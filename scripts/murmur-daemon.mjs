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
  SQLiteDedupeOutboxStore,
  SQLiteMessageStore,
  stableAckPayload,
  stableEnvelopePayload,
} from "@murmurv2/core";
import { decryptPayload, encryptPayload, signEnvelope, verifyEnvelopeSignature } from "@murmurv2/security";
import { NotifyQueue, flushNotifyQueue, normalizeNotifyTargets } from "./notify-router.mjs";
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
const notifyTargets = normalizeNotifyTargets(config.notify);
const envTelegramFallback = (() => {
  const botToken = process.env.MURMUR_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.MURMUR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.MURMUR_TELEGRAM_TOPIC_ID || process.env.TELEGRAM_TOPIC_ID;
  if (notifyTargets.length > 0 || !botToken || !chatId) return [];
  return [{ type: "telegram", channel: "telegram", botToken, chatId, ...(topicId ? { topicId } : {}) }];
})();
const effectiveNotifyTargets = notifyTargets.length > 0 ? notifyTargets : envTelegramFallback;
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
const runtimeBindingStore = claudeOneShotEnabled ? new RuntimeBindingStore(wakeDb) : null;
if (runtimeBindingStore) {
  runtimeBindingStore.expireRoute({
    agentId,
    projectId: claudeProjectId,
    memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
    runtimeKind: CLAUDE_ONE_SHOT_KIND,
  });
  const bindingRecovery = runtimeBindingStore.reconcileStale({ processingStartedTtlMs });
  for (const diagnostic of bindingRecovery) log("warn", "Recovered Claude one-shot runtime binding", diagnostic);
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
  notifyFallbackFromEnv: envTelegramFallback.length > 0,
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
    text,
    createdAt,
    transport: "nats",
  });
  return { msgId };
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

const enqueueWakeNotification = async (payload, reason) => {
  log("warn", "WakeMonitor fallback notify", { reason, msgId: payload.msgId, from: payload.from });
  if (effectiveNotifyTargets.length === 0) return;
  notifyQueue.enqueueMessage({
    ...payload,
    text: `[WakeMonitor ${reason}] ${payload.text}`,
  }, effectiveNotifyTargets);
};

const claudeOneShotRuntime = runtimeBindingStore ? new ClaudeOneShotRuntime({
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
  log,
}) : null;
if (claudeOneShotRuntime) {
  claudeOneShotRuntime.start({
    bindingId: randomUUID(),
    runtimeGeneration: Date.now(),
    leaseTtlMs: Number(claudeOneShotConfig.leaseTtlMs) || 30_000,
  });
  await claudeOneShotRuntime.recoverCompletedReplies();
  log("info", "Claude one-shot runtime enabled", {
    projectId: claudeProjectId,
    memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
    permissionMode: claudeOneShotConfig.permissionMode || "dontAsk",
  });
}

const wakeMonitor = new WakeMonitor({
  ...wakeConfig,
  initialCursor: inboundCursor(),
  loadBacklogAfter: loadInboundAfter,
  dispatchStore: wakeDispatchStore,
  runtimeDispatcher: claudeOneShotRuntime
    ? (payload, dispatch) => claudeOneShotRuntime.executeTurn(payload, dispatch)
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

  const inboundMemberSlot = claudeOneShotEnabled ? CLAUDE_AUTO_MEMBER_SLOT : null;
  await msgStore.append({
    conversationId: envelope.conversationId,
    msgId: envelope.msgId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    direction: "inbound",
    sender: senderId,
    text: plaintext,
    createdAt: envelope.createdAt,
    transport: "nats",
    ...(inboundMemberSlot ? { memberSlot: inboundMemberSlot } : {}),
  });

  log("info", "Message received", {
    msgId: envelope.msgId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    from: senderId,
    conversationId: envelope.conversationId,
    textLen: plaintext.length,
  });

  const payload = {
    from: senderId,
    text: plaintext,
    msgId: envelope.msgId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    conversationId: envelope.conversationId,
    ts: new Date().toISOString(),
    cursor: inboundCursorForMsg(envelope.msgId),
    ...(inboundMemberSlot ? { memberSlot: inboundMemberSlot } : {}),
  };

  if (effectiveNotifyTargets.length > 0) {
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
      await claudeOneShotRuntime?.recoverCompletedReplies();
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
  await claudeOneShotRuntime?.cancel();
  claudeOneShotRuntime?.shutdown();
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

  flushLoop();
  log("info", "Daemon ready", { agentId, peers: Object.keys(peers) });
} catch (err) {
  log("fatal", "Daemon startup failed", { error: err.message });
  await broker.close().catch(() => {});
  process.exit(1);
}
