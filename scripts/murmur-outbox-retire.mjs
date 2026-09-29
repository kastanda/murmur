#!/usr/bin/env node
/**
 * murmur-outbox-retire.mjs — retire an EXACT set of outbox messages.
 *
 * Why this exists
 * ---------------
 * At-least-once delivery has no upper bound in time. A message addressed to a recipient
 * that will never come back keeps being re-selected by `claimDue()` forever: attempts
 * climb, the row never settles, and the only historical escapes were to fake an ACK
 * (a lie — nobody acknowledged it) or to delete the row (destroying the audit trail).
 *
 * `retired` is the third option, and this script is the ONLY thing that produces it:
 *
 *   - the payload, msgId, attempt count and every `message_events` row are retained;
 *   - the row is terminal, so the sender loop stops selecting it (`claimDue()` reads
 *     only `pending`/`failed`, `requeueStaleSent()` only `sent`);
 *   - it is NOT `acked`: nothing claims the message was delivered;
 *   - it is NOT `dlq`: that is the transport's verdict and feeds the dead-letter alarm,
 *     whereas this is a decision a human made about a specific message;
 *   - the reason is kept in `last_error`, visible in status and audit output.
 *
 * Safety
 * ------
 * Nothing is retired implicitly. Only the msgIds passed on the command line are touched,
 * a consistent SQLite backup is taken first (`VACUUM INTO`, not a copy of a live WAL
 * database), and an already-settled row is reported, never rewritten. Message bodies are
 * never read, printed or logged: the plan and the result are status metadata only.
 *
 * Usage:
 *   node scripts/murmur-outbox-retire.mjs \
 *     --data-dir .data-claude \
 *     --reason superseded-legacy-cursor-offline \
 *     --msg-id <uuid> [--msg-id <uuid> ...] \
 *     [--backup-dir ~/.murmur/backups] [--no-backup] [--dry-run] [--json]
 */
import path from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SQLiteDedupeOutboxStore, TERMINAL_OUTBOX_STATUSES } from "@murmurv2/core";

/** A reason is an operator-supplied audit token, not free text: it lands in a DB column. */
const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

export class RetireError extends Error {
  constructor(reason, detail = null) {
    super(`outbox-retire:${reason}${detail ? `:${detail}` : ""}`);
    this.name = "RetireError";
    this.reason = reason;
    this.detail = detail;
  }
}

export const parseRetireArgs = (argv) => {
  const options = { dataDir: null, reason: null, msgIds: [], backupDir: null, backup: true, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--reason") options.reason = argv[++i];
    else if (arg === "--msg-id") options.msgIds.push(argv[++i]);
    else if (arg === "--backup-dir") options.backupDir = argv[++i];
    else if (arg === "--no-backup") options.backup = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else throw new RetireError("unknown-flag", arg);
  }
  if (!options.dataDir) throw new RetireError("data-dir-required");
  if (!options.reason) throw new RetireError("reason-required");
  if (!REASON_PATTERN.test(options.reason)) throw new RetireError("reason-unsafe", options.reason.slice(0, 40));
  if (options.msgIds.length === 0) throw new RetireError("msg-id-required");
  for (const msgId of options.msgIds) {
    if (typeof msgId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(msgId)) {
      throw new RetireError("msg-id-unsafe", String(msgId).slice(0, 40));
    }
  }
  if (new Set(options.msgIds).size !== options.msgIds.length) throw new RetireError("msg-id-duplicated");
  return options;
};

/**
 * A CONSISTENT snapshot of a live database.
 *
 * `VACUUM INTO` is SQLite's own backup path: it reads the database through the normal
 * locking protocol, so a daemon writing to the WAL at the same moment cannot produce a
 * torn snapshot — which is exactly what copying `murmur.db` (leaving `-wal` and `-shm`
 * behind) would give. The destination is a single self-contained file with no sidecars.
 */
export const backupDatabase = (dbPath, destination) => {
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(destination), 0o700);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=10000;");
    db.exec(`VACUUM INTO ${quoteSqlString(destination)}`);
  } finally {
    db.close();
  }
  chmodSync(destination, 0o600);
  return destination;
};

/** The destination is a path, not user text, but it still crosses into SQL — quote it. */
const quoteSqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * `<data-dir>-<db>-<timestamp>.db`, so a backup says which identity it came from.
 *
 * The leading dot of a `.data-claude` directory is dropped: a backup an operator has to
 * find again during an incident must not be a hidden file.
 */
export const backupPathFor = (dbPath, backupDir, stamp = new Date().toISOString()) => {
  const dataDir = path.basename(path.dirname(path.resolve(dbPath))).replace(/^\.+/, "");
  return path.join(backupDir, `${dataDir}-${path.basename(dbPath, ".db")}-${stamp.replace(/[:.]/g, "-")}.db`);
};

/** Status metadata for one row. Deliberately never includes `envelope_json`. */
const describeRow = (record) => (record
  ? {
    msgId: record.msgId,
    subject: record.subject,
    status: record.status,
    attempts: record.attempts,
    lastError: record.lastError ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  : null);

export const planRetirement = async ({ store, msgIds }) => {
  const rows = [];
  for (const msgId of msgIds) rows.push({ msgId, before: describeRow(await store.getOutboxRecord(msgId)) });
  const missing = rows.filter((row) => !row.before).map((row) => row.msgId);
  const settled = rows.filter((row) => row.before && TERMINAL_OUTBOX_STATUSES.has(row.before.status));
  return { rows, missing, settled, retirable: rows.filter((row) => row.before && !settled.includes(row)) };
};

export const retireMessages = async ({
  dataDir,
  reason,
  msgIds,
  backupDir,
  backup = true,
  dryRun = false,
  now = () => new Date().toISOString(),
}) => {
  const dbPath = path.join(dataDir, "murmur.db");
  const store = new SQLiteDedupeOutboxStore(dbPath);
  const plan = await planRetirement({ store, msgIds });

  // Fail closed BEFORE writing anything: a typo'd msgId means the operator does not have
  // the set of messages they think they have, and must look again.
  if (plan.missing.length > 0) throw new RetireError("msg-id-not-found", plan.missing.join(","));

  if (dryRun) {
    return { dryRun: true, dbPath, reason, backupPath: null, results: plan.rows.map((row) => ({ ...row, outcome: "planned" })) };
  }

  const backupPath = backup ? backupDatabase(dbPath, backupPathFor(dbPath, backupDir, now())) : null;

  const outcomes = await store.markManyRetired(msgIds, reason);
  const results = [];
  for (const outcome of outcomes) {
    results.push({
      msgId: outcome.msgId,
      outcome: outcome.outcome,
      before: describeRow(outcome.before),
      after: describeRow(await store.getOutboxRecord(outcome.msgId)),
    });
  }
  return { dryRun: false, dbPath, reason, backupPath, results };
};

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const options = parseRetireArgs(process.argv.slice(2));
  const backupDir = options.backupDir
    || path.join(process.env.MURMUR_HOME || path.join(process.env.HOME || ".", ".murmur"), "backups");
  const result = await retireMessages({ ...options, backupDir });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Database: ${result.dbPath}\n`);
    process.stdout.write(`Backup:   ${result.backupPath ?? "(skipped)"}\n`);
    process.stdout.write(`Reason:   ${result.reason}\n`);
    for (const row of result.results) {
      const before = row.before ? `${row.before.status}/attempts=${row.before.attempts}` : "missing";
      const after = row.after ? `${row.after.status}/attempts=${row.after.attempts}` : "missing";
      process.stdout.write(`  ${row.msgId}  ${before} -> ${after}  [${row.outcome}]\n`);
    }
  }
  const allRetired = result.results.every((row) => row.outcome === "retired" || row.outcome === "planned");
  process.exitCode = allRetired ? 0 : 1;
}
