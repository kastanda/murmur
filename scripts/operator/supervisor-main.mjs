#!/usr/bin/env node
/**
 * supervisor-main.mjs — detached entry point for ONE project supervisor.
 *
 * Launched by `murmur start` with its stdout/stderr already redirected into
 * `logs/supervisor.log`. It is the authoritative lock holder for the project: the CLI's
 * duplicate-start check is a fast courtesy, this `O_EXCL` acquisition is the real one.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "./profile.mjs";
import { murmurHome, projectPathsFor } from "./project.mjs";
import { establishOwnership } from "./proc.mjs";
import { acquireLock, readRunState, releaseLock, writeRunState } from "./runstate.mjs";
import { ProjectSupervisor } from "./supervisor.mjs";

const log = (level, msg, data = {}) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })}\n`);
};

const argOf = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const projectId = argOf("project-id");
if (!projectId) {
  log("fatal", "supervisor-project-id-required");
  process.exit(2);
}

const paths = projectPathsFor(projectId, { home: murmurHome() });
const murmurRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Establish OUR OWN ownership before claiming authority: a supervisor that cannot be
// identified could never be safely stopped by a later `murmur stop`.
const self = await establishOwnership(process.pid);
if (self.ownership !== "established") {
  log("fatal", "supervisor-own-identity-unverifiable", { ownership: self.ownership });
  process.exit(4);
}
const owner = { pid: process.pid, startIdentity: self.startIdentity, projectId };

const lock = acquireLock(paths, owner);
if (!lock.acquired) {
  // The live supervisor owns `supervisor.json`; a refused duplicate must not write into
  // it, or it would smear a bogus error across a perfectly healthy project. An
  // `unknown` lock owner is NOT reclaimed — exclusivity is preserved on doubt.
  log("fatal", "supervisor-lock-not-acquired", {
    lockState: lock.lockState, reason: lock.reason, heldByPid: lock.heldBy?.pid ?? null,
  });
  process.exit(3);
}
/**
 * The EXACT acquisition instance, not just "pid + identity". Only this object may release
 * the lock, so a later, unrelated acquisition on a reused PID can never be unlinked by us.
 */
const lockInstance = lock.owner;

/** How often a degraded supervisor re-attempts the exit it could not observe. */
const DEGRADED_RETRY_MS = Number(process.env.MURMUR_DEGRADED_RETRY_MS || 15_000);

let supervisor;
let shuttingDown = false;
let degraded = false;
let retrying = false;

/**
 * DEGRADED HOLD — the alternative to abandoning a process we cannot prove is gone.
 *
 * When a child is unsettled but we still hold its trusted spawn handle, exiting would
 * destroy the last thing that can force or observe its exit, leaving a live process that no
 * future Murmur could ever prove it owns. So the supervisor does the opposite of exiting:
 *
 *   - it stays alive, holding every retained ChildProcess handle;
 *   - it keeps the authoritative project lock, so no new start can overlap it;
 *   - it keeps `phase: stop-incomplete` with the residual evidence in run state;
 *   - it keeps retrying termination through those handles.
 *
 * If a retry finally observes every exit, the hold resolves: the lock is released with our
 * exact instance token and the process exits non-zero, because the stop was not clean.
 */
const holdDegraded = (reason, residual) => {
  degraded = true;
  log("fatal", "Supervisor DEGRADED: retaining project authority and trusted spawn handles", {
    projectId, reason, residual, retryMs: DEGRADED_RETRY_MS,
  });
  // A ref'd timer deliberately keeps this process alive: the handles die with it.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const retry = setInterval(async () => {
    if (retrying) return;
    retrying = true;
    try {
      const result = await supervisor.retryResidualTermination();
      if (result.clean) {
        clearInterval(retry);
        clearInterval(keepAlive);
        const released = releaseLock(paths, lockInstance);
        log("info", "Degraded hold resolved: every owned process is now proven gone", {
          projectId, lockReleased: released.released, lockReason: released.reason,
        });
        process.exit(5);
      }
      log("error", "Degraded hold continues: an owned process is still not proven gone", {
        projectId, residual: result.residual,
      });
    } catch (err) {
      log("error", "Degraded retry failed", { error: err?.message });
    } finally {
      retrying = false;
    }
  }, DEGRADED_RETRY_MS);
};

/**
 * Authority is released ONLY once every owned child is proven gone.
 *
 * If a child cannot be settled the supervisor keeps the lock and leaves the run state
 * in `stop-incomplete` with the residual PID/start-identity records intact. While a
 * trusted spawn handle for that child still exists it does not exit at all (see
 * `holdDegraded`); only when nothing can be done in-process does it exit non-zero,
 * retaining the lock so `murmur stop` can retry and `murmur start` stays refused.
 */
const shutdown = async (signal) => {
  if (shuttingDown) {
    if (degraded) log("error", "Ignoring signal while degraded: trusted handles must not be dropped", { signal });
    return;
  }
  shuttingDown = true;
  log("info", "Supervisor shutting down", { signal });
  let result = { clean: false, residual: [{ name: "supervisor", reason: "stop-not-run" }], degraded: false };
  try {
    result = (await supervisor?.stop(`signal:${signal}`)) || { clean: true, residual: [], degraded: false };
  } catch (err) {
    log("error", "Supervisor stop error", { error: err?.message });
    result = { clean: false, residual: [{ name: "supervisor", reason: err?.message || "stop-error" }], degraded: false };
  }

  if (!result.clean) {
    log("fatal", "Supervisor cleanup incomplete; retaining lock and residual evidence", {
      projectId, residual: result.residual, degraded: result.degraded,
    });
    try {
      const previous = (await readRunState(paths)) || {};
      await writeRunState(paths, {
        ...previous, phase: "stop-incomplete", residual: result.residual, degraded: result.degraded, stoppedAt: null,
      });
    } catch (err) {
      log("error", "Could not persist residual evidence", { error: err?.message });
    }
    if (result.degraded) {
      holdDegraded(`signal:${signal}`, result.residual);
      return;
    }
    process.exit(5);
  }

  const released = releaseLock(paths, lockInstance);
  log("info", "Supervisor stopped", { projectId, lockReleased: released.released, lockReason: released.reason });
  process.exit(0);
};

process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });

try {
  const project = await loadProfile(paths);
  supervisor = new ProjectSupervisor({ project, paths, murmurRoot, log });
  const result = await supervisor.start();
  if (!result.ok) {
    // A rollback that could not prove every child gone keeps the lock: the project is
    // not safe to start again until that residual is resolved.
    if (result.clean === false) {
      log("fatal", "Supervisor start failed and rollback was incomplete; retaining lock", {
        reason: result.reason, residual: result.residual, degraded: result.degraded,
      });
      if (result.degraded) {
        // A child is alive-or-unknown and we still hold its spawn handle. Do NOT exit.
        holdDegraded(`start-failed:${result.reason}`, result.residual);
      } else {
        process.exit(5);
      }
    } else {
      const released = releaseLock(paths, lockInstance);
      log("fatal", "Supervisor start failed", { reason: result.reason, lockReleased: released.released });
      process.exit(1);
    }
  } else {
    // Stay alive so the supervisor keeps owning its children. A periodic persist keeps
    // `murmur status` honest about a child that died on its own.
    const heartbeat = setInterval(() => {
      supervisor.persist({}).catch((err) => log("warn", "Run state persist failed", { error: err?.message }));
    }, 5_000);
    heartbeat.unref?.();
    setInterval(() => {}, 1 << 30);
  }
} catch (err) {
  log("fatal", "Supervisor crashed", { error: err?.message });
  let crashStop = { clean: true, residual: [], degraded: false };
  try {
    crashStop = (await supervisor?.stop("crash")) || crashStop;
  } catch {
    crashStop = { clean: false, residual: [{ name: "supervisor", reason: "crash-stop-failed" }], degraded: false };
  }
  if (!crashStop.clean) {
    log("fatal", "Crash cleanup incomplete; retaining lock and residual evidence", {
      residual: crashStop.residual, degraded: crashStop.degraded,
    });
    if (crashStop.degraded) holdDegraded("crash", crashStop.residual);
    else process.exit(5);
  } else {
    releaseLock(paths, lockInstance);
    process.exit(1);
  }
}
