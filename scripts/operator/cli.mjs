/**
 * cli.mjs — the `murmur` local operator CLI.
 *
 *   murmur start   <project> [--foreground] [--timeout <s>]
 *   murmur status  <project> [--json]
 *   murmur stop    <project>
 *   murmur doctor  <project> [--json]
 *   murmur logs    <project> [child] [-n <lines>] [--follow]
 *   murmur send    <project> "<task>" [--timeout <s>] [--no-wait]
 *   murmur notify  status | migrate [--from <dir>] | test
 *
 * Exit codes: 0 ok · 1 usage/resolution · 2 preflight failed · 3 unhealthy or not
 * running · 4 start failed.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync, openSync, closeSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { ensurePrivateDirectory } from "../secure-state.mjs";
import {
  FAIL,
  formatReport,
  hasFatal,
  runDiagnostics,
  worstStatus,
} from "./doctor.mjs";
import {
  agentByName,
  bootstrapProfile,
  enabledAgents,
  loadProfile,
  profileExists,
  publicProfileSummary,
} from "./profile.mjs";
import { commandClaude } from "./claude.mjs";
import { commandWork } from "./work.mjs";
import { commandUsage } from "./usage.mjs";
import { commandCodex } from "./codex-model.mjs";
import { commandCursor } from "./cursor.mjs";
import { commandNotify } from "./notify.mjs";
import { locateProject, murmurHome, projectPathsFor } from "./project.mjs";
import {
  UNKNOWN,
  establishOwnership,
  hasTrustedHandle,
  observeChildExit,
  ownedProcessState,
  pidExists,
  probeStartIdentity,
  provenGone,
  readStartIdentity,
  stopOwnedProcess,
  stopSettled,
  terminateSpawnedChild,
} from "./proc.mjs";
import {
  GUARD_CLEANUP_UNVERIFIED,
  LOCK_FREE,
  LOCK_HELD,
  LOCK_STALE,
  LOCK_UNKNOWN,
  acquireLaunchGuard,
  acquireLock,
  launchGuardReclaimable,
  launchGuardState,
  lockState,
  noteLaunchGuardCleanupUnverified,
  noteLaunchGuardSpawn,
  noteLaunchGuardSpawnFailed,
  noteLaunchGuardSpawnIntent,
  noteLaunchGuardSupervisor,
  noteLaunchGuardSupervisorExited,
  readLaunchGuard,
  readLock,
  readRunState,
  reclaimStaleLaunchGuard,
  releaseLaunchGuard,
  releaseLock,
  supervisorState,
  unsettledOwnedChildren,
  writeRunState,
} from "./runstate.mjs";
import { enqueueRootTask, findRejectedCandidates, rootWorkflowCancelledAt, waitForCorrelatedReply } from "./send.mjs";
import { lowLimitWarnings } from "./usage.mjs";
import { classifyRuntimeOutput, OUTPUT_KINDS } from "../runtime-output.mjs";
import { collectStatus } from "./status.mjs";
import { CODEX_APP_SERVER_CHILD, cleanupRuntimeArtifacts, reapOrphanedChildren } from "./supervisor.mjs";

const MURMUR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPERVISOR_ENTRY = path.join(MURMUR_ROOT, "scripts", "operator", "supervisor-main.mjs");

/**
 * Period between re-attempts while a `start` is holding a supervisor whose exit it could not
 * observe. Bounded and never zero, so the hold is a slow, safe wait loop rather than a spin.
 */
const CLEANUP_HOLD_POLL_MS = Math.max(250, Number(process.env.MURMUR_CLEANUP_HOLD_POLL_MS) || 5_000);

const USAGE = `murmur — local operator CLI for Murmur multi-agent projects

Usage:
  murmur start   <project> [--foreground] [--timeout <seconds>]
  murmur status  <project> [--json]
  murmur stop    <project> [--timeout <seconds>]
  murmur doctor  <project> [--json]
  murmur logs    <project> [supervisor|root|claude|codex|cursor|codex-app-server] [-n <lines>] [--follow]
  murmur send    <project> "<task>" [--timeout <seconds>] [--no-wait]
  murmur projects [--json]
  murmur claude   <project> config [--json] [--refresh] | model <id|inherit> | effort <level>
  murmur codex    <project> config [--json] [--refresh] | model <id|inherit> | effort <level>
  murmur tasks    <project> [--json]
  murmur task     <project> <workflow-id> [--json]
  murmur cancel   <project> <workflow-id> [--json]
  murmur usage    <project> [--json] [--refresh]
  murmur cursor   <project> config [--json]
  murmur notify  status | mode <activity|errors|default> | migrate [--from <dir>] | test

<project> is an absolute path, or a name resolved under ~/Projects/<name>.
Profiles and all runtime state live under ~/.murmur/projects/<project-id>/.

\`murmur notify\` configures notifications once per USER, in
~/.murmur/notifications.json — no project ever stores the credential.
\`murmur notify mode activity\` turns Telegram into a human activity feed: who asked
whom, the topic, the answer and the final result — no ACK/heartbeat/retry noise.
`;

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);

/** Collapse an absolute path back to `~/...` for display only. */
const tilde = (target, homedir = os.homedir()) =>
  target === homedir || target.startsWith(`${homedir}${path.sep}`) ? `~${target.slice(homedir.length)}` : target;

export const parseArgs = (argv) => {
  const flags = { json: false, foreground: false, follow: false, wait: true, lines: 200, timeoutSeconds: null, from: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") flags.json = true;
    else if (arg === "--foreground" || arg === "-f") flags.foreground = true;
    else if (arg === "--follow") flags.follow = true;
    else if (arg === "--no-wait") flags.wait = false;
    else if (arg === "-n" || arg === "--lines") flags.lines = Number(argv[++i]);
    else if (arg === "--timeout") flags.timeoutSeconds = Number(argv[++i]);
    else if (arg === "--from") flags.from = argv[++i];
    else if (arg === "--refresh") flags.refresh = true;
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--version" || arg === "-v") flags.version = true;
    else if (arg.startsWith("-")) throw new Error(`unknown-flag:${arg}`);
    else positional.push(arg);
  }
  if (flags.lines !== null && (!Number.isFinite(flags.lines) || flags.lines <= 0)) throw new Error("invalid-lines");
  if (flags.timeoutSeconds !== null && (!Number.isFinite(flags.timeoutSeconds) || flags.timeoutSeconds <= 0)) {
    throw new Error("invalid-timeout");
  }
  if (flags.from !== null && (typeof flags.from !== "string" || !flags.from.trim())) throw new Error("invalid-from");
  return { command: positional[0], args: positional.slice(1), flags };
};

const locate = (projectArg) => {
  const located = locateProject(projectArg, { home: murmurHome() });
  return located;
};

const printDiagnostics = (results, { json }) => {
  if (json) {
    out(JSON.stringify({ status: worstStatus(results), checks: results }, null, 2));
    return;
  }
  out(formatReport(results));
  out("");
  const failures = results.filter((result) => result.status === FAIL);
  out(failures.length === 0 ? "All checks passed." : `${failures.length} check(s) failed.`);
};

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
const commandDoctor = async ({ args, flags }) => {
  const { projectPath, projectId, paths } = locate(args[0]);
  const results = await runDiagnostics({ projectPath, projectId, paths });
  if (!flags.json) {
    out(`Project: ${projectPath}`);
    out(`Profile: ${tilde(paths.root)}`);
    out("");
  }
  printDiagnostics(results, flags);
  return worstStatus(results) === FAIL ? 2 : 0;
};

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
/**
 * Fail closed. A start is refused not only when the project is demonstrably running,
 * but whenever ownership of the supervisor, the lock, or any recorded child cannot be
 * DISPROVEN. Only positive evidence that everything is gone lets a new supervisor in.
 */
const refuseDuplicateStart = async (paths) => {
  const state = await readRunState(paths);
  const supervisor = supervisorState(state);
  if (supervisor === "ours") return `a supervisor is already running for this project (pid ${state.supervisor.pid})`;
  if (supervisor === UNKNOWN) {
    return `the recorded supervisor (pid ${state.supervisor.pid}) could not be verified as stopped — refusing to start a second one`;
  }

  // A launch already in flight owns this project even before its supervisor has published
  // anything at all — that window is exactly what the launch guard exists to cover.
  const guard = launchGuardState(paths);
  if (guard.state === LOCK_HELD) {
    if (guard.heldBy.phase === GUARD_CLEANUP_UNVERIFIED) {
      return `a \`murmur start\` (pid ${guard.heldBy.pid}) is holding a supervisor (pid ${guard.heldBy.spawnedPid ?? "unknown"}) `
        + "whose exit it could not confirm — it is still trying, and no second supervisor may be started";
    }
    return `another \`murmur start\` is launching this project (launcher pid ${guard.heldBy.pid}, launch ${guard.heldBy.launchId})`;
  }
  if (guard.state === LOCK_UNKNOWN) {
    return `a launch guard is present and its owner could not be verified (${guard.reason}) — refusing to start a second supervisor`;
  }
  if (guard.state === LOCK_STALE) {
    const reclaimable = launchGuardReclaimable(guard.heldBy);
    if (!reclaimable.ok) return describeUnreclaimableGuard(paths, guard.heldBy, reclaimable);
  }

  const lock = lockState(paths);
  if (lock.state !== LOCK_FREE && lock.state !== LOCK_STALE) {
    return `the project lock is ${lock.state} (pid ${lock.heldBy?.pid ?? "unknown"}, ${lock.reason})`;
  }

  // Residual children from a previous run that could not be proven gone.
  const residual = unsettledOwnedChildren(state);
  if (residual.length > 0) {
    const detail = residual.map((entry) => `${entry.name}(pid ${entry.pid}, ${entry.state})`).join(", ");
    return `processes from a previous run are not proven stopped: ${detail}`;
  }
  return null;
};

const bootstrapIfNeeded = async ({ projectId, projectPath, paths }) => {
  // ENSURE/RECONCILE, not "create if project.json is missing": an existing profile is
  // still validated and its safely derivable missing pieces repaired on every start.
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.runDir);
  const owner = { pid: process.pid, startIdentity: readStartIdentity(process.pid) };
  const lockView = { lockFile: paths.bootstrapLockFile };
  const lock = acquireLock(lockView, owner);
  if (!lock.acquired) throw new Error(`bootstrap-in-progress:${lock.heldBy?.pid ?? "unknown"}`);
  try {
    return await bootstrapProfile({ projectId, projectPath, paths });
  } finally {
    // Released by the EXACT acquisition instance, never by PID alone.
    releaseLock(lockView, lock.owner);
  }
};

/**
 * Wait for the supervisor WE just launched. Matching on `supervisor.pid` means a
 * refused duplicate can never read another supervisor's `ready` and report success,
 * and a supervisor that dies before publishing a phase is detected immediately.
 */
const waitForSupervisorPhase = async (paths, { timeoutMs, pid, startIdentity = null, exit = null }) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const state = await readRunState(paths);
    const ours = state?.supervisor?.pid === pid
      && (!startIdentity || state.supervisor.startIdentity === startIdentity);
    if (ours) {
      last = state;
      // `stop-incomplete` is terminal for THIS invocation too: the supervisor rolled back
      // and could not prove every child gone, which is a failed start, not a slow one.
      if (["ready", "failed", "stopped", "stop-incomplete"].includes(state.phase)) return state;
    }
    // Liveness from the trusted spawn handle when we still hold it — an OBSERVED exit is
    // certain, where a PID probe can be fooled by reuse. `pidExists` is the fallback.
    const gone = exit ? exit.state.exited : !pidExists(pid);
    if (gone) return { ...(last ?? { phase: "failed" }), error: last?.error ?? "supervisor-exited-before-ready" };
    await sleep(250);
  }
  // The deadline expired. Whatever the last published phase was, THIS invocation timed
  // out, and the caller must treat it as a failed start that has to be cleaned up.
  return { ...(last ?? { phase: "unknown" }), timedOut: true };
};

/**
 * Outer safety net for a CLI-side readiness timeout.
 *
 * The supervisor keeps its own startup rollback; this exists because a CLI that gives
 * up must not leave the supervisor IT just created continuing to bring a project up
 * behind an `exit 4`. Only the exact process this invocation spawned is touched — PID
 * plus start identity — so a pre-existing supervisor is never affected and nothing is
 * ever matched by process name.
 */
const cleanupFailedStart = async (paths, supervisor, { graceMs = 30_000, child = null, exit = null } = {}) => {
  const report = { supervisor: "not-running", children: [], residual: [], ok: true };
  // An exit we OBSERVED through our own spawn handle is the strongest evidence of absence
  // there is; otherwise fall back to exact PID + start identity.
  const supervisorGone = () => provenGone(ownedProcessState({ ...supervisor, exitObserved: exit?.state?.exited === true }));

  if (!supervisorGone()) {
    let outcome = null;
    // Prefer the trusted spawn handle while we still hold it: it terminates exactly the
    // process this command created and waits for the real `exit`, so it cannot be confused
    // by PID reuse and cannot report an exit it did not see.
    if (hasTrustedHandle(child, exit)) {
      outcome = (await terminateSpawnedChild(child, { exit, graceMs })).outcome;
    }
    if (!stopSettled(outcome)) {
      const viaIdentity = await stopOwnedProcess(supervisor, { graceMs });
      if (stopSettled(viaIdentity) || !outcome) outcome = viaIdentity;
    }
    report.supervisor = outcome;
  }
  // Anything the supervisor recorded before dying is reaped under the same identity
  // rule, so a child that outlived a SIGKILLed supervisor cannot survive the failure.
  report.children = await reapOrphanedChildren(paths, { graceMs });

  // Residual = everything not PROVEN gone. A process whose ownership could not be
  // verified counts as residual, so cleanup never reports success it cannot prove.
  const residualState = await readRunState(paths);
  const residual = unsettledOwnedChildren(residualState).map((entry) => ({
    name: entry.name, pid: entry.pid, outcome: entry.state,
  }));
  if (!supervisorGone()) {
    residual.push({ name: "supervisor", pid: supervisor.pid, outcome: report.supervisor });
  }
  for (const child of report.children) {
    if (!child.settled) residual.push({ name: child.name, pid: child.pid, outcome: child.outcome });
  }
  const seen = new Set();
  report.residual = residual.filter((entry) => !seen.has(entry.pid) && seen.add(entry.pid));
  report.ok = report.residual.length === 0;

  // ONLY a provably complete cleanup may delete the run state and release the lock.
  // Otherwise the PID/start-identity evidence and the lock authority are retained so a
  // later `murmur stop` can retry and a later `murmur start` stays fail-closed.
  if (report.ok) await cleanupRuntimeArtifacts(paths);
  return report;
};

const startedSummary = async ({ project, paths }) => {
  const status = await collectStatus({ project, paths });
  out(`Project:  ${status.projectPath}`);
  out(`Profile:  ${tilde(status.profileRoot)}`);
  out(`NATS:     ${status.nats?.status === "PASS" ? "OK" : "UNREACHABLE"}`);
  for (const agent of status.agents) {
    const label = `${agent.name.charAt(0).toUpperCase()}${agent.name.slice(1)}:`;
    const state = !agent.alive ? "DOWN" : agent.binding ? (agent.binding.heartbeatFresh ? "READY" : "STALE") : "NO-BINDING";
    out(`${label.padEnd(10)}${agent.role === "operator" ? (agent.alive ? "READY" : "DOWN") : state}`);
  }
  const handoffAgents = status.agents.filter((agent) => agent.memberSlot);
  const handoffReady = handoffAgents.length > 0 && handoffAgents.every((agent) => agent.alive && agent.binding?.heartbeatFresh);
  out(`Handoff:  ${handoffReady ? "READY" : "DEGRADED"}`);
  return status;
};

/**
 * Has the supervisor WE spawned actually taken over the project?
 *
 * Two independent facts must name the exact process this invocation identified: the
 * published run state, and the authoritative `O_EXCL` lock. Only when both do may the
 * launcher give up its own exclusion — otherwise there would be an instant in which
 * nothing at all owns this project.
 */
const verifySupervisorAuthority = async (paths, supervisor) => {
  const state = await readRunState(paths);
  if (state?.supervisor?.pid !== supervisor.pid || state?.supervisor?.startIdentity !== supervisor.startIdentity) {
    return { ok: false, reason: "run-state-does-not-name-the-supervisor-this-command-started" };
  }
  const lock = readLock(paths);
  if (!lock) return { ok: false, reason: "supervisor-lock-missing" };
  if (Number(lock.pid) !== Number(supervisor.pid) || lock.startIdentity !== supervisor.startIdentity) {
    return { ok: false, reason: `supervisor-lock-held-by-another-owner:${lock.pid ?? "unrecorded"}` };
  }
  if (!lock.lockId) return { ok: false, reason: "supervisor-lock-carries-no-instance-token" };
  return { ok: true, reason: null };
};

/**
 * Why a launch guard whose launcher is gone still cannot be taken.
 *
 * The `manualRecovery` verdicts are the honest ones: a supervisor was created and Murmur never
 * established its identity or saw it exit, so there is no trustworthy way to find that process
 * again. Restart stays impossible until an operator resolves it — deliberately, and there is
 * no force-recovery command.
 */
const describeUnreclaimableGuard = (paths, heldBy, verdict) => {
  if (verdict.manualRecovery) {
    return `a previous \`murmur start\` spawned a supervisor (pid ${verdict.spawnedPid ?? heldBy?.spawnedPid ?? "unknown"}) `
      + `whose ownership was never established and whose exit was never observed (${verdict.reason}). `
      + "MANUAL RECOVERY REQUIRED: identify and stop that process yourself, then remove the launch guard at "
      + `${tilde(paths.launchGuardFile)}. Murmur will not reclaim it automatically, and will not start a `
      + "second supervisor that could overlap it";
  }
  return `a failed \`murmur start\` left a supervisor (pid ${verdict.supervisor?.pid ?? "unknown"}) that is not proven stopped `
    + `(${verdict.reason}) — resolve it with \`murmur stop <project>\` first`;
};

/** Human-readable refusal for a launch guard we could not take. */
const describeGuardRefusal = (paths, guard) => {
  if (guard.guardState === LOCK_HELD) {
    if (guard.heldBy?.phase === GUARD_CLEANUP_UNVERIFIED) {
      return `a \`murmur start\` (pid ${guard.heldBy.pid}) is still holding a supervisor whose exit it could not confirm`;
    }
    return `another \`murmur start\` is launching this project (launcher pid ${guard.heldBy?.pid}, launch ${guard.heldBy?.launchId})`;
  }
  if (guard.guardState === LOCK_UNKNOWN) {
    return `a launch guard is present and its owner could not be verified (${guard.reason})`;
  }
  if (guard.guardState === LOCK_STALE && guard.heldBy) {
    return describeUnreclaimableGuard(paths, guard.heldBy, launchGuardReclaimable(guard.heldBy));
  }
  return `the launch guard could not be acquired (${guard.reason})`;
};

/**
 * THE OWNERSHIP BARRIER for a detached supervisor.
 *
 * The old sequence was: spawn detached, read the start identity ONCE (possibly null),
 * `unref()` the handle, carry on. That could leave a live supervisor that no later Murmur
 * could ever prove it owned — the one state this system forbids. The barrier below replaces
 * it: the trusted spawn handle is retained until the supervisor is either
 *
 *   A. VERIFIED OWNED   — its exact start identity established, its record published, and
 *                         the authoritative lock in its name; or
 *   B. VERIFIED EXITED  — its `exit` observed through that very handle.
 *
 * Nothing in between returns from this function with the process still running.
 *
 * Exported so the barrier itself can be tested against a start-identity probe that fails
 * permanently — the condition that used to produce an unidentifiable detached supervisor.
 * `probe` is the ONLY injected dependency; the spawn, the guard and the cleanup are real.
 */
export const startDetachedSupervisor = async ({
  project, projectId, paths, guard, flags,
  probe = probeStartIdentity,
  spawnSupervisor = spawn,
  graceMs = null,
  holdPollMs = CLEANUP_HOLD_POLL_MS,
}) => {
  // Everything that can fail WITHOUT creating a process happens first, while the guard is
  // still an ordinary reclaimable `launching` record: opening the log is one of those.
  const logFd = openSync(paths.logFile("supervisor"), "a", 0o600);

  // THE PRE-SPAWN BOUNDARY. `spawn()` is irreversible and cannot be made atomic with a disk
  // write, so the conservative durable state goes first: from here on, a launcher that is
  // killed at ANY point leaves a guard that refuses automatic reclamation, because whether a
  // process exists is genuinely unknowable to a later reader.
  const intent = noteLaunchGuardSpawnIntent(paths, guard.guard);
  if (!intent.updated) {
    closeSync(logFd);
    // No process has been created, and none will be: without the durable boundary we must not
    // spawn at all.
    err(`murmur: refusing to spawn a supervisor — the launch guard could not record the attempt (${intent.reason}).`);
    err("Nothing was started.");
    return 4;
  }

  let child;
  try {
    child = spawnSupervisor(process.execPath, [SUPERVISOR_ENTRY, "--project-id", projectId], {
      cwd: MURMUR_ROOT,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } catch (error) {
    // A synchronous throw from spawn means no process was ever created. That is POSITIVE
    // proof, so the conservative boundary above may be lifted and the exclusion released —
    // an ordinary spawn failure must never become a permanent lock.
    return releaseAfterProvenNoProcess({ paths, guard, error: error?.message || String(error) });
  } finally {
    // The child already owns its duplicated descriptors.
    closeSync(logFd);
  }

  // Node's contract: no pid means the process could not be spawned (an `error` event follows).
  // Again positive proof of "nothing was created" — never inferred from a missing PID record.
  if (child.pid === undefined || child.pid === null) {
    return releaseAfterProvenNoProcess({ paths, guard, error: "spawn-produced-no-pid" });
  }

  // Latch the exit BEFORE anything can await: this handle is the only evidence that
  // outranks a failed `ps`, and it is deliberately NOT unref'd here.
  const exit = observeChildExit(child);
  const effectiveGraceMs = graceMs ?? Math.min(30_000, Math.max(5_000, (flags.timeoutSeconds ?? 120) * 1000));
  const hold = { paths, guard, child, exit, graceMs: effectiveGraceMs, holdPollMs };

  // A process now provably exists: record its PID. The spawn-intent boundary already covered
  // the instant between the spawn and this write.
  const spawned = noteLaunchGuardSpawn(paths, guard.guard, { pid: child.pid });
  if (!spawned.updated) {
    err(`murmur: could not record the spawned supervisor in the launch guard (${spawned.reason}).`);
    return abandonUnverifiedLaunch({ ...hold, reason: `launch-guard-${spawned.reason}` });
  }

  try {
    return await superviseLaunch({
      project, projectId, paths, guard, flags, child, exit, graceMs: effectiveGraceMs, probe, holdPollMs,
    });
  } catch (error) {
    // No unexpected failure may end this command with a live, unidentified supervisor behind
    // it. We still hold the handle, so the same barrier applies.
    err(`murmur: unexpected failure while bringing the supervisor up (${error?.message || error}).`);
    return abandonUnverifiedLaunch({ ...hold, reason: `launch-error:${error?.message || error}` });
  }
};

const superviseLaunch = async ({
  project, paths, guard, flags, child, exit, graceMs, probe = probeStartIdentity, holdPollMs = CLEANUP_HOLD_POLL_MS,
}) => {
  const supervisorPid = child.pid;
  const timeoutMs = (flags.timeoutSeconds ?? 120) * 1000;

  // Same bounded ownership-establishment contract every other child goes through.
  const owned = await establishOwnership(supervisorPid, { child, probe });
  if (owned.ownership !== "established") {
    return abandonUnverifiedLaunch({
      paths, guard, child, exit, graceMs, holdPollMs,
      reason: `supervisor-ownership-${owned.ownership}`,
    });
  }
  const supervisorRecord = { pid: supervisorPid, startIdentity: owned.startIdentity };

  // Durable, trustworthy ownership record, written while the handle still backs it. If this
  // launcher is killed in the next instant, the next `murmur start` measures THIS record and
  // stays refused for as long as the supervisor cannot be proven gone.
  const noted = noteLaunchGuardSupervisor(paths, guard.guard, supervisorRecord);
  if (!noted.updated) {
    // Our exclusion is gone, so we can no longer guarantee we are the only launcher. The
    // supervisor we just created must not be left behind.
    return abandonUnverifiedLaunch({
      paths, guard, child, exit, graceMs, holdPollMs, reason: `launch-guard-${noted.reason}`,
    });
  }

  let state = await waitForSupervisorPhase(paths, {
    timeoutMs, pid: supervisorPid, startIdentity: supervisorRecord.startIdentity, exit,
  });

  if (state?.phase !== "ready") {
    // Readiness can land in the same instant the local deadline expires. Re-read once
    // before tearing anything down, so a genuinely started project is reported
    // truthfully instead of being killed by a lost race.
    const settled = await readRunState(paths);
    if (settled?.supervisor?.pid === supervisorPid && settled.phase === "ready") state = settled;
  }

  // A supervisor that is DEGRADED is holding the project deliberately: it could not prove
  // one of its own children gone and is keeping the lock, the run state and its trusted
  // handles rather than abandoning them. Killing it here would destroy exactly that
  // evidence, so the start reports the failure and leaves authority where it is.
  if (state?.phase === "stop-incomplete" && state?.degraded === true) {
    const authority = await verifySupervisorAuthority(paths, supervisorRecord);
    err(`murmur: supervisor start failed and it is holding the project in a degraded state (${state.error || "stop-incomplete"}).`);
    for (const residual of state.residual || []) err(`  residual ${residual.name} pid=${residual.pid ?? "-"} (${residual.outcome ?? residual.reason ?? "unknown"})`);
    err(`Logs: ${tilde(paths.logsDir)}`);
    err("The supervisor is retaining the project lock and the trusted handles for those processes.");
    err("Run `murmur status <project>` / `murmur stop <project>`; a new start stays refused until it is resolved.");
    if (authority.ok) {
      // Authority has transferred to a process we verified: the launcher's exclusion is no
      // longer what protects this project, so it may be released.
      releaseLaunchGuard(paths, guard.guard);
      child.unref();
      return 3;
    }
    return holdLaunchGuard(paths, 3, "the supervisor is degraded and did not take authoritative ownership", child);
  }

  if (state?.phase !== "ready") {
    const reason = state?.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s, last phase: ${state.phase ?? "unknown"}`
      : `phase: ${state?.phase ?? "unknown"}${state?.error ? `, ${state.error}` : ""}`;
    err(`murmur: supervisor did not reach ready (${reason}). Cleaning up...`);
    const cleanup = await cleanupFailedStart(paths, supervisorRecord, { graceMs, child, exit });
    err(`Logs: ${tilde(paths.logsDir)}`);
    if (!cleanup.ok) {
      err("murmur: CLEANUP INCOMPLETE — these processes from the failed start are still running:");
      for (const residual of cleanup.residual) err(`  ${residual.name} pid=${residual.pid}`);
      err("Run `murmur stop <project>` and check them before starting again.");
      return holdLaunchGuard(paths, 3, "cleanup after the failed start is not proven complete", child);
    }
    err(`Cleaned up the supervisor this command started (${cleanup.supervisor}` +
      `${cleanup.children.length > 0 ? `, ${cleanup.children.length} child process(es)` : ""}). Nothing from this start is running.`);
    // Proven clean: no process from this launch survives, so the exclusion may go.
    releaseLaunchGuard(paths, guard.guard);
    return 4;
  }

  // Ready. Authority must be provably in the hands of the exact supervisor we verified
  // before this launcher steps aside.
  const authority = await verifySupervisorAuthority(paths, supervisorRecord);
  if (!authority.ok) {
    err(`murmur: the supervisor reported ready without taking authoritative ownership (${authority.reason}). Cleaning up...`);
    const cleanup = await cleanupFailedStart(paths, supervisorRecord, { graceMs, child, exit });
    if (!cleanup.ok) {
      err("murmur: CLEANUP INCOMPLETE — these processes from the failed start are still running:");
      for (const residual of cleanup.residual) err(`  ${residual.name} pid=${residual.pid}`);
      return holdLaunchGuard(paths, 3, "cleanup after the failed authority hand-off is not proven complete", child);
    }
    releaseLaunchGuard(paths, guard.guard);
    return 4;
  }

  // ORDERED HAND-OFF: verified supervisor owns lock + run state -> launcher's exclusion is
  // released -> only then is the spawn handle released. There is no instant in between in
  // which a second `murmur start` could see an unowned project.
  const released = releaseLaunchGuard(paths, guard.guard);
  if (!released.released) err(`murmur: warning — the launch guard was not released (${released.reason}).`);
  child.unref();

  const status = await startedSummary({ project, paths });
  out("");
  out(status.healthy ? "Murmur started." : `Murmur started with warnings: ${status.problems.join("; ")}`);
  return status.healthy ? 0 : 3;
};

/**
 * Deliberately KEEP the launch guard, and end the command truthfully.
 *
 * Reached only when this command could not prove that what it created is gone: everything
 * that could be done in-process has been done (TERM and KILL through the trusted handle,
 * waiting for a real exit each time). The guard stays on disk so the project is fail-closed
 * against another start, and the operator is told exactly why.
 *
 * The handle is released here only because this process is terminating either way — the
 * durable guard (plus the run-state evidence) is what carries the fail-closed state forward.
 * `process.exit()` is deliberately NOT used: it can truncate the report above.
 */
const holdLaunchGuard = (paths, code, why, child = null) => {
  err("");
  err(`murmur: the launch guard at ${tilde(paths.launchGuardFile)} is RETAINED because ${why}.`);
  err("No new `murmur start` is allowed for this project until it is resolved.");
  child?.unref();
  return code;
};

/**
 * The spawn provably created NO process (a synchronous throw, or Node reporting no pid).
 *
 * This is the only evidence that lifts the pre-spawn boundary: it is recorded durably first,
 * and only then is the exclusion released — so an ordinary spawn failure leaves no lock, while
 * a crash between the two still leaves a guard whose terminal state is safe to reclaim.
 */
const releaseAfterProvenNoProcess = ({ paths, guard, error }) => {
  noteLaunchGuardSpawnFailed(paths, guard.guard, { error });
  const released = releaseLaunchGuard(paths, guard.guard);
  err(`murmur: the supervisor could not be spawned (${error}). No process was created.`);
  if (!released.released) err(`murmur: warning — the launch guard was not released (${released.reason}).`);
  err(`Logs: ${tilde(paths.logsDir)}`);
  return 4;
};

/**
 * CLEANUP HOLD — for the one case where neither ownership nor an exit can be proven.
 *
 * We spawned a supervisor, never established its identity, signalled it through the trusted
 * handle and never saw it exit. There is no durable way to find that process again, so the
 * command does NOT unref the handle and does NOT return: it keeps the only trusted handle on
 * that process alive and keeps retrying, on a bounded period, until the exit is actually
 * observed. Staying alive is the honest outcome; returning the shell here would mean claiming
 * a cleanup that did not happen.
 *
 * The durable guard is marked non-reclaimable FIRST, so even an external SIGKILL of this
 * command leaves the project locked rather than automatically restartable.
 */
const holdUnverifiedCleanup = async ({ paths, guard, child, exit, graceMs, holdPollMs, outcome, signalled }) => {
  const pid = child?.pid ?? null;
  const marked = noteLaunchGuardCleanupUnverified(paths, guard.guard, { pid, outcome, signalled });

  err("");
  err("murmur: CLEANUP INCOMPLETE");
  err(`Supervisor exit could not be confirmed (pid ${pid ?? "-"}, ${outcome}; signals sent: ${signalled.join(", ") || "none"}).`);
  err("Project launch remains locked. Do not start another Murmur instance.");
  err(marked.updated
    ? `Launch guard ${tilde(paths.launchGuardFile)} is recorded \`cleanup-unverified\` and will NOT be reclaimed automatically.`
    : `WARNING: the launch guard could not be updated (${marked.reason}) — check ${tilde(paths.launchGuardFile)} by hand.`);
  err(`Logs: ${tilde(paths.logsDir)}`);
  err("");
  err(`This command is deliberately staying alive: it still holds the only trusted handle on that`);
  err(`process, and re-attempts termination every ${Math.max(1, Math.round(holdPollMs / 1000))}s until the exit is observed.`);
  err("Interrupting it loses that handle and leaves the project in manual recovery.");

  for (;;) {
    if (exit.state.exited) break;
    await sleep(holdPollMs);
    if (exit.state.exited) break;
    const retry = await terminateSpawnedChild(child, { exit, graceMs });
    if (retry.settled) break;
  }

  // OBSERVED EXIT. Only now does this launch's ownership responsibility end.
  noteLaunchGuardSupervisorExited(paths, guard.guard, { pid, outcome: "exit-observed-in-cleanup-hold" });
  err("");
  err(`murmur: the supervisor's exit has now been observed (pid ${pid ?? "-"}). Completing cleanup...`);
  return finishAbandonedLaunch({ paths, guard, child, graceMs, outcome: "exit-observed-in-cleanup-hold" });
};

/**
 * Shared tail for a launch whose supervisor is PROVEN gone: reap whatever it recorded, clear
 * the launch artifacts, and release this launch's exact exclusion.
 */
const finishAbandonedLaunch = async ({ paths, guard, child, graceMs, outcome }) => {
  const children = await reapOrphanedChildren(paths, { graceMs });
  const unsettled = children.filter((entry) => !entry.settled);
  if (unsettled.length > 0) {
    err("murmur: CLEANUP INCOMPLETE — processes recorded by the failed launch are not proven stopped:");
    for (const entry of unsettled) err(`  ${entry.name} pid=${entry.pid} (${entry.outcome})`);
    return holdLaunchGuard(paths, 3, "a process recorded by the failed launch is not proven stopped", child);
  }
  await cleanupRuntimeArtifacts(paths);
  const released = releaseLaunchGuard(paths, guard.guard);
  err(`murmur: the supervisor this command spawned was ${outcome}; nothing from this start is running.`);
  if (!released.released) err(`murmur: warning — the launch guard was not released (${released.reason}).`);
  err(`Logs: ${tilde(paths.logsDir)}`);
  child?.unref();
  return 4;
};

/**
 * The ownership barrier failed: we spawned a supervisor and could not establish its
 * identity (or lost our exclusion). We still hold the trusted spawn handle, so terminate
 * THROUGH it and wait for the real exit. A naked unverified PID is never signalled.
 */
const abandonUnverifiedLaunch = async ({ paths, guard, child, exit, reason, graceMs, holdPollMs = CLEANUP_HOLD_POLL_MS }) => {
  err(`murmur: the supervisor this command spawned cannot be safely handed the project (${reason}).`);
  err("Terminating it through the trusted spawn handle...");
  const result = await terminateSpawnedChild(child, { exit, graceMs });
  if (!result.settled) {
    // NOT settled: the handle must not be discarded and this command must not return.
    return holdUnverifiedCleanup({
      paths, guard, child, exit, graceMs, holdPollMs, outcome: result.outcome, signalled: result.signalled,
    });
  }

  // Its exit is observed — recorded durably before the exclusion is given up, so a crash in
  // between still leaves a guard a later start can safely reclaim.
  noteLaunchGuardSupervisorExited(paths, guard.guard, { pid: child?.pid ?? null, outcome: result.outcome });
  return finishAbandonedLaunch({ paths, guard, child, graceMs, outcome: result.outcome });
};

/**
 * Foreground: this CLI stays the supervisor's parent for its whole life, so the trusted
 * handle is never dropped while the process may be alive, and the launch guard is held for
 * exactly the same span — released only once the child's exit has been OBSERVED.
 */
const startForegroundSupervisor = async ({ projectId, paths, guard }) => {
  // The same pre-spawn durable boundary as the detached path: no OS process may be created
  // before the guard says one might exist.
  const intent = noteLaunchGuardSpawnIntent(paths, guard.guard);
  if (!intent.updated) {
    err(`murmur: refusing to spawn a supervisor — the launch guard could not record the attempt (${intent.reason}).`);
    return 4;
  }
  let child;
  try {
    child = spawn(process.execPath, [SUPERVISOR_ENTRY, "--project-id", projectId], {
      cwd: MURMUR_ROOT,
      env: process.env,
      stdio: "inherit",
    });
  } catch (error) {
    return releaseAfterProvenNoProcess({ paths, guard, error: error?.message || String(error) });
  }
  if (child.pid === undefined || child.pid === null) {
    return releaseAfterProvenNoProcess({ paths, guard, error: "spawn-produced-no-pid" });
  }
  const spawnNoted = noteLaunchGuardSpawn(paths, guard.guard, { pid: child.pid });
  const exit = observeChildExit(child);
  if (!spawnNoted.updated) {
    err(`murmur: could not record the spawned supervisor in the launch guard (${spawnNoted.reason}).`);
    return abandonUnverifiedLaunch({
      paths, guard, child, exit, graceMs: 30_000, reason: `launch-guard-${spawnNoted.reason}`,
    });
  }
  // The same ownership barrier as the detached path: a supervisor we cannot identify is
  // terminated through this handle rather than left running.
  const owned = await establishOwnership(child.pid, { child });
  if (owned.ownership !== "established") {
    return abandonUnverifiedLaunch({
      paths, guard, child, exit, graceMs: 30_000, reason: `supervisor-ownership-${owned.ownership}`,
    });
  }
  noteLaunchGuardSupervisor(paths, guard.guard, { pid: child.pid, startIdentity: owned.startIdentity });

  const settled = await exit.promise;
  // VERIFIED EXITED through our own handle. Recorded durably before the release, so a crash in
  // between leaves a guard whose terminal state is safe rather than an unresolved one.
  noteLaunchGuardSupervisorExited(paths, guard.guard, { pid: child.pid, outcome: `exit:${settled.signal || settled.code}` });
  const released = releaseLaunchGuard(paths, guard.guard);
  if (!released.released) err(`murmur: warning — the launch guard was not released (${released.reason}).`);
  return settled.code === 0 ? 0 : 4;
};

const commandStart = async ({ args, flags }) => {
  const { projectPath, projectId, paths } = locate(args[0]);

  const duplicate = await refuseDuplicateStart(paths);
  if (duplicate) {
    err(`murmur: refusing to start — ${duplicate}`);
    err("Run `murmur status <project>` or `murmur stop <project>` first.");
    return 3;
  }

  const bootstrap = await bootstrapIfNeeded({ projectId, projectPath, paths });
  if (bootstrap.created) {
    out(`Created a new Murmur profile for this project: ${tilde(paths.root)}`);
    out(`Identities: ${bootstrap.createdAgents.join(", ")} (private keys never leave ${tilde(paths.agentsDir)})`);
    out("");
  } else if (bootstrap.repaired) {
    out(`Repaired missing profile pieces: ${bootstrap.repairs.join(", ")}`);
    out("(existing identities were reused; no key was rotated)");
    out("");
  }

  const results = await runDiagnostics({ projectPath, projectId, paths });
  if (hasFatal(results)) {
    err("murmur: preflight failed — nothing was started.");
    err("");
    err(formatReport(results.filter((result) => result.status !== "PASS")));
    return 2;
  }

  const project = await loadProfile(paths);
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });

  // DURABLE CROSS-PROCESS EXCLUSION BEFORE ANY PROCESS EXISTS. The supervisor's own lock
  // cannot cover the interval before that supervisor runs, so the launcher takes this guard
  // first; a concurrent `murmur start` fails closed here instead of spawning a second
  // supervisor and losing the lock race afterwards.
  const launcher = { pid: process.pid, startIdentity: readStartIdentity(process.pid), command: "start" };
  if (!launcher.startIdentity) {
    // Without our own identity we could never release our own guard, and could never be
    // proven gone by anyone else. Refuse before creating anything.
    err("murmur: could not establish this command's own process identity — refusing to spawn a supervisor it could not prove it owns.");
    return 4;
  }
  const guard = acquireLaunchGuard(paths, launcher);
  if (!guard.acquired) {
    err(`murmur: refusing to start — ${describeGuardRefusal(paths, guard)}`);
    err("Run `murmur status <project>` or `murmur stop <project>` first.");
    return 3;
  }

  if (flags.foreground) return startForegroundSupervisor({ projectId, paths, guard });
  return startDetachedSupervisor({ project, projectId, paths, guard, flags });
};

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

/**
 * Enumerate the profiles this user already has, newest-looking first by name.
 *
 * This exists so a GUI does not have to read `project.json` itself. That file carries a
 * NATS token when one is configured, and nothing outside Murmur should have to know which
 * fields are safe to read — `publicProfileSummary` is the redacted view, and it is the
 * only thing that leaves here.
 *
 * A profile that is unreadable or invalid is REPORTED, not skipped: a project that has
 * silently vanished from a picker is worse than one shown as broken.
 */
export const listProfiles = async ({ home = murmurHome() } = {}) => {
  const root = path.join(home, "projects");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const paths = projectPathsFor(entry.name, { home });
    try {
      const project = await loadProfile(paths);
      profiles.push({
        projectId: project.projectId,
        // What the operator calls this project — never the hashed profile directory.
        name: path.basename(project.projectPath),
        projectPath: project.projectPath,
        profileRoot: paths.root,
        logsDir: paths.logsDir,
        valid: true,
        profile: publicProfileSummary(project),
      });
    } catch (error) {
      profiles.push({
        projectId: entry.name,
        name: entry.name,
        projectPath: null,
        profileRoot: paths.root,
        logsDir: paths.logsDir,
        valid: false,
        reason: error?.message || "unreadable",
      });
    }
  }
  return profiles;
};

const commandProjects = async ({ flags }) => {
  const profiles = await listProfiles();
  if (flags.json) {
    out(JSON.stringify({ projects: profiles }, null, 2));
    return 0;
  }
  if (profiles.length === 0) {
    out("No Murmur projects yet. Run `murmur start <project>` to create one.");
    return 0;
  }
  for (const profile of profiles) {
    out(profile.valid
      ? `${profile.name.padEnd(24)} ${profile.projectPath}`
      : `${profile.name.padEnd(24)} (invalid profile: ${profile.reason})`);
  }
  return 0;
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
const commandStatus = async ({ args, flags }) => {
  const { projectPath, projectId, paths } = locate(args[0]);
  if (!(await profileExists(paths))) {
    if (flags.json) out(JSON.stringify({ projectPath, projectId, profile: null, healthy: false }, null, 2));
    else {
      out(`Project:  ${projectPath}`);
      out(`Profile:  none (run \`murmur start\`)`);
    }
    return 3;
  }
  const project = await loadProfile(paths);
  const status = await collectStatus({ project, paths });

  if (flags.json) {
    out(JSON.stringify({ ...status, profile: publicProfileSummary(project) }, null, 2));
    return status.healthy ? 0 : 3;
  }

  out(`Project:     ${status.projectPath}`);
  out(`Profile:     ${tilde(status.profileRoot)}`);
  out(`Supervisor:  ${status.supervisor.alive ? `running (pid ${status.supervisor.pid})` : "not running"}  phase=${status.supervisor.phase}`);
  if (status.launchGuard) {
    out(`Launch:      ${status.launchGuard.state}/${status.launchGuard.phase ?? "unknown"}`
      + `${status.launchGuard.spawnedPid ? ` (supervisor pid ${status.launchGuard.spawnedPid})` : ""}`
      + `${status.launchGuard.manualRecovery ? "  MANUAL RECOVERY REQUIRED" : ""}`);
  }
  out(`NATS:        ${status.nats?.status === "PASS" ? "OK" : `UNREACHABLE (${status.nats?.detail ?? "unknown"})`}`);
  if (status.appServer) {
    // The real App Server exposes the configured path as a symlink to its own socket, so say
    // which shape is in use rather than implying the file itself is the endpoint.
    const socketState = status.appServer.socket.ok
      ? `listening${status.appServer.socket.alias ? " (alias)" : ""}`
      : status.appServer.socket.reason;
    out(`Codex App Server: ${status.appServer.alive ? `pid ${status.appServer.pid}` : "not running"}  socket=${socketState}`);
  }
  out("");
  out("  agent    pid      child        binding        heartbeat   member-slot");
  for (const agent of status.agents) {
    const heartbeat = agent.binding?.heartbeatAgeMs === null || agent.binding?.heartbeatAgeMs === undefined
      ? "-"
      : `${Math.round(agent.binding.heartbeatAgeMs / 1000)}s${agent.binding.heartbeatFresh ? "" : "!"}`;
    out(
      `  ${agent.name.padEnd(8)} ${String(agent.pid ?? "-").padEnd(8)} ${String(agent.alive ? "alive" : agent.childState).padEnd(12)} ` +
      `${String(agent.binding?.state ?? "-").padEnd(14)} ${heartbeat.padEnd(11)} ${agent.memberSlot ?? "-"}`,
    );
  }
  out("");
  out(`Open continuations: ${status.totals.openContinuations}`);
  out(`Dispatches:         active=${status.totals.activeDispatch} pending=${status.totals.pendingDispatch}`);
  if (!status.healthy) {
    out("");
    out(`UNHEALTHY: ${status.problems.join("; ")}`);
  }
  return status.healthy ? 0 : 3;
};

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------
/**
 * Reclaim the launch guard if — and only if — the durable state proves no possibly-live
 * supervisor was left behind. Otherwise report exactly why the project stays locked.
 *
 * `blocked` means a later `murmur start` will still be refused, so `stop` must not exit 0.
 */
const settleLaunchGuardOnStop = (paths) => {
  const guard = reclaimStaleLaunchGuard(paths);
  if (guard.reclaimed) {
    out("  cleared a launch guard left behind by a failed start");
    return { blocked: false };
  }
  if (!guard.reason || guard.reason === "not-present") return { blocked: false };

  const heldBy = readLaunchGuard(paths);
  const verdict = launchGuardReclaimable(heldBy);
  err("");
  if (verdict.manualRecovery) {
    err("murmur: MANUAL RECOVERY REQUIRED — an unresolved launch is keeping this project locked.");
    err(`  a \`murmur start\` spawned a supervisor (pid ${verdict.spawnedPid ?? heldBy?.spawnedPid ?? "unknown"}) whose ownership`);
    err("  was never established and whose exit was never observed, so there is no trustworthy way");
    err("  for Murmur to find that process again.");
    err(`  Identify and stop it yourself, then remove ${tilde(paths.launchGuardFile)}.`);
    err("  Murmur will not reclaim this guard automatically and will not start a second supervisor.");
  } else {
    err(`murmur: the launch guard is retained (${guard.reason}); a new start stays refused.`);
  }
  return { blocked: true };
};


const commandStop = async ({ args, flags }) => {
  const { projectPath, paths } = locate(args[0]);
  const graceMs = (flags.timeoutSeconds ?? 30) * 1000;
  const state = await readRunState(paths);

  if (!state) {
    await cleanupRuntimeArtifacts(paths);
    out(`Project:  ${projectPath}`);
    out("Nothing to stop (no supervisor run state).");
    // "No run state" is NOT the same as "nothing is locked": an unresolved launch keeps this
    // project fail-closed with no run state at all, and stop must say so rather than imply the
    // project is startable.
    const guard = settleLaunchGuardOnStop(paths);
    return guard.blocked ? 3 : 0;
  }

  // A DEGRADED supervisor is the one process this command must NOT escalate against. It is
  // alive on purpose, holding the trusted spawn handles for children it could not prove gone,
  // and SIGKILLing it would destroy the last evidence that can still force or observe their
  // exit — turning a recoverable state into an unrecoverable one.
  if (state.degraded === true && ownedProcessState(state.supervisor || {}) === "ours") {
    out(`Project:  ${projectPath}`);
    out(`Profile:  ${tilde(paths.root)}  (identities, databases and history are preserved)`);
    err("");
    err(`murmur: the supervisor (pid ${state.supervisor.pid}) is in a DEGRADED hold and was left alone.`);
    for (const entry of state.residual || []) {
      err(`  residual ${entry.name} pid=${entry.pid ?? "-"} (${entry.outcome ?? entry.reason ?? "not proven stopped"})`);
    }
    err("It is retaining the project lock and the trusted spawn handles for those processes, and");
    err("keeps retrying their termination. Killing it would destroy the only evidence that can");
    err("still prove they are gone, so this command will not do that.");
    err(`Watch \`murmur logs ${args[0]}\`; re-run \`murmur stop\` once it reports the hold resolved.`);
    return 3;
  }

  const stopped = [];
  if (state.supervisor && !provenGone(ownedProcessState(state.supervisor))) {
    const outcome = await stopOwnedProcess(state.supervisor, { graceMs });
    stopped.push({ name: "supervisor", pid: state.supervisor.pid, outcome, settled: stopSettled(outcome) });
  }

  // Only PIDs this project's supervisor recorded, only when the start identity still
  // matches. Nothing is matched by process name; unrelated NATS/Claude/Cursor/Codex
  // processes are never touched.
  const orphans = await reapOrphanedChildren(paths, { graceMs });
  stopped.push(...orphans.map((entry) => ({ ...entry, orphaned: true })));

  // Authoritative verdict: a stop is CLEAN only when every owned process is proven
  // gone by observing the OS, not by our own bookkeeping.
  const after = await readRunState(paths);
  const residual = unsettledOwnedChildren(after).map((entry) => ({ name: entry.name, pid: entry.pid, outcome: entry.state }));
  if (after?.supervisor && !provenGone(ownedProcessState(after.supervisor))) {
    residual.unshift({ name: "supervisor", pid: after.supervisor.pid, outcome: ownedProcessState(after.supervisor) });
  }

  out(`Project:  ${projectPath}`);
  out(`Profile:  ${tilde(paths.root)}  (identities, databases and history are preserved)`);
  if (stopped.length === 0 && residual.length === 0) out("Nothing was running.");
  else for (const entry of stopped) out(`  stopped ${entry.name.padEnd(18)} pid=${entry.pid ?? "-"} ${entry.outcome}${entry.orphaned ? " (orphan)" : ""}`);

  if (residual.length > 0) {
    // STOP INCOMPLETE. Keep the run state, the PID/start-identity records and the lock
    // authority: they are exactly what a retry needs, and what keeps a new `murmur
    // start` from overlapping a process that may still be alive.
    await writeRunState(paths, { ...after, phase: "stop-incomplete", residual, stoppedAt: null });
    err("");
    err("murmur: STOP INCOMPLETE — these owned processes could not be proven stopped:");
    for (const entry of residual) err(`  ${entry.name} pid=${entry.pid} (${entry.outcome})`);
    err(`Ownership evidence is preserved in ${tilde(paths.supervisorFile)}.`);
    err("Re-run `murmur stop <project>` to retry; `murmur start` stays refused until this is resolved.");
    return 3;
  }

  // Everything is proven gone: only now may the socket, run state and lock be removed.
  await cleanupRuntimeArtifacts(paths);
  // A launch guard left behind by a failed launch may go too — but only as a RECLAMATION:
  // its launcher must be proven gone and so must the supervisor that launch recorded.
  const guard = settleLaunchGuardOnStop(paths);
  out("");
  out("Murmur stopped.");
  return guard.blocked ? 3 : 0;
};

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------
const tailFile = async (file, lines) => {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  const window = Math.min(size, Math.max(4096, lines * 512));
  const stream = createReadStream(file, { start: Math.max(0, size - window), encoding: "utf8" });
  let buffer = "";
  for await (const chunk of stream) buffer += chunk;
  return buffer.split("\n").slice(-lines).join("\n");
};

const commandLogs = async ({ args, flags }) => {
  const { paths } = locate(args[0]);
  const known = ["supervisor", "root", "claude", "codex", "cursor", CODEX_APP_SERVER_CHILD];
  const name = args[1] || "supervisor";
  if (!known.includes(name)) {
    err(`murmur: unknown log '${name}'. Known: ${known.join(", ")}`);
    return 1;
  }
  const file = paths.logFile(name);
  if (!existsSync(file)) {
    err(`murmur: no log yet at ${tilde(file)}`);
    return 3;
  }
  out(await tailFile(file, flags.lines));
  if (!flags.follow) return 0;

  let offset = statSync(file).size;
  for (;;) {
    await sleep(500);
    if (!existsSync(file)) continue;
    const size = statSync(file).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) continue;
    const stream = createReadStream(file, { start: offset, end: size - 1, encoding: "utf8" });
    for await (const chunk of stream) process.stdout.write(chunk);
    offset = size;
  }
};

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------
/**
 * Is the root -> coordinator path actually usable right now?
 *
 * Requires the supervisor, the root daemon and the coordinator daemon to be alive, and
 * the coordinator to hold a fresh autonomous binding on its exact member slot. A
 * coordinator that is mid-turn is reported as BUSY rather than dead, because that is a
 * different operator problem with a different answer.
 */
const USABLE_BINDING_STATES = new Set(["BOUND_IDLE"]);
const BUSY_BINDING_STATES = new Set(["CLAIMED", "WAKING", "RUNNING"]);

export const coordinatorGate = (status, { root = "root", coordinator = "claude" } = {}) => {
  if (!status.supervisor.alive) {
    return { ok: false, reason: "the project supervisor is not running", fix: "Run `murmur start <project>` first." };
  }
  const rootAgent = status.agents.find((agent) => agent.name === root);
  if (!rootAgent?.alive) {
    return { ok: false, reason: "the root/operator daemon is not running (it is what flushes the outbox)", fix: "Run `murmur start <project>` first." };
  }
  const agent = status.agents.find((entry) => entry.name === coordinator);
  if (!agent) return { ok: false, reason: `the coordinator '${coordinator}' is not part of this profile` };
  if (!agent.alive) {
    return { ok: false, reason: `the ${coordinator} coordinator daemon is not running`, fix: "Run `murmur start <project>` first." };
  }
  if (!agent.binding) {
    return { ok: false, reason: `the ${coordinator} coordinator has no autonomous runtime binding`, fix: `Check \`murmur logs <project> ${coordinator}\`.` };
  }
  if (agent.binding.memberSlot !== agent.memberSlot) {
    return { ok: false, reason: `the ${coordinator} binding is on member slot ${agent.binding.memberSlot}, expected ${agent.memberSlot}` };
  }
  if (!agent.binding.heartbeatFresh) {
    return { ok: false, reason: `the ${coordinator} runtime binding heartbeat is stale (state ${agent.binding.state})`, fix: "Restart the project: `murmur stop <project> && murmur start <project>`." };
  }
  if (BUSY_BINDING_STATES.has(agent.binding.state)) {
    return { ok: false, reason: `the ${coordinator} coordinator is busy with another task (binding state ${agent.binding.state})`, fix: "Wait for the current task to finish, then send again." };
  }
  if (!USABLE_BINDING_STATES.has(agent.binding.state)) {
    return { ok: false, reason: `the ${coordinator} runtime binding is ${agent.binding.state}, not assignable`, fix: "Restart the project: `murmur stop <project> && murmur start <project>`." };
  }
  return { ok: true, reason: null };
};

/**
 * `send` in ONE machine-readable object.
 *
 * A GUI would otherwise have to scrape the human transcript — "Sent <id> -> ...", a blank
 * line, then the reply — and would silently misread the day someone improves the wording.
 * This changes nothing about correlation: the same enqueue and the same strict wait
 * produce it, and `--json` only decides how the outcome is printed.
 */
const sendResult = (payload) => {
  out(JSON.stringify(payload, null, 2));
};

const commandSend = async ({ args, flags }) => {
  const { paths } = locate(args[0]);
  const text = args.slice(1).join(" ").trim();
  const fail = (reason, detail = null) => {
    if (flags.json) sendResult({ ok: false, reason, ...(detail ? { detail } : {}) });
    return null;
  };
  if (!text) {
    if (!flags.json) err("murmur: send requires a task, e.g. murmur send <project> \"summarise README.md\"");
    fail("task-required");
    return 1;
  }
  if (!(await profileExists(paths))) {
    if (!flags.json) err("murmur: no profile for this project. Run `murmur start <project>` first.");
    fail("no-profile");
    return 3;
  }
  const project = await loadProfile(paths);
  const root = agentByName(project, "root");
  const coordinator = agentByName(project, project.coordinator || "claude");
  if (!root || !coordinator) {
    if (!flags.json) err("murmur: profile has no root/coordinator pair.");
    fail("no-root-coordinator-pair");
    return 3;
  }
  if (!enabledAgents(project).some((agent) => agent.name === root.name)) {
    if (!flags.json) err("murmur: the root/operator identity is disabled in this profile.");
    fail("root-disabled");
    return 3;
  }

  // FAIL CLOSED before anything is enqueued: a root task must never be written into the
  // outbox when the coordinator path is already known to be unusable. The judgement
  // comes from the same `collectStatus` the `status` command renders, not a second,
  // divergent health check.
  const status = await collectStatus({ project, paths, includeNats: false });
  const gate = coordinatorGate(status, { root: root.name, coordinator: coordinator.name });
  if (!gate.ok) {
    if (!flags.json) {
      err(`murmur: refusing to send — ${gate.reason}`);
      if (gate.fix) err(gate.fix);
    }
    fail("coordinator-unavailable", gate.reason);
    return 3;
  }

  // Passive, NON-BLOCKING warning from the last cached usage snapshot (never a fresh provider
  // call, never an interactive prompt): the task is sent regardless.
  for (const line of await lowLimitWarnings()) err(`murmur: ${line}`);

  const sent = await enqueueRootTask({
    murmurRoot: MURMUR_ROOT,
    rootDataDir: paths.agentDir(root.name),
    to: coordinator.agentId,
    text,
  });
  if (!flags.json) out(`Sent ${sent.msgId} -> ${coordinator.agentId} (conversation ${sent.conversationId})`);
  if (!flags.wait) {
    if (flags.json) {
      sendResult({ ok: true, waited: false, msgId: sent.msgId, conversationId: sent.conversationId, to: coordinator.agentId });
    }
    return 0;
  }

  // Strict correlation: exact replyToMessageId AND the expected coordinator sender AND
  // the original root conversation.
  const correlation = {
    msgId: sent.msgId,
    expectedSender: coordinator.agentId,
    conversationId: sent.conversationId,
  };
  const timeoutMs = (flags.timeoutSeconds ?? 600) * 1000;
  const reply = await waitForCorrelatedReply(paths.agentDbFile(root.name), correlation, {
    timeoutMs,
    cancelCheck: () => rootWorkflowCancelledAt(paths.agentDbFile(root.name), sent.msgId),
  });
  if (reply?.cancelled) {
    // An operator/runtime status — deliberately NOT attributed to any agent.
    if (flags.json) {
      sendResult({ ok: false, reason: "cancelled", msgId: sent.msgId, conversationId: sent.conversationId, systemResult: "Задача отменена пользователем." });
    } else {
      out("");
      out("Задача отменена пользователем.");
    }
    return 5;
  }
  if (!reply) {
    const rejected = findRejectedCandidates(paths.agentDbFile(root.name), correlation);
    if (flags.json) {
      sendResult({
        ok: false,
        reason: "timeout",
        msgId: sent.msgId,
        conversationId: sent.conversationId,
        timeoutSeconds: Math.round(timeoutMs / 1000),
        ignoredReplies: rejected.length,
      });
      return 3;
    }
    err(`murmur: no correlated reply within ${Math.round(timeoutMs / 1000)}s (msgId ${sent.msgId}).`);
    for (const candidate of rejected) {
      err(`  ignored ${candidate.msgId}: sender=${candidate.sender} conversation=${candidate.conversationId} (not the expected coordinator/conversation)`);
    }
    return 3;
  }
  // A correlated reply is not automatically an ANSWER: an empty text or a bare tool/delegation
  // intent must never satisfy a caller (and never a required independent review).
  const verdict = classifyRuntimeOutput({ text: reply.text });
  if (verdict.kind !== OUTPUT_KINDS.text) {
    if (flags.json) {
      sendResult({ ok: false, reason: "non-substantive-reply", kind: verdict.kind, msgId: sent.msgId, conversationId: sent.conversationId, replyMsgId: reply.msgId });
    } else {
      err(`murmur: the correlated reply is not substantive (${verdict.kind}); it does not count as a result (msgId ${sent.msgId}).`);
    }
    return 3;
  }
  if (flags.json) {
    sendResult({
      ok: true,
      waited: true,
      substantive: true,
      msgId: sent.msgId,
      conversationId: sent.conversationId,
      replyMsgId: reply.msgId,
      from: reply.sender,
      text: reply.text,
    });
    return 0;
  }
  out("");
  out(reply.text);
  return 0;
};

// ---------------------------------------------------------------------------
const COMMANDS = {
  start: commandStart,
  status: commandStatus,
  projects: commandProjects,
  stop: commandStop,
  doctor: commandDoctor,
  logs: commandLogs,
  send: commandSend,
  notify: (parsed) => commandNotify({ ...parsed, out, err }),
  claude: (parsed) => commandClaude({ ...parsed, out, err }),
  codex: (parsed) => commandCodex({ ...parsed, out, err }),
  usage: (parsed) => commandUsage({ ...parsed, out, err }),
  tasks: (parsed) => commandWork({ ...parsed, command: "tasks", out, err }),
  task: (parsed) => commandWork({ ...parsed, command: "task", out, err }),
  cancel: (parsed) => commandWork({ ...parsed, command: "cancel", out, err }),
  cursor: (parsed) => commandCursor({ ...parsed, out, err }),
};

/**
 * Commands that operate on the USER's Murmur state rather than on one project, and so
 * must not be rejected for a missing `<project>`.
 */
const PROJECTLESS_COMMANDS = new Set(["notify", "projects"]);

export const run = async (argv = process.argv.slice(2)) => {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    err(`murmur: ${error.message}`);
    err(USAGE);
    return 1;
  }
  if (parsed.flags.help || !parsed.command || parsed.command === "help") {
    out(USAGE);
    return parsed.command || parsed.flags.help ? 0 : 1;
  }
  const handler = COMMANDS[parsed.command];
  if (!handler) {
    err(`murmur: unknown command '${parsed.command}'`);
    err(USAGE);
    return 1;
  }
  if (!parsed.args[0] && !PROJECTLESS_COMMANDS.has(parsed.command)) {
    err(`murmur: ${parsed.command} requires <project>`);
    err(USAGE);
    return 1;
  }
  try {
    return await handler(parsed);
  } catch (error) {
    err(`murmur: ${error?.message || error}`);
    return 1;
  }
};
