/**
 * agent-handoff-store.mjs — durable continuation/routing state for explicit agent
 * handoffs.
 *
 * Scope is deliberately narrow: this store persists ONLY what is needed to resume a
 * delegator once its bounded child task returns. It does not duplicate outbox state,
 * transport status, wake_dispatch state or processing_attempt status — those remain
 * the authoritative owners of delivery, wake and model-execution lifecycle.
 *
 * The handoff envelope's own `msgId` IS the handoff id (primary key). Logical
 * idempotency is `(delegator_id, caused_by_message_id)`: one child handoff per
 * causative message/model turn, so a crash/replay of the same delegation action
 * reuses the existing handoff and its exact msgId instead of creating a second
 * delegated task.
 *
 * FENCED AUTHORITY. `runtime_bindings`, `wake_dispatch`, `agent_handoffs` and `outbox`
 * all live in ONE SQLite database, so every irreversible continuation mutation runs
 * inside a single `BEGIN IMMEDIATE` transaction that re-reads the runtime binding fence
 * as part of the same transaction. `validateFence(); await …; mutate()` is NOT
 * sufficient authority: a binding replacement can land in the gap. The fenced
 * primitives below (`fencedCreate`, `fencedClose`, `fencedTerminate`) are the only
 * paths a runtime may use, and a stale generation loses every one of them atomically —
 * leaving behind no continuation row and no outbound handoff outbox row.
 */
import { DatabaseSync } from "node:sqlite";

export const HANDOFF_STATES = Object.freeze({
  open: "open",
  closed: "closed",
  terminal: "terminal",
});

const DDL = `
  CREATE TABLE IF NOT EXISTS agent_handoffs (
    handoff_msg_id                 TEXT PRIMARY KEY,
    delegator_id                   TEXT NOT NULL,
    recipient_id                   TEXT NOT NULL,
    caused_by_message_id           TEXT NOT NULL,
    root_message_id                TEXT NOT NULL,
    root_conversation_id           TEXT NOT NULL,
    handoff_conversation_id        TEXT NOT NULL,
    parent_active_ancestry_json    TEXT NOT NULL,
    handoff_ancestry_json          TEXT NOT NULL,
    originating_binding_id         TEXT NOT NULL,
    originating_binding_generation INTEGER NOT NULL,
    originating_runtime_kind       TEXT NOT NULL,
    originating_member_slot        TEXT NOT NULL,
    originating_runtime_session_id TEXT,
    originating_server_generation  INTEGER,
    originating_server_identity    TEXT,
    parent_message_id              TEXT NOT NULL,
    parent_conversation_id         TEXT NOT NULL,
    parent_sender_id               TEXT NOT NULL,
    task_text                      TEXT NOT NULL,
    state                          TEXT NOT NULL,
    enqueued_at                    INTEGER,
    closed_by_message_id           TEXT,
    terminal_reason                TEXT,
    created_at                     INTEGER NOT NULL,
    closed_at                      INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_handoff_cause
    ON agent_handoffs(delegator_id, caused_by_message_id);
  CREATE INDEX IF NOT EXISTS idx_agent_handoff_open
    ON agent_handoffs(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_handoff_root
    ON agent_handoffs(root_message_id, created_at);
`;

const REQUIRED_STRINGS = [
  "handoffMsgId", "delegatorId", "recipientId", "causedByMessageId",
  "rootMessageId", "rootConversationId", "handoffConversationId",
  "originatingBindingId", "originatingRuntimeKind", "originatingMemberSlot",
  "parentMessageId", "parentConversationId", "parentSenderId", "taskText",
];

const requireString = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`agent-handoff-${name}-required`);
  return value;
};

const requireAncestry = (value, name) => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`agent-handoff-${name}-invalid`);
  }
  if (new Set(value).size !== value.length) throw new Error(`agent-handoff-${name}-invalid`);
  return [...value];
};

const parseAncestry = (json) => {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export class AgentHandoffStore {
  constructor(dbOrPath) {
    this.ownsDb = typeof dbOrPath === "string";
    this.db = this.ownsDb ? new DatabaseSync(dbOrPath) : dbOrPath;
    if (!this.db) throw new Error("agent-handoff-db-required");
    if (this.ownsDb) this.db.exec("PRAGMA journal_mode=WAL;");
    // The fenced primitives take a write lock that competes with every other store on
    // this database file, so this connection needs the same busy timeout they use.
    this.db.exec("PRAGMA busy_timeout=10000;");
    this.db.exec(DDL);
    this.ensureColumns();
  }

  hasTable(name) {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  /**
   * Run `apply` inside one `BEGIN IMMEDIATE` transaction. SQLite has no nested
   * transactions, so every `#apply*` helper assumes an already-open transaction and is
   * never called directly by a runtime.
   */
  transact(apply) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Re-read the runtime binding fence (and, when an assignment identity is given, the
   * wake_dispatch ownership row) INSIDE the caller's transaction. This mirrors
   * `RuntimeBindingStore.validateFence` exactly, but its result cannot go stale between
   * the check and the mutation because both are in the same transaction.
   */
  fenceIsCurrent(fence, identity = null) {
    if (!fence?.bindingId) return false;
    if (!this.hasTable("runtime_bindings")) throw new Error("agent-handoff-runtime-bindings-missing");
    const binding = this.db.prepare(`
      SELECT 1 FROM runtime_bindings
      WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ?
        AND fencing_epoch = ? AND state NOT IN ('OFFLINE','STALE')
    `).get(fence.bindingId, fence.ownerGeneration, fence.fencingToken, fence.fencingEpoch);
    if (!binding) return false;
    if (!identity) return true;
    if (!this.hasTable("wake_dispatch")) throw new Error("agent-handoff-wake-dispatch-missing");
    return Boolean(this.db.prepare(`
      SELECT 1 FROM wake_dispatch
      WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
        AND owner_binding_id = ? AND owner_generation = ?
        AND fencing_token = ? AND fencing_epoch = ?
    `).get(
      identity.msgId, identity.recipientId, identity.memberSlot, fence.bindingId,
      fence.ownerGeneration, fence.fencingToken, fence.fencingEpoch,
    ));
  }

  /** Additive migration, consistent with the other Murmur SQLite stores. */
  ensureColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(agent_handoffs)").all().map((c) => c.name));
    for (const [name, type] of [
      ["originating_server_generation", "INTEGER"],
      ["originating_server_identity", "TEXT"],
      ["enqueued_at", "INTEGER"],
      ["terminal_reason", "TEXT"],
      ["task_text", "TEXT NOT NULL DEFAULT ''"],
    ]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE agent_handoffs ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Create the continuation, or return the one an earlier attempt at the SAME logical
   * delegation already created. Reuse keeps the original `handoff_msg_id`, so a replay
   * re-enqueues the identical envelope rather than delegating twice.
   */
  createOrReuse(record, now = Date.now()) {
    return this.transact(() => this.applyCreate(record, now));
  }

  /** Transaction-free core of {@link createOrReuse}. Caller MUST hold a transaction. */
  applyCreate(record, now = Date.now()) {
    for (const field of REQUIRED_STRINGS) requireString(record?.[field], field);
    const parentActiveAncestry = requireAncestry(record.parentActiveAncestry, "parentActiveAncestry");
    const handoffAncestry = requireAncestry(record.handoffAncestry, "handoffAncestry");
    const generation = Number(record.originatingBindingGeneration);
    if (!Number.isInteger(generation)) throw new Error("agent-handoff-originatingBindingGeneration-invalid");
    {
      const existing = this.db.prepare(`
        SELECT * FROM agent_handoffs WHERE delegator_id = ? AND caused_by_message_id = ?
      `).get(record.delegatorId, record.causedByMessageId);
      if (existing) {
        return { handoff: this.fromRow(existing), created: false };
      }
      this.db.prepare(`
        INSERT INTO agent_handoffs
          (handoff_msg_id, delegator_id, recipient_id, caused_by_message_id,
           root_message_id, root_conversation_id, handoff_conversation_id,
           parent_active_ancestry_json, handoff_ancestry_json,
           originating_binding_id, originating_binding_generation,
           originating_runtime_kind, originating_member_slot,
           originating_runtime_session_id, originating_server_generation,
           originating_server_identity,
           parent_message_id, parent_conversation_id, parent_sender_id,
           task_text, state, enqueued_at, closed_by_message_id, terminal_reason,
           created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, NULL)
      `).run(
        record.handoffMsgId, record.delegatorId, record.recipientId, record.causedByMessageId,
        record.rootMessageId, record.rootConversationId, record.handoffConversationId,
        JSON.stringify(parentActiveAncestry), JSON.stringify(handoffAncestry),
        record.originatingBindingId, generation,
        record.originatingRuntimeKind, record.originatingMemberSlot,
        record.originatingRuntimeSessionId ?? null,
        record.originatingServerGeneration == null ? null : Number(record.originatingServerGeneration),
        record.originatingServerIdentity ?? null,
        record.parentMessageId, record.parentConversationId, record.parentSenderId,
        record.taskText, now,
      );
      return { handoff: this.get(record.handoffMsgId), created: true };
    }
  }

  /** Record that the signed handoff envelope reached the durable outbox. */
  markEnqueued(handoffMsgId, now = Date.now()) {
    return Number(this.db.prepare(`
      UPDATE agent_handoffs SET enqueued_at = COALESCE(enqueued_at, ?)
      WHERE handoff_msg_id = ?
    `).run(now, handoffMsgId).changes);
  }

  /**
   * Insert the exact outbound handoff envelope into the shared durable outbox, using
   * the SAME columns and `INSERT OR IGNORE` msgId semantics as
   * `SQLiteDedupeOutboxStore.enqueue`. Caller MUST hold a transaction: the outbox row is
   * the durable "send" boundary, so it has to commit atomically with the continuation
   * and the fence check. Actual NATS publication still happens later through the normal
   * outbox flush.
   */
  applyOutboxEnqueue({ subject, envelope }, now = Date.now()) {
    requireString(subject, "outboxSubject");
    if (!envelope?.msgId) throw new Error("agent-handoff-outbox-envelope-invalid");
    if (!this.hasTable("outbox")) throw new Error("agent-handoff-outbox-missing");
    const iso = new Date(now).toISOString();
    return Number(this.db.prepare(`
      INSERT OR IGNORE INTO outbox
        (msg_id, subject, envelope_json, status, attempts, next_attempt_at, created_at, updated_at, version)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, 1)
    `).run(envelope.msgId, subject, JSON.stringify(envelope), iso, iso, iso).changes);
  }

  /**
   * FENCED handoff creation — the single durable authority boundary for delegating.
   *
   * One `BEGIN IMMEDIATE` transaction: re-read the binding fence, idempotently
   * create/reuse the continuation, insert/reuse the exact outbound outbox row, and mark
   * it enqueued. A generation that lost its fence commits NOTHING: no continuation row
   * and no new outbound handoff.
   */
  fencedCreate({ fence, identity = null, record, outbox = null }, now = Date.now()) {
    if (!fence?.bindingId) throw new Error("agent-handoff-fence-required");
    return this.transact(() => {
      if (!this.fenceIsCurrent(fence, identity)) {
        return { ok: false, reason: "handoff-continuation-stale-binding", handoff: null, created: false };
      }
      const { handoff, created } = this.applyCreate(record, now);
      if (outbox) this.applyOutboxEnqueue(outbox, now);
      this.markEnqueued(handoff.handoffMsgId, now);
      return { ok: true, reason: null, handoff: this.get(handoff.handoffMsgId), created };
    });
  }

  /**
   * FENCED continuation close. The fence re-read, the exact-correlation checks and the
   * open -> closed CAS all commit together, so a stale generation loses the CAS and
   * cannot touch `closed_by_message_id`, `closed_at` or the terminal state.
   */
  fencedClose({ fence, identity = null, handoffMsgId, replySenderId, replyConversationId, closedByMessageId }, now = Date.now()) {
    if (!fence?.bindingId) throw new Error("agent-handoff-fence-required");
    return this.transact(() => {
      if (!this.fenceIsCurrent(fence, identity)) {
        return { ok: false, closed: false, replay: false, reason: "handoff-continuation-stale-binding", handoff: this.get(handoffMsgId) };
      }
      const result = this.applyClose({ handoffMsgId, replySenderId, replyConversationId, closedByMessageId }, now);
      return { ok: true, ...result };
    });
  }

  /**
   * FENCED terminalization. A stale generation must not be able to mark a continuation
   * failed/rejected after a replacement runtime has taken ownership of the binding.
   */
  fencedTerminate({ fence, identity = null, handoffMsgId, reason }, now = Date.now()) {
    if (!fence?.bindingId) throw new Error("agent-handoff-fence-required");
    return this.transact(() => {
      if (!this.fenceIsCurrent(fence, identity)) {
        return { ok: false, changed: 0, reason: "handoff-continuation-stale-binding" };
      }
      return { ok: true, changed: this.applyTerminate({ handoffMsgId, reason }, now), reason: null };
    });
  }

  /**
   * Open continuations whose envelope never reached the outbox (crash between the
   * continuation write and the enqueue). Re-enqueue is safe: the outbox is keyed by
   * msgId, and the handoff msgId is stable.
   */
  pendingEnqueue() {
    return this.db.prepare(`
      SELECT * FROM agent_handoffs WHERE state = 'open' AND enqueued_at IS NULL
      ORDER BY created_at, rowid
    `).all().map((row) => this.fromRow(row));
  }

  get(handoffMsgId) {
    if (typeof handoffMsgId !== "string" || !handoffMsgId) return null;
    const row = this.db.prepare("SELECT * FROM agent_handoffs WHERE handoff_msg_id = ?").get(handoffMsgId);
    return row ? this.fromRow(row) : null;
  }

  findByCause(delegatorId, causedByMessageId) {
    const row = this.db.prepare(`
      SELECT * FROM agent_handoffs WHERE delegator_id = ? AND caused_by_message_id = ?
    `).get(delegatorId, causedByMessageId);
    return row ? this.fromRow(row) : null;
  }

  listOpen() {
    return this.db.prepare("SELECT * FROM agent_handoffs WHERE state = 'open' ORDER BY created_at, rowid")
      .all().map((row) => this.fromRow(row));
  }

  list() {
    return this.db.prepare("SELECT * FROM agent_handoffs ORDER BY created_at, rowid")
      .all().map((row) => this.fromRow(row));
  }

  /**
   * Compare-and-set close, exactly once.
   *
   * `closed: true` is returned to exactly one caller. A repeat of the SAME closing
   * message (an at-least-once redelivery / dispatch retry of the identical child
   * reply) is reported as `replay: true` so the delegator can finish the work it
   * already claimed; a DIFFERENT second reply is refused and can never resume the
   * runtime again.
   */
  closeOnce({ handoffMsgId, replySenderId, replyConversationId, closedByMessageId }, now = Date.now()) {
    return this.transact(() => this.applyClose({ handoffMsgId, replySenderId, replyConversationId, closedByMessageId }, now));
  }

  /**
   * Transaction-free core of {@link closeOnce}. Caller MUST hold a transaction.
   *
   * Exact correlation requires ALL THREE of: the exact handoff msgId, the expected
   * recipient identity, and the persisted DERIVED handoff conversation. A reply that
   * matches the msgId and sender but arrives in any other conversation (the root
   * conversation, another handoff's conversation, an attacker-chosen one) closes
   * nothing and mutates nothing — the continuation stays open for the real result.
   */
  applyClose({ handoffMsgId, replySenderId, replyConversationId, closedByMessageId }, now = Date.now()) {
    requireString(handoffMsgId, "handoffMsgId");
    requireString(closedByMessageId, "closedByMessageId");
    const row = this.get(handoffMsgId);
    if (!row) {
      return { closed: false, replay: false, reason: "handoff-continuation-missing", handoff: null };
    }
    if (replySenderId !== undefined && row.recipientId !== replySenderId) {
      return { closed: false, replay: false, reason: "handoff-continuation-sender-mismatch", handoff: row };
    }
    if (replyConversationId !== undefined && row.handoffConversationId !== replyConversationId) {
      return { closed: false, replay: false, reason: "handoff-continuation-conversation-mismatch", handoff: row };
    }
    if (row.state === HANDOFF_STATES.terminal) {
      return { closed: false, replay: false, reason: "handoff-continuation-terminal", handoff: row };
    }
    if (row.state === HANDOFF_STATES.closed) {
      return row.closedByMessageId === closedByMessageId
        ? { closed: false, replay: true, reason: null, handoff: row }
        : { closed: false, replay: false, reason: "handoff-continuation-already-closed", handoff: row };
    }
    const changed = Number(this.db.prepare(`
      UPDATE agent_handoffs
      SET state = 'closed', closed_by_message_id = ?, closed_at = ?
      WHERE handoff_msg_id = ? AND state = 'open'
    `).run(closedByMessageId, now, handoffMsgId).changes);
    if (changed !== 1) {
      return { closed: false, replay: false, reason: "handoff-continuation-already-closed", handoff: this.get(handoffMsgId) };
    }
    return { closed: true, replay: false, reason: null, handoff: this.get(handoffMsgId) };
  }

  /**
   * Record an explicit terminal continuation reason. Used when safe continuation is
   * impossible — never to fake continuity with an unrelated new model session.
   */
  markTerminal({ handoffMsgId, reason }, now = Date.now()) {
    return this.transact(() => this.applyTerminate({ handoffMsgId, reason }, now));
  }

  /** Transaction-free core of {@link markTerminal}. Caller MUST hold a transaction. */
  applyTerminate({ handoffMsgId, reason }, now = Date.now()) {
    requireString(handoffMsgId, "handoffMsgId");
    requireString(reason, "terminalReason");
    return Number(this.db.prepare(`
      UPDATE agent_handoffs
      SET state = 'terminal', terminal_reason = ?, closed_at = COALESCE(closed_at, ?)
      WHERE handoff_msg_id = ? AND state IN ('open', 'closed')
    `).run(reason, now, handoffMsgId).changes);
  }

  fromRow(row) {
    return {
      handoffMsgId: row.handoff_msg_id,
      delegatorId: row.delegator_id,
      recipientId: row.recipient_id,
      causedByMessageId: row.caused_by_message_id,
      rootMessageId: row.root_message_id,
      rootConversationId: row.root_conversation_id,
      handoffConversationId: row.handoff_conversation_id,
      parentActiveAncestry: parseAncestry(row.parent_active_ancestry_json),
      handoffAncestry: parseAncestry(row.handoff_ancestry_json),
      originatingBindingId: row.originating_binding_id,
      originatingBindingGeneration: Number(row.originating_binding_generation),
      originatingRuntimeKind: row.originating_runtime_kind,
      originatingMemberSlot: row.originating_member_slot,
      originatingRuntimeSessionId: row.originating_runtime_session_id ?? null,
      originatingServerGeneration: row.originating_server_generation == null
        ? null : Number(row.originating_server_generation),
      originatingServerIdentity: row.originating_server_identity ?? null,
      parentMessageId: row.parent_message_id,
      parentConversationId: row.parent_conversation_id,
      parentSenderId: row.parent_sender_id,
      taskText: row.task_text ?? "",
      state: row.state,
      enqueuedAt: row.enqueued_at == null ? null : Number(row.enqueued_at),
      closedByMessageId: row.closed_by_message_id ?? null,
      terminalReason: row.terminal_reason ?? null,
      createdAt: Number(row.created_at),
      closedAt: row.closed_at == null ? null : Number(row.closed_at),
    };
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
