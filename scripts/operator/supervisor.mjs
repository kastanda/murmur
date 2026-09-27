/**
 * supervisor.mjs — one project supervisor owning every project-level process.
 *
 * Ownership model
 * ---------------
 * The supervisor spawns and owns:
 *   - the external Codex App Server (when the codex agent is enabled),
 *   - one Murmur daemon per enabled agent identity.
 *
 * The Codex *Murmur daemon* still treats the App Server as EXTERNAL and UNOWNED: it
 * connects to the socket, never spawns it, never kills it and never unlinks it. The
 * supervisor owning the App Server process is a separate, higher layer — that proven
 * runtime invariant is untouched.
 *
 * Every child is tracked by exact PID + start identity (see `proc.mjs`). Nothing is ever
 * matched by process name.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, lstatSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ensurePrivateDirectory } from "../secure-state.mjs";
import { codexAppServerCommand } from "./codex.mjs";
import { enabledAgents } from "./profile.mjs";
import {
  GONE,
  establishOwnership,
  hasTrustedHandle,
  observeChildExit,
  ownedProcessState,
  probeStartIdentity,
  provenGone,
  readStartIdentity,
  stopOwnedProcess,
  stopSettled,
  terminateSpawnedChild,
} from "./proc.mjs";
import { clearRunState, readRunState, reclaimStaleLock, writeRunState } from "./runstate.mjs";

export const CODEX_APP_SERVER_CHILD = "codex-app-server";
const LOG_ROTATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const DEFAULT_STOP_GRACE_MS = 15_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Trivial size-based rotation: one generation, applied when the stream is opened. */
export const rotateLog = (logFile, maxBytes = LOG_ROTATE_BYTES) => {
  try {
    if (statSync(logFile).size < maxBytes) return false;
  } catch {
    return false;
  }
  renameSync(logFile, `${logFile}.1`);
  return true;
};

/**
 * Does a filesystem ENTRY exist at this path — including a dangling symlink?
 *
 * `existsSync` follows links, so it answers "false" for a broken alias, which would leave that
 * alias in place while reporting "no socket present". Everything that decides whether to remove
 * OUR OWN configured endpoint uses this instead.
 */
export const endpointEntryExists = (target) => {
  try {
    lstatSync(target);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return true; // exists but cannot be stat'ed: not something to assume away
  }
};

/**
 * Inspect the configured endpoint leaf. The real Codex App Server materialises the pathname it
 * is given as a SYMLINK to its own socket under `/private/tmp/codex-daemon-*`, so both shapes
 * are legitimate:
 *
 *   A. a Unix socket directly at the configured path;
 *   B. a symlink at the configured path whose target IS a Unix socket.
 *
 * A broken alias, or one resolving to a regular file or directory, is unhealthy — and neither is
 * ever treated as a profile-containment failure.
 */
export const inspectSocketEndpoint = (socketPath) => {
  let entry;
  try {
    entry = lstatSync(socketPath);
  } catch (err) {
    if (err?.code === "ENOENT") return { present: false, alias: false, targetKind: null, target: null, reason: "socket-absent" };
    return { present: true, alias: false, targetKind: null, target: null, reason: `socket-unreadable:${err?.code || "lstat-failed"}` };
  }
  if (!entry.isSymbolicLink()) {
    return {
      present: true,
      alias: false,
      targetKind: entry.isSocket() ? "socket" : "other",
      target: null,
      reason: entry.isSocket() ? null : "not-a-socket",
    };
  }
  // A runtime alias. Follow it for HEALTH only; the target stays runtime-owned and is never
  // managed, written or deleted by Murmur.
  let target;
  try {
    target = realpathSync(socketPath);
  } catch (err) {
    return { present: true, alias: true, targetKind: null, target: null, reason: `socket-alias-broken:${err?.code || "unresolvable"}` };
  }
  let stats;
  try {
    stats = statSync(target);
  } catch (err) {
    return { present: true, alias: true, targetKind: null, target, reason: `socket-alias-broken:${err?.code || "unreadable"}` };
  }
  if (!stats.isSocket()) {
    return { present: true, alias: true, targetKind: stats.isDirectory() ? "directory" : "file", target, reason: "socket-alias-not-a-socket" };
  }
  return { present: true, alias: true, targetKind: "socket", target, reason: null };
};

/** Can we actually connect to the App Server socket? Presence alone is not readiness. */
export const probeUnixSocket = (socketPath, timeoutMs = 2_000) =>
  new Promise((resolve) => {
    const endpoint = inspectSocketEndpoint(socketPath);
    const describe = (result) => ({ ...result, alias: endpoint.alias, targetKind: endpoint.targetKind, target: endpoint.target });
    if (!endpoint.present) {
      resolve(describe({ ok: false, reason: "socket-absent" }));
      return;
    }
    if (endpoint.reason) {
      // A broken alias, or one pointing at something that is not a socket: no point connecting.
      resolve(describe({ ok: false, reason: endpoint.reason }));
      return;
    }
    // `net.connect` follows the alias, exactly as a real client does.
    const socket = net.connect({ path: socketPath });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(describe(result));
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, reason: "socket-timeout" }));
    socket.once("connect", () => finish({ ok: true, reason: endpoint.alias ? "connected-via-alias" : "connected" }));
    socket.once("error", (err) => finish({ ok: false, reason: `socket-error:${err.code || err.message}` }));
  });

/** Readiness marker emitted by `murmur-daemon.mjs` structured logging. */
const inspectDaemonLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let entry;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (entry?.level === "fatal") return { kind: "fatal", detail: entry.msg || "daemon-fatal" };
  if (entry?.msg === "Daemon ready") return { kind: "ready" };
  return null;
};

export class ProjectSupervisor {
  constructor({
    project,
    paths,
    murmurRoot,
    log = () => {},
    spawn = nodeSpawn,
    readIdentity = readStartIdentity,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    socketProbe = probeUnixSocket,
    // How a spawned child's start identity is measured, and how hard we try. Injectable so
    // the ownership barrier can be exercised against a probe that fails transiently or
    // permanently, which is exactly the condition that must never leak a process.
    probeIdentity = probeStartIdentity,
    ownershipAttempts = 5,
    ownershipDelayMs = 100,
    env = process.env,
  }) {
    Object.assign(this, {
      project, paths, murmurRoot, log, spawn, readIdentity, readyTimeoutMs, stopGraceMs, socketProbe,
      probeIdentity, ownershipAttempts, ownershipDelayMs, env,
    });
    /** name -> { child, record, stream, readyPromise } */
    this.children = new Map();
    this.stopping = false;
    this.owner = { pid: process.pid, startIdentity: this.readIdentity(process.pid) };
  }

  agents() {
    return enabledAgents(this.project);
  }

  usesCodexAppServer() {
    return this.agents().some((agent) => agent.name === "codex");
  }

  childRecords() {
    const out = {};
    for (const [name, entry] of this.children) out[name] = entry.record;
    return out;
  }

  async persist(patch) {
    const previous = (await readRunState(this.paths)) || {};
    await writeRunState(this.paths, {
      ...previous,
      projectId: this.project.projectId,
      projectPath: this.project.projectPath,
      supervisor: this.owner,
      children: this.childRecords(),
      updatedAt: new Date().toISOString(),
      ...patch,
    });
  }

  openLog(name) {
    const logFile = this.paths.logFile(name);
    rotateLog(logFile);
    return { logFile, stream: createWriteStream(logFile, { flags: "a", mode: 0o600 }) };
  }

  /**
   * Spawn one tracked child. stdout/stderr are piped so they can be BOTH persisted to the
   * per-child log and scanned for a readiness marker; nothing is inherited from the
   * operator's terminal.
   */
  spawnChild({ name, command, args, cwd, env, inspect = null }) {
    const { logFile, stream } = this.openLog(name);
    const child = this.spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const record = {
      name,
      pid: child.pid ?? null,
      // Ownership is established asynchronously with bounded retry right after spawn
      // (`establishChildOwnership`). Until then the record is explicitly `pending`, so
      // nothing can mistake an unmeasured child for an absent one.
      startIdentity: null,
      ownership: child.pid ? "pending" : "gone",
      spawnedAt: Date.now(),
      command,
      args,
      cwd,
      logFile,
      startedAt: new Date().toISOString(),
      state: "starting",
      exit: null,
    };

    let settle = null;
    const readyPromise = new Promise((resolve) => { settle = resolve; });
    // Latch the OS exit through the trusted spawn handle. This is what lets a rollback
    // prove a child is really gone even when its ownership was never measurable.
    const exit = observeChildExit(child);
    const entry = { child, record, stream, readyPromise, settle, exit };
    this.children.set(name, entry);

    let buffer = "";
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      stream.write(text);
      if (!inspect) return;
      buffer += text;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const verdict = inspect(line);
        if (verdict?.kind === "ready") settle({ ok: true });
        else if (verdict?.kind === "fatal") settle({ ok: false, reason: verdict.detail });
      }
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-8 * 1024);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Keep the trusted spawn-time handle on the entry: while Node holds a non-exited
    // ChildProcess we know the process exists even if `ps` cannot be run.
    entry.handle = child;
    child.on("error", (err) => {
      record.state = "failed";
      record.exit = { error: err.message };
      settle({ ok: false, reason: `spawn-failed:${err.message}` });
    });
    child.on("exit", (code, signal) => {
      record.state = "exited";
      // FIRST-HAND evidence of absence, recorded durably: we watched this exact process be
      // reaped, so no later reader has to trust a PID probe that PID reuse could fool.
      record.exitObserved = true;
      record.exit = { code, signal };
      settle({ ok: false, reason: `exited:${signal || code}` });
      if (!this.stopping) {
        this.log("error", "Supervised child exited", { child: name, code, signal });
        this.persist({}).catch(() => {});
      }
    });

    return entry;
  }

  /**
   * Turn a freshly spawned child into a fully owned record, or say plainly that it
   * could not be done. A child whose identity cannot be captured is NOT declared gone
   * and NOT declared started: it stays `unverified`, which start() treats as a failure
   * and stop() treats as residual.
   */
  async establishChildOwnership(name) {
    const entry = this.children.get(name);
    if (!entry) throw new Error(`supervisor-child-unknown:${name}`);
    if (!entry.record.pid) return { ok: false, reason: "spawn-produced-no-pid" };
    const result = await establishOwnership(entry.record.pid, {
      child: entry.handle,
      probe: this.probeIdentity,
      attempts: this.ownershipAttempts,
      delayMs: this.ownershipDelayMs,
    });
    entry.record.startIdentity = result.startIdentity;
    entry.record.ownership = result.ownership;
    if (result.ownership === "established") return { ok: true };
    this.log("error", "Could not establish ownership of a spawned child", {
      child: name, pid: entry.record.pid, ownership: result.ownership,
    });
    return { ok: false, reason: `ownership-${result.ownership}:${name}` };
  }

  /**
   * True while this entry still carries trusted, non-exited spawn-time evidence: the exact
   * ChildProcess this supervisor created, whose exit has not been observed.
   */
  hasTrustedHandle(entry) {
    return Boolean(entry) && hasTrustedHandle(entry.handle, entry.exit);
  }

  /**
   * Terminate one child THROUGH its retained spawn handle, waiting for the real `exit`.
   *
   * This is the only lawful way to clean up a child whose ownership could not be measured:
   * signalling a naked PID could hit an unrelated process that inherited it, while our own
   * non-exited handle cannot point anywhere else.
   */
  async terminateThroughHandle(entry, { graceMs = this.stopGraceMs } = {}) {
    const result = await terminateSpawnedChild(entry.handle, { exit: entry.exit, graceMs });
    // Settled here means the OS exit was OBSERVED (or the process never existed), which is
    // durable positive evidence of absence — record it so later readers need no probe.
    if (result.settled) entry.record.exitObserved = true;
    if (result.signalled.length > 0) {
      this.log("info", "Signalled a child through its trusted spawn handle", {
        child: entry.record.name, pid: entry.record.pid, signals: result.signalled, outcome: result.outcome,
      });
    }
    return result.outcome;
  }

  /**
   * Stop ONE child with the strongest authority available, never a weaker one.
   *
   *   exit already observed -> nothing to do;
   *   ownership established -> exact PID + start identity, escalating through the trusted
   *                            handle if that could not prove the exit;
   *   ownership unverified  -> the trusted handle ONLY. Never a naked PID.
   */
  async terminateEntry(entry, { graceMs = this.stopGraceMs } = {}) {
    if (entry.exit?.state?.exited || entry.record.exitObserved === true) return "not-running";

    const verified = entry.record.ownership === "established" && Boolean(entry.record.startIdentity);
    if (!verified) {
      if (this.hasTrustedHandle(entry)) return this.terminateThroughHandle(entry, { graceMs });
      // No identity and no handle: nothing may be signalled, and nothing may be claimed.
      if (!entry.record.pid) return "not-running";
      return "identity-unknown";
    }

    const outcome = await stopOwnedProcess(entry.record, { graceMs });
    if (stopSettled(outcome)) return outcome;
    if (this.hasTrustedHandle(entry)) {
      const viaHandle = await this.terminateThroughHandle(entry, { graceMs });
      if (stopSettled(viaHandle)) return viaHandle;
    }
    return outcome;
  }

  async waitForChildReady(name, timeoutMs = this.readyTimeoutMs) {
    const entry = this.children.get(name);
    if (!entry) throw new Error(`supervisor-child-unknown:${name}`);
    const timeout = delay(timeoutMs).then(() => ({ ok: false, reason: "ready-timeout" }));
    const result = await Promise.race([entry.readyPromise, timeout]);
    entry.record.state = result.ok ? "ready" : "failed";
    if (!result.ok && !entry.record.exit) entry.record.exit = { reason: result.reason };
    return result;
  }

  /**
   * Start the App Server the supervisor owns, then wait until its socket actually
   * accepts a connection. A socket file left behind by a dead server is removed first —
   * but only after confirming nothing is listening on it.
   */
  async startCodexAppServer() {
    const socketPath = this.paths.codexSocket;
    const probe = await this.socketProbe(socketPath);
    if (probe.ok) throw new Error(`codex-app-server-socket-in-use:${socketPath}`);
    if (endpointEntryExists(socketPath)) {
      // Removes OUR configured entry only. For an alias that unlinks the link itself; the
      // App Server's own socket under /private/tmp is never touched.
      this.log("warn", "Removing stale Codex App Server socket", {
        socketPath, reason: probe.reason, alias: probe.alias === true,
      });
      try {
        unlinkSync(socketPath);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }

    const { command, args, endpoint, discovery } = codexAppServerCommand(this.project, socketPath, { env: this.env });
    if (!command) throw new Error("codex-executable-not-found");
    this.log("info", "Starting Codex App Server", { source: discovery.source, endpoint });
    this.spawnChild({
      name: CODEX_APP_SERVER_CHILD,
      command,
      args,
      cwd: this.project.projectPath,
      env: { ...this.env, MURMUR_CODEX_APP_SERVER_SOCKET: socketPath },
    });

    const owned = await this.establishChildOwnership(CODEX_APP_SERVER_CHILD);
    if (!owned.ok) return { ok: false, reason: owned.reason };

    const entry = this.children.get(CODEX_APP_SERVER_CHILD);
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (entry.record.state === "exited" || entry.record.state === "failed") {
        return { ok: false, reason: `codex-app-server-${entry.record.state}`, logFile: entry.record.logFile };
      }
      const ready = await this.socketProbe(socketPath);
      if (ready.ok) {
        entry.record.state = "ready";
        entry.record.socketPath = socketPath;
        return { ok: true };
      }
      await delay(250);
    }
    return { ok: false, reason: "codex-app-server-socket-timeout", logFile: entry.record.logFile };
  }

  daemonChildSpec(agent) {
    return {
      name: agent.name,
      command: process.execPath,
      args: [path.join(this.murmurRoot, "scripts", "murmur-daemon.mjs")],
      cwd: this.project.projectPath,
      env: { ...this.env, DATA_DIR: agent.dataDir, MURMUR_PROJECT_ID: this.project.projectId },
      inspect: inspectDaemonLine,
    };
  }

  /**
   * Start everything, in dependency order. Any failure triggers a FULL rollback of
   * whatever this call already started, so a failed start never leaves half a project
   * running.
   */
  async start() {
    await ensurePrivateDirectory(this.paths.logsDir);
    await ensurePrivateDirectory(this.paths.runDir);
    await this.persist({ phase: "starting", error: null, startedAt: new Date().toISOString() });

    try {
      if (this.usesCodexAppServer()) {
        const appServer = await this.startCodexAppServer();
        if (!appServer.ok) throw new Error(appServer.reason);
        await this.persist({ phase: "starting" });
      }

      // Daemons start in parallel; readiness is awaited per child.
      for (const agent of this.agents()) this.spawnChild(this.daemonChildSpec(agent));
      // Ownership BEFORE readiness: a child we cannot identify must never be reported
      // as a successful start, and must never be silently dropped from cleanup.
      for (const agent of this.agents()) {
        const owned = await this.establishChildOwnership(agent.name);
        if (!owned.ok) throw new Error(owned.reason);
      }
      await this.persist({ phase: "starting" });

      for (const agent of this.agents()) {
        const ready = await this.waitForChildReady(agent.name);
        if (!ready.ok) throw new Error(`${agent.name}-not-ready:${ready.reason}`);
      }

      await this.persist({ phase: "ready", readyAt: new Date().toISOString(), error: null });
      this.log("info", "Supervisor ready", {
        projectId: this.project.projectId,
        children: [...this.children.keys()],
      });
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log("error", "Supervisor start failed, rolling back", { reason });
      const rollback = await this.stop("start-failed");
      // A rollback that could not prove every child gone must keep saying so; marking
      // the run `failed` with no residual would throw away the retry evidence.
      await this.persist(rollback.clean
        ? { phase: "failed", error: reason, residual: [] }
        : { phase: "stop-incomplete", error: reason, residual: rollback.residual, degraded: rollback.degraded });
      return { ok: false, reason, clean: rollback.clean, residual: rollback.residual, degraded: rollback.degraded };
    }
  }

  /**
   * Graceful shutdown of ONLY the processes this supervisor started, in reverse
   * dependency order: Murmur daemons first so they retire their bindings cleanly, then
   * the Codex App Server the supervisor owns.
   */
  async stop(reason = "requested") {
    if (this.stopping) return this.lastStopResult || { stopped: [], clean: true, residual: [], degraded: false };
    this.stopping = true;
    this.stopReason = reason;
    this.stopOutcomes = new Map();
    await this.persist({ phase: "stopping", stopReason: reason }).catch(() => {});

    const order = [...this.agents().map((agent) => agent.name).reverse(), CODEX_APP_SERVER_CHILD];
    for (const name of order) {
      const entry = this.children.get(name);
      if (!entry) continue;
      const outcome = await this.terminateEntry(entry);
      this.recordStopOutcome(entry, outcome);
      try {
        entry.stream.end();
      } catch {
        /* stream already closed */
      }
    }
    return this.finalizeStop();
  }

  /** Book the verdict for one child, and keep the evidence a retry would need. */
  recordStopOutcome(entry, outcome) {
    const settled = stopSettled(outcome);
    // A record we could not settle keeps its PID and identity: that evidence is what
    // a later `murmur stop` needs in order to retry the cleanup safely.
    entry.record.state = settled ? "stopped" : "stop-unconfirmed";
    entry.record.stopOutcome = outcome;
    this.stopOutcomes.set(entry.record.name, { outcome, settled, pid: entry.record.pid });
    this.log(settled ? "info" : "error", "Supervised child stopped", {
      child: entry.record.name, outcome, pid: entry.record.pid, settled,
    });
  }

  /**
   * Turn the per-child verdicts into the authoritative stop result, clean up what may be
   * cleaned, and persist the truth.
   *
   * `degraded` means: something is unsettled AND we still hold its trusted spawn handle.
   * That is recoverable in-process — the caller must NOT exit and drop the handle, because
   * the handle is the last thing that can still prove or force that process's exit.
   */
  async finalizeStop() {
    const stopped = [...this.stopOutcomes.entries()].map(([name, info]) => ({ name, ...info }));
    const residual = stopped.filter((entry) => !entry.settled).map(({ name, pid, outcome }) => ({ name, pid, outcome }));
    const clean = residual.length === 0;
    const degraded = residual.some((entry) => this.hasTrustedHandle(this.children.get(entry.name)));

    // The socket belongs to the App Server process this supervisor owned. While that
    // ownership is UNCERTAIN the socket is evidence, not garbage: unlinking it would
    // destroy the only handle on a possibly-live server.
    if (clean) {
      const probe = await this.socketProbe(this.paths.codexSocket);
      if (!probe.ok && endpointEntryExists(this.paths.codexSocket)) {
        try {
          unlinkSync(this.paths.codexSocket);
        } catch (err) {
          if (err?.code !== "ENOENT") this.log("warn", "Could not remove Codex socket", { error: err.message });
        }
      }
    } else {
      this.log("error", "Stop incomplete: owned processes could not be proven gone", { residual, degraded });
    }

    // Never persist `stopped` for a cleanup that was not proven complete.
    await this.persist(clean
      ? { phase: "stopped", stoppedAt: new Date().toISOString(), stopReason: this.stopReason, residual: [] }
      : { phase: "stop-incomplete", stopReason: this.stopReason, residual, degraded, stoppedAt: null }).catch(() => {});

    this.lastStopResult = { stopped, clean, residual, degraded };
    return this.lastStopResult;
  }

  /**
   * Re-attempt the unsettled part of a stop while the trusted handles are still held.
   *
   * This is what a DEGRADED supervisor runs on a slow loop instead of exiting: as long as
   * it is alive it keeps the handle, keeps the project lock, and keeps trying to observe
   * the exit it could not observe the first time.
   */
  async retryResidualTermination({ graceMs = this.stopGraceMs } = {}) {
    if (!this.stopOutcomes) return this.lastStopResult || { stopped: [], clean: true, residual: [], degraded: false };
    for (const [name, info] of [...this.stopOutcomes]) {
      if (info.settled) continue;
      const entry = this.children.get(name);
      if (!entry) continue;
      const outcome = await this.terminateEntry(entry, { graceMs });
      this.recordStopOutcome(entry, outcome);
    }
    return this.finalizeStop();
  }
}

/**
 * Out-of-band reaping for `murmur stop` when the supervisor process itself is already
 * gone: only PIDs recorded in run state, only when their start identity still matches.
 */
export const reapOrphanedChildren = async (paths, { graceMs = DEFAULT_STOP_GRACE_MS } = {}) => {
  const state = await readRunState(paths);
  // A child whose liveness cannot be measured right now is a reaping CANDIDATE, not a
  // process to assume dead — `stopOwnedProcess` still refuses to signal it unverified.
  const orphans = Object.entries(state?.children || {})
    .map(([name, record]) => ({ name, ...record }))
    .filter((record) => ownedProcessState(record) !== "gone");
  const stopped = [];
  for (const record of orphans) {
    const outcome = await stopOwnedProcess(record, { graceMs });
    stopped.push({ name: record.name, outcome, pid: record.pid, settled: stopSettled(outcome) });
  }
  return stopped;
};

/**
 * Post-stop cleanup of run metadata. Never touches identities, databases or logs.
 *
 * It removes durable evidence ONLY when every owned process is proven gone. An
 * unmeasurable supervisor or child leaves the run state, lock and socket in place, so a
 * later `murmur stop` can retry and a later `murmur start` stays fail-closed.
 */
export const cleanupRuntimeArtifacts = async (paths, { removeSocket = true, socketProbe = probeUnixSocket } = {}) => {
  const removed = [];
  const state = await readRunState(paths);

  const supervisorState = state?.supervisor ? ownedProcessState(state.supervisor) : GONE;
  const childStates = Object.values(state?.children || {}).map((record) => ownedProcessState(record));
  const everythingGone = provenGone(supervisorState) && childStates.every(provenGone);
  if (!everythingGone) {
    return { removed, retained: true, supervisorState, unsettledChildren: childStates.filter((value) => !provenGone(value)).length };
  }

  if (removeSocket && endpointEntryExists(paths.codexSocket)) {
    const probe = await socketProbe(paths.codexSocket);
    if (!probe.ok) {
      try {
        unlinkSync(paths.codexSocket);
        removed.push(paths.codexSocket);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    }
  }
  if (state?.supervisor) {
    // Post-stop cleanup does not hold the dead supervisor's lock instance token, so it may
    // only RECLAIM the lock, and only on positive evidence that the recorded owner is gone.
    // A lock that a live (or unmeasurable) owner holds is never touched here.
    const reclaimed = reclaimStaleLock(paths, { expected: state.supervisor });
    if (reclaimed.reclaimed) removed.push(paths.lockFile);
    await clearRunState(paths);
    removed.push(paths.supervisorFile);
  }
  return { removed, retained: false, supervisorState, unsettledChildren: 0 };
};
