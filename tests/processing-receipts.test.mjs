import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";
import { invokeWithProcessingReceipts } from "../scripts/llm-processing-lifecycle.mjs";

const payload = (msgId = "msg-1") => ({
  from: "agent-peer",
  text: "process this",
  msgId,
  conversationId: "conv-processing",
});

const context = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-processing-receipt-"));
  const dbPath = path.join(dir, "murmur.db");
  const store = new WakeDispatchStore(dbPath, options);
  return {
    dir,
    dbPath,
    store,
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const startAttempt = (store, {
  msgId = "msg-1",
  attemptId = "attempt-1",
  now = 1000,
  recipientId = "local",
  memberSlot = recipientId,
  runtime = "test-runtime",
  capability = "completed",
} = {}) => {
  store.enqueue({ ...payload(msgId), recipientAgentId: recipientId, memberSlot }, now);
  const dispatch = store.claimDue(now);
  assert.ok(dispatch);
  assert.equal(store.beginHandoff(dispatch, now, { attemptId, runtime, capability }), 1);
  return { dispatch, attempt: { attemptId, inboundMessageId: msgId, recipientId, memberSlot, runtime, capability } };
};

test("completed processing receipt survives restart and suppresses crash-window replay", async () => {
  const ctx = context();
  const { attempt } = startAttempt(ctx.store);
  ctx.store.recordProcessingReceipt({ ...attempt, status: "completed" }, 1100);
  ctx.store.close();

  const reopened = new WakeDispatchStore(ctx.dbPath);
  let runtimeCalls = 0;
  try {
    const recovery = reopened.reconcileProcessingAttempts({ now: 1200, startedTtlMs: 5000 });
    assert.equal(recovery[0]?.type, "completed-skip-replay");
    assert.equal(reopened.recoverStaleClaims({ now: 1200, claimTtlMs: 0 }), 0);
    await new WakeMonitor({ dispatchStore: reopened, hook: async () => { runtimeCalls += 1; } }).drain();
    assert.equal(runtimeCalls, 0);
    assert.equal(reopened.get("msg-1").state, "handed_off");
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("fresh started receipt survives restart and holds the dispatch in flight", async () => {
  const ctx = context();
  const { attempt } = startAttempt(ctx.store);
  ctx.store.recordProcessingReceipt({ ...attempt, status: "started" }, 1100);
  ctx.store.close();
  const reopened = new WakeDispatchStore(ctx.dbPath);
  let calls = 0;
  try {
    const recovery = reopened.reconcileProcessingAttempts({ now: 1200, startedTtlMs: 5000 });
    assert.equal(recovery[0]?.type, "started-in-flight");
    assert.equal(reopened.recoverStaleClaims({ now: 1200, claimTtlMs: 0 }), 0);
    await new WakeMonitor({ dispatchStore: reopened, hook: async () => { calls += 1; } }).drain();
    assert.equal(calls, 0);
    assert.equal(reopened.get("msg-1").state, "dispatched");
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("expired started receipt becomes failed and permits a bounded retry", async () => {
  const ctx = context({ maxAttempts: 3 });
  const { attempt } = startAttempt(ctx.store);
  ctx.store.recordProcessingReceipt({ ...attempt, status: "started" }, 1100);
  const recovery = ctx.store.reconcileProcessingAttempts({ now: 7000, startedTtlMs: 5000, retryAt: 7000 });
  assert.equal(recovery[0]?.type, "started-expired");
  assert.equal(ctx.store.getProcessingAttempt(attempt.attemptId).status, "failed");
  let calls = 0;
  const hook = async () => { calls += 1; };
  hook.processingReceipts = "none";
  hook.runtime = "shell-hook";
  try {
    await new WakeMonitor({ dispatchStore: ctx.store, now: () => 7000, hook }).drain();
    assert.equal(calls, 1);
    assert.equal(ctx.store.get("msg-1").attempts, 2);
  } finally {
    ctx.close();
  }
});

test("started receipt expires during live operation and retries once without a second restart", async () => {
  const ctx = context({ maxAttempts: 3 });
  const first = startAttempt(ctx.store);
  ctx.store.recordProcessingReceipt({ ...first.attempt, status: "started" }, 1100);
  ctx.store.close();

  const reopened = new WakeDispatchStore(ctx.dbPath, { maxAttempts: 3 });
  let now = 1200;
  let runtimeCalls = 0;
  const retryAttemptIds = [];
  const hook = async (_payload, attempt) => {
    runtimeCalls += 1;
    retryAttemptIds.push(attempt.attemptId);
    reopened.recordProcessingReceipt({ ...attempt, status: "started" }, now);
    throw new Error("runtime-still-unavailable");
  };
  hook.processingReceipts = "completed";
  hook.runtime = "llm-hook";
  const monitor = new WakeMonitor({
    dispatchStore: reopened,
    hook,
    now: () => now,
    processingStartedTtlMs: 5000,
    retry: { baseDelayMs: 100, maxDelayMs: 100 },
  });
  try {
    assert.equal(reopened.reconcileProcessingAttempts({ now, startedTtlMs: 5000 })[0]?.type, "started-in-flight");
    assert.equal(reopened.recoverStaleClaims({ now, claimTtlMs: 0, processingStartedTtlMs: 5000 }), 0);
    monitor.reconcileProcessingAttempts();
    await monitor.drain();
    assert.equal(runtimeCalls, 0);
    assert.equal(reopened.get("msg-1").state, "dispatched");
    assert.equal(reopened.get("msg-1").attempts, 1);

    now = 7000;
    assert.equal(monitor.reconcileProcessingAttempts()[0]?.type, "started-expired");
    assert.equal(reopened.getProcessingAttempt(first.attempt.attemptId).status, "failed");
    await monitor.drain();
    assert.equal(runtimeCalls, 1);
    assert.equal(reopened.get("msg-1").attempts, 2);
    assert.notEqual(retryAttemptIds[0], first.attempt.attemptId);

    monitor.reconcileProcessingAttempts();
    await monitor.drain();
    assert.equal(runtimeCalls, 1);
    assert.equal(reopened.listProcessingAttempts(reopened.get("msg-1")).length, 2);
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("LLM hook completed receipt wins over a post-completion failure", async () => {
  const ctx = context({ maxAttempts: 3 });
  let runtimeCalls = 0;
  const logs = [];
  const hook = async (_payload, attempt) => {
    runtimeCalls += 1;
    ctx.store.recordProcessingReceipt({ ...attempt, status: "started" }, 1100);
    ctx.store.recordProcessingReceipt({ ...attempt, status: "completed" }, 1200);
    throw new Error("reply-delivery-failure");
  };
  hook.processingReceipts = "completed";
  hook.runtime = "llm-hook";
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    hook,
    now: () => 1200,
    log: (level, message, fields) => logs.push({ level, message, fields }),
  });
  try {
    await monitor.onInbound(payload());
    const dispatch = ctx.store.get("msg-1");
    const attempt = ctx.store.latestProcessingAttempt(dispatch);
    assert.equal(attempt.status, "completed");
    assert.equal(dispatch.state, "handed_off");
    assert.equal(dispatch.attempts, 1);
    assert.equal(runtimeCalls, 1);
    assert.ok(logs.some((entry) => entry.message === "WakeMonitor post-completion hook failure"
      && entry.fields.attemptId === attempt.attemptId));

    monitor.reconcileProcessingAttempts();
    await monitor.drain();
    assert.equal(runtimeCalls, 1);
    assert.equal(ctx.store.get("msg-1").attempts, 1);
  } finally {
    ctx.close();
  }
});

test("failed processing receipt follows delivery retry policy", async () => {
  const ctx = context({ maxAttempts: 3 });
  const { attempt } = startAttempt(ctx.store);
  ctx.store.recordProcessingReceipt({ ...attempt, status: "failed", errorMessage: "model-failed" }, 1100);
  ctx.store.reconcileProcessingAttempts({ now: 1200, retryAt: 1200 });
  let calls = 0;
  const hook = async () => { calls += 1; };
  hook.processingReceipts = "none";
  hook.runtime = "shell-hook";
  try {
    await new WakeMonitor({ dispatchStore: ctx.store, now: () => 1200, hook }).drain();
    assert.equal(calls, 1);
    assert.equal(ctx.store.get("msg-1").attempts, 2);
  } finally {
    ctx.close();
  }
});

test("receipt transitions are idempotent, monotonic, and diagnose terminal conflict", () => {
  const ctx = context();
  const { attempt } = startAttempt(ctx.store);
  try {
    assert.equal(ctx.store.recordProcessingReceipt({ ...attempt, status: "completed" }, 1100).accepted, true);
    assert.equal(ctx.store.recordProcessingReceipt({ ...attempt, status: "completed" }, 1200).duplicate, true);
    assert.equal(ctx.store.recordProcessingReceipt({ ...attempt, status: "started" }, 1300).reason, "terminal-completed");
    const conflict = ctx.store.recordProcessingReceipt({ ...attempt, status: "failed", errorMessage: "late" }, 1400);
    assert.equal(conflict.conflict, true);
    assert.equal(ctx.store.getProcessingAttempt(attempt.attemptId).status, "completed");
  } finally {
    ctx.close();
  }
});

test("conflicting terminal receipt emits an operator diagnostic", () => {
  const ctx = context();
  const { attempt } = startAttempt(ctx.store);
  const logs = [];
  const monitor = new WakeMonitor({ dispatchStore: ctx.store, log: (level, message, fields) => logs.push({ level, message, fields }) });
  try {
    monitor.recordProcessingReceipt(attempt, "completed");
    monitor.recordProcessingReceipt(attempt, "failed", { errorMessage: "late-failure" });
    assert.ok(logs.some((entry) => entry.level === "error" && entry.message === "WakeMonitor conflicting processing receipt"));
  } finally {
    ctx.close();
  }
});

test("LLM lifecycle records started then completed around a successful model invocation", async () => {
  const events = [];
  const result = await invokeWithProcessingReceipts({
    invoke: async () => "model-result",
    record: (status) => events.push(status),
  });
  assert.equal(result, "model-result");
  assert.deepEqual(events, ["started", "completed"]);
});

test("LLM lifecycle records started then failed around a model invocation error", async () => {
  const events = [];
  await assert.rejects(() => invokeWithProcessingReceipts({
    invoke: async () => { throw new Error("model-error"); },
    record: (status, details) => events.push([status, details?.errorMessage ?? null]),
  }), /model-error/);
  assert.deepEqual(events, [["started", null], ["failed", "model-error"]]);
});

test("unknown attempt and wrong recipient/member slot receipts are rejected", () => {
  const ctx = context();
  const { attempt } = startAttempt(ctx.store);
  try {
    assert.equal(ctx.store.recordProcessingReceipt({ ...attempt, attemptId: "unknown", status: "completed" }).reason, "unknown-attempt");
    assert.equal(ctx.store.recordProcessingReceipt({ ...attempt, recipientId: "victim", status: "completed" }).reason, "attempt-identity-mismatch");
    assert.equal(ctx.store.recordProcessingReceipt({ ...attempt, memberSlot: "other-slot", status: "completed" }).reason, "attempt-identity-mismatch");
    assert.equal(ctx.store.getProcessingAttempt(attempt.attemptId).status, "created");
  } finally {
    ctx.close();
  }
});

test("late receipt for an old attempt cannot alter the active attempt", () => {
  const ctx = context({ maxAttempts: 3 });
  const first = startAttempt(ctx.store);
  ctx.store.recordProcessingReceipt({ ...first.attempt, status: "failed", errorMessage: "retry" }, 1100);
  ctx.store.reconcileProcessingAttempts({ now: 1200, retryAt: 1200 });
  const dispatch = ctx.store.claimDue(1200);
  const secondAttempt = { attemptId: "attempt-2", runtime: "test-runtime", capability: "completed" };
  ctx.store.beginHandoff(dispatch, 1200, secondAttempt);
  try {
    ctx.store.recordProcessingReceipt({ ...first.attempt, status: "completed" }, 1300);
    assert.equal(ctx.store.latestProcessingAttempt(dispatch).attemptId, "attempt-2");
    assert.equal(ctx.store.latestProcessingAttempt(dispatch).status, "created");
    assert.equal(ctx.store.get(dispatch).state, "dispatched");
  } finally {
    ctx.close();
  }
});

test("conversational replies remain independent from processing receipts", async () => {
  const ctx = context();
  const messageStore = new SQLiteMessageStore(ctx.dbPath);
  const { attempt } = startAttempt(ctx.store);
  try {
    await messageStore.append({
      conversationId: "conv-processing",
      msgId: "reply-1",
      replyToMessageId: "msg-1",
      direction: "inbound",
      sender: "agent-peer",
      text: "reply",
      createdAt: new Date().toISOString(),
      transport: "test",
    });
    assert.equal((await messageStore.getRepliesTo("msg-1", "agent-peer"))[0]?.msgId, "reply-1");
    assert.equal(ctx.store.getProcessingAttempt(attempt.attemptId).status, "created");
    ctx.store.recordProcessingReceipt({ ...attempt, status: "completed" }, 1100);
    assert.equal((await messageStore.getRepliesTo("msg-1", "agent-peer"))[0]?.msgId, "reply-1");
  } finally {
    ctx.close();
  }
});

test("runtime may complete without producing a conversational reply", () => {
  const ctx = context();
  const { attempt } = startAttempt(ctx.store);
  try {
    ctx.store.recordProcessingReceipt({ ...attempt, status: "completed" }, 1100);
    assert.equal(ctx.store.getProcessingAttempt(attempt.attemptId).status, "completed");
  } finally {
    ctx.close();
  }
});

test("stateless inbox handoff creates no fake processing attempt", async () => {
  const ctx = context();
  try {
    await new WakeMonitor({ dispatchStore: ctx.store, mode: "stateless", hook: null }).onInbound(payload());
    assert.equal(ctx.store.get("msg-1").state, "handed_off");
    assert.equal(ctx.store.latestProcessingAttempt(ctx.store.get("msg-1")), null);
  } finally {
    ctx.close();
  }
});

test("lease defer creates no processing attempt before a real runtime call", async () => {
  const ctx = context();
  let allowed = false;
  let now = 1000;
  const hook = async () => {};
  hook.processingReceipts = "none";
  hook.runtime = "shell-hook";
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    hook,
    now: () => now,
    retry: { baseDelayMs: 10, maxDelayMs: 10 },
    leaseGate: async () => allowed ? { allow: true } : { allow: false, reason: "busy" },
  });
  try {
    await monitor.onInbound(payload());
    const dispatch = ctx.store.get("msg-1");
    assert.equal(dispatch.state, "deferred");
    assert.equal(ctx.store.latestProcessingAttempt(dispatch), null);
    allowed = true;
    now += 10;
    await monitor.drain();
    assert.equal(ctx.store.listProcessingAttempts(dispatch).length, 1);
  } finally {
    ctx.close();
  }
});

test("without a completed receipt the existing at-least-once crash replay remains", async () => {
  const ctx = context({ maxAttempts: 3 });
  startAttempt(ctx.store);
  ctx.store.close();
  const reopened = new WakeDispatchStore(ctx.dbPath, { maxAttempts: 3 });
  let calls = 0;
  const hook = async () => { calls += 1; };
  hook.processingReceipts = "none";
  hook.runtime = "shell-hook";
  try {
    assert.equal(reopened.recoverStaleClaims({ now: 1200, claimTtlMs: 0 }), 1);
    await new WakeMonitor({ dispatchStore: reopened, now: () => 1200, hook }).drain();
    assert.equal(calls, 1);
    assert.equal(reopened.get("msg-1").attempts, 2);
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});
