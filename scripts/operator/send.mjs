/**
 * send.mjs — submit one root/operator task to the project coordinator.
 *
 * This adds NO new message semantics. The envelope is built, signed, encrypted and
 * enqueued by the existing `scripts/murmur-shell-send.mjs` against the root identity's
 * data dir; the root daemon flushes its outbox as usual. Waiting is nothing more than
 * polling the root identity's durable local inbox for the row whose
 * `reply_to_message_id` is exactly the message we sent — the same strict correlation the
 * runtimes already use.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const enqueueRootTask = async ({
  murmurRoot,
  rootDataDir,
  to,
  text,
  conversationId,
  exec = execFileAsync,
}) => {
  const script = path.join(murmurRoot, "scripts", "murmur-shell-send.mjs");
  const args = [script, "--to", to, "--text", text, "--origin", "operator_client", ...(conversationId ? ["--conv", conversationId] : [])];
  const { stdout } = await exec(process.execPath, args, {
    env: { ...process.env, DATA_DIR: rootDataDir },
    encoding: "utf8",
    timeout: 30_000,
  });
  const parsed = JSON.parse(String(stdout).trim().split("\n").pop());
  if (!parsed?.msgId) throw new Error("send-msg-id-missing");
  return parsed;
};

/**
 * The exact correlated final result, or null while it has not arrived yet.
 *
 * STRICT three-way correlation — all of these must match:
 *   - `reply_to_message_id` is exactly the request's msgId;
 *   - the sender is exactly the expected coordinator agent id;
 *   - the conversation is exactly the root conversation the request was sent on.
 *
 * There is no latest-reply fallback, no time window and no conversation-only match. A
 * reply from another agent, or the right agent on another conversation, is not a
 * candidate at all — it is skipped, and a later exact reply still satisfies the wait.
 */
export const findCorrelatedReply = (dbPath, { msgId, expectedSender, conversationId }) => {
  if (!msgId || !expectedSender || !conversationId) throw new Error("send-correlation-incomplete");
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=2000;");
    const row = db
      .prepare(
        `SELECT msg_id AS msgId, sender, text, created_at AS createdAt, conversation_id AS conversationId
           FROM local_messages
          WHERE direction = 'inbound'
            AND reply_to_message_id = ?
            AND sender = ?
            AND conversation_id = ?
          ORDER BY rowid ASC LIMIT 1`,
      )
      .get(msgId, expectedSender, conversationId);
    return row || null;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
};

/** Non-matching inbound replies to the same request, for an honest timeout message. */
export const findRejectedCandidates = (dbPath, { msgId, expectedSender, conversationId }) => {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout=2000;");
    return db
      .prepare(
        `SELECT msg_id AS msgId, sender, conversation_id AS conversationId
           FROM local_messages
          WHERE direction = 'inbound' AND reply_to_message_id = ?
            AND (sender != ? OR conversation_id != ?)
          ORDER BY rowid ASC LIMIT 5`,
      )
      .all(msgId, expectedSender, conversationId);
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
};

/**
 * When did the operator cancel this root workflow (ms), or `null`? Read from the root identity's
 * own database (where `murmur cancel` records the durable intent). A waiting `murmur send`
 * observes it so it can stop waiting and report a SYSTEM result instead of timing out on a task
 * nobody will answer.
 */
export const rootWorkflowCancelledAt = (dbPath, msgId) => {
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=2000;");
    const row = db.prepare("SELECT requested_at AS at FROM workflow_control WHERE root_message_id = ?").get(msgId);
    return row ? Number(row.at) : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
};

export const waitForCorrelatedReply = async (dbPath, correlation, { timeoutMs = 600_000, pollMs = 500, sleep = delay, cancelCheck = null } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = findCorrelatedReply(dbPath, correlation);
    const cancelledAt = cancelCheck?.();
    const cancelled = cancelledAt !== null && cancelledAt !== undefined && cancelledAt !== false;
    if (row) {
      // A reply that arrived AFTER the cancel is a late delivery: it stays in history but the
      // task stays cancelled. One that arrived before it is a genuine completion.
      if (cancelled && Date.parse(row.createdAt) > Number(cancelledAt)) return { cancelled: true };
      return row;
    }
    if (cancelled) return { cancelled: true };
    await sleep(pollMs);
  }
  return null;
};
