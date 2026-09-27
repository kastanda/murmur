/**
 * runstate.mjs — the supervisor's durable run state and its exclusive lock.
 *
 * `supervisor.json` is the single place that records which PIDs this project's
 * supervisor owns. Stop and status read it; nothing else is allowed to infer
 * ownership from process names.
 */
import { randomUUID } from "node:crypto";
import { closeSync, ftruncateSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { constants } from "node:fs";
import { rm } from "node:fs/promises";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "../secure-state.mjs";
import { GONE, OWNED, UNKNOWN, ownedProcessState, provenGone } from "./proc.mjs";

export const RUNSTATE_VERSION = 1;

export const readRunState = async (paths) => {
  try {
    const state = await readPrivateJson(paths.supervisorFile);
    if (!state || state.version !== RUNSTATE_VERSION) return null;
    return state;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
};

export const writeRunState = async (paths, state) => {
  await ensurePrivateDirectory(paths.runDir);
  await writePrivateJson(paths.supervisorFile, { ...state, version: RUNSTATE_VERSION });
};

export const clearRunState = async (paths) => {
  await rm(paths.supervisorFile, { force: true });
};

/** Three-state ownership of the supervisor recorded in run state. */
export const supervisorState = (state) => (state?.supervisor ? ownedProcessState(state.supervisor) : GONE);

/** Three-state ownership of every child the run state claims. */
export const ownedChildStates = (state) =>
  Object.entries(state?.children || {}).map(([name, record]) => ({ name, ...record, state: ownedProcessState(record) }));

/** Children that are NOT proven gone — reaping candidates, and residual evidence. */
export const unsettledOwnedChildren = (state) => ownedChildStates(state).filter((entry) => !provenGone(entry.state));

export const LOCK_FREE = "free";
export const LOCK_HELD = "held";
export const LOCK_STALE = "stale";
export const LOCK_UNKNOWN = "unknown";

// ---------------------------------------------------------------------------
// INSTANCE-SAFE EXCLUSION FILES
// ---------------------------------------------------------------------------
/**
 * Both exclusion files in this module (the authoritative supervisor lock and the CLI's
 * launch guard) are the SAME primitive: an `O_EXCL` file whose payload names exactly one
 * acquisition instance.
 *
 * Why an instance token and not just a PID
 * ----------------------------------------
 * A PID identifies a process slot, not an acquisition. Consider:
 *
 *   owner A acquires (pid X, identity A) -> A exits -> the OS reuses pid X for owner B,
 *   which acquires a REPLACEMENT lock (pid X, identity B).
 *
 * A late cleanup path belonging to A that compares only the PID would happily unlink B's
 * live lock. Even comparing the start identity is not quite enough: the same process can
 * legitimately acquire, release and re-acquire, and a stale release from the first
 * acquisition must not remove the second one. So every acquisition mints a random token
 * and a release only ever unlinks a file that still carries that exact token, PID and
 * start identity.
 *
 * RELEASE and RECLAMATION are deliberately different operations:
 *
 *   release   — "I am done with MY acquisition": requires the exact instance token.
 *   reclaim   — "the recorded owner is provably gone": requires POSITIVE evidence of
 *               absence (`stale`), never a token, and never happens on `unknown`.
 */

/** Classify an exclusion file into the three ownership facts, never two. */
const instanceFileState = (file, { label }) => {
  const held = readInstanceFile(file);
  if (!held) return { state: LOCK_FREE, heldBy: null, reason: null };
  if (!held.pid) {
    // No owner recorded: unreadable/garbage. That is not evidence the owner is gone.
    return { state: LOCK_UNKNOWN, heldBy: held, reason: `${label}-owner-unrecorded` };
  }
  const owner = ownedProcessState(held);
  if (owner === OWNED) return { state: LOCK_HELD, heldBy: held, reason: null };
  if (owner === UNKNOWN) return { state: LOCK_UNKNOWN, heldBy: held, reason: `${label}-owner-unverifiable` };
  return { state: LOCK_STALE, heldBy: held, reason: `${label}-owner-gone` };
};

const readInstanceFile = (file) => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const writeInstanceFile = (file, payload, { create }) => {
  const flags = create
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_NOFOLLOW;
  const fd = openSync(file, flags, 0o600);
  try {
    if (!create) ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify(payload), 0);
  } finally {
    closeSync(fd);
  }
};

/**
 * Atomically create an exclusion file, minting a fresh instance token.
 *
 * Reclamation requires POSITIVE evidence that the previous owner is gone. `held` and
 * `unknown` both fail closed.
 */
const acquireInstanceFile = (file, owner, { tokenKey, label, contendedReason, reclaimable = () => ({ ok: true, reason: null }) }) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const instance = { ...owner, [tokenKey]: randomUUID(), acquiredAt: new Date().toISOString() };
    try {
      writeInstanceFile(file, instance, { create: true });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const current = instanceFileState(file, { label });
      if (current.state !== LOCK_STALE) {
        return { acquired: false, instance: null, heldBy: current.heldBy, state: current.state, reason: current.reason || contendedReason };
      }
      // The recorded owner is proven gone — but it may have left something of its own
      // behind that is NOT proven gone, in which case this file is not ours to take.
      const permitted = reclaimable(current.heldBy);
      if (!permitted.ok) {
        return { acquired: false, instance: null, heldBy: current.heldBy, state: current.state, reason: permitted.reason };
      }
      // Proven gone (no such process, or the PID was reused by something unrelated).
      try {
        unlinkSync(file);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
      }
      continue;
    }
    return { acquired: true, instance, heldBy: null, state: LOCK_FREE, reason: null };
  }
  const current = instanceFileState(file, { label });
  return { acquired: false, instance: null, heldBy: current.heldBy, state: current.state, reason: current.reason || contendedReason };
};

/**
 * Does the file on disk still describe EXACTLY the acquisition the caller performed?
 *
 * `startIdentity` must match too, and a null identity on either side is never treated as
 * a match: "I could not identify myself" is not authority to delete someone else's file.
 */
const matchesInstance = (current, holder, tokenKey) => {
  if (!current || !holder) return false;
  const token = holder[tokenKey];
  if (!token || current[tokenKey] !== token) return false;
  if (Number(current.pid) !== Number(holder.pid)) return false;
  if (!current.startIdentity || !holder.startIdentity) return false;
  return current.startIdentity === holder.startIdentity;
};

/** Remove an exclusion file ONLY when it still is the caller's exact acquisition. */
const releaseInstanceFile = (file, holder, { tokenKey }) => {
  const current = readInstanceFile(file);
  if (!current) return { released: false, reason: "not-present" };
  if (!matchesInstance(current, holder, tokenKey)) {
    // A replacement acquisition (very possibly on the same reused PID) owns this file now.
    return { released: false, reason: "owner-changed", heldBy: current };
  }
  try {
    unlinkSync(file);
    return { released: true, reason: null };
  } catch (err) {
    if (err?.code === "ENOENT") return { released: false, reason: "not-present" };
    throw err;
  }
};

/**
 * Reclaim an exclusion file whose recorded owner is PROVEN gone. This is the only way a
 * process that does not hold the instance token may remove the file, and it demands
 * positive evidence of absence: `unknown` is retained, always.
 */
const reclaimInstanceFile = (file, { label, expected = null }) => {
  const current = instanceFileState(file, { label });
  if (current.state === LOCK_FREE) return { reclaimed: false, reason: "not-present", state: current.state };
  if (current.state !== LOCK_STALE) return { reclaimed: false, reason: current.reason || "owner-not-proven-gone", state: current.state };
  if (expected && Number(current.heldBy?.pid) !== Number(expected.pid)) {
    // Someone else's acquisition, also gone. It is still not ours to reason about.
    return { reclaimed: false, reason: "owner-mismatch", state: current.state, heldBy: current.heldBy };
  }
  try {
    unlinkSync(file);
    return { reclaimed: true, reason: null, state: current.state };
  } catch (err) {
    if (err?.code === "ENOENT") return { reclaimed: false, reason: "not-present", state: current.state };
    throw err;
  }
};

// ---------------------------------------------------------------------------
// AUTHORITATIVE SUPERVISOR LOCK
// ---------------------------------------------------------------------------
/**
 * Classify the project lock in THREE ownership facts, never two.
 *
 * `stale` — and only `stale` — permits reclamation. A lock whose owner could not be
 * measured is `unknown`: it stays exactly where it is. Deleting it because `ps`
 * happened to fail would let a second supervisor start alongside a perfectly healthy
 * one, which is the whole thing the lock exists to prevent.
 */
export const lockState = (paths) => instanceFileState(paths.lockFile, { label: "lock" });

/**
 * Exclusive project lock. `O_EXCL` makes acquisition atomic, so two concurrent
 * `murmur start` invocations cannot both win.
 *
 * On success `owner` is the caller's exact acquisition instance (the passed-in owner plus
 * a freshly minted `lockId`). That object — not the bare PID — is what `releaseLock`
 * requires later.
 */
export const acquireLock = (paths, owner) => {
  const result = acquireInstanceFile(paths.lockFile, owner, {
    tokenKey: "lockId",
    label: "lock",
    contendedReason: "lock-held",
  });
  return {
    acquired: result.acquired,
    owner: result.instance,
    heldBy: result.heldBy,
    lockState: result.state,
    reason: result.reason,
  };
};

export const readLock = (paths) => readInstanceFile(paths.lockFile);

/**
 * Release the lock, and ONLY the caller's own acquisition of it.
 *
 * `owner` must be the object `acquireLock` returned. If the file on disk now belongs to a
 * different acquisition — a replacement lock on a reused PID, for instance — nothing is
 * unlinked and the caller is told the owner changed.
 */
export const releaseLock = (paths, owner) => releaseInstanceFile(paths.lockFile, owner, { tokenKey: "lockId" });

/**
 * Reclaim a lock whose recorded owner is proven gone. Used by post-stop cleanup, which by
 * definition does not hold the dead supervisor's instance token.
 */
export const reclaimStaleLock = (paths, { expected = null } = {}) =>
  reclaimInstanceFile(paths.lockFile, { label: "lock", expected });

// ---------------------------------------------------------------------------
// LAUNCH GUARD
// ---------------------------------------------------------------------------
/**
 * The launch guard closes the one interval the supervisor lock cannot: between "a CLI has
 * decided to spawn a supervisor" and "that supervisor has acquired the authoritative lock
 * and published its run state". Without it two `murmur start` invocations can both pass
 * the duplicate check and both spawn a supervisor, and only one of them will lose the
 * lock race — after the loser has already created a process.
 *
 * It is created by the CLI BEFORE the spawn, carries a random `launchId` plus the
 * launcher's own identity, and is removed by that exact launcher only after the verified
 * supervisor owns the project. If a launch fails and its cleanup is incomplete the guard
 * deliberately stays behind and keeps the project fail-closed.
 */
export const launchGuardState = (paths) =>
  instanceFileState(paths.launchGuardFile, { label: "guard" });

export const readLaunchGuard = (paths) => readInstanceFile(paths.launchGuardFile);

/**
 * LAUNCH LIFECYCLE recorded in the guard, and the reclaimability rule for each phase.
 *
 * Creating an OS process is irreversible and cannot be made atomic with a disk write, so the
 * durable state moves FIRST, conservatively: before the spawn, the guard already says "a
 * supervisor may exist". From that boundary on, only POSITIVE later evidence can make the
 * guard automatically reclaimable again — the absence of evidence never can.
 *
 *   phase                        meaning                              auto-reclaim when launcher gone
 *   ---------------------------  -----------------------------------  ------------------------------
 *   `launching`                  guard taken, no spawn intended yet   yes (nothing can exist yet)
 *   `supervisor-spawn-intent`    a spawn is ABOUT to happen; whether   NO — unknown, manual recovery
 *                                a process exists is unknowable
 *   `supervisor-spawned`         a process exists, identity unproven   NO — manual recovery
 *   `supervisor-verified`        exact pid + start identity captured   only if THAT process is gone
 *   `cleanup-unverified`         spawned, never identified, exit
 *                                never observed, cleanup gave up      NO — manual recovery
 *   `supervisor-exited`          its exit was OBSERVED via the handle  yes
 *   `spawn-failed`               Node proved no process was created    yes
 *
 * The property that matters is monotonic safety: once `supervisor-spawn-intent` is durable,
 * nothing short of proof (no process created / process exited / verified process proven gone)
 * restores automatic reclamation.
 */
export const GUARD_LAUNCHING = "launching";
export const GUARD_SPAWN_INTENT = "supervisor-spawn-intent";
export const GUARD_SUPERVISOR_SPAWNED = "supervisor-spawned";
export const GUARD_SUPERVISOR_VERIFIED = "supervisor-verified";
export const GUARD_CLEANUP_UNVERIFIED = "cleanup-unverified";
export const GUARD_SUPERVISOR_EXITED = "supervisor-exited";
export const GUARD_SPAWN_FAILED = "spawn-failed";

/**
 * May a STALE launch guard (its launcher proven gone) be reclaimed?
 *
 * Decided by EVIDENCE, in priority order, never by the absence of a field:
 *
 *   1. Node proved the spawn created no process            -> safe
 *   2. the creator observed the process exit               -> safe
 *   3. a verified identity exists                          -> safe only once it is proven gone
 *   4. a spawn was intended or performed and none of the
 *      above ever happened                                 -> NEVER (manual recovery)
 *   5. the guard states no spawn was ever intended         -> safe
 *   6. anything else (unrecognised state)                   -> NEVER
 *
 * Rule 4 is the whole point: a launcher that is SIGKILLed anywhere between "about to spawn"
 * and "identity established" leaves a guard with no PID and no identity, and that is UNKNOWN,
 * not proof that nothing runs. Preferring a conservative false lock there is deliberate —
 * overlapping supervisors are unrecoverable, a manual unlock is not.
 */
export const launchGuardReclaimable = (heldBy) => {
  if (!heldBy) return { ok: true, reason: null };

  // 1. The spawn definitively created nothing (a synchronous throw, or Node reporting no pid).
  if (heldBy.noProcessProven === true) return { ok: true, reason: null };

  // 2. First-hand evidence of absence: the creator watched this exact process exit.
  if (heldBy.exitObserved === true) return { ok: true, reason: null };

  // 3. A verified identity: measure that exact process, and require positive absence.
  if (heldBy.supervisor) {
    const state = ownedProcessState(heldBy.supervisor);
    if (provenGone(state)) return { ok: true, reason: null };
    return { ok: false, reason: `launched-supervisor-${state}`, supervisor: heldBy.supervisor, supervisorState: state };
  }

  // 4. A spawn was intended or performed, and nothing above ever proved it resolved. This
  //    covers every crash point from just-before-spawn to just-before-identity.
  if (heldBy.spawnIntent === true || heldBy.supervisorWasSpawned === true || heldBy.unsafeToReclaim === true) {
    return {
      ok: false,
      reason: heldBy.supervisorWasSpawned === true
        ? (heldBy.phase === GUARD_CLEANUP_UNVERIFIED ? `guard-${GUARD_CLEANUP_UNVERIFIED}` : "launched-supervisor-unverified")
        : "launch-spawn-intent-unresolved",
      spawnedPid: heldBy.spawnedPid ?? null,
      manualRecovery: true,
    };
  }

  // 5. Only a guard that says, in its own durable state, that no spawn was ever intended.
  if (heldBy.supervisorWasSpawned === false && heldBy.spawnIntent !== true) return { ok: true, reason: null };

  // 6. Unrecognised/incomplete state is not proof that nothing was spawned.
  return { ok: false, reason: "guard-launch-state-unknown", manualRecovery: true };
};

export const acquireLaunchGuard = (paths, launcher) => {
  const result = acquireInstanceFile(paths.launchGuardFile, {
    ...launcher,
    role: "launcher",
    phase: GUARD_LAUNCHING,
    // Stated explicitly from the very first write: nothing has been spawned under this guard
    // yet. Every later transition only ever makes this MORE restrictive.
    supervisorWasSpawned: false,
  }, {
    tokenKey: "launchId",
    label: "guard",
    contendedReason: "launch-in-progress",
    reclaimable: launchGuardReclaimable,
  });
  return {
    acquired: result.acquired,
    guard: result.instance,
    heldBy: result.heldBy,
    guardState: result.state,
    reason: result.reason,
  };
};

/**
 * Patch the guard the launcher still owns, in place, keeping its instance identity.
 *
 * Every launch-lifecycle transition goes through here, and each one is verified against the
 * caller's exact `launchId` first — a launcher can only ever rewrite its own guard.
 */
const updateLaunchGuard = (paths, guard, patch) => {
  const current = readInstanceFile(paths.launchGuardFile);
  if (!matchesInstance(current, guard, "launchId")) return { updated: false, reason: "owner-changed" };
  try {
    writeInstanceFile(paths.launchGuardFile, { ...current, ...patch, notedAt: new Date().toISOString() }, { create: false });
  } catch (err) {
    // The guard vanished (or became unwritable) between the check and the write. The caller
    // must treat that as "our exclusion is gone", not as a successful transition.
    return { updated: false, reason: `guard-write-failed:${err?.code || err?.message}` };
  }
  return { updated: true, reason: null };
};

/**
 * THE PRE-SPAWN BOUNDARY. A supervisor spawn is about to be attempted.
 *
 * `spawn()` is irreversible and cannot be made atomic with a disk write, so the conservative
 * state goes to disk FIRST. Between this write and the next one, whether a process exists is
 * genuinely unknowable to any later reader — so from here on the guard is not automatically
 * reclaimable until something positive is proven.
 *
 * The caller MUST NOT spawn if this does not persist.
 */
export const noteLaunchGuardSpawnIntent = (paths, guard) =>
  updateLaunchGuard(paths, guard, {
    phase: GUARD_SPAWN_INTENT,
    spawnIntent: true,
    unsafeToReclaim: true,
  });

/**
 * A process now EXISTS under this guard, before anything about it has been proven.
 *
 * Written immediately after the spawn returns. The spawn-intent boundary above is what covers
 * the instant in between: a launcher killed there leaves a guard that already refuses
 * automatic reclamation, instead of one that claims nothing was ever started.
 */
export const noteLaunchGuardSpawn = (paths, guard, { pid }) =>
  updateLaunchGuard(paths, guard, {
    spawnIntent: true,
    supervisorWasSpawned: true,
    spawnedPid: pid ?? null,
    phase: GUARD_SUPERVISOR_SPAWNED,
    // Deliberately NOT weakened by this transition.
    unsafeToReclaim: true,
  });

/**
 * Node PROVED the spawn created no process: a synchronous throw, or a ChildProcess with no pid
 * (for which Node guarantees an `error` event and no process). This is the one terminal state
 * that makes a spawn-intent guard safe again, so ordinary spawn failures never become a
 * permanent lock.
 *
 * It is never inferred from a missing PID record on disk — only from live Node evidence.
 */
export const noteLaunchGuardSpawnFailed = (paths, guard, { error = null } = {}) =>
  updateLaunchGuard(paths, guard, {
    phase: GUARD_SPAWN_FAILED,
    processCreated: false,
    noProcessProven: true,
    unsafeToReclaim: false,
    spawnError: error,
  });

/**
 * Record the verified supervisor this launch created, inside the guard the launcher still
 * owns. It is written only after the supervisor's identity was established from trusted
 * spawn-time evidence, so it is a durable, trustworthy handle on the process even if the
 * launcher is killed a moment later: a later start finds the guard, measures THAT record
 * and stays refused while it cannot be proven gone.
 */
export const noteLaunchGuardSupervisor = (paths, guard, supervisor, { phase = GUARD_SUPERVISOR_VERIFIED } = {}) =>
  updateLaunchGuard(paths, guard, {
    supervisor,
    spawnIntent: true,
    supervisorWasSpawned: true,
    spawnedPid: supervisor?.pid ?? null,
    phase,
  });

/**
 * The launcher spawned a supervisor, could not establish its identity, signalled it through
 * the trusted handle and STILL never observed an exit.
 *
 * This makes the guard non-reclaimable by every automatic path. It is written BEFORE the
 * launcher enters its cleanup hold, so the durable state is already fail-closed even if the
 * launcher is externally killed during that hold.
 */
export const noteLaunchGuardCleanupUnverified = (paths, guard, { pid = null, outcome = null, signalled = [] } = {}) =>
  updateLaunchGuard(paths, guard, {
    supervisorWasSpawned: true,
    spawnedPid: pid,
    phase: GUARD_CLEANUP_UNVERIFIED,
    unsafeToReclaim: true,
    unresolved: { pid, outcome, signalled, at: new Date().toISOString() },
  });

/**
 * The spawned supervisor's exit has now been OBSERVED through the trusted handle. Recorded
 * before the guard is released, so a crash in between still leaves reclaimable state.
 */
export const noteLaunchGuardSupervisorExited = (paths, guard, { pid = null, outcome = null } = {}) =>
  updateLaunchGuard(paths, guard, {
    phase: GUARD_SUPERVISOR_EXITED,
    exitObserved: true,
    unsafeToReclaim: false,
    spawnedPid: pid,
    exit: { pid, outcome, at: new Date().toISOString() },
  });

export const releaseLaunchGuard = (paths, guard) =>
  releaseInstanceFile(paths.launchGuardFile, guard, { tokenKey: "launchId" });

/**
 * Reclaim a launch guard whose launcher is proven gone AND whose recorded supervisor is
 * proven gone. Used by `murmur stop` once it has proven the whole project settled; it is a
 * RECLAMATION (positive evidence of absence), never a release (instance token).
 */
export const reclaimStaleLaunchGuard = (paths) => {
  const current = launchGuardState(paths);
  if (current.state === LOCK_FREE) return { reclaimed: false, reason: "not-present", state: current.state };
  if (current.state !== LOCK_STALE) {
    return { reclaimed: false, reason: current.reason || "launcher-not-proven-gone", state: current.state };
  }
  const permitted = launchGuardReclaimable(current.heldBy);
  if (!permitted.ok) return { reclaimed: false, reason: permitted.reason, state: current.state, supervisor: permitted.supervisor };
  return reclaimInstanceFile(paths.launchGuardFile, { label: "guard" });
};
