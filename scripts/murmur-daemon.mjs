#!/usr/bin/env node
/**
 * murmur-daemon.mjs — Persistent agent-to-agent messaging daemon.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { NatsBroker } from "@murmurv2/broker-nats";
import {
  ChannelRosterStore,
  HANDOFF_MAX_ACTIVE_DEPTH,
  HANDOFF_WIRE_VERSION,
  SQLiteDedupeOutboxStore,
  SQLiteMessageStore,
  isHandoffEnvelope,
  isSupportedEnvelope,
  stableAckPayload,
  stableEnvelopePayload,
  validateHandoffEnvelope,
} from "@murmurv2/core";
import { decryptPayload, encryptPayload, signEnvelope, verifyEnvelopeSignature } from "@murmurv2/security";
import { NotifyQueue, flushNotifyQueue } from "./notify-router.mjs";
import { planNotifiesErrors, planNotifiesInbound, resolveNotifyPlan } from "./notify-config.mjs";
import {
  createChannelThreadStartBindingResolver,
  createCodexAppServerDaemonInjector,
  createCodexAppServerInjector,
} from "./codex-app-server-wake.mjs";
import { startJetStreamAdvisoryDlqIfEnabled } from "./murmur-jetstream-advisory.mjs";
import { WakeMonitor, createAuditShellHook, createShellHook, normalizeWakeConfig } from "./wake-monitor.mjs";
import { WakeDispatchStore } from "./wake-dispatch-store.mjs";
import { RuntimeBindingStore } from "./runtime-binding-store.mjs";
import {
  CLAUDE_AUTO_MEMBER_SLOT,
  CLAUDE_ONE_SHOT_KIND,
  ClaudeOneShotRuntime,
} from "./claude-one-shot-runtime.mjs";
import {
  CURSOR_ACP_KIND,
  CURSOR_ACP_MEMBER_SLOT,
  CursorAcpRuntime,
  normalizeCursorAcpRuntimeConfig,
} from "./cursor-acp-runtime.mjs";
import {
  CODEX_APP_SERVER_KIND,
  CODEX_APP_SERVER_MEMBER_SLOT,
  ClaudeOneShotRuntimeAdapter,
  CodexAppServerRuntimeAdapter,
  CursorAcpRuntimeAdapter,
} from "./agent-runtime-adapter.mjs";
import { AgentRuntimeRegistry } from "./agent-runtime-registry.mjs";
import { AgentHandoffStore } from "./agent-handoff-store.mjs";
import { AgentHandoffController, admitInboundHandoff, buildHandoffFailureText } from "./agent-handoff-controller.mjs";
import { HandoffTurnCoordinator } from "./agent-handoff-runtime.mjs";
import { SessionLeaseStore, createNativeLeaseGate } from "./lease.mjs";
import { ensurePrivateDirectory, readPrivateJson, setPrivateUmask } from "./secure-state.mjs";
// vault-guard: optional content policy hook (not included in OSS release)

setPrivateUmask();

const log = (level, msg, data) => {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console.log(JSON.stringify(entry));
};

const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");

let config;
try {
  await ensurePrivateDirectory(dataDir);
  config = await readPrivateJson(configPath);
} catch (err) {
  log("fatal", "Cannot load agent config", { path: configPath, error: err.message });
  log("info", "Run: node scripts/agent-config-init.mjs");
  process.exit(1);
}

const { agentId, natsUrl, natsToken, subject, peers, keys } = config;
const dbPath = path.join(dataDir, "murmur.db");
const flushIntervalMs = Number(process.env.FLUSH_INTERVAL_MS) || 2000;
const jetstreamConfig = config.jetstream || {};
const jetstreamEnabled = jetstreamConfig.enabled ?? process.env.MURMUR_JETSTREAM === "1";
const jetstreamStream = jetstreamConfig.stream || process.env.MURMUR_JETSTREAM_STREAM || "MURMUR";
const jetstreamSubjects = jetstreamConfig.subjects || ["msg.>", "ack.>"];
const streamingConfig = config.streaming || {};
const ackWindowConfig = streamingConfig.ackWindow || {};
const firstDefined = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
const optionalPositiveInteger = (name, value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name}-invalid`);
  return parsed;
};
const jetstreamMaxDeliver = optionalPositiveInteger(
  "jetstream-max-deliver",
  firstDefined(jetstreamConfig.maxDeliver, process.env.MURMUR_JETSTREAM_MAX_DELIVER),
);
const jetstreamAckWaitMs = optionalPositiveInteger(
  "jetstream-ack-wait-ms",
  firstDefined(jetstreamConfig.ackWaitMs, process.env.MURMUR_JETSTREAM_ACK_WAIT_MS),
);
const ackTimeoutMs = optionalPositiveInteger(
  "ack-timeout-ms",
  firstDefined(streamingConfig.ackTimeoutMs, process.env.MURMUR_ACK_TIMEOUT_MS),
) ?? 15_000;
const ackSecurityConfig = config.ackSecurity || {};
const emitSignedAcks = process.env.MURMUR_EMIT_SIGNED_ACKS !== undefined
  ? process.env.MURMUR_EMIT_SIGNED_ACKS !== "0"
  : ackSecurityConfig.emitSigned ?? true;
const requireSignedAcks = process.env.MURMUR_REQUIRE_SIGNED_ACKS !== undefined
  ? process.env.MURMUR_REQUIRE_SIGNED_ACKS === "1"
  : ackSecurityConfig.requireSigned ?? false;
const maxAckAgeMs = optionalPositiveInteger(
  "ack-max-age-ms",
  firstDefined(ackSecurityConfig.maxAgeMs, process.env.MURMUR_ACK_MAX_AGE_MS),
) ?? 5 * 60_000;
const ackWindowEnabled = ackWindowConfig.enabled ?? process.env.MURMUR_STREAM_ACK_WINDOW === "1";
const ackWindow = ackWindowEnabled
  ? {
      maxInFlightChunks: optionalPositiveInteger(
        "stream-max-in-flight-chunks",
        firstDefined(ackWindowConfig.maxInFlightChunks, process.env.MURMUR_STREAM_MAX_IN_FLIGHT_CHUNKS),
      ) ?? 64,
      maxInFlightBytes: optionalPositiveInteger(
        "stream-max-in-flight-bytes",
        firstDefined(ackWindowConfig.maxInFlightBytes, process.env.MURMUR_STREAM_MAX_IN_FLIGHT_BYTES),
      ) ?? 4 * 1024 * 1024,
    }
  : undefined;
// Notification credentials are a MURMUR-USER setting, not per-project state. The plan is
// resolved from the inline `notify` block (the pre-CLI `.data-*` layout), else the global
// $MURMUR_HOME/notifications.json, else the MURMUR_TELEGRAM_* environment fallback — and
// the identity's non-secret `notifications.scope` decides WHICH events reach it, so one
// operator task does not produce one Telegram message per agent in the topology.
// A missing or malformed notification config is never fatal: the bus keeps running.
let notifyPlan = { source: "none", scope: "off", targets: [], global: null };
try {
  notifyPlan = await resolveNotifyPlan({ config, env: process.env });
} catch (err) {
  log("error", "Notification config could not be resolved; continuing without notifications", { error: err.message });
}
if (notifyPlan.source === "invalid") {
  log("warn", "Global notification config is invalid; continuing without notifications", {
    reason: notifyPlan.global?.reason,
  });
}
const effectiveNotifyTargets = notifyPlan.targets;
const notifyInbound = planNotifiesInbound(notifyPlan);
const notifyErrors = planNotifiesErrors(notifyPlan);
const notifyQueue = new NotifyQueue(dbPath);
const wakeDb = new DatabaseSync(dbPath);
const wakeDispatchStore = new WakeDispatchStore(dbPath, {
  maxAttempts: Number(process.env.MURMUR_WAKE_MAX_ATTEMPTS) || 5,
  recipientId: agentId,
});
// This process is the sole owner of its local dispatch ledger. On process start,
// any claimed row belongs to the previous daemon generation and is recoverable
// immediately. Operators may set a positive grace when deliberately overlapping
// daemon generations during a supervised handoff.
const wakeClaimTtlMs = Number(process.env.MURMUR_WAKE_CLAIM_TTL_MS) || 0;
const processingStartedTtlMs = Number(process.env.MURMUR_PROCESSING_STARTED_TTL_MS) || 300_000;
const processingRecovery = wakeDispatchStore.reconcileProcessingAttempts({ startedTtlMs: processingStartedTtlMs });
for (const diagnostic of processingRecovery) {
  if (diagnostic.type === "completed-skip-replay") log("info", "Recovery skipped replay because processing completed", diagnostic);
  else if (diagnostic.type === "started-expired") log("warn", "Processing started receipt expired", diagnostic);
  else if (diagnostic.type === "started-in-flight") log("info", "Processing attempt remains in flight", diagnostic);
  else if (diagnostic.type === "processing-failed") log("warn", "Recovered failed processing attempt", diagnostic);
}
const recoveredWakeClaims = wakeDispatchStore.recoverStaleClaims({
  claimTtlMs: wakeClaimTtlMs,
  processingStartedTtlMs,
});
const backfilledWakeDispatches = wakeDispatchStore.backfillMissingInbound();
const wakeConfig = normalizeWakeConfig(config);
const claudeOneShotConfig = config.runtime?.claudeOneShot || {};
const claudeOneShotEnabled = claudeOneShotConfig.enabled === true;
const claudeProjectId = claudeOneShotConfig.projectId || path.resolve(claudeOneShotConfig.cwd || process.cwd());
const cursorAcpConfig = normalizeCursorAcpRuntimeConfig(config.runtime?.cursorAcp);
const cursorAcpEnabled = cursorAcpConfig.enabled === true;
const codexAppServerRuntimeConfig = config.runtime?.codexAppServer || {};
const codexAppServerRuntimeEnabled = codexAppServerRuntimeConfig.enabled === true;
if ([claudeOneShotEnabled, cursorAcpEnabled, codexAppServerRuntimeEnabled].filter(Boolean).length > 1) {
  throw new Error("only-one-autonomous-runtime-per-daemon");
}
const cursorProjectId = cursorAcpConfig.projectId || path.resolve(cursorAcpConfig.cwd || process.cwd());
const codexProjectId = codexAppServerRuntimeConfig.projectId || path.resolve(codexAppServerRuntimeConfig.cwd || process.cwd());
const runtimeBindingStore = claudeOneShotEnabled || cursorAcpEnabled || codexAppServerRuntimeEnabled ? new RuntimeBindingStore(wakeDb) : null;
if (runtimeBindingStore) {
  if (claudeOneShotEnabled) runtimeBindingStore.expireRoute({ agentId, projectId: claudeProjectId,
    memberSlot: CLAUDE_AUTO_MEMBER_SLOT, runtimeKind: CLAUDE_ONE_SHOT_KIND });
  if (cursorAcpEnabled) runtimeBindingStore.expireRoute({ agentId, projectId: cursorProjectId,
    memberSlot: CURSOR_ACP_MEMBER_SLOT, runtimeKind: CURSOR_ACP_KIND });
  if (codexAppServerRuntimeEnabled) runtimeBindingStore.expireRoute({ agentId, projectId: codexProjectId,
    memberSlot: CODEX_APP_SERVER_MEMBER_SLOT, runtimeKind: CODEX_APP_SERVER_KIND });
  const bindingRecovery = runtimeBindingStore.reconcileStale({ processingStartedTtlMs });
  for (const diagnostic of bindingRecovery) log("warn", "Recovered autonomous runtime binding", diagnostic);
}
if (recoveredWakeClaims > 0) log("warn", "Recovered stale wake dispatch claims", { count: recoveredWakeClaims });
if (backfilledWakeDispatches > 0) log("warn", "Recovered inbound messages missing wake dispatch state", { count: backfilledWakeDispatches });

log("info", "Daemon starting", {
  agentId,
  subject,
  natsUrl,
  dbPath,
  flushIntervalMs,
  jetstreamEnabled,
  jetstreamStream: jetstreamEnabled ? jetstreamStream : undefined,
  jetstreamMaxDeliver,
  jetstreamAckWaitMs,
  ackTimeoutMs,
  ackSecurity: {
    emitSigned: emitSignedAcks,
    requireSigned: requireSignedAcks,
    maxAgeMs: maxAckAgeMs,
  },
  ackWindow,
  notifyTargets: effectiveNotifyTargets.map((t) => `${t.type}:${t.channel}`),
  notifySource: notifyPlan.source,
  notifyScope: notifyPlan.scope,
});

const store = new SQLiteDedupeOutboxStore(dbPath);
const msgStore = new SQLiteMessageStore(dbPath);

// Scoped-channels (#82): native daemon wake becomes a lease-gated fallback. Default OFF
// (backward-compat: no lease -> WakeMonitor behaves exactly as before). Lease lives in its
// own SQLite file (separate WAL) per review.
const scopedChannelsEnabled = config.scopedChannels?.enabled ?? process.env.MURMUR_SCOPED_CHANNELS === "1";
const nativeLeaseTtlMs = Number(process.env.MURMUR_LEASE_TTL_MS) || 20000;
const leaseStore = scopedChannelsEnabled ? new SessionLeaseStore(path.join(dataDir, "lease.db")) : null;
const nativeLeaseGate = leaseStore
  ? createNativeLeaseGate({ store: leaseStore, agentId, ttlMs: nativeLeaseTtlMs, log })
  : null;
if (scopedChannelsEnabled) log("info", "Scoped-channels native lease gate enabled", { ttlMs: nativeLeaseTtlMs });

const channelRosterConfig = config.channelRoster || {};
const channelRosterEnabled = channelRosterConfig.enabled ?? process.env.MURMUR_CHANNEL_ROSTER === "1";
const channelRosterPath = channelRosterConfig.path || process.env.MURMUR_CHANNEL_ROSTER_PATH || path.join(dataDir, "channel-roster.db");
const channelRosterStore = channelRosterEnabled ? new ChannelRosterStore(channelRosterPath) : null;
const threadStartBindingResolver = channelRosterStore
  ? createChannelThreadStartBindingResolver({ rosterStore: channelRosterStore, agentId, log })
  : null;
const codexAppServerInjector = createCodexAppServerInjector({ log, resolveThreadStartBinding: threadStartBindingResolver });
const daemonCodexAppServerInjector = createCodexAppServerDaemonInjector(codexAppServerInjector);
if (channelRosterEnabled) log("info", "Channel roster thread-start binding enabled", { channelRosterPath });
const broker = new NatsBroker({
  url: natsUrl,
  token: natsToken,
  jetstream: jetstreamEnabled,
  stream: jetstreamEnabled ? jetstreamStream : undefined,
  streamSubjects: jetstreamSubjects,
  jetstreamMaxDeliver,
  jetstreamAckWaitMs,
});

const signAck = async (unsignedAck) => ({
  ...unsignedAck,
  signature: await signEnvelope(stableAckPayload(unsignedAck), keys.signing.privateKey),
});

const verifyAck = async (ack) => {
  const peer = peers[ack.senderAgentId];
  if (!peer?.signing?.publicKey) return false;
  return verifyEnvelopeSignature(stableAckPayload(ack), ack.signature, peer.signing.publicKey);
};

const enqueueRuntimeReply = async ({ msgId = randomUUID(), to, conversationId, replyToMessageId, text }) => {
  const peer = peers[to];
  if (!peer) throw new Error(`unknown-reply-recipient:${to}`);
  if (!replyToMessageId) throw new Error("reply-correlation-required");
  const createdAt = new Date().toISOString();
  const encrypted = await encryptPayload(text, peer.encryption.publicKey, keys.encryption.privateKey);
  const envelope = {
    schemaVersion: "1.0",
    msgId,
    conversationId,
    replyToMessageId,
    senderAgentId: agentId,
    recipients: [to],
    createdAt,
    payloadCiphertext: encrypted.ciphertext,
    payloadNonce: encrypted.nonce,
    signature: "",
  };
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), keys.signing.privateKey);
  await store.enqueue(peer.subject, envelope);
  await msgStore.appendIdempotent({
    conversationId,
    msgId,
    replyToMessageId,
    direction: "outbound",
    sender: agentId,
    recipientId: to,
    text,
    createdAt,
    transport: "nats",
  });
  return { msgId };
};

// ---------------------------------------------------------------------------
// Explicit agent handoff (schemaVersion 1.1)
// ---------------------------------------------------------------------------
const handoffConfig = config.handoff || {};
const handoffMaxDepth = optionalPositiveInteger(
  "handoff-max-active-depth",
  firstDefined(handoffConfig.maxActiveDepth, process.env.MURMUR_HANDOFF_MAX_DEPTH),
) ?? HANDOFF_MAX_ACTIVE_DEPTH;

/**
 * BUILD (and sign) the outbound handoff envelope. This performs NO durable writes: the
 * controller inserts the returned envelope into the shared outbox inside the same fenced
 * transaction that creates the continuation, so a runtime that lost its binding fence can
 * never leave a continuation row or an outbound handoff behind.
 *
 * The subject comes from the paired peer config the controller already authorized; a
 * model can never supply a NATS subject.
 */
const buildHandoffEnvelope = async ({ msgId, to, subject, conversationId, handoff, text }) => {
  const peer = peers[to];
  if (!peer) throw new Error(`unknown-handoff-recipient:${to}`);
  if (!subject || subject !== peer.subject) throw new Error(`handoff-subject-not-from-peer-config:${to}`);
  const createdAt = new Date().toISOString();
  const encrypted = await encryptPayload(text, peer.encryption.publicKey, keys.encryption.privateKey);
  const envelope = {
    schemaVersion: HANDOFF_WIRE_VERSION,
    msgId,
    conversationId,
    senderAgentId: agentId,
    recipients: [to],
    createdAt,
    payloadCiphertext: encrypted.ciphertext,
    payloadNonce: encrypted.nonce,
    handoff,
    signature: "",
  };
  // Self-check before signing: never emit an envelope a conformant receiver must refuse.
  // This now also enforces the derived-conversation rule on the emit side.
  const violations = validateHandoffEnvelope(envelope, { maxDepth: handoffMaxDepth });
  if (violations.length > 0) throw new Error(`handoff-envelope-invalid:${violations.join(",")}`);
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), keys.signing.privateKey);
  return { subject: peer.subject, envelope };
};

/** Non-authoritative audit mirror, written only AFTER the fenced commit. Idempotent. */
const recordHandoffAudit = async ({ continuation, envelope }) => {
  await msgStore.appendIdempotent({
    conversationId: continuation.handoffConversationId,
    msgId: continuation.handoffMsgId,
    direction: "outbound",
    sender: agentId,
    recipientId: continuation.recipientId,
    text: continuation.taskText,
    createdAt: envelope.createdAt,
    transport: "nats",
    handoff: envelope.handoff,
  });
  await msgStore.recordEvent({
    msgId: continuation.handoffMsgId,
    conversationId: continuation.handoffConversationId,
    event: "queued",
    actor: agentId,
    detail: `handoff->${continuation.recipientId}`,
    relatesTo: continuation.rootMessageId,
  });
  log("info", "Handoff envelope enqueued", {
    msgId: continuation.handoffMsgId,
    to: continuation.recipientId,
    conversationId: continuation.handoffConversationId,
    rootMessageId: continuation.rootMessageId,
    ancestry: continuation.handoffAncestry,
  });
};

const handoffStore = runtimeBindingStore ? new AgentHandoffStore(wakeDb) : null;
const handoffController = handoffStore
  ? new AgentHandoffController({
    store: handoffStore,
    agentId,
    peers,
    maxDepth: handoffMaxDepth,
    buildHandoffEnvelope,
    recordHandoffAudit,
    log,
  })
  : null;
const handoffCoordinator = handoffController ? new HandoffTurnCoordinator({ controller: handoffController, log }) : null;
if (handoffController) {
  log("info", "Explicit agent handoff enabled", {
    wireVersion: HANDOFF_WIRE_VERSION,
    maxActiveDepth: handoffMaxDepth,
    targets: handoffController.handoffTargets(),
  });
}

/**
 * Exact correlated system failure for a handoff refused deterministically after
 * transport acceptance but before model execution. It is not model success and it is
 * not a new handoff; its msgId is derived from the handoff id so a redelivery or an
 * inbound-backfill replay can never produce a second distinct failure result.
 */
const enqueueHandoffFailureReply = async (payload, { reason, detail = null }) => {
  if (!payload?.msgId || !payload?.from || !payload?.conversationId) return null;
  if (!peers[payload.from]) {
    log("error", "Cannot return handoff failure to an unpaired sender", { msgId: payload.msgId, from: payload.from, reason });
    return null;
  }
  const reply = await enqueueRuntimeReply({
    msgId: `handoff-failed-${payload.msgId}`,
    to: payload.from,
    conversationId: payload.conversationId,
    replyToMessageId: payload.msgId,
    text: buildHandoffFailureText({ reason, detail, handoffMsgId: payload.msgId }),
  });
  log("warn", "Handoff refused before model execution", {
    handoffMsgId: payload.msgId, from: payload.from, reason, detail, replyMsgId: reply.msgId,
  });
  return reply;
};

const durableSafe = (value) => value.replace(/[^A-Za-z0-9_-]/g, "-");

const inboundCursor = () => {
  const row = wakeDb.prepare("SELECT COALESCE(MAX(rowid), 0) as cursor FROM local_messages WHERE direction = 'inbound'").get();
  return Number(row?.cursor ?? 0);
};

const inboundCursorForMsg = (msgId) => {
  const row = wakeDb.prepare("SELECT rowid as cursor FROM local_messages WHERE direction = 'inbound' AND msg_id = ? ORDER BY rowid DESC LIMIT 1").get(msgId);
  return Number(row?.cursor ?? 0);
};

const loadInboundAfter = async (cursor) => {
  const rows = wakeDb
    .prepare(
      `SELECT
         rowid as cursor,
         conversation_id as conversationId,
         msg_id as msgId,
         reply_to_message_id as replyToMessageId,
         member_slot as memberSlot,
         sender as "from",
         text,
         created_at as ts
       FROM local_messages
       WHERE direction = 'inbound' AND rowid > ?
       ORDER BY rowid ASC
       LIMIT 100`,
    )
    .all(cursor);
  return rows.map((row) => ({
    from: row.from,
    text: row.text,
    msgId: row.msgId,
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    ...(row.memberSlot ? { memberSlot: row.memberSlot } : {}),
    conversationId: row.conversationId,
    ts: row.ts,
    cursor: Number(row.cursor),
  }));
};

// Runtime-failure notifications are the one class every scope except `off` receives:
// a worker whose runtime never picked the work up is exactly what the operator has to
// hear about, even though that identity does not notify ordinary inbound traffic.
const enqueueWakeNotification = async (payload, reason) => {
  log("warn", "WakeMonitor fallback notify", { reason, msgId: payload.msgId, from: payload.from });
  if (!notifyErrors) return;
  notifyQueue.enqueueMessage({
    ...payload,
    text: `[WakeMonitor ${reason}] ${payload.text}`,
  }, effectiveNotifyTargets);
};

const claudeOneShotRuntime = claudeOneShotEnabled ? new ClaudeOneShotRuntime({
  bindingStore: runtimeBindingStore,
  dispatchStore: wakeDispatchStore,
  agentId,
  projectId: claudeProjectId,
  cwd: path.resolve(claudeOneShotConfig.cwd || process.cwd()),
  sendReply: enqueueRuntimeReply,
  heartbeatIntervalMs: Number(claudeOneShotConfig.heartbeatIntervalMs) || 5_000,
  turnTimeoutMs: Number(claudeOneShotConfig.turnTimeoutMs) || 300_000,
  terminateGraceMs: Number(claudeOneShotConfig.terminateGraceMs) || 5_000,
  permissionMode: claudeOneShotConfig.permissionMode || "dontAsk",
  model: claudeOneShotConfig.model,
  handoff: handoffCoordinator,
  log,
}) : null;

const cursorAcpRuntime = cursorAcpEnabled ? new CursorAcpRuntime({
  bindingStore: runtimeBindingStore,
  dispatchStore: wakeDispatchStore,
  agentId,
  projectId: cursorProjectId,
  cwd: path.resolve(cursorAcpConfig.cwd || process.cwd()),
  sendReply: enqueueRuntimeReply,
  command: cursorAcpConfig.command || "agent",
  heartbeatIntervalMs: Number(cursorAcpConfig.heartbeatIntervalMs) || 5_000,
  startupTimeoutMs: Number(cursorAcpConfig.startupTimeoutMs) || 30_000,
  turnTimeoutMs: Number(cursorAcpConfig.turnTimeoutMs) || 300_000,
  terminateGraceMs: Number(cursorAcpConfig.terminateGraceMs) || 5_000,
  permissionPolicy: cursorAcpConfig.permissionPolicy || "reject-once",
  mode: cursorAcpConfig.mode || "ask",
  handoff: handoffCoordinator,
  log,
}) : null;
const codexAppServerRuntime = codexAppServerRuntimeEnabled ? new CodexAppServerRuntimeAdapter({
  bindingStore: runtimeBindingStore,
  dispatchStore: wakeDispatchStore,
  agentId,
  projectId: codexProjectId,
  peer: { ...codexAppServerRuntimeConfig, mode: "codex_app_server" },
  injector: daemonCodexAppServerInjector,
  sendReply: enqueueRuntimeReply,
  heartbeatIntervalMs: Number(codexAppServerRuntimeConfig.heartbeatIntervalMs) || 5_000,
  retryDelayMs: Number(codexAppServerRuntimeConfig.retryDelayMs) || 1_000,
  handoff: handoffCoordinator,
  log,
}) : null;

const runtimeRegistry = new AgentRuntimeRegistry([
  ...(claudeOneShotRuntime ? [new ClaudeOneShotRuntimeAdapter(claudeOneShotRuntime)] : []),
  ...(cursorAcpRuntime ? [new CursorAcpRuntimeAdapter(cursorAcpRuntime)] : []),
  ...(codexAppServerRuntime ? [codexAppServerRuntime] : []),
]);
const configuredRuntimeAdapters = runtimeRegistry.adapters();
if (configuredRuntimeAdapters.length > 1) throw new Error("only-one-autonomous-runtime-per-daemon");
const activeRuntimeAdapter = configuredRuntimeAdapters[0] || null;
if (activeRuntimeAdapter) {
  await activeRuntimeAdapter.start({ bindingId: randomUUID(), runtimeGeneration: Date.now(),
    leaseTtlMs: Number((claudeOneShotEnabled ? claudeOneShotConfig
      : cursorAcpEnabled ? cursorAcpConfig : codexAppServerRuntimeConfig).leaseTtlMs) || 30_000 });
  await activeRuntimeAdapter.recoverCompletedReplies();
  log("info", "Autonomous runtime adapter enabled", { runtimeKind: activeRuntimeAdapter.runtimeKind,
    memberSlot: activeRuntimeAdapter.memberSlot, capabilities: activeRuntimeAdapter.capabilities });
}

const wakeMonitor = new WakeMonitor({
  ...wakeConfig,
  initialCursor: inboundCursor(),
  loadBacklogAfter: loadInboundAfter,
  dispatchStore: wakeDispatchStore,
  runtimeDispatcher: activeRuntimeAdapter
    ? (payload, dispatch) => runtimeRegistry.executeTurn(payload, dispatch)
    : null,
  processingStartedTtlMs,
  retry: {
    baseDelayMs: Number(process.env.MURMUR_WAKE_RETRY_BASE_MS) || 1000,
    maxDelayMs: Number(process.env.MURMUR_WAKE_RETRY_MAX_MS) || 30000,
  },
  leaseGate: nativeLeaseGate,
  auditHook: createAuditShellHook({ command: wakeConfig.auditHook, log }),
  hook: createShellHook({
    command: config.onReceive,
    log,
    storePath: dbPath,
    processingReceipts: config.onReceiveProcessingReceipts === "completed" ? "completed" : "none",
  }),
  injector: daemonCodexAppServerInjector,
  onHandoffRejected: enqueueHandoffFailureReply,
  notify: enqueueWakeNotification,
  log,
});

const proxyWakeMonitor = new WakeMonitor({
  ...wakeConfig,
  initialCursor: inboundCursor(),
  auditHook: createAuditShellHook({ command: wakeConfig.auditHook, log }),
  hook: createShellHook({ command: config.proxyOnReceive, log }),
  leaseGate: nativeLeaseGate,
  injector: daemonCodexAppServerInjector,
  notify: enqueueWakeNotification,
  log,
});


const onMessage = async (envelope) => {
  const senderId = envelope.senderAgentId;
  const peer = peers[senderId];

  if (!peer) throw new Error(`unknown-sender:${senderId}`);

  // Structural gate FIRST. A malformed 1.1 envelope has no defined canonical form, so it
  // cannot be authenticated and therefore gets no correlated reply — it is refused at the
  // transport boundary. An unsupported schemaVersion is refused for the same reason.
  if (!isSupportedEnvelope(envelope)) {
    throw new Error(`envelope-unsupported:${String(envelope?.schemaVersion)}`);
  }
  const handoffInbound = isHandoffEnvelope(envelope);

  const sigPayload = stableEnvelopePayload(envelope);
  const valid = await verifyEnvelopeSignature(sigPayload, envelope.signature, peer.signing.publicKey);
  if (!valid) throw new Error(`signature-invalid:${senderId}`);

  const plaintext = await decryptPayload(
    {
      ciphertext: envelope.payloadCiphertext,
      nonce: envelope.payloadNonce,
      senderPublicKey: peer.encryption.publicKey,
    },
    keys.encryption.privateKey,
  );

  const inboundMemberSlot = activeRuntimeAdapter?.memberSlot || null;
  const inboundRow = {
    conversationId: envelope.conversationId,
    msgId: envelope.msgId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    direction: "inbound",
    sender: senderId,
    recipientId: agentId,
    text: plaintext,
    createdAt: envelope.createdAt,
    transport: "nats",
    ...(inboundMemberSlot ? { memberSlot: inboundMemberSlot } : {}),
    ...(handoffInbound ? { handoff: envelope.handoff } : {}),
  };
  const basePayload = {
    from: senderId,
    text: plaintext,
    msgId: envelope.msgId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    conversationId: envelope.conversationId,
    ts: new Date().toISOString(),
    ...(inboundMemberSlot ? { memberSlot: inboundMemberSlot } : {}),
    ...(handoffInbound ? { handoff: envelope.handoff } : {}),
  };

  // The envelope is now authenticated, so a deterministic handoff refusal can be returned
  // as an EXACT correlated failure result instead of silence. No model ever runs.
  //
  // The refusal is recorded in the dispatch ledger BEFORE the audit row is written: inbound
  // backfill rebuilds dispatches from local_messages, so an audit row with no dispatch row
  // could otherwise resurrect a refused handoff after a restart as executable work.
  if (handoffInbound) {
    const admission = admitInboundHandoff({
      envelope,
      localAgentId: agentId,
      maxDepth: handoffMaxDepth,
      hasAutonomousRuntime: Boolean(activeRuntimeAdapter),
    });
    if (!admission.ok) {
      wakeDispatchStore.rejectInbound({ ...basePayload, cursor: 0 }, admission.reason);
      await msgStore.appendIdempotent(inboundRow);
      await msgStore.recordEvent({ msgId: envelope.msgId, conversationId: envelope.conversationId,
        event: "wake_failed", actor: agentId, detail: admission.reason });
      await enqueueHandoffFailureReply(basePayload, admission);
      return;
    }
  }

  await msgStore.append(inboundRow);

  log("info", "Message received", {
    msgId: envelope.msgId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    from: senderId,
    conversationId: envelope.conversationId,
    textLen: plaintext.length,
    ...(handoffInbound ? { handoff: { rootMessageId: envelope.handoff.rootMessageId,
      ancestry: envelope.handoff.ancestry } } : {}),
  });

  const payload = { ...basePayload, cursor: inboundCursorForMsg(envelope.msgId) };

  // Scope `errors` deliberately does NOT notify inbound traffic: coordinator -> worker
  // handoffs and worker -> coordinator results are internal, and the operator already
  // receives the final correlated reply through the root identity.
  if (notifyInbound) {
    notifyQueue.enqueueMessage(payload, effectiveNotifyTargets);
    log("info", "Notifications queued", {
      msgId: envelope.msgId,
      targetCount: effectiveNotifyTargets.length,
    });
  }

  await wakeMonitor.onInbound(payload);
};

let running = true;

const flushLoop = async () => {
  while (running) {
    try {
      wakeMonitor.reconcileProcessingAttempts();
      runtimeBindingStore?.reconcileStale({ processingStartedTtlMs });
      await runtimeRegistry.recoverCompletedReplies();
      if (handoffController) await handoffController.recoverPendingEnqueues();
      await wakeMonitor.drain();
    } catch (err) {
      log("error", "Wake dispatch retry error", { error: err.message });
    }

    try {
      await broker.flushOutbox({ outbox: store, maxAttempts: 5, ackTimeoutMs, ackWindow });
    } catch (err) {
      log("error", "Outbox flush error", { error: err.message });
    }

    try {
      await flushNotifyQueue({ queue: notifyQueue, log, limit: 100 });
    } catch (err) {
      log("error", "Notify flush error", { error: err.message });
    }

    await sleep(flushIntervalMs);
  }
};

const shutdown = async (signal) => {
  log("info", "Shutdown signal received, draining NATS", { signal });
  running = false;
  await runtimeRegistry.cancelAll();
  await runtimeRegistry.shutdownAll();
  try {
    await broker.close();
  } catch (err) {
    log("error", "Broker close error", { error: err.message });
  }
  log("info", "Daemon stopped", { agentId });
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

try {
  await broker.connect();
  log("info", "NATS connected", { url: natsUrl });

  await broker.subscribeWithAck({
    subject,
    consumerId: agentId,
    dedupe: store,
    onMessage,
    ...(emitSignedAcks ? { signAck } : {}),
  });
  log("info", "Subscribed", { subject });

  // Also subscribe to proxy subjects (agents without their own daemon)
  const proxySubjects = (config.proxySubjects || []);
  for (const ps of proxySubjects) {
    const proxyOnMessage = async (envelope, plaintext) => {
      const senderId = envelope.senderAgentId || "unknown";
      // The proxy path has no signed-lineage validation and no autonomous runtime, so a
      // handoff must never be laundered through it as ordinary text.
      if (envelope?.schemaVersion !== "1.0") {
        log("error", "Proxy subject refused a non-1.0 envelope", {
          subject: ps, from: senderId, schemaVersion: String(envelope?.schemaVersion), msgId: envelope?.msgId,
        });
        return;
      }
      log("info", "Proxy message received", { subject: ps, from: senderId, len: plaintext?.length });
      await proxyWakeMonitor.onInbound({
        from: senderId,
        text: plaintext ?? "",
        msgId: envelope.msgId,
        conversationId: envelope.conversationId,
        ts: new Date().toISOString(),
        env: { MURMUR_PROXY_AGENT: ps.replace("msg.", "") },
      });
    };
    await broker.subscribeWithAck({ subject: ps, consumerId: `${agentId}-proxy-${durableSafe(ps)}`, dedupe: store, onMessage: proxyOnMessage });
    log("info", "Subscribed (proxy)", { subject: ps });
  }

  // `store` is a SQLiteDedupeOutboxStore, which also implements AckReceiptStore: ACK nonces
  // are claimed in the same database as the outbox, so replay protection survives a daemon
  // restart. Without this the broker falls back to an in-memory set that forgets everything
  // on exit.
  const ackReceipts = typeof store.claimAckNonce === "function" ? store : undefined;
  await broker.startAckCorrelation({
    outbox: store,
    ackReceipts,
    ackSubject: `ack.${agentId}`,
    consumerId: `${agentId}-ack`,
    verifyAck,
    requireSignedAcks,
    maxAckAgeMs,
    onInvalidAck: (event) => log("warn", "Invalid ACK rejected", event),
  });
  log("info", "ACK correlation started", {
    ackSubject: `ack.${agentId}`,
    emitSignedAcks,
    requireSignedAcks,
    durableAckReplayProtection: Boolean(ackReceipts),
  });
  if (!ackReceipts) {
    log("warn", "ACK replay protection is in-memory only — nonces are forgotten on restart", {
      hint: "use the SQLite store (storePath) so ack_receipts is persisted",
    });
  }
  await startJetStreamAdvisoryDlqIfEnabled({
    broker,
    outbox: store,
    jetstreamEnabled,
    log,
  });

  const pendingNotify = notifyQueue.pendingCount();
  if (pendingNotify > 0) {
    log("info", "Resuming pending notifications", { pendingNotify });
    await flushNotifyQueue({ queue: notifyQueue, log, limit: 250 });
  }

  if (handoffController) {
    const openContinuations = handoffStore.listOpen();
    if (openContinuations.length > 0) {
      log("warn", "Reloaded open handoff continuations", {
        count: openContinuations.length,
        handoffMsgIds: openContinuations.map((row) => row.handoffMsgId),
      });
    }
    const recovered = await handoffController.recoverPendingEnqueues();
    if (recovered.length > 0) log("warn", "Recovered handoff envelopes at startup", { handoffMsgIds: recovered });
  }

  flushLoop();
  log("info", "Daemon ready", { agentId, peers: Object.keys(peers) });
} catch (err) {
  log("fatal", "Daemon startup failed", { error: err.message });
  await runtimeRegistry.cancelAll().catch(() => {});
  await runtimeRegistry.shutdownAll().catch(() => {});
  await broker.close().catch(() => {});
  process.exit(1);
}
