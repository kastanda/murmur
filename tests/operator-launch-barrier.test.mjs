// HIGH 1 — the detached supervisor ownership barrier and the launch exclusion around it,
// driven through the REAL `murmur` CLI against real processes.
//
// Two properties are proven here:
//
//   1. there is no window in which a project is unowned. Before any supervisor exists the
//      launcher holds a durable launch guard, and it only lets go once the verified
//      supervisor owns the authoritative lock and the published run state;
//   2. a launch that fails cleans up what it created BEFORE releasing that exclusion, and if
//      it cannot prove the cleanup it keeps the exclusion and says so.
//
// The concurrency test uses a second, independent OS process holding the guard through the
// production API — not a mocked helper returning `false`.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
import { launchGuardState, readLaunchGuard, readLock, readRunState } from "../scripts/operator/runstate.mjs";

const execFileAsync = promisify(execFile);
const MURMUR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(MURMUR_ROOT, "bin", "murmur.mjs");
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Enough of the NATS wire protocol for the real preflight client to connect. */
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
 * A SECOND real process that holds the project's launch guard through the production API and
 * then waits — exactly the state a first `murmur start` is in after taking the exclusion but
 * before its supervisor has published anything. It releases the guard on SIGTERM.
 */
const PAUSED_LAUNCHER = `
import { writeFileSync } from "node:fs";
import { readStartIdentity } from "${MURMUR_ROOT}/scripts/operator/proc.mjs";
import { projectPathsFor } from "${MURMUR_ROOT}/scripts/operator/project.mjs";
import { acquireLaunchGuard, releaseLaunchGuard } from "${MURMUR_ROOT}/scripts/operator/runstate.mjs";

const [projectId, home, readyFile] = process.argv.slice(2);
const paths = projectPathsFor(projectId, { home });
const guard = acquireLaunchGuard(paths, {
  pid: process.pid, startIdentity: readStartIdentity(process.pid), command: "start",
});
writeFileSync(readyFile, guard.acquired ? "acquired" : \`failed:\${guard.reason}\`);
process.on("SIGTERM", () => {
  if (guard.acquired) releaseLaunchGuard(paths, guard.guard);
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

const setup = async ({ appServer = SLOW_APP_SERVER(process.execPath) } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-lg-"));
  mkdirSync(path.join(dir, "project"), { recursive: true });
  const projectPath = realpathSync(path.join(dir, "project"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["claude", AUTHED_CLAUDE], ["agent", AUTHED_AGENT], ["codex", appServer]]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  const launcherScript = path.join(dir, "paused-launcher.mjs");
  writeFileSync(launcherScript, PAUSED_LAUNCHER);

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

  // Bootstrap through the real CLI, then point the profile at the fake broker.
  await murmur("doctor", projectPath);
  const { bootstrapProfile } = await import("../scripts/operator/profile.mjs");
  await bootstrapProfile({ projectId, projectPath, paths, natsUrl: nats.url });
  const project = JSON.parse(readFileSync(paths.projectFile, "utf8"));
  project.natsUrl = nats.url;
  await writePrivateJson(paths.projectFile, project);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

  /** Every live supervisor process for THIS project, found by its exact argv. */
  const supervisorProcesses = async () => {
    const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid,command"], { encoding: "utf8" });
    return stdout.split("\n").filter((line) => line.includes("supervisor-main.mjs") && line.includes(projectId));
  };

  return {
    dir, projectPath, projectId, home, paths, murmur, launcherScript, supervisorProcesses,
    codexBinary: path.join(bin, "codex"),
    cleanup: async () => {
      await murmur("stop", projectPath).catch(() => {});
      await nats.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

// ---------------------------------------------------------------------------
// 3. CONCURRENT START DURING THE PRE-PUBLICATION WINDOW
// ---------------------------------------------------------------------------

test("3. a second start is refused while a first launch holds the exclusion, and spawns nothing", async () => {
  const ctx = await setup();
  const readyFile = path.join(ctx.dir, "launcher-ready");
  const first = spawn(process.execPath, [ctx.launcherScript, ctx.projectId, ctx.home, readyFile], { stdio: "ignore" });
  const firstExit = new Promise((resolve) => first.on("exit", resolve));
  try {
    for (let i = 0; i < 100 && !existsSync(readyFile); i += 1) await sleep(50);
    assert.equal(readFileSync(readyFile, "utf8"), "acquired", "the first launcher must hold the exclusion");
    // Nothing is published yet: no run state, no lock. This is exactly the window that used
    // to admit a second supervisor.
    assert.equal(await readRunState(ctx.paths), null);
    assert.equal(readLock(ctx.paths), null);
    assert.equal(launchGuardState(ctx.paths).state, "held");

    const second = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(second.code, 3, `expected a refusal, got ${second.code}: ${second.stderr}`);
    assert.match(second.stderr, /refusing to start/);
    assert.match(second.stderr, /is launching this project/);

    // NO second supervisor was created, and the first launcher's guard is untouched.
    assert.deepEqual(await ctx.supervisorProcesses(), []);
    assert.equal(await readRunState(ctx.paths), null, "a refused start must not write run state");
    assert.equal(readLock(ctx.paths), null, "a refused start must not take the lock");
    assert.equal(readLaunchGuard(ctx.paths).pid, first.pid, "the guard still belongs to the first launcher");
    const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid,command"], { encoding: "utf8" });
    assert.equal(stdout.includes(ctx.codexBinary), false, "no App Server was started by the refused start");

    // The first launch completes and releases its exclusion...
    first.kill("SIGTERM");
    await firstExit;
    assert.equal(existsSync(ctx.paths.launchGuardFile), false, "the exact launch owner released its guard");

    // ...and only then may another start proceed. It is allowed to fail (this App Server
    // never binds), but it must no longer be REFUSED, and it must clean up after itself.
    const third = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(third.code, 3, `a start after a completed launch must not be refused: ${third.stderr}`);
    assert.equal(third.stderr.includes("CLEANUP INCOMPLETE"), false, third.stderr);
    assert.equal(existsSync(ctx.paths.launchGuardFile), false, "a proven-clean failed start releases its guard");
    assert.deepEqual(await ctx.supervisorProcesses(), [], "no supervisor may survive a failed start");
  } finally {
    first.kill("SIGKILL");
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 11-12. THE GUARD ACROSS A REAL LAUNCH
// ---------------------------------------------------------------------------

test("11. a failed launch proves its cleanup BEFORE releasing the launch exclusion", async () => {
  const ctx = await setup();
  try {
    // Watch the exclusion while a real launch runs: it must be held for the whole launch and
    // must carry the VERIFIED supervisor record (pid + start identity) once established.
    const observations = { heldDuringLaunch: false, supervisorRecords: [] };
    let running = true;
    const watcher = (async () => {
      while (running) {
        const guard = readLaunchGuard(ctx.paths);
        if (guard) {
          observations.heldDuringLaunch = true;
          if (guard.supervisor) observations.supervisorRecords.push(guard.supervisor);
        }
        await sleep(40);
      }
    })();

    const result = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    running = false;
    await watcher;

    assert.equal(result.code, 4, `expected a failed start, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /Cleaned up the supervisor this command started/);
    assert.equal(result.stderr.includes("CLEANUP INCOMPLETE"), false);

    assert.equal(observations.heldDuringLaunch, true, "the launch exclusion must exist during the launch");
    assert.ok(observations.supervisorRecords.length > 0, "the verified supervisor is recorded in the guard");
    for (const record of observations.supervisorRecords) {
      assert.ok(Number.isInteger(record.pid), "the recorded supervisor carries an exact pid");
      assert.ok(record.startIdentity, "...and a start identity established from trusted spawn evidence");
      // That record is durable, trustworthy evidence: by now the process is gone, and it can
      // be PROVEN gone rather than merely assumed.
      assert.equal(ownedProcessState(record), "gone");
    }

    // Cleanup was proven first, so the exclusion is gone and the project is startable again.
    assert.equal(existsSync(ctx.paths.launchGuardFile), false);
    assert.deepEqual(await ctx.supervisorProcesses(), []);
    const retry = await ctx.murmur("doctor", ctx.projectPath);
    assert.equal(retry.stdout.includes("launch-guard"), true);
    assert.match(retry.stdout, /PASS\s+launch-guard\s+none/);
    // The real supervisor process released its OWN lock acquisition (exact instance token)
    // during its rollback; a release that could not identify its instance would have left
    // the lock file behind.
    assert.equal(existsSync(ctx.paths.lockFile), false, "the supervisor released its own lock instance");
    assert.match(retry.stdout, /PASS\s+supervisor-lock\s+free/);
  } finally {
    await ctx.cleanup();
  }
});

test("a launch guard whose launcher died but whose supervisor is unproven keeps starts refused", async () => {
  const ctx = await setup();
  // A live process standing in for the supervisor that a crashed launcher left behind. It is
  // recorded WITHOUT a start identity, so its ownership is `unknown` — and unknown is not gone.
  const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const orphanExit = new Promise((resolve) => orphan.on("exit", resolve));
  try {
    await sleep(100);
    writeFileSync(ctx.paths.launchGuardFile, JSON.stringify({
      launchId: "a-launch-that-crashed",
      pid: 999_421,
      startIdentity: "Thu Jan  1 00:00:00 1970",
      role: "launcher",
      supervisor: { pid: orphan.pid, startIdentity: null },
    }), { mode: 0o600 });

    const refused = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(refused.code, 3, refused.stderr);
    assert.match(refused.stderr, /not proven stopped/);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true, "the guard is retained on doubt");
    assert.deepEqual(await ctx.supervisorProcesses(), [], "nothing was spawned");
    assert.equal(ownedProcessState({ pid: orphan.pid, startIdentity: readStartIdentity(orphan.pid) }), "ours",
      "and the process it protects was never touched");

    // doctor says the same thing, fatally, instead of leaving the operator guessing.
    const doctor = await ctx.murmur("doctor", ctx.projectPath);
    assert.equal(doctor.code, 2, doctor.stdout);
    assert.match(doctor.stdout, /FAIL\s+launch-guard/);

    // Once that process is genuinely gone, the guard becomes reclaimable and a start proceeds.
    orphan.kill("SIGKILL");
    await orphanExit;
    const allowed = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(allowed.code, 3, `a resolved residual must unblock starts: ${allowed.stderr}`);
    assert.equal(allowed.stderr.includes("CLEANUP INCOMPLETE"), false, allowed.stderr);
  } finally {
    orphan.kill("SIGKILL");
    await ctx.cleanup();
  }
});

test("12. a launch that reaches ready hands authority over with no unowned instant", async () => {
  // The supervisor publishes its lock BEFORE its run state, and the CLI only releases the
  // launch guard after BOTH name the exact supervisor it verified. This test proves the
  // ordering invariant on the artifacts a concurrent start would consult.
  const ctx = await setup();
  try {
    const seen = [];
    let running = true;
    const watcher = (async () => {
      while (running) {
        const guard = readLaunchGuard(ctx.paths);
        const lock = readLock(ctx.paths);
        const state = await readRunState(ctx.paths);
        seen.push({ guard: Boolean(guard), lock: Boolean(lock), runState: Boolean(state) });
        await sleep(30);
      }
    })();
    const result = await ctx.murmur("start", ctx.projectPath, "--timeout", "4");
    running = false;
    await watcher;

    // Whatever the outcome, at no observed moment was the project unowned mid-launch: every
    // sample that saw a lock or run state either still had the guard, or the launch was over.
    const unowned = seen.filter((sample) => !sample.guard && !sample.lock && !sample.runState);
    // Only the leading samples (before the guard was taken) and trailing ones (after a fully
    // cleaned failure) may be unowned — never a gap between two owned samples.
    const firstOwned = seen.findIndex((sample) => sample.guard || sample.lock || sample.runState);
    const lastOwned = seen.map((sample) => sample.guard || sample.lock || sample.runState).lastIndexOf(true);
    const gaps = seen.slice(firstOwned, lastOwned).filter((sample) => !sample.guard && !sample.lock && !sample.runState);
    assert.deepEqual(gaps, [], `no unowned gap is allowed mid-launch (${unowned.length} unowned samples total)`);

    if (result.code === 0) {
      // A truthful success: the guard is gone and the supervisor owns lock + run state.
      assert.equal(existsSync(ctx.paths.launchGuardFile), false);
      const lock = readLock(ctx.paths);
      const state = await readRunState(ctx.paths);
      assert.equal(lock.pid, state.supervisor.pid);
      assert.equal(lock.startIdentity, state.supervisor.startIdentity);
      assert.ok(lock.lockId, "the authoritative lock carries its own instance token");
      assert.equal(ownedProcessState(state.supervisor), "ours");
    } else {
      // A cleaned failure: no supervisor, and the exclusion released only after that proof.
      assert.equal(result.stderr.includes("CLEANUP INCOMPLETE"), false, result.stderr);
      assert.equal(existsSync(ctx.paths.launchGuardFile), false);
      assert.deepEqual(await ctx.supervisorProcesses(), []);
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// THE BARRIER ITSELF: OWNERSHIP MEASUREMENT THAT NEVER SUCCEEDS
// ---------------------------------------------------------------------------

test("a supervisor whose identity can never be measured is terminated through the handle, and the exclusion goes last", async () => {
  const ctx = await setup();
  const { loadProfile } = await import("../scripts/operator/profile.mjs");
  const { acquireLaunchGuard } = await import("../scripts/operator/runstate.mjs");
  const { startDetachedSupervisor } = await import("../scripts/operator/cli.mjs");

  // The real supervisor process is spawned with this process's environment, so it has to see
  // the test project's Murmur home and fake binaries.
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, MURMUR_HOME: process.env.MURMUR_HOME };
  process.env.HOME = ctx.dir;
  process.env.PATH = path.join(ctx.dir, "bin");
  process.env.MURMUR_HOME = ctx.home;

  const project = await loadProfile(ctx.paths);
  const guard = acquireLaunchGuard(ctx.paths, {
    pid: process.pid, startIdentity: readStartIdentity(process.pid), command: "start",
  });
  assert.equal(guard.acquired, true);

  // A refused concurrent start, observed WHILE the barrier is running below.
  let concurrent = null;
  const truth = { identities: new Map() };
  const probe = (pid) => {
    // Remember the real identity for the test's own verification, and tell the CLI nothing —
    // the overloaded-`ps` condition that used to strand a detached supervisor.
    const real = probeStartIdentity(pid);
    if (real.state === "alive") truth.identities.set(Number(pid), real.identity);
    if (!concurrent) concurrent = ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    return { state: "unknown", identity: null };
  };

  try {
    const code = await startDetachedSupervisor({
      project, projectId: ctx.projectId, paths: ctx.paths, guard, flags: { timeoutSeconds: 5 }, probe,
    });

    // Truthful failure, not a silent success.
    assert.equal(code, 4, "an unidentifiable supervisor is a failed start");

    // The second start, which ran while the exclusion was held, was refused and spawned nothing.
    const refused = await concurrent;
    assert.equal(refused.code, 3, refused.stderr);
    assert.match(refused.stderr, /refusing to start/);

    // The supervisor this launch created is PROVEN gone, measured against the identity the
    // test captured while it was alive (never against a bare PID).
    assert.ok(truth.identities.size > 0, "the barrier really did try to measure the supervisor");
    for (const [pid, startIdentity] of truth.identities) {
      assert.equal(ownedProcessState({ pid, startIdentity }), "gone", `supervisor pid ${pid} must not survive`);
    }
    assert.deepEqual(await ctx.supervisorProcesses(), [], "no supervisor process is left behind");

    // Only after that proof was the exclusion released.
    assert.equal(existsSync(ctx.paths.launchGuardFile), false, "the exclusion is released last");
    const state = await readRunState(ctx.paths);
    assert.equal(state === null || (state.children && Object.keys(state.children).length === 0)
      || Object.values(state.children).every((record) => ownedProcessState(record) === "gone"), true,
    "nothing the abandoned supervisor recorded may still be running");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// THE DEGRADED HOLD IS VISIBLE, AND IS NOT DESTROYED BY `stop`
// ---------------------------------------------------------------------------

test("a supervisor in a degraded hold is reported honestly and never killed by `murmur stop`", async () => {
  const ctx = await setup();
  const { writeRunState } = await import("../scripts/operator/runstate.mjs");
  // A live process standing in for a supervisor that is holding the project, and a second one
  // standing in for the child it could not prove gone (recorded without an identity, exactly
  // as an unverifiable child is).
  const supervisor = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const residual = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const exits = Promise.all([
    new Promise((resolve) => supervisor.on("exit", resolve)),
    new Promise((resolve) => residual.on("exit", resolve)),
  ]);
  try {
    await sleep(150);
    const supervisorRecord = { pid: supervisor.pid, startIdentity: readStartIdentity(supervisor.pid), projectId: ctx.projectId };
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      phase: "stop-incomplete",
      degraded: true,
      supervisor: supervisorRecord,
      children: { claude: { name: "claude", pid: residual.pid, startIdentity: null, state: "stop-unconfirmed" } },
      residual: [{ name: "claude", pid: residual.pid, outcome: "handle-escalation-failed" }],
    });
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ lockId: "held-by-the-degraded-supervisor", ...supervisorRecord }), { mode: 0o600 });

    // stop must leave it completely alone, and say why.
    const stop = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(stop.code, 3, stop.stderr);
    assert.match(stop.stderr, /DEGRADED hold and was left alone/);
    assert.match(stop.stderr, new RegExp(`residual claude pid=${residual.pid}`));
    assert.equal(ownedProcessState(supervisorRecord), "ours", "the degraded supervisor must survive `stop`");
    assert.equal(existsSync(ctx.paths.lockFile), true, "its lock authority is retained");
    assert.equal(existsSync(ctx.paths.supervisorFile), true, "its residual evidence is retained");

    // doctor is fatal about it rather than reporting a healthy running supervisor.
    const doctor = await ctx.murmur("doctor", ctx.projectPath);
    assert.equal(doctor.code, 2, doctor.stdout);
    assert.match(doctor.stdout, /FAIL\s+supervisor\s+running in a DEGRADED hold/);

    // status says it too, and is unhealthy.
    const status = await ctx.murmur("status", ctx.projectPath, "--json");
    assert.equal(status.code, 3);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.supervisor.degraded, true);
    assert.equal(parsed.healthy, false);
    assert.ok(parsed.problems.some((problem) => problem.includes("degraded hold")), JSON.stringify(parsed.problems));

    // And a new start stays refused while it holds the project.
    const start = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(start.code, 3, start.stderr);
    assert.match(start.stderr, /refusing to start/);
    assert.deepEqual(await ctx.supervisorProcesses(), []);
  } finally {
    supervisor.kill("SIGKILL");
    residual.kill("SIGKILL");
    await exits;
    await ctx.cleanup();
  }
});
