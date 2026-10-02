/**
 * doctor.mjs — reusable diagnostics shared by `murmur doctor` and `murmur start`
 * preflight.
 *
 * Every check returns a small record; NONE of them ever returns key material, a NATS
 * token, or the contents of an agent config. `fatal: true` means `murmur start` refuses
 * before touching any process.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { peerSupportsHandoffV1 } from "@murmurv2/core";
import { readPrivateJson } from "../secure-state.mjs";
import { SCOPE_OFF, describeNotifyConfig, isNotifyScope, loadNotifyConfig, notifyConfigPath } from "../notify-config.mjs";
import { CODEX_SOURCES, discoverCodexExecutable } from "./codex.mjs";
import { discoverClaudeCapabilities } from "../claude-capabilities.mjs";
import { isSupportedEffort, isSupportedModel, loadClaudePreferences } from "./claude-config.mjs";
import { resolveCursorModelInfo, cursorCliConfigPath } from "./cursor-config.mjs";
import { DEFAULT_AGENTS, DEFAULT_NATS_URL, agentByName, agentIdFor, enabledAgents, loadProfile, peersForAgent } from "./profile.mjs";
import { socketPathFits, UNIX_SOCKET_PATH_MAX } from "./project.mjs";
import { OWNED, UNKNOWN, ownedProcessState, provenGone } from "./proc.mjs";
import {
  GUARD_CLEANUP_UNVERIFIED,
  LOCK_FREE,
  LOCK_HELD,
  LOCK_STALE,
  LOCK_UNKNOWN,
  launchGuardReclaimable,
  launchGuardState,
  lockState,
  readRunState,
  unsettledOwnedChildren,
} from "./runstate.mjs";
import { endpointEntryExists, probeUnixSocket } from "./supervisor.mjs";

const execFileAsync = promisify(execFile);

export const PASS = "PASS";
export const FAIL = "FAIL";
export const WARN = "WARN";
export const SKIP = "SKIP";

const check = (name, status, detail, extra = {}) => ({ name, status, detail, fatal: false, ...extra });

/** PATH lookup without a shell, so nothing from `<project>` can ever be interpreted. */
export const findExecutable = (command, env = process.env) => {
  if (typeof command !== "string" || !command) return null;
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep searching */
    }
  }
  return null;
};

const runTool = async (file, args, timeoutMs = 20_000) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout: timeoutMs, encoding: "utf8" });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return { ok: false, stdout: err?.stdout || "", stderr: err?.stderr || "", error: err?.message || "exec-failed" };
  }
};

export const checkNats = async ({ natsUrl, natsToken, timeoutMs = 4_000, connectImpl } = {}) => {
  let connect = connectImpl;
  if (!connect) ({ connect } = await import("nats"));
  let connection;
  try {
    connection = await connect({
      servers: natsUrl,
      ...(natsToken ? { token: natsToken } : {}),
      timeout: timeoutMs,
      reconnect: false,
      maxReconnectAttempts: 0,
      name: "murmur-doctor",
    });
    const server = connection.getServer?.() || natsUrl;
    return check("nats", PASS, `reachable at ${server}`);
  } catch (err) {
    return check("nats", FAIL, `cannot reach ${natsUrl}: ${err?.message || "connect-failed"}`, {
      fatal: true,
      fix: "start a NATS server for this endpoint (Murmur never starts, stops or reconfigures one for you)",
    });
  } finally {
    await connection?.close?.().catch(() => {});
  }
};

export const checkClaude = async ({ env = process.env, run = runTool } = {}) => {
  const binary = findExecutable("claude", env);
  if (!binary) {
    return [
      check("claude-binary", FAIL, "`claude` not found on PATH", { fatal: true, fix: "install Claude Code" }),
      check("claude-auth", SKIP, "binary missing"),
    ];
  }
  const result = await run(binary, ["auth", "status"]);
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(result.stdout).loggedIn === true;
  } catch {
    loggedIn = false;
  }
  return [
    check("claude-binary", PASS, binary),
    loggedIn
      ? check("claude-auth", PASS, "authenticated")
      : check("claude-auth", FAIL, "not authenticated", { fatal: true, fix: "claude auth login" }),
  ];
};

export const checkCursor = async ({ env = process.env, run = runTool, command = "agent" } = {}) => {
  const binary = findExecutable(command, env);
  if (!binary) {
    return [
      check("cursor-binary", FAIL, `\`${command}\` not found on PATH`, { fatal: true, fix: "install the Cursor Agent CLI" }),
      check("cursor-auth", SKIP, "binary missing"),
    ];
  }
  const result = await run(binary, ["status"]);
  const text = `${result.stdout}\n${result.stderr}`;
  const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
  return [
    check("cursor-binary", PASS, binary),
    loggedIn
      ? check("cursor-auth", PASS, "authenticated")
      : check("cursor-auth", FAIL, "not authenticated", { fatal: true, fix: "agent login" }),
  ];
};

/**
 * Report WHICH Codex executable the canonical discovery chain selected. Only the source
 * and the resolved path are surfaced; nothing from the profile's private state is.
 */
export const checkCodexBinary = ({ project, env = process.env, platform = process.platform } = {}) => {
  const override = project?.codexAppServer?.command;
  const discovery = discoverCodexExecutable({ override, env, platform });
  if (!discovery.path) {
    const tried = discovery.attempted.map((entry) => entry.source).join(", ") || "none";
    return [check("codex-binary", FAIL, `no Codex executable found (tried: ${tried})`, {
      fatal: true,
      fix: "install Codex (or the ChatGPT desktop app), set codexAppServer.command in project.json, or set agents[codex].enabled=false",
    })];
  }
  const label = discovery.source === CODEX_SOURCES.chatgptBundle
    ? `${discovery.path} (ChatGPT app bundle)`
    : `${discovery.path} (${discovery.source})`;
  const results = [check("codex-binary", PASS, label, { source: discovery.source })];
  if (discovery.overrideIgnored) {
    results.push(check("codex-binary-override", WARN,
      `configured codexAppServer.command did not resolve to an executable; using ${discovery.source} instead`));
  }
  return results;
};

/**
 * Classification rule for the three profile checks below:
 *
 *   WARN = incomplete but safely derivable — `murmur start` repairs it (doctor never
 *          repairs anything itself);
 *   FAIL = contradictory or unsafe — repair would have to guess, so it fails closed.
 */
const repairable = (name, detail) =>
  check(name, WARN, detail, { repairable: true, fix: "murmur start <project> repairs this" });

const checkIdentities = async ({ project, paths }) => {
  const results = [];
  for (const agent of enabledAgents(project)) {
    const configPath = paths.agentConfigFile(agent.name);
    let config;
    try {
      config = await readPrivateJson(configPath);
    } catch (err) {
      results.push(err?.code === "ENOENT"
        ? repairable(`identity:${agent.name}`, "identity missing")
        : check(`identity:${agent.name}`, FAIL, `unreadable agent config (${err?.code || err?.message})`, { fatal: true }));
      continue;
    }
    const expectedId = agentIdFor(project.projectId, agent.name);
    // Contradictory: a repair cannot invent which of the two is authoritative.
    const contradictions = [];
    if (config.agentId !== expectedId) contradictions.push(`agentId ${config.agentId} != ${expectedId}`);
    if (config.subject !== `msg.${expectedId}`) contradictions.push("subject does not match agentId");
    if (!config.keys?.encryption?.privateKey || !config.keys?.signing?.privateKey) contradictions.push("keypair incomplete");
    if (path.resolve(config.dataDir || "") !== path.resolve(paths.agentDir(agent.name))) contradictions.push("dataDir outside the profile");
    if (contradictions.length > 0) {
      results.push(check(`identity:${agent.name}`, FAIL, contradictions.join("; "), { fatal: true }));
      continue;
    }
    // Derivable: the advertisement is a pure function of the role.
    const expectedFeatures = agent.handoff ? ["handoff-v1"] : [];
    const advertises = Array.isArray(config.features) && expectedFeatures.every((f) => config.features.includes(f));
    results.push(advertises
      ? check(`identity:${agent.name}`, PASS, expectedId)
      : repairable(`identity:${agent.name}`, "capability advertisement out of date"));
  }
  return results;
};

const checkPairing = async ({ project, paths }) => {
  const active = new Set(enabledAgents(project).map((agent) => agent.name));
  const configs = new Map();
  for (const agent of enabledAgents(project)) {
    try {
      configs.set(agent.name, await readPrivateJson(paths.agentConfigFile(agent.name)));
    } catch {
      /* identity check already reported this */
    }
  }
  const results = [];
  for (const [a, b] of project.trustEdges || []) {
    if (!active.has(a) || !active.has(b)) {
      results.push(check(`pairing:${a}<->${b}`, SKIP, "one side disabled"));
      continue;
    }
    const configA = configs.get(a);
    const configB = configs.get(b);
    if (!configA || !configB) {
      results.push(repairable(`pairing:${a}<->${b}`, "identity missing"));
      continue;
    }
    const idA = configA.agentId;
    const idB = configB.agentId;
    // Every pairing defect is derivable from the public halves already on disk, so it
    // is repairable — repair copies public keys and never rotates a private one.
    const problems = [];
    if (!configA.peers?.[idB]) problems.push(`${a} is missing peer ${b}`);
    if (!configB.peers?.[idA]) problems.push(`${b} is missing peer ${a}`);
    if (configA.peers?.[idB] && configA.peers[idB].signing?.publicKey !== configB.keys?.signing?.publicKey) {
      problems.push(`${a}'s copy of ${b}'s signing key is stale`);
    }
    if (configB.peers?.[idA] && configB.peers[idA].signing?.publicKey !== configA.keys?.signing?.publicKey) {
      problems.push(`${b}'s copy of ${a}'s signing key is stale`);
    }
    results.push(problems.length === 0
      ? check(`pairing:${a}<->${b}`, PASS, "paired both ways")
      : repairable(`pairing:${a}<->${b}`, problems.join("; ")));
  }

  for (const agent of enabledAgents(project)) {
    if (!agent.handoff) continue;
    const config = configs.get(agent.name);
    if (!config) continue;
    for (const peerName of peersForAgent(agent.name, project.trustEdges || [])) {
      const peerAgent = project.agents.find((entry) => entry.name === peerName);
      if (!peerAgent?.handoff || !active.has(peerName)) continue;
      const peerEntry = config.peers?.[agentIdFor(project.projectId, peerName)];
      results.push(peerSupportsHandoffV1(peerEntry)
        ? check(`handoff-v1:${agent.name}->${peerName}`, PASS, "protocol 1.1 + handoff-v1")
        : repairable(`handoff-v1:${agent.name}->${peerName}`, "peer does not advertise protocol 1.1 + handoff-v1"));
    }
  }
  return results;
};

/**
 * The project's Claude model/effort PREFERENCE, validated against what the installed CLI
 * can actually do right now.
 *
 * Never fails merely because the project uses "inherit" (that is the untouched, always-
 * valid default — see `claude-config.mjs`), and never fails because the preferences file
 * is simply absent (an ordinary state for a project that has never set one). It FAILS when
 * an EXPLICIT selection is no longer something the installed CLI supports — exactly the
 * situation that would otherwise silently fall back to no override with only a log line
 * to notice it by.
 */
export const checkClaudeModelConfig = async ({ paths, discoverCapabilities = discoverClaudeCapabilities }) => {
  const loaded = await loadClaudePreferences(paths);
  if (loaded.state === "invalid") {
    return [check("claude-model-config", FAIL, `claude-preferences.json is invalid: ${loaded.reason}`, { fatal: false })];
  }
  if (loaded.state === "absent") {
    return [check("claude-model-config", PASS, "no project preference (inherits Claude Code's own configuration)")];
  }
  const capabilities = await discoverCapabilities();
  const { model, effort } = loaded.preferences;
  const results = [];
  results.push(isSupportedModel(model, capabilities)
    ? check("claude-model-config", PASS, model === "inherit" ? "inherit" : `${model} (supported by installed CLI)`)
    : check("claude-model-config", FAIL, `configured model '${model}' is no longer supported by the installed Claude CLI`, {
      fix: "murmur claude <project> model <id|inherit>  (ids: murmur claude <project> config)",
    }));
  results.push(isSupportedEffort(effort, capabilities)
    ? check("claude-effort-config", PASS, effort === "inherit" ? "inherit" : `${effort} (supported by installed CLI)`)
    : check("claude-effort-config", FAIL, `configured effort '${effort}' is no longer supported by the installed Claude CLI`, {
      fix: `murmur claude <project> effort <${[...capabilities.supportedEfforts, "inherit"].join("|")}>`,
    }));
  return results;
};

/**
 * Purely informational — ALWAYS passes. There is nothing to validate: Murmur offers no
 * Cursor model selection to be wrong (see `cursor-config.mjs`'s header for why), so this
 * exists only to make the currently-effective Cursor model visible in `murmur doctor`
 * without a separate `murmur cursor config` call.
 */
const checkCursorModelInfo = async ({ homedir = os.homedir() } = {}) => {
  const info = await resolveCursorModelInfo({ cursorCliConfigPath: cursorCliConfigPath(homedir) });
  return [check("cursor-model", PASS, `${info.effectiveModelLabel ?? "по настройкам Cursor"} (настройки Cursor, не Murmur)`)];
};

const checkRuntimeConfig = async ({ project, paths }) => {
  const results = [];
  for (const agent of enabledAgents(project)) {
    if (!agent.runtimeKind) continue;
    let config;
    try {
      config = await readPrivateJson(paths.agentConfigFile(agent.name));
    } catch {
      continue;
    }
    const runtime = config.runtime || {};
    const enabledKinds = Object.entries(runtime).filter(([, value]) => value?.enabled === true).map(([key]) => key);
    // Two enabled autonomous runtimes on one identity is what the daemon itself refuses
    // to start with; repair would have to guess which one the operator meant.
    if (enabledKinds.length > 1) {
      results.push(check(`runtime:${agent.name}`, FAIL, `expected exactly one enabled runtime, found ${enabledKinds.length}`, { fatal: true }));
      continue;
    }
    const settings = Object.values(runtime).find((value) => value?.enabled === true) || null;
    const missing = [];
    if (!settings) missing.push("no enabled runtime");
    else {
      if (path.resolve(settings.cwd || "") !== path.resolve(project.projectPath)) missing.push("runtime cwd is not the project path");
      if (agent.name === "codex" && path.resolve(settings.socketPath || "") !== path.resolve(paths.codexSocket)) {
        missing.push("codex socketPath is not the profile-owned socket");
      }
    }
    results.push(missing.length === 0
      ? check(`runtime:${agent.name}`, PASS, `${agent.runtimeKind} -> ${agent.memberSlot}`)
      : repairable(`runtime:${agent.name}`, missing.join("; ")));
  }
  return results;
};

const checkCodexSocket = async ({ project, paths, socketProbe = probeUnixSocket }) => {
  if (!enabledAgents(project).some((agent) => agent.name === "codex")) {
    return [check("codex-socket", SKIP, "codex agent disabled")];
  }
  const results = [];
  results.push(socketPathFits(paths.codexSocket)
    ? check("codex-socket-path", PASS, paths.codexSocket)
    : check("codex-socket-path", FAIL, `socket path exceeds the ${UNIX_SOCKET_PATH_MAX}-byte AF_UNIX limit: ${paths.codexSocket}`, {
      fatal: true,
      fix: "set MURMUR_HOME to a shorter directory",
    }));

  // A dangling alias is an ENTRY, even though `existsSync` (which follows links) says otherwise.
  if (!endpointEntryExists(paths.codexSocket)) {
    results.push(check("codex-socket", PASS, "no socket present (a fresh one is created on start)"));
    return results;
  }
  const probe = await socketProbe(paths.codexSocket);
  const state = await readRunState(paths);
  const supervisorOwned = state?.supervisor ? ownedProcessState(state.supervisor) === OWNED : false;
  // The real App Server materialises the configured pathname as a symlink to its own socket.
  const shape = probe.alias ? "socket alias" : "socket";
  if (probe.ok && supervisorOwned) {
    results.push(check("codex-socket", PASS, `owned by the running supervisor (${shape})`));
  } else if (probe.alias && probe.targetKind && probe.targetKind !== "socket") {
    // The alias resolves to something that is not a socket: never usable, whoever owns it.
    results.push(check("codex-socket", FAIL, `the Codex socket alias resolves to a ${probe.targetKind}, not a socket`, {
      fatal: true,
      fix: "remove the alias at run/codex.sock and start again",
    }));
  } else if (probe.ok) {
    results.push(check("codex-socket", FAIL, "an App Server is listening on this profile's socket but no Murmur supervisor owns it", {
      fatal: true,
      fix: "stop that process yourself — Murmur never kills an App Server it did not start",
    }));
  } else if (state?.supervisor && !provenGone(ownedProcessState(state.supervisor))) {
    // Ownership of the App Server is uncertain: the socket is evidence, not garbage.
    results.push(check("codex-socket", WARN, `socket retained while supervisor ownership is unresolved (${probe.reason})`));
  } else results.push(check("codex-socket", WARN, `stale socket file present (${probe.reason}); it is removed on start`));
  return results;
};

/**
 * NOTIFICATIONS — always NON-BLOCKING.
 *
 * Operator notifications are a convenience layer over the bus, never a prerequisite for
 * it, so nothing here is ever `fatal`: an absent or malformed notification config must
 * not stop `murmur start` from bringing the multi-agent runtime up.
 *
 * Nothing printed here is derived from a credential — only presence, shape and the
 * per-identity scope. `describeNotifyConfig()` is the sole formatted view.
 */
export const checkNotifications = async ({ project = null, paths = null, env = process.env, home = undefined, load = loadNotifyConfig } = {}) => {
  const configPath = notifyConfigPath(env, home);
  const loaded = await load({ env, home, configPath });
  const summary = describeNotifyConfig(loaded);
  const results = [];

  if (summary.state === "absent") {
    results.push(check("telegram-notify", WARN, "not configured", {
      fix: "murmur notify migrate (or murmur notify status) — notifications are optional and never block a start",
    }));
    return results;
  }
  if (summary.state === "invalid") {
    results.push(check("telegram-notify", WARN, `configured but invalid (${summary.reason})`, {
      fix: `fix or remove ${configPath}; Murmur starts without notifications either way`,
    }));
    return results;
  }
  results.push(check("telegram-notify", PASS, `${summary.telegram} (global${summary.channels.length > 0 ? `: ${summary.channels.join(", ")}` : ""})`));

  // With a global config in place, every identity's POLICY is what decides whether one
  // operator task turns into one notification or one per agent. Report it, and flag a
  // topology in which nothing at all would be notified.
  if (!project || !paths) return results;
  const scopes = [];
  for (const agent of enabledAgents(project)) {
    let config;
    try {
      config = await readPrivateJson(paths.agentConfigFile(agent.name));
    } catch {
      continue; // the identity check already reported this
    }
    const declared = config.notifications;
    const scope = declared && isNotifyScope(declared.scope) && declared.source === "global"
      ? declared.scope
      : declared?.source === "none"
        ? SCOPE_OFF
        : null;
    if (scope === null) {
      results.push(repairable(`notify-policy:${agent.name}`, "notification policy missing or unrecognised"));
      continue;
    }
    // Report the EFFECTIVE scope, not only the stored one. A machine-wide
    // `murmur notify mode` overrides every per-role default, so printing the stored value
    // alone would tell an operator who just switched to `activity` that nothing changed.
    // An explicit opt-out is never overridden, and is reported as the opt-out it is.
    const effective = scope === SCOPE_OFF || summary.mode === "default" ? scope : summary.mode;
    scopes.push({ name: agent.name, scope: effective });
  }
  if (scopes.length > 0) {
    const describe = `mode=${summary.mode} ${scopes.map((entry) => `${entry.name}=${entry.scope}`).join(" ")}`;
    results.push(scopes.every((entry) => entry.scope === SCOPE_OFF)
      ? check("notify-policy", WARN, `every identity has notifications off (${describe})`)
      : check("notify-policy", PASS, describe));
  }
  return results;
};

const checkSupervisor = async ({ paths }) => {
  const results = [];
  const state = await readRunState(paths);
  const supervisor = state?.supervisor ? ownedProcessState(state.supervisor) : "gone";

  if (supervisor === OWNED && state?.degraded === true) {
    // Alive on purpose: it is holding the project rather than abandoning a process it could
    // not prove gone. That is safe, but it is NOT healthy, and a start stays refused.
    const detail = (state.residual || []).map((entry) => `${entry.name}(pid ${entry.pid ?? "-"})`).join(", ");
    results.push(check("supervisor", FAIL,
      `running in a DEGRADED hold (pid ${state.supervisor.pid}): residual not proven stopped${detail ? `: ${detail}` : ""}`, {
        fatal: true,
        fix: "it keeps retrying through its trusted handles; check `murmur logs <project>` and the residual PIDs",
      }));
  } else if (supervisor === OWNED) {
    results.push(check("supervisor", PASS, `running (pid ${state.supervisor.pid}, phase ${state.phase || "unknown"})`, { running: true }));
  } else if (supervisor === UNKNOWN) {
    // Not stale: ownership could not be measured, so `start` stays fail-closed.
    results.push(check("supervisor", FAIL, `recorded supervisor (pid ${state.supervisor.pid}) could not be verified as stopped`, {
      fatal: true,
      fix: "murmur stop <project> to retry cleanup; start stays refused until ownership is resolved",
    }));
  } else if (state?.supervisor) {
    results.push(check("supervisor", WARN, `stale run state for pid ${state.supervisor.pid}; it is reclaimed on start`));
  } else {
    results.push(check("supervisor", PASS, "not running"));
  }

  const lock = lockState(paths);
  if (lock.state === LOCK_FREE) results.push(check("supervisor-lock", PASS, "free"));
  else if (lock.state === LOCK_HELD) results.push(check("supervisor-lock", PASS, `held by pid ${lock.heldBy.pid}`));
  else if (lock.state === LOCK_UNKNOWN) {
    results.push(check("supervisor-lock", FAIL, `lock owner (pid ${lock.heldBy?.pid ?? "unrecorded"}) is unverifiable (${lock.reason})`, {
      fatal: true,
      fix: "the lock is deliberately NOT reclaimed while ownership is unknown — re-run doctor, or murmur stop <project>",
    }));
  } else {
    results.push(check("supervisor-lock", WARN, `stale lock from pid ${lock.heldBy?.pid}; reclaimed on start`));
  }

  // The launch guard is the exclusion that covers a supervisor that has been spawned but
  // has not yet published anything. A retained guard is a deliberate fail-closed state and
  // has to be visible here, not just as a confusing "refusing to start".
  const guard = launchGuardState(paths);
  if (guard.state === LOCK_FREE) results.push(check("launch-guard", PASS, "none"));
  else if (guard.state === LOCK_HELD && guard.heldBy.phase === GUARD_CLEANUP_UNVERIFIED) {
    // A launcher is alive and deliberately holding an unresolved supervisor.
    results.push(check("launch-guard", FAIL,
      `a \`murmur start\` (pid ${guard.heldBy.pid}) is holding a supervisor (pid ${guard.heldBy.spawnedPid ?? "unknown"}) `
      + "whose exit could not be confirmed", {
        fatal: true,
        fix: "let that command keep running — it holds the only trusted handle on that process; starts stay refused",
      }));
  } else if (guard.state === LOCK_HELD) {
    results.push(check("launch-guard", WARN, `a \`murmur start\` is launching this project (launcher pid ${guard.heldBy.pid})`));
  } else if (guard.state === LOCK_UNKNOWN) {
    results.push(check("launch-guard", FAIL, `launch guard owner (pid ${guard.heldBy?.pid ?? "unrecorded"}) is unverifiable (${guard.reason})`, {
      fatal: true,
      fix: "the guard is deliberately NOT reclaimed while ownership is unknown — re-run doctor, or murmur stop <project>",
    }));
  } else if (guard.state === LOCK_STALE) {
    const reclaimable = launchGuardReclaimable(guard.heldBy);
    if (reclaimable.ok) results.push(check("launch-guard", WARN, `stale launch guard from pid ${guard.heldBy?.pid}; reclaimed on start`));
    else if (reclaimable.manualRecovery) {
      // The worst case, stated plainly: a process was created and never identified, and the
      // launcher that held its handle is gone. No automatic path may reclaim this.
      results.push(check("launch-guard", FAIL,
        `MANUAL RECOVERY REQUIRED: a launch spawned a supervisor (pid ${reclaimable.spawnedPid ?? "unknown"}) whose ownership `
        + `was never established and whose exit was never observed (${reclaimable.reason})`, {
          fatal: true,
          fix: `identify and stop that process yourself, then remove ${paths.launchGuardFile}; `
            + "Murmur will never reclaim this guard automatically",
        }));
    } else {
      results.push(check("launch-guard", FAIL,
        `a failed launch left a supervisor (pid ${reclaimable.supervisor?.pid}) that is not proven stopped (${reclaimable.reason})`, {
          fatal: true,
          fix: "murmur stop <project>; start stays refused until that process is resolved",
        }));
    }
  }

  const residual = unsettledOwnedChildren(state);
  if (residual.length > 0 && supervisor !== OWNED) {
    const detail = residual.map((entry) => `${entry.name}(pid ${entry.pid}, ${entry.state})`).join(", ");
    results.push(check("residual-children", FAIL, `processes from a previous run are not proven stopped: ${detail}`, {
      fatal: true,
      fix: "murmur stop <project>",
    }));
  }
  return results;
};

/** Binary + authentication checks for the agents in an (already active) topology. */
const checkTools = async ({ project, paths, env, run, active, platform = process.platform }) => {
  const results = [];
  if (active.has("claude")) results.push(...await checkClaude({ env, run }));
  if (active.has("codex")) results.push(...checkCodexBinary({ project, env, platform }));
  if (active.has("cursor")) {
    let command = "agent";
    if (paths) {
      try {
        const config = await readPrivateJson(paths.agentConfigFile("cursor"));
        command = config.runtime?.cursorAcp?.command || "agent";
      } catch {
        /* identity check already reported this */
      }
    }
    results.push(...await checkCursor({ env, run, command }));
  }
  return results;
};

/**
 * Run the full diagnostic sweep. `requireProfile: false` lets `murmur doctor` describe a
 * project that has never been started without inventing a profile for it.
 */
export const runDiagnostics = async ({
  projectPath,
  projectId,
  paths,
  env = process.env,
  platform = process.platform,
  connectImpl,
  run = runTool,
  socketProbe = probeUnixSocket,
  includeNats = true,
  includeTools = true,
  includeNotifications = true,
  // The notification config lives in the SAME Murmur home as the profiles being
  // diagnosed, so it is derived from `paths` rather than re-read from the ambient
  // environment. A diagnostic run against one home can never inspect another's.
  notifyHome = paths?.home,
} = {}) => {
  const results = [];

  try {
    const stats = statSync(projectPath);
    results.push(stats.isDirectory()
      ? check("project-path", PASS, projectPath)
      : check("project-path", FAIL, `${projectPath} is not a directory`, { fatal: true }));
  } catch (err) {
    results.push(check("project-path", FAIL, `${projectPath}: ${err?.code || err?.message}`, { fatal: true }));
    return results;
  }

  results.push(path.resolve(paths.root).startsWith(`${path.resolve(projectPath)}${path.sep}`)
    ? check("state-location", FAIL, "the Murmur profile would live inside the project repository", { fatal: true })
    : check("state-location", PASS, paths.root));

  let project;
  try {
    project = await loadProfile(paths);
  } catch (err) {
    const missing = err?.code === "ENOENT";
    results.push(missing
      ? check("profile", WARN, "no profile yet; `murmur start` bootstraps one", { bootstrapNeeded: true })
      // `invalid-profile:<reason>` — persisted state that is unsafe or contradictory,
      // never something `start` is allowed to rewrite on its own.
      : check("profile", FAIL, err?.message || "invalid profile", { fatal: true }));
    // Without a profile there is nothing to verify about identities or pairing, but the
    // host-level prerequisites are exactly what the operator needs to know BEFORE the
    // first `murmur start`.
    if (includeNotifications) results.push(...await checkNotifications({ env, home: notifyHome }));
    if (includeNats) results.push(await checkNats({ natsUrl: DEFAULT_NATS_URL, connectImpl }));
    if (includeTools) {
      results.push(...await checkTools({
        project: {},
        paths: null,
        env,
        run,
        platform,
        active: new Set(DEFAULT_AGENTS.map((agent) => agent.name)),
      }));
    }
    return results;
  }

  results.push(project.projectId === projectId && path.resolve(project.projectPath) === path.resolve(projectPath)
    ? check("profile", PASS, `${paths.projectFile} (v${project.version})`)
    : check("profile", FAIL, "profile does not belong to this project path", { fatal: true }));

  results.push(...await checkIdentities({ project, paths }));
  results.push(...await checkPairing({ project, paths }));
  results.push(...await checkRuntimeConfig({ project, paths }));
  results.push(...await checkClaudeModelConfig({ paths }));
  if (agentByName(project, "cursor")) results.push(...await checkCursorModelInfo({}));
  results.push(...await checkCodexSocket({ project, paths, socketProbe }));
  results.push(...await checkSupervisor({ paths }));
  if (includeNotifications) results.push(...await checkNotifications({ project, paths, env, home: notifyHome }));

  if (includeNats) results.push(await checkNats({ natsUrl: project.natsUrl, natsToken: project.natsToken, connectImpl }));

  if (includeTools) {
    results.push(...await checkTools({
      project,
      paths,
      env,
      run,
      platform,
      active: new Set(enabledAgents(project).map((agent) => agent.name)),
    }));
  }

  return results;
};

export const hasFatal = (results) => results.some((result) => result.status === FAIL && result.fatal);
export const worstStatus = (results) => {
  if (results.some((result) => result.status === FAIL)) return FAIL;
  if (results.some((result) => result.status === WARN)) return WARN;
  return PASS;
};

export const formatReport = (results) => {
  const width = Math.max(...results.map((result) => result.name.length), 8);
  const lines = results.map((result) => {
    const fix = result.fix ? `\n${" ".repeat(width + 10)}fix: ${result.fix}` : "";
    return `  ${result.status.padEnd(4)}  ${result.name.padEnd(width)}  ${result.detail}${fix}`;
  });
  return lines.join("\n");
};
