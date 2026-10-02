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
import { planNotifiesActivity, planNotifiesErrors, planNotifiesInbound, resolveNotifyPlan } from "./notify-config.mjs";
import {
  buildActivityErrorNotification,
  buildActivityNotification,
  classifyActivity,
  needsRussianSummary,
  redactSecrets,
} from "./notify-activity.mjs";
import { createClaudeSummarizer } from "./notify-summarizer.mjs";
import {
  CodexAppServerClient,
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
  runClaudeOneShot,
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
import { murmurHome, projectPathsFor } from "./operator/project.mjs";
import { discoverClaudeCapabilities } from "./claude-capabilities.mjs";
import { claudeEffortApplies, isSupportedEffort, isSupportedModel, loadClaudePreferences } from "./operator/claude-config.mjs";
import { clearCodexRuntimeCache, loadCodexPreferences, resolveCodexRuntimePolicy, writeCodexRuntimeCache } from "./operator/codex-config.mjs";
import { discoverCodexCapabilities } from "./codex-capabilities.mjs";
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
/**
 * The notification policy is MUTABLE at runtime.
 *
 * `$MURMUR_HOME/notifications.json` is a user-level file that an operator changes with
 * `murmur notify mode ...` while agents are mid-task. Resolving it once at startup meant
 * every such change needed a daemon restart — and restarting a daemon that is holding an
 * open handoff continuation is exactly the thing worth avoiding. So the plan is re-read
 * on a slow timer and swapped atomically; nothing else in the daemon is reconfigured.
 */
let notifyPolicy = {
  targets: notifyPlan.targets,
  inbound: planNotifiesInbound(notifyPlan),
  activity: planNotifiesActivity(notifyPlan),
  errors: planNotifiesErrors(notifyPlan),
  scope: notifyPlan.scope,
  source: notifyPlan.source,
};
const notifyQueue = new NotifyQueue(dbPath);

/** Minimum gap between policy re-reads. A notification policy is not hot-path state. */
const notifyReloadIntervalMs = Number(process.env.MURMUR_NOTIFY_RELOAD_MS) || 30_000;
// The plan above IS the first read, so the timer starts now rather than firing again on
// the very first flush.
let notifyReloadedAt = Date.now();

const reloadNotifyPolicy = async () => {
  if (Date.now() - notifyReloadedAt < notifyReloadIntervalMs) return;
  notifyReloadedAt = Date.now();
  let plan;
  try {
    plan = await resolveNotifyPlan({ config, env: process.env });
  } catch (err) {
    log("error", "Notification policy reload failed; keeping the current policy", { error: err.message });
    return;
  }
  const next = {
    targets: plan.targets,
    inbound: planNotifiesInbound(plan),
    activity: planNotifiesActivity(plan),
    errors: planNotifiesErrors(plan),
    scope: plan.scope,
    source: plan.source,
  };
  // The policy is ALWAYS swapped, not only when the printable summary changed: a rotated
  // bot token keeps the same scope, source and channel list, and comparing only those
  // would leave the daemon posting to a credential the operator has already replaced.
  const changed = next.scope !== notifyPolicy.scope || next.source !== notifyPolicy.source;
  notifyPolicy = next;
  if (!changed) return;
  log("info", "Notification policy reloaded", {
    notifySource: next.source,
    notifyScope: next.scope,
    notifyTargets: next.targets.map((t) => `${t.type}:${t.channel}`),
  });
};

/**
 * What this identity calls itself and its project in a human feed. Both come from the
 * agent config written by `murmur start`; a legacy `.data-*` identity has neither, and is
 * labelled honestly as legacy rather than being attributed to a project it may not be in.
 */
const activityProjectId = typeof config.project?.id === "string" ? config.project.id : null;
// A pre-CLI `.data-*` identity has no project descriptor. The project line is then
// omitted entirely rather than filled with a placeholder presented as a project name.
const activityProjectLabel = typeof config.project?.label === "string" && config.project.label
  ? config.project.label
  : null;

/**
 * The Russian summarizer for long non-Russian agent content.
 *
 * It reuses the `claude` CLI this project is already configured and authenticated with —
 * no new provider, dependency or credential — invoked as one bounded text call with tools
 * disabled. Disabled with MURMUR_ACTIVITY_SUMMARY=0; the feed then keeps its deterministic
 * English excerpt, which is exactly the fallback every failure path already uses.
 *
 * It is NOT configured through $MURMUR_HOME/notifications.json: that file holds the
 * credential and the machine-wide mode, and a rendering detail does not belong beside a
 * secret.
 */
const activitySummaryEnabled = process.env.MURMUR_ACTIVITY_SUMMARY !== "0";
const activitySummaryDebug = process.env.MURMUR_ACTIVITY_SUMMARY_DEBUG === "1";
const activitySummarizer = activitySummaryEnabled
  ? createClaudeSummarizer({
    runner: runClaudeOneShot,
    ...(process.env.MURMUR_ACTIVITY_SUMMARY_MODEL ? { model: process.env.MURMUR_ACTIVITY_SUMMARY_MODEL } : {}),
    ...(Number(process.env.MURMUR_ACTIVITY_SUMMARY_TIMEOUT_MS) > 0
      ? { timeoutMs: Number(process.env.MURMUR_ACTIVITY_SUMMARY_TIMEOUT_MS) }
      : {}),
    cwd: path.resolve(config.runtime?.claudeOneShot?.cwd
      || config.runtime?.codexAppServer?.cwd
      || config.runtime?.cursorAcp?.cwd
      || process.cwd()),
    // A failed summary is an ordinary outcome with a good fallback, not an incident: it
    // stays out of the log unless an operator asked to see it, and it NEVER reaches
    // Telegram, which would turn an observability aid into its own source of noise.
    log: activitySummaryDebug ? log : () => {},
  })
  : null;

/** The delegated task a reply answers, when this identity actually holds it locally. */
const parentTextFor = (replyToMessageId) => {
  if (!replyToMessageId) return null;
  try {
    const row = wakeDb
      .prepare("SELECT text FROM local_messages WHERE msg_id = ? AND direction = 'outbound' ORDER BY rowid DESC LIMIT 1")
      .get(replyToMessageId);
    return row?.text ? String(row.text) : null;
  } catch {
    return null;
  }
};
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

/**
 * The project's Claude model/effort PREFERENCE, resolved ONCE at daemon startup, exactly
 * like every other `runtime.claudeOneShot` setting — and, like them, fixed for the life
 * of this process (see `ClaudeOneShotRuntime`'s constructor doc). A later edit to
 * `claude-preferences.json` is picked up the NEXT time this daemon starts, never by this
 * running one; `murmur claude <project> config` reports that truthfully by comparing the
 * file against this daemon's own recorded binding metadata, not by asking this process.
 *
 * Only a MODERN operator profile has `MURMUR_PROJECT_ID` (set by the supervisor) and a
 * `claude-preferences.json` to read at all; a legacy `.data-claude` identity has neither,
 * so it is completely unaffected by this feature and keeps its exact prior behaviour —
 * no `--model`/`--effort` ever added, same as before this slice existed.
 *
 * Values are validated against the INSTALLED CLI's own discovered capabilities right
 * here, not merely against the preferences file's shape: a model that was supported when
 * selected but is no longer supported by whatever `claude` binary this daemon now finds
 * on PATH must never be silently forwarded to argv (that already-covered failure mode is
 * `is_error: true` buried inside a successful-looking JSON result — see
 * `claude-capabilities.mjs`). An unsupported selection falls back to no override, exactly
 * like `"inherit"`, and is logged so `murmur doctor` has something to point the operator
 * at.
 */
let resolvedClaudeModel;
let resolvedClaudeEffort;
// Whether a valid `claude-preferences.json` governs this project. When one does — including
// an explicit "inherit" — no other source may add a model override.
let claudePreferencesConfigured = false;
// Hoisted so the "claudeRuntimeCacheFile" path is also available where
// `ClaudeOneShotRuntime` is constructed, further below — the opportunistic
// canonical-model cache is a project-scoped, display-only file exactly like
// `claude-preferences.json`, not something worth re-deriving twice.
let claudeProjectPaths;
if (claudeOneShotEnabled) {
  const murmurProjectId = typeof process.env.MURMUR_PROJECT_ID === "string" ? process.env.MURMUR_PROJECT_ID : null;
  if (murmurProjectId) {
    claudeProjectPaths = projectPathsFor(murmurProjectId, { home: murmurHome() });
    const loadedClaudePrefs = await loadClaudePreferences(claudeProjectPaths);
    if (loadedClaudePrefs.state === "configured") {
      claudePreferencesConfigured = true;
      const capabilities = await discoverClaudeCapabilities();
      const { model: selectedModel, effort: selectedEffort } = loadedClaudePrefs.preferences;
      if (isSupportedModel(selectedModel, capabilities)) {
        if (selectedModel !== "inherit") resolvedClaudeModel = selectedModel;
      } else {
        log("warn", "Configured Claude model no longer supported by installed CLI; running without an override", {
          configuredModel: selectedModel,
        });
      }
      if (isSupportedEffort(selectedEffort, capabilities)) {
        if (selectedEffort !== "inherit") {
          if (claudeEffortApplies(resolvedClaudeModel ?? "inherit", selectedEffort, capabilities)) {
            resolvedClaudeEffort = selectedEffort;
          } else {
            log("warn", "Configured Claude effort is not supported by the configured model; running without an effort override", {
              configuredModel: resolvedClaudeModel, configuredEffort: selectedEffort,
            });
          }
        }
      } else {
        log("warn", "Configured Claude effort no longer supported by installed CLI; running without an override", {
          configuredEffort: selectedEffort,
        });
      }
    } else if (loadedClaudePrefs.state === "invalid") {
      log("warn", "Project Claude preferences are invalid; running without an override", { reason: loadedClaudePrefs.reason });
    }
  }
}
// A hand-edited `runtime.claudeOneShot.model` is only a fallback for a profile with no
// preference file (a legacy identity), and it passes the SAME allowlist as a preference:
// an arbitrary string never reaches `claude --model`.
let fallbackClaudeModel;
if (claudeOneShotEnabled && resolvedClaudeModel === undefined && !claudePreferencesConfigured
  && typeof claudeOneShotConfig.model === "string" && claudeOneShotConfig.model && claudeOneShotConfig.model !== "inherit") {
  if (isSupportedModel(claudeOneShotConfig.model, await discoverClaudeCapabilities())) {
    fallbackClaudeModel = claudeOneShotConfig.model;
  } else {
    log("warn", "Configured runtime.claudeOneShot.model is not offered by the installed Claude CLI; running without an override", {
      configuredModel: claudeOneShotConfig.model,
    });
  }
}
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
  notifyTargets: notifyPolicy.targets.map((t) => `${t.type}:${t.channel}`),
  notifySource: notifyPolicy.source,
  notifyScope: notifyPolicy.scope,
  activityProject: activityProjectLabel,
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

/**
 * Build and durably enqueue ONE activity notification.
 *
 * Deliberately NOT awaited by the inbound path. A summary costs a model call, and the
 * inbound handler is on the critical path of actually doing the work: awaiting here would
 * put a multi-second observability call in front of `wakeMonitor.onInbound()` and delay
 * the task itself. So the message is dispatched to the runtime immediately and this runs
 * alongside it.
 *
 * The consequence is that the notification is enqueued ONCE, already final, after the
 * summary has resolved or given up. That is what keeps the durable dedupe honest: the
 * rendered payload is written before it is enqueued, so `activity:<class>:<msgId>` always
 * maps to one row and one Telegram message. A transport retry re-reads that stored row
 * and can never trigger a second model call, and model variation can never produce a
 * second notification.
 */
const enqueueActivityNotification = async ({
  senderId, msgId, replyToMessageId, handoff, text, parentText,
}) => {
  const input = {
    localAgentId: agentId,
    senderId,
    msgId,
    replyToMessageId,
    handoff,
    text,
    parentText,
    projectId: activityProjectId,
    projectLabel: activityProjectLabel,
  };

  // AT MOST ONE model call per event, for whichever half of the render actually needs it.
  //
  //   - a long non-Russian BODY is retold, and the retelling replaces the excerpt;
  //   - otherwise a long non-Russian PARENT is retold, and the retelling becomes the
  //     topic. This is the short-reply case: `Ответ: RELEASE_CHECK_OK` is already perfect,
  //     but the request it answers is English, and without this the feed would head a
  //     Russian conversation with an English line.
  //
  // Never both: two calls would double the cost and latency of an observability aid.
  let summary = null;
  let topicSummary = null;
  let attempted = "none";
  if (activitySummarizer) {
    const event = classifyActivity({ localAgentId: agentId, senderId, replyToMessageId, handoff, projectId: activityProjectId });
    const summarizeFor = needsRussianSummary(text)
      ? { field: "summary", source: text }
      : needsRussianSummary(parentText)
        ? { field: "topicSummary", source: parentText }
        : null;
    if (summarizeFor) {
      // REDACTION FIRST. This is the one point where message content leaves this process
      // tree, so the text handed over is already sanitized — never the original, never
      // sanitized afterwards.
      const produced = await activitySummarizer({
        msgId,
        text: redactSecrets(String(summarizeFor.source ?? "")),
        kind: event.kind,
        from: event.from.label,
        to: event.to.label,
        project: activityProjectLabel,
      });
      if (summarizeFor.field === "summary") summary = produced;
      else topicSummary = produced;
      // Remember that a summary was ASKED FOR even when it did not arrive: "none" and
      // "it timed out" are different diagnoses, and a log that conflates them sends an
      // operator looking at the trigger rule when the budget is what needs tuning.
      attempted = produced ? summarizeFor.field : "failed";
    }
  }

  const activity = buildActivityNotification({ ...input, summary, topicSummary });
  if (!activity) return;
  notifyQueue.enqueueMessage(activity, notifyPolicy.targets);
  log("info", "Activity notification queued", {
    msgId,
    activityKind: activity.activityKind,
    summarized: attempted,
    targetCount: notifyPolicy.targets.length,
  });
};

// Runtime-failure notifications are the one class every scope except `off` receives:
// a worker whose runtime never picked the work up is exactly what the operator has to
// hear about, even though that identity does not notify ordinary inbound traffic.
const enqueueWakeNotification = async (payload, reason) => {
  log("warn", "WakeMonitor fallback notify", { reason, msgId: payload.msgId, from: payload.from });
  if (!notifyPolicy.errors) return;
  // In activity mode this is the ONE technical event a human is shown, and it is rendered
  // like every other feed entry so it reads in the same conversation.
  const rendered = notifyPolicy.activity
    ? buildActivityErrorNotification({
      localAgentId: agentId,
      senderId: payload.from,
      msgId: payload.msgId,
      reason,
      text: payload.text,
      projectId: activityProjectId,
      projectLabel: activityProjectLabel,
    })
    : null;
  notifyQueue.enqueueMessage(rendered ?? {
    ...payload,
    text: `[WakeMonitor ${reason}] ${payload.text}`,
  }, notifyPolicy.targets);
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
  // `resolvedClaudeModel`/`resolvedClaudeEffort` (the project's preference, validated
  // against this installed CLI) take precedence; a hand-edited
  // `claudeOneShotConfig.model` survives only as a validated fallback (see above).
  model: resolvedClaudeModel ?? fallbackClaudeModel,
  effort: resolvedClaudeEffort,
  canonicalModelCacheFile: claudeProjectPaths?.claudeRuntimeCacheFile,
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
/**
 * The project's Codex model/effort policy, resolved PER TURN (Codex applies `model`/`effort`
 * on each `turn/start`, so unlike Claude no restart is needed). Only a modern operator
 * profile has `MURMUR_PROJECT_ID` and a `codex-preferences.json`; anything else, an absent
 * file, or "inherit" sends no override — the prior behaviour exactly. The saved value is
 * re-validated against the live App Server catalog every time, so a model that is no
 * longer offered is never forwarded.
 */
const codexProjectPaths = codexAppServerRuntimeEnabled && typeof process.env.MURMUR_PROJECT_ID === "string"
  ? projectPathsFor(process.env.MURMUR_PROJECT_ID, { home: murmurHome() })
  : null;
if (codexProjectPaths) await clearCodexRuntimeCache(codexProjectPaths).catch(() => {});
const codexModelPolicy = codexProjectPaths ? async () => {
  const loaded = await loadCodexPreferences(codexProjectPaths);
  if (loaded.state === "invalid") {
    log("warn", "Project Codex preferences are invalid; running without an override", { reason: loaded.reason });
    return { model: null, effort: null };
  }
  if (loaded.state !== "configured") return { model: null, effort: null };
  const capabilities = await discoverCodexCapabilities({ override: codexAppServerRuntimeConfig.command ?? null });
  const policy = resolveCodexRuntimePolicy({ preferences: loaded.preferences, capabilities });
  if (policy.reasons.length) {
    log("warn", "Configured Codex model/effort not honoured; running without that override", { reasons: policy.reasons });
  }
  return { model: policy.model, effort: policy.effort };
} : null;
const codexAppServerRuntime = codexAppServerRuntimeEnabled ? new CodexAppServerRuntimeAdapter({
  modelPolicy: codexModelPolicy,
  // Per-task cancel: `turn/interrupt` for one exact thread + turn on the project's App Server.
  interruptTurn: ({ threadId, turnId }) => new CodexAppServerClient({
    socketPath: codexAppServerRuntimeConfig.socketPath || codexAppServerRuntimeConfig.target, timeoutMs: 10_000,
  }).request("turn/interrupt", { threadId, turnId }),
  recordEffective: codexProjectPaths ? (record) => writeCodexRuntimeCache(codexProjectPaths, record) : null,
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

/**
 * Operator per-task cancellation, runtime side. `murmur cancel` only writes a durable
 * intent (see workflow-control.mjs); the gates that refuse new work read it directly. This
 * watcher additionally interrupts the turn that is executing RIGHT NOW when — and only
 * when — it belongs to a cancelled root workflow, using the runtime's own scoped mechanism
 * (one `claude -p` child / one Codex `turn/interrupt` / one ACP `session/cancel`). It never
 * stops the daemon, another agent, or a turn of any other workflow.
 */
if (activeRuntimeAdapter && handoffCoordinator) {
  const interruptedRoots = new Set();
  const watcher = setInterval(async () => {
    try {
      const root = activeRuntimeAdapter.activeRootMessageId;
      if (!root || interruptedRoots.has(root) || !handoffCoordinator.isWorkflowCancelled(root)) return;
      if (await activeRuntimeAdapter.interruptActiveTurn()) {
        interruptedRoots.add(root);
        log("warn", "Active turn interrupted: its workflow was cancelled by the operator", { rootMessageId: root });
      }
    } catch (error) {
      log("warn", "Could not interrupt the active turn of a cancelled workflow", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 1_000);
  watcher.unref?.();
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

  // Three distinct behaviours, in priority order:
  //   `all`      — forward the raw message text (the historical scope, unchanged);
  //   `activity` — render ONE human feed event for this logical message;
  //   `errors`   — nothing here. Coordinator -> worker handoffs and worker -> coordinator
  //                results are internal, and the operator already receives the final
  //                correlated reply through the root identity.
  if (notifyPolicy.inbound) {
    notifyQueue.enqueueMessage(payload, notifyPolicy.targets);
    log("info", "Notifications queued", {
      msgId: envelope.msgId,
      targetCount: notifyPolicy.targets.length,
    });
  } else if (notifyPolicy.activity) {
    // ONE activity event per LOGICAL message, produced HERE — at the recipient, from the
    // message it has just durably stored. Rendering at the sender instead would notify
    // every hop twice (once by each side) and would fire again on every transport retry;
    // the notify queue's durable dedupe key closes the redelivery case on top of that.
    //
    // Not awaited: see `enqueueActivityNotification`. A notification must never sit
    // between an inbound message and the runtime that has to act on it.
    void enqueueActivityNotification({
      senderId,
      msgId: envelope.msgId,
      replyToMessageId: envelope.replyToMessageId ?? null,
      handoff: handoffInbound ? envelope.handoff : null,
      text: plaintext,
      parentText: parentTextFor(envelope.replyToMessageId),
    }).catch((error) => {
      // Observability must not be able to take the bus down.
      log("error", "Activity notification failed", { msgId: envelope.msgId, error: error?.message || String(error) });
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
      await reloadNotifyPolicy();
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
