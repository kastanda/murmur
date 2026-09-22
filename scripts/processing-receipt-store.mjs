import { DatabaseSync } from "node:sqlite";

export const PROCESSING_RECEIPT_STATUSES = Object.freeze({
  created: "created",
  started: "started",
  completed: "completed",
  failed: "failed",
});

export const PROCESSING_RECEIPT_CAPABILITIES = Object.freeze({
  none: "none",
  started: "started",
  completed: "completed",
});

const TERMINAL = new Set(["completed", "failed"]);

const DDL = `
  CREATE TABLE IF NOT EXISTS processing_attempts (
    attempt_id          TEXT PRIMARY KEY,
    inbound_message_id  TEXT NOT NULL,
    recipient_id        TEXT NOT NULL,
    member_slot         TEXT NOT NULL,
    runtime             TEXT NOT NULL,
    capability          TEXT NOT NULL,
    status              TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    started_at          INTEGER,
    completed_at        INTEGER,
    failed_at           INTEGER,
    last_error          TEXT,
    session_id          TEXT,
    result_message_id   TEXT,
    metadata_json       TEXT,
    updated_at          INTEGER NOT NULL,
    UNIQUE (inbound_message_id, recipient_id, member_slot, attempt_id)
  );
  CREATE INDEX IF NOT EXISTS idx_processing_attempt_dispatch
    ON processing_attempts(inbound_message_id, recipient_id, member_slot, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_processing_attempt_status
    ON processing_attempts(status, updated_at);
`;

export class ProcessingReceiptStore {
  constructor(dbOrPath) {
    this.ownsDb = typeof dbOrPath === "string";
    this.db = this.ownsDb ? new DatabaseSync(dbOrPath) : dbOrPath;
    if (!this.db) throw new Error("processing-receipt-db-required");
    if (this.ownsDb) this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;");
    this.db.exec(DDL);
  }

  createAttempt(attempt, now = Date.now()) {
    for (const field of ["attemptId", "inboundMessageId", "recipientId", "memberSlot", "runtime", "capability"]) {
      if (typeof attempt?.[field] !== "string" || !attempt[field].trim()) {
        throw new Error(`processing-attempt-${field}-required`);
      }
    }
    const dispatch = this.db.prepare(`
      SELECT 1 FROM wake_dispatch
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
        AND state IN ('claimed', 'dispatched')
    `).get(attempt.inboundMessageId, attempt.recipientId, attempt.memberSlot);
    if (!dispatch) throw new Error("processing-attempt-dispatch-not-active");
    this.db.prepare(`
      INSERT INTO processing_attempts
        (attempt_id, inbound_message_id, recipient_id, member_slot, runtime,
         capability, status, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)
    `).run(
      attempt.attemptId,
      attempt.inboundMessageId,
      attempt.recipientId,
      attempt.memberSlot,
      attempt.runtime,
      attempt.capability,
      now,
      now,
      attempt.metadata == null ? null : JSON.stringify(attempt.metadata),
    );
    return this.get(attempt.attemptId);
  }

  record(receipt, now = Date.now()) {
    const status = receipt?.status;
    if (!["started", "completed", "failed"].includes(status)) {
      return { accepted: false, reason: "invalid-status", row: null };
    }
    const row = this.get(receipt?.attemptId);
    if (!row) return { accepted: false, reason: "unknown-attempt", row: null };
    if (
      row.inboundMessageId !== receipt.inboundMessageId
      || row.recipientId !== receipt.recipientId
      || row.memberSlot !== receipt.memberSlot
      || (receipt.runtime && row.runtime !== receipt.runtime)
    ) {
      return { accepted: false, reason: "attempt-identity-mismatch", row };
    }
    if (row.status === status) {
      this.db.prepare(`
        UPDATE processing_attempts
        SET session_id = COALESCE(session_id, ?),
            result_message_id = COALESCE(result_message_id, ?),
            metadata_json = COALESCE(metadata_json, ?)
        WHERE attempt_id = ?
      `).run(
        receipt.sessionId ?? null,
        receipt.resultMessageId ?? null,
        receipt.metadata == null ? null : JSON.stringify(receipt.metadata),
        receipt.attemptId,
      );
      return { accepted: true, duplicate: true, row: this.get(receipt.attemptId) };
    }
    if (TERMINAL.has(row.status)) {
      return {
        accepted: false,
        conflict: TERMINAL.has(status) && row.status !== status,
        reason: `terminal-${row.status}`,
        row,
      };
    }
    if (row.status === "started" && status === "started") {
      return { accepted: true, duplicate: true, row };
    }
    const timestampColumn = status === "started" ? "started_at" : status === "completed" ? "completed_at" : "failed_at";
    this.db.prepare(`
      UPDATE processing_attempts
      SET status = ?, ${timestampColumn} = COALESCE(${timestampColumn}, ?), updated_at = ?,
          last_error = CASE WHEN ? = 'failed' THEN ? ELSE last_error END,
          session_id = COALESCE(session_id, ?),
          result_message_id = COALESCE(result_message_id, ?),
          metadata_json = COALESCE(metadata_json, ?)
      WHERE attempt_id = ? AND status IN ('created', 'started')
    `).run(
      status,
      now,
      now,
      status,
      receipt.errorMessage ?? null,
      receipt.sessionId ?? null,
      receipt.resultMessageId ?? null,
      receipt.metadata == null ? null : JSON.stringify(receipt.metadata),
      receipt.attemptId,
    );
    return { accepted: true, duplicate: false, row: this.get(receipt.attemptId) };
  }

  get(attemptId) {
    if (!attemptId) return null;
    const row = this.db.prepare("SELECT * FROM processing_attempts WHERE attempt_id = ?").get(attemptId);
    return row ? this.fromRow(row) : null;
  }

  latestForDispatch(identity) {
    const row = this.db.prepare(`
      SELECT * FROM processing_attempts
      WHERE inbound_message_id = ? AND recipient_id = ? AND member_slot = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(identity.msgId, identity.recipientId, identity.memberSlot);
    return row ? this.fromRow(row) : null;
  }

  listForDispatch(identity) {
    return this.db.prepare(`
      SELECT * FROM processing_attempts
      WHERE inbound_message_id = ? AND recipient_id = ? AND member_slot = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(identity.msgId, identity.recipientId, identity.memberSlot).map((row) => this.fromRow(row));
  }

  fromRow(row) {
    return {
      attemptId: row.attempt_id,
      inboundMessageId: row.inbound_message_id,
      recipientId: row.recipient_id,
      memberSlot: row.member_slot,
      runtime: row.runtime,
      capability: row.capability,
      status: row.status,
      createdAt: Number(row.created_at),
      startedAt: row.started_at == null ? null : Number(row.started_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at),
      failedAt: row.failed_at == null ? null : Number(row.failed_at),
      lastError: row.last_error ?? null,
      sessionId: row.session_id ?? null,
      resultMessageId: row.result_message_id ?? null,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      updatedAt: Number(row.updated_at),
    };
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
