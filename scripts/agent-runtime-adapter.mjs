import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { CLAUDE_AUTO_MEMBER_SLOT, CLAUDE_ONE_SHOT_KIND } from "./claude-one-shot-runtime.mjs";
import { CURSOR_ACP_KIND, CURSOR_ACP_MEMBER_SLOT } from "./cursor-acp-runtime.mjs";

export const CODEX_APP_SERVER_KIND = "codex_app_server";
export const CODEX_APP_SERVER_MEMBER_SLOT = "codex:app-server";

const capability = (values) => Object.freeze({
  persistentProcess: false,
  sessionContinuity: false,
  sessionResumeAcrossProcessRestart: false,
  processingStartedReceipt: false,
  processingCompletedReceipt: false,
  cancel: false,
  heartbeatOwnership: false,
  autonomous: true,
  interactive: false,
  ...values,
});

export const RUNTIME_CAPABILITIES = Object.freeze({
  [CLAUDE_ONE_SHOT_KIND]: capability({ sessionContinuity: true,
    sessionResumeAcrossProcessRestart: true, processingCompletedReceipt: true,
    cancel: true, heartbeatOwnership: true }),
  [CODEX_APP_SERVER_KIND]: capability({ sessionContinuity: true,
    processingCompletedReceipt: true,
    heartbeatOwnership: true }),
  [CURSOR_ACP_KIND]: capability({ persistentProcess: true, sessionContinuity: true,
    processingStartedReceipt: true, processingCompletedReceipt: true,
    cancel: true, heartbeatOwnership: true }),
});

class DelegatingRuntimeAdapter {
  constructor({ runtimeKind, memberSlot, runtime }) {
    if (!runtime) throw new Error("agent-runtime-adapter-runtime-required");
    this.runtimeKind = runtimeKind;
    this.memberSlot = memberSlot;
    this.capabilities = RUNTIME_CAPABILITIES[runtimeKind];
    this.runtime = runtime;
  }
  start(options) { return this.runtime.start(options); }
  executeTurn(payload, dispatch) { return this.runtime.executeTurn(payload, dispatch); }
  cancel(options) { return this.capabilities.cancel ? this.runtime.cancel(options) : false; }
  health() { return { runtimeKind: this.runtimeKind, memberSlot: this.memberSlot,
    capabilities: this.capabilities, ...this.runtime.health() }; }
  recoverCompletedReplies() { return this.runtime.recoverCompletedReplies?.() ?? []; }
  shutdown() { return this.runtime.shutdown(); }
}

export class ClaudeOneShotRuntimeAdapter extends DelegatingRuntimeAdapter {
  constructor(runtime) { super({ runtimeKind: CLAUDE_ONE_SHOT_KIND, memberSlot: CLAUDE_AUTO_MEMBER_SLOT, runtime }); }
}

export class CursorAcpRuntimeAdapter extends DelegatingRuntimeAdapter {
  constructor(runtime) { super({ runtimeKind: CURSOR_ACP_KIND, memberSlot: CURSOR_ACP_MEMBER_SLOT, runtime }); }
}

const asError = (value) => value instanceof Error ? value : new Error(String(value));

export const codexConversationKey = (payload) => JSON.stringify([
  String(payload?.from || ""),
  String(payload?.conversationId || ""),
]);

const unixSocketIdentity = (socketPath) => {
  const stat = statSync(socketPath);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}`;
};

export class CodexConversationThreadStore {
  constructor() { this.sessions = new Map(); }
  get(conversationKey, serverGeneration) {
    const session = this.sessions.get(conversationKey);
    return session?.serverGeneration === serverGeneration ? session : null;
  }
  replace(conversationKey, serverGeneration, threadId) {
    const session = { conversationKey, serverGeneration, threadId };
    this.sessions.set(conversationKey, session);
    return session;
  }
  remove(conversationKey) { return this.sessions.delete(conversationKey); }
  invalidateGeneration(serverGeneration) {
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (serverGeneration != null && session.serverGeneration !== serverGeneration) continue;
      this.sessions.delete(key); removed++;
    }
    return removed;
  }
  get size() { return this.sessions.size; }
}

export class CodexAppServerRuntimeAdapter {
  constructor({ bindingStore, dispatchStore, agentId, projectId, peer, injector, sendReply,
    now = () => Date.now(), heartbeatIntervalMs = 5_000, retryDelayMs = 1_000, log = () => {},
    readServerIdentity = unixSocketIdentity, threadStore = new CodexConversationThreadStore() }) {
    if (typeof injector !== "function") throw new Error("codex-app-server-adapter-injector-required");
    Object.assign(this, { bindingStore, dispatchStore, agentId, projectId, peer, injector, sendReply,
      now, heartbeatIntervalMs, retryDelayMs, log, readServerIdentity, threadStore });
    this.runtimeKind = CODEX_APP_SERVER_KIND;
    this.memberSlot = CODEX_APP_SERVER_MEMBER_SLOT;
    this.capabilities = RUNTIME_CAPABILITIES[this.runtimeKind];
    this.serverGeneration = 0;
    this.serverIdentity = null;
  }
  refreshServerGeneration() {
    const socketPath = this.peer?.socketPath || this.peer?.target;
    let identity = null;
    try { identity = this.readServerIdentity(socketPath); } catch { identity = null; }
    if (identity !== this.serverIdentity) {
      const previousGeneration = this.serverGeneration || null;
      const invalidatedSessions = previousGeneration == null
        ? 0 : this.threadStore.invalidateGeneration(previousGeneration);
      this.serverIdentity = identity;
      this.serverGeneration++;
      if (previousGeneration != null) this.log("warn", "Codex app-server generation changed", {
        previousGeneration, serverGeneration: this.serverGeneration, invalidatedSessions, socketPath,
      });
    }
    return this.serverGeneration;
  }
  getSession(payload, serverGeneration = this.serverGeneration) {
    return this.threadStore.get(codexConversationKey(payload), serverGeneration);
  }
  replaceSession(payload, serverGeneration, threadId) {
    return this.threadStore.replace(codexConversationKey(payload), serverGeneration, threadId);
  }
  removeSession(payload) { return this.threadStore.remove(codexConversationKey(payload)); }
  start({ bindingId = randomUUID(), runtimeGeneration = 1, leaseTtlMs = 30_000 } = {}) {
    const socketPath = this.peer?.socketPath || this.peer?.target;
    if (!socketPath) throw new Error("codex-app-server-socket-missing");
    if (!existsSync(socketPath)) throw new Error(`codex-app-server-socket-unavailable:${socketPath}`);
    this.refreshServerGeneration();
    this.bindingId = bindingId;
    this.heartbeatIntervalMs = Math.min(Math.max(1, Number(this.heartbeatIntervalMs) || 1), Math.max(1, Math.floor(leaseTtlMs / 2)));
    const binding = this.bindingStore.register({ bindingId, agentId: this.agentId,
      runtimeKind: this.runtimeKind, runtimeGeneration, projectId: this.projectId,
      memberSlot: this.memberSlot, leaseTtlMs, state: "STARTING",
      metadata: { persistentProcess: false, externalProcess: true } }, this.now());
    const fence = { bindingId, ownerGeneration: binding.runtimeGeneration,
      fencingToken: binding.leaseToken, fencingEpoch: binding.fencingEpoch };
    if (this.bindingStore.markIdle(fence, this.now()) !== 1) throw new Error("codex-app-server-adapter-start-failed");
    this.startHeartbeat();
    return this.bindingStore.get(bindingId);
  }
  startHeartbeat() {
    this.stopHeartbeat();
    const tick = () => {
      const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
      if (!binding || ["OFFLINE", "STALE"].includes(binding.state)) return;
      this.bindingStore.heartbeat({ bindingId: binding.bindingId, ownerGeneration: binding.runtimeGeneration,
        fencingToken: binding.leaseToken, fencingEpoch: binding.fencingEpoch }, this.now());
    };
    tick(); this.heartbeatTimer = setInterval(tick, this.heartbeatIntervalMs); this.heartbeatTimer.unref?.();
  }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  health() {
    const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
    const socketPath = this.peer?.socketPath || this.peer?.target || null;
    const socketPresent = Boolean(socketPath && existsSync(socketPath));
    return { runtimeKind: this.runtimeKind, memberSlot: this.memberSlot, capabilities: this.capabilities,
      healthy: Boolean(socketPresent && binding && !["OFFLINE", "STALE"].includes(binding.state)), binding,
      external: { socketPath, socketPresent, owned: false, serverGeneration: this.serverGeneration,
        conversationSessions: this.threadStore.size } };
  }
  async executeTurn(payload, dispatch) {
    const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
    const fence = this.bindingStore.assignDispatch(identity, { agentId: this.agentId, projectId: this.projectId,
      memberSlot: this.memberSlot, taskId: payload.conversationId }, this.now());
    if (!fence) { this.dispatchStore.defer(dispatch, "codex-app-server-binding-unavailable", this.now() + this.retryDelayMs, this.now()); return { status: "deferred" }; }
    if (this.bindingStore.markWaking(fence, this.now()) !== 1) throw new Error("codex-app-server-waking-transition-failed");
    const attempt = { attemptId: randomUUID(), inboundMessageId: identity.msgId,
      recipientId: identity.recipientId, memberSlot: identity.memberSlot,
      runtime: this.runtimeKind, capability: "completed" };
    let handedOff = false;
    try {
      if (this.dispatchStore.beginHandoff(identity, this.now(), attempt) !== 1) throw new Error("codex-app-server-handoff-claim-lost");
      handedOff = true;
      if (this.bindingStore.markRunning(fence, this.now()) !== 1) throw new Error("codex-app-server-running-transition-failed");
      let terminalObserved = false;
      const processing = {
        attemptId: attempt.attemptId,
        completed: () => {
          if (!this.bindingStore.validateFence(fence, identity)) return { accepted: false, reason: "stale-runtime-fence" };
          terminalObserved = true;
          return { accepted: true, deferredToAdapter: true };
        },
        failed: ({ errorMessage = "codex-app-server-processing-failed" } = {}) => {
          if (!this.bindingStore.validateFence(fence, identity)) return { accepted: false, reason: "stale-runtime-fence" };
          return this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "failed", errorMessage }, this.now());
        },
      };
      const serverGeneration = this.refreshServerGeneration();
      const existingSession = this.getSession(payload, serverGeneration);
      const runtimePeer = { ...this.peer, ...(existingSession ? { threadId: existingSession.threadId } : {}) };
      if (!existingSession) delete runtimePeer.threadId;
      runtimePeer.mode = "codex_app_server";
      runtimePeer.relayFinalToMurmur = false;
      runtimePeer.returnFinalToCaller = true;
      const result = await this.injector(payload, runtimePeer, processing);
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (this.refreshServerGeneration() !== serverGeneration) {
        const error = new Error("codex-app-server-generation-changed-during-turn");
        error.outcomeUnknown = true;
        throw error;
      }
      if (!terminalObserved) throw new Error("codex-app-server-terminal-completion-unconfirmed");
      const sessionId = runtimePeer.threadId || result?.threadId || null;
      if (!sessionId) throw new Error("codex-app-server-thread-id-missing");
      this.replaceSession(payload, serverGeneration, sessionId);
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      const completed = this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "completed",
        sessionId: result?.turnId || sessionId,
        metadata: { resultText: result?.finalText || "", conversationId: payload.conversationId,
          recipient: payload.from, replyToMessageId: payload.msgId, runtimeSessionId: sessionId } }, this.now());
      if (!completed.accepted) throw new Error(`codex-app-server-completion-rejected:${completed.reason}`);
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      this.dispatchStore.markHandedOffIfLatestAttemptCompleted(identity, attempt.attemptId, this.now());
      let reply = null;
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      try {
        reply = await this.sendReply({ msgId: attempt.attemptId, to: payload.from,
          conversationId: payload.conversationId, replyToMessageId: payload.msgId, text: result?.finalText || "" });
        if (this.bindingStore.validateFence(fence, identity)) {
          this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "completed", resultMessageId: reply.msgId }, this.now());
        }
      } catch (error) { this.log("error", "Codex app-server reply enqueue failed after durable completion", { attemptId: attempt.attemptId, error: asError(error).message }); }
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (this.bindingStore.markIdle(fence, this.now()) !== 1) return { status: "late-result-dropped" };
      return { status: reply ? "completed" : "completed-reply-pending", attemptId: attempt.attemptId, reply };
    } catch (error) {
      const failure = asError(error);
      this.refreshServerGeneration();
      if (this.bindingStore.validateFence(fence, identity)) {
        if (handedOff && !failure.outcomeUnknown) this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "failed", errorMessage: failure.message }, this.now());
        const row = this.dispatchStore.get(identity);
        this.bindingStore.releaseAssignment(fence, identity, { state: row?.attempts >= row?.maxAttempts ? "terminal" : "failed",
          reason: failure.message, nextAttemptAt: this.now() + this.retryDelayMs }, this.now());
      }
      return { status: failure.outcomeUnknown ? "unknown" : "failed", error: failure };
    }
  }
  async recoverCompletedReplies() {
    const rows = this.dispatchStore.db.prepare(`SELECT * FROM processing_attempts WHERE runtime=? AND status='completed' AND result_message_id IS NULL ORDER BY completed_at,rowid`).all(this.runtimeKind);
    const recovered = [];
    for (const row of rows) {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
      if (!metadata?.recipient || !metadata?.conversationId || !metadata?.replyToMessageId) continue;
      const reply = await this.sendReply({ msgId: row.attempt_id, to: metadata.recipient,
        conversationId: metadata.conversationId, replyToMessageId: metadata.replyToMessageId, text: metadata.resultText || "" });
      this.dispatchStore.recordProcessingReceipt({ attemptId: row.attempt_id,
        inboundMessageId: row.inbound_message_id, recipientId: row.recipient_id,
        memberSlot: row.member_slot, runtime: this.runtimeKind, status: "completed", resultMessageId: reply.msgId }, this.now());
      recovered.push({ attemptId: row.attempt_id, msgId: reply.msgId });
    }
    return recovered;
  }
  cancel() { return false; }
  shutdown() {
    this.stopHeartbeat(); const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
    return binding ? this.bindingStore.markOffline({ bindingId: binding.bindingId,
      ownerGeneration: binding.runtimeGeneration, fencingToken: binding.leaseToken,
      fencingEpoch: binding.fencingEpoch }, this.now()) : 0;
  }
}
