/**
 * Durable reply ownership: a request sent by a CLIENT gets an explicit owner for its
 * correlated reply, recorded BEFORE the message is committed for delivery.
 *
 * Why this exists: the interactive MCP server and the autonomous daemon are the same Murmur
 * identity over the same `murmur.db`. Without durable origin metadata the daemon cannot tell
 * "a reply to something the operator's client sent" from "new work", so it wakes a model turn
 * on a reply it does not own and answers it (a ping-pong).
 *
 * origin (both mean "the reply belongs to that client; store it, never run autonomous work"):
 *   mcp_client       — sent by an interactive MCP tool call;
 *   operator_client  — sent by the operator CLI / a manual shell send (`--origin`).
 *
 * A daemon-owned handoff is NOT recorded here: its owner is the durable `agent_handoffs`
 * continuation, which the wake gate checks first. A sender that records nothing (autonomous
 * replies, legacy callers) is unowned and keeps the historical wake behaviour — in particular
 * a follow-up that replies to an agent's answer is legitimate traffic and is never suppressed.
 *
 * The decision is made on this durable state only — never on `replyToMessageId != null` and
 * never on message text — so it survives restart, retry and redelivery.
 */
export const REPLY_ORIGINS = Object.freeze({
  mcpClient: "mcp_client",
  operatorClient: "operator_client",
});

export const REPLY_OWNERSHIP_DDL = `
  CREATE TABLE IF NOT EXISTS reply_ownership (
    msg_id     TEXT PRIMARY KEY,
    origin     TEXT NOT NULL,
    owner      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const hasTable = (db, name) => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
).get(name));

export class ReplyOwnershipStore {
  /** @param db an open `node:sqlite` DatabaseSync on the profile's `murmur.db` */
  constructor(db) {
    this.db = db;
    // The profile db is shared with the MCP server and the outbox flusher: wait for their
    // writes instead of failing the first post-upgrade start with SQLITE_BUSY.
    this.db.exec("PRAGMA busy_timeout=10000;");
    this.migrate();
    this.db.exec(REPLY_OWNERSHIP_DDL);
  }

  /** An earlier revision constrained `origin` (and admitted a since-removed value): rebuild, keeping client rows. */
  migrate() {
    const sql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reply_ownership'").get()?.sql;
    if (!sql || !/CHECK/i.test(sql)) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("ALTER TABLE reply_ownership RENAME TO reply_ownership_old");
      this.db.exec(REPLY_OWNERSHIP_DDL);
      this.db.exec(`INSERT INTO reply_ownership (msg_id, origin, owner, created_at)
        SELECT msg_id, origin, owner, created_at FROM reply_ownership_old WHERE origin IN ('mcp_client', 'operator_client')`);
      this.db.exec("DROP TABLE reply_ownership_old");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** First write wins: ownership of a msgId is never reassigned. */
  record({ msgId, origin, owner }, now = Date.now()) {
    if (!msgId) throw new Error("reply-ownership-msg-id-required");
    if (!Object.values(REPLY_ORIGINS).includes(origin)) throw new Error(`reply-ownership-origin-invalid:${origin}`);
    if (!owner) throw new Error("reply-ownership-owner-required");
    this.db.prepare(`
      INSERT INTO reply_ownership (msg_id, origin, owner, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(msg_id) DO NOTHING
    `).run(msgId, origin, owner, now);
  }

  get(msgId) {
    const row = this.db.prepare("SELECT msg_id AS msgId, origin, owner FROM reply_ownership WHERE msg_id = ?").get(msgId);
    return row ?? null;
  }

  /**
   * Who may EXECUTE on an inbound correlated reply? Returns `null` when the autonomous
   * runtime may (a daemon handoff continuation, or an unrecorded request), or
   * `{ owner, reason }` when a client owns it.
   */
  static route(db, replyToMessageId) {
    if (!replyToMessageId) return null;
    // A continuation the daemon durably holds (in any state: closed/terminal ones are refused
    // downstream, never re-owned by a client) ALWAYS wins: it closes exactly that handoff.
    if (hasTable(db, "agent_handoffs") && db.prepare(
      "SELECT 1 FROM agent_handoffs WHERE handoff_msg_id = ?",
    ).get(replyToMessageId)) return null;
    if (!hasTable(db, "reply_ownership")) return null;
    const row = db.prepare("SELECT origin, owner FROM reply_ownership WHERE msg_id = ?").get(replyToMessageId);
    if (!row) return null;
    if (!Object.values(REPLY_ORIGINS).includes(row.origin)) return null;
    return { owner: row.owner, reason: `reply-owned-by-${row.origin.replace("_", "-")}` };
  }
}
