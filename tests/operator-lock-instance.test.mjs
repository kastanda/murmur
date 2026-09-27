// Adversarial coverage for LOCK INSTANCE IDENTITY.
//
// A PID names a process slot, not an acquisition. These tests drive the exact sequence that
// used to destroy a live owner's lock: owner A acquires, A dies, the OS hands PID X to
// owner B, B acquires a replacement lock, and a late cleanup path belonging to A calls
// release. Only the exact acquisition instance may ever unlink a lock, so A must fail.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readStartIdentity } from "../scripts/operator/proc.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import {
  LOCK_HELD,
  LOCK_STALE,
  LOCK_UNKNOWN,
  acquireLaunchGuard,
  acquireLock,
  launchGuardState,
  lockState,
  noteLaunchGuardSupervisor,
  readLaunchGuard,
  readLock,
  reclaimStaleLaunchGuard,
  reclaimStaleLock,
  releaseLaunchGuard,
  releaseLock,
} from "../scripts/operator/runstate.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const DEAD = { pid: 999_411, startIdentity: "Thu Jan  1 00:00:00 1970" };

const setup = () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-lockid-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const paths = projectPathsFor(projectIdFor(projectPath), { home: path.join(dir, ".murmur") });
  mkdirSync(paths.runDir, { recursive: true });
  return { dir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Us, but identified exactly — the shape every acquisition is given. */
const me = (startIdentity = readStartIdentity(process.pid)) => ({ pid: process.pid, startIdentity });

// ---------------------------------------------------------------------------
// 7-8. RELEASE REQUIRES THE EXACT INSTANCE
// ---------------------------------------------------------------------------

test("7. a lock release requires the exact lockId minted by that acquisition", () => {
  const ctx = setup();
  try {
    const owner = me();
    const acquired = acquireLock(ctx.paths, owner);
    assert.equal(acquired.acquired, true);
    assert.ok(acquired.owner.lockId, "every acquisition mints an instance token");
    assert.equal(readLock(ctx.paths).lockId, acquired.owner.lockId);

    // The caller-supplied owner object has NO token: it names a process, not an acquisition.
    const withoutToken = releaseLock(ctx.paths, owner);
    assert.equal(withoutToken.released, false);
    assert.equal(withoutToken.reason, "owner-changed");
    assert.equal(existsSync(ctx.paths.lockFile), true, "a tokenless caller must not unlink the lock");

    // A fabricated token is no better.
    const wrongToken = releaseLock(ctx.paths, { ...acquired.owner, lockId: "00000000-0000-4000-8000-000000000000" });
    assert.equal(wrongToken.released, false);
    assert.equal(existsSync(ctx.paths.lockFile), true);

    // The exact instance releases it.
    const released = releaseLock(ctx.paths, acquired.owner);
    assert.deepEqual(released, { released: true, reason: null });
    assert.equal(existsSync(ctx.paths.lockFile), false);
  } finally {
    ctx.cleanup();
  }
});

test("8. a lock release requires the exact owner identity, and null identity is never authority", () => {
  const ctx = setup();
  try {
    const acquired = acquireLock(ctx.paths, me());
    assert.equal(acquired.acquired, true);

    // Right token, wrong start identity: a different process generation.
    const wrongIdentity = releaseLock(ctx.paths, { ...acquired.owner, startIdentity: "an-identity-from-another-process" });
    assert.equal(wrongIdentity.released, false);
    assert.equal(wrongIdentity.reason, "owner-changed");

    // Right token, wrong PID.
    const wrongPid = releaseLock(ctx.paths, { ...acquired.owner, pid: acquired.owner.pid + 1 });
    assert.equal(wrongPid.released, false);

    // "I could not identify myself" is not authority to delete anything.
    const nullIdentity = releaseLock(ctx.paths, { ...acquired.owner, startIdentity: null });
    assert.equal(nullIdentity.released, false);
    assert.equal(existsSync(ctx.paths.lockFile), true);

    // And a lock whose stored identity is null cannot be released either — it can only ever
    // be reasoned about as `unknown`, which is never reclaimable.
    rmSync(ctx.paths.lockFile);
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ lockId: "l1", pid: process.pid, startIdentity: null }));
    assert.equal(releaseLock(ctx.paths, { lockId: "l1", pid: process.pid, startIdentity: null }).released, false);
    assert.equal(lockState(ctx.paths).state, LOCK_UNKNOWN);
    assert.equal(existsSync(ctx.paths.lockFile), true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9-10. PID REUSE
// ---------------------------------------------------------------------------

test("9. a stale owner cannot remove a REPLACEMENT lock that reused its PID", () => {
  const ctx = setup();
  try {
    // 1. Lock A: lockId=A, pid=X, startIdentity=A.
    const a = acquireLock(ctx.paths, { pid: process.pid, startIdentity: "identity-A" });
    assert.equal(a.acquired, true);

    // 2. A exits; PID X is reused by owner B, which acquires a REPLACEMENT lock:
    //    lockId=B, pid=X (the same PID!), startIdentity=B.
    rmSync(ctx.paths.lockFile);
    const b = acquireLock(ctx.paths, { pid: process.pid, startIdentity: "identity-B" });
    assert.equal(b.acquired, true);
    assert.notEqual(a.owner.lockId, b.owner.lockId);
    assert.equal(readLock(ctx.paths).pid, process.pid, "both acquisitions really do share one PID");

    // 3. A's stale cleanup path calls release. Under PID-only comparison this unlinked B's
    //    live lock; now it must refuse.
    const stale = releaseLock(ctx.paths, a.owner);
    assert.equal(stale.released, false);
    assert.equal(stale.reason, "owner-changed");
    assert.equal(stale.heldBy.lockId, b.owner.lockId, "release reports the changed owner");
    assert.equal(existsSync(ctx.paths.lockFile), true, "B's lock must remain intact");
    assert.equal(readLock(ctx.paths).lockId, b.owner.lockId);

    // B itself still owns its acquisition.
    assert.equal(releaseLock(ctx.paths, b.owner).released, true);
  } finally {
    ctx.cleanup();
  }
});

test("10. a different lockId blocks release even with the SAME pid and startIdentity", () => {
  const ctx = setup();
  try {
    const owner = { pid: process.pid, startIdentity: "identical-mocked-identity" };
    const first = acquireLock(ctx.paths, owner);
    assert.equal(first.acquired, true);

    // Same process, same measured identity, a NEW acquisition. Process metadata alone
    // cannot tell these two apart — only the instance token can.
    rmSync(ctx.paths.lockFile);
    const second = acquireLock(ctx.paths, owner);
    assert.equal(second.acquired, true);
    assert.equal(readLock(ctx.paths).pid, first.owner.pid);
    assert.equal(readLock(ctx.paths).startIdentity, first.owner.startIdentity);
    assert.notEqual(second.owner.lockId, first.owner.lockId);

    const fromFirst = releaseLock(ctx.paths, first.owner);
    assert.equal(fromFirst.released, false, "an earlier acquisition can never remove a later one");
    assert.equal(fromFirst.reason, "owner-changed");
    assert.equal(existsSync(ctx.paths.lockFile), true);

    assert.equal(releaseLock(ctx.paths, second.owner).released, true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// RELEASE vs RECLAMATION
// ---------------------------------------------------------------------------

test("reclamation needs proof the stored owner is gone; release needs the instance token", () => {
  const ctx = setup();
  try {
    // HELD: never reclaimed.
    const live = acquireLock(ctx.paths, me());
    assert.equal(lockState(ctx.paths).state, LOCK_HELD);
    const heldAttempt = reclaimStaleLock(ctx.paths);
    assert.equal(heldAttempt.reclaimed, false);
    assert.equal(existsSync(ctx.paths.lockFile), true);
    releaseLock(ctx.paths, live.owner);

    // UNKNOWN: never reclaimed.
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ lockId: "u", acquiredAt: new Date().toISOString() }));
    assert.equal(lockState(ctx.paths).state, LOCK_UNKNOWN);
    assert.equal(reclaimStaleLock(ctx.paths).reclaimed, false);
    assert.equal(existsSync(ctx.paths.lockFile), true);
    rmSync(ctx.paths.lockFile);

    // STALE with a MISMATCHED expectation: still not ours to remove.
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ lockId: "s", ...DEAD }));
    assert.equal(lockState(ctx.paths).state, LOCK_STALE);
    const mismatch = reclaimStaleLock(ctx.paths, { expected: { pid: 999_412, startIdentity: "other" } });
    assert.equal(mismatch.reclaimed, false);
    assert.equal(mismatch.reason, "owner-mismatch");
    assert.equal(existsSync(ctx.paths.lockFile), true);

    // STALE, owner proven gone: reclaimable without any token.
    const reclaimed = reclaimStaleLock(ctx.paths, { expected: DEAD });
    assert.equal(reclaimed.reclaimed, true);
    assert.equal(existsSync(ctx.paths.lockFile), false);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// LAUNCH GUARD: THE SAME INSTANCE SEMANTICS
// ---------------------------------------------------------------------------

test("the launch guard carries a launchId with the same instance semantics", () => {
  const ctx = setup();
  try {
    const first = acquireLaunchGuard(ctx.paths, me());
    assert.equal(first.acquired, true);
    assert.ok(first.guard.launchId);
    assert.equal(launchGuardState(ctx.paths).state, LOCK_HELD);

    // A second launcher fails closed while the guard is active.
    const second = acquireLaunchGuard(ctx.paths, { pid: 999_413, startIdentity: "other-launcher" });
    assert.equal(second.acquired, false);
    assert.equal(second.guardState, LOCK_HELD);
    assert.equal(readLaunchGuard(ctx.paths).launchId, first.guard.launchId, "the guard is untouched by a refused start");

    // Only the exact launchId may remove it.
    assert.equal(releaseLaunchGuard(ctx.paths, { ...first.guard, launchId: "not-the-launch-id" }).released, false);
    assert.equal(releaseLaunchGuard(ctx.paths, { ...first.guard, startIdentity: "wrong" }).released, false);
    assert.equal(existsSync(ctx.paths.launchGuardFile), true);
    assert.equal(releaseLaunchGuard(ctx.paths, first.guard).released, true);
    assert.equal(existsSync(ctx.paths.launchGuardFile), false);

    // A replacement guard on the same PID cannot be removed by the earlier launch.
    const a = acquireLaunchGuard(ctx.paths, { pid: process.pid, startIdentity: "launcher-A" });
    rmSync(ctx.paths.launchGuardFile);
    const b = acquireLaunchGuard(ctx.paths, { pid: process.pid, startIdentity: "launcher-B" });
    assert.equal(releaseLaunchGuard(ctx.paths, a.guard).released, false);
    assert.equal(readLaunchGuard(ctx.paths).launchId, b.guard.launchId);
    assert.equal(releaseLaunchGuard(ctx.paths, b.guard).released, true);
  } finally {
    ctx.cleanup();
  }
});

test("a guard whose launcher died is only reclaimable when its supervisor is proven gone", () => {
  const ctx = setup();
  try {
    // A launcher that is gone, which recorded a verified supervisor that is ALSO gone.
    writeFileSync(ctx.paths.launchGuardFile, JSON.stringify({ launchId: "g1", ...DEAD, supervisor: DEAD }));
    assert.equal(launchGuardState(ctx.paths).state, LOCK_STALE);
    const next = acquireLaunchGuard(ctx.paths, me());
    assert.equal(next.acquired, true, "a genuinely finished failed launch must not block starts forever");
    releaseLaunchGuard(ctx.paths, next.guard);

    // Now a gone launcher whose recorded supervisor CANNOT be proven gone: a live PID with
    // no identity is `unknown`, and unknown is not gone.
    writeFileSync(ctx.paths.launchGuardFile, JSON.stringify({
      launchId: "g2", ...DEAD, supervisor: { pid: process.pid, startIdentity: null },
    }));
    assert.equal(launchGuardState(ctx.paths).state, LOCK_STALE, "the LAUNCHER is gone...");
    const refused = acquireLaunchGuard(ctx.paths, me());
    assert.equal(refused.acquired, false, "...but its supervisor is unknown, so the guard stays");
    assert.equal(refused.reason, "launched-supervisor-unknown");
    assert.equal(existsSync(ctx.paths.launchGuardFile), true);
    assert.equal(reclaimStaleLaunchGuard(ctx.paths).reclaimed, false);

    // Once that supervisor is proven gone (a PID that does not exist), the guard is
    // reclaimable by the normal stale rules.
    writeFileSync(ctx.paths.launchGuardFile, JSON.stringify({ launchId: "g3", ...DEAD, supervisor: DEAD }));
    assert.equal(reclaimStaleLaunchGuard(ctx.paths).reclaimed, true);
    assert.equal(existsSync(ctx.paths.launchGuardFile), false);
  } finally {
    ctx.cleanup();
  }
});

test("noting the launched supervisor preserves the guard's own instance identity", () => {
  const ctx = setup();
  try {
    const guard = acquireLaunchGuard(ctx.paths, me());
    const supervisor = { pid: 999_414, startIdentity: "supervisor-identity" };
    assert.equal(noteLaunchGuardSupervisor(ctx.paths, guard.guard, supervisor).updated, true);

    const stored = readLaunchGuard(ctx.paths);
    assert.deepEqual(stored.supervisor, supervisor);
    assert.equal(stored.launchId, guard.guard.launchId, "the launchId survives the update");
    assert.equal(stored.phase, "supervisor-verified");
    // And the original instance can still release it.
    assert.equal(releaseLaunchGuard(ctx.paths, guard.guard).released, true);

    // A stranger's guard is never overwritten.
    writeFileSync(ctx.paths.launchGuardFile, JSON.stringify({ launchId: "someone-else", ...me() }));
    assert.equal(noteLaunchGuardSupervisor(ctx.paths, guard.guard, supervisor).updated, false);
    assert.equal(readLaunchGuard(ctx.paths).supervisor, undefined);
  } finally {
    ctx.cleanup();
  }
});
