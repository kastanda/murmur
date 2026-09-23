import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { CURSOR_ACP_KIND, CURSOR_ACP_MEMBER_SLOT, CursorAcpClient, CursorAcpRuntime,
  normalizeCursorAcpRuntimeConfig } from "../scripts/cursor-acp-runtime.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";
import { SQLiteDedupeOutboxStore, SQLiteMessageStore } from "../packages/core/dist/src/index.js";

class FakeAcpClient {
  constructor({ results = [], failBeforeSubmit = null, failAfterSubmit = null } = {}) {
    this.results = [...results];
    this.failBeforeSubmit = failBeforeSubmit;
    this.failAfterSubmit = failAfterSubmit;
    this.sessions = new Set();
    this.turns = [];
    this.running = false;
    this.cancelled = 0;
  }
  async start() { this.running = true; return { pid: 4321, processStartIdentity: "4321:test" }; }
  health() { return { healthy: this.running, pid: 4321, sessionIds: [...this.sessions] }; }
  async createSession() { const id = "cursor-session-1"; this.sessions.add(id); return id; }
  async loadSession(id) { this.sessions.add(id); return id; }
  async executeTurn(options) {
    if (this.failBeforeSubmit) throw this.failBeforeSubmit;
    this.turns.push(options);
    options.onSubmitted();
    options.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "chunk" } });
    if (this.failAfterSubmit) throw this.failAfterSubmit;
    const result = this.results.shift() || { text: `answer:${options.prompt}`, sessionId: options.sessionId,
      stopReason: "end_turn" };
    return { ...result, sessionId: options.sessionId };
  }
  async cancel() { this.cancelled += 1; return true; }
  async shutdown() { this.running = false; return true; }
}

const contexts = [];
test.afterEach(async () => {
  while (contexts.length) {
    const ctx = contexts.pop();
    await ctx.runtime.shutdown();
    ctx.bindingStore.close();
    ctx.dispatchStore.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("Cursor ACP runtime is disabled unless explicitly enabled", () => {
  assert.equal(normalizeCursorAcpRuntimeConfig().enabled, false);
  assert.equal(normalizeCursorAcpRuntimeConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeCursorAcpRuntimeConfig({ enabled: true }).enabled, true);
});

test("real stdio client negotiates ACP, forces ask mode, and collects terminal text", async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "fake-cursor-acp.mjs");
  const client = new CursorAcpClient({ command: process.execPath, args: [fixture], cwd: process.cwd(),
    startupTimeoutMs: 1_000, turnTimeoutMs: 1_000, terminateGraceMs: 100, mode: "ask" });
  try {
    const processInfo = await client.start();
    assert.ok(processInfo.pid > 0);
    const sessionId = await client.createSession();
    const updates = [];
    const result = await client.executeTurn({ sessionId, prompt: "hello",
      onSubmitted: () => {}, onUpdate: (update) => updates.push(update) });
    assert.equal(result.text, "fixture:hello");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(updates.length, 1);
  } finally { await client.shutdown(); }
});

test("stdio client timeout cancels and terminates its owned ACP child", async () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "fake-cursor-acp.mjs");
  const client = new CursorAcpClient({ command: process.execPath, args: [fixture], cwd: process.cwd(),
    startupTimeoutMs: 1_000, turnTimeoutMs: 20, terminateGraceMs: 100, mode: "ask" });
  await client.start(); const sessionId = await client.createSession(); const pid = client.child.pid;
  await assert.rejects(client.executeTurn({ sessionId, prompt: "HANG" }),
    (error) => error.message === "cursor-acp-turn-timeout" && error.outcomeUnknown === true);
  await delay(20);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

async function setup({ client = new FakeAcpClient(), sendReply, leaseTtlMs = 1_000,
  heartbeatIntervalMs = 10 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-cursor-acp-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "cursor-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const replies = [];
  const runtime = new CursorAcpRuntime({ bindingStore, dispatchStore, agentId: "cursor-agent",
    projectId: "project-a", cwd: dir, client, heartbeatIntervalMs, retryDelayMs: 1,
    sendReply: sendReply || (async (reply) => { replies.push(reply); return { msgId: reply.msgId }; }) });
  await runtime.start({ bindingId: "binding-a", runtimeGeneration: 7, leaseTtlMs });
  const ctx = { dir, dbPath, dispatchStore, bindingStore, runtime, client, replies };
  contexts.push(ctx);
  return ctx;
}

function claim(ctx, { msgId = "msg-1", conversationId = "conv-1", text = "hello", from = "claude" } = {}) {
  const payload = { msgId, conversationId, text, from, memberSlot: CURSOR_ACP_MEMBER_SLOT };
  ctx.dispatchStore.enqueue(payload);
  return { payload, dispatch: ctx.dispatchStore.claimDue() };
}

test("runtime is an explicit cursor:acp binding and records owned process identity", async () => {
  const ctx = await setup();
  const binding = ctx.bindingStore.get("binding-a");
  assert.equal(CURSOR_ACP_KIND, "cursor_acp");
  assert.equal(binding.memberSlot, "cursor:acp");
  assert.equal(binding.state, "BOUND_IDLE");
  assert.equal(binding.pid, 4321);
  assert.equal(binding.runtimeSessionId, null);
});

test("first turn creates and confirms an ACP session", async () => {
  const ctx = await setup();
  const turn = claim(ctx);
  const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(result.status, "completed");
  assert.equal(ctx.bindingStore.get("binding-a").runtimeSessionId, "cursor-session-1");
  assert.equal(ctx.client.turns.length, 1);
});

test("second turn uses the same live ACP session and preserves context", async () => {
  let remembered;
  const client = new FakeAcpClient();
  client.executeTurn = async (options) => {
    client.turns.push(options); options.onSubmitted();
    options.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "x" } });
    if (client.turns.length === 1) remembered = "NONCE-ACP";
    return { text: client.turns.length === 1 ? "stored" : remembered,
      sessionId: options.sessionId, stopReason: "end_turn" };
  };
  const ctx = await setup({ client });
  let turn = claim(ctx, { msgId: "turn-1", text: "remember nonce" });
  await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  turn = claim(ctx, { msgId: "turn-2", text: "what nonce?" });
  await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(client.turns[0].sessionId, client.turns[1].sessionId);
  assert.equal(ctx.replies.at(-1).text, "NONCE-ACP");
});

test("ACP update produces started and terminal response produces completed", async () => {
  const ctx = await setup();
  const turn = claim(ctx);
  const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  const attempt = ctx.dispatchStore.getProcessingAttempt(result.attemptId);
  assert.equal(attempt.status, "completed");
  assert.ok(attempt.startedAt);
  assert.ok(attempt.completedAt);
});

test("reply is exact, correlated, deterministic, and independent from completion", async () => {
  const ctx = await setup(); const turn = claim(ctx);
  const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(ctx.replies[0].msgId, result.attemptId);
  assert.equal(ctx.replies[0].replyToMessageId, turn.payload.msgId);
  assert.equal(ctx.replies[0].conversationId, turn.payload.conversationId);
  assert.equal(ctx.dispatchStore.getProcessingAttempt(result.attemptId).resultMessageId, result.attemptId);
});

test("completed plus reply failure retries only reply and never ACP turn", async () => {
  let sends = 0;
  const ctx = await setup({ sendReply: async (reply) => { if (++sends === 1) throw new Error("outbox-down"); return { msgId: reply.msgId }; } });
  const turn = claim(ctx); const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(result.status, "completed-reply-pending");
  assert.equal(ctx.client.turns.length, 1);
  assert.equal((await ctx.runtime.recoverCompletedReplies()).length, 1);
  assert.equal(ctx.client.turns.length, 1);
});

test("reply recovery stays idempotent in outbox and local mirror", async () => {
  const ctx = await setup(); const outbox = new SQLiteDedupeOutboxStore(ctx.dbPath);
  const messages = new SQLiteMessageStore(ctx.dbPath);
  ctx.runtime.sendReply = async (reply) => {
    await outbox.enqueue("reply.subject", { schemaVersion: "1.0", msgId: reply.msgId,
      conversationId: reply.conversationId, replyToMessageId: reply.replyToMessageId,
      senderAgentId: "cursor-agent", recipients: [reply.to], createdAt: new Date().toISOString(),
      payloadCiphertext: "test", payloadNonce: "test", signature: "test" });
    await messages.appendIdempotent({ conversationId: reply.conversationId, msgId: reply.msgId,
      replyToMessageId: reply.replyToMessageId, direction: "outbound", sender: "cursor-agent",
      text: reply.text, createdAt: new Date().toISOString(), transport: "nats" });
    return { msgId: reply.msgId };
  };
  const turn = claim(ctx); const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  ctx.dispatchStore.db.prepare("UPDATE processing_attempts SET result_message_id = NULL WHERE attempt_id = ?").run(result.attemptId);
  await ctx.runtime.recoverCompletedReplies();
  const counts = ctx.dispatchStore.db.prepare(`SELECT
    (SELECT COUNT(*) FROM outbox WHERE msg_id=?) outbox_count,
    (SELECT COUNT(*) FROM local_messages WHERE direction='outbound' AND msg_id=?) message_count`)
    .get(result.attemptId, result.attemptId);
  assert.deepEqual({ ...counts }, { outbox_count: 1, message_count: 1 });
  assert.equal(ctx.client.turns.length, 1);
});

test("crash before prompt submission creates no receipt and is safely reassignable", async () => {
  const ctx = await setup({ client: new FakeAcpClient({ failBeforeSubmit: new Error("before-submit") }) });
  const turn = claim(ctx); const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(result.status, "failed");
  assert.equal(ctx.dispatchStore.listProcessingAttempts(turn.dispatch).length, 0);
  assert.equal(ctx.dispatchStore.get(turn.dispatch).ownerBindingId, null);
  assert.equal(ctx.dispatchStore.get(turn.dispatch).attempts, 0);
});

test("disconnect after submission keeps unknown outcome honest", async () => {
  const error = new Error("transport-disconnected"); error.outcomeUnknown = true;
  const ctx = await setup({ client: new FakeAcpClient({ failAfterSubmit: error }) });
  const turn = claim(ctx); const result = await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(result.status, "unknown");
  assert.equal(ctx.dispatchStore.listProcessingAttempts(turn.dispatch)[0].status, "started");
  assert.equal(ctx.dispatchStore.get(turn.dispatch).ownerBindingId, null);
});

test("durable completed suppresses turn replay", async () => {
  const ctx = await setup({ sendReply: async () => { throw new Error("down"); } });
  const turn = claim(ctx); await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  assert.equal(ctx.dispatchStore.claimDue(), null);
  assert.equal(ctx.client.turns.length, 1);
});

test("late old-generation result cannot complete or reply", async () => {
  let release;
  const client = new FakeAcpClient();
  client.executeTurn = (options) => new Promise((resolve) => {
    client.turns.push(options); options.onSubmitted();
    release = () => resolve({ text: "late", sessionId: options.sessionId, stopReason: "end_turn" });
  });
  const ctx = await setup({ client, leaseTtlMs: 20, heartbeatIntervalMs: 5 });
  const turn = claim(ctx); const pending = ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  await delay(5); ctx.runtime.stopHeartbeat();
  ctx.bindingStore.expireRoute({ agentId: "cursor-agent", projectId: "project-a",
    memberSlot: CURSOR_ACP_MEMBER_SLOT, runtimeKind: CURSOR_ACP_KIND }, Date.now());
  ctx.bindingStore.reconcileStale({ now: Date.now() }); release();
  assert.equal((await pending).status, "late-result-dropped");
  assert.equal(ctx.replies.length, 0);
});

test("idle heartbeat keeps binding assignable beyond TTL", async () => {
  const ctx = await setup({ leaseTtlMs: 25, heartbeatIntervalMs: 5 });
  await delay(70); assert.deepEqual(ctx.bindingStore.reconcileStale({ now: Date.now() }), []);
  const turn = claim(ctx, { msgId: "after-idle" });
  assert.equal((await ctx.runtime.executeTurn(turn.payload, turn.dispatch)).status, "completed");
});

test("active turn heartbeat survives beyond TTL", async () => {
  const client = new FakeAcpClient();
  client.executeTurn = async (options) => { client.turns.push(options); options.onSubmitted();
    await delay(60); options.onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "ok" } });
    return { text: "ok", sessionId: options.sessionId, stopReason: "end_turn" }; };
  const ctx = await setup({ client, leaseTtlMs: 25, heartbeatIntervalMs: 5 });
  const turn = claim(ctx); const pending = ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  await delay(40); assert.deepEqual(ctx.bindingStore.reconcileStale({ now: Date.now() }), []);
  assert.equal((await pending).status, "completed");
});

test("routing isolation assigns cursor:acp and not another binding", async () => {
  const ctx = await setup();
  ctx.bindingStore.register({ bindingId: "other", agentId: "cursor-agent", runtimeKind: "manual",
    runtimeGeneration: 1, projectId: "project-a", memberSlot: "cursor:manual", state: "BOUND_IDLE" });
  const messages = new SQLiteMessageStore(ctx.dbPath);
  const monitor = new WakeMonitor({ dispatchStore: ctx.dispatchStore,
    runtimeDispatcher: (payload, dispatch) => ctx.runtime.executeTurn(payload, dispatch) });
  const inbound = { msgId: "isolated", conversationId: "conv", from: "claude", text: "run",
    memberSlot: CURSOR_ACP_MEMBER_SLOT };
  await messages.append({ conversationId: inbound.conversationId, msgId: inbound.msgId,
    direction: "inbound", sender: inbound.from, text: inbound.text,
    createdAt: new Date().toISOString(), memberSlot: inbound.memberSlot });
  await monitor.onInbound(inbound);
  assert.equal(ctx.bindingStore.get("binding-a").lastAssignedMessageId, "isolated");
  assert.equal(ctx.bindingStore.get("other").lastAssignedMessageId, null);
});

test("explicit cancellation delegates to owned ACP process", async () => {
  const ctx = await setup(); assert.equal(await ctx.runtime.cancel(), true); assert.equal(ctx.client.cancelled, 1);
});

test("shutdown marks binding offline and stops heartbeat/process", async () => {
  const ctx = await setup({ leaseTtlMs: 25, heartbeatIntervalMs: 5 });
  await ctx.runtime.shutdown(); const at = ctx.bindingStore.get("binding-a").lastHeartbeat;
  await delay(30); assert.equal(ctx.bindingStore.get("binding-a").state, "OFFLINE");
  assert.equal(ctx.bindingStore.get("binding-a").lastHeartbeat, at);
  assert.equal(ctx.client.health().healthy, false);
});

test("runtime session identity survives store reopen but process restart continuity is not claimed", async () => {
  const ctx = await setup(); const turn = claim(ctx); await ctx.runtime.executeTurn(turn.payload, turn.dispatch);
  const reopened = new RuntimeBindingStore(ctx.dbPath);
  try { assert.equal(reopened.get("binding-a").runtimeSessionId, "cursor-session-1");
    assert.equal(reopened.get("binding-a").metadata.restartContinuity, false); } finally { reopened.close(); }
});
