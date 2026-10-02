import { IGNORED_DUE_TO_CANCELLED_WORKFLOW } from "./workflow-control.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { HANDOFF_REASONS } from "@murmurv2/core";

import { settleRuntimeTurn } from "./agent-handoff-runtime.mjs";

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
  /** The root workflow of the turn executing right now (null when idle). */
  get activeRootMessageId() { return this.runtime.activeRootMessageId ?? null; }
  /** Interrupt only the current turn; see each runtime's `interruptActiveTurn`. */
  interruptActiveTurn(options) { return this.runtime.interruptActiveTurn?.(options) ?? false; }
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

/**
 * Codex continuation guard. The Unix-socket identity IS the external App Server
 * generation: if it changed (or was never captured) the originating thread cannot be
 * trusted to still exist, so the continuation fails closed instead of faking continuity.
 * The numeric in-process generation is checked too, but only the durable socket identity
 * survives a Murmur restart.
 */
export const codexHandoffResumeGuard = ({ continuation, serverGeneration, serverIdentity }) => {
  if (!continuation.originatingRuntimeSessionId) {
    return { ok: false, reason: HANDOFF_REASONS.continuationSessionUnavailable, detail: "no-originating-thread" };
  }
  if (!continuation.originatingServerIdentity || !serverIdentity) {
    return { ok: false, reason: HANDOFF_REASONS.continuationServerGenerationChanged, detail: "server-identity-unknown" };
  }
  if (continuation.originatingServerIdentity !== serverIdentity) {
    return { ok: false, reason: HANDOFF_REASONS.continuationServerGenerationChanged, detail: "server-identity-changed" };
  }
  if (continuation.originatingServerGeneration != null && serverGeneration != null
    && continuation.originatingServerGeneration !== serverGeneration) {
    return { ok: false, reason: HANDOFF_REASONS.continuationServerGenerationChanged, detail: "server-generation-changed" };
  }
  return { ok: true };
};

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
    handoff = null,
    // The RECIPIENT project's model policy, resolved per turn: `async () => ({ model, effort })`
    // (null = no override). Sender identity and message text never reach this — Claude,
    // Cursor and root all get the same Codex policy because it belongs to this project.
    modelPolicy = null,
    // `async ({ threadId, turnId }) => void` — the App Server `turn/interrupt` for exactly one
    // turn. Injected so the adapter never opens its own connection and tests need no server.
    interruptTurn = null,
    // Display-only record of what the App Server reported running; best-effort.
    recordEffective = null,
    readServerIdentity = unixSocketIdentity, threadStore = new CodexConversationThreadStore() }) {
    if (typeof injector !== "function") throw new Error("codex-app-server-adapter-injector-required");
    Object.assign(this, { bindingStore, dispatchStore, agentId, projectId, peer, injector, sendReply,
      now, heartbeatIntervalMs, retryDelayMs, log, handoff, modelPolicy, interruptTurn, recordEffective, readServerIdentity, threadStore });
    this.runtimeKind = CODEX_APP_SERVER_KIND;
    this.memberSlot = CODEX_APP_SERVER_MEMBER_SLOT;
    this.capabilities = RUNTIME_CAPABILITIES[this.runtimeKind];
    this.serverGeneration = 0;
    this.serverIdentity = null;
    this.activeRootMessageId = null;
    this.activeTurn = null;
  }
  /**
   * Per-task interrupt of the ACTIVE turn: `turn/interrupt` for that exact thread + turn id.
   * The App Server, its other threads and every other workflow are untouched. Returns false
   * when no turn id is known yet (the turn has not started) — the cancel intent still stops
   * everything that would follow.
   */
  async interruptActiveTurn() {
    const active = this.activeTurn;
    if (!active?.threadId || !active?.turnId || typeof this.interruptTurn !== "function") return false;
    await this.interruptTurn({ threadId: active.threadId, turnId: active.turnId });
    // The server accepted the interrupt for this exact turn: stop waiting for it locally.
    try { active.abort?.("operator-cancel"); } catch { /* the wait already ended */ }
    return true;
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
    // The external App Server generation/identity must be known BEFORE a continuation is
    // allowed to resume its originating thread.
    const preTurnServerGeneration = this.handoff ? this.refreshServerGeneration() : null;
    const turn = this.handoff
      ? this.handoff.prepareTurn({
        payload,
        binding: this.bindingStore.get(fence.bindingId),
        runtimeKind: this.runtimeKind,
        memberSlot: this.memberSlot,
        serverGeneration: preTurnServerGeneration,
        serverIdentity: this.serverIdentity,
        resumeGuard: codexHandoffResumeGuard,
        fence,
        identity,
      })
      : null;
    if (turn?.rejection) {
      return this.handoff.failClosedTurn({
        turn, dispatch, dispatchStore: this.dispatchStore, bindingStore: this.bindingStore, fence, identity,
      });
    }
    const attempt = { attemptId: randomUUID(), inboundMessageId: identity.msgId,
      recipientId: identity.recipientId, memberSlot: identity.memberSlot,
      runtime: this.runtimeKind, capability: "completed" };
    this.activeRootMessageId = turn?.rootMessageId ?? payload.msgId;
    this.activeTurn = null;
    let handedOff = false;
    try {
      if (this.dispatchStore.beginHandoff(identity, this.now(), attempt) !== 1) throw new Error("codex-app-server-handoff-claim-lost");
      handedOff = true;
      if (this.bindingStore.markRunning(fence, this.now()) !== 1) throw new Error("codex-app-server-running-transition-failed");
      let terminalObserved = false;
      const processing = {
        attemptId: attempt.attemptId,
        // The App Server's own ids for THIS turn, for a scoped `turn/interrupt`. Deliberately
        // NOT `started`: Codex has no processing-started receipt (see RUNTIME_CAPABILITIES).
        observeTurn: ({ sessionId, threadId, abort = null }) => {
          this.activeTurn = { threadId: threadId ?? null, turnId: sessionId ?? null, abort };
        },
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
      // Continuation: resume the EXACT originating Codex thread recorded in the
      // continuation — never a thread derived from the child sender or the derived
      // handoff conversation. Ordinary turns keep per-sender/per-conversation affinity.
      const continuationThreadId = turn?.kind === "continuation" ? turn.resumeSessionId : null;
      const existingSession = continuationThreadId
        ? { threadId: continuationThreadId }
        : this.getSession(payload, serverGeneration);
      const affinityKey = turn?.kind === "continuation"
        ? { from: turn.reply.to, conversationId: turn.reply.conversationId }
        : payload;
      const runtimePeer = { ...this.peer, ...(existingSession ? { threadId: existingSession.threadId } : {}) };
      if (!existingSession) delete runtimePeer.threadId;
      runtimePeer.mode = "codex_app_server";
      let policy = { model: null, effort: null };
      if (typeof this.modelPolicy === "function") {
        try {
          policy = { ...policy, ...(await this.modelPolicy()) };
        } catch (error) {
          this.log("warn", "Codex model policy could not be resolved; running without an override", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (typeof this.modelPolicy === "function") {
        // The project policy is the ONLY source of a model/effort here: a static value in
        // the runtime config must not leak through when the policy says "inherit".
        delete runtimePeer.model;
        delete runtimePeer.effort;
      }
      if (policy.model) {
        runtimePeer.model = policy.model;
        // ...and an explicit project choice outranks a channel persona's model on thread/start.
        runtimePeer.projectModelPolicy = true;
      }
      if (policy.effort) runtimePeer.effort = policy.effort;
      runtimePeer.relayFinalToMurmur = false;
      runtimePeer.returnFinalToCaller = true;
      const turnPayload = turn?.promptText != null ? { ...payload, text: turn.promptText } : payload;
      const result = await this.injector(turnPayload, runtimePeer, processing);
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (this.refreshServerGeneration() !== serverGeneration) {
        const error = new Error("codex-app-server-generation-changed-during-turn");
        error.outcomeUnknown = true;
        throw error;
      }
      if (!terminalObserved) throw new Error("codex-app-server-terminal-completion-unconfirmed");
      const sessionId = runtimePeer.threadId || result?.threadId || null;
      if (!sessionId) throw new Error("codex-app-server-thread-id-missing");
      this.replaceSession(affinityKey, serverGeneration, sessionId);
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (typeof this.recordEffective === "function" && result?.effective) {
        // Display-only and never awaited into the fenced path; a failure here is harmless.
        void Promise.resolve().then(() => this.recordEffective({
          model: result.effective.model,
          effort: result.effective.effort ?? null,
          source: result.effectiveSource ?? null,
          threadId: sessionId,
          selection: { model: policy.model ?? "inherit", effort: policy.effort ?? "inherit" },
          observedAt: new Date(this.now()).toISOString(),
        })).catch(() => {});
      }
      return await settleRuntimeTurn({
        runtimeKind: this.runtimeKind,
        dispatchStore: this.dispatchStore,
        bindingStore: this.bindingStore,
        fence,
        identity,
        attempt,
        payload,
        turn,
        coordinator: this.handoff,
        resultText: result?.finalText || "",
        sessionId: result?.turnId || sessionId,
        extraMetadata: { runtimeSessionId: sessionId },
        runtimeSession: {
          runtimeSessionId: sessionId,
          serverGeneration,
          serverIdentity: this.serverIdentity,
        },
        sendReply: this.sendReply,
        log: this.log,
        now: this.now,
      });
    } catch (error) {
      const failure = asError(error);
      this.refreshServerGeneration();
      if (this.bindingStore.validateFence(fence, identity)) {
        if (handedOff && !failure.outcomeUnknown) this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "failed", errorMessage: failure.message }, this.now());
        const row = this.dispatchStore.get(identity);
        const cancelled = Boolean(this.handoff?.isWorkflowCancelled(turn?.rootMessageId ?? payload.msgId));
        this.bindingStore.releaseAssignment(fence, identity, {
          state: cancelled || row?.attempts >= row?.maxAttempts ? "terminal" : "failed",
          reason: cancelled ? IGNORED_DUE_TO_CANCELLED_WORKFLOW : failure.message,
          nextAttemptAt: this.now() + this.retryDelayMs }, this.now());
      }
      return { status: failure.outcomeUnknown ? "unknown" : "failed", error: failure };
    } finally {
      this.activeRootMessageId = null;
      this.activeTurn = null;
    }
  }
  async recoverCompletedReplies() {
    const rows = this.dispatchStore.db.prepare(`SELECT * FROM processing_attempts WHERE runtime=? AND status='completed' AND result_message_id IS NULL ORDER BY completed_at,rowid`).all(this.runtimeKind);
    const recovered = [];
    for (const row of rows) {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
      if (!metadata?.recipient || !metadata?.conversationId || !metadata?.replyToMessageId) continue;
      // A stored result of a CANCELLED workflow is never delivered, however it got stuck.
      if (this.handoff?.isInboundMessageWorkflowCancelled(row.inbound_message_id)) continue;
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
