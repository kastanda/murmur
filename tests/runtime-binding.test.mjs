import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fork } from "node:child_process";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-runtime-binding-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatch = new WakeDispatchStore(dbPath, { recipientId: "claude-agent" });
  const bindings = new RuntimeBindingStore(dbPath);
  return { dir, dbPath, dispatch, bindings, close() { bindings.close(); dispatch.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
};

const addBinding = (store, bindingId, memberSlot, now = 1000, overrides = {}) => {
  store.register({
    bindingId,
    agentId: "claude-agent",
    runtimeKind: overrides.runtimeKind ?? "claude",
    runtimeSessionId: overrides.runtimeSessionId ?? bindingId,
    runtimeGeneration: overrides.runtimeGeneration ?? 1,
    pid: overrides.pid ?? null,
    processStartIdentity: overrides.processStartIdentity ?? null,
    projectId: overrides.projectId ?? "project-main",
    taskId: overrides.taskId ?? null,
    memberSlot,
    leaseTtlMs: overrides.leaseTtlMs ?? 100,
    state: overrides.state ?? "STARTING",
    metadata: overrides.metadata ?? null,
  }, now);
  const row = store.get(bindingId);
  assert.equal(store.markIdle({ bindingId, ownerGeneration: row.runtimeGeneration, fencingToken: row.leaseToken }, now), 1);
  return store.get(bindingId);
};

const prepareDispatch = (dispatch, msgId, memberSlot, conversationId = "task-1", now = 1000) => {
  dispatch.enqueue({ msgId, conversationId, from: "peer", text: msgId, memberSlot, recipientAgentId: "claude-agent" }, now);
  return dispatch.claimDue(now);
};

const route = (memberSlot, taskId = "task-1") => ({ agentId: "claude-agent", projectId: "project-main", memberSlot, taskId });

test("two independent store contenders produce exactly one binding assignment", () => {
  const ctx = setup();
  const contender = new RuntimeBindingStore(ctx.dbPath);
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-1", "claude:auto");
    const first = ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    const second = contender.assignDispatch(item, route("claude:auto"), 1001);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(ctx.dispatch.get(item).ownerBindingId, "auto-1");
  } finally {
    contender.close();
    ctx.close();
  }
});

test("two processes released by one barrier produce exactly one owner", async () => {
  const ctx = setup();
  const children = [];
  try {
    addBinding(ctx.bindings, "auto-process-a", "claude:auto");
    addBinding(ctx.bindings, "auto-process-b", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-process-race", "claude:auto");
    const helper = path.join(import.meta.dirname, "fixtures", "runtime-binding-contender.mjs");
    const args = [ctx.dbPath, JSON.stringify(item), JSON.stringify(route("claude:auto")), "1001"];
    const run = () => new Promise((resolve, reject) => {
      const child = fork(helper, args, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      let ready = false;
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("message", (message) => {
        if (message.type === "ready") {
          ready = true;
          resolve({ child, ready: true, result: new Promise((resultResolve, resultReject) => {
            child.on("message", (outcome) => {
              if (outcome.type === "result") resultResolve(outcome.result);
              if (outcome.type === "error") resultReject(new Error(outcome.error));
            });
          }) });
        }
      });
      child.on("exit", (code) => {
        if (!ready && code !== 0) reject(new Error(`runtime-binding-contender-exit-${code}`));
      });
    });
    const contenders = await Promise.all([run(), run()]);
    for (const contender of contenders) contender.child.send("start");
    const results = await Promise.all(contenders.map((contender) => contender.result));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(ctx.bindings.listActive({ memberSlot: "claude:auto" }, 1001)
      .filter((binding) => binding.state === "CLAIMED").length, 1);
    assert.ok(["auto-process-a", "auto-process-b"].includes(ctx.dispatch.get(item).ownerBindingId));
  } finally {
    for (const child of children) if (child.connected) child.disconnect();
    ctx.close();
  }
});

test("stale generation cannot transition, heartbeat, reply, or complete under its old fence", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-1", "claude:auto");
    const oldFence = ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    ctx.bindings.reconcileStale({ now: 1200 });
    addBinding(ctx.bindings, "auto-2", "claude:auto", 1200, { runtimeGeneration: 2 });
    const retried = ctx.dispatch.claimDue(1200);
    const newFence = ctx.bindings.assignDispatch(retried, route("claude:auto"), 1201);
    assert.equal(ctx.bindings.validateFence(oldFence, item), false);
    assert.equal(ctx.bindings.heartbeat(oldFence, 1202), 0);
    assert.equal(ctx.bindings.markRunning(oldFence, 1202), 0);
    assert.equal(ctx.bindings.validateFence(newFence, item), true);
  } finally { ctx.close(); }
});

test("heartbeat wins a stale-reconciler boundary race", () => {
  const ctx = setup();
  try {
    const binding = addBinding(ctx.bindings, "auto-1", "claude:auto", 1000, { leaseTtlMs: 100 });
    const fence = { bindingId: binding.bindingId, ownerGeneration: binding.runtimeGeneration, fencingToken: binding.leaseToken };
    assert.equal(ctx.bindings.heartbeat(fence, 1099), 1);
    assert.deepEqual(ctx.bindings.reconcileStale({ now: 1100 }), []);
    assert.equal(ctx.bindings.get("auto-1").state, "BOUND_IDLE");
    assert.ok(ctx.bindings.reconcileStale({ now: 1200 }).some((event) => event.type === "binding-stale"));
  } finally { ctx.close(); }
});

test("binding replacement increments generation and invalidates the previous fence", () => {
  const ctx = setup();
  try {
    const old = addBinding(ctx.bindings, "auto-1", "claude:auto");
    const oldFence = { bindingId: old.bindingId, ownerGeneration: old.runtimeGeneration, fencingToken: old.leaseToken, fencingEpoch: old.fencingEpoch };
    const replacement = ctx.bindings.replace("auto-1", { bindingId: "auto-2", runtimeSessionId: "session-2" }, 1100);
    assert.equal(replacement.runtimeGeneration, 2);
    assert.equal(ctx.bindings.validateFence(oldFence), false);
    assert.equal(ctx.bindings.get("auto-1").state, "STALE");
  } finally { ctx.close(); }
});

test("interactive and autonomous Claude member slots never cross-assign", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "interactive-a", "claude:interactive:a");
    addBinding(ctx.bindings, "interactive-b", "claude:interactive:b");
    addBinding(ctx.bindings, "auto-c", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-1", "claude:auto");
    const fence = ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    assert.equal(fence.bindingId, "auto-c");
    assert.equal(ctx.bindings.get("interactive-a").state, "BOUND_IDLE");
    assert.equal(ctx.bindings.get("interactive-b").state, "BOUND_IDLE");
  } finally { ctx.close(); }
});

test("dispatch member slot is authoritative and a mismatched route is rejected", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "interactive-a", "claude:interactive:a");
    addBinding(ctx.bindings, "auto-c", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-slot-guard", "claude:auto");
    assert.throws(
      () => ctx.bindings.assignDispatch(item, route("claude:interactive:a"), 1001),
      /runtime-binding-member-slot-mismatch/,
    );
    assert.equal(ctx.dispatch.get(item).ownerBindingId, null);
    assert.equal(ctx.bindings.get("interactive-a").state, "BOUND_IDLE");
    assert.equal(ctx.bindings.assignDispatch(item, route("claude:auto"), 1002).bindingId, "auto-c");
  } finally { ctx.close(); }
});

test("conversation affinity prefers its pinned idle binding", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "unpinned", "claude:auto", 900);
    addBinding(ctx.bindings, "pinned", "claude:auto", 1000, {
      taskId: "task-1", metadata: { stickyTask: true },
    });
    const item = prepareDispatch(ctx.dispatch, "msg-1", "claude:auto");
    const fence = ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    assert.equal(fence.bindingId, "pinned");
  } finally { ctx.close(); }
});

test("a reusable autonomous binding clears affinity on idle and serves another conversation", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto");
    const first = prepareDispatch(ctx.dispatch, "msg-conv-1", "claude:auto", "conv-1");
    const firstFence = ctx.bindings.assignDispatch(first, route("claude:auto", "conv-1"), 1001);
    assert.equal(ctx.bindings.get("auto-1").taskId, "conv-1");
    assert.equal(ctx.bindings.markWaking(firstFence, 1002), 1);
    assert.equal(ctx.bindings.markRunning(firstFence, 1003), 1);
    assert.equal(ctx.dispatch.markHandedOff(first, 1004), 1);
    assert.equal(ctx.bindings.markIdle(firstFence, 1004), 1);
    assert.equal(ctx.bindings.get("auto-1").taskId, null);
    const second = prepareDispatch(ctx.dispatch, "msg-conv-2", "claude:auto", "conv-2", 1005);
    assert.equal(ctx.bindings.assignDispatch(second, route("claude:auto", "conv-2"), 1006).bindingId, "auto-1");
  } finally { ctx.close(); }
});

test("legacy stale recovery ignores binding-owned rows and binding reconciliation releases them", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto", 1000, { leaseTtlMs: 100 });
    const item = prepareDispatch(ctx.dispatch, "msg-owned", "claude:auto", "conv-owned", 1000);
    const fence = ctx.bindings.assignDispatch(item, route("claude:auto", "conv-owned"), 1001);
    assert.equal(ctx.dispatch.recoverStaleClaims({ now: 1200, claimTtlMs: 0 }), 0);
    assert.equal(ctx.dispatch.get(item).state, "claimed");
    assert.equal(ctx.dispatch.get(item).ownerBindingId, "auto-1");
    assert.equal(ctx.bindings.get("auto-1").state, "CLAIMED");

    ctx.bindings.reconcileStale({ now: 1200, retryAt: 1200 });
    assert.equal(ctx.bindings.get("auto-1").state, "STALE");
    assert.equal(ctx.dispatch.get(item).state, "deferred");
    assert.equal(ctx.dispatch.get(item).ownerBindingId, null);

    addBinding(ctx.bindings, "auto-2", "claude:auto", 1200, { runtimeGeneration: 2 });
    const retry = ctx.dispatch.claimDue(1200);
    assert.equal(ctx.bindings.assignDispatch(retry, route("claude:auto", "conv-owned"), 1201).bindingId, "auto-2");
    assert.equal(ctx.bindings.validateFence(fence, item), false);
  } finally { ctx.close(); }
});

test("heartbeat age equal to TTL remains fresh and becomes stale only when age is greater", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-ttl", "claude:auto", 1000, { leaseTtlMs: 100 });
    assert.deepEqual(ctx.bindings.reconcileStale({ now: 1100 }), []);
    assert.equal(ctx.bindings.get("auto-ttl").state, "BOUND_IDLE");
    ctx.bindings.reconcileStale({ now: 1101 });
    assert.equal(ctx.bindings.get("auto-ttl").state, "STALE");
  } finally { ctx.close(); }
});

test("stale pinned binding does not block a healthy replacement", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "pinned-old", "claude:auto", 1000, {
      taskId: "conv-1", leaseTtlMs: 100, metadata: { stickyTask: true },
    });
    ctx.bindings.reconcileStale({ now: 1200 });
    addBinding(ctx.bindings, "healthy-new", "claude:auto", 1200, { runtimeGeneration: 2 });
    const item = prepareDispatch(ctx.dispatch, "msg-replacement", "claude:auto", "conv-1", 1200);
    assert.equal(ctx.bindings.assignDispatch(item, route("claude:auto", "conv-1"), 1201).bindingId, "healthy-new");
  } finally { ctx.close(); }
});

test("binding crash before handoff makes dispatch retryable and reassignable", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-1", "claude:auto");
    ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    ctx.bindings.reconcileStale({ now: 1200, retryAt: 1200 });
    assert.equal(ctx.dispatch.get(item).state, "deferred");
    assert.equal(ctx.dispatch.get(item).ownerBindingId, null);
    addBinding(ctx.bindings, "auto-2", "claude:auto", 1200, { runtimeGeneration: 2 });
    const retry = ctx.dispatch.claimDue(1200);
    assert.equal(ctx.bindings.assignDispatch(retry, route("claude:auto"), 1201).bindingId, "auto-2");
  } finally { ctx.close(); }
});

test("binding crash while running holds fresh started receipt and completed evidence wins", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-1", "claude:auto");
    const fence = ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    assert.equal(ctx.bindings.markWaking(fence, 1002), 1);
    assert.equal(ctx.dispatch.beginHandoff(item, 1002, {
      attemptId: "attempt-1", runtime: "claude-worker", capability: "completed",
    }), 1);
    ctx.dispatch.recordProcessingReceipt({
      attemptId: "attempt-1", inboundMessageId: item.msgId,
      recipientId: item.recipientId, memberSlot: item.memberSlot,
      runtime: "claude-worker", status: "started",
    }, 1003);
    assert.equal(ctx.bindings.markRunning(fence, 1003), 1);
    const events = ctx.bindings.reconcileStale({ now: 1200, processingStartedTtlMs: 500 });
    assert.ok(events.some((event) => event.type === "processing-in-flight"));
    assert.equal(ctx.dispatch.get(item).state, "dispatched");
    ctx.dispatch.recordProcessingReceipt({
      attemptId: "attempt-1", inboundMessageId: item.msgId,
      recipientId: item.recipientId, memberSlot: item.memberSlot,
      runtime: "claude-worker", status: "completed",
    }, 1201);
    ctx.dispatch.reconcileProcessingAttempts({ now: 1202 });
    assert.equal(ctx.dispatch.get(item).state, "handed_off");
  } finally { ctx.close(); }
});

test("binding crash after durable completion never makes the dispatch retryable", () => {
  const ctx = setup();
  try {
    addBinding(ctx.bindings, "auto-1", "claude:auto");
    const item = prepareDispatch(ctx.dispatch, "msg-completed", "claude:auto");
    const fence = ctx.bindings.assignDispatch(item, route("claude:auto"), 1001);
    ctx.bindings.markWaking(fence, 1002);
    ctx.dispatch.beginHandoff(item, 1002, {
      attemptId: "attempt-completed", runtime: "claude-worker", capability: "completed",
    });
    ctx.dispatch.recordProcessingReceipt({
      attemptId: "attempt-completed", inboundMessageId: item.msgId,
      recipientId: item.recipientId, memberSlot: item.memberSlot,
      runtime: "claude-worker", status: "completed",
    }, 1003);
    ctx.bindings.markRunning(fence, 1003);
    const events = ctx.bindings.reconcileStale({ now: 1200 });
    assert.ok(events.some((event) => event.type === "processing-completed"));
    assert.equal(ctx.dispatch.get(item).state, "handed_off");
  } finally { ctx.close(); }
});

test("old dispatch schemas gain nullable assignment columns without changing legacy behavior", () => {
  const ctx = setup();
  try {
    const columns = new Set(ctx.dispatch.db.prepare(`PRAGMA table_info(wake_dispatch)`).all().map((column) => column.name));
    for (const column of ["owner_binding_id", "owner_generation", "fencing_token", "fencing_epoch"]) assert.ok(columns.has(column));
    const item = prepareDispatch(ctx.dispatch, "legacy-default", "claude-agent");
    assert.equal(item.ownerBindingId, null);
    assert.equal(ctx.dispatch.beginHandoff(item, 1001), 1);
    assert.equal(ctx.dispatch.markHandedOff(item, 1002), 1);
  } finally { ctx.close(); }
});

test("pre-binding composite dispatch schema migrates assignment columns in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-runtime-binding-migration-"));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE wake_dispatch (
      msg_id TEXT NOT NULL, recipient_id TEXT NOT NULL, member_slot TEXT NOT NULL,
      conversation_id TEXT NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, claim_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      claimed_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, handed_off_at INTEGER,
      PRIMARY KEY (msg_id, recipient_id, member_slot)
    );
    CREATE TABLE wake_dispatch_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO wake_dispatch_meta VALUES ('inbound-baseline-rowid', '0');
    INSERT INTO wake_dispatch VALUES
      ('old-msg', 'claude-agent', 'claude:auto', 'task-1', '{}', 'pending',
       0, 0, 5, 1000, NULL, NULL, 1000, 1000, NULL);
  `);
  db.close();
  const migrated = new WakeDispatchStore(dbPath, { recipientId: "claude-agent" });
  try {
    assert.equal(migrated.get({ msgId: "old-msg", recipientId: "claude-agent", memberSlot: "claude:auto" }).ownerBindingId, null);
    assert.equal(migrated.db.prepare(`SELECT COUNT(*) AS count FROM wake_dispatch`).get().count, 1);
  } finally {
    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
