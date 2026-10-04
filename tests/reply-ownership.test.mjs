/**
 * Correlated reply ownership: exactly one execution owner per reply.
 *
 * The interactive MCP server and the autonomous daemon are ONE Murmur identity over ONE
 * `murmur.db`. These tests pin that a reply to an MCP-client request is stored for the client
 * and never starts an autonomous turn, that a daemon handoff continuation still wakes exactly
 * itself, and that the decision survives restart, duplicates and a vanished client.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLiteDedupeOutboxStore, SQLiteMessageStore } from "../packages/core/dist/src/index.js";
import { commitOutbound, createMcpReplyOwnership } from "../packages/mcp-server/dist/src/outbound.js";
import { AgentHandoffStore } from "../scripts/agent-handoff-store.mjs";
import { REPLY_ORIGINS, ReplyOwnershipStore } from "../scripts/reply-ownership-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";

const CLAUDE = "agent-claude";
const CODEX = "agent-codex";
const profile = { kind: "project", projectId: "p", dataDir: "/x" };

const world = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-reply-owner-"));
  const dbPath = path.join(dir, "murmur.db");
  const messages = new SQLiteMessageStore(dbPath);
  const outbox = new SQLiteDedupeOutboxStore(dbPath);
  const dispatch = new WakeDispatchStore(dbPath, { recipientId: CLAUDE });
  const executions = [];
  const monitor = new WakeMonitor({
    dispatchStore: dispatch,
    loopBreaker: { maxWakes: 1000, windowMs: 60_000 },
    hook: async (item) => executions.push(item.msgId),
  });
  return {
    dir, dbPath, messages, outbox, dispatch, monitor, executions,
    ownership: createMcpReplyOwnership(dbPath),
    reopen() {
      dispatch.close();
      const next = new WakeDispatchStore(dbPath, { recipientId: CLAUDE });
      return { dispatch: next, monitor: new WakeMonitor({
        dispatchStore: next, loopBreaker: { maxWakes: 1000, windowMs: 60_000 },
        hook: async (item) => executions.push(item.msgId),
      }) };
    },
    close() {
      try { dispatch.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const request = (msgId, ts = "2026-10-04T00:00:00.000Z") => ({
  schemaVersion: "1.0", msgId, conversationId: `dm:${CLAUDE}:${CODEX}`, senderAgentId: CLAUDE,
  recipients: [CODEX], createdAt: ts, payloadCiphertext: "c", payloadNonce: "n", signature: "s",
});
const reply = (msgId, replyToMessageId, extra = {}) => ({
  from: CODEX, text: "SMOKE-ACK", msgId, replyToMessageId, conversationId: `dm:${CLAUDE}:${CODEX}`, cursor: 1, ...extra,
});
const mcpSend = (w, msgId) => commitOutbound({
  outbox: w.outbox, store: w.messages, profile, subject: `msg.${CODEX}`, envelope: request(msgId), text: "hi",
  ownership: w.ownership,
});
const rowOf = (w, msgId) => w.dispatch.get({ msgId, recipientId: CLAUDE, memberSlot: CLAUDE });

test("1. MCP client send: the correlated reply is stored for the client and starts zero autonomous turns", async () => {
  const w = world();
  try {
    const receipt = await mcpSend(w, "req-1");
    assert.equal(receipt.durable, true);
    assert.deepEqual(new ReplyOwnershipStore(new DatabaseSync(w.dbPath)).get("req-1")?.origin, REPLY_ORIGINS.mcpClient);

    await w.monitor.onInbound(reply("rep-1", "req-1"));
    assert.deepEqual(w.executions, [], "no autonomous model turn for a client-owned reply");
    const row = rowOf(w, "rep-1");
    assert.equal(row.state, "handed_off");
    assert.match(row.lastError, /^reply-owned-by-mcp-client:mcp:/);
    assert.equal(w.dispatch.claimDue(Date.now()), null, "never claimable");
  } finally { w.close(); }
});

test("1b. ownership is durable before the outbox commit, and a failed ownership write refuses the send", async () => {
  const w = world();
  try {
    const order = [];
    const outbox = { enqueue: async () => order.push("outbox"), getOutboxRecord: async (msgId) => ({ msgId, subject: `msg.${CODEX}`, status: "pending" }) };
    await commitOutbound({
      outbox, store: w.messages, profile, subject: `msg.${CODEX}`, envelope: request("req-order"), text: "t",
      ownership: { record: () => order.push("ownership") },
    });
    assert.deepEqual(order, ["ownership", "outbox"]);
    await assert.rejects(commitOutbound({
      outbox, store: w.messages, profile, subject: `msg.${CODEX}`, envelope: request("req-fail"), text: "t",
      ownership: { record: () => { throw new Error("disk full"); } },
    }), (error) => error.code === "reply-ownership-unrecorded");
    assert.equal(order.filter((entry) => entry === "outbox").length, 1, "nothing left the outbox when ownership failed");
  } finally { w.close(); }
});

test("2. autonomous handoff: the reply closing a daemon continuation still wakes exactly that continuation", async () => {
  const w = world();
  try {
    const handoffs = new AgentHandoffStore(w.dbPath);
    handoffs.createOrReuse({
      handoffMsgId: "h-1", delegatorId: CLAUDE, recipientId: CODEX, causedByMessageId: "root-1", rootMessageId: "root-1",
      rootConversationId: "conv-root", handoffConversationId: "handoff:h-1", parentActiveAncestry: [], handoffAncestry: [CLAUDE],
      originatingBindingId: "b", originatingBindingGeneration: 1, originatingRuntimeKind: "claude_one_shot",
      originatingMemberSlot: "claude:auto", originatingRuntimeSessionId: "s", parentMessageId: "root-1",
      parentConversationId: "conv-root", parentSenderId: "root", taskText: "t",
    }, 1);
    // Even if the same msgId were ALSO recorded as client-owned, the held continuation wins.
    w.ownership.record("h-1", "mcp:x");
    assert.equal(ReplyOwnershipStore.route(new DatabaseSync(w.dbPath), "h-1"), null);

    await w.monitor.onInbound(reply("c-1", "h-1", { conversationId: "handoff:h-1" }));
    assert.deepEqual(w.executions, ["c-1"], "continuation woken exactly once");
    handoffs.close();
  } finally { w.close(); }
});

test("3. nested handoff: every hop that closes a daemon continuation wakes; client-owned hops do not", async () => {
  const w = world();
  try {
    const handoffs = new AgentHandoffStore(w.dbPath);
    const mk = (id, delegator, recipient) => handoffs.createOrReuse({
      handoffMsgId: id, delegatorId: delegator, recipientId: recipient, causedByMessageId: "root", rootMessageId: "root",
      rootConversationId: "c", handoffConversationId: `handoff:${id}`, parentActiveAncestry: [], handoffAncestry: [delegator],
      originatingBindingId: "b", originatingBindingGeneration: 1, originatingRuntimeKind: "claude_one_shot",
      originatingMemberSlot: "claude:auto", originatingRuntimeSessionId: "s", parentMessageId: "root",
      parentConversationId: "c", parentSenderId: "root", taskText: "t",
    }, 1);
    mk("h-claude-codex", CLAUDE, CODEX);
    mk("h-codex-cursor", CODEX, "agent-cursor");
    await mcpSend(w, "client-req");
    for (const [id, replyTo] of [["r-a", "h-codex-cursor"], ["r-b", "h-claude-codex"], ["r-c", "client-req"]]) {
      await w.monitor.onInbound(reply(id, replyTo, { cursor: 1 }));
    }
    assert.deepEqual(w.executions, ["r-a", "r-b"]);
    handoffs.close();
  } finally { w.close(); }
});

test("4. client disconnects before the reply: the reply is durable, never autonomous work, and no loop forms", async () => {
  const w = world();
  try {
    await mcpSend(w, "req-gone");
    // The client process is simply gone; only durable state remains.
    await w.messages.append({ conversationId: `dm:${CLAUDE}:${CODEX}`, msgId: "rep-gone", replyToMessageId: "req-gone",
      direction: "inbound", sender: CODEX, text: "SMOKE-ACK", createdAt: "2026-10-04T00:00:01.000Z", transport: "nats" });
    await w.monitor.onInbound(reply("rep-gone", "req-gone"));
    assert.deepEqual(w.executions, []);
    assert.equal((await w.messages.getRepliesTo("req-gone", CODEX, 5))[0].text, "SMOKE-ACK", "retrievable by the client/recovery path");
    assert.equal(w.dispatch.list().filter((row) => row.state !== "handed_off").length, 0);
  } finally { w.close(); }
});

test("5. duplicate correlated reply: dedupe preserved, still no model execution", async () => {
  const w = world();
  try {
    await mcpSend(w, "req-dup");
    await w.monitor.onInbound(reply("rep-dup", "req-dup"));
    await w.monitor.onInbound(reply("rep-dup", "req-dup"));
    assert.deepEqual(w.executions, []);
    assert.equal(w.dispatch.list().filter((row) => row.msgId === "rep-dup").length, 1);
  } finally { w.close(); }
});

test("6. restart between send and reply: ownership survives, including inbound backfill after a crash", async () => {
  const w = world();
  try {
    await mcpSend(w, "req-restart");
    // Crash window: the inbound audit row was written but the dispatch row was not.
    await w.messages.append({ conversationId: `dm:${CLAUDE}:${CODEX}`, msgId: "rep-restart", replyToMessageId: "req-restart",
      direction: "inbound", sender: CODEX, text: "SMOKE-ACK", createdAt: "2026-10-04T00:00:02.000Z", transport: "nats" });
    const next = w.reopen();
    assert.equal(next.dispatch.backfillMissingInbound(), 1);
    await next.monitor.drain();
    assert.deepEqual(w.executions, [], "backfill must not resurrect a client-owned reply as work");
    assert.equal(next.dispatch.get({ msgId: "rep-restart", recipientId: CLAUDE, memberSlot: CLAUDE }).state, "handed_off");
    next.dispatch.close();
  } finally { w.close(); }
});

test("7. a genuine new inbound request (and an un-owned legacy reply) still wakes normally", async () => {
  const w = world();
  try {
    await w.monitor.onInbound({ from: CODEX, text: "please review", msgId: "new-1", conversationId: "dm:new", cursor: 1 });
    await w.monitor.onInbound(reply("legacy-1", "unrecorded-request"));
    assert.deepEqual(w.executions, ["new-1", "legacy-1"]);
  } finally { w.close(); }
});

test("a follow-up replying to the runtime's own answer is legitimate traffic and still wakes (no blanket terminal rule)", async () => {
  const w = world();
  try {
    // The daemon's own answer is recorded nowhere as terminal: a client/operator may reply to it.
    await w.monitor.onInbound(reply("followup-1", "runtime-answer", { text: "thanks, now also do X" }));
    assert.deepEqual(w.executions, ["followup-1"]);
  } finally { w.close(); }
});

test("operator-client sends (shell sender --origin) record ownership; other origins are refused", () => {
  const w = world();
  try {
    const store = new ReplyOwnershipStore(new DatabaseSync(w.dbPath));
    store.record({ msgId: "op-1", origin: REPLY_ORIGINS.operatorClient, owner: "operator:root" });
    assert.equal(ReplyOwnershipStore.route(new DatabaseSync(w.dbPath), "op-1").reason, "reply-owned-by-operator-client");
    assert.throws(() => store.record({ msgId: "x", origin: "autonomous_reply", owner: "r" }), /origin-invalid/);
  } finally { w.close(); }
});

test("migration keeps client rows of the earlier CHECK-constrained table and drops the removed origin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-reply-owner-mig-"));
  try {
    const db = new DatabaseSync(path.join(dir, "murmur.db"));
    db.exec(`CREATE TABLE reply_ownership (msg_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK (origin IN ('mcp_client', 'autonomous_reply')), owner TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO reply_ownership VALUES ('keep', 'mcp_client', 'mcp:a', 1), ('drop', 'autonomous_reply', 'runtime:a', 1);`);
    const store = new ReplyOwnershipStore(db);
    assert.equal(store.get("keep").owner, "mcp:a");
    assert.equal(store.get("drop"), null);
    store.record({ msgId: "new", origin: REPLY_ORIGINS.operatorClient, owner: "operator:r" });
    assert.equal(store.get("new").origin, "operator_client");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ownership is first-write-wins and rejects unknown origins", () => {
  const w = world();
  try {
    const store = new ReplyOwnershipStore(new DatabaseSync(w.dbPath));
    store.record({ msgId: "m", origin: REPLY_ORIGINS.mcpClient, owner: "a" });
    store.record({ msgId: "m", origin: REPLY_ORIGINS.operatorClient, owner: "b" });
    assert.equal(store.get("m").owner, "a");
    assert.throws(() => store.record({ msgId: "x", origin: "root_workflow", owner: "r" }), /origin-invalid/);
  } finally { w.close(); }
});

test("migration waits for a concurrent writer instead of failing with SQLITE_BUSY", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-reply-owner-busy-"));
  const dbPath = path.join(dir, "murmur.db");
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE reply_ownership (msg_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL CHECK (origin IN ('mcp_client', 'autonomous_reply')), owner TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO reply_ownership VALUES ('keep', 'mcp_client', 'mcp:a', 1);`);
    seed.close();
    // A second process holds the write lock for ~800ms (the MCP server / outbox flusher).
    const holder = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec("BEGIN IMMEDIATE"); console.log("locked");
      setTimeout(() => { db.exec("COMMIT"); process.exit(0); }, 800);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve) => holder.stdout.once("data", resolve));
    const db = new DatabaseSync(dbPath); // deliberately NO busy_timeout: the store must set its own
    const store = new ReplyOwnershipStore(db);
    assert.equal(store.get("keep").owner, "mcp:a");
    await new Promise((resolve) => holder.once("exit", resolve));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
