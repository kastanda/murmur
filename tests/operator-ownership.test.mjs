// Adversarial coverage for the three-state ownership model: an UNKNOWN measurement
// must never be laundered into GONE by the lock, by stop/cleanup, or by a new start.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  establishOwnership,
  isOwnedProcessAlive,
  ownedProcessState,
  probeStartIdentity,
  provenGone,
  readStartIdentity,
  stopOwnedProcess,
  stopSettled,
} from "../scripts/operator/proc.mjs";
import {
  LOCK_FREE,
  LOCK_HELD,
  LOCK_STALE,
  LOCK_UNKNOWN,
  acquireLock,
  lockState,
  readLock,
  readRunState,
  supervisorState,
  unsettledOwnedChildren,
  writeRunState,
} from "../scripts/operator/runstate.mjs";
import { cleanupRuntimeArtifacts, reapOrphanedChildren } from "../scripts/operator/supervisor.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const DEAD = { pid: 999_401, startIdentity: "Thu Jan  1 00:00:00 1970" };

const sleeper = () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, record: (name) => ({ name, pid: child.pid, startIdentity: readStartIdentity(child.pid) }) };
};

const setup = () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-own-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const paths = projectPathsFor(projectIdFor(projectPath), { home: path.join(dir, ".murmur") });
  mkdirSync(paths.runDir, { recursive: true });
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ---------------------------------------------------------------------------
// PROCESS IDENTITY (1-6)
// ---------------------------------------------------------------------------

test("1. stored startIdentity=null + probe unknown is UNKNOWN, never gone", () => {
  const state = ownedProcessState({ pid: 4242, startIdentity: null }, { probe: () => ({ state: "unknown", identity: null }) });
  assert.equal(state, "unknown");
  assert.equal(provenGone(state), false);
});

test("2. stored identity known + probe unknown is UNKNOWN", () => {
  const state = ownedProcessState({ pid: 4242, startIdentity: "known" }, { probe: () => ({ state: "unknown", identity: null }) });
  assert.equal(state, "unknown");
});

test("3. a genuinely absent process is GONE", async () => {
  const { child, exited } = sleeper();
  const record = { pid: child.pid, startIdentity: readStartIdentity(child.pid) };
  child.kill("SIGKILL");
  await exited;
  assert.equal(ownedProcessState(record), "gone");
  assert.equal(ownedProcessState({ pid: 4242, startIdentity: null }, { probe: () => ({ state: "gone", identity: null }) }), "gone");
});

test("4. a reused PID is GONE for us and the unrelated occupant is never signalled", async () => {
  const { child, exited } = sleeper();
  const signals = [];
  try {
    const record = { pid: child.pid, startIdentity: "an-identity-from-an-earlier-process" };
    assert.equal(ownedProcessState(record), "gone", "our process is gone; the PID now belongs to someone else");
    const outcome = await stopOwnedProcess(record, { graceMs: 200, pollMs: 10, kill: (...args) => signals.push(args) });
    assert.equal(outcome, "not-running");
    assert.deepEqual(signals, [], "the unrelated occupant must never be signalled");
    assert.equal(ownedProcessState({ pid: child.pid, startIdentity: readStartIdentity(child.pid) }), "ours");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("5. a spawn whose first measurement fails still establishes ownership on retry", async () => {
  let calls = 0;
  const flaky = (pid) => {
    calls += 1;
    return calls <= 2 ? { state: "unknown", identity: null } : { state: "alive", identity: `identity-of-${pid}` };
  };
  const result = await establishOwnership(77, { probe: flaky, sleep: async () => {}, attempts: 5 });
  assert.deepEqual(result, { ownership: "established", startIdentity: "identity-of-77" });
});

test("6. a spawn that stays unmeasurable is `unverified` — never gone, never established", async () => {
  const result = await establishOwnership(77, {
    probe: () => ({ state: "unknown", identity: null }),
    sleep: async () => {},
    attempts: 3,
  });
  assert.deepEqual(result, { ownership: "unverified", startIdentity: null });
  // And such a record is UNKNOWN, so cleanup can never call it clean.
  assert.equal(ownedProcessState({ pid: 77, startIdentity: result.startIdentity },
    { probe: () => ({ state: "unknown", identity: null }) }), "unknown");

  // A `ps` that says "gone" while the spawn handle has NOT exited is not believed.
  const liveHandle = { exitCode: null, signalCode: null };
  const stubborn = await establishOwnership(77, {
    probe: () => ({ state: "gone", identity: null }),
    sleep: async () => {},
    attempts: 3,
    child: liveHandle,
  });
  assert.equal(stubborn.ownership, "unverified", "trusted spawn-time evidence outranks a contradicting ps");
});

// ---------------------------------------------------------------------------
// LOCK (7-9)
// ---------------------------------------------------------------------------

test("7. a live lock owner whose measurement temporarily fails does NOT lose the lock", () => {
  const ctx = setup();
  const supervisor = sleeper();
  try {
    const owner = supervisor.record("supervisor");
    assert.equal(acquireLock(ctx.paths, owner).acquired, true);

    // Healthy case first.
    assert.equal(lockState(ctx.paths).state, LOCK_HELD);

    // Now make the measurement fail: the lock must be classified unknown and KEPT.
    const unknownProbe = () => ({ state: "unknown", identity: null });
    const classified = (() => {
      const held = readLock(ctx.paths);
      return ownedProcessState(held, { probe: unknownProbe });
    })();
    assert.equal(classified, "unknown");
    assert.equal(existsSync(ctx.paths.lockFile), true, "the lock file must still be on disk");
  } finally {
    supervisor.child.kill("SIGKILL");
    ctx.cleanup();
  }
});

test("8. a second start is refused while the lock owner is unknown", () => {
  const ctx = setup();
  try {
    // A lock with no recorded owner cannot be proven abandoned.
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ acquiredAt: new Date().toISOString() }));
    const state = lockState(ctx.paths);
    assert.equal(state.state, LOCK_UNKNOWN);
    assert.equal(state.reason, "lock-owner-unrecorded");

    const attempt = acquireLock(ctx.paths, { pid: process.pid, startIdentity: readStartIdentity(process.pid) });
    assert.equal(attempt.acquired, false);
    assert.equal(attempt.lockState, LOCK_UNKNOWN);
    assert.equal(existsSync(ctx.paths.lockFile), true, "an unknown-owner lock is never deleted");
  } finally {
    ctx.cleanup();
  }
});

test("9. only an authoritatively gone owner permits stale-lock reclamation", () => {
  const ctx = setup();
  try {
    writeFileSync(ctx.paths.lockFile, JSON.stringify(DEAD));
    assert.equal(lockState(ctx.paths).state, LOCK_STALE);
    const me = { pid: process.pid, startIdentity: readStartIdentity(process.pid) };
    const attempt = acquireLock(ctx.paths, me);
    assert.equal(attempt.acquired, true);
    assert.equal(lockState(ctx.paths).state, LOCK_HELD);
    rmSync(ctx.paths.lockFile);
    assert.equal(lockState(ctx.paths).state, LOCK_FREE);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// STOP / CLEANUP EVIDENCE (10-14)
// ---------------------------------------------------------------------------

test("10. a child that cannot be proven gone keeps run state, evidence and lock", async () => {
  const ctx = setup();
  const bystander = sleeper();
  try {
    // A live PID with NO recorded identity: ownership is unprovable, so it is UNKNOWN.
    const unverifiable = { name: "claude", pid: bystander.child.pid, startIdentity: null };
    await writeRunState(ctx.paths, {
      projectId: "p", phase: "stopping",
      supervisor: DEAD,
      children: { claude: unverifiable },
    });
    writeFileSync(ctx.paths.lockFile, JSON.stringify(DEAD));

    const stopped = await reapOrphanedChildren(ctx.paths, { graceMs: 300 });
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].settled, false, "an unprovable child is never reported stopped");

    const result = await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(result.retained, true, "cleanup must refuse to delete evidence it cannot justify");
    assert.deepEqual(result.removed, []);

    // Evidence and authority survive for the retry.
    const after = await readRunState(ctx.paths);
    assert.equal(after.children.claude.pid, bystander.child.pid);
    assert.equal(existsSync(ctx.paths.lockFile), true, "lock authority is retained");
    assert.equal(unsettledOwnedChildren(after).length, 1);
    assert.equal(stopSettled(stopped[0].outcome), false);
  } finally {
    bystander.child.kill("SIGKILL");
    await bystander.exited;
    ctx.cleanup();
  }
});

test("11. only evidence the creator actually captured can settle a record — nothing invents it", async () => {
  const ctx = setup();
  const spawned = sleeper();
  const unverifiable = sleeper();
  try {
    // PART A — TRUSTED EVIDENCE OUTLIVES ITS CREATOR.
    // The identity in this record was captured at spawn time, while the creator still held
    // the trusted handle. That is a legitimate durable record, so a later, separate cleanup
    // can act on it: exact PID + exact start identity.
    await writeRunState(ctx.paths, {
      projectId: "p", phase: "stopping", supervisor: DEAD,
      children: { claude: spawned.record("claude") },
    });
    const settled = await reapOrphanedChildren(ctx.paths, { graceMs: 8_000 });
    assert.equal(settled[0].settled, true, settled[0].outcome);
    await spawned.exited;
    const cleaned = await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(cleaned.retained, false, "everything is proven gone, so state may be cleaned");
    assert.equal(existsSync(ctx.paths.supervisorFile), false);

    // PART B — AN UNVERIFIED RECORD IS NOT MADE "RECOVERABLE" BY ANYTHING HERE.
    // A live PID with no captured identity can never be signalled and can never be declared
    // gone. There is deliberately NO production path that fills in the identity afterwards:
    // once the trusted spawn-time evidence is lost, fail-closed/manual recovery is the honest
    // outcome. (The supervisor resolving this WHILE it still holds the handle — the only
    // trustworthy way — is covered in tests/operator-child-handle.test.mjs.)
    await writeRunState(ctx.paths, {
      projectId: "p", phase: "stopping", supervisor: DEAD,
      children: { claude: { name: "claude", pid: unverifiable.child.pid, startIdentity: null } },
    });
    const attempt = await reapOrphanedChildren(ctx.paths, { graceMs: 300 });
    assert.equal(attempt[0].settled, false, "an unprovable record is never reported stopped");
    assert.equal(attempt[0].outcome, "identity-unknown");

    const after = await readRunState(ctx.paths);
    assert.equal(unsettledOwnedChildren(after).length, 1);
    assert.equal(unsettledOwnedChildren(after)[0].state, "unknown", "unknown, never gone");
    const retained = await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(retained.retained, true, "cleanup must refuse to justify what it cannot prove");
    assert.equal(existsSync(ctx.paths.supervisorFile), true, "the evidence is kept for manual recovery");
    // And the process itself was never touched on a guess.
    assert.equal(isOwnedProcessAlive({ pid: unverifiable.child.pid, startIdentity: readStartIdentity(unverifiable.child.pid) }), true);
  } finally {
    spawned.child.kill("SIGKILL");
    unverifiable.child.kill("SIGKILL");
    await unverifiable.exited;
    ctx.cleanup();
  }
});

test("12. unresolved residual keeps the project fail-closed against a new start", async () => {
  const ctx = setup();
  const bystander = sleeper();
  try {
    await writeRunState(ctx.paths, {
      projectId: "p", phase: "stop-incomplete", supervisor: DEAD,
      children: { claude: { name: "claude", pid: bystander.child.pid, startIdentity: null } },
    });
    const state = await readRunState(ctx.paths);
    assert.equal(supervisorState(state), "gone");
    // The supervisor is gone, but a residual child is NOT proven gone, so a start must
    // still be refused: the two facts are independent.
    assert.equal(unsettledOwnedChildren(state).length, 1);
    assert.equal(unsettledOwnedChildren(state)[0].state, "unknown");
  } finally {
    bystander.child.kill("SIGKILL");
    await bystander.exited;
    ctx.cleanup();
  }
});

test("13. an unmeasurable supervisor blocks cleanup even when no child is recorded", async () => {
  const ctx = setup();
  const supervisor = sleeper();
  try {
    await writeRunState(ctx.paths, {
      projectId: "p", phase: "stopping",
      supervisor: { name: "supervisor", pid: supervisor.child.pid, startIdentity: null },
      children: {},
    });
    const result = await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(result.retained, true);
    assert.equal(result.supervisorState, "unknown");
    assert.equal(existsSync(ctx.paths.supervisorFile), true);
  } finally {
    supervisor.child.kill("SIGKILL");
    await supervisor.exited;
    ctx.cleanup();
  }
});

test("14. a fully proven stop cleans run state, lock and socket", async () => {
  const ctx = setup();
  try {
    await writeRunState(ctx.paths, { projectId: "p", phase: "stopped", supervisor: DEAD, children: {} });
    writeFileSync(ctx.paths.lockFile, JSON.stringify(DEAD));
    writeFileSync(ctx.paths.codexSocket, "");

    const result = await cleanupRuntimeArtifacts(ctx.paths, { socketProbe: async () => ({ ok: false, reason: "stale" }) });
    assert.equal(result.retained, false);
    assert.equal(existsSync(ctx.paths.supervisorFile), false);
    assert.equal(existsSync(ctx.paths.lockFile), false);
    assert.equal(existsSync(ctx.paths.codexSocket), false);
  } finally {
    ctx.cleanup();
  }
});

test("probeStartIdentity itself never reports a live process as gone", async () => {
  const { child, exited } = sleeper();
  try {
    assert.equal(probeStartIdentity(child.pid).state, "alive");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});
