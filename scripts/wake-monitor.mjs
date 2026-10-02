import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const ensureObject = (value) => (value && typeof value === "object" ? value : {});
const validMode = (mode) => mode === "stateless" || mode === "codex_app_server";

export const normalizeWakeConfig = (config = {}) => {
  const wake = ensureObject(config.wake);
  const dedup = ensureObject(wake.dedup);
  const loopBreaker = ensureObject(wake.loopBreaker);
  const peers = Object.fromEntries(
    Object.entries(ensureObject(wake.peers)).map(([agentId, peer]) => {
      const value = ensureObject(peer);
      const normalized = {
        mode: validMode(value.mode) ? value.mode : undefined,
        socketPath: typeof value.socketPath === "string" && value.socketPath.trim() ? value.socketPath.trim() : undefined,
        threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : undefined,
      };
      if (typeof value.cwd === "string" && value.cwd.trim()) normalized.cwd = value.cwd.trim();
      if (typeof value.model === "string" && value.model.trim()) normalized.model = value.model.trim();
      if (typeof value.murmurRoot === "string" && value.murmurRoot.trim()) normalized.murmurRoot = value.murmurRoot.trim();
      if (typeof value.dataDir === "string" && value.dataDir.trim()) normalized.dataDir = value.dataDir.trim();
      if (typeof value.storePath === "string" && value.storePath.trim()) normalized.storePath = value.storePath.trim();
      if (value.relayFinalToMurmur === true) normalized.relayFinalToMurmur = true;
      // Without this the injector's `peer.resume === false` opt-out is unreachable
      // from a real config: normalization used to drop the field entirely.
      if (typeof value.resume === "boolean") normalized.resume = value.resume;
      // Same story for baseInstructions: the channel binding resolver falls back to
      // `peer.baseInstructions`, so dropping it here makes per-peer role instructions
      // impossible to configure — the only remaining lever is `personaId`, which Codex
      // rejects for anything outside its own `none|friendly|pragmatic` enum.
      if (typeof value.baseInstructions === "string" && value.baseInstructions.trim()) {
        normalized.baseInstructions = value.baseInstructions;
      }
      if (Number.isFinite(Number(value.replyTimeoutMs))) normalized.replyTimeoutMs = Number(value.replyTimeoutMs);
      return [agentId, normalized];
    }),
  );
  return {
    enabled: wake.enabled !== false,
    mode: validMode(wake.mode) ? wake.mode : "stateless",
    peers,
    auditHook: typeof wake.auditHook === "string" && wake.auditHook.trim() ? wake.auditHook.trim() : null,
    dedup: {
      cooldownMs: Number.isFinite(Number(dedup.cooldownMs)) ? Number(dedup.cooldownMs) : 300000,
    },
    loopBreaker: {
      // Permit a normal autonomous dialogue while retaining a production safety
      // ceiling. Deployments can tune the threshold explicitly.
      maxWakes: Number.isFinite(Number(loopBreaker.maxWakes)) ? Number(loopBreaker.maxWakes) : 20,
      windowMs: Number.isFinite(Number(loopBreaker.windowMs)) ? Number(loopBreaker.windowMs) : 60000,
    },
  };
};

export const createShellHook = ({ command, timeoutMs = 10000, baseEnv = process.env, log = () => {}, processingReceipts = "none", storePath = null }) => {
  if (!command) return null;
  const hook = (payload, attempt = null) => new Promise((resolve, reject) => {
    const env = {
      ...baseEnv,
      MURMUR_FROM: payload.from,
      MURMUR_TEXT: payload.text,
      MURMUR_MSG_ID: payload.msgId,
      MURMUR_REPLY_TO_MESSAGE_ID: payload.msgId,
      MURMUR_INBOUND_REPLY_TO_MESSAGE_ID: payload.replyToMessageId || "",
      MURMUR_CONVERSATION_ID: payload.conversationId,
      ...(attempt ? {
        MURMUR_PROCESSING_ATTEMPT_ID: attempt.attemptId,
        MURMUR_PROCESSING_RECIPIENT_ID: attempt.recipientId,
        MURMUR_PROCESSING_MEMBER_SLOT: attempt.memberSlot,
        MURMUR_PROCESSING_RUNTIME: attempt.runtime,
        MURMUR_PROCESSING_RECEIPT_CAPABILITY: attempt.capability,
        MURMUR_STORE_PATH: storePath || baseEnv.MURMUR_STORE_PATH || "",
      } : {}),
      ...(payload.env || {}),
    };
    execFile("sh", ["-c", command], { env, timeout: timeoutMs }, (err) => {
      if (err) {
        log("warn", "wake hook failed", { error: err.message, msgId: payload.msgId });
        reject(err);
        return;
      }
      resolve();
    });
  });
  hook.processingReceipts = processingReceipts;
  hook.runtime = processingReceipts === "completed" ? "llm-hook" : "shell-hook";
  return hook;
};

export const createAuditShellHook = ({ command, timeoutMs = 10000, baseEnv = process.env, log = () => {} }) => {
  if (!command) return null;
  return (payload) => new Promise((resolve) => {
    const env = {
      ...baseEnv,
      MURMUR_FROM: payload.from,
      MURMUR_TEXT: payload.text,
      MURMUR_MSG_ID: payload.msgId,
      MURMUR_INBOUND_REPLY_TO_MESSAGE_ID: payload.replyToMessageId || "",
      MURMUR_CONVERSATION_ID: payload.conversationId,
      ...(payload.env || {}),
    };
    execFile("sh", ["-c", command], { env, timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        log("warn", "wake audit hook failed", { error: err.message, msgId: payload.msgId });
        resolve("deny");
        return;
      }
      const verdict = String(stdout || "").split(/\r?\n/, 1)[0]?.trim();
      resolve(verdict === "deny" || verdict === "require_approval" || verdict === "allow" ? verdict : "deny");
    });
  });
};

export class WakeMonitor {
  constructor(options = {}) {
    const wakeConfig = normalizeWakeConfig({ wake: options });
    this.enabled = options.enabled ?? wakeConfig.enabled;
    this.mode = options.mode ?? wakeConfig.mode;
    this.peers = options.peers ?? wakeConfig.peers;
    this.cooldownMs = options.dedup?.cooldownMs ?? wakeConfig.dedup.cooldownMs;
    this.loopBreaker = {
      maxWakes: options.loopBreaker?.maxWakes ?? wakeConfig.loopBreaker.maxWakes,
      windowMs: options.loopBreaker?.windowMs ?? wakeConfig.loopBreaker.windowMs,
    };
    this.hook = options.hook || null;
    this.injector = options.injector || null;
    this.auditHook = options.auditHook || null;
    this.leaseGate = options.leaseGate || null;
    this.notify = options.notify || null;
    this.loadBacklogAfter = options.loadBacklogAfter || null;
    this.dispatchStore = options.dispatchStore || null;
    this.runtimeDispatcher = options.runtimeDispatcher || null;
    // HANDOFF ONLY: an explicit delegation must never fall back to the legacy wake hook,
    // the stateless inbox, an interactive drain, or a different runtime adapter.
    this.onHandoffRejected = options.onHandoffRejected || null;
    this.retry = {
      maxDelayMs: options.retry?.maxDelayMs ?? 30000,
      baseDelayMs: options.retry?.baseDelayMs ?? 1000,
    };
    this.processingStartedTtlMs = options.processingStartedTtlMs ?? 300_000;
    this.now = options.now || (() => Date.now());
    this.log = options.log || (() => {});
    this.seen = new Map();
    this.senderWindows = new Map();
    this.suspendedSenders = new Map();
    this.queue = [];
    this.queuedKeys = new Set();
    this.processing = false;
    // A request that arrived while a drain was already running; honoured before the drain ends.
    this.drainAgain = false;
    // Daemon mode: the broker's receive handler must only DURABLY ACCEPT a message and return.
    // Running the runtime turn inside it (minutes for a model turn) blocks the receive loop, so
    // the ACK is not sent until the turn ends, the sender re-publishes the same msgId every
    // ack-timeout, and the queued duplicates then draw late duplicate ACKs.
    this.backgroundDrain = options.backgroundDrain === true;
    this.cursor = Number.isFinite(Number(options.initialCursor)) ? Number(options.initialCursor) : 0;
  }

  async onInbound(payload) {
    if (!this.enabled) return;
    if (this.dispatchStore) {
      this.dispatchStore.enqueue(payload, this.now());
      this.advanceCursor(payload);
      if (this.backgroundDrain) this.drainInBackground();
      else await this.drain();
      return;
    }
    this.enqueue(payload);
    if (this.backgroundDrain) this.drainInBackground();
    else await this.drain();
  }

  /** Start (or nudge) the single drain loop without making the caller wait for it. */
  drainInBackground() {
    this.drain().catch((error) => {
      this.log("error", "WakeMonitor background drain failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  enqueue(payload) {
    if (!payload?.msgId) return;
    const key = this.keyFor(payload);
    if (this.queuedKeys.has(key)) return;
    this.queuedKeys.add(key);
    this.queue.push(payload);
  }

  async drain() {
    if (this.processing) {
      // Work arrived mid-drain: make the running loop take another pass instead of dropping it.
      this.drainAgain = true;
      return;
    }
    this.processing = true;
    try {
      do {
        this.drainAgain = false;
        if (this.dispatchStore) {
          while (true) {
            const dispatch = this.dispatchStore.claimDue(this.now());
            if (!dispatch) break;
            await this.processPayload(dispatch.payload, dispatch);
          }
          continue;
        }
        while (true) {
          while (this.queue.length > 0) {
            const payload = this.queue.shift();
            this.queuedKeys.delete(this.keyFor(payload));
            await this.processPayload(payload);
          }

          if (!this.loadBacklogAfter) break;
          const backlog = await this.loadBacklogAfter(this.cursor);
          if (!Array.isArray(backlog) || backlog.length === 0) break;
          for (const payload of backlog) this.enqueue(payload);
        }
      } while (this.drainAgain);
    } finally {
      this.processing = false;
    }
  }

  reconcileProcessingAttempts() {
    if (!this.dispatchStore) return [];
    const now = this.now();
    const diagnostics = this.dispatchStore.reconcileProcessingAttempts({
      now,
      startedTtlMs: this.processingStartedTtlMs,
      retryAt: now,
    });
    for (const diagnostic of diagnostics) {
      if (diagnostic.type === "completed-skip-replay") {
        this.log("info", "WakeMonitor skipped replay because processing completed", diagnostic);
      } else if (diagnostic.type === "started-expired") {
        this.log("warn", "WakeMonitor processing started receipt expired", diagnostic);
      } else if (diagnostic.type === "processing-failed") {
        this.log("warn", "WakeMonitor recovered failed processing attempt", diagnostic);
      }
    }
    return diagnostics;
  }

  async processPayload(payload, dispatch = null) {
    const key = this.keyFor(payload);
    const now = this.now();
    if (!dispatch) {
      this.pruneSeen(now);
      const lastWakeAt = this.seen.get(key);
      if (lastWakeAt !== undefined && now - lastWakeAt < this.cooldownMs) {
        this.advanceCursor(payload);
        this.log("info", "WakeMonitor duplicate dropped", { msgId: payload.msgId, conversationId: payload.conversationId });
        return;
      }
      this.seen.set(key, now);
    }
    if (await this.isLoopBreakerBlocked(payload, now)) {
      if (dispatch) {
        const suspendedUntil = this.suspendedSenders.get(payload.from || "unknown") ?? now;
        this.deferDispatch(dispatch, "loop-breaker-suppressed", now, suspendedUntil);
      }
      else this.advanceCursor(payload);
      return;
    }

    const verdict = await this.audit(payload);
    if (verdict === "deny") {
      this.log("warn", "WakeMonitor audit denied wake", { msgId: payload.msgId, conversationId: payload.conversationId, from: payload.from });
      if (dispatch) this.dispatchStore.reject(dispatch, "audit-denied", now);
      else this.advanceCursor(payload);
      // Audit denial happens BEFORE any model execution; a handoff gets an exact
      // correlated authorization failure instead of silence.
      if (payload.handoff) await this.rejectHandoff(payload, "handoff-unauthorized", "audit-denied");
      return;
    }
    if (verdict === "require_approval") {
      await this.safeNotify(payload, "require_approval");
      this.log("warn", "WakeMonitor audit requires approval", { msgId: payload.msgId, conversationId: payload.conversationId, from: payload.from });
      if (dispatch) this.deferDispatch(dispatch, "audit-requires-approval", now);
      else this.advanceCursor(payload);
      return;
    }

    // Scoped-channels lease gate (#82): the native daemon wake is a fallback owner.
    // If a live chat session already owns this conversation, mute the native wake so it
    // does not spawn a competing thread; otherwise claim and route as the cold-wake owner.
    if (this.leaseGate) {
      let decision;
      try {
        decision = await this.leaseGate(payload, this.peerFor(payload));
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        decision = { allow: false, reason: `lease-gate-error:${e.message}` };
      }
      if (!decision || decision.allow !== true) {
        this.log("info", "WakeMonitor lease mute (non-owner)", {
          msgId: payload.msgId,
          conversationId: payload.conversationId,
          ownerSessionId: decision?.ownerSessionId ?? null,
          reason: decision?.reason ?? "non-owner",
        });
        if (dispatch) this.deferDispatch(dispatch, decision?.reason ?? "lease-deferred", now);
        else this.advanceCursor(payload);
        return;
      }
      payload.leaseToken = decision.token ?? null;
    }

    // Explicit handoff routing: exact locally configured autonomous runtime only.
    if (payload.handoff && !(dispatch && this.runtimeDispatcher)) {
      this.log("error", "WakeMonitor refused handoff without an autonomous runtime", {
        msgId: payload.msgId, from: payload.from, conversationId: payload.conversationId,
        memberSlot: dispatch?.memberSlot ?? null,
      });
      if (dispatch) this.dispatchStore.reject(dispatch, "handoff-runtime-unavailable", now);
      else this.advanceCursor(payload);
      await this.rejectHandoff(payload, "handoff-runtime-unavailable",
        dispatch ? "no-autonomous-runtime-adapter" : "no-durable-dispatch");
      return;
    }

    let processingAttempt = null;
    try {
      if (dispatch && this.runtimeDispatcher) {
        await this.runtimeDispatcher(payload, dispatch);
        return;
      }
      const peer = this.peerFor(payload);
      if (peer.mode === "codex_app_server") {
        processingAttempt = dispatch ? this.createProcessingAttempt(dispatch, "codex-app-server", "completed") : null;
        if (dispatch && this.dispatchStore.beginHandoff(dispatch, now, processingAttempt) !== 1) {
          this.handleHandoffClaimLoss(dispatch, now, payload);
          return;
        }
        if (!this.injector) throw new Error(`wake-native-injector-missing:${payload.from}`);
        await this.injector(payload, peer, this.processingContext(processingAttempt));
        this.log("info", "WakeMonitor native wake completed", { msgId: payload.msgId, conversationId: payload.conversationId, mode: peer.mode });
      } else if (this.hook) {
        processingAttempt = dispatch
          ? this.createProcessingAttempt(dispatch, this.hook.runtime || "shell-hook", this.hook.processingReceipts || "none")
          : null;
        if (dispatch && this.dispatchStore.beginHandoff(dispatch, now, processingAttempt) !== 1) {
          this.handleHandoffClaimLoss(dispatch, now, payload);
          return;
        }
        await this.hook(payload, processingAttempt);
        this.log("info", "WakeMonitor hook completed", { msgId: payload.msgId, conversationId: payload.conversationId });
      } else {
        // Stateless/pull agents consume the durable local inbox themselves. No active
        // wake hook is required and, because no runtime call occurs, no delivery attempt
        // is spent. `handed_off` here means handed to that local inbox boundary only.
        this.log("info", "WakeMonitor stateless inbox handoff completed", {
          msgId: payload.msgId,
          conversationId: payload.conversationId,
        });
      }
      if (dispatch) this.dispatchStore.markHandedOff(dispatch, this.now());
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.log("warn", "WakeMonitor hook error", { error: e.message, msgId: payload.msgId });
      if (dispatch) {
        const completedWon = processingAttempt
          ? this.dispatchStore.markHandedOffIfLatestAttemptCompleted(dispatch, processingAttempt.attemptId, this.now()) === 1
          : false;
        if (completedWon) {
          this.log("error", "WakeMonitor post-completion hook failure", {
            error: e.message,
            msgId: payload.msgId,
            attemptId: processingAttempt.attemptId,
            runtime: processingAttempt.runtime,
          });
          return;
        }
        const attempt = processingAttempt
          ? this.dispatchStore.getProcessingAttempt(processingAttempt.attemptId)
          : this.dispatchStore.latestProcessingAttempt(dispatch);
        if (attempt?.capability !== "none" && attempt?.status !== "completed") {
          this.recordProcessingReceipt(attempt, "failed", { errorMessage: e.message });
        }
        await this.failDispatch(dispatch, e.message, this.now(), payload);
      }
    } finally {
      this.advanceCursor(payload);
    }
  }

  /** Exact correlated system failure for a handoff refused before model execution. */
  async rejectHandoff(payload, reason, detail = null) {
    if (typeof this.onHandoffRejected !== "function") return;
    try {
      await this.onHandoffRejected(payload, { reason, detail });
    } catch (err) {
      this.log("error", "WakeMonitor handoff failure reply could not be enqueued", {
        msgId: payload.msgId, reason, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  createProcessingAttempt(dispatch, runtime, capability) {
    return {
      attemptId: randomUUID(),
      inboundMessageId: dispatch.msgId,
      recipientId: dispatch.recipientId,
      memberSlot: dispatch.memberSlot,
      runtime,
      capability,
    };
  }

  processingContext(attempt) {
    if (!attempt) return null;
    return {
      ...attempt,
      started: (details = {}) => this.recordProcessingReceipt(attempt, "started", details),
      completed: (details = {}) => this.recordProcessingReceipt(attempt, "completed", details),
      failed: (details = {}) => this.recordProcessingReceipt(attempt, "failed", details),
    };
  }

  recordProcessingReceipt(attempt, status, details = {}) {
    if (!attempt || !this.dispatchStore) return { accepted: false, reason: "receipt-store-unavailable" };
    const result = this.dispatchStore.recordProcessingReceipt({ ...attempt, ...details, status }, this.now());
    const diagnostic = {
      msgId: attempt.inboundMessageId,
      recipientId: attempt.recipientId,
      memberSlot: attempt.memberSlot,
      attemptId: attempt.attemptId,
      runtime: attempt.runtime,
      status,
      reason: result.reason ?? null,
    };
    if (result.conflict) this.log("error", "WakeMonitor conflicting processing receipt", diagnostic);
    else if (!result.accepted) this.log("warn", "WakeMonitor stale or unknown processing receipt", diagnostic);
    else if (!result.duplicate) this.log("info", `WakeMonitor processing ${status}`, diagnostic);
    return result;
  }

  retryDelay(attempts) {
    return Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * (2 ** Math.max(0, attempts - 1)));
  }

  deferDispatch(dispatch, reason, now = this.now(), notBefore = now) {
    const nextAttemptAt = Math.max(notBefore, now + this.retryDelay(dispatch.attempts));
    this.dispatchStore.defer(dispatch, reason, nextAttemptAt, now);
  }

  handleHandoffClaimLoss(dispatch, now, payload) {
    const reason = "wake-dispatch-handoff-claim-lost";
    const nextAttemptAt = now + this.retryDelay(dispatch.attempts);
    const rescheduled = this.dispatchStore.rescheduleAfterClaimLoss(dispatch, reason, nextAttemptAt, now);
    this.log("error", "WakeMonitor handoff claim invariant failed", {
      msgId: payload.msgId,
      recipient: dispatch.recipientId,
      memberSlot: dispatch.memberSlot,
      rescheduled: rescheduled === 1,
      nextAttemptAt,
    });
  }

  async safeNotify(payload, reason, diagnostic = {}) {
    try {
      await this.notify?.(payload, reason);
    } catch (err) {
      this.log("error", "WakeMonitor notification failed", {
        msgId: payload.msgId,
        conversationId: payload.conversationId,
        reason,
        ...diagnostic,
        notificationError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async failDispatch(dispatch, reason, now = this.now(), payload = dispatch.payload) {
    const result = this.dispatchStore.fail(
      dispatch,
      reason,
      now + this.retryDelay(dispatch.attempts + 1),
      now,
    );
    if (!result.terminal) return;
    const diagnostic = {
      msgId: result.row.msgId,
      recipient: result.row.recipientId,
      memberSlot: result.row.memberSlot,
      attempts: result.row.attempts,
      lastError: result.row.lastError,
      timestamp: new Date(now).toISOString(),
      transitionReason: "delivery-attempt-budget-exhausted",
    };
    this.log("error", "WakeMonitor dispatch terminal failure", diagnostic);
    await this.safeNotify(
      { ...payload, dispatchDiagnostic: diagnostic },
      "terminal",
      diagnostic,
    );
  }

  pruneSeen(now = this.now()) {
    for (const [key, wokeAt] of this.seen.entries()) {
      if (now - wokeAt >= this.cooldownMs) this.seen.delete(key);
    }
  }

  async isLoopBreakerBlocked(payload, now) {
    const sender = payload.from || "unknown";
    const suspendedUntil = this.suspendedSenders.get(sender);
    if (suspendedUntil !== undefined) {
      if (now < suspendedUntil) {
        await this.safeNotify(payload, "loop-breaker", { suspendedUntil });
        this.log("warn", "WakeMonitor loop-breaker suspended wake", { sender, msgId: payload.msgId, suspendedUntil });
        return true;
      }
      this.suspendedSenders.delete(sender);
    }

    const since = now - this.loopBreaker.windowMs;
    const window = (this.senderWindows.get(sender) || []).filter((ts) => ts > since);
    if (window.length >= this.loopBreaker.maxWakes) {
      const nextSuspendedUntil = now + this.loopBreaker.windowMs;
      this.suspendedSenders.set(sender, nextSuspendedUntil);
      this.senderWindows.set(sender, window);
      await this.safeNotify(payload, "loop-breaker", { suspendedUntil: nextSuspendedUntil });
      this.log("warn", "WakeMonitor loop-breaker tripped", { sender, count: window.length + 1, msgId: payload.msgId });
      return true;
    }

    window.push(now);
    this.senderWindows.set(sender, window);
    return false;
  }

  async audit(payload) {
    if (!this.auditHook) return "allow";
    const verdict = await this.auditHook(payload);
    return verdict === "allow" || verdict === "require_approval" || verdict === "deny" ? verdict : "deny";
  }

  advanceCursor(payload) {
    const cursor = Number(payload?.cursor);
    if (Number.isFinite(cursor) && cursor > this.cursor) this.cursor = cursor;
  }

  keyFor(payload) {
    return payload.msgId;
  }

  peerFor(payload) {
    const peer = ensureObject(this.peers?.[payload.from]);
    return {
      ...peer,
      mode: validMode(peer.mode) ? peer.mode : this.mode,
    };
  }
}
