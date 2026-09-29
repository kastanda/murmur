/**
 * outbox-retire.test.mjs — operator retirement of an outbox message.
 *
 * The one property that matters: a retired message stops retrying WITHOUT anything,
 * anywhere, claiming it was delivered. Everything else here guards the blast radius —
 * only the listed rows move, and an active message still retries exactly as before.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLiteDedupeOutboxStore, TERMINAL_OUTBOX_STATUSES } from "@murmurv2/core";
import {
  RetireError,
  backupDatabase,
  backupPathFor,
  parseRetireArgs,
  planRetirement,
  retireMessages,
} from "../scripts/murmur-outbox-retire.mjs";

const envelopeFor = (msgId, to = "cursor") => ({
  schemaVersion: "1.0",
  msgId,
  conversationId: `dm:${to}:claude`,
  senderAgentId: "claude",
  recipients: [to],
  createdAt: "2026-09-23T11:07:23.000Z",
  payloadCiphertext: `cipher-${msgId}`,
  payloadNonce: "nonce",
  signature: "sig",
});

const setup = async ({ msgIds = ["a", "b", "c"], extra = ["keep-me"] } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-retire-"));
  const dataDir = path.join(dir, ".data-claude");
  const dbPath = path.join(dataDir, "murmur.db");
  const store = new SQLiteDedupeOutboxStore(dbPath);
  for (const msgId of [...msgIds, ...extra]) {
    await store.enqueue(`msg.cursor`, envelopeFor(msgId));
    // Reproduce the live shape: published, never acknowledged, requeued by ack-timeout.
    await store.markSent(msgId);
    await store.markFailed(msgId, "ack-timeout", new Date(Date.now() - 1000).toISOString());
  }
  return { dir, dataDir, dbPath, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ---------------------------------------------------------------------------
// Status semantics
// ---------------------------------------------------------------------------

test("retired is terminal and is NOT acked", () => {
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("retired"), true);
  assert.equal(TERMINAL_OUTBOX_STATUSES.has("acked"), true);
  assert.notEqual("retired", "acked");
});

test("a retired row is never selected for retry again", async () => {
  const ctx = await setup();
  try {
    assert.equal((await ctx.store.claimDue(50)).length, 4, "all four rows are due before retirement");

    await ctx.store.markManyRetired(["a", "b", "c"], "superseded-legacy-cursor-offline");

    const due = await ctx.store.claimDue(50);
    assert.deepEqual(due.map((row) => row.msgId), ["keep-me"], "only the untouched row is still retryable");

    // The ack-timeout sweep must not resurrect it either: that path reads `sent` rows,
    // and a retired row is not one.
    await ctx.store.requeueStaleSent(0, "ack-timeout");
    assert.deepEqual((await ctx.store.claimDue(50)).map((row) => row.msgId), ["keep-me"]);
  } finally {
    ctx.cleanup();
  }
});

test("attempts stop increasing, and the payload and history survive", async () => {
  const ctx = await setup();
  try {
    const before = await ctx.store.getOutboxRecord("a");
    await ctx.store.markManyRetired(["a"], "superseded-legacy-cursor-offline");
    const after = await ctx.store.getOutboxRecord("a");

    assert.equal(after.status, "retired");
    assert.equal(after.attempts, before.attempts, "retirement is a decision, not a delivery attempt");
    assert.equal(after.lastError, "superseded-legacy-cursor-offline", "the reason stays visible in audit output");
    assert.deepEqual(after.envelope, before.envelope, "the exact message is retained");
    assert.equal(after.createdAt, before.createdAt);

    // Drive the retry loop the way the daemon does: nothing selects it, so nothing counts.
    for (let i = 0; i < 5; i += 1) {
      const due = await ctx.store.claimDue(50);
      for (const row of due) await ctx.store.markSent(row.msgId, row.version);
      await ctx.store.requeueStaleSent(0, "ack-timeout");
    }
    assert.equal((await ctx.store.getOutboxRecord("a")).attempts, before.attempts);
    assert.ok((await ctx.store.getOutboxRecord("keep-me")).attempts > before.attempts,
      "an active message still retries exactly as before");
  } finally {
    ctx.cleanup();
  }
});

test("a late ACK cannot move a retired row, and retirement cannot rewrite a delivered one", async () => {
  const ctx = await setup();
  try {
    await ctx.store.markManyRetired(["a"], "superseded-legacy-cursor-offline");
    assert.equal(await ctx.store.applyAckTransition("a", "ack"), "not-in-flight");
    assert.equal((await ctx.store.getOutboxRecord("a")).status, "retired", "a retired row is never upgraded to acked");

    await ctx.store.markAcked("keep-me");
    const [outcome] = await ctx.store.markManyRetired(["keep-me"], "superseded-legacy-cursor-offline");
    assert.equal(outcome.outcome, "already-settled");
    assert.equal((await ctx.store.getOutboxRecord("keep-me")).status, "acked",
      "a delivered message is never rewritten as never-delivered");
  } finally {
    ctx.cleanup();
  }
});

test("only the listed rows are retired", async () => {
  const ctx = await setup({ msgIds: ["a", "b", "c"], extra: ["x", "y"] });
  try {
    await ctx.store.markManyRetired(["a", "c"], "superseded-legacy-cursor-offline");
    const statuses = {};
    for (const msgId of ["a", "b", "c", "x", "y"]) statuses[msgId] = (await ctx.store.getOutboxRecord(msgId)).status;
    assert.deepEqual(statuses, { a: "retired", b: "failed", c: "retired", x: "failed", y: "failed" });
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The operator tool
// ---------------------------------------------------------------------------

test("a typo'd msgId retires NOTHING instead of retiring a subset", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () => retireMessages({
        dataDir: ctx.dataDir,
        reason: "superseded-legacy-cursor-offline",
        msgIds: ["a", "not-a-real-message"],
        backupDir: path.join(ctx.dir, "backups"),
      }),
      /msg-id-not-found/,
    );
    assert.equal((await ctx.store.getOutboxRecord("a")).status, "failed", "nothing moved");
  } finally {
    ctx.cleanup();
  }
});

test("the tool takes a consistent backup, retires exactly the listed rows, and reports both states", async () => {
  const ctx = await setup();
  try {
    const backupDir = path.join(ctx.dir, "backups");
    const result = await retireMessages({
      dataDir: ctx.dataDir,
      reason: "superseded-legacy-cursor-offline",
      msgIds: ["a", "b", "c"],
      backupDir,
    });

    assert.equal(existsSync(result.backupPath), true, "a backup is taken BEFORE the mutation");
    assert.equal(statSync(result.backupPath).mode & 0o777, 0o600, "the backup holds message bodies: 0600");
    assert.equal(existsSync(`${result.backupPath}-wal`), false, "VACUUM INTO produces one self-contained file");

    // The backup is a real, readable database still holding the pre-retirement state.
    const restored = new DatabaseSync(result.backupPath, { readOnly: true });
    const row = restored.prepare("SELECT status, envelope_json FROM outbox WHERE msg_id = 'a'").get();
    restored.close();
    assert.equal(row.status, "failed");
    assert.match(String(row.envelope_json), /cipher-a/, "the message is preserved for audit");

    assert.deepEqual(result.results.map((entry) => entry.outcome), ["retired", "retired", "retired"]);
    for (const entry of result.results) {
      assert.equal(entry.before.status, "failed");
      assert.equal(entry.after.status, "retired");
      assert.equal(entry.after.attempts, entry.before.attempts);
    }
    assert.equal((await ctx.store.getOutboxRecord("keep-me")).status, "failed");
  } finally {
    ctx.cleanup();
  }
});

test("the reported plan and result never carry a message body", async () => {
  const ctx = await setup();
  try {
    const plan = await planRetirement({ store: ctx.store, msgIds: ["a"] });
    assert.equal(plan.rows[0].before.envelope, undefined);
    assert.doesNotMatch(JSON.stringify(plan), /cipher-a/);

    const result = await retireMessages({
      dataDir: ctx.dataDir,
      reason: "superseded-legacy-cursor-offline",
      msgIds: ["a"],
      backupDir: path.join(ctx.dir, "backups"),
    });
    assert.doesNotMatch(JSON.stringify(result), /cipher-a/, "the audit summary is status metadata only");
  } finally {
    ctx.cleanup();
  }
});

test("--dry-run writes nothing at all", async () => {
  const ctx = await setup();
  try {
    const result = await retireMessages({
      dataDir: ctx.dataDir,
      reason: "superseded-legacy-cursor-offline",
      msgIds: ["a"],
      backupDir: path.join(ctx.dir, "backups"),
      dryRun: true,
    });
    assert.equal(result.backupPath, null);
    assert.equal((await ctx.store.getOutboxRecord("a")).status, "failed");
  } finally {
    ctx.cleanup();
  }
});

test("argument parsing fails closed on anything that could touch the wrong row", () => {
  const ok = parseRetireArgs(["--data-dir", ".data-claude", "--reason", "superseded-legacy-cursor-offline", "--msg-id", "a"]);
  assert.deepEqual(ok.msgIds, ["a"]);
  assert.equal(ok.backup, true);

  const cases = [
    [[], /data-dir-required/],
    [["--data-dir", "d", "--msg-id", "a"], /reason-required/],
    [["--data-dir", "d", "--reason", "Bad Reason", "--msg-id", "a"], /reason-unsafe/],
    [["--data-dir", "d", "--reason", "ok-reason"], /msg-id-required/],
    [["--data-dir", "d", "--reason", "ok-reason", "--msg-id", "a'; DROP TABLE outbox--"], /msg-id-unsafe/],
    [["--data-dir", "d", "--reason", "ok-reason", "--msg-id", "a", "--msg-id", "a"], /msg-id-duplicated/],
    [["--data-dir", "d", "--reason", "ok-reason", "--msg-id", "a", "--wat"], /unknown-flag/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseRetireArgs(argv), pattern, argv.join(" "));
  }
  assert.ok(new RetireError("x") instanceof Error);
});

test("a backup destination containing a quote cannot break out of the VACUUM statement", async () => {
  const ctx = await setup();
  try {
    const weird = path.join(ctx.dir, "back'ups", "snap.db");
    backupDatabase(ctx.dbPath, weird);
    assert.equal(existsSync(weird), true);
  } finally {
    ctx.cleanup();
  }
});

test("the backup filename identifies its source and is never itself a hidden file", () => {
  const generated = backupPathFor("/x/.data-claude/murmur.db", "/backups", "2026-09-30T01:02:03.456Z");
  assert.equal(generated, "/backups/data-claude-murmur-2026-09-30T01-02-03-456Z.db");
  assert.equal(path.basename(generated).startsWith("."), false,
    "a backup an operator must find during an incident is not hidden");
});
