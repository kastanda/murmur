import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { waitForReply } from "../packages/mcp-server/dist/src/request-reply.js";

const createStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-reply-correlation-"));
  const dbPath = path.join(dir, "murmur.db");
  const store = new SQLiteMessageStore(dbPath);
  return { dir, dbPath, store };
};

const appendInbound = (store, {
  msgId,
  replyToMessageId,
  sender = "agent-b",
  conversationId = "conv-1",
  createdAt = "2026-09-18T10:00:00.000Z",
}) => store.append({
  conversationId,
  msgId,
  ...(replyToMessageId ? { replyToMessageId } : {}),
  direction: "inbound",
  sender,
  text: msgId,
  createdAt,
  transport: "nats",
});

test("two concurrent requests in one conversation resolve reverse-order replies exactly", async () => {
  const ctx = createStore();
  try {
    await appendInbound(ctx.store, { msgId: "reply-b", replyToMessageId: "req-b" });
    await appendInbound(ctx.store, { msgId: "reply-a", replyToMessageId: "req-a" });
    const wait = (requestId) => waitForReply({
      checkStore: async () => (await ctx.store.getRepliesTo(requestId, "agent-b", 1))[0] ?? null,
      pollMs: 10,
      graceMs: 0,
      deadline: Date.now() + 100,
    });
    const [replyA, replyB] = await Promise.all([wait("req-a"), wait("req-b")]);
    assert.equal(replyA?.msgId, "reply-a");
    assert.equal(replyB?.msgId, "reply-b");
  } finally {
    ctx.store.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("unrelated, wrong-target, late, and wrong-sender messages never satisfy strict lookup", async () => {
  const ctx = createStore();
  try {
    await appendInbound(ctx.store, { msgId: "ordinary" });
    await appendInbound(ctx.store, { msgId: "wrong-target", replyToMessageId: "req-other" });
    await appendInbound(ctx.store, { msgId: "late", replyToMessageId: "req-previous" });
    await appendInbound(ctx.store, { msgId: "wrong-sender", replyToMessageId: "req-current", sender: "agent-c" });
    assert.deepEqual(await ctx.store.getRepliesTo("req-current", "agent-b"), []);
  } finally {
    ctx.store.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("duplicate replies resolve deterministically to the first and both remain in the inbox", async () => {
  const ctx = createStore();
  try {
    await appendInbound(ctx.store, { msgId: "reply-first", replyToMessageId: "req-1" });
    await appendInbound(ctx.store, { msgId: "reply-second", replyToMessageId: "req-1" });
    const replies = await ctx.store.getRepliesTo("req-1", "agent-b", 10);
    assert.deepEqual(replies.map((row) => row.msgId), ["reply-first", "reply-second"]);
    assert.equal((await ctx.store.listInbound(10)).filter((row) => row.replyToMessageId === "req-1").length, 2);
  } finally {
    ctx.store.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("nested reply chain preserves immediate parents and survives store restart", async () => {
  const ctx = createStore();
  await appendInbound(ctx.store, { msgId: "reply-1", replyToMessageId: "req-1" });
  await appendInbound(ctx.store, { msgId: "followup", replyToMessageId: "reply-1" });
  ctx.store.db.close();
  const reopened = new SQLiteMessageStore(ctx.dbPath);
  try {
    const first = await reopened.getRepliesTo("req-1", "agent-b", 1);
    const followup = await reopened.getRepliesTo("reply-1", "agent-b", 1);
    assert.equal(first[0]?.msgId, "reply-1");
    assert.equal(first[0]?.conversationId, "conv-1");
    assert.equal(followup[0]?.msgId, "followup");
    assert.equal(followup[0]?.replyToMessageId, "reply-1");
    assert.equal(followup[0]?.conversationId, "conv-1");
  } finally {
    reopened.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("legacy local_messages rows remain readable when reply correlation column is added", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-reply-legacy-"));
  const dbPath = path.join(dir, "murmur.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE local_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, msg_id TEXT NOT NULL,
      direction TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, transport TEXT
    );
    INSERT INTO local_messages
      (id, conversation_id, msg_id, direction, sender, text, created_at, transport)
    VALUES ('legacy', 'conv-1', 'legacy-msg', 'inbound', 'agent-b', 'old',
            '2026-09-18T09:00:00.000Z', 'nats');
  `);
  legacy.close();
  const store = new SQLiteMessageStore(dbPath);
  try {
    const inbox = await store.listInbound(10);
    assert.equal(inbox[0]?.msgId, "legacy-msg");
    assert.equal(inbox[0]?.replyToMessageId, null);
    assert.equal(await store.getRepliesTo("anything", "agent-b", 1).then((rows) => rows.length), 0);
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
