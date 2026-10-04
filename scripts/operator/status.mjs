/**
 * status.mjs — read-only project runtime status.
 *
 * Reads exactly the counters and binding rows needed to answer "is this project
 * healthy right now"; it never dumps databases, message bodies or identities.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkNats } from "./doctor.mjs";
import { enabledAgents } from "./profile.mjs";
import { OWNED, UNKNOWN, ownedProcessState } from "./proc.mjs";
import { LOCK_FREE, launchGuardReclaimable, launchGuardState, readRunState } from "./runstate.mjs";
import { CODEX_APP_SERVER_CHILD, probeUnixSocket } from "./supervisor.mjs";

const LIVE_BINDING_STATES = new Set(["STARTING", "BOUND_IDLE", "CLAIMED", "WAKING", "RUNNING"]);
// An owner binding in one of these states is doing (or about to do) the work. BOUND_IDLE /
// OFFLINE / STOPPED / absent mean nobody is working on the row, whatever the row still says.
const WORKING_BINDING_STATES = new Set(["CLAIMED", "WAKING", "RUNNING"]);
// A `claimed` row that has no owner yet (not yet dispatched) is in flight only briefly. An unowned
// `dispatched` row has no fence to prove anything and is never active.
const UNOWNED_CLAIM_GRACE_MS = 10 * 60_000;
const PENDING_DISPATCH_STATES = new Set(["pending", "deferred", "failed"]);

const queryAll = (db, sql, params = []) => {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return null;
  }
};

/** Per-agent durable state. Returns `null` when the daemon has never written a store. */
export const readAgentRuntimeState = (dbPath, agentId, { now = Date.now() } = {}) => {
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    return { error: err?.message || "database-open-failed" };
  }
  try {
    db.exec("PRAGMA busy_timeout=2000;");
    const bindingRows = queryAll(
      db,
      `SELECT binding_id AS bindingId, runtime_kind AS runtimeKind, member_slot AS memberSlot,
              state, last_heartbeat AS lastHeartbeat, lease_ttl_ms AS leaseTtlMs, pid, task_id AS taskId,
              metadata_json AS metadataJson
         FROM runtime_bindings WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 8`,
      [agentId],
    ) || [];
    const bindings = bindingRows.map(({ metadataJson, ...row }) => ({
      ...row,
      live: LIVE_BINDING_STATES.has(row.state),
      heartbeatAgeMs: Number.isFinite(Number(row.lastHeartbeat)) ? now - Number(row.lastHeartbeat) : null,
      heartbeatFresh: Number.isFinite(Number(row.lastHeartbeat))
        ? now - Number(row.lastHeartbeat) <= Number(row.leaseTtlMs || 30_000)
        : false,
      // Set once at `ClaudeOneShotRuntime.start()` / recorded the same way by every other
      // runtime kind's own `metadata`; never a secret (permission mode, model, effort).
      metadata: metadataJson ? JSON.parse(metadataJson) : null,
    }));

    // `active` is work some runtime is verifiably doing NOW. A `claimed`/`dispatched` row whose
    // owner is gone or idle is `unretired`: an internal record that outlived its runtime
    // (crash, restart, a turn whose outcome was never reconciled). It is reported, never
    // presented as active operator work. `byState` stays the raw row count by state.
    const dispatchRows = queryAll(db, "SELECT state, COUNT(*) AS n FROM wake_dispatch GROUP BY state") || [];
    const dispatch = { active: 0, pending: 0, unretired: 0, byState: {} };
    for (const row of dispatchRows) {
      dispatch.byState[row.state] = Number(row.n);
      if (PENDING_DISPATCH_STATES.has(row.state)) dispatch.pending += Number(row.n);
    }
    const heldRows = queryAll(
      db,
      `SELECT d.msg_id AS msgId, d.state AS dispatchState, d.owner_binding_id AS ownerBindingId, d.updated_at AS updatedAt,
              d.owner_generation AS ownerGeneration, d.fencing_token AS fencingToken, d.fencing_epoch AS fencingEpoch,
              b.state AS bindingState, b.last_heartbeat AS lastHeartbeat, b.lease_ttl_ms AS leaseTtlMs,
              b.runtime_generation AS bindingGeneration, b.lease_token AS bindingToken,
              b.fencing_epoch AS bindingEpoch, b.last_assigned_message_id AS bindingMessageId
         FROM wake_dispatch d LEFT JOIN runtime_bindings b ON b.binding_id = d.owner_binding_id
        WHERE d.state IN ('claimed', 'dispatched')`,
    ) || [];
    for (const row of heldRows) {
      const owned = row.ownerBindingId != null;
      // The row is only "being worked" if the binding still holds THIS row's fence: same
      // generation, lease token and epoch, and this message as its current assignment. A binding
      // that is RUNNING a later message (higher token) does not make an older row active.
      const fenceHolds = owned
        && row.ownerGeneration != null && Number(row.ownerGeneration) === Number(row.bindingGeneration)
        && row.fencingToken != null && Number(row.fencingToken) === Number(row.bindingToken)
        && row.fencingEpoch != null && Number(row.fencingEpoch) === Number(row.bindingEpoch)
        && row.bindingMessageId === row.msgId;
      const working = owned
        ? fenceHolds
          && WORKING_BINDING_STATES.has(row.bindingState)
          && Number.isFinite(Number(row.lastHeartbeat))
          && now - Number(row.lastHeartbeat) <= Number(row.leaseTtlMs || 30_000)
        : row.dispatchState === "claimed" && Number.isFinite(Number(row.updatedAt)) && now - Number(row.updatedAt) <= UNOWNED_CLAIM_GRACE_MS;
      if (working) dispatch.active += 1;
      else dispatch.unretired += 1;
    }

    const handoffRows = queryAll(db, "SELECT COUNT(*) AS n FROM agent_handoffs WHERE state = 'open'");
    const openContinuations = handoffRows ? Number(handoffRows[0]?.n ?? 0) : null;

    return { bindings, dispatch, openContinuations };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
};

/**
 * Whole-project status. `includeNats: false` keeps this callable without a broker
 * (used by tests and by `stop`).
 */
export const collectStatus = async ({
  project,
  paths,
  includeNats = true,
  connectImpl,
  socketProbe = probeUnixSocket,
  now = Date.now(),
  readRuntimeState = readAgentRuntimeState,
} = {}) => {
  const state = await readRunState(paths);
  const supervisorRecord = state?.supervisor || null;
  // Three-state ownership, surfaced as-is. `alive` stays strictly `ours`, so an
  // unverifiable process is never displayed — or consumed by the send gate — as running.
  const supervisorOwnership = supervisorRecord ? ownedProcessState(supervisorRecord) : "gone";
  const supervisorAlive = supervisorOwnership === OWNED;

  const children = state?.children || {};
  const agents = enabledAgents(project).map((agent) => {
    const record = children[agent.name] || null;
    const runtime = readRuntimeState(paths.agentDbFile(agent.name), agent.agentId, { now });
    const binding = runtime?.bindings?.find((row) => row.memberSlot === agent.memberSlot && row.live)
      || runtime?.bindings?.[0]
      || null;
    return {
      name: agent.name,
      agentId: agent.agentId,
      role: agent.role,
      memberSlot: agent.memberSlot,
      pid: record?.pid ?? null,
      alive: record ? ownedProcessState(record) === OWNED : false,
      ownership: record ? ownedProcessState(record) : "gone",
      childState: record?.state ?? "not-started",
      logFile: record?.logFile ?? paths.logFile(agent.name),
      binding: binding
        ? {
          state: binding.state,
          runtimeKind: binding.runtimeKind,
          memberSlot: binding.memberSlot,
          heartbeatAgeMs: binding.heartbeatAgeMs,
          heartbeatFresh: binding.heartbeatFresh,
        }
        : null,
      dispatch: runtime?.dispatch ?? null,
      openContinuations: runtime?.openContinuations ?? null,
      storeError: runtime?.error ?? null,
    };
  });

  const usesCodex = enabledAgents(project).some((agent) => agent.name === "codex");
  const appServerRecord = children[CODEX_APP_SERVER_CHILD] || null;
  const appServer = usesCodex
    ? {
      pid: appServerRecord?.pid ?? null,
      alive: appServerRecord ? ownedProcessState(appServerRecord) === OWNED : false,
      ownership: appServerRecord ? ownedProcessState(appServerRecord) : "gone",
      socketPath: paths.codexSocket,
      socket: await socketProbe(paths.codexSocket),
      owned: Boolean(appServerRecord),
    }
    : null;

  const nats = includeNats
    ? await checkNats({ natsUrl: project.natsUrl, natsToken: project.natsToken, connectImpl })
    : null;

  const totals = agents.reduce(
    (acc, agent) => ({
      openContinuations: acc.openContinuations + (agent.openContinuations || 0),
      activeDispatch: acc.activeDispatch + (agent.dispatch?.active || 0),
      pendingDispatch: acc.pendingDispatch + (agent.dispatch?.pending || 0),
      unretiredDispatch: acc.unretiredDispatch + (agent.dispatch?.unretired || 0),
    }),
    { openContinuations: 0, activeDispatch: 0, pendingDispatch: 0, unretiredDispatch: 0 },
  );

  // An unresolved launch is its own fail-closed condition, independent of the supervisor
  // record: it means a process was created that Murmur cannot prove anything about.
  const guard = launchGuardState(paths);
  const guardVerdict = guard.state === LOCK_FREE ? { ok: true, reason: null } : launchGuardReclaimable(guard.heldBy);
  const launchGuard = guard.state === LOCK_FREE
    ? null
    : {
      state: guard.state,
      phase: guard.heldBy?.phase ?? null,
      launcherPid: guard.heldBy?.pid ?? null,
      spawnedPid: guard.heldBy?.spawnedPid ?? null,
      supervisorWasSpawned: guard.heldBy?.supervisorWasSpawned ?? null,
      unsafeToReclaim: guard.heldBy?.unsafeToReclaim === true,
      reclaimable: guardVerdict.ok,
      manualRecovery: guardVerdict.manualRecovery === true,
      reason: guardVerdict.reason,
    };

  const problems = [];
  if (launchGuard?.manualRecovery) {
    problems.push(`an unresolved launch left a supervisor (pid ${launchGuard.spawnedPid ?? "unknown"}) that Murmur cannot prove stopped: manual recovery required`);
  } else if (launchGuard && !launchGuard.reclaimable) {
    problems.push(`a launch is in progress or unresolved (${launchGuard.reason || launchGuard.state})`);
  }
  if (supervisorOwnership === UNKNOWN) problems.push("supervisor ownership is unverifiable");
  else if (!supervisorAlive) problems.push("supervisor is not running");
  // A degraded supervisor is deliberately alive: it is holding the project (lock, run state
  // and trusted spawn handles) because it could not prove one of its children gone.
  if (state?.degraded === true) problems.push("the supervisor is in a degraded hold: residual processes are not proven stopped");
  for (const agent of agents) {
    if (agent.ownership === UNKNOWN) problems.push(`${agent.name} daemon ownership is unverifiable`);
    else if (!agent.alive) problems.push(`${agent.name} daemon is not running`);
    else if (!agent.binding && agent.memberSlot) problems.push(`${agent.name} has no runtime binding`);
    else if (agent.binding && !agent.binding.heartbeatFresh) problems.push(`${agent.name} binding heartbeat is stale`);
    if (agent.storeError) problems.push(`${agent.name} store unreadable`);
  }
  if (appServer && (!appServer.alive || !appServer.socket.ok)) problems.push("codex app-server is not accepting connections");
  if (nats && nats.status !== "PASS") problems.push("NATS is unreachable");

  return {
    projectId: project.projectId,
    projectPath: project.projectPath,
    profileRoot: paths.root,
    supervisor: {
      pid: supervisorRecord?.pid ?? null,
      alive: supervisorAlive,
      ownership: supervisorOwnership,
      phase: state?.phase ?? "not-started",
      degraded: state?.degraded === true,
      residual: state?.residual ?? [],
      startedAt: state?.startedAt ?? null,
      error: state?.error ?? null,
    },
    launchGuard,
    nats,
    appServer,
    agents,
    totals,
    healthy: problems.length === 0,
    problems,
  };
};
