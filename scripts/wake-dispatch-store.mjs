import { DatabaseSync } from "node:sqlite";

export const WAKE_DISPATCH_STATES = Object.freeze({
  pending: "pending",
  claimed: "claimed",
  dispatched: "dispatched",
  handedOff: "handed_off",
  deferred: "deferred",
  failed: "failed",
  terminal: "terminal",
  rejected: "rejected",
});

const CONNECTION_PRAGMAS = `
  PRAGMA journal_mode=WAL;
  PRAGMA busy_timeout=10000;
`;

const DDL = `
  CREATE TABLE IF NOT EXISTS wake_dispatch (
    msg_id            TEXT NOT NULL,
    recipient_id      TEXT NOT NULL,
    member_slot       TEXT NOT NULL,
    conversation_id   TEXT NOT NULL,
    payload_json      TEXT NOT NULL,
    state             TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    claim_count       INTEGER NOT NULL DEFAULT 0,
    max_attempts      INTEGER NOT NULL,
    next_attempt_at   INTEGER NOT NULL,
    claimed_at        INTEGER,
    last_error        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    handed_off_at     INTEGER,
    PRIMARY KEY (msg_id, recipient_id, member_slot)
  );
  CREATE INDEX IF NOT EXISTS idx_wake_dispatch_due
    ON wake_dispatch(state, next_attempt_at, created_at);
  CREATE TABLE IF NOT EXISTS wake_dispatch_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const RETRYABLE_STATES = ["pending", "deferred", "failed"];

export class WakeDispatchStore {
  constructor(dbPath, { maxAttempts = 5, recipientId = "local", migrationFault = null } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.maxAttempts = Math.max(1, Math.trunc(maxAttempts));
    this.recipientId = recipientId;
    this.migrationFault = migrationFault;
    this.db.exec(CONNECTION_PRAGMAS);
    try {
      const hadDispatchTable = Boolean(this.db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wake_dispatch'
      `).get());
      if (hadDispatchTable && !this.hasMigrationBaseline()) {
        throw new Error("wake-dispatch-meta-baseline-missing");
      }
      const legacySchema = hadDispatchTable && !this.db.prepare(`PRAGMA table_info(wake_dispatch)`).all()
        .some((column) => column.name === "recipient_id");
      if (legacySchema) this.migrateLegacySchema();
      else this.db.exec(DDL);
      if (!hadDispatchTable) this.seedMigrationBaseline();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  identityFor(payload, overrides = {}) {
    const recipientId = overrides.recipientId
      ?? payload?.recipientAgentId
      ?? payload?.env?.MURMUR_PROXY_AGENT
      ?? this.recipientId;
    const memberSlot = overrides.memberSlot ?? payload?.memberSlot ?? recipientId;
    return { msgId: payload?.msgId, recipientId, memberSlot };
  }

  enqueue(payload, now = Date.now()) {
    if (!payload?.msgId) throw new Error("wake-dispatch-msg-id-required");
    if (!payload?.conversationId) throw new Error("wake-dispatch-conversation-id-required");
    const identity = this.identityFor(payload);
    this.db.prepare(`
      INSERT INTO wake_dispatch
        (msg_id, recipient_id, member_slot, conversation_id, payload_json, state,
         attempts, claim_count, max_attempts, next_attempt_at, claimed_at,
         last_error, created_at, updated_at, handed_off_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, NULL, NULL, ?, ?, NULL)
      ON CONFLICT(msg_id, recipient_id, member_slot) DO NOTHING
    `).run(
      identity.msgId,
      identity.recipientId,
      identity.memberSlot,
      payload.conversationId,
      JSON.stringify(payload),
      this.maxAttempts,
      now,
      now,
      now,
    );
    return this.get(identity);
  }

  claimDue(now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const identity = this.db.prepare(`
        SELECT msg_id AS msgId, recipient_id AS recipientId, member_slot AS memberSlot
        FROM wake_dispatch
        WHERE state IN ('pending', 'deferred', 'failed')
          AND attempts < max_attempts AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT 1
      `).get(now);
      if (!identity) {
        this.db.exec("COMMIT");
        return null;
      }
      const claimed = this.db.prepare(`
        UPDATE wake_dispatch
        SET state = 'claimed', claim_count = claim_count + 1,
            claimed_at = ?, updated_at = ?
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
          AND state IN ('pending', 'deferred', 'failed')
        RETURNING *
      `).get(now, now, identity.msgId, identity.recipientId, identity.memberSlot);
      this.db.exec("COMMIT");
      return claimed ? this.fromRow(claimed) : null;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  beginHandoff(identity, now = Date.now()) {
    const key = this.requireTransitionIdentity(identity);
    const result = this.db.prepare(`
      UPDATE wake_dispatch
      SET state = 'dispatched', attempts = attempts + 1,
          updated_at = ?, claimed_at = ?
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
        AND state = 'claimed' AND attempts < max_attempts
    `).run(now, now, key.msgId, key.recipientId, key.memberSlot);
    return Number(result.changes);
  }

  markHandedOff(identity, now = Date.now()) {
    const key = this.requireTransitionIdentity(identity);
    const result = this.db.prepare(`
      UPDATE wake_dispatch
      SET state = 'handed_off', updated_at = ?, handed_off_at = ?,
          claimed_at = NULL, last_error = NULL
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
        AND state IN ('claimed', 'dispatched')
    `).run(now, now, key.msgId, key.recipientId, key.memberSlot);
    return Number(result.changes);
  }

  defer(identity, reason, nextAttemptAt, now = Date.now()) {
    const key = this.requireTransitionIdentity(identity);
    const result = this.db.prepare(`
      UPDATE wake_dispatch
      SET state = 'deferred', next_attempt_at = ?, claimed_at = NULL,
          last_error = ?, updated_at = ?
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ? AND state = 'claimed'
    `).run(nextAttemptAt, reason, now, key.msgId, key.recipientId, key.memberSlot);
    return Number(result.changes);
  }

  rescheduleAfterClaimLoss(identity, reason, nextAttemptAt, now = Date.now()) {
    const key = this.requireTransitionIdentity(identity);
    const result = this.db.prepare(`
      UPDATE wake_dispatch
      SET state = CASE WHEN state = 'claimed' THEN 'deferred' ELSE state END,
          next_attempt_at = CASE
            WHEN next_attempt_at < ? THEN ?
            ELSE next_attempt_at
          END,
          claimed_at = NULL, last_error = ?, updated_at = ?
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
        AND state IN ('claimed', 'pending', 'deferred', 'failed')
    `).run(
      nextAttemptAt,
      nextAttemptAt,
      reason,
      now,
      key.msgId,
      key.recipientId,
      key.memberSlot,
    );
    return Number(result.changes);
  }

  fail(identity, reason, nextAttemptAt, now = Date.now()) {
    const key = this.requireTransitionIdentity(identity);
    const row = this.get(key);
    if (!row || row.state !== "dispatched") return { changed: false, terminal: false, row };
    const terminal = row.attempts >= row.maxAttempts;
    this.db.prepare(`
      UPDATE wake_dispatch
      SET state = ?, next_attempt_at = ?, claimed_at = NULL,
          last_error = ?, updated_at = ?
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ? AND state = 'dispatched'
    `).run(terminal ? "terminal" : "failed", nextAttemptAt, reason, now, key.msgId, key.recipientId, key.memberSlot);
    return { changed: true, terminal, row: this.get(key) };
  }

  reject(identity, reason, now = Date.now()) {
    const key = this.requireTransitionIdentity(identity);
    const result = this.db.prepare(`
      UPDATE wake_dispatch
      SET state = 'rejected', updated_at = ?, last_error = ?, claimed_at = NULL
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ? AND state = 'claimed'
    `).run(now, reason, key.msgId, key.recipientId, key.memberSlot);
    return Number(result.changes);
  }

  recoverStaleClaims({ now = Date.now(), claimTtlMs = 60_000, retryAt = now } = {}) {
    const result = this.db.prepare(`
      UPDATE wake_dispatch
      SET state = CASE
            WHEN state = 'claimed' THEN 'deferred'
            WHEN attempts >= max_attempts THEN 'terminal'
            ELSE 'failed'
          END,
          next_attempt_at = ?, claimed_at = NULL,
          last_error = CASE
            WHEN state = 'claimed' THEN 'stale-claim-recovered'
            ELSE 'handoff-outcome-unknown-after-restart'
          END,
          updated_at = ?
      WHERE state IN ('claimed', 'dispatched')
        AND claimed_at IS NOT NULL AND (? - claimed_at) >= ?
    `).run(retryAt, now, now, claimTtlMs);
    return Number(result.changes);
  }

  backfillMissingInbound(now = Date.now()) {
    if (!this.hasLocalMessagesTable()) return 0;
    const replyColumn = this.hasLocalMessageReplyColumn()
      ? "reply_to_message_id AS replyToMessageId"
      : "NULL AS replyToMessageId";
    const baseline = Number(this.db.prepare(`
      SELECT value FROM wake_dispatch_meta WHERE key = 'inbound-baseline-rowid'
    `).get()?.value ?? 0);
    const rows = this.db.prepare(`
      SELECT rowid AS cursor, conversation_id AS conversationId, msg_id AS msgId,
             ${replyColumn},
             sender AS "from", text, created_at AS ts
      FROM local_messages AS message
      WHERE direction = 'inbound' AND rowid > ?
        AND NOT EXISTS (
          SELECT 1 FROM wake_dispatch AS dispatch
          WHERE dispatch.msg_id = message.msg_id
            AND dispatch.recipient_id = ? AND dispatch.member_slot = ?
        )
      ORDER BY rowid ASC
    `).all(baseline, this.recipientId, this.recipientId);
    for (const row of rows) this.enqueue({
      ...row,
      ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
      cursor: Number(row.cursor),
    }, now);
    return rows.length;
  }

  nextDueAt() {
    const row = this.db.prepare(`
      SELECT MIN(next_attempt_at) AS nextDueAt FROM wake_dispatch
      WHERE state IN ('pending', 'deferred', 'failed') AND attempts < max_attempts
    `).get();
    return row?.nextDueAt == null ? null : Number(row.nextDueAt);
  }

  get(identity, recipientId, memberSlot) {
    const key = this.normalizeIdentity(identity, recipientId, memberSlot);
    const row = this.db.prepare(`
      SELECT * FROM wake_dispatch
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
    `).get(key.msgId, key.recipientId, key.memberSlot);
    return row ? this.fromRow(row) : null;
  }

  list() {
    return this.db.prepare(`
      SELECT * FROM wake_dispatch
      ORDER BY created_at ASC, msg_id ASC, recipient_id ASC, member_slot ASC
    `).all().map((row) => this.fromRow(row));
  }

  close() {
    this.db.close();
  }

  normalizeIdentity(identity, recipientId, memberSlot) {
    if (typeof identity === "string") {
      return {
        msgId: identity,
        recipientId: recipientId ?? this.recipientId,
        memberSlot: memberSlot ?? recipientId ?? this.recipientId,
      };
    }
    return {
      msgId: identity.msgId,
      recipientId: identity.recipientId ?? this.recipientId,
      memberSlot: identity.memberSlot ?? identity.recipientId ?? this.recipientId,
    };
  }

  requireTransitionIdentity(identity) {
    if (!identity || typeof identity === "string"
      || !identity.msgId || !identity.recipientId || !identity.memberSlot) {
      throw new Error("wake-dispatch-full-identity-required");
    }
    return {
      msgId: identity.msgId,
      recipientId: identity.recipientId,
      memberSlot: identity.memberSlot,
    };
  }

  hasLocalMessagesTable() {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_messages'
    `).get());
  }

  hasLocalMessageReplyColumn() {
    return this.db.prepare(`PRAGMA table_info(local_messages)`).all()
      .some((column) => column.name === "reply_to_message_id");
  }

  hasMigrationBaseline() {
    const hasMetaTable = Boolean(this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wake_dispatch_meta'
    `).get());
    return hasMetaTable && Boolean(this.db.prepare(`
      SELECT 1 FROM wake_dispatch_meta WHERE key = 'inbound-baseline-rowid'
    `).get());
  }

  migrateLegacySchema() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("ALTER TABLE wake_dispatch RENAME TO wake_dispatch_legacy");
      this.migrationFault?.("after-legacy-rename");
      this.db.exec("DROP INDEX IF EXISTS idx_wake_dispatch_due");
      this.db.exec(DDL);
      this.db.prepare(`
        INSERT INTO wake_dispatch
          (msg_id, recipient_id, member_slot, conversation_id, payload_json, state,
           attempts, claim_count, max_attempts, next_attempt_at, claimed_at,
           last_error, created_at, updated_at, handed_off_at)
        SELECT
          msg_id, ?, ?, conversation_id, payload_json,
          CASE WHEN state = 'acknowledged' THEN 'handed_off' ELSE state END,
          attempts, 0, max_attempts, next_attempt_at, claimed_at, last_error,
          created_at, updated_at,
          CASE WHEN state = 'acknowledged' THEN acknowledged_at ELSE NULL END
        FROM wake_dispatch_legacy
      `).run(this.recipientId, this.recipientId);
      this.migrationFault?.("after-data-copy");
      this.db.exec("DROP TABLE wake_dispatch_legacy");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  seedMigrationBaseline() {
    const baseline = this.hasLocalMessagesTable()
      ? Number(this.db.prepare(`
          SELECT COALESCE(MAX(rowid), 0) AS cursor
          FROM local_messages WHERE direction = 'inbound'
        `).get()?.cursor ?? 0)
      : 0;
    this.db.prepare(`
      INSERT OR IGNORE INTO wake_dispatch_meta(key, value)
      VALUES ('inbound-baseline-rowid', ?)
    `).run(String(baseline));
  }

  fromRow(row) {
    return {
      msgId: row.msg_id,
      recipientId: row.recipient_id,
      memberSlot: row.member_slot,
      conversationId: row.conversation_id,
      payload: JSON.parse(row.payload_json),
      state: row.state,
      attempts: Number(row.attempts),
      claimCount: Number(row.claim_count),
      maxAttempts: Number(row.max_attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
      lastError: row.last_error ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      handedOffAt: row.handed_off_at == null ? null : Number(row.handed_off_at),
    };
  }
}

export const isRetryableWakeState = (state) => RETRYABLE_STATES.includes(state);
