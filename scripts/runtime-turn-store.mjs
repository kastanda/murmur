/**
 * runtime-turn-store.mjs — durable ownership of "which runtime thread/turn runs this message".
 *
 * Transport is at-least-once and a dispatch may be retried (a wait timeout, a crashed daemon).
 * Execution of ONE logical msgId must nevertheless happen once: a retry must find the thread
 * and turn the first attempt already created and ATTACH to them, never seed a second thread
 * or start a second turn.
 *
 *   runtime_turns(msg_id, recipient_id, member_slot) -> thread_id, turn_id, server_identity, state
 *
 *   seeded     a thread exists for this message; no turn has been accepted yet (a retry reuses the thread)
 *   launched   the server accepted a turn on that thread (a retry attaches to it)
 *   finished   the turn's terminal result was observed (nothing is ever re-run)
 *   abandoned  the runtime that owned it is gone (server identity changed): a retry may start fresh
 *
 * Lives in the agent's own database next to `wake_dispatch`, so it survives a daemon restart.
 */
import { DatabaseSync } from "node:sqlite";

const DDL = `
  CREATE TABLE IF NOT EXISTS runtime_turns (
    msg_id          TEXT NOT NULL,
    recipient_id    TEXT NOT NULL,
    member_slot     TEXT NOT NULL,
    runtime_kind    TEXT NOT NULL,
    thread_id       TEXT,
    turn_id         TEXT,
    server_identity TEXT,
    state           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (msg_id, recipient_id, member_slot)
  );
`;

export const RUNTIME_TURN_STATES = Object.freeze({ seeded: "seeded", launched: "launched", finished: "finished", abandoned: "abandoned" });

const keyOf = (identity) => [identity.msgId, identity.recipientId, identity.memberSlot];

export class RuntimeTurnStore {
  constructor(dbOrPath) {
    this.ownsDb = typeof dbOrPath === "string";
    this.db = this.ownsDb ? new DatabaseSync(dbOrPath) : dbOrPath;
    if (!this.db) throw new Error("runtime-turn-db-required");
    if (this.ownsDb) this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=10000;");
    this.db.exec(DDL);
  }

  get(identity) {
    const row = this.db.prepare(`
      SELECT msg_id AS msgId, recipient_id AS recipientId, member_slot AS memberSlot, runtime_kind AS runtimeKind,
             thread_id AS threadId, turn_id AS turnId, server_identity AS serverIdentity, state,
             created_at AS createdAt, updated_at AS updatedAt
        FROM runtime_turns WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?`).get(...keyOf(identity));
    return row ? { ...row } : null;
  }

  /** The thread was created. Never downgrades a launched/finished record. */
  recordSeeded(identity, { runtimeKind, threadId, serverIdentity = null }, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO runtime_turns (msg_id, recipient_id, member_slot, runtime_kind, thread_id, server_identity, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'seeded', ?, ?)
      ON CONFLICT(msg_id, recipient_id, member_slot) DO UPDATE SET
        thread_id = excluded.thread_id, server_identity = excluded.server_identity, updated_at = excluded.updated_at
        WHERE runtime_turns.state IN ('seeded', 'abandoned')
    `).run(...keyOf(identity), runtimeKind, threadId, serverIdentity, now, now);
  }

  /** The server accepted exactly this turn on exactly this thread. */
  recordLaunched(identity, { runtimeKind, threadId, turnId, serverIdentity = null }, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO runtime_turns (msg_id, recipient_id, member_slot, runtime_kind, thread_id, turn_id, server_identity, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'launched', ?, ?)
      ON CONFLICT(msg_id, recipient_id, member_slot) DO UPDATE SET
        thread_id = excluded.thread_id, turn_id = excluded.turn_id, server_identity = excluded.server_identity,
        state = 'launched', updated_at = excluded.updated_at
        WHERE runtime_turns.state IN ('seeded', 'launched', 'abandoned')
    `).run(...keyOf(identity), runtimeKind, threadId, turnId, serverIdentity, now, now);
  }

  markFinished(identity, now = Date.now()) {
    return Number(this.db.prepare(
      "UPDATE runtime_turns SET state = 'finished', updated_at = ? WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?",
    ).run(now, ...keyOf(identity)).changes);
  }

  markAbandoned(identity, now = Date.now()) {
    return Number(this.db.prepare(
      "UPDATE runtime_turns SET state = 'abandoned', updated_at = ? WHERE msg_id = ? AND recipient_id = ? AND member_slot = ? AND state != 'finished'",
    ).run(now, ...keyOf(identity)).changes);
  }

  count() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM runtime_turns").get().n);
  }
}
