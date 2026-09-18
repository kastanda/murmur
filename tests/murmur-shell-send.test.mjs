import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";
import { createKeyPair, createSigningKeyPair } from "../packages/security/dist/src/index.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "murmur-shell-send.mjs");

const runShellSend = (args, env = {}) => spawnSync(process.execPath, [script, ...args], {
  cwd: repoRoot,
  env: { ...process.env, ...env },
  encoding: "utf8",
});

const makeDataDir = async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-shell-send-"));
  chmodSync(dir, 0o700);
  const encryption = await createKeyPair();
  const signing = await createSigningKeyPair();
  const peerEncryption = await createKeyPair();
  const peerSigning = await createSigningKeyPair();
  const config = {
    agentId: "agent-a",
    keys: { encryption, signing },
    peers: {
      "agent-b": {
        subject: "msg.agent-b",
        encryption: { publicKey: peerEncryption.publicKey },
        signing: { publicKey: peerSigning.publicKey },
      },
    },
  };
  const configPath = path.join(dir, "agent-config.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  return dir;
};

test("shell send rejects --reply-to without a value", () => {
  const result = runShellSend(["--to", "agent-b", "--text", "reply", "--reply-to"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reply-to requires a non-empty message ID/);
});

test("shell send does not consume the next flag as the --reply-to value", () => {
  const result = runShellSend(["--to", "agent-b", "--reply-to", "--text", "reply"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--reply-to requires a non-empty message ID/);
});

for (const value of ["", "   "]) {
  test(`shell send rejects ${value ? "whitespace" : "empty"} --reply-to`, () => {
    const result = runShellSend(["--to", "agent-b", "--text", "reply", "--reply-to", value]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--reply-to requires a non-empty message ID/);
  });
}

test("shell send preserves valid reply correlation and ordinary sends", async (t) => {
  const dataDir = await makeDataDir();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "murmur.db");
  const env = { DATA_DIR: dataDir, MURMUR_STORE_PATH: dbPath };

  const reply = runShellSend([
    "--to", "agent-b", "--conv", "conv-1", "--reply-to", "  msg-'quoted  ", "--text", "reply",
  ], env);
  assert.equal(reply.status, 0, reply.stderr);
  const replyOutput = JSON.parse(reply.stdout);
  assert.equal(replyOutput.replyToMessageId, "msg-'quoted");

  const ordinary = runShellSend(["--to", "agent-b", "--conv", "conv-1", "--text", "ordinary"], env);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  const ordinaryOutput = JSON.parse(ordinary.stdout);
  assert.equal("replyToMessageId" in ordinaryOutput, false);

  const outbox = new SQLiteDedupeOutboxStore(dbPath);
  const replyRecord = await outbox.getOutboxRecord(replyOutput.msgId);
  const ordinaryRecord = await outbox.getOutboxRecord(ordinaryOutput.msgId);
  assert.equal(replyRecord?.envelope.replyToMessageId, "msg-'quoted");
  assert.equal("replyToMessageId" in ordinaryRecord.envelope, false);
});

test("LLM reply hook fails closed when MURMUR_MSG_ID is missing", () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "on-receive-llm.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, MURMUR_TEXT: "reply needed", MURMUR_FROM: "agent-b", MURMUR_MSG_ID: "" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing MURMUR_MSG_ID; refusing to send an uncorrelated reply/);
});
