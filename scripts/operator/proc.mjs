/**
 * proc.mjs — process ownership primitives for the project supervisor.
 *
 * Two rules the whole operator CLI depends on:
 *
 * 1. A PID is NEVER sufficient identity — operating systems reuse PIDs. Every recorded
 *    process carries a start identity (its kernel start time) and a signal is only ever
 *    delivered after that identity is re-read and still matches.
 * 2. Ownership is never inferred from command-line text. Murmur signals exactly the PIDs
 *    it spawned; there is no name-based matching and no `pkill`.
 */
import { execFileSync } from "node:child_process";

const PS_BIN = "/bin/ps";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `ps -o lstart=` renders the start time with strftime, so its text depends on the
 * caller's locale and timezone. Two Murmur processes with different environments would
 * otherwise compute DIFFERENT identities for the SAME process and each conclude the
 * other's child was gone. Pinning locale and timezone makes the identity canonical
 * for a given host.
 */
const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" };

/**
 * Probe `pid`'s start identity, distinguishing THREE outcomes:
 *
 *   `alive`   — ps answered and the process exists (with its start identity);
 *   `gone`    — ps answered and there is no such process;
 *   `unknown` — ps itself could not be run or timed out.
 *
 * Collapsing `unknown` into `gone` is a real hazard: under heavy load `ps` can exceed
 * its timeout, and a caller that reads that as "already dead" will skip the kill and
 * leak the very child it was asked to stop. Everything that stops a process must treat
 * `unknown` as "still possibly alive".
 */
export const probeStartIdentity = (pid, { attempts = 3, timeoutMs = 10_000 } = {}) => {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return { state: "gone", identity: null };
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const out = execFileSync(PS_BIN, ["-o", "lstart=", "-p", String(numeric)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: PS_ENV,
        timeout: timeoutMs,
      });
      const value = out.trim();
      return value ? { state: "alive", identity: value } : { state: "gone", identity: null };
    } catch (err) {
      lastError = err;
      // `ps` ran and reported "no such process": a clean exit status, no transport error.
      if (err?.status === 1 && !err?.signal && err?.code === undefined) return { state: "gone", identity: null };
      // Anything else (ETIMEDOUT, ENOENT, killed by a signal) is a failed measurement.
    }
  }
  return { state: "unknown", identity: null, error: lastError?.code || lastError?.message || "ps-failed" };
};

/**
 * Kernel-reported start time for `pid`, or null when the process does not exist
 * (or could not be measured — use `probeStartIdentity` when that difference matters).
 */
export const readStartIdentity = (pid) => probeStartIdentity(pid).identity;

/** True when the PID exists at all (identity-agnostic). */
export const pidExists = (pid) => {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

export const OWNED = "ours";
export const GONE = "gone";
export const UNKNOWN = "unknown";

/**
 * Ownership state of a recorded process. THREE distinct facts, never collapsed:
 *
 *   `ours`    — measured alive, and still the exact process Murmur started;
 *   `gone`    — measured, and our process is definitively no longer there (either no
 *               such PID at all, or the PID now belongs to a different process);
 *   `unknown` — ownership could not be proven right now, so the process may still be
 *               ours and alive.
 *
 * `gone` is only ever returned on POSITIVE evidence of absence. In particular a record
 * whose `startIdentity` was never captured is `unknown` — not `gone`. A missing initial
 * identity means "ownership cannot yet be proven", which is the opposite of "the process
 * is absent"; treating it as absence lets cleanup report success over a live detached
 * process.
 *
 * A process that exists but whose ownership cannot be established from trusted
 * spawn-time evidence is also `unknown`: it is never promoted to `ours` on a guess, so
 * PID-reuse protection is never weakened.
 */
export const ownedProcessState = ({ pid, startIdentity, exitObserved }, { probe = probeStartIdentity } = {}) => {
  // The creator watched this exact process exit through its trusted spawn handle. That is
  // the strongest possible evidence of absence — stronger than `ps`, which can be fooled
  // by PID reuse into reporting a live stranger where our child used to be. This flag is
  // ONLY ever written after an actual `exit` event on the ChildProcess we spawned.
  if (exitObserved === true) return GONE;

  const numeric = Number(pid);
  // No PID was ever recorded: there is nothing that could be running.
  if (!Number.isInteger(numeric) || numeric <= 0) return GONE;

  const result = probe(numeric);
  // The measurement itself failed. Nothing may be concluded, with or without an identity.
  if (result.state === UNKNOWN) return UNKNOWN;
  // Positive evidence of absence.
  if (result.state === GONE) return GONE;

  // A process exists at this PID.
  if (!startIdentity) return UNKNOWN; // exists, but ownership was never established
  // The PID was reused by something else: OUR process is genuinely gone, and the
  // current occupant must never be signalled.
  return result.identity === startIdentity ? OWNED : GONE;
};

/** True only for the states that prove our process is no longer running. */
export const provenGone = (state) => state === GONE;

/**
 * Capture a freshly spawned process's start identity with bounded retry.
 *
 * Until this succeeds the record is `unverified`: the process was definitely spawned,
 * but ownership cannot be proven, so it may never be signalled and may never be
 * reported as gone. `child` (when supplied) is trusted spawn-time evidence — while Node
 * still holds a non-exited handle we know the process exists.
 */
export const establishOwnership = async (
  pid,
  { attempts = 5, delayMs = 100, probe = probeStartIdentity, sleep = delay, child = null } = {},
) => {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return { ownership: "gone", startIdentity: null };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = probe(numeric);
    if (result.state === "alive") return { ownership: "established", startIdentity: result.identity };
    if (result.state === GONE) {
      // A handle that has not exited outranks a `ps` that says the PID is absent:
      // trust the spawn-time evidence and keep probing rather than declaring it gone.
      const handleSaysAlive = child && child.exitCode === null && child.signalCode === null;
      if (!handleSaysAlive) return { ownership: "gone", startIdentity: null };
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return { ownership: "unverified", startIdentity: null };
};

/**
 * INFORMATIONAL ONLY. True when the process is measured alive AND is still exactly the
 * process Murmur started. It cannot distinguish `gone` from `unknown`, so it must never
 * drive an authoritative decision (deleting a lock or run state, unlinking a socket,
 * allowing a start, or declaring a stop complete) — those all use `ownedProcessState`.
 */
export const isOwnedProcessAlive = ({ pid, startIdentity }, { readIdentity = readStartIdentity } = {}) => {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (!startIdentity) return false;
  const current = readIdentity(numeric);
  if (current === null || current === undefined) return false;
  return current === startIdentity;
};

/** Signal a process only if its identity still matches. Returns true when delivered. */
export const signalOwnedProcess = ({ pid, startIdentity }, signal, { readIdentity = readStartIdentity, kill = process.kill.bind(process) } = {}) => {
  if (!isOwnedProcessAlive({ pid, startIdentity }, { readIdentity })) return false;
  try {
    kill(Number(pid), signal);
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    throw err;
  }
};

/**
 * SIGTERM, bounded wait, then SIGKILL — against one exactly-identified process.
 *
 * Outcomes: `not-running`, `terminated`, `killed`, `identity-unknown` (liveness could
 * not be measured, so nothing was signalled and the caller must treat it as residual),
 * or `escalation-failed`. It NEVER reports success for a process it could not confirm
 * had gone, because a caller that believes a leaked child is dead will leave it behind.
 */
export const stopOwnedProcess = (
  record,
  { graceMs = 10_000, pollMs = 100, probe = probeStartIdentity, kill = process.kill.bind(process), sleep = delay,
    readIdentity } = {},
) => {
  // `readIdentity` remains supported for callers/tests that inject a simple reader.
  const effectiveProbe = readIdentity
    ? (pid) => {
      const identity = readIdentity(pid);
      return identity === null || identity === undefined ? { state: "gone", identity: null } : { state: "alive", identity };
    }
    : probe;
  const state = () => ownedProcessState(record, { probe: effectiveProbe });

  return (async () => {
    const initial = state();
    if (provenGone(initial)) return "not-running";
    if (initial === UNKNOWN) {
      // Do not signal on a guess. Retry the measurement within the grace window.
      const retryUntil = Date.now() + Math.min(graceMs, 5_000);
      let current = initial;
      while (Date.now() < retryUntil && current === UNKNOWN) {
        await sleep(pollMs);
        current = state();
      }
      if (provenGone(current)) return "not-running";
      if (current === UNKNOWN) return "identity-unknown";
    }

    signalOwnedProcess(record, "SIGTERM", { readIdentity: (pid) => effectiveProbe(pid).identity, kill });
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (provenGone(state())) return "terminated";
      await sleep(pollMs);
    }
    if (provenGone(state())) return "terminated";

    signalOwnedProcess(record, "SIGKILL", { readIdentity: (pid) => effectiveProbe(pid).identity, kill });
    const killDeadline = Date.now() + Math.min(graceMs, 5_000);
    while (Date.now() < killDeadline) {
      if (provenGone(state())) return "killed";
      await sleep(pollMs);
    }
    // Never report success for an exit we could not observe.
    const final = state();
    return provenGone(final) ? "killed" : (final === UNKNOWN ? "identity-unknown" : "escalation-failed");
  })();
};

/** Outcomes that mean the process is genuinely no longer running. */
export const STOP_OUTCOMES_SETTLED = Object.freeze(["not-running", "terminated", "killed"]);
export const stopSettled = (outcome) => STOP_OUTCOMES_SETTLED.includes(outcome);

// ---------------------------------------------------------------------------
// TRUSTED SPAWN-HANDLE LIFECYCLE
// ---------------------------------------------------------------------------
/**
 * The ChildProcess object returned by `spawn` is the ONLY evidence that outranks a `ps`
 * measurement: while Node still holds a non-exited handle the process provably exists,
 * and its `exit` event is a first-hand observation of the OS reaping it.
 *
 * That evidence is strictly scoped:
 *
 *   - it is the actual object this process got back from THIS spawn;
 *   - it is valid only until its exit has been observed;
 *   - "we once spawned PID X" is NEVER equivalent evidence once the handle is gone.
 *
 * Everything durable (a record on disk, a later `murmur stop`) therefore still goes
 * through exact process identity; the handle is used only by the creator, in-process,
 * while it still holds it.
 */

/**
 * Latch a spawned child's exit. Returns `{ state, promise }` where `state.exited`
 * becomes true the moment the handle reports the process reaped, and `promise` resolves
 * with that state. Both are safe to consult repeatedly.
 */
export const observeChildExit = (child) => {
  const state = {
    exited: child.exitCode !== null || child.signalCode !== null,
    code: child.exitCode ?? null,
    signal: child.signalCode ?? null,
    spawnFailed: false,
    error: null,
  };
  const promise = new Promise((resolve) => {
    if (state.exited) {
      resolve(state);
      return;
    }
    child.once("exit", (code, signal) => {
      state.exited = true;
      state.code = code ?? null;
      state.signal = signal ?? null;
      resolve(state);
    });
    child.once("error", (err) => {
      state.error = err?.message || String(err);
      // An `error` with no PID means the process was never created, so there is nothing
      // to own. An `error` on a child that DID start (a failed kill, for instance) is not
      // an exit and must never be mistaken for one.
      if (child.pid === undefined || child.pid === null) {
        state.exited = true;
        state.spawnFailed = true;
        resolve(state);
      }
    });
  });
  return { state, promise };
};

/** Wait up to `timeoutMs` for an observed exit. Resolves true only on a real exit. */
const waitForObservedExit = (exit, timeoutMs) =>
  new Promise((resolve) => {
    if (exit.state.exited) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    exit.promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });

/**
 * Terminate a process through the trusted spawn handle we still hold: SIGTERM, wait for
 * the ACTUAL `exit` event, then SIGKILL, then wait again.
 *
 * This is the only safe way to clean up a child whose ownership could not be measured —
 * a naked PID must never be signalled, but our own non-exited handle cannot be pointing
 * at anything except the process we created.
 *
 * Outcomes use the same vocabulary as `stopOwnedProcess`, plus `handle-escalation-failed`
 * for "we signalled through the handle and STILL never observed the exit", which is never
 * reported as settled.
 */
export const terminateSpawnedChild = async (
  child,
  { exit = null, graceMs = 10_000, killGraceMs = null } = {},
) => {
  if (!child) return { settled: false, outcome: "no-trusted-handle", signalled: [] };
  const observed = exit ?? observeChildExit(child);
  const signalled = [];
  // Nothing was ever created, or the exit is already observed: verified absent.
  if (observed.state.exited) return { settled: true, outcome: "not-running", signalled };
  if (child.pid === undefined || child.pid === null) return { settled: true, outcome: "not-running", signalled };

  const send = (signal) => {
    try {
      child.kill(signal);
      signalled.push(signal);
    } catch (err) {
      // ESRCH means the OS already reaped it; the exit latch settles that authoritatively.
      if (err?.code !== "ESRCH") throw err;
    }
  };

  send("SIGTERM");
  if (await waitForObservedExit(observed, graceMs)) return { settled: true, outcome: "terminated", signalled };
  send("SIGKILL");
  if (await waitForObservedExit(observed, killGraceMs ?? Math.min(graceMs, 5_000))) {
    return { settled: true, outcome: "killed", signalled };
  }
  return { settled: false, outcome: "handle-escalation-failed", signalled };
};

/** True while `child` is trusted spawn-time evidence: our handle, and not yet exited. */
export const hasTrustedHandle = (child, exit = null) => {
  if (!child) return false;
  if (exit?.state?.exited) return false;
  if (child.pid === undefined || child.pid === null) return false;
  return child.exitCode === null && child.signalCode === null;
};
