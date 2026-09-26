import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CODEX_APP_SERVER_KIND,
  CODEX_APP_SERVER_MEMBER_SLOT,
  RUNTIME_CAPABILITIES,
  ClaudeOneShotRuntimeAdapter,
  CodexAppServerRuntimeAdapter,
  CursorAcpRuntimeAdapter,
} from "../scripts/agent-runtime-adapter.mjs";
import { AgentRuntimeRegistry } from "../scripts/agent-runtime-registry.mjs";
import { CLAUDE_AUTO_MEMBER_SLOT, CLAUDE_ONE_SHOT_KIND } from "../scripts/claude-one-shot-runtime.mjs";
import { CURSOR_ACP_KIND, CURSOR_ACP_MEMBER_SLOT } from "../scripts/cursor-acp-runtime.mjs";
import { CodexAppServerClient, createCodexAppServerInjector } from "../scripts/codex-app-server-wake.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";

const methods = ["start", "executeTurn", "cancel", "health", "shutdown"];
const makeRuntime = (label) => ({
  started: 0, turns: [], cancelled: 0, stopped: 0,
  start(options) { this.started++; return { label, options }; },
  async executeTurn(payload, dispatch) { this.turns.push({ payload, dispatch }); return { status: "completed", label }; },
  async cancel() { this.cancelled++; return true; },
  health() { return { healthy: true, label }; },
  async recoverCompletedReplies() { return []; },
  async shutdown() { this.stopped++; },
});

test("all runtime kinds expose one explicit capability shape", () => {
  const keys = Object.keys(RUNTIME_CAPABILITIES[CLAUDE_ONE_SHOT_KIND]);
  for (const kind of [CLAUDE_ONE_SHOT_KIND, CODEX_APP_SERVER_KIND, CURSOR_ACP_KIND]) {
    assert.deepEqual(Object.keys(RUNTIME_CAPABILITIES[kind]), keys);
    assert.ok(keys.every((key) => typeof RUNTIME_CAPABILITIES[kind][key] === "boolean"));
  }
  assert.equal(RUNTIME_CAPABILITIES[CLAUDE_ONE_SHOT_KIND].processingStartedReceipt, false);
  assert.equal(RUNTIME_CAPABILITIES[CODEX_APP_SERVER_KIND].processingStartedReceipt, false);
  assert.equal(RUNTIME_CAPABILITIES[CURSOR_ACP_KIND].sessionResumeAcrossProcessRestart, false);
});

test("thin Claude and Cursor adapters satisfy the common lifecycle contract", async () => {
  for (const Adapter of [ClaudeOneShotRuntimeAdapter, CursorAcpRuntimeAdapter]) {
    const runtime = makeRuntime(Adapter.name);
    const adapter = new Adapter(runtime);
    for (const method of methods) assert.equal(typeof adapter[method], "function", `${Adapter.name}.${method}`);
    adapter.start({ bindingId: "binding" });
    assert.equal((await adapter.executeTurn({ msgId: "m" }, { memberSlot: adapter.memberSlot })).status, "completed");
    assert.equal((await adapter.cancel()), true);
    assert.equal(adapter.health().healthy, true);
    await adapter.shutdown();
    assert.deepEqual([runtime.started, runtime.turns.length, runtime.cancelled, runtime.stopped], [1, 1, 1, 1]);
  }
});

test("registry routes three independent member slots and never falls back", async () => {
  const calls = [];
  const adapter = (runtimeKind, memberSlot) => ({ runtimeKind, memberSlot,
    capabilities: RUNTIME_CAPABILITIES[runtimeKind],
    executeTurn: async (payload) => { calls.push([runtimeKind, payload.msgId]); return { status: "completed" }; },
    health: () => ({ healthy: true }), cancel: async () => false, shutdown: async () => {},
    recoverCompletedReplies: async () => [] });
  const registry = new AgentRuntimeRegistry([
    adapter(CLAUDE_ONE_SHOT_KIND, CLAUDE_AUTO_MEMBER_SLOT),
    adapter(CODEX_APP_SERVER_KIND, CODEX_APP_SERVER_MEMBER_SLOT),
    adapter(CURSOR_ACP_KIND, CURSOR_ACP_MEMBER_SLOT),
  ]);
  await registry.executeTurn({ msgId: "c1" }, { memberSlot: CLAUDE_AUTO_MEMBER_SLOT });
  await registry.executeTurn({ msgId: "c2" }, { memberSlot: CODEX_APP_SERVER_MEMBER_SLOT });
  await registry.executeTurn({ msgId: "c3" }, { memberSlot: CURSOR_ACP_MEMBER_SLOT });
  assert.deepEqual(calls, [[CLAUDE_ONE_SHOT_KIND, "c1"], [CODEX_APP_SERVER_KIND, "c2"], [CURSOR_ACP_KIND, "c3"]]);
  await assert.rejects(registry.executeTurn({ msgId: "bad" }, { memberSlot: "unknown:slot" }),
    /runtime-adapter-unavailable:unknown:slot/);
  assert.equal(calls.length, 3);
});

test("registry rejects ambiguous runtime kinds and member slots", () => {
  const runtime = makeRuntime("x");
  const claude = new ClaudeOneShotRuntimeAdapter(runtime);
  const registry = new AgentRuntimeRegistry([claude]);
  assert.throws(() => registry.register(new ClaudeOneShotRuntimeAdapter(makeRuntime("y"))), /kind-duplicate/);
  assert.throws(() => registry.register({ runtimeKind: "other", memberSlot: CLAUDE_AUTO_MEMBER_SLOT }), /slot-duplicate/);
});

test("Codex adapter completes without a started event, preserves correlation and returns idle", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-adapter-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const replies = [];
  const peer = { socketPath: path.join(dir, "app-server.sock") };
  writeFileSync(peer.socketPath, "");
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer,
    injector: async (_payload, runtimePeer, processing) => {
      runtimePeer.threadId = "thread-1";
      assert.equal(processing.started, undefined);
      processing.completed({ sessionId: "turn-1" });
      return { turnId: "turn-1", finalText: "codex answer" };
    },
    sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; },
    heartbeatIntervalMs: 10,
  });
  try {
    adapter.start({ bindingId: "codex-binding", runtimeGeneration: 2, leaseTtlMs: 1_000 });
    const payload = { msgId: "request-1", from: "claude-agent", conversationId: "conv", text: "hello",
      memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    const result = await adapter.executeTurn(payload, dispatchStore.claimDue());
    assert.equal(result.status, "completed");
    assert.equal(bindingStore.get("codex-binding").state, "BOUND_IDLE");
    assert.equal(bindingStore.get("codex-binding").runtimeSessionId, null);
    const receipt = dispatchStore.getProcessingAttempt(result.attemptId);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.startedAt, null);
    assert.equal(replies[0].replyToMessageId, "request-1");
    assert.equal(replies[0].msgId, result.attemptId);
    assert.equal(adapter.health().external.owned, false);
    assert.equal(await adapter.cancel(), false);
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex thread affinity is isolated by sender and conversation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-routes-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock"); writeFileSync(socketPath, "");
  const routes = []; const memory = new Map(); let nextThread = 0; let invalidThread = null;
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath },
    injector: async (payload, peer, processing) => {
      if (!peer.threadId) peer.threadId = `thread-${++nextThread}`;
      if (peer.threadId === invalidThread) peer.threadId = `thread-${++nextThread}`;
      if (payload.text.startsWith("remember ")) memory.set(peer.threadId, payload.text.slice(9));
      routes.push({ from: payload.from, conversationId: payload.conversationId, threadId: peer.threadId });
      processing.completed({ sessionId: `turn-${payload.msgId}` });
      return { turnId: `turn-${payload.msgId}`, finalText: memory.get(peer.threadId) || "none" };
    }, sendReply: async (reply) => ({ ...reply, msgId: reply.msgId }) });
  const run = async (msgId, from, conversationId, text) => {
    const payload = { msgId, from, conversationId, text, memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    return adapter.executeTurn(payload, dispatchStore.claimDue());
  };
  try {
    adapter.start({ bindingId: "binding", leaseTtlMs: 1_000 });
    await run("a1", "sender-a", "shared", "remember ALPHA");
    await run("b1", "sender-b", "shared", "remember BETA");
    const a2 = await run("a2", "sender-a", "shared", "recall");
    const b2 = await run("b2", "sender-b", "shared", "recall");
    invalidThread = routes[0].threadId;
    await run("a3", "sender-a", "shared", "recall");
    await run("b3", "sender-b", "shared", "recall");
    await run("a-other", "sender-a", "other", "recall");
    assert.equal(routes[0].threadId, routes[2].threadId);
    assert.equal(routes[1].threadId, routes[3].threadId);
    assert.notEqual(routes[0].threadId, routes[1].threadId);
    assert.notEqual(routes[0].threadId, routes[4].threadId);
    assert.equal(routes[1].threadId, routes[5].threadId);
    assert.notEqual(routes[0].threadId, routes[6].threadId);
    assert.equal(a2.reply.text, "ALPHA");
    assert.equal(b2.reply.text, "BETA");
    assert.equal(nextThread, 4);
    assert.equal(adapter.health().external.conversationSessions, 3);
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("external App Server generation replacement invalidates threads without daemon restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-restart-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock"); writeFileSync(socketPath, "");
  let serverIdentity = "server-1"; let nextThread = 0; const usedThreads = []; const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath },
    readServerIdentity: () => serverIdentity,
    injector: async (payload, peer, processing) => {
      if (!peer.threadId) peer.threadId = `${serverIdentity}-thread-${++nextThread}`;
      usedThreads.push(peer.threadId); processing.completed({ sessionId: `turn-${payload.msgId}` });
      return { turnId: `turn-${payload.msgId}`, finalText: `reply-${payload.msgId}` };
    }, sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; } });
  const run = async (msgId) => {
    const payload = { msgId, from: "sender-a", conversationId: "conv-a", text: "hello",
      memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    return adapter.executeTurn(payload, dispatchStore.claimDue());
  };
  try {
    adapter.start({ bindingId: "binding", leaseTtlMs: 1_000 });
    const first = await run("turn-1"); serverIdentity = "server-2"; const second = await run("turn-2");
    assert.equal(first.status, "completed"); assert.equal(second.status, "completed");
    assert.notEqual(usedThreads[0], usedThreads[1]);
    assert.equal(usedThreads[1], "server-2-thread-2");
    assert.equal(dispatchStore.getProcessingAttempt(second.attemptId).metadata.runtimeSessionId, usedThreads[1]);
    assert.equal(replies[1].replyToMessageId, "turn-2");
    assert.equal(bindingStore.get("binding").state, "BOUND_IDLE");
    assert.equal(bindingStore.get("binding").runtimeSessionId, null);
    assert.equal(adapter.health().external.serverGeneration, 2);
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("mid-turn App Server replacement cannot complete or reply and retry uses the new generation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-mid-turn-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock"); writeFileSync(socketPath, "");
  let serverIdentity = "server-1"; let releaseOldTurn; let calls = 0; const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath }, retryDelayMs: 0,
    readServerIdentity: () => serverIdentity,
    injector: async (payload, peer, processing) => {
      calls++; peer.threadId ||= `${serverIdentity}-thread`;
      if (calls === 1) return new Promise((resolve) => { releaseOldTurn = () => {
        processing.completed({ sessionId: "old-turn" });
        resolve({ turnId: "old-turn", finalText: "stale result" });
      }; });
      processing.completed({ sessionId: "new-turn" });
      return { turnId: "new-turn", finalText: "fresh result" };
    }, sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; } });
  try {
    adapter.start({ bindingId: "binding", leaseTtlMs: 1_000 });
    const payload = { msgId: "request", from: "sender", conversationId: "conv", text: "hello",
      memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    const oldExecution = adapter.executeTurn(payload, dispatchStore.claimDue());
    while (!releaseOldTurn) await new Promise((resolve) => setImmediate(resolve));
    serverIdentity = "server-2"; releaseOldTurn();
    const oldResult = await oldExecution;
    const oldAttempt = dispatchStore.latestProcessingAttempt(dispatchStore.get(payload));
    assert.equal(oldResult.status, "unknown");
    assert.equal(oldAttempt.status, "created");
    assert.equal(replies.length, 0);
    assert.equal(dispatchStore.get(payload).state, "failed");
    const retry = dispatchStore.claimDue(Date.now() + 100);
    const freshResult = await adapter.executeTurn(payload, retry);
    assert.equal(freshResult.status, "completed");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].replyToMessageId, "request");
    assert.equal(dispatchStore.getProcessingAttempt(freshResult.attemptId).status, "completed");
    assert.equal(bindingStore.get("binding").state, "BOUND_IDLE");
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex stale generation cannot record late completion, reply, or idle replacement", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-fence-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock"); writeFileSync(socketPath, "");
  const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath },
    injector: async (_payload, peer, processing) => {
      peer.threadId = "old-thread";
      bindingStore.replace("old-binding", { bindingId: "replacement", state: "BOUND_IDLE" });
      processing.completed({ sessionId: "late-turn" });
      return { turnId: "late-turn", finalText: "must not escape" };
    }, sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; } });
  try {
    adapter.start({ bindingId: "old-binding", runtimeGeneration: 2, leaseTtlMs: 1_000 });
    const payload = { msgId: "stale-request", from: "peer", conversationId: "conv", text: "hello",
      memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload); const dispatch = dispatchStore.claimDue();
    const result = await adapter.executeTurn(payload, dispatch);
    assert.equal(result.status, "late-result-dropped");
    const attempts = dispatchStore.listProcessingAttempts(dispatch);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "created");
    assert.equal(attempts[0].sessionId, null);
    assert.equal(replies.length, 0);
    assert.equal(bindingStore.get("replacement").state, "BOUND_IDLE");
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex completed receipt contains recovery metadata before reply failure", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-recovery-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock"); writeFileSync(socketPath, "");
  let turns = 0; let sends = 0; const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath },
    injector: async (_payload, peer, processing) => {
      turns++; peer.threadId = "thread-recovery";
      processing.completed({ sessionId: "turn-recovery" });
      return { turnId: "turn-recovery", finalText: "recover me" };
    }, sendReply: async (reply) => {
      sends++; if (sends === 1) throw new Error("outbox-down");
      replies.push(reply); return { msgId: reply.msgId };
    } });
  try {
    adapter.start({ bindingId: "binding", runtimeGeneration: 1, leaseTtlMs: 1_000 });
    const payload = { msgId: "recover-request", from: "peer", conversationId: "recover-conv", text: "hello",
      memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload); const result = await adapter.executeTurn(payload, dispatchStore.claimDue());
    assert.equal(result.status, "completed-reply-pending");
    const receipt = dispatchStore.getProcessingAttempt(result.attemptId);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(receipt.metadata, { resultText: "recover me", conversationId: "recover-conv",
      recipient: "peer", replyToMessageId: "recover-request", runtimeSessionId: "thread-recovery" });
    assert.equal((await adapter.recoverCompletedReplies()).length, 1);
    assert.equal(turns, 1);
    assert.deepEqual(replies[0], { msgId: result.attemptId, to: "peer", conversationId: "recover-conv",
      replyToMessageId: "recover-request", text: "recover me" });
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex adapter start fails cleanly when external socket is unavailable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-start-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent" });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath: path.join(dir, "missing.sock") },
    injector: async () => {}, sendReply: async () => {} });
  try {
    assert.throws(() => adapter.start({ bindingId: "must-not-exist" }), /codex-app-server-socket-unavailable/);
    assert.equal(bindingStore.get("must-not-exist"), null);
    assert.equal(dispatchStore.db.prepare("SELECT COUNT(*) count FROM processing_attempts").get().count, 0);
  } finally { bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real-order turn/started stays diagnostic while Codex receipt moves created to completed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-real-order-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock"); writeFileSync(socketPath, "");
  let attemptExistedBeforeStart = false;
  class RealOrderWebSocket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit("open")); }
    send(raw) {
      const request = JSON.parse(raw);
      const emit = (message) => this.emit("message", Buffer.from(JSON.stringify(message)));
      if (request.method === "initialize") queueMicrotask(() => emit({ id: request.id, result: {} }));
      if (request.method === "thread/start") queueMicrotask(() => emit({ id: request.id,
        result: { thread: { id: "thread-real-order", path: null } } }));
      if (request.method === "turn/start") queueMicrotask(() => {
        attemptExistedBeforeStart = dispatchStore.db.prepare("SELECT COUNT(*) n FROM processing_attempts").get().n === 1;
        const threadId = request.params.threadId; const turnId = "turn-real-order";
        emit({ id: request.id, result: { turn: { id: turnId } } });
        emit({ method: "thread/status/changed", params: { threadId, status: { type: "active" } } });
        emit({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
        emit({ method: "item/started", params: { threadId, turnId, item: { id: "u", type: "userMessage" } } });
        emit({ method: "item/completed", params: { threadId, turnId, item: { id: "u", type: "userMessage" } } });
        emit({ method: "item/started", params: { threadId, turnId, item: { id: "a", type: "agentMessage", phase: "final_answer" } } });
        emit({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "a", delta: "answer" } });
        emit({ method: "item/completed", params: { threadId, turnId,
          item: { id: "a", type: "agentMessage", phase: "final_answer", text: "integrated answer" } } });
        emit({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: {} } });
        emit({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
        emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      });
    }
    close() {}
  }
  class RealOrderClient extends CodexAppServerClient {
    constructor(options) { super({ ...options, WebSocketImpl: RealOrderWebSocket }); }
  }
  const diagnostics = []; const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({ bindingStore, dispatchStore,
    agentId: "codex-agent", projectId: "project", peer: { socketPath, protocolDiagnostics: true },
    injector: createCodexAppServerInjector({ Client: RealOrderClient,
      log: (_level, _message, data) => diagnostics.push(data) }),
    sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; } });
  try {
    adapter.start({ bindingId: "binding", runtimeGeneration: 1, leaseTtlMs: 1_000 });
    const payload = { msgId: "integrated-request", from: "peer", conversationId: "conv", text: "hello",
      memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload); const result = await adapter.executeTurn(payload, dispatchStore.claimDue());
    const receipt = dispatchStore.getProcessingAttempt(result.attemptId);
    assert.equal(attemptExistedBeforeStart, true);
    assert.equal(receipt.startedAt, null);
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.metadata.resultText, "integrated answer");
    assert.equal(replies[0].replyToMessageId, "integrated-request");
    assert.ok(diagnostics.some((event) => event.method === "turn/started"
      && event.threadId === "thread-real-order" && event.turnId === "turn-real-order"));
    assert.ok(diagnostics.some((event) => event.method === "turn/completion-source"
      && event.source === "app-server-events"));
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});
