import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HANDOFF_REASONS } from "@murmurv2/core";
import { settleRuntimeTurn } from "./agent-handoff-runtime.mjs";
import { extractCanonicalModel } from "./claude-capabilities.mjs";
import { writePrivateJson } from "./secure-state.mjs";

export const CLAUDE_ONE_SHOT_KIND = "claude_one_shot";
export const CLAUDE_AUTO_MEMBER_SLOT = "claude:auto";

const asError = (value) => value instanceof Error ? value : new Error(String(value));

/**
 * Claude continuation guard. `claude -p --resume <sessionId>` genuinely reloads the
 * originating logical session (it is CLI-side state, so it survives a Murmur restart),
 * so resuming needs only the exact recorded session id. It is refused when the binding
 * has meanwhile confirmed a DIFFERENT session — that binding can hold one session, and
 * silently starting an unrelated one is not a resume.
 */
export const claudeHandoffResumeGuard = ({ continuation, binding }) => {
  if (!continuation.originatingRuntimeSessionId) {
    return { ok: false, reason: HANDOFF_REASONS.continuationSessionUnavailable, detail: "no-originating-session" };
  }
  if (binding.runtimeSessionId && binding.runtimeSessionId !== continuation.originatingRuntimeSessionId) {
    return { ok: false, reason: HANDOFF_REASONS.continuationSessionUnavailable, detail: "binding-session-diverged" };
  }
  return { ok: true };
};

/**
 * `model`/`effort` are passed through UNVALIDATED here on purpose: validation against the
 * installed CLI's actual discovered capabilities happens once, at the policy boundary
 * (`operator/claude-config.mjs`), before a value is ever written to the project's
 * preferences file. By the time a value reaches this function it is already a value an
 * operator explicitly chose and Murmur already confirmed the CLI accepts — this function
 * only builds argv from it. Passing `undefined`/omitting a flag entirely is how "inherit"
 * is expressed: Murmur adds no override and the installed CLI's own configuration decides,
 * exactly as it did before either option existed.
 */
export function buildClaudeOneShotArgs({ prompt, sessionId, resume = false, permissionMode = "dontAsk", model, effort }) {
  const args = ["-p", "--safe-mode", "--output-format", "json", "--permission-mode", permissionMode, "--tools", ""];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (resume) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId);
  args.push(prompt);
  return args;
}

export function runClaudeOneShot({
  prompt,
  sessionId,
  resume = false,
  cwd,
  permissionMode = "dontAsk",
  model,
  effort,
  timeoutMs = 300_000,
  terminateGraceMs = 5_000,
  command = "claude",
  env = process.env,
  onSpawn = () => {},
}) {
  return new Promise((resolve, reject) => {
    const args = buildClaudeOneShotArgs({ prompt, sessionId, resume, permissionMode, model, effort });
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("spawn", () => {
      try {
        onSpawn({ pid: child.pid, processStartIdentity: `${child.pid}:${Date.now()}`, child });
      } catch (error) {
        child.kill("SIGTERM");
        reject(asError(error));
      }
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), terminateGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        const error = new Error("claude-one-shot-timeout");
        error.outcomeUnknown = true;
        error.code = code;
        error.signal = signal;
        reject(error);
        return;
      }
      if (code !== 0) {
        const error = new Error(`claude-one-shot-exit:${code}:${stderr.trim()}`);
        error.code = code;
        error.signal = signal;
        reject(error);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const resultText = typeof parsed.result === "string" ? parsed.result : null;
        const confirmedSessionId = parsed.session_id || parsed.sessionId;
        if (!resultText || !confirmedSessionId) throw new Error("claude-one-shot-result-invalid");
        resolve({ text: resultText, sessionId: confirmedSessionId, raw: parsed });
      } catch (error) {
        reject(asError(error));
      }
    });
  });
}

export class ClaudeOneShotRuntime {
  constructor({
    bindingStore,
    dispatchStore,
    agentId,
    projectId,
    cwd,
    sendReply,
    runner = runClaudeOneShot,
    now = () => Date.now(),
    heartbeatIntervalMs = 5_000,
    turnTimeoutMs = 300_000,
    terminateGraceMs = 5_000,
    retryDelayMs = 1_000,
    permissionMode = "dontAsk",
    model,
    effort,
    handoff = null,
    log = () => {},
    // Opportunistic, best-effort cache of the CANONICAL model id a completed real turn
    // reveals (e.g. "claude-sonnet-5") — see `maybeCacheCanonicalModel`. Undefined for a
    // legacy `.data-claude` identity, which simply never gets this cache file.
    canonicalModelCacheFile = undefined,
  }) {
    Object.assign(this, {
      bindingStore, dispatchStore, agentId, projectId, cwd, sendReply, runner, now,
      heartbeatIntervalMs, turnTimeoutMs, terminateGraceMs, retryDelayMs,
      permissionMode, model, effort, handoff, log, canonicalModelCacheFile,
    });
  }

  /**
   * Cache the canonical model id a completed turn's own `modelUsage` reveals — NEVER from
   * a dedicated probe, only as a side effect of real work this runtime was already doing.
   * Correlated to the alias that was ACTUALLY configured when the turn ran (`this.model`):
   * if the operator later switches aliases, a reader of this cache must be able to tell
   * the cached id belongs to the PREVIOUS selection and fall back to the bare alias label
   * until a turn runs under the new one. Best-effort and fire-and-forget: a failed write
   * here must never fail, delay or retry the turn itself.
   */
  async maybeCacheCanonicalModel(result) {
    if (!this.canonicalModelCacheFile || !this.model) return;
    const canonicalModel = extractCanonicalModel(result?.raw?.modelUsage, this.model);
    if (!canonicalModel) return;
    try {
      await writePrivateJson(this.canonicalModelCacheFile, {
        version: 1,
        selectedAlias: this.model,
        canonicalModel,
        observedAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      this.log("warn", "Could not cache observed canonical Claude model (display only, non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  start({ bindingId = randomUUID(), runtimeGeneration = 1, leaseTtlMs = 30_000 } = {}) {
    if (!Number.isFinite(Number(leaseTtlMs)) || Number(leaseTtlMs) <= 1) {
      throw new Error("claude-one-shot-lease-ttl-invalid");
    }
    leaseTtlMs = Number(leaseTtlMs);
    this.stopHeartbeat();
    this.bindingId = bindingId;
    this.leaseTtlMs = leaseTtlMs;
    this.heartbeatIntervalMs = Math.min(
      Math.max(1, Number(this.heartbeatIntervalMs) || 1),
      Math.max(1, Math.floor(leaseTtlMs / 2)),
    );
    const binding = this.bindingStore.register({
      bindingId,
      agentId: this.agentId,
      runtimeKind: CLAUDE_ONE_SHOT_KIND,
      runtimeGeneration,
      projectId: this.projectId,
      memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
      leaseTtlMs,
      state: "STARTING",
      // Recorded once, at daemon boot, because `this.model`/`this.effort` are fixed for
      // the life of this process (see the module header on why a config-file change needs
      // a restart to take effect). `status`/`doctor` read this back as the TRUTH of what
      // is actually executing right now, as opposed to the project's current preference
      // file — which a running daemon may have already fallen behind. "inherit" is
      // recorded explicitly (never omitted) so a later comparison never has to guess
      // whether an absent field meant "no override" or "not recorded yet".
      metadata: {
        permissionMode: this.permissionMode,
        model: this.model || "inherit",
        effort: this.effort || "inherit",
      },
    }, this.now());
    const fence = {
      bindingId,
      ownerGeneration: binding.runtimeGeneration,
      fencingToken: binding.leaseToken,
      fencingEpoch: binding.fencingEpoch,
    };
    if (this.bindingStore.markIdle(fence, this.now()) !== 1) throw new Error("claude-one-shot-start-failed");
    this.startHeartbeat();
    return this.bindingStore.get(bindingId);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const tick = () => {
      const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
      if (!binding || ["OFFLINE", "STALE"].includes(binding.state)) return;
      this.bindingStore.heartbeat({
        bindingId: binding.bindingId,
        ownerGeneration: binding.runtimeGeneration,
        fencingToken: binding.leaseToken,
        fencingEpoch: binding.fencingEpoch,
      }, this.now());
    };
    tick();
    this.heartbeatTimer = setInterval(tick, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  bind(bindingId) {
    const binding = this.bindingStore.get(bindingId);
    if (!binding || binding.runtimeKind !== CLAUDE_ONE_SHOT_KIND) throw new Error("claude-one-shot-binding-invalid");
    this.bindingId = bindingId;
    return binding;
  }

  health() {
    const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
    return { healthy: Boolean(binding && !["OFFLINE", "STALE"].includes(binding.state)), binding };
  }

  async executeTurn(payload, dispatch) {
    const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
    const fence = this.bindingStore.assignDispatch(identity, {
      agentId: this.agentId,
      projectId: this.projectId,
      memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
      taskId: payload.conversationId,
    }, this.now());
    if (!fence) {
      this.dispatchStore.defer(dispatch, "claude-one-shot-binding-unavailable", this.now() + this.retryDelayMs, this.now());
      return { status: "deferred" };
    }
    if (!this.bindingStore.validateFence(fence, identity)) throw new Error("claude-one-shot-fence-lost-before-wake");
    if (this.bindingStore.markWaking(fence, this.now()) !== 1) throw new Error("claude-one-shot-waking-transition-failed");

    const binding = this.bindingStore.get(fence.bindingId);
    const turn = this.handoff
      ? this.handoff.prepareTurn({
        payload,
        binding,
        runtimeKind: CLAUDE_ONE_SHOT_KIND,
        memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
        resumeGuard: claudeHandoffResumeGuard,
        fence,
        identity,
      })
      : null;
    if (turn?.rejection) {
      return this.handoff.failClosedTurn({
        turn, dispatch, dispatchStore: this.dispatchStore, bindingStore: this.bindingStore, fence, identity,
      });
    }
    // A continuation resumes the EXACT originating Claude session; an ordinary turn keeps
    // the binding's session (or seeds a new one).
    const requestedSessionId = turn?.resumeSessionId || binding.runtimeSessionId || randomUUID();
    const resumeSession = Boolean(turn?.resumeSessionId || binding.runtimeSessionId);
    const promptText = turn?.promptText ?? payload.text;
    const attempt = {
      attemptId: randomUUID(),
      inboundMessageId: identity.msgId,
      recipientId: identity.recipientId,
      memberSlot: identity.memberSlot,
      runtime: CLAUDE_ONE_SHOT_KIND,
      capability: "completed",
    };
    let launched = false;
    try {
      const result = await this.runner({
        prompt: promptText,
        sessionId: requestedSessionId,
        resume: resumeSession,
        cwd: this.cwd,
        permissionMode: this.permissionMode,
        // Fixed per daemon process and applied to EVERY turn this runtime instance ever
        // executes — a new session, a resumed session, and a turn caused by Codex, Cursor
        // or the root operator all go through this same instance, so none of them can
        // choose Claude's model/effort merely by being the sender. See
        // `claude-one-shot-runtime.test.mjs` for the sender-independence proof, and
        // `claude-capabilities.mjs` for empirical confirmation that `--model` on a
        // `--resume`d session changes the effective model with no loss of context.
        model: this.model,
        effort: this.effort,
        timeoutMs: this.turnTimeoutMs,
        terminateGraceMs: this.terminateGraceMs,
        onSpawn: ({ pid, processStartIdentity, child }) => {
          if (!this.bindingStore.validateFence(fence, identity)) throw new Error("claude-one-shot-fence-lost-before-launch");
          if (this.dispatchStore.beginHandoff(identity, this.now(), attempt) !== 1) {
            throw new Error("claude-one-shot-handoff-claim-lost");
          }
          launched = true;
          this.currentChild = child ?? null;
          if (this.bindingStore.updateProcess(fence, { pid, processStartIdentity }, this.now()) !== 1
            || this.bindingStore.markRunning(fence, this.now()) !== 1) {
            throw new Error("claude-one-shot-running-transition-failed");
          }
        },
      });
      if (!launched) throw new Error("claude-one-shot-launch-unconfirmed");
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      if (result.sessionId !== requestedSessionId) throw new Error("claude-one-shot-session-mismatch");
      if (this.bindingStore.confirmRuntimeSession(fence, result.sessionId, this.now()) !== 1) {
        throw new Error("claude-one-shot-session-confirm-failed");
      }
      if (!this.bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
      // Display-only and fire-and-forget: never awaited into the fenced/correlated path
      // above, and never allowed to affect the result the turn actually settles with.
      void this.maybeCacheCanonicalModel(result);
      return await settleRuntimeTurn({
        runtimeKind: CLAUDE_ONE_SHOT_KIND,
        dispatchStore: this.dispatchStore,
        bindingStore: this.bindingStore,
        fence,
        identity,
        attempt,
        payload,
        turn,
        coordinator: this.handoff,
        resultText: result.text,
        sessionId: result.sessionId,
        runtimeSession: { runtimeSessionId: result.sessionId },
        sendReply: this.sendReply,
        log: this.log,
        now: this.now,
      });
    } catch (error) {
      const failure = asError(error);
      if (this.bindingStore.validateFence(fence, identity)) {
        if (launched && !failure.outcomeUnknown) {
          this.dispatchStore.recordProcessingReceipt({ ...attempt, status: "failed", errorMessage: failure.message }, this.now());
        }
        const row = this.dispatchStore.get(identity);
        const terminal = row && row.attempts >= row.maxAttempts;
        this.bindingStore.releaseAssignment(fence, identity, {
          state: terminal ? "terminal" : "failed",
          reason: failure.outcomeUnknown ? "claude-one-shot-outcome-unknown" : failure.message,
          nextAttemptAt: this.now() + this.retryDelayMs,
        }, this.now());
      }
      return { status: failure.outcomeUnknown ? "unknown" : "failed", error: failure };
    } finally {
      this.currentChild = null;
    }
  }

  async recoverCompletedReplies() {
    const rows = this.dispatchStore.db.prepare(`
      SELECT * FROM processing_attempts
      WHERE runtime = ? AND status = 'completed' AND result_message_id IS NULL
      ORDER BY completed_at, rowid
    `).all(CLAUDE_ONE_SHOT_KIND);
    const recovered = [];
    for (const row of rows) {
      const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
      if (!metadata?.resultText || !metadata?.recipient || !metadata?.conversationId || !metadata?.replyToMessageId) continue;
      const reply = await this.sendReply({
        msgId: row.attempt_id,
        to: metadata.recipient,
        conversationId: metadata.conversationId,
        replyToMessageId: metadata.replyToMessageId,
        text: metadata.resultText,
      });
      this.dispatchStore.recordProcessingReceipt({
        attemptId: row.attempt_id,
        inboundMessageId: row.inbound_message_id,
        recipientId: row.recipient_id,
        memberSlot: row.member_slot,
        runtime: CLAUDE_ONE_SHOT_KIND,
        status: "completed",
        resultMessageId: reply.msgId,
      }, this.now());
      recovered.push({ attemptId: row.attempt_id, msgId: reply.msgId });
    }
    return recovered;
  }

  async cancel({ graceMs = this.terminateGraceMs } = {}) {
    if (!this.currentChild || this.currentChild.exitCode != null) return false;
    const child = this.currentChild;
    await new Promise((resolve) => {
      let settled = false;
      let force = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (force) clearTimeout(force);
        resolve();
      };
      child.once("close", finish);
      child.kill("SIGTERM");
      force = setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        finish();
      }, graceMs);
    });
    return true;
  }

  shutdown() {
    this.stopHeartbeat();
    const binding = this.bindingId ? this.bindingStore.get(this.bindingId) : null;
    if (!binding) return 0;
    return this.bindingStore.markOffline({
      bindingId: binding.bindingId,
      ownerGeneration: binding.runtimeGeneration,
      fencingToken: binding.leaseToken,
      fencingEpoch: binding.fencingEpoch,
    }, this.now());
  }
}
