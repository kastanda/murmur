/**
 * `murmur_send` truthfulness: `queued` may only mean "committed to durable Murmur state, and
 * read back". Pure helper tests (fake stores) plus end-to-end tests against the real MCP
 * server process and a real SQLite outbox. No network, no NATS: the outbox is the commit.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKeyPair, createSigningKeyPair } from "../packages/security/dist/src/index.js";
import {
  OutboundError, assertRouting, commitOutbound, resolveProfileIdentity,
} from "../packages/mcp-server/dist/src/outbound.js";
import { writePrivateJson } from "../scripts/secure-state.mjs";

const SERVER = "packages/mcp-server/dist/src/index.js";
const envelope = (over = {}) => ({
  schemaVersion: "1.0", msgId: "m-1", conversationId: "dm:a:b", senderAgentId: "a", recipients: ["b"],
  createdAt: "2026-10-04T00:00:00.000Z", payloadCiphertext: "CIPHERTEXT-SECRET", payloadNonce: "n", signature: "SIG-SECRET", ...over,
});
const legacy = { kind: "legacy", projectId: null, dataDir: "/x/.data-a" };

const fakeOutbox = ({ enqueue, record } = {}) => {
  const calls = [];
  return {
    calls,
    enqueue: async (subject, env) => { calls.push(["enqueue", subject, env.msgId]); if (enqueue) await enqueue(); },
    getOutboxRecord: async (msgId) => { calls.push(["read", msgId]); return record === undefined ? { msgId, subject: "msg.b", status: "pending" } : record; },
  };
};
const fakeStore = (fail = false) => ({ append: async () => { if (fail) throw new Error("disk"); } });

test("queued is returned only after the outbox row is committed and read back", async () => {
  const outbox = fakeOutbox();
  const receipt = await commitOutbound({ outbox, store: fakeStore(), profile: legacy, subject: "msg.b", envelope: envelope(), text: "hi" });
  assert.deepEqual(outbox.calls.map((c) => c[0]), ["enqueue", "read"], "verified by reading back AFTER the write");
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.durable, true);
  assert.equal(receipt.msgId, "m-1");
  assert.equal(receipt.recipientAgentId, "b");
  assert.equal(receipt.senderAgentId, "a");
  assert.equal(receipt.conversationId, "dm:a:b");
  assert.equal(receipt.profile, "legacy");
  assert.equal(receipt.projectId, null);
  assert.equal(receipt.localCopy, true);
});

test("a durable write failure can never return queued", async () => {
  const outbox = fakeOutbox({ enqueue: async () => { throw new Error("attempt to write a readonly database"); } });
  await assert.rejects(
    commitOutbound({ outbox, store: fakeStore(), profile: legacy, subject: "msg.b", envelope: envelope(), text: "hi" }),
    (error) => error instanceof OutboundError && error.code === "outbox-write-failed",
  );
  assert.deepEqual(outbox.calls.map((c) => c[0]), ["enqueue"], "no read-back, no receipt");
});

test("an enqueue that leaves no row (or the wrong row) is not queued", async () => {
  for (const record of [null, { msgId: "m-1", subject: "msg.OTHER", status: "pending" }, { msgId: "m-2", subject: "msg.b", status: "pending" }]) {
    await assert.rejects(
      commitOutbound({ outbox: fakeOutbox({ record }), store: fakeStore(), profile: legacy, subject: "msg.b", envelope: envelope(), text: "hi" }),
      (error) => error.code === "outbox-commit-unverified",
    );
  }
});

test("a failed local copy is reported, not hidden, and does not un-queue a committed message", async () => {
  const receipt = await commitOutbound({ outbox: fakeOutbox(), store: fakeStore(true), profile: legacy, subject: "msg.b", envelope: envelope(), text: "hi" });
  assert.equal(receipt.durable, true);
  assert.equal(receipt.localCopy, false);
});

test("the receipt carries no payload, signature or key material", async () => {
  const receipt = await commitOutbound({ outbox: fakeOutbox(), store: fakeStore(), profile: legacy, subject: "msg.b", envelope: envelope(), text: "PLAINTEXT-SECRET" });
  const json = JSON.stringify(receipt);
  for (const secret of ["CIPHERTEXT-SECRET", "SIG-SECRET", "PLAINTEXT-SECRET", "privateKey", "natsToken"]) assert.ok(!json.includes(secret), secret);
});

test("profile identity: only ~/.murmur/projects/<id>/agents/<agent> is a project profile", () => {
  const home = "/Users/u";
  const project = resolveProfileIdentity("/Users/u/.murmur/projects/murmur-f6a3/agents/claude", {}, home);
  assert.deepEqual([project.kind, project.projectId], ["project", "murmur-f6a3"]);
  for (const dir of ["/Users/u/Projects/murmur/.data-claude", "/Users/u/Projects/murmur/.data", "/tmp/projects/x/agents/claude"]) {
    const identity = resolveProfileIdentity(dir, {}, home);
    assert.deepEqual([identity.kind, identity.projectId], ["legacy", null], dir);
  }
  const custom = resolveProfileIdentity("/srv/m/projects/p-1/agents/codex", { MURMUR_HOME: "/srv/m" }, home);
  assert.equal(custom.projectId, "p-1");
});

test("routing: a stale/legacy profile cannot carry a send for another project", () => {
  const project = { kind: "project", projectId: "p-1", dataDir: "/d" };
  assertRouting(project, {});
  assertRouting(project, { requestedProjectId: "p-1" });
  assert.throws(() => assertRouting(project, { requestedProjectId: "p-2" }), (e) => e.code === "profile-mismatch");
  assert.throws(() => assertRouting(legacy, { requestedProjectId: "p-1" }), (e) => e.code === "profile-mismatch");
  assertRouting(legacy, {});
  assert.throws(() => assertRouting(legacy, { requireProject: true }), (e) => e.code === "legacy-profile-rejected");
  assertRouting(project, { requireProject: true });
});

// ---- end to end: the real MCP server and a real SQLite outbox --------------------------

const makeProfile = async (dir, { agentId = "a", peers = ["b"] } = {}) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const enc = await createKeyPair();
  const sig = await createSigningKeyPair();
  const peerEntries = {};
  for (const peer of peers) {
    const pe = await createKeyPair();
    const ps = await createSigningKeyPair();
    peerEntries[peer] = { encryption: { publicKey: pe.publicKey }, signing: { publicKey: ps.publicKey }, subject: `msg.${peer}` };
  }
  await writePrivateJson(path.join(dir, "agent-config.json"), {
    agentId, natsUrl: "nats://127.0.0.1:1", subject: `msg.${agentId}`, dataDir: dir,
    keys: { encryption: enc, signing: sig }, peers: peerEntries,
  });
};

const startServer = (dir, extraEnv = {}) => {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dir, MURMUR_STORE_PATH: path.join(dir, "murmur.db"), MURMUR_CHANNEL_ROSTER_PATH: path.join(dir, "channel-roster.db"), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiters.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const call = (name, args) => new Promise((resolve) => {
    const id = ++nextId;
    waiters.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  }).then((message) => (message.error ? { error: message.error.message } : JSON.parse(message.result.content[0].text)));
  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  return { proc, call, exited };
};

const outboxRow = (dir, msgId) => {
  const db = new DatabaseSync(path.join(dir, "murmur.db"), { readOnly: true });
  try { return db.prepare("SELECT msg_id, subject, status FROM outbox WHERE msg_id = ?").get(msgId); } finally { db.close(); }
};

test("e2e: the msgId in a queued receipt is in the outbox the instant it is returned", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "murmur-send-"));
  await makeProfile(dir);
  const server = startServer(dir);
  try {
    const receipt = await server.call("murmur_send", { to: "b", text: "hello", conversationId: "dm:a:b", replyToMessageId: "orig-1" });
    assert.equal(receipt.status, "queued");
    assert.equal(receipt.durable, true);
    assert.equal(receipt.replyToMessageId, "orig-1");
    assert.equal(receipt.profile, "legacy");
    assert.equal(receipt.dataDir, path.resolve(dir));
    const row = outboxRow(dir, receipt.msgId);
    assert.deepEqual({ ...row }, { msg_id: receipt.msgId, subject: "msg.b", status: "pending" });
    assert.ok(!JSON.stringify(receipt).includes("privateKey"));
  } finally {
    server.proc.stdin.end();
    await server.exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e: unknown recipient and project mismatches never return queued and write nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "murmur-send-"));
  await makeProfile(dir);
  const server = startServer(dir);
  try {
    assert.match((await server.call("murmur_send", { to: "nobody", text: "x" })).error, /unknown peer/);
    assert.match((await server.call("murmur_send", { to: "b", text: "x", projectId: "other-project" })).error, /profile-mismatch/);
    const db = new DatabaseSync(path.join(dir, "murmur.db"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 0); } finally { db.close(); }
  } finally {
    server.proc.stdin.end();
    await server.exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e: a project profile accepts only its own projectId; MURMUR_REQUIRE_PROJECT_PROFILE refuses legacy", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "murmur-home-"));
  const dir = path.join(home, "projects", "proj-abc123", "agents", "claude");
  await makeProfile(dir);
  const server = startServer(dir, { MURMUR_HOME: home });
  const legacyDir = await mkdtemp(path.join(os.tmpdir(), "murmur-legacy-"));
  await makeProfile(legacyDir);
  const strict = startServer(legacyDir, { MURMUR_REQUIRE_PROJECT_PROFILE: "1" });
  try {
    const ok = await server.call("murmur_send", { to: "b", text: "x", projectId: "proj-abc123" });
    assert.equal(ok.status, "queued");
    assert.equal(ok.profile, "project");
    assert.equal(ok.projectId, "proj-abc123");
    assert.match((await server.call("murmur_send", { to: "b", text: "x", projectId: "proj-zzz" })).error, /profile-mismatch/);
    assert.match((await strict.call("murmur_send", { to: "b", text: "x" })).error, /legacy-profile-rejected/);
  } finally {
    for (const s of [server, strict]) { s.proc.stdin.end(); await s.exited; }
    await rm(home, { recursive: true, force: true });
    await rm(legacyDir, { recursive: true, force: true });
  }
});

test("e2e: if the outbox cannot be written the tool fails and does not claim queued", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "murmur-send-"));
  await makeProfile(dir);
  const server = startServer(dir);
  try {
    assert.equal((await server.call("murmur_send", { to: "b", text: "first" })).status, "queued");
    const db = new DatabaseSync(path.join(dir, "murmur.db"));
    db.exec("DROP TABLE outbox");
    db.close();
    const failed = await server.call("murmur_send", { to: "b", text: "second" });
    assert.ok(failed.error, "an error, not a receipt");
    assert.equal(failed.status, undefined);
  } finally {
    server.proc.stdin.end();
    await server.exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e: the server exits when its session ends, and sequential sessions leave no process behind", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "murmur-send-"));
  await makeProfile(dir);
  const pids = [];
  try {
    for (let i = 0; i < 6; i += 1) {
      const server = startServer(dir);
      pids.push(server.proc.pid);
      assert.equal((await server.call("murmur_send", { to: "b", text: `m${i}` })).durable, true);
      server.proc.stdin.end(); // the session ends
      const { code } = await server.exited;
      assert.equal(code, 0);
    }
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (e) => e.code === "ESRCH", `pid ${pid} still alive`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("e2e: a send already accepted when the session closes is still committed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "murmur-send-"));
  await makeProfile(dir);
  const server = startServer(dir);
  try {
    const pending = server.call("murmur_send", { to: "b", text: "last words" });
    server.proc.stdin.end(); // EOF immediately after the request
    const receipt = await pending;
    assert.equal(receipt.durable, true);
    await server.exited;
    assert.equal(outboxRow(dir, receipt.msgId).msg_id, receipt.msgId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
