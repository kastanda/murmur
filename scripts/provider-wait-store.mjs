/**
 * provider-wait-store.mjs — the durable `waiting_for_provider` wait reason of ONE workflow.
 *
 * A wait exists only for work that was REFUSED before anything durable was created (a handoff
 * whose recipient provider is authoritatively exhausted). It records the original intent so the
 * release can perform exactly that delegation, once, after the provider recovers:
 *
 *   provider_waits(wait_id PK = the handoff msg id reserved for the child,
 *                  workflow_id = root message id, provider, intended_recipient_id, delegator_id,
 *                  caused_by_message_id, required_capability, mandatory, wait_reason,
 *                  state waiting|released|cancelled, first_observed_at, resets_at,
 *                  next_check_at, record_json = the delegation intent, released_at)
 *
 * Nothing about quota percentages lives here. Exactly-once: `(delegator_id, caused_by_message_id)`
 * is UNIQUE (one wait per causative turn), and release is a CAS `waiting -> released` committed in
 * the SAME transaction as the child handoff creation (see AgentHandoffController.releaseWait).
 */
export const PROVIDER_WAIT_DDL = `
  CREATE TABLE IF NOT EXISTS provider_waits (
    wait_id               TEXT PRIMARY KEY,
    workflow_id           TEXT NOT NULL,
    provider              TEXT NOT NULL,
    intended_recipient_id TEXT NOT NULL,
    delegator_id          TEXT NOT NULL,
    caused_by_message_id  TEXT NOT NULL,
    required_capability   TEXT,
    mandatory             INTEGER NOT NULL DEFAULT 0,
    wait_reason           TEXT NOT NULL,
    state                 TEXT NOT NULL,
    first_observed_at     INTEGER NOT NULL,
    resets_at             INTEGER,
    next_check_at         INTEGER NOT NULL,
    record_json           TEXT NOT NULL,
    created_at            INTEGER NOT NULL,
    released_at           INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_wait_cause
    ON provider_waits(delegator_id, caused_by_message_id);
  CREATE INDEX IF NOT EXISTS idx_provider_wait_due
    ON provider_waits(state, next_check_at);
`;

export const WAIT_STATES = Object.freeze({ waiting: "waiting", released: "released", cancelled: "cancelled" });

const fromRow = (row) => (row ? {
  waitId: row.wait_id,
  workflowId: row.workflow_id,
  provider: row.provider,
  intendedRecipientId: row.intended_recipient_id,
  delegatorId: row.delegator_id,
  causedByMessageId: row.caused_by_message_id,
  requiredCapability: row.required_capability ?? null,
  mandatory: Number(row.mandatory) === 1,
  waitReason: row.wait_reason,
  state: row.state,
  firstObservedAt: Number(row.first_observed_at),
  resetsAt: row.resets_at == null ? null : Number(row.resets_at),
  nextCheckAt: Number(row.next_check_at),
  record: JSON.parse(row.record_json),
  createdAt: Number(row.created_at),
  releasedAt: row.released_at == null ? null : Number(row.released_at),
} : null);

export class ProviderWaitStore {
  constructor(db) {
    if (!db) throw new Error("provider-wait-store-db-required");
    this.db = db;
    db.exec(PROVIDER_WAIT_DDL);
  }

  /**
   * One wait per causative turn: a replay of the same refused turn returns the existing wait
   * (and refreshes only the observed reset / next check), it never creates a second one.
   */
  upsert({ waitId, workflowId, provider, intendedRecipientId, delegatorId, causedByMessageId,
    requiredCapability = null, mandatory = false, waitReason, resetsAt = null, nextCheckAt, record }, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO provider_waits (wait_id, workflow_id, provider, intended_recipient_id, delegator_id, caused_by_message_id,
        required_capability, mandatory, wait_reason, state, first_observed_at, resets_at, next_check_at, record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?)
      ON CONFLICT(delegator_id, caused_by_message_id) DO UPDATE SET
        wait_reason = excluded.wait_reason, resets_at = excluded.resets_at, next_check_at = excluded.next_check_at
        WHERE provider_waits.state = 'waiting'
    `).run(waitId, workflowId, provider, intendedRecipientId, delegatorId, causedByMessageId, requiredCapability,
      mandatory ? 1 : 0, waitReason, now, resetsAt, nextCheckAt, JSON.stringify(record), now);
    return this.getByCause(delegatorId, causedByMessageId);
  }

  getByCause(delegatorId, causedByMessageId) {
    return fromRow(this.db.prepare("SELECT * FROM provider_waits WHERE delegator_id = ? AND caused_by_message_id = ?").get(delegatorId, causedByMessageId));
  }

  get(waitId) {
    return fromRow(this.db.prepare("SELECT * FROM provider_waits WHERE wait_id = ?").get(waitId));
  }

  /** Waiting items whose re-evaluation time has come (never earlier: no aggressive polling). */
  due(now = Date.now()) {
    return this.db.prepare("SELECT * FROM provider_waits WHERE state = 'waiting' AND next_check_at <= ? ORDER BY next_check_at, created_at").all(now).map(fromRow);
  }

  listWaiting() {
    return this.db.prepare("SELECT * FROM provider_waits WHERE state = 'waiting' ORDER BY created_at").all().map(fromRow);
  }

  reschedule(waitId, { resetsAt, nextCheckAt, waitReason }) {
    return Number(this.db.prepare(`
      UPDATE provider_waits SET resets_at = ?, next_check_at = ?, wait_reason = ? WHERE wait_id = ? AND state = 'waiting'
    `).run(resetsAt, nextCheckAt, waitReason, waitId).changes);
  }

  /** CAS inside the caller's transaction: exactly one caller wins the release. */
  markReleased(waitId, now = Date.now()) {
    return Number(this.db.prepare("UPDATE provider_waits SET state = 'released', released_at = ? WHERE wait_id = ? AND state = 'waiting'").run(now, waitId).changes);
  }

  /** The operator cancelled the workflow: the intent can never be released. */
  cancelWorkflow(workflowId, now = Date.now()) {
    return Number(this.db.prepare("UPDATE provider_waits SET state = 'cancelled', released_at = ? WHERE workflow_id = ? AND state = 'waiting'").run(now, workflowId).changes);
  }
}
