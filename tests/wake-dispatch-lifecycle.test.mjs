import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { WakeMonitor, normalizeWakeConfig } from "../scripts/wake-monitor.mjs";

const payload = (n, conversationId = "conv-lifecycle") => ({
  from: "agent-peer",
  text: `message ${n}`,
  msgId: `msg-${n}`,
  conversationId,
  cursor: n,
});

const context = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-dispatch-"));
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

const createLegacyDispatchDatabase = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE wake_dispatch (
      msg_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL, claimed_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, acknowledged_at INTEGER
    );
    CREATE INDEX idx_wake_dispatch_due ON wake_dispatch(state, next_attempt_at, created_at);
    CREATE TABLE wake_dispatch_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO wake_dispatch_meta(key, value) VALUES ('inbound-baseline-rowid', '73');
  `);
  const insert = db.prepare(`
    INSERT INTO wake_dispatch
      (msg_id, conversation_id, payload_json, state, attempts, max_attempts,
       next_attempt_at, claimed_at, last_error, created_at, updated_at, acknowledged_at)
    VALUES (?, 'legacy-conv', ?, ?, ?, 5, 1000, NULL, ?, 900, 950, ?)
  `);
  insert.run("legacy-ack", JSON.stringify(payload(1)), "acknowledged", 2, null, 960);
  insert.run("legacy-failed", JSON.stringify(payload(2)), "failed", 3, "legacy-error", null);
  db.close();
};

test("one WakeMonitor lifecycle hands off 20 sequential wakes", async () => {
  const ctx = context();
  const calls = [];
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    loopBreaker: { maxWakes: 100, windowMs: 60_000 },
    hook: async (item) => calls.push(item.msgId),
  });
  try {
    for (let i = 1; i <= 20; i += 1) await monitor.onInbound(payload(i));
    assert.deepEqual(calls, Array.from({ length: 20 }, (_, i) => `msg-${i + 1}`));
    assert.ok(ctx.store.list().every((row) => row.state === "handed_off"));
  } finally {
    ctx.close();
  }
});

for (const target of [
  { name: "non-default recipient", recipientAgentId: "agent-b" },
  { name: "non-default member slot", recipientAgentId: "agent-a", memberSlot: "slot-b" },
]) {
  test(`defer preserves full dispatch identity for ${target.name}`, async () => {
    const ctx = context({ recipientId: "agent-a" });
    let now = 1500;
    let available = false;
    let calls = 0;
    const item = { ...payload(1), ...target };
    const monitor = new WakeMonitor({
      dispatchStore: ctx.store,
      retry: { baseDelayMs: 10, maxDelayMs: 10 },
      now: () => now,
      leaseGate: async () => available
        ? { allow: true, token: 1 }
        : { allow: false, reason: "target-busy" },
      hook: async () => { calls += 1; },
    });
    try {
      await monitor.onInbound(item);
      const identity = ctx.store.identityFor(item);
      assert.equal(ctx.store.get(identity).state, "deferred");
      assert.equal(ctx.store.get(identity).attempts, 0);
      available = true;
      now += 10;
      await monitor.drain();
      assert.equal(calls, 1);
      assert.equal(ctx.store.get(identity).state, "handed_off");
    } finally {
      ctx.close();
    }
  });
}

test("production loop-breaker default is 20 and remains configurable", () => {
  assert.equal(normalizeWakeConfig({}).loopBreaker.maxWakes, 20);
  assert.equal(normalizeWakeConfig({ wake: { loopBreaker: { maxWakes: 37 } } }).loopBreaker.maxWakes, 37);
});

test("legacy dispatch migration is atomic and preserves state, attempts, meta, and composite identity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-migration-"));
  const dbPath = path.join(dir, "murmur.db");
  createLegacyDispatchDatabase(dbPath);
  const store = new WakeDispatchStore(dbPath, { recipientId: "agent-a" });
  try {
    const acknowledged = store.get({ msgId: "legacy-ack", recipientId: "agent-a", memberSlot: "agent-a" });
    const failed = store.get({ msgId: "legacy-failed", recipientId: "agent-a", memberSlot: "agent-a" });
    assert.equal(acknowledged.state, "handed_off");
    assert.equal(acknowledged.attempts, 2);
    assert.equal(acknowledged.handedOffAt, 960);
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempts, 3);
    assert.equal(failed.lastError, "legacy-error");
    const primaryKey = store.db.prepare(`PRAGMA table_info(wake_dispatch)`).all()
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    assert.deepEqual(primaryKey, ["msg_id", "recipient_id", "member_slot"]);
    store.enqueue({ ...payload(1), recipientAgentId: "agent-a" }, 2000);
    store.enqueue({ ...payload(1), recipientAgentId: "agent-b" }, 2000);
    assert.equal(store.list().filter((row) => row.msgId === "msg-1").length, 2);
    assert.equal(store.db.prepare(`SELECT value FROM wake_dispatch_meta WHERE key = 'inbound-baseline-rowid'`).get().value, "73");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy migration failure rolls back schema and data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-migration-rollback-"));
  const dbPath = path.join(dir, "murmur.db");
  createLegacyDispatchDatabase(dbPath);
  assert.throws(() => new WakeDispatchStore(dbPath, {
    recipientId: "agent-a",
    migrationFault: (point) => {
      if (point === "after-data-copy") throw new Error("injected-migration-failure");
    },
  }), /injected-migration-failure/);
  const db = new DatabaseSync(dbPath);
  try {
    const columns = db.prepare(`PRAGMA table_info(wake_dispatch)`).all().map((column) => column.name);
    assert.equal(columns.includes("recipient_id"), false);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM wake_dispatch`).get().count, 2);
    assert.equal(db.prepare(`SELECT state FROM wake_dispatch WHERE msg_id = 'legacy-ack'`).get().state, "acknowledged");
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wake_dispatch_legacy'`).get(), undefined);
    assert.equal(db.prepare(`SELECT value FROM wake_dispatch_meta WHERE key = 'inbound-baseline-rowid'`).get().value, "73");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("existing dispatch ledger without migration baseline fails instead of replaying history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-missing-meta-"));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE wake_dispatch (
      msg_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL, claimed_at INTEGER, last_error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, acknowledged_at INTEGER
    )
  `);
  db.close();
  try {
    assert.throws(() => new WakeDispatchStore(dbPath), /wake-dispatch-meta-baseline-missing/);
    const inspection = new DatabaseSync(dbPath);
    try {
      assert.equal(inspection.prepare(`PRAGMA table_info(wake_dispatch)`).all()
        .some((column) => column.name === "recipient_id"), false);
    } finally {
      inspection.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal notification failure does not break drain or subsequent dispatch", async () => {
  const ctx = context({ maxAttempts: 1 });
  const logs = [];
  const calls = [];
  ctx.store.enqueue(payload(1), 2500);
  ctx.store.enqueue(payload(2), 2500);
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    now: () => 2500,
    log: (level, message, data) => logs.push({ level, message, data }),
    notify: async () => { throw new Error("notification-offline"); },
    hook: async (item) => {
      calls.push(item.msgId);
      if (item.msgId === "msg-1") throw new Error("runtime-terminal");
    },
  });
  try {
    await assert.doesNotReject(() => monitor.drain());
    assert.deepEqual(calls, ["msg-1", "msg-2"]);
    assert.equal(ctx.store.get("msg-1").state, "terminal");
    assert.equal(ctx.store.get("msg-2").state, "handed_off");
    assert.ok(logs.some((entry) => entry.level === "error"
      && entry.message === "WakeMonitor notification failed"
      && entry.data.reason === "terminal"
      && entry.data.notificationError === "notification-offline"));
  } finally {
    ctx.close();
  }
});

test("beginHandoff CAS loss defers without tight loop or spending an attempt", async () => {
  const ctx = context();
  const competingStore = new WakeDispatchStore(ctx.dbPath);
  let now = 2600;
  let runtimeCalls = 0;
  const logs = [];
  const realBeginHandoff = ctx.store.beginHandoff.bind(ctx.store);
  let loseOnce = true;
  ctx.store.beginHandoff = (...args) => {
    if (loseOnce) {
      loseOnce = false;
      const dispatch = args[0];
      competingStore.db.prepare(`
        UPDATE wake_dispatch
        SET state = 'deferred', next_attempt_at = ?, claimed_at = NULL,
            last_error = 'competing-state-change', updated_at = ?
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
      `).run(now, now, dispatch.msgId, dispatch.recipientId, dispatch.memberSlot);
    }
    return realBeginHandoff(...args);
  };
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 10, maxDelayMs: 10 },
    now: () => now,
    log: (level, message, data) => logs.push({ level, message, data }),
    hook: async () => { runtimeCalls += 1; },
  });
  try {
    await monitor.onInbound(payload(1));
    let row = ctx.store.get("msg-1");
    assert.equal(row.state, "deferred");
    assert.equal(row.attempts, 0);
    assert.equal(row.claimCount, 1);
    assert.equal(row.nextAttemptAt, 2610);
    assert.equal(runtimeCalls, 0);
    assert.ok(logs.some((entry) => entry.message === "WakeMonitor handoff claim invariant failed"));
    await monitor.drain();
    assert.equal(ctx.store.get("msg-1").claimCount, 1, "same drain time does not reclaim the row");
    now = 2610;
    await monitor.drain();
    row = ctx.store.get("msg-1");
    assert.equal(runtimeCalls, 1);
    assert.equal(row.state, "handed_off");
    assert.equal(row.attempts, 1);

    ctx.store.enqueue(payload(2), now);
    ctx.store.beginHandoff = (dispatch, attemptedAt) => {
      competingStore.db.prepare(`
        UPDATE wake_dispatch
        SET state = 'terminal', next_attempt_at = ?, claimed_at = NULL,
            last_error = 'competing-terminal', updated_at = ?
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
      `).run(attemptedAt, attemptedAt, dispatch.msgId, dispatch.recipientId, dispatch.memberSlot);
      return realBeginHandoff(dispatch, attemptedAt);
    };
    await monitor.drain();
    const terminal = ctx.store.get("msg-2");
    assert.equal(terminal.state, "terminal");
    assert.equal(terminal.attempts, 0);
    assert.equal(runtimeCalls, 1, "claim-loss recovery does not resurrect terminal state");
  } finally {
    competingStore.close();
    ctx.close();
  }
});

test("require_approval notification failure defers and continues the same drain", async () => {
  const ctx = context();
  const logs = [];
  const calls = [];
  ctx.store.enqueue(payload(1), 2800);
  ctx.store.enqueue(payload(2), 2800);
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    now: () => 2800,
    auditHook: async (item) => item.msgId === "msg-1" ? "require_approval" : "allow",
    notify: async () => { throw new Error("approval-notify-offline"); },
    log: (level, message, data) => logs.push({ level, message, data }),
    hook: async (item) => calls.push(item.msgId),
  });
  try {
    await assert.doesNotReject(() => monitor.drain());
    assert.deepEqual(calls, ["msg-2"]);
    assert.equal(ctx.store.get("msg-1").state, "deferred");
    assert.equal(ctx.store.get("msg-1").attempts, 0);
    assert.equal(ctx.store.get("msg-2").state, "handed_off");
    assert.ok(logs.some((entry) => entry.level === "error"
      && entry.message === "WakeMonitor notification failed"
      && entry.data.reason === "require_approval"
      && entry.data.notificationError === "approval-notify-offline"));
  } finally {
    ctx.close();
  }
});

test("loop-breaker notification failure preserves suspension and continues the same drain", async () => {
  const ctx = context();
  let now = 3000;
  const logs = [];
  const calls = [];
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    loopBreaker: { maxWakes: 1, windowMs: 100 },
    retry: { baseDelayMs: 5, maxDelayMs: 5 },
    now: () => now,
    notify: async () => { throw new Error("breaker-notify-offline"); },
    log: (level, message, data) => logs.push({ level, message, data }),
    hook: async (item) => calls.push(item.msgId),
  });
  try {
    await monitor.onInbound(payload(0));
    ctx.store.enqueue(payload(1), now);
    ctx.store.enqueue({ ...payload(2), from: "agent-other" }, now);
    await assert.doesNotReject(() => monitor.drain());
    assert.deepEqual(calls, ["msg-0", "msg-2"]);
    assert.equal(ctx.store.get("msg-1").state, "deferred");
    assert.equal(ctx.store.get("msg-1").attempts, 0);
    assert.equal(ctx.store.get("msg-2").state, "handed_off");
    assert.equal(monitor.suspendedSenders.get("agent-peer"), 3100);
    assert.ok(logs.some((entry) => entry.level === "error"
      && entry.message === "WakeMonitor notification failed"
      && entry.data.reason === "loop-breaker"
      && entry.data.notificationError === "breaker-notify-offline"));
    now = 3099;
    await monitor.drain();
    assert.deepEqual(calls, ["msg-0", "msg-2"]);
    now = 3100;
    await monitor.drain();
    assert.deepEqual(calls, ["msg-0", "msg-2", "msg-1"]);
    assert.equal(ctx.store.get("msg-1").state, "handed_off");
  } finally {
    ctx.close();
  }
});

test("wake error is retained and retried to success with backoff", async () => {
  const ctx = context();
  let now = 1000;
  let calls = 0;
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 50, maxDelayMs: 1000 },
    now: () => now,
    hook: async () => {
      calls += 1;
      if (calls === 1) throw new Error("runtime-temporarily-unavailable");
    },
  });
  try {
    await monitor.onInbound(payload(1));
    assert.equal(ctx.store.get("msg-1").state, "failed");
    assert.equal(ctx.store.get("msg-1").lastError, "runtime-temporarily-unavailable");
    await monitor.drain();
    assert.equal(calls, 1, "backoff prevents a tight retry loop");
    now += 50;
    await monitor.drain();
    assert.equal(calls, 2);
    assert.equal(ctx.store.get("msg-1").state, "handed_off");
  } finally {
    ctx.close();
  }
});

test("lease defer remains retryable and is delivered when lease becomes available", async () => {
  const ctx = context();
  let now = 2000;
  let leaseAvailable = false;
  let calls = 0;
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 25, maxDelayMs: 1000 },
    now: () => now,
    leaseGate: async () => leaseAvailable
      ? { allow: true, token: 2 }
      : { allow: false, reason: "live-owner" },
    hook: async () => { calls += 1; },
  });
  try {
    await monitor.onInbound(payload(1));
    assert.equal(ctx.store.get("msg-1").state, "deferred");
    assert.equal(calls, 0);
    leaseAvailable = true;
    now += 25;
    await monitor.drain();
    assert.equal(calls, 1);
    assert.equal(ctx.store.get("msg-1").state, "handed_off");
  } finally {
    ctx.close();
  }
});

test("daemon-style restart recovers a pending dispatch", async () => {
  const ctx = context();
  ctx.store.enqueue(payload(1), 1000);
  ctx.store.close();
  const reopened = new WakeDispatchStore(ctx.dbPath);
  let calls = 0;
  const monitor = new WakeMonitor({
    dispatchStore: reopened,
    now: () => 1000,
    hook: async () => { calls += 1; },
  });
  try {
    await monitor.drain();
    assert.equal(calls, 1);
    assert.equal(reopened.get("msg-1").state, "handed_off");
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("restart after handoff and duplicate inbox event do not start another turn", async () => {
  const ctx = context();
  let calls = 0;
  const first = new WakeMonitor({
    dispatchStore: ctx.store,
    hook: async () => { calls += 1; },
  });
  await first.onInbound(payload(1));
  ctx.store.close();

  const reopened = new WakeDispatchStore(ctx.dbPath);
  const second = new WakeMonitor({
    dispatchStore: reopened,
    hook: async () => { calls += 1; },
  });
  try {
    await second.onInbound(payload(1));
    await second.drain();
    assert.equal(calls, 1);
    assert.equal(reopened.get("msg-1").state, "handed_off");
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("monitor continues after approval suppression and runtime error", async () => {
  const ctx = context();
  let now = 3000;
  let auditAllows = false;
  const calls = [];
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 10, maxDelayMs: 100 },
    now: () => now,
    auditHook: async (item) => item.msgId === "msg-1" && !auditAllows ? "require_approval" : "allow",
    hook: async (item) => {
      calls.push(item.msgId);
      if (item.msgId === "msg-2" && calls.filter((id) => id === "msg-2").length === 1) {
        throw new Error("transient-hook-error");
      }
    },
  });
  try {
    await monitor.onInbound(payload(1));
    await monitor.onInbound(payload(2));
    await monitor.onInbound(payload(3));
    assert.equal(ctx.store.get("msg-1").state, "deferred");
    assert.equal(ctx.store.get("msg-2").state, "failed");
    assert.equal(ctx.store.get("msg-3").state, "handed_off");

    auditAllows = true;
    now += 10;
    await monitor.drain();
    assert.ok(ctx.store.list().every((row) => row.state === "handed_off"));
  } finally {
    ctx.close();
  }
});

test("loop-breaker suppression is deferred until the quiet window and then delivered", async () => {
  const ctx = context();
  let now = 3500;
  const calls = [];
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    loopBreaker: { maxWakes: 1, windowMs: 100 },
    retry: { baseDelayMs: 5, maxDelayMs: 20 },
    now: () => now,
    hook: async (item) => calls.push(item.msgId),
  });
  try {
    await monitor.onInbound(payload(1));
    await monitor.onInbound(payload(2));
    assert.deepEqual(calls, ["msg-1"]);
    assert.equal(ctx.store.get("msg-2").state, "deferred");
    now += 99;
    await monitor.drain();
    assert.deepEqual(calls, ["msg-1"]);
    now += 1;
    await monitor.drain();
    assert.deepEqual(calls, ["msg-1", "msg-2"]);
    assert.equal(ctx.store.get("msg-2").state, "handed_off");
  } finally {
    ctx.close();
  }
});

test("bounded retry reaches terminal failure and keeps the final reason", async () => {
  const ctx = context({ maxAttempts: 3 });
  let now = 4000;
  let calls = 0;
  const notifications = [];
  const logs = [];
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 5, maxDelayMs: 5 },
    now: () => now,
    notify: async (item, reason) => notifications.push({ item, reason }),
    log: (level, message, data) => logs.push({ level, message, data }),
    hook: async () => {
      calls += 1;
      throw new Error(`failure-${calls}`);
    },
  });
  try {
    await monitor.onInbound(payload(1));
    for (let i = 0; i < 3; i += 1) {
      now += 5;
      await monitor.drain();
    }
    const row = ctx.store.get("msg-1");
    assert.equal(calls, 3);
    assert.equal(row.state, "terminal");
    assert.equal(row.lastError, "failure-3");
    assert.equal(row.attempts, 3);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].reason, "terminal");
    assert.deepEqual(notifications[0].item.dispatchDiagnostic, {
      msgId: "msg-1",
      recipient: "local",
      memberSlot: "local",
      attempts: 3,
      lastError: "failure-3",
      timestamp: new Date(row.updatedAt).toISOString(),
      transitionReason: "delivery-attempt-budget-exhausted",
    });
    assert.ok(logs.some((entry) => entry.level === "error" && entry.message === "WakeMonitor dispatch terminal failure"));
  } finally {
    ctx.close();
  }
});

test("more than maxAttempts deferrals do not spend delivery attempts or become terminal", async () => {
  const ctx = context({ maxAttempts: 3 });
  let now = 4500;
  let leaseAvailable = false;
  let handoffs = 0;
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    now: () => now,
    leaseGate: async () => leaseAvailable
      ? { allow: true, token: 1 }
      : { allow: false, reason: "live-owner" },
    hook: async () => { handoffs += 1; },
  });
  try {
    await monitor.onInbound(payload(1));
    for (let i = 0; i < 8; i += 1) {
      now += 1;
      await monitor.drain();
    }
    let row = ctx.store.get("msg-1");
    assert.equal(row.state, "deferred");
    assert.equal(row.attempts, 0);
    assert.equal(row.claimCount, 9);
    leaseAvailable = true;
    now += 1;
    await monitor.drain();
    row = ctx.store.get("msg-1");
    assert.equal(handoffs, 1);
    assert.equal(row.state, "handed_off");
    assert.equal(row.attempts, 1);
  } finally {
    ctx.close();
  }
});

test("stateless pull runtime without onReceive hands off to durable inbox without spending an attempt", async () => {
  const ctx = context();
  const monitor = new WakeMonitor({ dispatchStore: ctx.store, mode: "stateless", hook: null });
  try {
    await monitor.onInbound(payload(1));
    const row = ctx.store.get("msg-1");
    assert.equal(row.state, "handed_off");
    assert.equal(row.attempts, 0);
    assert.equal(row.lastError, null);
  } finally {
    ctx.close();
  }
});

test("only real runtime failures spend delivery attempts", async () => {
  const ctx = context({ maxAttempts: 4 });
  let now = 4700;
  let calls = 0;
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    now: () => now,
    hook: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`runtime-failure-${calls}`);
    },
  });
  try {
    await monitor.onInbound(payload(1));
    assert.equal(ctx.store.get("msg-1").attempts, 1);
    now += 1;
    await monitor.drain();
    assert.equal(ctx.store.get("msg-1").attempts, 2);
    now += 1;
    await monitor.drain();
    assert.equal(ctx.store.get("msg-1").attempts, 3);
    assert.equal(ctx.store.get("msg-1").state, "handed_off");
  } finally {
    ctx.close();
  }
});

test("audit deny becomes rejected and is never retried", async () => {
  const ctx = context();
  let auditCalls = 0;
  let handoffs = 0;
  let now = 4800;
  const monitor = new WakeMonitor({
    dispatchStore: ctx.store,
    now: () => now,
    auditHook: async () => { auditCalls += 1; return "deny"; },
    hook: async () => { handoffs += 1; },
  });
  try {
    await monitor.onInbound(payload(1));
    let row = ctx.store.get("msg-1");
    assert.equal(row.state, "rejected");
    assert.equal(row.lastError, "audit-denied");
    assert.equal(row.attempts, 0);
    now += 1_000_000;
    await monitor.drain();
    row = ctx.store.get("msg-1");
    assert.equal(row.state, "rejected");
    assert.equal(auditCalls, 1);
    assert.equal(handoffs, 0);
  } finally {
    ctx.close();
  }
});

test("dispatch identity allows one msgId for distinct recipients while deduping each target", () => {
  const ctx = context({ recipientId: "agent-default" });
  try {
    ctx.store.enqueue({ ...payload(1), recipientAgentId: "agent-a" }, 5000);
    ctx.store.enqueue({ ...payload(1), recipientAgentId: "agent-b" }, 5001);
    ctx.store.enqueue({ ...payload(1), recipientAgentId: "agent-a", text: "duplicate" }, 5002);
    const rows = ctx.store.list();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.recipientId).sort(), ["agent-a", "agent-b"]);
    assert.equal(rows.find((row) => row.recipientId === "agent-a").payload.text, "message 1");
  } finally {
    ctx.close();
  }
});

test("crash after runtime handoff but before handed_off persistence retries at least once", async () => {
  const ctx = context({ maxAttempts: 3 });
  let handoffs = 0;
  ctx.store.enqueue(payload(1), 5100);
  const dispatch = ctx.store.claimDue(5100);
  assert.equal(ctx.store.beginHandoff(dispatch, 5100), 1);
  handoffs += 1; // Runtime received it; the daemon crashes before markHandedOff().
  ctx.store.close();

  const reopened = new WakeDispatchStore(ctx.dbPath, { maxAttempts: 3 });
  try {
    assert.equal(reopened.recoverStaleClaims({ now: 5200, claimTtlMs: 0 }), 1);
    const recovered = reopened.get("msg-1");
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.attempts, 1);
    assert.equal(recovered.lastError, "handoff-outcome-unknown-after-restart");
    const monitor = new WakeMonitor({
      dispatchStore: reopened,
      now: () => 5200,
      hook: async () => { handoffs += 1; },
    });
    await monitor.drain();
    assert.equal(handoffs, 2, "at-least-once crash window permits a duplicate runtime handoff");
    assert.equal(reopened.get("msg-1").state, "handed_off");
    assert.equal(reopened.get("msg-1").attempts, 2);
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("two active monitors cannot claim the same dispatch concurrently", async () => {
  const ctx = context();
  const secondStore = new WakeDispatchStore(ctx.dbPath);
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let turns = 0;
  const hook = async () => {
    turns += 1;
    await blocker;
  };
  const first = new WakeMonitor({ dispatchStore: ctx.store, hook });
  const second = new WakeMonitor({ dispatchStore: secondStore, hook });
  try {
    const running = first.onInbound(payload(1));
    await new Promise((resolve) => setImmediate(resolve));
    await second.onInbound(payload(1));
    assert.equal(turns, 1);
    release();
    await running;
    await second.drain();
    assert.equal(turns, 1);
    assert.equal(secondStore.get("msg-1").state, "handed_off");
  } finally {
    secondStore.close();
    ctx.close();
  }
});

test("restart recovers a dispatch left claimed by the previous daemon generation", async () => {
  const ctx = context();
  ctx.store.enqueue(payload(1), 5000);
  assert.equal(ctx.store.claimDue(5000).state, "claimed");
  ctx.store.close();

  const reopened = new WakeDispatchStore(ctx.dbPath);
  let calls = 0;
  try {
    assert.equal(reopened.recoverStaleClaims({ now: 5000, claimTtlMs: 0 }), 1);
    const monitor = new WakeMonitor({
      dispatchStore: reopened,
      now: () => 5000,
      hook: async () => { calls += 1; },
    });
    await monitor.drain();
    assert.equal(calls, 1);
    assert.equal(reopened.get("msg-1").state, "handed_off");
  } finally {
    reopened.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("restart backfills an inbound row persisted before dispatch enqueue", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-backfill-"));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, msg_id TEXT NOT NULL,
      direction TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, transport TEXT
    )
  `);
  db.prepare(`
    INSERT INTO local_messages
      (id, conversation_id, msg_id, direction, sender, text, created_at, transport)
    VALUES ('old', 'conv', 'old-msg', 'inbound', 'peer', 'old', '2026-01-01T00:00:00Z', 'nats')
  `).run();
  const store = new WakeDispatchStore(dbPath);
  db.prepare(`
    INSERT INTO local_messages
      (id, conversation_id, msg_id, direction, sender, text, created_at, transport)
    VALUES ('new', 'conv', 'new-msg', 'inbound', 'peer', 'new', '2026-01-01T00:00:01Z', 'nats')
  `).run();
  try {
    assert.equal(store.backfillMissingInbound(6000), 1);
    assert.equal(store.get("old-msg"), null, "pre-migration history is not replayed");
    assert.equal(store.get("new-msg").state, "pending");
  } finally {
    store.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
