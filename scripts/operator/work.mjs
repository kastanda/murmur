/**
 * work.mjs — the operator's view of ACTIVE WORK, and safe per-task cancellation.
 *
 *   murmur tasks  <project> [--json]
 *   murmur task   <project> <workflow-id> [--json]
 *   murmur cancel <project> <workflow-id> [--json]
 *
 * WHAT A "TASK" IS. One operator task is ONE root request — the message `murmur send`
 * (or the menu bar's send action) enqueued. Every descendant handoff belongs to it; the
 * chain Root → Claude → Codex → Cursor → Codex → Claude → Root is ONE task. The workflow
 * id IS the root message id: the same id every handoff already carries as
 * `rootMessageId`, so a task stays traceable through root message, handoffs, replies and
 * the final result without any second identifier or database.
 *
 * WHERE THE TRUTH IS. Nothing here is stored. The view is RECONSTRUCTED, read-only, from
 * the durable records the runtime already keeps in each agent's own database:
 *
 *   root task / final reply      root `local_messages` (+ `outbox`)
 *   pending handoff / waiting    `agent_handoffs` (open | closed | terminal) in the delegator's db
 *   queued / active turn         `wake_dispatch` (+ `runtime_bindings` liveness) in the recipient's db
 *   cancel intent                `workflow_control` (see workflow-control.mjs)
 *
 * so it survives restarts and cannot drift from what the runtime would do.
 *
 * STATES (only ones the records can distinguish):
 *   queued           accepted durably; no agent execution has started
 *   running          an agent's turn of this workflow is executing and its runtime binding is live
 *   waiting          nothing is executing right now but work is outstanding (a parent waits for a
 *                    child, or a runtime that owned the turn is not live — flagged `stalled`)
 *   cancel_requested the operator asked; a turn of the workflow is still executing
 *   cancelled        terminal: intent recorded and no turn of the workflow is executing
 *   completed        the correlated final root reply exists
 *   failed           terminal failure with no reply
 *
 * `cancelled` is derived, never stored, and monotonic: once the intent exists every gate
 * refuses new work for the workflow, so a cancelled workflow can never become active again.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "../notify-activity.mjs";
import {
  PROVIDER_REASONS, availabilityFile, readAvailabilityRecords, resolveAvailability,
} from "../provider-availability.mjs";
import { readUsageCache, usageCacheFile } from "../provider-usage.mjs";
import { usageIdentities } from "./usage.mjs";
import {
  IGNORED_DUE_TO_CANCELLED_WORKFLOW, isValidWorkflowId, recordCancelRequest,
} from "../workflow-control.mjs";
import { agentByName, enabledAgents, loadProfile, profileExists } from "./profile.mjs";
import { locateProject, murmurHome } from "./project.mjs";

export const WORK_STATES = Object.freeze({
  queued: "queued", running: "running", waiting: "waiting", cancelRequested: "cancel_requested",
  cancelled: "cancelled", completed: "completed", failed: "failed",
  // The workflow cannot proceed because a provider's quota is authoritatively exhausted. Nothing is
  // running: these are NOT `running`, and no agent is reported as the current executor.
  waitingForProvider: "waiting_for_provider", blockedByProviderQuota: "blocked_by_provider_quota",
});
const PROVIDER_WAIT_STATES = new Set(["waiting_for_provider", "blocked_by_provider_quota"]);
const PROVIDER_LABEL = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const LIVE_BINDING_STATES = new Set(["BOUND_IDLE", "CLAIMED", "WAKING", "RUNNING"]);
const EXECUTING_DISPATCH = new Set(["claimed", "dispatched"]);
const WAITING_DISPATCH = new Set(["pending", "deferred", "failed"]);

export const PREVIEW_MAX = 160;
export const RESULT_MAX = 4000;
const RECENT_TERMINAL_KEEP = 5;
const RECENT_WINDOW_MS = 24 * 3600_000;
const SCAN_WINDOW_MS = 7 * 24 * 3600_000;

/** Bounded, redacted, single-line preview of free text (never the whole prompt). */
export const redactedPreview = (text, max = PREVIEW_MAX) => {
  const line = redactSecrets(String(text ?? "")).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Bounded multi-line text for the detail view; redacted, never raw. */
export const redactedBody = (text, max = RESULT_MAX) => {
  const body = redactSecrets(String(text ?? "")).trim();
  return body.length > max ? `${body.slice(0, max - 1)}…` : body;
};

const queryAll = (db, sql, params = []) => {
  try { return db.prepare(sql).all(...params); } catch { return null; }
};

const openReadOnly = (dbPath) => {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=2000;");
    return db;
  } catch {
    return null;
  }
};

const closeQuietly = (db) => { try { db?.close(); } catch { /* already closed */ } };
const asMs = (value) => {
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const maxOf = (values) => values.filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -Infinity);

/** Everything durable the view needs, read once from every agent database (read-only). */
export const collectWorkRecords = ({ project, paths, now = Date.now(), providerStates = {} }) => {
  const agents = enabledAgents(project);
  const nameById = new Map(agents.map((agent) => [agent.agentId, agent.name]));
  const records = { agents, nameById, handoffs: [], waits: [], providerStates, dispatches: [], bindings: new Map(), controls: new Map(), root: null };
  for (const agent of agents) {
    const db = openReadOnly(paths.agentDbFile(agent.name));
    if (!db) continue;
    try {
      for (const row of queryAll(db, `
        SELECT handoff_msg_id AS id, delegator_id AS delegatorId, recipient_id AS recipientId,
               root_message_id AS rootId, state, terminal_reason AS terminalReason,
               task_text AS taskText, created_at AS createdAt, closed_at AS closedAt
          FROM agent_handoffs`) || []) records.handoffs.push(row);
      for (const row of queryAll(db, `
        SELECT wait_id AS id, workflow_id AS workflowId, provider, intended_recipient_id AS recipientId,
               wait_reason AS waitReason, state, first_observed_at AS firstObservedAt, resets_at AS resetsAt,
               mandatory, required_capability AS capability
          FROM provider_waits WHERE state = 'waiting'`) || []) records.waits.push(row);
      for (const row of queryAll(db, `
        SELECT msg_id AS msgId, recipient_id AS recipientId, state, attempts, last_error AS lastError, next_attempt_at AS nextAttemptAt,
               created_at AS createdAt, updated_at AS updatedAt, claimed_at AS claimedAt,
               owner_binding_id AS ownerBindingId,
               json_extract(payload_json, '$.from') AS sender,
               json_extract(payload_json, '$.replyToMessageId') AS replyTo,
               json_extract(payload_json, '$.handoff.rootMessageId') AS rootId
          FROM wake_dispatch WHERE created_at > ? OR state IN ('pending','claimed','dispatched','deferred','failed')`,
      [now - SCAN_WINDOW_MS]) || []) {
        records.dispatches.push({ ...row, agent: agent.name });
      }
      const bindingRows = queryAll(db, `
        SELECT binding_id AS bindingId, state, last_heartbeat AS lastHeartbeat, lease_ttl_ms AS leaseTtlMs
          FROM runtime_bindings WHERE agent_id = ?`, [agent.agentId]) || [];
      for (const row of bindingRows) {
        const fresh = Number.isFinite(Number(row.lastHeartbeat)) && now - Number(row.lastHeartbeat) <= Number(row.leaseTtlMs || 30_000);
        records.bindings.set(row.bindingId, { agent: agent.name, live: LIVE_BINDING_STATES.has(row.state) && fresh });
      }
      // The EARLIEST recorded intent wins (the same row is written to every agent database).
      for (const row of queryAll(db, "SELECT root_message_id AS id, requested_at AS at FROM workflow_control") || []) {
        const previous = records.controls.get(row.id);
        if (previous === undefined || Number(row.at) < previous) records.controls.set(row.id, Number(row.at));
      }
    } finally {
      closeQuietly(db);
    }
  }
  const root = agentByName(project, "root");
  const coordinator = agentByName(project, project.coordinator || "claude");
  const rootDb = root ? openReadOnly(paths.agentDbFile(root.name)) : null;
  if (rootDb && coordinator) {
    try {
      const tasks = queryAll(rootDb, `
        SELECT msg_id AS msgId, created_at AS createdAt, text, conversation_id AS conversationId
          FROM local_messages
         WHERE direction = 'outbound' AND reply_to_message_id IS NULL AND sender = ?
           AND conversation_id LIKE ?
         ORDER BY rowid DESC LIMIT 200`, [root.agentId, `%:${coordinator.agentId}`]) || [];
      const outbox = new Map((queryAll(rootDb, "SELECT msg_id AS msgId, status FROM outbox") || []).map((r) => [r.msgId, r.status]));
      const replies = new Map();
      for (const reply of queryAll(rootDb, `
        SELECT msg_id AS msgId, reply_to_message_id AS replyTo, sender, text, created_at AS createdAt, conversation_id AS conversationId
          FROM local_messages WHERE direction = 'inbound' AND reply_to_message_id IS NOT NULL
         ORDER BY rowid DESC LIMIT 400`) || []) {
        if (!replies.has(reply.replyTo)) replies.set(reply.replyTo, reply);
      }
      records.root = { agent: root, coordinator, tasks, outbox, replies };
    } finally {
      closeQuietly(rootDb);
    }
  }
  return records;
};

/** Message ids that belong to one workflow: the root message and every handoff under it. */
const workflowMessageIds = (records, rootId) => {
  const ids = new Set([rootId]);
  for (const handoff of records.handoffs) if (handoff.rootId === rootId) ids.add(handoff.id);
  return ids;
};

const agentLabelOf = (records, agentId) => records.nameById.get(agentId) ?? "unknown";

const STAGE = Object.freeze({
  queued: "В очереди",
  request: "Обработка запроса",
  continuation: "Обработка ответа",
  waitingPrefix: "Ожидание ответа",
  cancelling: "Отмена запрошена",
});

/** Build one task's view from the records. Pure — deterministic given `records` and `now`. */
export const buildTask = (records, task, now) => {
  const rootId = task.msgId;
  const coordinatorName = records.root.coordinator.name;
  const ids = workflowMessageIds(records, rootId);
  const handoffs = records.handoffs.filter((h) => h.rootId === rootId).sort((a, b) => a.createdAt - b.createdAt);
  const dispatches = records.dispatches.filter((d) =>
    ids.has(d.msgId) || ids.has(d.replyTo) || d.rootId === rootId);
  const cancelIntent = records.controls.has(rootId);
  const cancelRequestedAt = records.controls.get(rootId);
  const rawReply = records.root.replies.get(rootId) ?? null;
  // A final reply that arrived AFTER the cancel intent is a late delivery: it stays in history
  // but never turns a cancelled task back into a completed one (cancellation is monotonic).
  const replyIsLate = Boolean(rawReply && cancelIntent && asMs(rawReply.createdAt) > cancelRequestedAt);
  const reply = replyIsLate ? null : rawReply;
  const submittedAtMs = asMs(task.createdAt);

  // Executing = a turn of this workflow is assigned to a runtime binding that is LIVE. An old
  // `claimed` row whose runtime died is not "running": it is reported waiting + stalled.
  const executing = dispatches.filter((d) => EXECUTING_DISPATCH.has(d.state));
  const live = executing.filter((d) => records.bindings.get(d.ownerBindingId)?.live === true);
  const outstanding = dispatches.filter((d) => WAITING_DISPATCH.has(d.state) && d.lastError !== IGNORED_DUE_TO_CANCELLED_WORKFLOW);
  const openHandoffs = handoffs.filter((h) => h.state === "open");
  const failedHandoff = handoffs.find((h) => h.state === "terminal" && h.terminalReason && h.terminalReason !== "workflow-cancelled");
  const rootDispatch = dispatches.find((d) => d.msgId === rootId);
  const rootFailed = rootDispatch && ["terminal", "rejected"].includes(rootDispatch.state)
    && rootDispatch.lastError !== IGNORED_DUE_TO_CANCELLED_WORKFLOW;

  // A delegation refused for provider quota (durable `provider_waits`), or a turn/dispatch deferred because
  // its provider is exhausted, makes the workflow WAIT for that provider — never "running".
  const quotaWaits = records.waits.filter((w) => w.workflowId === rootId);
  const quotaDispatch = dispatches.find((d) => d.state === "deferred" && d.lastError === PROVIDER_REASONS.quotaExhausted);
  let providerWait = null;
  if (quotaWaits.length > 0 || quotaDispatch) {
    const w = quotaWaits[0] ?? null;
    const provider = w?.provider ?? quotaDispatch.agent;
    const stateRow = records.providerStates?.[provider] ?? null;
    const resetMs = w?.resetsAt != null ? Number(w.resetsAt) : asMs(stateRow?.resetsAt);
    providerWait = {
      provider,
      state: Number.isFinite(resetMs) ? WORK_STATES.waitingForProvider : WORK_STATES.blockedByProviderQuota,
      firstObservedAt: iso(w ? Number(w.firstObservedAt) : Number(quotaDispatch?.updatedAt)),
      resetsAt: iso(resetMs),
      resetsInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null,
      intendedRecipient: w ? agentLabelOf(records, w.recipientId) : quotaDispatch.agent,
      mandatory: Boolean(w && Number(w.mandatory) === 1),
      workflowId: rootId,
    };
  }

  let status;
  if (reply) status = WORK_STATES.completed;
  // `cancel_requested` only while a turn of this workflow is genuinely executing on a LIVE runtime;
  // a `claimed` row whose runtime is gone executes nothing, so the workflow is cancelled.
  else if (cancelIntent) status = live.length > 0 ? WORK_STATES.cancelRequested : WORK_STATES.cancelled;
  else if (rootFailed || (failedHandoff && live.length === 0 && outstanding.length === 0 && openHandoffs.length === 0)) status = WORK_STATES.failed;
  else if (providerWait && live.length === 0) status = providerWait.state;
  else if (live.length > 0) status = WORK_STATES.running;
  else if (executing.length > 0 || openHandoffs.length > 0 || handoffs.length > 0
    || (rootDispatch && !WAITING_DISPATCH.has(rootDispatch.state))) status = WORK_STATES.waiting;
  else status = WORK_STATES.queued;
  const stalled = !reply && !cancelIntent && live.length === 0 && executing.length > 0;

  // Who is working RIGHT NOW: the agent executing a turn; else the agent the workflow is
  // waiting on (the open child's recipient / the pending dispatch's agent); else the coordinator.
  const currentDispatch = live[0] ?? executing[0] ?? outstanding[outstanding.length - 1] ?? null;
  const waitedOn = openHandoffs[openHandoffs.length - 1] ?? null;
  const currentAgent = currentDispatch?.agent
    ?? (waitedOn ? agentLabelOf(records, waitedOn.recipientId) : coordinatorName);
  const currentMessageId = currentDispatch?.msgId ?? waitedOn?.id ?? rootId;

  const handoffOfCurrent = handoffs.find((h) => h.id === currentDispatch?.msgId);
  let currentStage;
  if (status === WORK_STATES.queued) currentStage = STAGE.queued;
  else if (status === WORK_STATES.cancelRequested) currentStage = STAGE.cancelling;
  else if (PROVIDER_WAIT_STATES.has(status)) {
    const label = PROVIDER_LABEL[providerWait.provider] ?? providerWait.provider;
    currentStage = status === WORK_STATES.waitingForProvider ? `Ожидает лимита ${label}` : `Заблокировано: лимит ${label} исчерпан`;
  } else if (handoffOfCurrent) currentStage = redactedPreview(handoffOfCurrent.taskText, 60);
  else if (currentDispatch?.replyTo) currentStage = STAGE.continuation;
  else if (status === WORK_STATES.waiting && waitedOn) currentStage = `${STAGE.waitingPrefix} ${agentLabelOf(records, waitedOn.recipientId)}`;
  else if (TERMINAL_STATES.has(status)) currentStage = null;
  else currentStage = STAGE.request;

  const chain = [{ from: "root", to: coordinatorName }, ...handoffs.map((h) => ({
    from: agentLabelOf(records, h.delegatorId), to: agentLabelOf(records, h.recipientId), state: h.state,
  }))];

  const activityTimes = [
    submittedAtMs,
    ...dispatches.flatMap((d) => [Number(d.updatedAt), Number(d.claimedAt)]),
    ...handoffs.flatMap((h) => [Number(h.createdAt), Number(h.closedAt)]),
    reply ? asMs(reply.createdAt) : NaN,
    cancelIntent ? cancelRequestedAt : NaN,
  ];
  const lastActivityMs = maxOf(activityTimes);
  const startedMs = dispatches.map((d) => Number(d.claimedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const endedMs = reply ? asMs(reply.createdAt) : (TERMINAL_STATES.has(status) ? lastActivityMs : null);
  const elapsedMs = Number.isFinite(submittedAtMs) ? Math.max(0, (endedMs ?? now) - submittedAtMs) : null;

  let lastActivity;
  if (reply) lastActivity = "Получен итоговый ответ";
  else if (status === WORK_STATES.cancelled) lastActivity = "Задача отменена пользователем";
  else if (status === WORK_STATES.cancelRequested) lastActivity = "Запрошена отмена, текущий шаг завершается";
  else if (PROVIDER_WAIT_STATES.has(status)) lastActivity = currentStage;
  else if (status === WORK_STATES.failed) lastActivity = rootDispatch?.lastError ? redactedPreview(rootDispatch.lastError, 100) : (failedHandoff?.terminalReason ?? "Сбой выполнения");
  else if (handoffs.length > 0) lastActivity = `${agentLabelOf(records, handoffs[handoffs.length - 1].delegatorId)} → ${agentLabelOf(records, handoffs[handoffs.length - 1].recipientId)}`;
  else lastActivity = status === WORK_STATES.queued ? "Принята, ожидает исполнителя" : "Выполняется";

  const active = [WORK_STATES.queued, WORK_STATES.running, WORK_STATES.waiting, WORK_STATES.cancelRequested,
    WORK_STATES.waitingForProvider, WORK_STATES.blockedByProviderQuota].includes(status);
  return {
    workflowId: rootId,
    rootMsgId: rootId,
    status,
    stalled,
    submittedAt: iso(submittedAtMs),
    startedAt: iso(startedMs),
    elapsedMs,
    requestSummary: redactedPreview(task.text),
    // Nobody is executing a task that waits for a provider: no agent is reported as active for it.
    currentAgent: TERMINAL_STATES.has(status) || PROVIDER_WAIT_STATES.has(status) ? null : currentAgent,
    ...(providerWait && PROVIDER_WAIT_STATES.has(status) ? { providerWait } : {}),
    currentStage,
    currentMessageId: TERMINAL_STATES.has(status) ? null : currentMessageId,
    chain,
    lastActivityAt: iso(lastActivityMs),
    lastActivity,
    cancellable: [WORK_STATES.queued, WORK_STATES.running, WORK_STATES.waiting,
      WORK_STATES.waitingForProvider, WORK_STATES.blockedByProviderQuota].includes(status),
    active,
    _reply: reply,
    _messageIds: [...ids],
  };
};

const stripPrivate = ({ _reply, _messageIds, active, ...task }) => task;

/** The whole snapshot: summary counts + active tasks (+ a few recent finished ones). */
export const buildWorkSnapshot = (records, { projectName, now = Date.now() } = {}) => {
  const all = (records.root?.tasks ?? [])
    .filter((task) => {
      const submitted = asMs(task.createdAt);
      return !Number.isFinite(submitted) || now - submitted <= SCAN_WINDOW_MS;
    })
    .map((task) => buildTask(records, task, now));
  const active = all.filter((task) => task.active).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const recent = all
    .filter((task) => !task.active && now - Date.parse(task.lastActivityAt ?? 0) <= RECENT_WINDOW_MS)
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, RECENT_TERMINAL_KEEP);
  const count = (state) => active.filter((task) => task.status === state).length;
  return {
    project: projectName,
    observedAt: iso(now),
    summary: {
      active: count("running") + count("waiting") + count("cancel_requested"),
      queued: count("queued"),
      running: count("running"),
      waiting: count("waiting"),
      waitingForProvider: count("waiting_for_provider") + count("blocked_by_provider_quota"),
      cancelRequested: count("cancel_requested"),
    },
    tasks: active.map(stripPrivate),
    recent: recent.map(stripPrivate),
  };
};

export const detailFor = (records, workflowId, now = Date.now()) => {
  const task = (records.root?.tasks ?? []).find((t) => t.msgId === workflowId);
  if (!task) return null;
  const view = buildTask(records, task, now);
  return {
    ...stripPrivate(view),
    request: redactedBody(task.text),
    result: view._reply ? redactedBody(view._reply.text) : null,
  };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const WORK_USAGE = `murmur tasks / task / cancel — active work

Usage:
  murmur tasks  <project> [--json]
  murmur task   <project> <workflow-id> [--json]
  murmur cancel <project> <workflow-id> [--json]

One task = one root request; every handoff under it belongs to it. \`cancel\` stops ONLY that
workflow: it records a durable intent that refuses all further work for it and interrupts the
turn executing right now (one claude child / one Codex turn / one ACP session). It never stops
the project, another agent or another task.

Exit codes: 0 ok (idempotent), 1 usage, 2 unknown workflow, 3 no profile, 4 already finished.
`;

/** Effective availability of each provider from DURABLE state only (never probes). */
const cachedProviderStates = async ({ env, now, project }) => {
  try {
    const usage = await readUsageCache(usageCacheFile(env, os.homedir()));
    const identities = usageIdentities({ project, env });
    const records = readAvailabilityRecords(availabilityFile(env, os.homedir()), identities);
    const states = {};
    for (const name of ["claude", "codex", "cursor"]) {
      const u = usage[name] ?? null;
      const r = resolveAvailability({ provider: name, usage: u && identities[name] && u.identity !== identities[name] ? null : u, record: records[name] ?? null, now });
      states[name] = { availability: r.availability, resetsAt: r.resetsAt };
    }
    return states;
  } catch {
    return {};
  }
};

const loadProjectContext = async ({ projectArg, env, home }) => {
  const { projectPath, paths } = locateProject(projectArg, { home: home ?? murmurHome(env) });
  if (!(await profileExists(paths))) return { error: "no-profile" };
  const project = await loadProfile(paths);
  if (!project.agents.some((a) => a.name === "root") || !agentByName(project, project.coordinator || "claude")) return { error: "no-root-coordinator-pair" };
  return { project, paths, projectPath };
};

const humanDuration = (ms) => {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м ${String(s % 60).padStart(2, "0")}с`;
  return `${Math.floor(m / 60)}ч ${String(m % 60).padStart(2, "0")}м`;
};

export const commandWork = async ({ command, args, flags, out, err, env = process.env, home = undefined, now = Date.now() }) => {
  const projectArg = args[0];
  const emit = (value) => out(JSON.stringify(value, null, 2));
  const ctx = await loadProjectContext({ projectArg, env, home }).catch((error) => ({ error: error.message }));
  if (ctx.error) {
    if (flags.json) emit({ ok: false, reason: ctx.error });
    else err(`murmur: ${ctx.error === "no-profile" ? "no profile for this project. Run `murmur start <project>` first." : ctx.error}`);
    return 3;
  }
  const { project, paths, projectPath } = ctx;
  const projectName = path.basename(projectPath);
  const records = collectWorkRecords({ project, paths, now, providerStates: await cachedProviderStates({ env, now, project }) });

  if (command === "tasks") {
    const snapshot = buildWorkSnapshot(records, { projectName, now });
    if (flags.json) { emit(snapshot); return 0; }
    out(`Project: ${projectName}`);
    out(`Active: ${snapshot.summary.active}   Queued: ${snapshot.summary.queued}`);
    for (const task of [...snapshot.tasks, ...snapshot.recent]) {
      out(`${task.status.padEnd(16)} ${humanDuration(task.elapsedMs).padEnd(9)} ${(task.currentAgent ?? "-").padEnd(7)} ${task.workflowId}  ${task.requestSummary}`);
    }
    return 0;
  }

  const workflowId = args[1];
  if (!workflowId || !isValidWorkflowId(workflowId)) {
    if (flags.json) emit({ ok: false, reason: "workflow-id-invalid" }); else { err("murmur: a valid <workflow-id> is required"); err(WORK_USAGE); }
    return 1;
  }

  if (command === "task") {
    const detail = detailFor(records, workflowId, now);
    if (!detail) {
      if (flags.json) emit({ ok: false, reason: "unknown-workflow", workflowId }); else err("murmur: unknown workflow for this project");
      return 2;
    }
    if (flags.json) { emit({ project: projectName, task: detail }); return 0; }
    out(`${detail.status}  ${detail.workflowId}`);
    out(`Request: ${detail.request}`);
    out(`Agent: ${detail.currentAgent ?? "-"}  Stage: ${detail.currentStage ?? "-"}  Elapsed: ${humanDuration(detail.elapsedMs)}`);
    out(`Chain: ${detail.chain.map((c) => `${c.from} → ${c.to}`).join(", ")}`);
    if (detail.result) out(`Result: ${detail.result}`);
    return 0;
  }

  // cancel
  const detail = detailFor(records, workflowId, now);
  const fail = (code, reason, extra = {}) => {
    if (flags.json) emit({ ok: false, reason, workflowId, ...extra }); else err(`murmur: ${reason}`);
    return code;
  };
  if (!detail) return fail(2, "unknown-workflow");
  if (detail.status === "completed" || detail.status === "failed") return fail(4, "already-terminal", { status: detail.status });
  if (detail.status === "cancelled" || detail.status === "cancel_requested") {
    // Idempotent: the intent already exists (re-applied to every db is harmless and heals a
    // db that was unavailable the first time).
  }
  const messageIds = workflowMessageIds(records, workflowId);
  let newlyRequested = false;
  let retired = 0;
  const failures = [];
  let attempted = 0;
  for (const agent of enabledAgents(project)) {
    const dbPath = paths.agentDbFile(agent.name);
    if (!existsSync(dbPath)) continue;
    attempted += 1;
    let db;
    try {
      db = new DatabaseSync(dbPath);
      const result = recordCancelRequest(db, workflowId, { messageIds: [...messageIds], now });
      newlyRequested = newlyRequested || result.newlyRequested;
      retired += result.retiredDispatches;
    } catch (error) {
      failures.push(`${agent.name}:${error?.message || "write-failed"}`);
    } finally {
      closeQuietly(db);
    }
  }
  // The intent must be in EVERY agent database for every gate to see it. A partial write is NOT
  // reported as success: the intent is idempotent, so the operator simply retries.
  if (failures.length > 0) return fail(1, failures.length === attempted ? "cancel-not-recorded" : "cancel-partially-recorded", { detail: failures });
  const after = detailFor(collectWorkRecords({ project, paths, now, providerStates: await cachedProviderStates({ env, now, project }) }), workflowId, now);
  const result = {
    ok: true,
    workflowId,
    status: after?.status ?? "cancel_requested",
    alreadyRequested: !newlyRequested,
    retiredQueuedDispatches: retired,
    // An operator/runtime status — never text attributed to an agent.
    systemResult: "Задача отменена пользователем.",
  };
  if (flags.json) emit(result);
  else out(`${result.status === "cancelled" ? "Cancelled" : "Cancel requested"}: ${workflowId}${result.alreadyRequested ? " (already requested)" : ""}`);
  return 0;
};
