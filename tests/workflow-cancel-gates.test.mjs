/**
 * workflow-cancel-gates.test.mjs — what a durable cancel intent actually STOPS, against the
 * real fenced runtime stack (real stores, real controller/coordinator, recording transport).
 * Message ids are synthetic.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { derivedHandoffConversationId, SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";
import { AgentHandoffController } from "../scripts/agent-handoff-controller.mjs";
import { AgentHandoffStore } from "../scripts/agent-handoff-store.mjs";
import { HandoffTurnCoordinator, settleRuntimeTurn } from "../scripts/agent-handoff-runtime.mjs";
import { CODEX_APP_SERVER_MEMBER_SLOT, CodexAppServerRuntimeAdapter } from "../scripts/agent-runtime-adapter.mjs";
import { CLAUDE_AUTO_MEMBER_SLOT, ClaudeOneShotRuntime } from "../scripts/claude-one-shot-runtime.mjs";
import { CursorAcpClient } from "../scripts/cursor-acp-runtime.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { recordCancelRequest } from "../scripts/workflow-control.mjs";
import { DatabaseSync } from "node:sqlite";
import { claimFencedDispatch, createHandoffDatabase, enqueuedEnvelopes, registerIdleBinding } from "./fixtures/handoff-fence.mjs";

const AGENT = "claude-agent";
const TARGET = "codex-agent";
const ROOT = "root-message-0001";
const OTHER_ROOT = "root-message-0002";
const IGNORED = "ignored_due_to_cancelled_workflow";
const handoffAction = (to, task) => JSON.stringify({ murmur: { action: "handoff", to, task } });
const peer = (agentId) => ({
  encryption: { publicKey: `enc-${agentId}` }, signing: { publicKey: `sig-${agentId}` },
  subject: `msg.${agentId}`, protocolVersions: ["1.0", "1.1"], features: ["handoff-v1"],
});

const contexts = [];
test.afterEach(async () => {
  while (contexts.length) {
    const ctx = contexts.pop();
    await ctx.teardown();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

function harness({ script = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-cancel-gates-"));
  const db = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(db, { recipientId: AGENT, maxAttempts: 3 });
  const outboxStore = new SQLiteDedupeOutboxStore(db);
  const bindingStore = new RuntimeBindingStore(db);
  const handoffStore = new AgentHandoffStore(db);
  let counter = 0;
  const controller = new AgentHandoffController({
    store: handoffStore, agentId: AGENT, peers: { [TARGET]: peer(TARGET) },
    buildHandoffEnvelope: async ({ msgId, to, subject, conversationId, handoff, text }) => ({
      subject,
      envelope: {
        schemaVersion: "1.1", msgId, conversationId, senderAgentId: AGENT, recipients: [to],
        createdAt: "2026-09-26T00:00:00.000Z", payloadCiphertext: Buffer.from(text).toString("base64"),
        payloadNonce: "n", handoff, signature: "s",
      },
    }),
    newMsgId: () => `handoff-msg-${++counter}`,
  });
  const coordinator = new HandoffTurnCoordinator({ controller });
  const replies = [];
  const runs = [];
  const queue = [...script];
  const runner = async ({ prompt, sessionId, onSpawn }) => {
    runs.push({ prompt, activeRoot: runtime.activeRootMessageId });
    onSpawn({ pid: 100, processStartIdentity: "100:1" });
    const next = queue.shift();
    if (typeof next === "function") return next({ sessionId });
    return { text: next ?? `answer:${prompt}`, sessionId };
  };
  const runtime = new ClaudeOneShotRuntime({
    bindingStore, dispatchStore, agentId: AGENT, projectId: "project-a", cwd: dir, runner,
    sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; },
    handoff: coordinator, heartbeatIntervalMs: 10, retryDelayMs: 1,
  });
  runtime.start({ bindingId: "binding-a", runtimeGeneration: 7, leaseTtlMs: 1_000 });
  const ctx = {
    dir, db, dispatchStore, bindingStore, handoffStore, outboxStore, runtime, coordinator, replies, runs,
    cancel: (root = ROOT, messageIds = []) => {
      const raw = new DatabaseSync(db);
      try { return recordCancelRequest(raw, root, { messageIds }); } finally { raw.close(); }
    },
    claim: ({ msgId = ROOT, from = "human-agent", conversationId = "conv-root", text = "root request", replyToMessageId, handoff } = {}) => {
      const payload = { msgId, from, conversationId, text, memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
        ...(replyToMessageId ? { replyToMessageId } : {}), ...(handoff ? { handoff } : {}) };
      dispatchStore.enqueue(payload);
      return { payload, dispatch: dispatchStore.claimDue() };
    },
    teardown: async () => { runtime.shutdown(); handoffStore.close(); bindingStore.close(); dispatchStore.close(); },
  };
  contexts.push(ctx);
  return ctx;
}

const openHandoff = (ctx, { root = ROOT, id = "handoff-open-001" } = {}) => ctx.handoffStore.createOrReuse({
  handoffMsgId: id, delegatorId: AGENT, recipientId: TARGET, causedByMessageId: `cause-${id}`,
  rootMessageId: root, rootConversationId: "conv-root", handoffConversationId: derivedHandoffConversationId(id),
  parentActiveAncestry: [], handoffAncestry: [AGENT], originatingBindingId: "binding-a", originatingBindingGeneration: 7,
  originatingRuntimeKind: "claude_one_shot", originatingMemberSlot: CLAUDE_AUTO_MEMBER_SLOT,
  originatingRuntimeSessionId: "sess-1", parentMessageId: root, parentConversationId: "conv-root",
  parentSenderId: "human-agent", taskText: "bounded task",
}).handoff;

// ---------------------------------------------------------------------------

test("a queued root task of a cancelled workflow never reaches the model: terminal with the audit disposition", async () => {
  const ctx = harness();
  ctx.cancel();
  const { payload, dispatch } = ctx.claim();
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, IGNORED);
  assert.equal(ctx.runs.length, 0, "no model turn started");
  const row = ctx.dispatchStore.get(dispatch);
  assert.equal(row.state, "terminal");
  assert.equal(row.lastError, IGNORED);
  assert.equal(ctx.bindingStore.get("binding-a").state, "BOUND_IDLE", "the runtime is free for the next task");
  assert.deepEqual(ctx.replies, []);
});

test("a LATE child reply after cancellation stays in history but cannot resume or continue the workflow", async () => {
  const ctx = harness();
  const handoff = openHandoff(ctx);
  ctx.cancel(ROOT, [handoff.handoffMsgId]);
  const { payload, dispatch } = ctx.claim({
    msgId: "late-child-reply-01", from: TARGET, conversationId: handoff.handoffConversationId,
    text: "late result", replyToMessageId: handoff.handoffMsgId,
  });
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.reason, IGNORED);
  assert.equal(ctx.runs.length, 0, "the parent is not resumed");
  assert.deepEqual(ctx.replies, [], "nothing is relayed to root");
  assert.equal(ctx.handoffStore.listOpen().length, 0, "the continuation no longer waits");
  const kept = ctx.handoffStore.get(handoff.handoffMsgId);
  assert.equal(kept.state, "terminal");
  assert.equal(kept.terminalReason, "workflow-cancelled");
  assert.equal(ctx.dispatchStore.get(dispatch).lastError, IGNORED, "the late message is recorded, not pretended away");
  assert.equal(enqueuedEnvelopes(ctx.db).length, 0, "no new child was created");
});

test("a retry of the same delivery after cancellation cannot undo it", async () => {
  const ctx = harness();
  ctx.cancel();
  ctx.dispatchStore.enqueue({ msgId: ROOT, from: "human-agent", conversationId: "conv-root", text: "root request", memberSlot: CLAUDE_AUTO_MEMBER_SLOT });
  const raw = new DatabaseSync(ctx.db);
  raw.close();
  // the operator command retires the pending row; a transport redelivery must not revive it
  const second = new DatabaseSync(ctx.db);
  recordCancelRequest(second, ROOT, { messageIds: [ROOT] });
  second.close();
  ctx.dispatchStore.enqueue({ msgId: ROOT, from: "human-agent", conversationId: "conv-root", text: "root request", memberSlot: CLAUDE_AUTO_MEMBER_SLOT });
  assert.equal(ctx.dispatchStore.get({ msgId: ROOT, recipientId: AGENT, memberSlot: CLAUDE_AUTO_MEMBER_SLOT }).state, "rejected");
  assert.equal(ctx.dispatchStore.claimDue(), null, "nothing is claimable");
});

test("cancel DURING a turn: the finished result is suppressed (no reply to root) and the audit receipt keeps it", async () => {
  const ctx = harness({ script: [async () => { ctx.cancel(); return { text: "an answer nobody should receive", sessionId: "s" }; }] });
  const { payload, dispatch } = ctx.claim();
  // runner receives the real session id; return it through the scripted function
  ctx.runtime.runner = async ({ sessionId, onSpawn }) => {
    onSpawn({ pid: 1, processStartIdentity: "1:1" });
    assert.equal(ctx.runtime.activeRootMessageId, ROOT, "the daemon watcher can see which workflow is executing");
    ctx.cancel();
    return { text: "an answer nobody should receive", sessionId };
  };
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed-cancelled-workflow");
  assert.deepEqual(ctx.replies, []);
  assert.equal(ctx.dispatchStore.getProcessingAttempt(result.attemptId).metadata.disposition, IGNORED);
  assert.equal(ctx.bindingStore.get("binding-a").state, "BOUND_IDLE");
  assert.equal(ctx.runtime.activeRootMessageId, null, "cleared when the turn ends");
});

test("cancel DURING a turn that ends in a handoff: no child is created", async () => {
  const ctx = harness();
  const { payload, dispatch } = ctx.claim();
  ctx.runtime.runner = async ({ sessionId, onSpawn }) => {
    onSpawn({ pid: 1, processStartIdentity: "1:1" });
    ctx.cancel();
    return { text: handoffAction(TARGET, "do the thing"), sessionId };
  };
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed-cancelled-workflow");
  assert.equal(ctx.handoffStore.list().length, 0, "no continuation");
  assert.equal(enqueuedEnvelopes(ctx.db).length, 0, "no outbound handoff");
});

test("the fenced handoff create itself refuses once the intent exists (race between the check and the commit)", async () => {
  const db = createHandoffDatabase({ agentId: AGENT });
  contexts.push({ dir: db.dir, teardown: async () => db.close() });
  registerIdleBinding(db.bindingStore, { agentId: AGENT, now: 1_000 });
  const claimed = claimFencedDispatch(db, { agentId: AGENT, now: 1_000 });
  const raw = new DatabaseSync(db.dbPath);
  recordCancelRequest(raw, "root-1-cancelled", { messageIds: [] });
  raw.close();
  const record = (rootMessageId, id) => ({
    handoffMsgId: id, delegatorId: AGENT, recipientId: TARGET, causedByMessageId: `c-${id}`,
    rootMessageId, rootConversationId: "conv-root", handoffConversationId: derivedHandoffConversationId(id),
    parentActiveAncestry: [], handoffAncestry: [AGENT], originatingBindingId: "binding-a", originatingBindingGeneration: 1,
    originatingRuntimeKind: "claude_one_shot", originatingMemberSlot: "claude:auto", parentMessageId: rootMessageId,
    parentConversationId: "conv-root", parentSenderId: "human-agent", taskText: "t",
  });
  const refused = db.handoffStore.fencedCreate({ fence: claimed.fence, identity: claimed.identity, record: record("root-1-cancelled", "h-refused-01") });
  assert.deepEqual([refused.ok, refused.reason], [false, "workflow-cancelled"]);
  assert.equal(db.handoffStore.list().length, 0, "nothing was created");
  // another workflow is unaffected
  const allowed = db.handoffStore.fencedCreate({ fence: claimed.fence, identity: claimed.identity, record: record("root-2-live-flow", "h-allowed-01") });
  assert.equal(allowed.ok, true);
});

test("cancelling workflow A leaves workflow B's queued work, continuations and turns alone", async () => {
  const ctx = harness({ script: ["B-answer"] });
  const a = openHandoff(ctx, { root: ROOT, id: "handoff-a-0001" });
  const b = openHandoff(ctx, { root: OTHER_ROOT, id: "handoff-b-0001" });
  ctx.cancel(ROOT, [a.handoffMsgId]);
  const claimed = ctx.claim({ msgId: OTHER_ROOT, conversationId: "conv-b", text: "B root" });
  const result = await ctx.runtime.executeTurn(claimed.payload, claimed.dispatch);
  assert.equal(result.status, "completed");
  assert.equal(ctx.runs.length, 1);
  assert.equal(ctx.handoffStore.get(b.handoffMsgId).state, "open", "B's continuation is untouched");
});

test("interrupting the active turn signals ONLY that turn's child process", async () => {
  const ctx = harness();
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = (signal) => { signals.push(signal); setImmediate(() => { child.exitCode = 0; child.emit("close"); }); };
  ctx.runtime.currentChild = child;
  const interrupted = await ctx.runtime.interruptActiveTurn({ graceMs: 50 });
  assert.equal(interrupted, true);
  assert.deepEqual(signals, ["SIGTERM"], "one graceful signal to one child; no SIGKILL of anything else");
});

test("Codex: the active turn is interrupted by its exact thread + turn id; nothing else is touched", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-codex-cancel-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock");
  writeFileSync(socketPath, "");
  const interrupts = [];
  let release;
  let aborted = 0;
  let sawActive = null;
  const adapter = new CodexAppServerRuntimeAdapter({
    bindingStore, dispatchStore, agentId: "codex-agent", projectId: "project", peer: { socketPath },
    interruptTurn: async (ids) => { interrupts.push(ids); },
    injector: async (payload, peer, processing) => {
      peer.threadId ||= "thread-exact";
      processing.observeTurn({ sessionId: "turn-exact", threadId: "thread-exact", abort: () => { aborted += 1; release(); } });
      sawActive = adapter.activeRootMessageId;
      await new Promise((resolve) => { release = resolve; });
      processing.completed({ sessionId: "turn-exact" });
      return { turnId: "turn-exact", finalText: "ok" };
    },
    sendReply: async (reply) => ({ msgId: reply.msgId }),
  });
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    const payload = { msgId: "codex-root-msg-1", from: "claude-agent", conversationId: "c", text: "t", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    const running = adapter.executeTurn(payload, dispatchStore.claimDue());
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sawActive, "codex-root-msg-1");
    assert.equal(await adapter.interruptActiveTurn(), true);
    assert.deepEqual(interrupts, [{ threadId: "thread-exact", turnId: "turn-exact" }]);
    assert.equal(aborted, 1, "after the server accepts the interrupt the local wait for that turn is ended");
    release();
    await running;
    assert.equal(adapter.activeRootMessageId, null);
    assert.equal(await adapter.interruptActiveTurn(), false, "no active turn -> nothing to interrupt");
    assert.equal(interrupts.length, 1);
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Cursor: a per-task interrupt sends session/cancel for the active session and NEVER shuts the agent process down", async () => {
  const client = Object.create(CursorAcpClient.prototype);
  const notes = [];
  let shutdowns = 0;
  client.activePrompt = { sessionId: "sess-active", promise: Promise.resolve() };
  client.notify = (method, params) => notes.push([method, params]);
  client.withTimeout = (promise) => promise;
  client.shutdown = async () => { shutdowns += 1; };
  assert.equal(await client.interruptActive({ graceMs: 10 }), true);
  assert.deepEqual(notes, [["session/cancel", { sessionId: "sess-active" }]]);
  // a cancel that does not complete in time still must not take Cursor down
  client.withTimeout = () => Promise.reject(new Error("cursor-acp-cancel-timeout"));
  assert.equal(await client.interruptActive({ graceMs: 10 }), false);
  assert.equal(shutdowns, 0);
  client.activePrompt = null;
  assert.equal(await client.interruptActive(), false);
});

test("settleRuntimeTurn without a coordinator is byte-for-byte the legacy behaviour (cancellation is opt-in via the handoff stack)", async () => {
  const dispatchStore = { recordProcessingReceipt: () => ({ accepted: true }), markHandedOffIfLatestAttemptCompleted: () => {} };
  const bindingStore = { validateFence: () => true, markIdle: () => 1 };
  const sent = [];
  const result = await settleRuntimeTurn({
    runtimeKind: "x", dispatchStore, bindingStore, fence: {}, identity: {}, attempt: { attemptId: "a" },
    payload: { msgId: "m", from: "f", conversationId: "c" }, resultText: "hi",
    sendReply: async (reply) => { sent.push(reply); return { msgId: "r" }; },
  });
  assert.equal(result.status, "completed");
  assert.equal(sent.length, 1);
});

test("the Codex injector reports the exact thread + turn ids of the running turn (from the turn/start response) through observeTurn", async () => {
  const { createCodexAppServerInjector } = await import("../scripts/codex-app-server-wake.mjs");
  class FakeClient {
    async request(method) { return method === "thread/start" ? { thread: { id: "thread-seeded" } } : { turn: { id: "x" } }; }
    async startTurnAndWaitForFinal(params, options) {
      options.onTurnId({ turnId: "turn-live", threadId: "thread-seeded", abort: () => {} });
      return { finalText: "ok", turnId: "turn-live" };
    }
  }
  const observed = [];
  const processing = { attemptId: "a", completed() {}, observeTurn: (ids) => observed.push(ids) };
  const injector = createCodexAppServerInjector({ Client: FakeClient });
  await injector({ msgId: "m", from: "s", conversationId: "c", text: "t" },
    { mode: "codex_app_server", socketPath: "/tmp/x.sock", returnFinalToCaller: true }, processing);
  assert.deepEqual(observed.map(({ abort, ...ids }) => ids), [{ sessionId: "turn-live", threadId: "thread-seeded" }]);
  assert.equal(typeof observed[0].abort, "function");
});

test("a cancel that lands between the check and the reply enqueue still withholds the reply", async () => {
  const sent = [];
  let checks = 0;
  const coordinator = {
    isWorkflowCancelled: () => { checks += 1; return checks >= 2; }, // false at the top, true right before the send
    classifyTerminal: () => ({ kind: "none" }),
  };
  const dispatchStore = { recordProcessingReceipt: () => ({ accepted: true }), markHandedOffIfLatestAttemptCompleted: () => {} };
  const bindingStore = { validateFence: () => true, markIdle: () => 1 };
  const result = await settleRuntimeTurn({
    runtimeKind: "x", dispatchStore, bindingStore, fence: {}, identity: {}, attempt: { attemptId: "a" },
    payload: { msgId: "m", from: "f", conversationId: "c" }, turn: { rootMessageId: ROOT, reply: { to: "f", conversationId: "c", replyToMessageId: "m" } },
    coordinator, resultText: "late answer", sendReply: async (reply) => { sent.push(reply); return { msgId: "r" }; },
  });
  assert.equal(result.status, "completed-cancelled-workflow");
  assert.deepEqual(sent, []);
});

test("durable reply RECOVERY after a restart never delivers a stored result of a cancelled workflow", async () => {
  const ctx = harness();
  let failSend = true;
  const sent = [];
  ctx.runtime.sendReply = async (reply) => { if (failSend) throw new Error("outbox down"); sent.push(reply); return { msgId: reply.msgId }; };
  const { payload, dispatch } = ctx.claim();
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed-reply-pending", "the reply could not be enqueued; the result is stored");
  ctx.cancel(ROOT);
  failSend = false;
  assert.deepEqual(await ctx.runtime.recoverCompletedReplies(), [], "cancelled: nothing is recovered");
  assert.deepEqual(sent, []);
  // an unrelated, non-cancelled workflow's stored result IS still recovered
  const other = ctx.claim({ msgId: OTHER_ROOT, conversationId: "conv-b", text: "B" });
  failSend = true;
  assert.equal((await ctx.runtime.executeTurn(other.payload, other.dispatch)).status, "completed-reply-pending");
  failSend = false;
  const recovered = await ctx.runtime.recoverCompletedReplies();
  assert.equal(recovered.length, 1);
  assert.equal(sent[0].replyToMessageId, OTHER_ROOT);
});

// ---------------------------------------------------------------------------
// Restart reconstruction (regression gate for the existing cancellation implementation)
// ---------------------------------------------------------------------------

test("RESTART after cancellation: a continuation left open (older build / unavailable db at cancel time) is closed by reconcile and never reloaded as open", async () => {
  const ctx = harness();
  const handoff = openHandoff(ctx);
  // an intent exists but the open continuation was never terminalized (the pre-fix leftover)
  const raw = new DatabaseSync(ctx.db);
  raw.exec("CREATE TABLE IF NOT EXISTS workflow_control (root_message_id TEXT PRIMARY KEY, state TEXT NOT NULL, requested_at INTEGER NOT NULL, requested_by TEXT NOT NULL)");
  raw.prepare("INSERT INTO workflow_control VALUES (?, 'cancel_requested', ?, 'operator')").run(ROOT, 1);
  raw.close();
  // "daemon restart": a fresh store instance on the same database
  const restarted = new AgentHandoffStore(ctx.db);
  assert.equal(restarted.listOpen().length, 1, "before reconcile the leftover is visible as open");
  assert.equal(restarted.reconcileCancelledContinuations(5), 1);
  assert.equal(restarted.listOpen().length, 0);
  assert.equal(restarted.pendingEnqueue().length, 0, "and it is not re-enqueued either");
  const kept = restarted.get(handoff.handoffMsgId);
  assert.deepEqual([kept.state, kept.terminalReason], ["terminal", "workflow-cancelled"]);
  assert.equal(restarted.reconcileCancelledContinuations(6), 0, "idempotent");
  restarted.close();
});

test("a cancelled workflow's handoff that was written but never enqueued is not re-enqueued by recovery after a restart; other workflows are", async () => {
  const ctx = harness();
  const cancelled = openHandoff(ctx, { root: ROOT, id: "handoff-cancelled-1" });
  const live = openHandoff(ctx, { root: OTHER_ROOT, id: "handoff-live-0001" });
  ctx.cancel(ROOT, [cancelled.handoffMsgId]);
  const restarted = new AgentHandoffStore(ctx.db);
  assert.deepEqual(restarted.pendingEnqueue().map((h) => h.handoffMsgId), [live.handoffMsgId]);
  restarted.close();
});
