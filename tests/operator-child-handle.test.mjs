// A spawned child whose ownership CANNOT be established must never become a durable
// null-identity record that the supervisor then walks away from. The supervisor still holds
// the trusted ChildProcess handle at that moment, so it resolves the ambiguity first: TERM,
// wait for the ACTUAL exit, KILL, wait again — and if it still cannot observe the exit it
// refuses to exit or release authority at all.
//
// These tests drive real child processes (plus one deliberately inert fake handle) against
// a start-identity probe that fails transiently, permanently, or forever.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { ownedProcessState, probeStartIdentity } from "../scripts/operator/proc.mjs";
import { readRunState, unsettledOwnedChildren } from "../scripts/operator/runstate.mjs";
import { ProjectSupervisor, cleanupRuntimeArtifacts } from "../scripts/operator/supervisor.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

/** Emits the real daemon's readiness line, and exits on SIGTERM like the real one. */
const FAKE_DAEMON = `
const name = process.env.DATA_DIR.split("/").pop();
console.log(JSON.stringify({ level: "info", msg: "Daemon ready", agentId: name }));
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`;

/**
 * A child that IGNORES SIGTERM: only an escalation through the handle can end it.
 *
 * It touches `$TERM_GUARD_MARKER.<pid>` once the handler is installed, so the test can be
 * sure the escalation it asserts is a real refusal to die rather than a race with Node's
 * own startup (a SIGTERM that lands before the handler exists kills by default).
 */
const TERM_RESISTANT_DAEMON = `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { console.log("ignoring SIGTERM"); });
writeFileSync(process.env.TERM_GUARD_MARKER + "." + process.pid, "");
setInterval(() => {}, 1000);
`;

const setup = async ({ daemon = FAKE_DAEMON, ...options } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-hnd-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const fakeRoot = path.join(dir, "fake-murmur");
  mkdirSync(path.join(fakeRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(fakeRoot, "scripts", "murmur-daemon.mjs"), daemon);

  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  const { project } = await bootstrapProfile({ projectId, projectPath, paths });
  // No Codex App Server in these tests: the subject is the daemon child lifecycle.
  project.agents = project.agents.map((agent) => (agent.name === "codex" ? { ...agent, enabled: false } : agent));

  const logs = [];
  const supervisor = new ProjectSupervisor({
    project,
    paths,
    murmurRoot: fakeRoot,
    log: (level, msg, data) => logs.push({ level, msg, ...data }),
    readyTimeoutMs: 6_000,
    stopGraceMs: 600,
    ownershipAttempts: 3,
    ownershipDelayMs: 10,
    ...options,
  });
  return { dir, paths, project, supervisor, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * PID-reuse-proof liveness for these tests.
 *
 * The supervisor under test is deliberately blind (its injected probe never resolves an
 * identity), but the TEST may measure the truth. It records each child's real start identity
 * while the child is running, and afterwards asks the same three-state question production
 * asks — so "gone" here means "gone as OUR process", never "that PID is free now".
 */
const identityRecorder = () => {
  const identities = new Map();
  return {
    identities,
    /** A probe that learns nothing for the supervisor while remembering the truth for us. */
    blindProbe: (pid) => {
      const real = probeStartIdentity(pid);
      if (real.state === "alive") identities.set(Number(pid), real.identity);
      return { state: "unknown", identity: null };
    },
    stateOf: (pid) => ownedProcessState({ pid, startIdentity: identities.get(Number(pid)) ?? null }),
  };
};

// ---------------------------------------------------------------------------
// 1. TRANSIENT PROBE FAILURE
// ---------------------------------------------------------------------------

test("1. a child whose first identity probes fail is still adopted on retry, with no duplicate", async () => {
  let failures = 0;
  const flaky = (pid) => {
    // The first two measurements of ANY child fail the way an overloaded `ps` does.
    if (failures < 2) {
      failures += 1;
      return { state: "unknown", identity: null };
    }
    return probeStartIdentity(pid);
  };
  const ctx = await setup({ probeIdentity: flaky });
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, true, result.reason);
    assert.ok(failures >= 2, "the transient failures really did happen");

    const state = await readRunState(ctx.paths);
    assert.equal(state.phase, "ready");
    const names = Object.keys(state.children).sort();
    assert.deepEqual(names, ["claude", "cursor", "root"]);
    for (const [name, record] of Object.entries(state.children)) {
      assert.equal(record.ownership, "established", name);
      assert.ok(record.startIdentity, `${name} must carry a real start identity`);
      assert.equal(ownedProcessState(record), "ours", name);
    }
    // Exactly one process per agent: a retry must never spawn a second one.
    const pids = Object.values(state.children).map((record) => record.pid);
    assert.equal(new Set(pids).size, pids.length);
  } finally {
    await ctx.supervisor.stop("test");
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2, 4, 6. PERMANENT PROBE FAILURE ON A LIVE CHILD
// ---------------------------------------------------------------------------

test("2. a child that can never be identified is terminated through the retained handle", async () => {
  const truth = identityRecorder();
  const ctx = await setup({ probeIdentity: truth.blindProbe });
  let pids = [];
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false, "a child we cannot identify is never a successful start");
    assert.match(result.reason, /ownership-unverified/);

    // The rollback used the trusted spawn handle, not a naked PID.
    const viaHandle = ctx.logs.filter((entry) => entry.msg === "Signalled a child through its trusted spawn handle");
    assert.ok(viaHandle.length > 0, "the retained handle is what did the terminating");
    for (const entry of viaHandle) assert.ok(entry.signals.includes("SIGTERM"), JSON.stringify(entry.signals));

    // Every child's exit was OBSERVED, and the OS agrees.
    const state = await readRunState(ctx.paths);
    pids = Object.values(state.children).map((record) => record.pid).filter(Boolean);
    assert.ok(pids.length > 0, "children really were spawned");
    for (const [name, record] of Object.entries(state.children)) {
      assert.equal(record.exitObserved, true, `${name}: its exit must be observed, not assumed`);
      assert.ok(record.exit, `${name}: the observed exit is recorded`);
      // Measured against the identity the TEST captured while the child was alive, so this
      // cannot be satisfied by a PID that merely became free (or got reused).
      assert.equal(truth.stateOf(record.pid), "gone", `${name} (pid ${record.pid}) must not survive`);
    }

    // 6. No durable null-identity residual is left for a future Murmur to puzzle over.
    assert.equal(result.clean, true, JSON.stringify(result.residual));
    assert.deepEqual(result.residual, []);
    assert.equal(result.degraded, false);
    assert.equal(state.phase, "failed");
    assert.equal(unsettledOwnedChildren(state).length, 0, "an observed exit settles a record with no identity");

    // Nothing a child left behind blocks cleanup any more. (The only thing still holding it
    // is this test process itself, which the run state names as the supervisor.)
    const cleanup = await cleanupRuntimeArtifacts(ctx.paths, { socketProbe: async () => ({ ok: false, reason: "absent" }) });
    assert.equal(cleanup.unsettledChildren, 0, "no child is left unsettled");
    assert.equal(cleanup.supervisorState, "ours", "the in-process supervisor is this test runner");
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone, which is the point */
      }
    }
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. TERM-RESISTANT CHILD
// ---------------------------------------------------------------------------

test("5. a TERM-resistant unidentifiable child is escalated through the handle and its exit observed", async () => {
  const marker = path.join(shortTmp(), `mur-term-guard-${process.pid}-${Date.now()}`);
  const truth = identityRecorder();
  /**
   * Block the first measurement of each child until that child has installed its SIGTERM
   * handler. Without this the rollback could race Node's startup and win by default action,
   * which would prove nothing about escalation.
   */
  const probeIdentity = (pid) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${marker}.${pid}`) && Date.now() < deadline) {
      try {
        execFileSync("/bin/sleep", ["0.05"], { stdio: "ignore" });
      } catch {
        /* a sleep that cannot be run just makes this a tight spin */
      }
    }
    return truth.blindProbe(pid);
  };
  const ctx = await setup({
    daemon: TERM_RESISTANT_DAEMON,
    probeIdentity,
    stopGraceMs: 400,
    env: { ...process.env, TERM_GUARD_MARKER: marker },
  });
  let pids = [];
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false);

    const state = await readRunState(ctx.paths);
    pids = Object.values(state.children).map((record) => record.pid).filter(Boolean);
    const escalations = ctx.logs.filter((entry) => entry.msg === "Signalled a child through its trusted spawn handle");
    assert.ok(escalations.length > 0);
    for (const entry of escalations) {
      assert.deepEqual(entry.signals, ["SIGTERM", "SIGKILL"], "TERM was ignored, so it had to escalate");
      assert.equal(entry.outcome, "killed");
    }
    for (const [name, record] of Object.entries(state.children)) {
      assert.equal(record.exitObserved, true, name);
      assert.equal(record.stopOutcome, "killed", name);
      assert.equal(truth.stateOf(record.pid), "gone", `${name} (pid ${record.pid}) must not survive`);
    }
    assert.equal(result.clean, true, JSON.stringify(result.residual));
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const pid of pids) rmSync(`${marker}.${pid}`, { force: true });
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// THE UNSETTLEABLE CASE: DEGRADED, NEVER ABANDONED
// ---------------------------------------------------------------------------

/**
 * A handle that reports a live child and swallows every signal — the pathological case in
 * which neither `ps` nor the handle can settle the process. The supervisor must then refuse
 * to call the stop clean, refuse to say the child is gone, and flag the state as DEGRADED so
 * its entry point holds the project instead of exiting and dropping the handle.
 */
const inertHandle = () => {
  const child = new EventEmitter();
  child.pid = 999_499;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = null;
  child.stderr = null;
  child.kill = () => true; // accepted, and ignored
  child.unref = () => {};
  return child;
};

test("an unsettleable child is reported DEGRADED, never silently abandoned", async () => {
  const handles = [];
  const ctx = await setup({
    probeIdentity: () => ({ state: "unknown", identity: null }),
    spawn: () => {
      const child = inertHandle();
      handles.push(child);
      return child;
    },
    stopGraceMs: 120,
  });
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false);
    assert.equal(result.clean, false, "nothing may be reported clean here");
    assert.equal(result.degraded, true, "a retained handle on an unsettled child means DEGRADED");
    assert.ok(result.residual.length > 0);
    for (const entry of result.residual) assert.equal(entry.outcome, "handle-escalation-failed");

    const state = await readRunState(ctx.paths);
    assert.equal(state.phase, "stop-incomplete", "the evidence is kept, not overwritten with `failed`");
    assert.equal(state.degraded, true);
    for (const record of Object.values(state.children)) {
      assert.notEqual(record.exitObserved, true, "an exit we never saw is never recorded as observed");
      assert.equal(record.state, "stop-unconfirmed");
    }
    // Run state, lock and socket all stay: cleanup must refuse to justify what it cannot.
    const cleanup = await cleanupRuntimeArtifacts(ctx.paths, { socketProbe: async () => ({ ok: false, reason: "absent" }) });
    assert.equal(cleanup.retained, true);
    assert.equal(existsSync(ctx.paths.supervisorFile), true);

    // A retry while the handles are still held keeps saying the same thing.
    const retry = await ctx.supervisor.retryResidualTermination({ graceMs: 60 });
    assert.equal(retry.clean, false);
    assert.equal(retry.degraded, true);

    // Once those children really do exit, the very same retry settles and releases.
    for (const handle of handles) {
      handle.exitCode = 0;
      handle.emit("exit", 0, null);
    }
    const resolved = await ctx.supervisor.retryResidualTermination({ graceMs: 60 });
    assert.equal(resolved.clean, true, JSON.stringify(resolved.residual));
    assert.equal(resolved.degraded, false);
    const after = await readRunState(ctx.paths);
    assert.equal(after.phase, "stopped");
    assert.equal(unsettledOwnedChildren(after).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("a child that exits on its own during startup leaves no residual and no null-identity record", async () => {
  // The daemon exits immediately: ownership establishment races a process that is already
  // gone, which is a VERIFIED EXIT, not an unknown.
  const ctx = await setup({ daemon: "process.exit(7);\n" });
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false);
    assert.equal(result.clean, true, JSON.stringify(result.residual));
    assert.equal(result.degraded, false);

    const state = await readRunState(ctx.paths);
    assert.equal(unsettledOwnedChildren(state).length, 0);
    for (const record of Object.values(state.children)) {
      assert.equal(record.exitObserved, true, record.name);
    }
  } finally {
    ctx.cleanup();
  }
});
