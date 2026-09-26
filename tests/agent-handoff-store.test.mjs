import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { AgentHandoffStore, HANDOFF_STATES } from "../scripts/agent-handoff-store.mjs";

const contexts = [];
test.afterEach(() => {
  while (contexts.length) {
    const ctx = contexts.pop();
    ctx.store.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const setup = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-store-"));
  const store = new AgentHandoffStore(path.join(dir, "handoff.db"));
  const ctx = { dir, store };
  contexts.push(ctx);
  return ctx;
};

const record = (overrides = {}) => ({
  handoffMsgId: "h1",
  delegatorId: "claude-agent",
  recipientId: "codex-agent",
  causedByMessageId: "root-1",
  rootMessageId: "root-1",
  rootConversationId: "conv-root",
  handoffConversationId: "handoff:h1",
  parentActiveAncestry: [],
  handoffAncestry: ["claude-agent"],
  originatingBindingId: "binding-a",
  originatingBindingGeneration: 7,
  originatingRuntimeKind: "claude_one_shot",
  originatingMemberSlot: "claude:auto",
  originatingRuntimeSessionId: "claude-session-1",
  parentMessageId: "root-1",
  parentConversationId: "conv-root",
  parentSenderId: "human-agent",
  taskText: "audit the outbox retry path",
  ...overrides,
});

test("creates an open continuation carrying only continuation/routing state", () => {
  const { store } = setup();
  const { handoff, created } = store.createOrReuse(record(), 1_000);
  assert.equal(created, true);
  assert.equal(handoff.state, HANDOFF_STATES.open);
  assert.equal(handoff.handoffMsgId, "h1");
  assert.equal(handoff.handoffConversationId, "handoff:h1");
  assert.deepEqual(handoff.parentActiveAncestry, []);
  assert.deepEqual(handoff.handoffAncestry, ["claude-agent"]);
  assert.equal(handoff.originatingRuntimeSessionId, "claude-session-1");
  assert.equal(handoff.enqueuedAt, null);
  assert.equal(handoff.closedByMessageId, null);
  assert.equal(handoff.closedAt, null);
  assert.equal(handoff.createdAt, 1_000);
});

test("one handoff per causative message: a replay reuses the SAME handoff msgId", () => {
  const { store } = setup();
  const first = store.createOrReuse(record(), 1_000);
  const replay = store.createOrReuse(record({ handoffMsgId: "h2-different" }), 2_000);
  assert.equal(replay.created, false);
  assert.equal(replay.handoff.handoffMsgId, first.handoff.handoffMsgId);
  assert.equal(replay.handoff.createdAt, 1_000);
  assert.equal(store.list().length, 1);
});

test("a different causative message is a distinct handoff", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  store.createOrReuse(record({ handoffMsgId: "h2", causedByMessageId: "reply-1", parentActiveAncestry: [] }), 2_000);
  assert.equal(store.list().length, 2);
  assert.equal(store.findByCause("claude-agent", "reply-1").handoffMsgId, "h2");
});

test("exact child reply closes the continuation exactly once", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  const first = store.closeOnce({ handoffMsgId: "h1", replySenderId: "codex-agent", closedByMessageId: "c1" }, 2_000);
  assert.equal(first.closed, true);
  assert.equal(first.handoff.state, HANDOFF_STATES.closed);
  assert.equal(first.handoff.closedByMessageId, "c1");
  assert.equal(first.handoff.closedAt, 2_000);
  assert.deepEqual(first.handoff.parentActiveAncestry, []);
});

test("a DISTINCT second reply can never resume again", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  store.closeOnce({ handoffMsgId: "h1", replySenderId: "codex-agent", closedByMessageId: "c1" }, 2_000);
  const second = store.closeOnce({ handoffMsgId: "h1", replySenderId: "codex-agent", closedByMessageId: "c2" }, 3_000);
  assert.equal(second.closed, false);
  assert.equal(second.replay, false);
  assert.equal(second.reason, "handoff-continuation-already-closed");
  // the original closing message is preserved for audit
  assert.equal(store.get("h1").closedByMessageId, "c1");
});

test("the SAME closing message is a replay, so a retried dispatch can still finish", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  store.closeOnce({ handoffMsgId: "h1", replySenderId: "codex-agent", closedByMessageId: "c1" }, 2_000);
  const retry = store.closeOnce({ handoffMsgId: "h1", replySenderId: "codex-agent", closedByMessageId: "c1" }, 3_000);
  assert.equal(retry.closed, false);
  assert.equal(retry.replay, true);
  assert.equal(retry.reason, null);
  assert.equal(retry.handoff.closedAt, 2_000);
});

test("only the expected delegation target may close a continuation", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  const wrong = store.closeOnce({ handoffMsgId: "h1", replySenderId: "cursor-agent", closedByMessageId: "c1" }, 2_000);
  assert.equal(wrong.closed, false);
  assert.equal(wrong.reason, "handoff-continuation-sender-mismatch");
  assert.equal(store.get("h1").state, HANDOFF_STATES.open);
});

test("an unknown handoff id cannot be closed", () => {
  const { store } = setup();
  const missing = store.closeOnce({ handoffMsgId: "nope", replySenderId: "codex-agent", closedByMessageId: "c1" });
  assert.equal(missing.closed, false);
  assert.equal(missing.reason, "handoff-continuation-missing");
});

test("a terminal continuation refuses any close", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  assert.equal(store.markTerminal({ handoffMsgId: "h1", reason: "handoff-continuation-session-unavailable" }, 2_000), 1);
  const refused = store.closeOnce({ handoffMsgId: "h1", replySenderId: "codex-agent", closedByMessageId: "c1" }, 3_000);
  assert.equal(refused.closed, false);
  assert.equal(refused.reason, "handoff-continuation-terminal");
  assert.equal(store.get("h1").terminalReason, "handoff-continuation-session-unavailable");
});

test("restart reloads open continuations and pending enqueues from disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-restart-"));
  const dbPath = path.join(dir, "handoff.db");
  try {
    const first = new AgentHandoffStore(dbPath);
    first.createOrReuse(record(), 1_000);
    first.createOrReuse(record({ handoffMsgId: "h2", causedByMessageId: "root-2", rootMessageId: "root-2" }), 1_100);
    first.markEnqueued("h2", 1_200);
    first.close();

    const reopened = new AgentHandoffStore(dbPath);
    const open = reopened.listOpen();
    assert.deepEqual(open.map((row) => row.handoffMsgId), ["h1", "h2"]);
    assert.deepEqual(reopened.pendingEnqueue().map((row) => row.handoffMsgId), ["h1"]);
    assert.equal(reopened.get("h1").originatingBindingGeneration, 7);
    assert.equal(reopened.get("h1").taskText, "audit the outbox retry path");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markEnqueued is idempotent and keeps the first timestamp", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  store.markEnqueued("h1", 1_500);
  store.markEnqueued("h1", 9_000);
  assert.equal(store.get("h1").enqueuedAt, 1_500);
  assert.equal(store.pendingEnqueue().length, 0);
});

test("nested continuations keep a non-empty saved parent active path", () => {
  const { store } = setup();
  const { handoff } = store.createOrReuse(record({
    handoffMsgId: "h2",
    delegatorId: "codex-agent",
    recipientId: "cursor-agent",
    causedByMessageId: "h1",
    parentActiveAncestry: ["claude-agent"],
    handoffAncestry: ["claude-agent", "codex-agent"],
    parentMessageId: "h1",
    parentConversationId: "handoff:h1",
    parentSenderId: "claude-agent",
  }), 1_000);
  assert.deepEqual(handoff.parentActiveAncestry, ["claude-agent"]);
  assert.deepEqual(handoff.handoffAncestry, ["claude-agent", "codex-agent"]);
  const closed = store.closeOnce({ handoffMsgId: "h2", replySenderId: "cursor-agent", closedByMessageId: "c2" }, 2_000);
  assert.deepEqual(closed.handoff.parentActiveAncestry, ["claude-agent"]);
});

test("malformed lineage and missing identity are rejected at write time", () => {
  const { store } = setup();
  assert.throws(() => store.createOrReuse(record({ handoffAncestry: ["a", "a"] })), /handoffAncestry-invalid/);
  assert.throws(() => store.createOrReuse(record({ parentActiveAncestry: ["", "b"] })), /parentActiveAncestry-invalid/);
  assert.throws(() => store.createOrReuse(record({ rootMessageId: "" })), /rootMessageId-required/);
  assert.throws(() => store.createOrReuse(record({ taskText: "  " })), /taskText-required/);
  assert.throws(() => store.createOrReuse(record({ originatingBindingGeneration: 1.5 })), /originatingBindingGeneration-invalid/);
});

test("the store migrates onto an existing pre-handoff database additively", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-migrate-"));
  const dbPath = path.join(dir, "murmur.db");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE local_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, msg_id TEXT NOT NULL,
        direction TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
        created_at TEXT NOT NULL, transport TEXT
      );
      INSERT INTO local_messages VALUES
        ('old', 'conv', 'old-msg', 'inbound', 'peer', 'hi', '2026-01-01T00:00:00.000Z', 'nats');
    `);
    legacy.close();

    const store = new AgentHandoffStore(dbPath);
    store.createOrReuse(record(), 1_000);
    assert.equal(store.get("h1").state, HANDOFF_STATES.open);
    // the pre-existing table is untouched
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_messages").get().n, 1);
    db.close();
    store.close();

    // reopening is idempotent (ensureColumns must not re-add anything)
    const again = new AgentHandoffStore(dbPath);
    assert.equal(again.list().length, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local_messages stores handoff lineage as explicit columns, never as parsed text", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-audit-"));
  const dbPath = path.join(dir, "murmur.db");
  try {
    const msgStore = new SQLiteMessageStore(dbPath);
    const handoff = {
      rootMessageId: "root-1",
      rootConversationId: "conv-root",
      causedByMessageId: "root-1",
      ancestry: ["claude-agent"],
    };
    await msgStore.appendIdempotent({
      conversationId: "handoff:h1", msgId: "h1", direction: "outbound", sender: "claude-agent",
      recipientId: "codex-agent", text: "bounded task", createdAt: "2026-09-26T00:00:00.000Z",
      transport: "nats", handoff,
    });
    await msgStore.append({
      conversationId: "conv-root", msgId: "root-1", direction: "inbound", sender: "human-agent",
      recipientId: "claude-agent", text: "ship it", createdAt: "2026-09-26T00:00:00.000Z", transport: "nats",
    });

    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT * FROM local_messages WHERE msg_id = 'h1'").get();
    assert.equal(row.recipient_id, "codex-agent");
    assert.equal(row.handoff_root_message_id, "root-1");
    assert.equal(row.handoff_root_conversation_id, "conv-root");
    assert.equal(row.handoff_caused_by_message_id, "root-1");
    assert.deepEqual(JSON.parse(row.handoff_ancestry_json), ["claude-agent"]);
    // ordinary rows stay compatible: lineage columns are NULL, not empty strings
    const ordinary = db.prepare("SELECT * FROM local_messages WHERE msg_id = 'root-1'").get();
    assert.equal(ordinary.handoff_root_message_id, null);
    assert.equal(ordinary.handoff_ancestry_json, null);
    assert.equal(ordinary.recipient_id, "claude-agent");
    db.close();

    // reads round-trip the lineage without touching the plaintext
    const inbox = await msgStore.listInbound(10);
    assert.equal(inbox[0].msgId, "root-1");
    assert.equal(inbox[0].handoff, null);
    assert.equal(inbox[0].recipientId, "claude-agent");
    const search = await msgStore.searchMessages("bounded task", 10);
    assert.deepEqual(search[0].handoff, handoff);
    assert.equal(search[0].recipientId, "codex-agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closeOnce enforces the DERIVED conversation, not the root conversation", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  const wrong = store.closeOnce({
    handoffMsgId: "h1", replySenderId: "codex-agent",
    replyConversationId: "conv-root", closedByMessageId: "c1",
  }, 2_000);
  assert.equal(wrong.closed, false);
  assert.equal(wrong.reason, "handoff-continuation-conversation-mismatch");
  assert.equal(store.get("h1").state, HANDOFF_STATES.open);
  assert.equal(store.get("h1").closedByMessageId, null);

  const right = store.closeOnce({
    handoffMsgId: "h1", replySenderId: "codex-agent",
    replyConversationId: "handoff:h1", closedByMessageId: "c1",
  }, 2_100);
  assert.equal(right.closed, true);
  assert.equal(store.get("h1").closedByMessageId, "c1");
});

test("the fenced primitives refuse to run without a fence at all", () => {
  const { store } = setup();
  store.createOrReuse(record(), 1_000);
  assert.throws(() => store.fencedCreate({ record: record() }), /agent-handoff-fence-required/);
  assert.throws(() => store.fencedClose({ handoffMsgId: "h1", closedByMessageId: "c1" }), /agent-handoff-fence-required/);
  assert.throws(() => store.fencedTerminate({ handoffMsgId: "h1", reason: "x" }), /agent-handoff-fence-required/);
});

test("a fenced mutation fails loudly when the fencing tables are absent", () => {
  const { store } = setup();
  // A standalone handoff database has no runtime_bindings: there is no authority to check,
  // so the fenced path must error rather than silently proceed unfenced.
  assert.throws(
    () => store.fencedCreate({ fence: { bindingId: "b", ownerGeneration: 1, fencingToken: 1, fencingEpoch: 1 }, record: record() }),
    /agent-handoff-runtime-bindings-missing/,
  );
  assert.deepEqual(store.list(), []);
});
