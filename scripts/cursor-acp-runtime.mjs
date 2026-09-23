import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

export const CURSOR_ACP_KIND = "cursor_acp";
export const CURSOR_ACP_MEMBER_SLOT = "cursor:acp";
export const normalizeCursorAcpRuntimeConfig = (config = {}) => ({ ...config, enabled: config.enabled === true });

const asError = (value) => value instanceof Error ? value : new Error(String(value));

export class CursorAcpClient {
  constructor({
    command = "agent", args = ["acp"], cwd, env = process.env,
    startupTimeoutMs = 30_000, turnTimeoutMs = 300_000,
    terminateGraceMs = 5_000, permissionPolicy = "reject-once",
    mode = "ask",
    spawnProcess = spawn, log = () => {},
  } = {}) {
    Object.assign(this, { command, args, cwd, env, startupTimeoutMs, turnTimeoutMs,
      terminateGraceMs, permissionPolicy, mode, spawnProcess, log });
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Set();
  }

  async start() {
    if (this.child && this.child.exitCode == null) return this.processInfo;
    const child = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderr = "";
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk) => { this.stderr += chunk; });
    const rl = createInterface({ input: child.stdout });
    this.reader = rl;
    rl.on("line", (line) => this.onLine(line));
    child.once("error", (error) => this.failAll(error));
    child.once("close", (code, signal) => {
      const error = new Error(`cursor-acp-exit:${code ?? "null"}:${signal ?? "none"}:${this.stderr.trim()}`);
      error.outcomeUnknown = Boolean(this.activePrompt);
      this.failAll(error);
    });
    await this.waitForSpawn(child);
    this.processInfo = { pid: child.pid, processStartIdentity: `${child.pid}:${Date.now()}`, child };
    const initialized = await this.withTimeout(this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "murmur", version: "0.1.0" },
    }), this.startupTimeoutMs, "cursor-acp-initialize-timeout");
    if (initialized?.protocolVersion !== 1) throw new Error("cursor-acp-protocol-unsupported");
    this.capabilities = initialized.agentCapabilities || {};
    await this.withTimeout(this.request("authenticate", { methodId: "cursor_login" }),
      this.startupTimeoutMs, "cursor-acp-auth-timeout");
    return this.processInfo;
  }

  waitForSpawn(child) {
    if (child.pid) return Promise.resolve();
    return new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  request(method, params) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("cursor-acp-not-running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) throw new Error("cursor-acp-not-running");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  respond(id, result) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.log("warn", "Cursor ACP emitted invalid JSON", { line });
      return;
    }
    if (message.id != null && (Object.hasOwn(message, "result") || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(`cursor-acp-rpc:${pending.method}:${message.error.message || message.error.code}`);
        error.rpcError = message.error;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      if (this.activePrompt && message.params?.sessionId === this.activePrompt.sessionId) {
        this.activePrompt.onUpdate?.(message.params.update);
      }
      return;
    }
    if (message.id != null && message.method === "session/request_permission") {
      const options = message.params?.options || [];
      const selected = options.find((option) => option.optionId === this.permissionPolicy)
        || options.find((option) => option.kind === this.permissionPolicy);
      this.respond(message.id, selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } });
      return;
    }
    if (message.id != null && ["cursor/ask_question", "cursor/create_plan"].includes(message.method)) {
      this.respond(message.id, { outcome: { outcome: "cancelled" } });
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async createSession() {
    const result = await this.withTimeout(this.request("session/new", { cwd: this.cwd, mcpServers: [] }),
      this.startupTimeoutMs, "cursor-acp-session-new-timeout");
    if (typeof result?.sessionId !== "string" || !result.sessionId) throw new Error("cursor-acp-session-invalid");
    if (this.mode) await this.withTimeout(this.request("session/set_mode", {
      sessionId: result.sessionId, modeId: this.mode,
    }), this.startupTimeoutMs, "cursor-acp-set-mode-timeout");
    this.sessions.add(result.sessionId);
    return result.sessionId;
  }

  async loadSession(sessionId) {
    if (!this.capabilities?.loadSession) throw new Error("cursor-acp-load-session-unsupported");
    await this.withTimeout(this.request("session/load", { sessionId, cwd: this.cwd, mcpServers: [] }),
      this.startupTimeoutMs, "cursor-acp-session-load-timeout");
    if (this.mode) await this.withTimeout(this.request("session/set_mode", { sessionId, modeId: this.mode }),
      this.startupTimeoutMs, "cursor-acp-set-mode-timeout");
    this.sessions.add(sessionId);
    return sessionId;
  }

  async executeTurn({ sessionId, prompt, onSubmitted = () => {}, onUpdate = () => {} }) {
    if (!this.sessions.has(sessionId)) throw new Error("cursor-acp-session-not-loaded");
    if (this.activePrompt) throw new Error("cursor-acp-turn-already-running");
    const chunks = [];
    const update = (event) => {
      onUpdate(event);
      if (event?.sessionUpdate === "agent_message_chunk" && typeof event.content?.text === "string") {
        chunks.push(event.content.text);
      }
    };
    // The durable handoff/fence callback must win before bytes cross the ACP
    // runtime boundary. request() writes synchronously to the child stdin.
    onSubmitted();
    const turn = this.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    this.activePrompt = { sessionId, promise: turn, onUpdate: update };
    try {
      let result;
      try {
        result = await this.withTimeout(turn, this.turnTimeoutMs, "cursor-acp-turn-timeout", true);
      } catch (error) {
        if (error.message === "cursor-acp-turn-timeout") {
          try { this.notify("session/cancel", { sessionId }); } catch {}
          await this.shutdown({ graceMs: this.terminateGraceMs });
        }
        throw error;
      }
      if (["cancelled", "refusal"].includes(result?.stopReason)) {
        const error = new Error(`cursor-acp-terminal:${result.stopReason}`);
        error.terminalOutcome = true;
        throw error;
      }
      const text = chunks.join("").trim();
      if (!text) throw new Error("cursor-acp-result-empty");
      return { text, sessionId, stopReason: result?.stopReason, raw: result };
    } finally {
      this.activePrompt = null;
    }
  }

  async cancel({ graceMs = this.terminateGraceMs } = {}) {
    const active = this.activePrompt;
    if (!active) return false;
    this.notify("session/cancel", { sessionId: active.sessionId });
    try {
      await this.withTimeout(active.promise.catch(() => {}), graceMs, "cursor-acp-cancel-timeout");
      return true;
    } catch {
      await this.shutdown({ graceMs });
      return true;
    }
  }

  health() {
    return { healthy: Boolean(this.child && this.child.exitCode == null), pid: this.child?.pid ?? null,
      sessionIds: [...this.sessions] };
  }

  async shutdown({ graceMs = this.terminateGraceMs } = {}) {
    const child = this.child;
    if (!child || child.exitCode != null) return false;
    child.stdin?.end();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      child.once("close", finish);
      const timer = setTimeout(() => { if (child.exitCode == null) child.kill("SIGKILL"); finish(); }, graceMs);
      timer.unref?.();
    });
    return true;
  }

  withTimeout(promise, timeoutMs, message, outcomeUnknown = false) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(message);
        error.outcomeUnknown = outcomeUnknown;
        reject(error);
      }, timeoutMs);
      timer.unref?.();
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
}

export class CursorAcpRuntime {
  constructor({
    bindingStore, dispatchStore, agentId, projectId, cwd, sendReply,
    client, clientFactory = (options) => new CursorAcpClient(options),
    command = "agent", env = process.env, now = () => Date.now(),
    heartbeatIntervalMs = 5_000, startupTimeoutMs = 30_000,
    turnTimeoutMs = 300_000, terminateGraceMs = 5_000, retryDelayMs = 1_000,
    permissionPolicy = "reject-once", log = () => {},
    mode = "ask",
  }) {
    Object.assign(this, { bindingStore, dispatchStore, agentId, projectId, cwd, sendReply,
      client, clientFactory, command, env, now, heartbeatIntervalMs, startupTimeoutMs,
      turnTimeoutMs, terminateGraceMs, retryDelayMs, permissionPolicy, mode, log });
  }

  async start({ bindingId = randomUUID(), runtimeGeneration = 1, leaseTtlMs = 30_000 } = {}) {
    if (!Number.isFinite(Number(leaseTtlMs)) || Number(leaseTtlMs) <= 1) throw new Error("cursor-acp-lease-ttl-invalid");
    leaseTtlMs = Number(leaseTtlMs);
    this.stopHeartbeat();
    this.bindingId = bindingId;
    this.leaseTtlMs = leaseTtlMs;
    this.heartbeatIntervalMs = Math.min(Math.max(1, Number(this.heartbeatIntervalMs) || 1),
      Math.max(1, Math.floor(leaseTtlMs / 2)));
    const binding = this.bindingStore.register({ bindingId, agentId: this.agentId,
      runtimeKind: CURSOR_ACP_KIND, runtimeGeneration, projectId: this.projectId,
      memberSlot: CURSOR_ACP_MEMBER_SLOT, leaseTtlMs, state: "STARTING",
      metadata: { permissionPolicy: this.permissionPolicy, restartContinuity: false, persistentProcess: true } }, this.now());
    const fence = { bindingId, ownerGeneration: binding.runtimeGeneration,
      fencingToken: binding.leaseToken, fencingEpoch: binding.fencingEpoch };
    this.client ||= this.clientFactory({ command: this.command, cwd: this.cwd, env: this.env,
      startupTimeoutMs: this.startupTimeoutMs, turnTimeoutMs: this.turnTimeoutMs,
      terminateGraceMs: this.terminateGraceMs, permissionPolicy: this.permissionPolicy,
      mode: this.mode, log: this.log });
    try {
      const processInfo = await this.client.start();
      if (this.bindingStore.updateProcess(fence, processInfo, this.now()) !== 1
        || this.bindingStore.markIdle(fence, this.now()) !== 1) throw new Error("cursor-acp-start-failed");
      this.startHeartbeat();
      return this.bindingStore.get(bindingId);
    } catch (error) {
      this.bindingStore.markOffline(fence, this.now());
      await this.client.shutdown?.();
      throw error;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const tick = () => {
      const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
      if (!binding || ["OFFLINE", "STALE"].includes(binding.state) || !this.client?.health().healthy) return;
      this.bindingStore.heartbeat({ bindingId: binding.bindingId, ownerGeneration: binding.runtimeGeneration,
        fencingToken: binding.leaseToken, fencingEpoch: binding.fencingEpoch }, this.now());
    };
    tick();
    this.heartbeatTimer = setInterval(tick, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

  health() {
    const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
    const process = this.client?.health() || { healthy: false };
    return { healthy: Boolean(process.healthy && binding && !["OFFLINE", "STALE"].includes(binding.state)), binding, process };
  }

  async executeTurn(payload, dispatch) {
    const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
    const fence = this.bindingStore.assignDispatch(identity, { agentId: this.agentId, projectId: this.projectId,
      memberSlot: CURSOR_ACP_MEMBER_SLOT, taskId: payload.conversationId }, this.now());
    if (!fence) {
      this.dispatchStore.defer(dispatch, "cursor-acp-binding-unavailable", this.now() + this.retryDelayMs, this.now());
      return { status: "deferred" };
    }
    if (!this.bindingStore.validateFence(fence, identity)) throw new Error("cursor-acp-fence-lost-before-wake");
    if (this.bindingStore.markWaking(fence, this.now()) !== 1) throw new Error("cursor-acp-waking-transition-failed");
    const binding = this.bindingStore.get(fence.bindingId);
    const attempt = { attemptId: randomUUID(), inboundMessageId: identity.msgId,
      recipientId: identity.recipientId, memberSlot: identity.memberSlot,
      runtime: CURSOR_ACP_KIND, capability: "completed" };
    let submitted = false;
    let started = false;
    try {
      let sessionId = binding.runtimeSessionId;
      if (!sessionId) sessionId = await this.client.createSession();
      else if (!this.client.health().sessionIds.includes(sessionId)) await this.client.loadSession(sessionId);
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (this.bindingStore.markRunning(fence, this.now()) !== 1) throw new Error("cursor-acp-running-transition-failed");
      if (this.bindingStore.confirmRuntimeSession(fence, sessionId, this.now()) !== 1) throw new Error("cursor-acp-session-confirm-failed");
      const result = await this.client.executeTurn({ sessionId, prompt: payload.text,
        onSubmitted: () => {
          if (!this.bindingStore.validateFence(fence, identity)) throw new Error("cursor-acp-fence-lost-before-submit");
          if (this.dispatchStore.beginHandoff(identity, this.now(), attempt) !== 1) throw new Error("cursor-acp-handoff-claim-lost");
          submitted = true;
        },
        onUpdate: () => {
          if (started || !this.bindingStore.validateFence(fence, identity)) return;
          const receipt = this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "started", sessionId }, this.now());
          if (receipt.accepted) started = true;
        },
      });
      if (!submitted) throw new Error("cursor-acp-submit-unconfirmed");
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      const receipt = this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "completed", sessionId,
        metadata: { resultText: result.text, stopReason: result.stopReason,
          conversationId: payload.conversationId, recipient: payload.from, replyToMessageId: payload.msgId } }, this.now());
      if (!receipt.accepted) throw new Error(`cursor-acp-completion-rejected:${receipt.reason}`);
      this.dispatchStore.markHandedOffIfLatestAttemptCompleted(identity, attempt.attemptId, this.now());
      let reply = null;
      if (this.bindingStore.validateFence(fence, identity)) {
        try {
          reply = await this.sendReply({ msgId: attempt.attemptId, to: payload.from,
            conversationId: payload.conversationId, replyToMessageId: payload.msgId, text: result.text });
          this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "completed",
            sessionId, resultMessageId: reply.msgId }, this.now());
        } catch (error) {
          this.log("error", "Cursor ACP reply enqueue failed after durable completion",
            { msgId: payload.msgId, attemptId: attempt.attemptId, error: asError(error).message });
        }
      }
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (this.bindingStore.markIdle(fence, this.now()) !== 1) return { status: "late-result-dropped" };
      return { status: reply ? "completed" : "completed-reply-pending", attemptId: attempt.attemptId, reply };
    } catch (error) {
      const failure = asError(error);
      if (this.bindingStore.validateFence(fence, identity)) {
        if (submitted && !failure.outcomeUnknown) this.dispatchStore.recordProcessingReceipt({ ...attempt,
          status: "failed", errorMessage: failure.message }, this.now());
        const row = this.dispatchStore.get(identity);
        const terminal = row && row.attempts >= row.maxAttempts;
        this.bindingStore.releaseAssignment(fence, identity, { state: terminal ? "terminal" : "failed",
          reason: failure.outcomeUnknown ? "cursor-acp-outcome-unknown" : failure.message,
          nextAttemptAt: this.now() + this.retryDelayMs }, this.now());
        if (!this.client.health().healthy) this.bindingStore.markOffline(fence, this.now());
      }
      return { status: failure.outcomeUnknown ? "unknown" : "failed", error: failure };
    }
  }

  async recoverCompletedReplies() {
    const rows = this.dispatchStore.db.prepare(`SELECT * FROM processing_attempts
      WHERE runtime = ? AND status = 'completed' AND result_message_id IS NULL ORDER BY completed_at, rowid`)
      .all(CURSOR_ACP_KIND);
    const recovered = [];
    for (const row of rows) {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
      if (!metadata?.resultText || !metadata?.recipient || !metadata?.conversationId || !metadata?.replyToMessageId) continue;
      const reply = await this.sendReply({ msgId: row.attempt_id, to: metadata.recipient,
        conversationId: metadata.conversationId, replyToMessageId: metadata.replyToMessageId, text: metadata.resultText });
      this.dispatchStore.recordProcessingReceipt({ attemptId: row.attempt_id,
        inboundMessageId: row.inbound_message_id, recipientId: row.recipient_id,
        memberSlot: row.member_slot, runtime: CURSOR_ACP_KIND, status: "completed",
        resultMessageId: reply.msgId }, this.now());
      recovered.push({ attemptId: row.attempt_id, msgId: reply.msgId });
    }
    return recovered;
  }

  async cancel() { return this.client?.cancel({ graceMs: this.terminateGraceMs }) || false; }

  async shutdown() {
    this.stopHeartbeat();
    const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
    if (binding) this.bindingStore.markOffline({ bindingId: binding.bindingId,
      ownerGeneration: binding.runtimeGeneration, fencingToken: binding.leaseToken,
      fencingEpoch: binding.fencingEpoch }, this.now());
    await this.client?.shutdown({ graceMs: this.terminateGraceMs });
  }
}
