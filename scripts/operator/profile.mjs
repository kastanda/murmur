/**
 * profile.mjs — the per-project Murmur profile: topology, identities, pairing and
 * runtime configuration.
 *
 * Identities and pairing are produced with the ALREADY IMPLEMENTED mechanisms
 * (`@murmurv2/security` keypairs, `localHandoffCapabilities()` /
 * `peerCapabilityFields()` advertisement, `secure-state` private JSON). Nothing here
 * re-implements crypto, envelope construction or capability negotiation.
 */
import { constants, lstatSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { createKeyPair, createSigningKeyPair, getCryptoProvider } from "@murmurv2/security";
import { localHandoffCapabilities, peerCapabilityFields } from "../agent-handoff-controller.mjs";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "../secure-state.mjs";
import { defaultScopeForRole, isNotifyScope } from "../notify-config.mjs";
import { CLAUDE_AUTO_MEMBER_SLOT } from "../claude-one-shot-runtime.mjs";
import { CURSOR_ACP_MEMBER_SLOT } from "../cursor-acp-runtime.mjs";
import { CODEX_APP_SERVER_MEMBER_SLOT } from "../agent-runtime-adapter.mjs";
import { DEFAULT_CODEX_APP_SERVER_ARGS } from "./codex.mjs";

export const PROFILE_VERSION = 1;
export const DEFAULT_NATS_URL = "nats://127.0.0.1:4222";

/** The v1 default topology: an operator/root identity plus three autonomous runtimes. */
export const DEFAULT_AGENTS = Object.freeze([
  Object.freeze({ name: "root", role: "operator", runtimeKey: null, runtimeKind: null, memberSlot: null, handoff: false, required: true }),
  Object.freeze({ name: "claude", role: "coordinator", runtimeKey: "claudeOneShot", runtimeKind: "claude_one_shot", memberSlot: CLAUDE_AUTO_MEMBER_SLOT, handoff: true, required: true }),
  Object.freeze({ name: "codex", role: "worker", runtimeKey: "codexAppServer", runtimeKind: "codex_app_server", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT, handoff: true, required: false }),
  Object.freeze({ name: "cursor", role: "worker", runtimeKey: "cursorAcp", runtimeKind: "cursor_acp", memberSlot: CURSOR_ACP_MEMBER_SLOT, handoff: true, required: false }),
]);

export const COORDINATOR = "claude";

/**
 * Trust edges. Sibling delegation goes THROUGH the coordinator, so codex <-> cursor is
 * deliberately absent: a worker cannot delegate directly to its sibling.
 */
export const DEFAULT_TRUST_EDGES = Object.freeze([
  Object.freeze(["root", "claude"]),
  Object.freeze(["claude", "codex"]),
  Object.freeze(["claude", "cursor"]),
]);

const exists = async (target) => {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/** Agent identity is namespaced by project id so two projects never collide on NATS. */
export const agentIdFor = (projectId, agentName) => `${projectId}-${agentName}`;

/**
 * What an agent advertises to its peers. Only agents that actually own an autonomous
 * runtime advertise `handoff-v1`; the operator/root identity does not, so a coordinator
 * can never "delegate" work back to the human operator slot.
 */
const advertisementFor = (agent) =>
  agent.handoff ? localHandoffCapabilities() : { protocolVersions: ["1.0"], features: [] };

const runtimeConfigFor = (agent, { projectId, projectPath, codexSocketPath }) => {
  const shared = { enabled: true, projectId, cwd: projectPath, leaseTtlMs: 30_000, heartbeatIntervalMs: 5_000 };
  switch (agent.runtimeKey) {
    case "claudeOneShot":
      return { claudeOneShot: { ...shared, turnTimeoutMs: 300_000, terminateGraceMs: 5_000, permissionMode: "dontAsk" } };
    case "codexAppServer":
      return { codexAppServer: { ...shared, socketPath: codexSocketPath, retryDelayMs: 1_000 } };
    case "cursorAcp":
      return {
        cursorAcp: {
          ...shared,
          command: "agent",
          mode: "ask",
          permissionPolicy: "reject-once",
          startupTimeoutMs: 30_000,
          turnTimeoutMs: 300_000,
          terminateGraceMs: 5_000,
        },
      };
    default:
      return null;
  }
};

/**
 * The identity's NOTIFICATION POLICY — a derivable, NON-SECRET field.
 *
 * The credential itself lives once per machine in $MURMUR_HOME/notifications.json; a
 * project profile only ever records WHICH events this identity forwards, so no agent
 * config, project profile or repository holds a copy of a bot token.
 *
 *   root (operator) -> `all`: it receives only the coordinator's final correlated reply,
 *                      so this is one notification per completed operator task;
 *   every other role -> `errors`: runtime failures only. Internal handoffs are not
 *                      notified, which is what keeps one task from producing one message
 *                      per agent.
 *
 * An operator may hand-edit `scope` (including to `off`) or set `source: "none"`, and a
 * repair preserves that choice — only a MISSING or INVALID policy is regenerated.
 */
const notificationsFor = (agent) => ({ source: "global", scope: defaultScopeForRole(agent.role) });

/** The public half of an identity, in the shape the pairing helpers already consume. */
const advertiseBlob = (agent, config) => ({
  agentId: config.agentId,
  subject: config.subject,
  protocolVersions: config.protocolVersions,
  features: config.features,
  encryption: { publicKey: config.keys.encryption.publicKey },
  signing: { publicKey: config.keys.signing.publicKey },
});

/** Peer entry built from what the other side ACTUALLY advertised (absent stays absent). */
export const peerEntryFrom = (blob) => ({
  encryption: { publicKey: blob.encryption.publicKey },
  signing: { publicKey: blob.signing.publicKey },
  subject: blob.subject,
  ...peerCapabilityFields(blob),
});

export const peersForAgent = (agentName, edges = DEFAULT_TRUST_EDGES) => {
  const peers = new Set();
  for (const [a, b] of edges) {
    if (a === agentName) peers.add(b);
    else if (b === agentName) peers.add(a);
  }
  return [...peers];
};

const createIdentityConfig = async (agent, { projectId, projectPath, paths, natsUrl, natsToken, codexSocketPath }) => {
  const agentId = agentIdFor(projectId, agent.name);
  const encryption = await createKeyPair();
  const signing = await createSigningKeyPair();
  const advertised = advertisementFor(agent);
  const runtime = runtimeConfigFor(agent, { projectId, projectPath, codexSocketPath });
  return {
    agentId,
    natsUrl,
    ...(natsToken ? { natsToken } : {}),
    subject: `msg.${agentId}`,
    dataDir: paths.agentDir(agent.name),
    cryptoProvider: getCryptoProvider().name,
    protocolVersions: advertised.protocolVersions,
    features: advertised.features,
    keys: { encryption, signing },
    ackSecurity: { emitSigned: true, requireSigned: false, maxAgeMs: 300_000 },
    notifications: notificationsFor(agent),
    peers: {},
    ...(runtime ? { runtime } : {}),
  };
};

/**
 * The derivable half of an agent config: every field Murmur can safely regenerate from
 * the project identity alone. Used by repair so an operator's own runtime tuning
 * (timeouts, model, permission mode) is preserved.
 */
const derivableRuntimeFields = (agent, { projectId, projectPath, codexSocketPath }) => {
  if (!agent.runtimeKey) return null;
  const base = { enabled: true, projectId, cwd: projectPath };
  return agent.runtimeKey === "codexAppServer" ? { ...base, socketPath: codexSocketPath } : base;
};

/**
 * Reconcile one existing agent config. Contradictory state fails closed; merely missing
 * derivable state is repaired in place. Returns the repair reasons applied.
 */
const reconcileIdentityConfig = (agent, config, { projectId, projectPath, paths, codexSocketPath }) => {
  const expectedId = agentIdFor(projectId, agent.name);
  const repairs = [];

  // Contradictory — never silently rewritten.
  if (config.agentId !== expectedId) refuse("identity-agent-id-mismatch", agent.name);
  if (config.subject !== `msg.${expectedId}`) refuse("identity-subject-mismatch", agent.name);
  if (!config.keys?.encryption?.privateKey || !config.keys?.signing?.privateKey) {
    refuse("identity-keypair-incomplete", agent.name);
  }
  assertWithinProfile(config.dataDir, paths.root, `identity-data-dir:${agent.name}`);
  if (path.resolve(config.dataDir) !== path.resolve(paths.agentDir(agent.name))) {
    refuse("identity-data-dir-unexpected", agent.name);
  }

  // Capability advertisement is derived from the role, so a missing one is repairable.
  const advertised = advertisementFor(agent);
  if (JSON.stringify(config.protocolVersions) !== JSON.stringify(advertised.protocolVersions)
    || JSON.stringify(config.features) !== JSON.stringify(advertised.features)) {
    config.protocolVersions = advertised.protocolVersions;
    config.features = advertised.features;
    repairs.push(`capabilities:${agent.name}`);
  }

  // The notification policy is derivable from the role, so a profile created before
  // global notifications existed is repaired in place — without regenerating an identity,
  // touching a key, or writing a credential anywhere near the profile.
  const notifications = config.notifications;
  const policyUsable = notifications && typeof notifications === "object" && !Array.isArray(notifications)
    && (notifications.source === "global" || notifications.source === "none")
    && isNotifyScope(notifications.scope);
  if (!policyUsable) {
    config.notifications = notificationsFor(agent);
    repairs.push(`notifications:${agent.name}`);
  }

  const derivable = derivableRuntimeFields(agent, { projectId, projectPath, codexSocketPath });
  if (!derivable) return repairs;

  const runtime = config.runtime && typeof config.runtime === "object" ? config.runtime : {};
  const enabledKeys = Object.entries(runtime).filter(([, value]) => value?.enabled === true).map(([key]) => key);
  // More than one autonomous runtime on one identity is refused by the daemon itself;
  // that is contradictory state, not something to repair by guessing.
  if (enabledKeys.length > 1 || (enabledKeys.length === 1 && enabledKeys[0] !== agent.runtimeKey)) {
    refuse("identity-runtime-ambiguous", `${agent.name}:${enabledKeys.join(",")}`);
  }

  const current = runtime[agent.runtimeKey];
  if (!current || typeof current !== "object") {
    config.runtime = { ...runtime, ...runtimeConfigFor(agent, { projectId, projectPath, codexSocketPath }) };
    repairs.push(`runtime:${agent.name}`);
    return repairs;
  }
  const patched = { ...current, ...derivable };
  if (JSON.stringify(patched) !== JSON.stringify(current)) {
    config.runtime = { ...runtime, [agent.runtimeKey]: patched };
    repairs.push(`runtime-fields:${agent.name}`);
  }
  return repairs;
};

/**
 * ENSURE/RECONCILE the project profile — not merely "create when project.json is
 * missing". Every `murmur start` runs this, so an interrupted or partially deleted
 * profile is completed even though `project.json` already exists.
 *
 * NON-DESTRUCTIVE: an existing `agent-config.json` is never rewritten with a new
 * identity, and an operator's own runtime settings are preserved. Only safely derivable
 * missing pieces are repaired (agent directory, one role's identity, a pairing edge, a
 * generated runtime field, a capability advertisement).
 *
 * CONTRADICTORY OR UNSAFE stored state fails closed with `invalid-profile:<reason>`
 * instead of being silently rewritten.
 */
export const bootstrapProfile = async ({
  projectId,
  projectPath,
  paths,
  natsUrl = DEFAULT_NATS_URL,
  natsToken = undefined,
  agents = DEFAULT_AGENTS,
  edges = DEFAULT_TRUST_EDGES,
  now = () => new Date().toISOString(),
}) => {
  const alreadyBootstrapped = await exists(paths.projectFile);

  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.agentsDir);
  await ensurePrivateDirectory(paths.runDir);
  await ensurePrivateDirectory(paths.logsDir);

  // An existing profile is validated BEFORE anything is repaired: unsafe or
  // contradictory persisted state must stop the operator, not be rewritten.
  const existingProject = alreadyBootstrapped
    ? validateProfile(await readPrivateJson(paths.projectFile), paths)
    : null;
  const effectiveNatsUrl = existingProject?.natsUrl || natsUrl;
  const effectiveToken = existingProject?.natsToken ?? natsToken;

  const configs = new Map();
  const createdAgents = [];
  const repairs = [];

  for (const agent of agents) {
    const configPath = paths.agentConfigFile(agent.name);
    if (await exists(configPath)) {
      const existing = await readPrivateJson(configPath);
      const applied = reconcileIdentityConfig(agent, existing, {
        projectId,
        projectPath,
        paths,
        codexSocketPath: paths.codexSocket,
      });
      if (applied.length > 0) repairs.push(...applied);
      configs.set(agent.name, { config: existing, dirty: applied.length > 0 });
      continue;
    }
    // Missing agent directory and/or identity for an expected role: recreate only that.
    await ensurePrivateDirectory(paths.agentDir(agent.name));
    const config = await createIdentityConfig(agent, {
      projectId,
      projectPath,
      paths,
      natsUrl: effectiveNatsUrl,
      natsToken: effectiveToken,
      codexSocketPath: paths.codexSocket,
    });
    configs.set(agent.name, { config, dirty: true });
    createdAgents.push(agent.name);
    if (alreadyBootstrapped) repairs.push(`identity:${agent.name}`);
  }

  // Pairing is derived from the public halves on disk, so a re-run repairs a missing or
  // stale edge without ever touching a private key.
  const blobs = new Map(agents.map((agent) => [agent.name, advertiseBlob(agent, configs.get(agent.name).config)]));
  for (const agent of agents) {
    const entry = configs.get(agent.name);
    const config = entry.config;
    config.peers = config.peers && typeof config.peers === "object" ? config.peers : {};
    for (const peerName of peersForAgent(agent.name, edges)) {
      const blob = blobs.get(peerName);
      if (!blob) continue;
      const desired = peerEntryFrom(blob);
      if (JSON.stringify(config.peers[blob.agentId]) !== JSON.stringify(desired)) {
        config.peers[blob.agentId] = desired;
        entry.dirty = true;
        if (alreadyBootstrapped) repairs.push(`pairing:${agent.name}->${peerName}`);
      }
    }
  }

  // Only the identities that actually changed are rewritten, so an untouched
  // agent-config.json stays byte-for-byte identical across a repair.
  for (const agent of agents) {
    const entry = configs.get(agent.name);
    if (entry.dirty) await writePrivateJson(paths.agentConfigFile(agent.name), entry.config);
  }

  const project = {
    version: PROFILE_VERSION,
    projectId,
    projectPath,
    createdAt: existingProject?.createdAt || now(),
    natsUrl: effectiveNatsUrl,
    ...(effectiveToken ? { natsToken: effectiveToken } : {}),
    coordinator: COORDINATOR,
    // No `command`: the executable comes from the canonical discovery chain in
    // `codex.mjs`. Set `command` to an absolute path or binary name to override it.
    // `{endpoint}` expands to the canonical `unix:///<socket>` endpoint.
    codexAppServer: existingProject?.codexAppServer || { args: [...DEFAULT_CODEX_APP_SERVER_ARGS] },
    agents: agents.map((agent) => ({
      name: agent.name,
      agentId: agentIdFor(projectId, agent.name),
      role: agent.role,
      runtimeKind: agent.runtimeKind,
      memberSlot: agent.memberSlot,
      handoff: agent.handoff,
      required: agent.required,
      enabled: existingProject?.agents?.find((a) => a.name === agent.name)?.enabled ?? true,
      dataDir: paths.agentDir(agent.name),
    })),
    trustEdges: edges.map((edge) => [...edge]),
  };

  if (!alreadyBootstrapped || JSON.stringify(existingProject) !== JSON.stringify(project)) {
    await writePrivateJson(paths.projectFile, project);
    if (alreadyBootstrapped && JSON.stringify(existingProject) !== JSON.stringify(project)) {
      repairs.push("project-metadata");
    }
  }

  return {
    created: !alreadyBootstrapped,
    repaired: alreadyBootstrapped && repairs.length > 0,
    createdAgents,
    repairs,
    project,
  };
};


// ---------------------------------------------------------------------------
// Persisted-profile containment
// ---------------------------------------------------------------------------
//
// `project.json` is operator-controlled state, but it is NOT trusted for anything that
// decides where Murmur writes or what it executes. A tampered or hand-broken profile
// must fail closed with a stable `invalid-profile:<reason>` instead of redirecting an
// agent's data directory, log file or argv.

/** The fixed v1 role set. A persisted agent name outside this set is refused. */
export const SUPPORTED_ROLES = Object.freeze(DEFAULT_AGENTS.map((agent) => agent.name));

export class InvalidProfileError extends Error {
  constructor(reason, detail = null) {
    super(`invalid-profile:${reason}${detail ? `:${detail}` : ""}`);
    this.name = "InvalidProfileError";
    this.reason = reason;
    this.detail = detail;
  }
}

const refuse = (reason, detail) => {
  throw new InvalidProfileError(reason, detail);
};

/**
 * A persisted agent name may only be one of the fixed roles. Log files, data
 * directories and supervised child names are all derived from this validated value, so
 * a separator, a traversal segment, a control character or an empty name can never
 * reach the filesystem.
 */
export const assertSafeRole = (name) => {
  if (typeof name !== "string" || !name) refuse("agent-name-empty");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) refuse("agent-name-unsafe", JSON.stringify(name).slice(0, 40));
  if (!SUPPORTED_ROLES.includes(name)) refuse("agent-name-unsupported", name);
  return name;
};

/**
 * Containment anchored to the CANONICAL PROFILE ROOT.
 *
 * Comparing `realpath(target)` against `realpath(someManagedParent)` is not enough: if
 * `<profile>/agents` is itself a symlink to `/tmp/external`, both sides resolve outside
 * together and the comparison happily succeeds. So containment is proven against the
 * canonical profile root, and the descent from it is walked component by component —
 * an intermediate managed directory that is a symlink is refused outright, whether it
 * is `agents`, `logs`, `run`, or an individual agent directory.
 *
 * Paths that do not exist yet are fine: every EXISTING ancestor is checked, and the
 * remaining components are validated textually against the canonical root. This is
 * ordinary local-user safety, not a TOCTOU-proof guarantee.
 */
export const canonicalProfileRoot = (profileRoot) => {
  const resolved = path.resolve(profileRoot);
  try {
    return realpathSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT") return resolved; // nothing exists yet to redirect through
    refuse("profile-root-unreadable", err?.code || "realpath-failed");
    return resolved;
  }
};

export const assertWithinProfile = (target, profileRoot, reason) => {
  if (typeof target !== "string" || !target) refuse(reason, "empty");
  const textualRoot = path.resolve(profileRoot);
  const resolvedTarget = path.resolve(target);

  // 1. Textual containment: catches `..` escapes and absolute paths elsewhere.
  const relative = path.relative(textualRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) refuse(reason, "outside-profile-root");

  // 2. Walk the descent from the CANONICAL root. Any managed component that is a
  //    symlink is refused — it could redirect the whole subtree outside the profile.
  const realRoot = canonicalProfileRoot(profileRoot);
  let current = realRoot;
  for (const segment of relative.split(path.sep).filter((part) => part && part !== ".")) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (err) {
      if (err?.code === "ENOENT") return current; // not created yet; ancestors were clean
      refuse(reason, err?.code || "stat-failed");
      return current;
    }
    if (stats.isSymbolicLink()) refuse(reason, "symlink");
  }

  // 3. Belt and braces: the fully resolved path must still be under the canonical root.
  try {
    const realTarget = realpathSync(current);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) refuse(reason, "symlink-escape");
  } catch (err) {
    if (err instanceof InvalidProfileError) throw err;
    if (err?.code !== "ENOENT") refuse(reason, err?.code || "realpath-failed");
  }
  return current;
};

/**
 * Containment for a RUNTIME ENDPOINT LEAF — today, exactly `run/codex.sock`.
 *
 * The real Codex App Server does not create a socket AT the pathname it is given: it
 * materialises that pathname as a SYMLINK to its own socket under `/private/tmp/codex-daemon-*`.
 * That is legitimate, and it is the App Server's runtime property, not a profile-containment
 * failure — so the leaf is the one component allowed to be a symlink.
 *
 * Everything else is unchanged and just as strict:
 *
 *   - the whole ANCESTOR chain (profile root -> run) still gets `assertWithinProfile`, so a
 *     managed directory replaced by a symlink is still refused outright;
 *   - the leaf name must still be textually inside the profile;
 *   - a leaf that is NOT a symlink must still resolve inside the canonical profile root.
 *
 * Whether the alias actually points at a live socket is a RUNTIME HEALTH question, answered by
 * `probeUnixSocket` (status/doctor), never by profile validation. Murmur also never treats the
 * alias target as part of its managed tree: it may unlink its own alias, never the target.
 */
export const assertEndpointWithinProfile = (target, profileRoot, reason) => {
  if (typeof target !== "string" || !target) refuse(reason, "empty");
  const resolved = path.resolve(target);

  // 1. The ancestor chain is held to the FULL managed-containment standard.
  assertWithinProfile(path.dirname(resolved), profileRoot, reason);

  // 2. The leaf itself must still be textually inside the profile.
  const relative = path.relative(path.resolve(profileRoot), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) refuse(reason, "outside-profile-root");

  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (err) {
    if (err?.code === "ENOENT") return resolved; // not created yet: normal before start
    refuse(reason, err?.code || "stat-failed");
    return resolved;
  }
  // 3a. A symlink here is the App Server's endpoint alias. Accepted, and NOT followed for
  //     containment: the target is runtime-owned and deliberately outside the profile.
  if (stats.isSymbolicLink()) return resolved;

  // 3b. A non-symlink leaf under a symlink-free parent chain cannot escape — prove it anyway.
  try {
    const realRoot = canonicalProfileRoot(profileRoot);
    const realRelative = path.relative(realRoot, realpathSync(resolved));
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) refuse(reason, "symlink-escape");
  } catch (err) {
    if (err instanceof InvalidProfileError) throw err;
    if (err?.code !== "ENOENT") refuse(reason, err?.code || "realpath-failed");
  }
  return resolved;
};

/** Back-compat alias: containment is always anchored to the profile root now. */
export const assertContained = (target, root, reason) => assertWithinProfile(target, root, reason);

const assertPlainString = (value, reason) => {
  if (typeof value !== "string" || !value.trim()) refuse(reason, "empty");
  if (/[\u0000-\u001f]/.test(value)) refuse(reason, "control-character");
  return value;
};

/**
 * Validate a loaded profile against the paths it claims to own. Throws
 * `InvalidProfileError` for anything contradictory or unsafe; INCOMPLETE state (a
 * missing identity, a missing pairing edge, a missing runtime field) is not an error
 * here — `bootstrapProfile` repairs that.
 */
export const validateProfile = (project, paths) => {
  if (!project || typeof project !== "object") refuse("not-an-object");
  if (project.version !== PROFILE_VERSION) refuse("version-unsupported", String(project.version));
  if (!Array.isArray(project.agents) || project.agents.length === 0) refuse("agents-missing");
  assertPlainString(project.projectId, "project-id");
  assertPlainString(project.projectPath, "project-path");
  if (path.basename(path.resolve(paths.root)) !== project.projectId) refuse("project-id-mismatch");

  const seen = new Set();
  for (const agent of project.agents) {
    const role = assertSafeRole(agent?.name);
    if (seen.has(role)) refuse("agent-duplicated", role);
    seen.add(role);
    if (agent.agentId !== agentIdFor(project.projectId, role)) refuse("agent-id-mismatch", role);
    // The data dir is the only profile-sourced path that decides where Murmur writes.
    assertWithinProfile(agent.dataDir, paths.root, `agent-data-dir:${role}`);
    if (path.resolve(agent.dataDir) !== path.resolve(paths.agentDir(role))) refuse("agent-data-dir-unexpected", role);
  }

  for (const required of DEFAULT_AGENTS.filter((agent) => agent.required)) {
    if (!seen.has(required.name)) refuse("required-agent-missing", required.name);
  }
  const disabledRequired = project.agents.filter((agent) => agent.required && agent.enabled === false);
  if (disabledRequired.length > 0) refuse("required-agent-disabled", disabledRequired.map((agent) => agent.name).join(","));

  if (project.coordinator !== undefined) assertSafeRole(project.coordinator);
  for (const edge of project.trustEdges || []) {
    if (!Array.isArray(edge) || edge.length !== 2) refuse("trust-edge-malformed");
    edge.forEach((name) => assertSafeRole(name));
  }

  // Run state, logs and the Codex socket are derived from the project id, never from
  // persisted text — but a managed directory could still have been REPLACED by a
  // symlink on disk, so every one of them is proven against the canonical profile root.
  assertWithinProfile(paths.agentsDir, paths.root, "agents-dir");
  assertWithinProfile(paths.runDir, paths.root, "run-dir");
  assertWithinProfile(paths.logsDir, paths.root, "logs-dir");
  // The Codex socket is a RUNTIME ENDPOINT, not a managed directory: its ancestors are held to
  // the same strict standard, but the leaf may be the App Server's own symlink alias.
  assertEndpointWithinProfile(paths.codexSocket, paths.root, "codex-socket");
  for (const role of SUPPORTED_ROLES) assertWithinProfile(paths.logFile(role), paths.root, `log-file:${role}`);
  for (const role of SUPPORTED_ROLES) assertWithinProfile(paths.agentDir(role), paths.root, `agent-dir:${role}`);

  const spec = project.codexAppServer;
  if (spec !== undefined) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) refuse("codex-app-server-malformed");
    if (spec.command !== undefined) assertPlainString(spec.command, "codex-app-server-command");
    if (spec.args !== undefined) {
      if (!Array.isArray(spec.args)) refuse("codex-app-server-args-malformed");
      spec.args.forEach((arg, index) => assertPlainString(arg, `codex-app-server-arg-${index}`));
    }
  }
  return project;
};

export const loadProfile = async (paths) => validateProfile(await readPrivateJson(paths.projectFile), paths);

export const profileExists = (paths) => exists(paths.projectFile);

export const enabledAgents = (project) => project.agents.filter((agent) => agent.enabled !== false);

export const agentByName = (project, name) => project.agents.find((agent) => agent.name === name) || null;

/** Redacted profile summary — never returns key material or a NATS token. */
export const publicProfileSummary = (project) => ({
  version: project.version,
  projectId: project.projectId,
  projectPath: project.projectPath,
  createdAt: project.createdAt,
  natsUrl: project.natsUrl,
  natsTokenConfigured: Boolean(project.natsToken),
  coordinator: project.coordinator,
  agents: project.agents.map(({ name, agentId, role, runtimeKind, memberSlot, handoff, enabled }) => ({
    name, agentId, role, runtimeKind, memberSlot, handoff, enabled: enabled !== false,
  })),
  trustEdges: project.trustEdges,
});
