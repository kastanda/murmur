import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMessageStore } from "../packages/core/dist/src/index.js";

const withStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-inbox-"));
  const dbPath = join(dir, "murmur.db");
  const store = new SQLiteMessageStore(dbPath);
  return { store, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const append = (store, { direction, sender, text, at }) =>
  store.append({
    conversationId: "peer:task:test",
    msgId: `${direction}-${text.slice(0, 8)}-${at}`,
    direction,
    sender,
    text,
    createdAt: at,
  });

test("listInbound returns delivered inbound messages that never mention the agent", async () => {
  const { store, cleanup } = withStore();
  try {
    // The regression from #114: none of these three spell out the receiving agent's
    // name, which is the normal case for a reply.
    await append(store, { direction: "inbound", sender: "agent-peer", text: "done, deployed", at: "2026-08-26T22:00:00.000Z" });
    await append(store, { direction: "inbound", sender: "agent-peer", text: "logs look clean", at: "2026-08-26T22:01:00.000Z" });
    await append(store, { direction: "outbound", sender: "agent-claude", text: "check the logs", at: "2026-08-26T22:02:00.000Z" });

    const inbound = await store.listInbound(20);

    assert.equal(inbound.length, 2);
    assert.ok(inbound.every((m) => m.direction === "inbound"));
    assert.deepEqual(inbound.map((m) => m.text), ["logs look clean", "done, deployed"]);
  } finally {
    cleanup();
  }
});

test("the old searchMessages(agentId) form is what dropped them", async () => {
  const { store, cleanup } = withStore();
  try {
    await append(store, { direction: "inbound", sender: "agent-peer", text: "done, deployed", at: "2026-08-26T22:00:00.000Z" });

    // Guards the reason for the fix rather than the fix itself: a LIKE over
    // text/sender/conversationId cannot see a message that does not name the agent,
    // and the tool reported count:0 while the sender saw the message acked.
    const viaSearch = await store.searchMessages("agent-claude", 100);
    assert.equal(viaSearch.length, 0);

    const viaInbox = await store.listInbound(20);
    assert.equal(viaInbox.length, 1);
  } finally {
    cleanup();
  }
});

test("listInbound honours the limit and returns newest first", async () => {
  const { store, cleanup } = withStore();
  try {
    for (let i = 0; i < 5; i += 1) {
      await append(store, {
        direction: "inbound",
        sender: "agent-peer",
        text: `msg ${i}`,
        at: `2026-08-26T22:0${i}:00.000Z`,
      });
    }

    const inbound = await store.listInbound(2);

    assert.equal(inbound.length, 2);
    assert.deepEqual(inbound.map((m) => m.text), ["msg 4", "msg 3"]);
  } finally {
    cleanup();
  }
});

test("memberSlot is persisted while legacy rows remain readable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-inbox-migrate-"));
  const dbPath = join(dir, "murmur.db");
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE local_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, msg_id TEXT NOT NULL,
      direction TEXT NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT NOT NULL, transport TEXT
    );
    INSERT INTO local_messages VALUES
      ('old-id', 'old-conv', 'old-msg', 'inbound', 'peer', 'old', '2026-01-01T00:00:00.000Z', 'nats');
  `);
  legacy.close();
  const store = new SQLiteMessageStore(dbPath);
  try {
    await store.append({
      conversationId: "auto-conv", msgId: "auto-msg", direction: "inbound",
      sender: "peer", text: "auto", createdAt: "2026-01-01T00:00:01.000Z",
      memberSlot: "claude:auto",
    });
    const rows = await store.listInbound(10);
    assert.equal(rows.find((row) => row.msgId === "auto-msg")?.memberSlot, "claude:auto");
    assert.equal(rows.find((row) => row.msgId === "old-msg")?.memberSlot, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendIdempotent mirrors one row per direction and msgId without blocking distinct replies", async () => {
  const { store, dbPath, cleanup } = withStore();
  try {
    const base = {
      conversationId: "conv", direction: "outbound", sender: "claude",
      text: "reply", createdAt: "2026-01-01T00:00:00.000Z",
    };
    await store.appendIdempotent({ ...base, msgId: "reply-1" });
    await store.appendIdempotent({ ...base, msgId: "reply-1" });
    await store.appendIdempotent({ ...base, msgId: "reply-2" });
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_messages WHERE direction='outbound' AND msg_id='reply-1'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_messages WHERE direction='outbound'").get().count, 2);
    db.close();
  } finally {
    cleanup();
  }
});
