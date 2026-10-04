#!/usr/bin/env node
// Standalone Murmur V2 sender for shell scripts and send-boundary services.
// Reads agent-config.json from DATA_DIR, encrypts/signs/enqueues an envelope.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SQLiteDedupeOutboxStore, SQLiteMessageStore, stableEnvelopePayload } from "@murmurv2/core";
import { encryptPayload, signEnvelope } from "@murmurv2/security";
import { readPrivateJson } from "./secure-state.mjs";
import { REPLY_ORIGINS, ReplyOwnershipStore } from "./reply-ownership-store.mjs";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const opt = {};
let replyToFlagPresent = false;
let originFlagPresent = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--to") opt.to = args[++i];
  else if (a === "--conv" || a === "--conversation") opt.conversationId = args[++i];
  else if (a === "--reply-to" || a === "--reply-to-message-id") {
    replyToFlagPresent = true;
    opt.replyToMessageId = args[++i];
  }
  else if (a === "--text") opt.text = args[++i];
  else if (a === "--text-file") opt.textFile = args[++i];
  else if (a === "--stdin") opt.stdin = true;
  // Explicit reply owner for a CLIENT-originated request (`operator_client`). Autonomous
  // responders and legacy callers omit it and stay unowned.
  else if (a === "--origin") {
    originFlagPresent = true;
    opt.origin = args[++i];
  }
  else if (a === "--help" || a === "-h") opt.help = true;
}

if (
  replyToFlagPresent &&
  (typeof opt.replyToMessageId !== "string" || !opt.replyToMessageId.trim() || opt.replyToMessageId.startsWith("--"))
) {
  process.stderr.write("error: --reply-to requires a non-empty message ID\n");
  process.exit(1);
}
if (replyToFlagPresent) opt.replyToMessageId = opt.replyToMessageId.trim();

// A present-but-missing/empty/flag-like value must FAIL, never degrade to an unowned send.
if (originFlagPresent && opt.origin !== REPLY_ORIGINS.operatorClient) {
  process.stderr.write(`error: --origin must be ${REPLY_ORIGINS.operatorClient}\n`);
  process.exit(1);
}

if (opt.help || !opt.to || (!opt.text && !opt.textFile && !opt.stdin)) {
  process.stderr.write(
    "usage: murmur-shell-send.mjs --to <peer-id> (--text <txt> | --text-file <path> | --stdin) [--conv <id>] [--reply-to <msg-id>] [--origin operator_client]\n",
  );
  process.exit(1);
}

if (opt.textFile) {
  opt.text = readFileSync(opt.textFile, "utf8");
} else if (opt.stdin) {
  opt.text = readFileSync(0, "utf8");
}
const text = String(opt.text ?? "").trim();
if (!text) {
  process.stderr.write("error: text is empty\n");
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || ".data";
const configPath = path.join(dataDir, "agent-config.json");
const dbPath = process.env.MURMUR_STORE_PATH ?? path.join(dataDir, "murmur.db");

let cfg;
try {
  cfg = await readPrivateJson(configPath);
} catch (err) {
  process.stderr.write(`error: cannot read ${configPath}: ${err.message}\n`);
  process.exit(2);
}

const peer = cfg.peers?.[opt.to];
if (!peer) {
  process.stderr.write(`error: unknown peer '${opt.to}' in ${configPath}\n`);
  process.exit(2);
}

const conversationId = opt.conversationId || `dm:${cfg.agentId}:${opt.to}`;
const msgId = randomUUID();
const createdAt = new Date().toISOString();


try {
  const encrypted = await encryptPayload(
    text,
    peer.encryption.publicKey,
    cfg.keys.encryption.privateKey,
  );

  const envelope = {
    schemaVersion: "1.0",
    msgId,
    conversationId,
    senderAgentId: cfg.agentId,
    recipients: [opt.to],
    createdAt,
    ...(opt.replyToMessageId ? { replyToMessageId: opt.replyToMessageId } : {}),
    payloadCiphertext: encrypted.ciphertext,
    payloadNonce: encrypted.nonce,
    signature: "",
  };
  envelope.signature = await signEnvelope(
    stableEnvelopePayload(envelope),
    cfg.keys.signing.privateKey,
  );

  const outbox = new SQLiteDedupeOutboxStore(dbPath);
  outbox.db?.exec?.("PRAGMA busy_timeout=5000;");
  if (opt.origin) {
    // Durable BEFORE the message can leave: the reply must never become autonomous work.
    const ownershipDb = new DatabaseSync(dbPath);
    ownershipDb.exec("PRAGMA busy_timeout=5000;");
    new ReplyOwnershipStore(ownershipDb).record({ msgId, origin: opt.origin, owner: `operator:${cfg.agentId}` });
    ownershipDb.close();
  }
  await outbox.enqueue(peer.subject, envelope);

  const store = new SQLiteMessageStore(dbPath);
  store.db?.exec?.("PRAGMA busy_timeout=5000;");
  await store.append({
    conversationId,
    msgId,
    ...(opt.replyToMessageId ? { replyToMessageId: opt.replyToMessageId } : {}),
    direction: "outbound",
    sender: cfg.agentId,
    text,
    createdAt,
    transport: "nats",
  });

  process.stdout.write(
    `${JSON.stringify({ msgId, to: opt.to, conversationId, ...(opt.replyToMessageId ? { replyToMessageId: opt.replyToMessageId } : {}), status: "queued" })}\n`,
  );
  process.exit(0);
} catch (err) {
  process.stderr.write(`error: enqueue failed: ${err.message}\n`);
  process.exit(3);
}
