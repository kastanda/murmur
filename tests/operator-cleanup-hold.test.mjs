// THE PATHOLOGICAL LAUNCH: a supervisor was spawned, its identity could never be measured,
// and TERM/KILL through the trusted handle never produced an observable exit.
//
// The old behaviour unref'd the handle, returned, and left a launch guard with no supervisor
// record — which `launchGuardReclaimable()` then read as "nothing was ever started", so a
// second start could overlap a possibly-live supervisor. These tests pin down both halves of
// the fix: the handle is never dropped while the child is unsettled, and the DURABLE guard
// becomes non-reclaimable by every automatic path, including after the launcher is killed.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writePrivateJson } from "../scripts/secure-state.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { ownedProcessState, probeStartIdentity, readStartIdentity } from "../scripts/operator/proc.mjs";
import {
  GUARD_CLEANUP_UNVERIFIED,
  GUARD_LAUNCHING,
  GUARD_SPAWN_INTENT,
  GUARD_SUPERVISOR_EXITED,
  GUARD_SUPERVISOR_SPAWNED,
  GUARD_SUPERVISOR_VERIFIED,
  LOCK_STALE,
  acquireLaunchGuard,
  launchGuardReclaimable,
  launchGuardState,
  noteLaunchGuardSpawn,
  readLaunchGuard,
  readRunState,
  reclaimStaleLaunchGuard,
} from "../scripts/operator/runstate.mjs";
import { startDetachedSupervisor } from "../scripts/operator/cli.mjs";

const execFileAsync = promisify(execFile);
const MURMUR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(MURMUR_ROOT, "bin", "murmur.mjs");
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DEAD_LAUNCHER = { pid: 999_611, startIdentity: "Thu Jan  1 00:00:00 1970" };

const startFakeNats = async () => {
  const server = net.createServer((socket) => {
    socket.write(`INFO ${JSON.stringify({
      server_id: "MURMUR-TEST", server_name: "murmur-test", version: "2.10.0", proto: 1,
      go: "", host: "127.0.0.1", port: 0, headers: true, max_payload: 1048576, client_id: 1,
    })}\r\n`);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n")) if (line.startsWith("PING")) socket.write("PONG\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `nats://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};

const AUTHED_CLAUDE = '#!/bin/sh\nif [ "$1" = "auth" ]; then echo \'{"loggedIn":true}\'; fi\nexit 0\n';
const AUTHED_AGENT = '#!/bin/sh\necho "Logged in as tester"\nexit 0\n';
/** An App Server that starts, stays alive and never binds: a legitimately slow start. */
const SLOW_APP_SERVER = (nodeBin) => `#!${nodeBin}\nsetInterval(() => {}, 1000);\n`;

/**
 * A real launcher process, driven to an exact crash point and then left waiting to be killed.
 *
 * Modes:
 *   `idle`               guard acquired, no spawn intended yet
 *   `intent`             durable spawn-intent written, spawn NOT called
 *   `spawn-then-pause`   runs the PRODUCTION launch and pauses inside it, after the OS spawn
 *                        has really happened but before the PID is recorded
 *   `cleanup-unverified` spawned + gave up without observing an exit
 */
const HOLDING_LAUNCHER = `
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startDetachedSupervisor } from "${MURMUR_ROOT}/scripts/operator/cli.mjs";
import { loadProfile } from "${MURMUR_ROOT}/scripts/operator/profile.mjs";
import { readStartIdentity } from "${MURMUR_ROOT}/scripts/operator/proc.mjs";
import { projectPathsFor } from "${MURMUR_ROOT}/scripts/operator/project.mjs";
import {
  acquireLaunchGuard, noteLaunchGuardCleanupUnverified, noteLaunchGuardSpawn, noteLaunchGuardSpawnIntent,
} from "${MURMUR_ROOT}/scripts/operator/runstate.mjs";

const [projectId, home, readyFile, mode, spawnedFile] = process.argv.slice(2);
const paths = projectPathsFor(projectId, { home });
const guard = acquireLaunchGuard(paths, {
  pid: process.pid, startIdentity: readStartIdentity(process.pid), command: "start",
});
if (!guard.acquired) {
  writeFileSync(readyFile, "failed:" + guard.reason);
  process.exit(1);
}

if (mode === "spawn-then-pause") {
  writeFileSync(readyFile, "held");
  // The REAL production launch, with only the spawn itself wrapped so the process can be
  // stopped at the exact instant the review cares about.
  await startDetachedSupervisor({
    project: await loadProfile(paths),
    projectId,
    paths,
    guard,
    flags: { timeoutSeconds: 5 },
    spawnSupervisor: () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        stdio: "ignore", detached: true,
      });
      writeFileSync(spawnedFile, String(child.pid));
      // PAUSE HERE: the OS process exists, the guard carries spawn-intent, and the PID has NOT
      // been recorded yet. The test SIGKILLs this launcher at exactly this point.
      execFileSync("/bin/sleep", ["60"]);
      return child;
    },
  });
  process.exit(0);
}

if (mode === "intent" || mode === "cleanup-unverified") {
  noteLaunchGuardSpawnIntent(paths, guard.guard);
}
if (mode === "cleanup-unverified") {
  noteLaunchGuardSpawn(paths, guard.guard, { pid: 999_777 });
  noteLaunchGuardCleanupUnverified(paths, guard.guard, {
    pid: 999_777, outcome: "handle-escalation-failed", signalled: ["SIGTERM", "SIGKILL"],
  });
}
writeFileSync(readyFile, "held");
setInterval(() => {}, 1000);
`;

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-ch-"));
  mkdirSync(path.join(dir, "project"), { recursive: true });
  const projectPath = realpathSync(path.join(dir, "project"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["claude", AUTHED_CLAUDE], ["agent", AUTHED_AGENT], ["codex", SLOW_APP_SERVER(process.execPath)]]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  const holderScript = path.join(dir, "holding-launcher.mjs");
  writeFileSync(holderScript, HOLDING_LAUNCHER);

  const home = path.join(dir, ".murmur");
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home });
  const nats = await startFakeNats();

  const murmur = async (...args) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
        env: { HOME: dir, PATH: bin, MURMUR_HOME: home },
        encoding: "utf8",
        timeout: 180_000,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  await murmur("doctor", projectPath);
  const { bootstrapProfile } = await import("../scripts/operator/profile.mjs");
  await bootstrapProfile({ projectId, projectPath, paths, natsUrl: nats.url });
  const project = JSON.parse(readFileSync(paths.projectFile, "utf8"));
  project.natsUrl = nats.url;
  await writePrivateJson(paths.projectFile, project);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });

  const supervisorProcesses = async () => {
    const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid,command"], { encoding: "utf8" });
    return stdout.split("\n").filter((line) => line.includes("supervisor-main.mjs") && line.includes(projectId));
  };

  return {
    dir, projectPath, projectId, home, paths, murmur, holderScript, supervisorProcesses,
    cleanup: async () => {
      await murmur("stop", projectPath).catch(() => {});
      await nats.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

/**
 * A supervisor handle that reports a live process, accepts every signal and NEVER exits — the
 * pathological case in which no exit can be observed. It counts `unref()` so the test can prove
 * the CLI does not discard it, and can be made to exit on demand.
 */
const unobservableSupervisor = (pid = 999_601) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = null;
  child.stderr = null;
  child.signals = [];
  child.unrefCalls = 0;
  child.kill = (signal) => {
    child.signals.push(signal);
    return true; // accepted, and ignored
  };
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.finallyExit = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return child;
};

// ---------------------------------------------------------------------------
// A + E + §10 — the hold, the refusal during it, and the late exit
// ---------------------------------------------------------------------------

test("A/E. an unobservable supervisor puts the launch into a cleanup hold; a second start is refused throughout", async () => {
  const ctx = await setup();
  const { loadProfile } = await import("../scripts/operator/profile.mjs");
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, MURMUR_HOME: process.env.MURMUR_HOME };
  process.env.HOME = ctx.dir;
  process.env.PATH = path.join(ctx.dir, "bin");
  process.env.MURMUR_HOME = ctx.home;

  const project = await loadProfile(ctx.paths);
  const guard = acquireLaunchGuard(ctx.paths, {
    pid: process.pid, startIdentity: readStartIdentity(process.pid), command: "start",
  });
  assert.equal(guard.acquired, true);
  const child = unobservableSupervisor();

  try {
    // The launch runs concurrently: it is expected NOT to return while the child is unsettled.
    const launch = startDetachedSupervisor({
      project,
      projectId: ctx.projectId,
      paths: ctx.paths,
      guard,
      flags: { timeoutSeconds: 5 },
      probe: () => ({ state: "unknown", identity: null }),
      spawnSupervisor: () => child,
      graceMs: 120,
      holdPollMs: 200,
    });
    let returned = false;
    launch.then(() => { returned = true; });

    // Wait until the hold has been entered and recorded durably.
    for (let i = 0; i < 200 && readLaunchGuard(ctx.paths)?.phase !== GUARD_CLEANUP_UNVERIFIED; i += 1) await sleep(50);
    const held = readLaunchGuard(ctx.paths);
    assert.equal(held.phase, GUARD_CLEANUP_UNVERIFIED, "the guard records the unresolved cleanup");
    assert.equal(held.unsafeToReclaim, true);
    assert.equal(held.supervisorWasSpawned, true);
    assert.equal(held.spawnedPid, child.pid);
    assert.deepEqual(held.unresolved.signalled, ["SIGTERM", "SIGKILL"], "it really did escalate through the handle");

    // §10 — THE HANDLE IS NOT DISCARDED, and the command has not returned.
    assert.equal(child.unrefCalls, 0, "an unsettled child must never be unref'd");
    assert.equal(returned, false, "the command must not return while the exit is unconfirmed");
    assert.equal(launchGuardReclaimable(held).ok, false, "and the durable state is non-reclaimable");

    // A second, fully independent start is refused — and spawns nothing.
    const second = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(second.code, 3, second.stderr);
    assert.match(second.stderr, /refusing to start/);
    assert.match(second.stderr, /exit it could not confirm/);
    assert.deepEqual(await ctx.supervisorProcesses(), [], "no second supervisor may be spawned");
    assert.equal(readLaunchGuard(ctx.paths).launchId, guard.guard.launchId, "the guard is untouched by the refused start");
    assert.equal(child.unrefCalls, 0);
    assert.equal(returned, false);

    // E — the exit finally becomes observable: the hold resolves it properly.
    child.finallyExit();
    const code = await launch;
    assert.equal(code, 4, "the command now returns a truthful failure");
    assert.equal(existsSync(ctx.paths.launchGuardFile), false, "the exact guard instance is released after the observed exit");
    // The handle is released ONLY after the exit was proven — never before.
    assert.equal(child.unrefCalls, 1, "the handle is released exactly once, after the observed exit");
    assert.deepEqual(child.signals.slice(0, 2), ["SIGTERM", "SIGKILL"], "escalation went through the handle");

    // And only now is a new start allowed.
    const third = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(third.code, 3, `a start after a resolved hold must not be refused: ${third.stderr}`);
    assert.equal(third.stderr.includes("CLEANUP INCOMPLETE"), false, third.stderr);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B — the launcher is externally killed while holding
// ---------------------------------------------------------------------------

test("B. killing the launcher during a cleanup hold does NOT make the guard reclaimable", async () => {
  const ctx = await setup();
  const readyFile = path.join(ctx.dir, "holder-ready");
  const holder = spawn(process.execPath, [ctx.holderScript, ctx.projectId, ctx.home, readyFile, "cleanup-unverified", path.join(ctx.dir, "unused")], { stdio: "ignore" });
  const holderExit = new Promise((resolve) => holder.on("exit", resolve));
  try {
    for (let i = 0; i < 100 && !existsSync(readyFile); i += 1) await sleep(50);
    assert.equal(readFileSync(readyFile, "utf8"), "held");
    assert.equal(launchGuardState(ctx.paths).state, "held");

    // The launcher is SIGKILLed: the trusted handle is gone for good. That is the unavoidable
    // hard-crash case — and it must convert to manual recovery, never to a free project.
    holder.kill("SIGKILL");
    await holderExit;

    const state = launchGuardState(ctx.paths);
    assert.equal(state.state, LOCK_STALE, "the launcher itself is now proven gone");
    const verdict = launchGuardReclaimable(state.heldBy);
    assert.equal(verdict.ok, false, "a dead launcher must NOT make an unresolved launch reclaimable");
    assert.equal(verdict.manualRecovery, true);
    assert.equal(verdict.reason, `guard-${GUARD_CLEANUP_UNVERIFIED}`);

    // No automatic path may take it: not acquisition, not `murmur stop`'s reclamation.
    const attempt = acquireLaunchGuard(ctx.paths, { pid: process.pid, startIdentity: readStartIdentity(process.pid) });
    assert.equal(attempt.acquired, false);
    assert.equal(reclaimStaleLaunchGuard(ctx.paths).reclaimed, false);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true);

    // A real start is refused and says exactly what has to happen.
    const start = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(start.code, 3, start.stderr);
    assert.match(start.stderr, /MANUAL RECOVERY REQUIRED/);
    assert.match(start.stderr, /999777/);
    assert.deepEqual(await ctx.supervisorProcesses(), []);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true, "the refused start must not delete the guard");

    // stop and doctor report the same condition rather than quietly clearing it.
    const stop = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(stop.code, 3, "stop must not claim success while the project stays locked");
    assert.match(stop.stderr, /MANUAL RECOVERY REQUIRED/);
    assert.match(stop.stderr, /999777/);
    assert.match(stop.stderr, /will not reclaim this guard automatically/);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true, "stop must not delete an unresolved guard");
    const doctor = await ctx.murmur("doctor", ctx.projectPath);
    assert.equal(doctor.code, 2);
    assert.match(doctor.stdout, /FAIL\s+launch-guard\s+MANUAL RECOVERY REQUIRED/);
  } finally {
    holder.kill("SIGKILL");
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C / D — the reclaimability model at the exact boundary
// ---------------------------------------------------------------------------

test("C. a guard that records a spawned-but-unidentified supervisor is never reclaimable", async () => {
  const ctx = await setup();
  try {
    // Produced through the production transitions, with a launcher that is proven gone: this is
    // precisely the state left behind by a launcher killed during ownership establishment.
    const guard = acquireLaunchGuard(ctx.paths, DEAD_LAUNCHER);
    assert.equal(guard.acquired, true);
    assert.equal(noteLaunchGuardSpawn(ctx.paths, guard.guard, { pid: 999_612 }).updated, true);

    const stored = readLaunchGuard(ctx.paths);
    assert.equal(stored.phase, GUARD_SUPERVISOR_SPAWNED);
    assert.equal(stored.supervisorWasSpawned, true);
    assert.equal(stored.supervisor, undefined, "no verified identity was ever captured");
    assert.equal(stored.exitObserved, undefined, "and no exit was ever observed");
    assert.equal(launchGuardState(ctx.paths).state, LOCK_STALE, "its launcher is gone");

    const verdict = launchGuardReclaimable(stored);
    assert.equal(verdict.ok, false, "absence of a verified record is NOT proof that nothing runs");
    assert.equal(verdict.reason, "launched-supervisor-unverified");
    assert.equal(verdict.spawnedPid, 999_612);
    assert.equal(acquireLaunchGuard(ctx.paths, { pid: process.pid, startIdentity: readStartIdentity(process.pid) }).acquired, false);
    assert.equal(reclaimStaleLaunchGuard(ctx.paths).reclaimed, false);

    // An unrecognised/incomplete guard is likewise not proof of anything.
    assert.equal(launchGuardReclaimable({ launchId: "x", pid: DEAD_LAUNCHER.pid }).ok, false);
    assert.equal(launchGuardReclaimable({ launchId: "x", pid: DEAD_LAUNCHER.pid }).reason, "guard-launch-state-unknown");
  } finally {
    await ctx.cleanup();
  }
});

test("D. a guard whose launch never spawned a supervisor is still reclaimable once its launcher is gone", async () => {
  const ctx = await setup();
  try {
    // Acquired and then abandoned before any spawn — the ordinary "launcher died early" case.
    const guard = acquireLaunchGuard(ctx.paths, DEAD_LAUNCHER);
    assert.equal(guard.acquired, true);
    const stored = readLaunchGuard(ctx.paths);
    assert.equal(stored.supervisorWasSpawned, false, "the guard states this from its first write");
    assert.equal(launchGuardState(ctx.paths).state, LOCK_STALE);
    assert.equal(launchGuardReclaimable(stored).ok, true);

    // So a fresh start is not blocked: no permanent false lock for a normal case.
    const live = { pid: process.pid, startIdentity: readStartIdentity(process.pid) };
    const next = acquireLaunchGuard(ctx.paths, live);
    assert.equal(next.acquired, true);
    assert.notEqual(next.guard.launchId, guard.guard.launchId);

    // A guard whose supervisor exit WAS observed is reclaimable too.
    const { noteLaunchGuardSupervisorExited, releaseLaunchGuard } = await import("../scripts/operator/runstate.mjs");
    assert.equal(noteLaunchGuardSpawn(ctx.paths, next.guard, { pid: 999_613 }).updated, true);
    assert.equal(launchGuardReclaimable(readLaunchGuard(ctx.paths)).ok, false, "spawned, nothing proven yet");
    assert.equal(noteLaunchGuardSupervisorExited(ctx.paths, next.guard, { pid: 999_613 }).updated, true);
    const exited = readLaunchGuard(ctx.paths);
    assert.equal(exited.phase, GUARD_SUPERVISOR_EXITED);
    assert.equal(exited.exitObserved, true);
    assert.equal(launchGuardReclaimable(exited).ok, true, "an observed exit is positive evidence of absence");
    releaseLaunchGuard(ctx.paths, next.guard);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F + §10 — normal launches are untouched, and their handle IS released
// ---------------------------------------------------------------------------

test("F. a normal launch progresses spawned -> verified, releases its guard, and leaves no lock behind", async () => {
  const ctx = await setup();
  const { loadProfile } = await import("../scripts/operator/profile.mjs");
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, MURMUR_HOME: process.env.MURMUR_HOME };
  process.env.HOME = ctx.dir;
  process.env.PATH = path.join(ctx.dir, "bin");
  process.env.MURMUR_HOME = ctx.home;

  const project = await loadProfile(ctx.paths);
  const guard = acquireLaunchGuard(ctx.paths, {
    pid: process.pid, startIdentity: readStartIdentity(process.pid), command: "start",
  });
  const spawned = [];
  try {
    const phases = new Set();
    let guardAtSpawn = null;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const current = readLaunchGuard(ctx.paths);
        if (current?.phase) phases.add(current.phase);
        await sleep(25);
      }
    })();

    // A real supervisor process, a real identity probe; only the spawn is wrapped, so `unref()`
    // can be counted on the production path.
    const code = await startDetachedSupervisor({
      project,
      projectId: ctx.projectId,
      paths: ctx.paths,
      guard,
      flags: { timeoutSeconds: 3 },
      probe: probeStartIdentity,
      spawnSupervisor: (...args) => {
        // INVARIANT 1, observed from inside the production flow: the durable non-reclaimable
        // boundary is already on disk at the instant the OS process is created.
        guardAtSpawn = readLaunchGuard(ctx.paths);
        const child = spawn(...args);
        spawned.push(child);
        const realUnref = child.unref.bind(child);
        child.unrefCalls = 0;
        child.unref = () => {
          child.unrefCalls += 1;
          realUnref();
        };
        return child;
      },
    });
    watching = false;
    await watcher;

    assert.ok([0, 3, 4].includes(code), `expected a truthful outcome, got ${code}`);
    assert.ok(guardAtSpawn, "the spawn really did go through the seam");
    assert.equal(guardAtSpawn.phase, GUARD_SPAWN_INTENT, "spawn-intent must be durable BEFORE the OS spawn");
    assert.equal(guardAtSpawn.spawnIntent, true);
    assert.equal(guardAtSpawn.unsafeToReclaim, true);
    assert.equal(launchGuardReclaimable(guardAtSpawn).ok, false, "and non-reclaimable from that instant on");
    assert.ok(phases.has(GUARD_SPAWN_INTENT) || phases.has(GUARD_SUPERVISOR_SPAWNED) || phases.has(GUARD_SUPERVISOR_VERIFIED),
      `the guard must record the launch lifecycle, saw: ${[...phases].join(", ") || "none"}`);
    for (const phase of phases) {
      assert.ok([GUARD_LAUNCHING, GUARD_SPAWN_INTENT, GUARD_SUPERVISOR_SPAWNED, GUARD_SUPERVISOR_VERIFIED, GUARD_SUPERVISOR_EXITED].includes(phase),
        `unexpected phase on a normal launch: ${phase}`);
    }
    assert.equal(phases.has(GUARD_CLEANUP_UNVERIFIED), false, "a normal launch never enters the unresolved state");

    // No permanent false lock: the exclusion is gone and nothing is left unreclaimable.
    assert.equal(existsSync(ctx.paths.launchGuardFile), false, "a normal launch releases its exclusion");
    const start = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(start.code, 3, `a later start must not be refused: ${start.stderr}`);
    assert.equal(start.stderr.includes("MANUAL RECOVERY"), false, start.stderr);
  } finally {
    for (const child of spawned) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// THE CRASH WINDOW: SIGKILL BETWEEN THE OS SPAWN AND THE PID RECORD
// ---------------------------------------------------------------------------

/** Wait until `file` exists, or fail the test. */
const waitForFile = async (file, what) => {
  for (let i = 0; i < 200 && !existsSync(file); i += 1) await sleep(50);
  assert.equal(existsSync(file), true, `timed out waiting for ${what}`);
  return readFileSync(file, "utf8");
};

test("MANDATORY. a launcher SIGKILLed after the spawn but before the PID record leaves a NON-reclaimable guard", async () => {
  const ctx = await setup();
  const readyFile = path.join(ctx.dir, "launcher-ready");
  const spawnedFile = path.join(ctx.dir, "spawned-pid");
  // A real launcher running the real production launch, paused inside it at the exact instant
  // the OS process exists but nothing about it has been recorded.
  const launcher = spawn(
    process.execPath,
    [ctx.holderScript, ctx.projectId, ctx.home, readyFile, "spawn-then-pause", spawnedFile],
    { stdio: "ignore" },
  );
  const launcherExit = new Promise((resolve) => launcher.on("exit", resolve));
  let orphanPid = null;
  try {
    await waitForFile(readyFile, "the launcher to take the guard");
    orphanPid = Number(await waitForFile(spawnedFile, "the supervisor process to be spawned"));
    assert.ok(Number.isInteger(orphanPid) && orphanPid > 0);

    // The durable boundary is already in place, BEFORE any PID could be recorded.
    const beforeKill = readLaunchGuard(ctx.paths);
    assert.equal(beforeKill.spawnIntent, true, "the spawn-intent boundary is durable before the spawn");
    assert.equal(beforeKill.phase, GUARD_SPAWN_INTENT);
    assert.notEqual(beforeKill.supervisorWasSpawned, true, "the PID record has deliberately not happened yet");
    assert.equal(beforeKill.spawnedPid ?? null, null);

    // 5. Kill the launcher exactly here. 6. The child stays alive.
    launcher.kill("SIGKILL");
    await launcherExit;
    assert.equal(
      ownedProcessState({ pid: orphanPid, startIdentity: readStartIdentity(orphanPid) }), "ours",
      "the spawned process outlives its launcher — this is the dangerous state",
    );

    // 7. Inspect the durable guard: its launcher is gone, and it must NOT be reclaimable.
    const state = launchGuardState(ctx.paths);
    assert.equal(state.state, LOCK_STALE, "the launcher itself is proven gone");
    const verdict = launchGuardReclaimable(state.heldBy);
    assert.equal(verdict.ok, false, "a missing PID after spawn-intent is UNKNOWN, not proof of no child");
    assert.equal(verdict.reason, "launch-spawn-intent-unresolved");
    assert.equal(verdict.manualRecovery, true);

    // 8. A second, fully independent start.
    const second = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(second.code, 3, `the second start must be refused: ${second.stderr}`);
    assert.match(second.stderr, /refusing to start/);
    assert.match(second.stderr, /MANUAL RECOVERY REQUIRED/);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true, "the guard must NOT be removed");
    assert.deepEqual(await ctx.supervisorProcesses(), [], "zero second supervisors may be spawned");
    assert.equal(await readRunState(ctx.paths), null, "and nothing was published");

    // status and doctor report the unresolved spawn rather than a startable project.
    const status = await ctx.murmur("status", ctx.projectPath, "--json");
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.launchGuard.manualRecovery, true);
    assert.equal(parsed.launchGuard.phase, GUARD_SPAWN_INTENT);
    assert.equal(parsed.healthy, false);
    const doctor = await ctx.murmur("doctor", ctx.projectPath);
    assert.equal(doctor.code, 2);
    assert.match(doctor.stdout, /FAIL\s+launch-guard\s+MANUAL RECOVERY REQUIRED/);
  } finally {
    launcher.kill("SIGKILL");
    if (orphanPid) {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await ctx.cleanup();
  }
});

test("a launcher killed BEFORE the spawn-intent boundary leaves an ordinarily reclaimable guard", async () => {
  const ctx = await setup();
  const readyFile = path.join(ctx.dir, "idle-ready");
  const launcher = spawn(
    process.execPath,
    [ctx.holderScript, ctx.projectId, ctx.home, readyFile, "idle", path.join(ctx.dir, "unused")],
    { stdio: "ignore" },
  );
  const launcherExit = new Promise((resolve) => launcher.on("exit", resolve));
  try {
    await waitForFile(readyFile, "the launcher to take the guard");
    const held = readLaunchGuard(ctx.paths);
    assert.equal(held.phase, GUARD_LAUNCHING);
    assert.equal(held.supervisorWasSpawned, false);
    assert.notEqual(held.spawnIntent, true);

    launcher.kill("SIGKILL");
    await launcherExit;

    // No spawn could have happened yet, so the ordinary stale-guard rules still apply — this is
    // what proves the conservative boundary did not make every abandoned guard permanent.
    const state = launchGuardState(ctx.paths);
    assert.equal(state.state, LOCK_STALE);
    assert.equal(launchGuardReclaimable(state.heldBy).ok, true);
    const start = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(start.code, 3, `a start must not be refused here: ${start.stderr}`);
    assert.equal(start.stderr.includes("MANUAL RECOVERY"), false, start.stderr);
  } finally {
    launcher.kill("SIGKILL");
    await ctx.cleanup();
  }
});

test("a launcher killed AFTER the spawn-intent boundary but before spawn() stays locked, deliberately", async () => {
  const ctx = await setup();
  const readyFile = path.join(ctx.dir, "intent-ready");
  const launcher = spawn(
    process.execPath,
    [ctx.holderScript, ctx.projectId, ctx.home, readyFile, "intent", path.join(ctx.dir, "unused")],
    { stdio: "ignore" },
  );
  const launcherExit = new Promise((resolve) => launcher.on("exit", resolve));
  try {
    await waitForFile(readyFile, "the launcher to record spawn-intent");
    assert.equal(readLaunchGuard(ctx.paths).phase, GUARD_SPAWN_INTENT);

    launcher.kill("SIGKILL");
    await launcherExit;

    // No process was ever created here — but nothing on disk can PROVE that, so the guard stays.
    // A conservative false lock is the intended trade: it needs a manual unlock, whereas two
    // overlapping supervisors cannot be undone.
    const state = launchGuardState(ctx.paths);
    assert.equal(state.state, LOCK_STALE);
    const verdict = launchGuardReclaimable(state.heldBy);
    assert.equal(verdict.ok, false, "conservative by design");
    assert.equal(verdict.manualRecovery, true);
    const start = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(start.code, 3, start.stderr);
    assert.match(start.stderr, /MANUAL RECOVERY REQUIRED/);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true);
    assert.deepEqual(await ctx.supervisorProcesses(), []);
  } finally {
    launcher.kill("SIGKILL");
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SPAWN FAILURE: PROVEN "NO PROCESS" MUST STILL RELEASE
// ---------------------------------------------------------------------------

test("a definitive spawn failure records a safe terminal state and releases the guard", async () => {
  const ctx = await setup();
  const { loadProfile } = await import("../scripts/operator/profile.mjs");
  const { noteLaunchGuardSpawnFailed, releaseLaunchGuard } = await import("../scripts/operator/runstate.mjs");
  const project = await loadProfile(ctx.paths);
  try {
    // 1. A synchronous throw from spawn: Node never created a process.
    const first = acquireLaunchGuard(ctx.paths, { pid: process.pid, startIdentity: readStartIdentity(process.pid) });
    const thrown = await startDetachedSupervisor({
      project, projectId: ctx.projectId, paths: ctx.paths, guard: first, flags: { timeoutSeconds: 3 },
      spawnSupervisor: () => { throw new Error("EACCES: permission denied"); },
    });
    assert.equal(thrown, 4, "a spawn failure is a truthful failed start");
    assert.equal(existsSync(ctx.paths.launchGuardFile), false, "proven no-process releases the exclusion");

    // 2. Node's other definitive signal: a ChildProcess with no pid.
    const second = acquireLaunchGuard(ctx.paths, { pid: process.pid, startIdentity: readStartIdentity(process.pid) });
    const noPid = await startDetachedSupervisor({
      project, projectId: ctx.projectId, paths: ctx.paths, guard: second, flags: { timeoutSeconds: 3 },
      spawnSupervisor: () => {
        const child = new EventEmitter();
        child.pid = undefined;
        child.kill = () => false;
        child.unref = () => {};
        return child;
      },
    });
    assert.equal(noPid, 4);
    assert.equal(existsSync(ctx.paths.launchGuardFile), false);

    // No permanent manual-recovery state: an ordinary start is allowed straight afterwards.
    const start = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(start.code, 3, `a start after a spawn failure must not be refused: ${start.stderr}`);
    assert.equal(start.stderr.includes("MANUAL RECOVERY"), false, start.stderr);

    // And the durable terminal state itself is what makes it reclaimable — not a missing PID.
    const third = acquireLaunchGuard(ctx.paths, DEAD_LAUNCHER);
    assert.equal(noteLaunchGuardSpawnFailed(ctx.paths, third.guard, { error: "ENOENT" }).updated, true);
    const failed = readLaunchGuard(ctx.paths);
    assert.equal(failed.phase, "spawn-failed");
    assert.equal(failed.noProcessProven, true);
    assert.equal(failed.processCreated, false);
    assert.equal(launchGuardReclaimable(failed).ok, true);
    releaseLaunchGuard(ctx.paths, third.guard);
  } finally {
    await ctx.cleanup();
  }
});
