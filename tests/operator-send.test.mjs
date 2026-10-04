import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteMessageStore } from "@murmurv2/core";
import { enqueueRootTask, findCorrelatedReply, findRejectedCandidates, waitForCorrelatedReply } from "../scripts/operator/send.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const withStore = async (fn) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-send-"));
  const dbPath = path.join(dir, "murmur.db");
  const store = new SQLiteMessageStore(dbPath);
  try {
    return await fn({ dbPath, store });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const COORDINATOR = "proj-claude";
const CONVERSATION = "dm:proj-root:proj-claude";
const correlationFor = (msgId) => ({ msgId, expectedSender: COORDINATOR, conversationId: CONVERSATION });

const inbound = (store, { msgId, replyToMessageId, text, sender = COORDINATOR, conversationId = CONVERSATION }) =>
  store.append({
    conversationId,
    msgId,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    direction: "inbound",
    sender,
    recipientId: "proj-root",
    text,
    createdAt: new Date().toISOString(),
    transport: "nats",
  });

test("enqueueRootTask delegates to the existing shell sender and returns its message id", async () => {
  const calls = [];
  const result = await enqueueRootTask({
    murmurRoot: "/opt/murmur",
    rootDataDir: "/state/agents/root",
    to: "proj-claude",
    text: "summarise the README",
    conversationId: "conv-9",
    exec: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: `${JSON.stringify({ msgId: "m-1", to: "proj-claude", conversationId: "conv-9", status: "queued" })}\n` };
    },
  });
  assert.equal(result.msgId, "m-1");
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.join("/opt/murmur", "scripts", "murmur-shell-send.mjs"),
    "--to", "proj-claude",
    "--text", "summarise the README",
    "--origin", "operator_client",
    "--conv", "conv-9",
  ]);
  assert.equal(calls[0].options.env.DATA_DIR, "/state/agents/root");
});

test("enqueueRootTask fails loudly when the sender returns no message id", async () => {
  await assert.rejects(
    () => enqueueRootTask({
      murmurRoot: "/opt/murmur",
      rootDataDir: "/state/root",
      to: "x",
      text: "y",
      exec: async () => ({ stdout: JSON.stringify({ status: "queued" }) }),
    }),
    /send-msg-id-missing/,
  );
});

test("the exact reply — right replyTo, sender and conversation — is accepted", async () => {
  await withStore(async ({ dbPath, store }) => {
    await inbound(store, { msgId: "noise-1", text: "unrelated chatter in the same conversation" });
    await inbound(store, { msgId: "reply-other", replyToMessageId: "some-other-message", text: "wrong answer" });
    assert.equal(findCorrelatedReply(dbPath, correlationFor("task-1")), null);

    await inbound(store, { msgId: "reply-1", replyToMessageId: "task-1", text: "the answer" });
    const reply = findCorrelatedReply(dbPath, correlationFor("task-1"));
    assert.equal(reply.msgId, "reply-1");
    assert.equal(reply.text, "the answer");
    assert.equal(reply.sender, COORDINATOR);
  });
});

test("a reply with the right replyToMessageId but the WRONG SENDER is never accepted", async () => {
  await withStore(async ({ dbPath, store }) => {
    await inbound(store, { msgId: "imposter", replyToMessageId: "task-2", text: "I am not the coordinator", sender: "proj-codex" });
    assert.equal(findCorrelatedReply(dbPath, correlationFor("task-2")), null);
    assert.deepEqual(
      findRejectedCandidates(dbPath, correlationFor("task-2")).map((row) => row.sender),
      ["proj-codex"],
    );
  });
});

test("a reply from the right sender on the WRONG CONVERSATION is never accepted", async () => {
  await withStore(async ({ dbPath, store }) => {
    await inbound(store, {
      msgId: "off-conversation",
      replyToMessageId: "task-3",
      text: "right agent, wrong thread",
      conversationId: `${CONVERSATION}#handoff-abc`,
    });
    assert.equal(findCorrelatedReply(dbPath, correlationFor("task-3")), null);
    assert.equal(findRejectedCandidates(dbPath, correlationFor("task-3"))[0].conversationId, `${CONVERSATION}#handoff-abc`);
  });
});

test("a later EXACT reply still satisfies the wait after non-matching candidates", async () => {
  await withStore(async ({ dbPath, store }) => {
    await inbound(store, { msgId: "wrong-sender", replyToMessageId: "task-4", text: "nope", sender: "proj-cursor" });
    await inbound(store, { msgId: "wrong-conv", replyToMessageId: "task-4", text: "nope", conversationId: "other" });
    assert.equal(findCorrelatedReply(dbPath, correlationFor("task-4")), null);

    await inbound(store, { msgId: "right", replyToMessageId: "task-4", text: "finally" });
    assert.equal(findCorrelatedReply(dbPath, correlationFor("task-4")).text, "finally");
  });
});

test("an incomplete correlation is a programming error, not a loose match", () => {
  assert.throws(() => findCorrelatedReply("/x", { msgId: "a" }), /send-correlation-incomplete/);
  assert.throws(() => findCorrelatedReply("/x", { msgId: "a", expectedSender: "b" }), /send-correlation-incomplete/);
});

test("waiting returns null on timeout instead of claiming a reply", async () => {
  await withStore(async ({ dbPath }) => {
    const ticks = [];
    const reply = await waitForCorrelatedReply(dbPath, correlationFor("never"), {
      timeoutMs: 30,
      pollMs: 10,
      sleep: async (ms) => { ticks.push(ms); },
    });
    assert.equal(reply, null);
    assert.ok(ticks.length > 0);
  });
});

test("a timeout stays honest when only wrong-sender replies arrived", async () => {
  await withStore(async ({ dbPath, store }) => {
    await inbound(store, { msgId: "x", replyToMessageId: "task-5", text: "hi", sender: "someone-else" });
    const reply = await waitForCorrelatedReply(dbPath, correlationFor("task-5"), {
      timeoutMs: 30,
      pollMs: 10,
      sleep: async () => {},
    });
    assert.equal(reply, null);
  });
});

test("waiting resolves as soon as the correlated reply lands", async () => {
  await withStore(async ({ dbPath, store }) => {
    let polls = 0;
    const reply = await waitForCorrelatedReply(dbPath, correlationFor("task-6"), {
      timeoutMs: 5_000,
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        if (polls === 2) await inbound(store, { msgId: "reply-2", replyToMessageId: "task-6", text: "done" });
      },
    });
    assert.equal(reply.text, "done");
  });
});

test("a missing store reads as no reply rather than throwing", () => {
  assert.equal(findCorrelatedReply("/nonexistent/murmur.db", correlationFor("x")), null);
  assert.deepEqual(findRejectedCandidates("/nonexistent/murmur.db", correlationFor("x")), []);
});
