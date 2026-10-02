/**
 * workflow-control.mjs — durable operator control of ONE root workflow.
 *
 * A "workflow" is identified by its ROOT message id (the `msgId` of the message
 * `murmur send` enqueued; every descendant handoff already carries it as
 * `rootMessageId`). Nothing new is invented: this table records only the operator's
 * INTENT about that existing id.
 *
 *   workflow_control(root_message_id PK, state, requested_at, requested_by)
 *
 * One row means "cancel_requested". `cancelled` is DERIVED by the operator view (the
 * intent exists and no runtime is still executing a turn of that workflow) — it is never
 * stored, so it cannot be written wrongly or lag behind reality.
 *
 * The table lives in EVERY agent database of the project (root, claude, codex, cursor),
 * written by `murmur cancel`. That is deliberate: `agent_handoffs`, `wake_dispatch`
 * and `runtime_bindings` already share one database per agent, so the gates that consult
 * this intent (new handoff creation, continuation resume, dispatch claim, reply send)
 * can read it inside the SAME transaction/connection as the state they protect.
 *
 * History is never deleted. Cancellation only ever REFUSES future work.
 */
import { DatabaseSync } from "node:sqlite";

export const WORKFLOW_CONTROL_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_control (
    root_message_id TEXT PRIMARY KEY,
    state           TEXT NOT NULL,
    requested_at    INTEGER NOT NULL,
    requested_by    TEXT NOT NULL
  );
`;

/** The disposition recorded for work refused because its workflow was cancelled. */
export const IGNORED_DUE_TO_CANCELLED_WORKFLOW = "ignored_due_to_cancelled_workflow";
export const WORKFLOW_CANCELLED_REASON = "workflow-cancelled";

/** A workflow id is exactly a message id: bounded, no separators, no shell/SQL surface. */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const isValidWorkflowId = (value) => typeof value === "string" && WORKFLOW_ID_PATTERN.test(value);

export const ensureWorkflowControl = (db) => db.exec(WORKFLOW_CONTROL_DDL);

export const isWorkflowCancelRequested = (db, rootMessageId) => {
  if (!isValidWorkflowId(rootMessageId)) return false;
  try {
    return Boolean(db.prepare("SELECT 1 FROM workflow_control WHERE root_message_id = ?").get(rootMessageId));
  } catch {
    // The table is created by every store at startup; a read-only caller on an old
    // database simply has no cancellations.
    return false;
  }
};

/**
 * Record the cancel intent in ONE database. Idempotent (`INSERT OR IGNORE`), so a double
 * cancel never rewrites `requested_at`. Also retires work of this workflow that no runtime
 * owns yet (`pending`/`deferred`/`failed` dispatches become `rejected` with the stable
 * disposition) in the same transaction — an atomic UPDATE that races a runtime claim
 * safely: whichever commits first wins, and a claimed row is refused by the runtime gate.
 *
 * `messageIds` is the set of message ids belonging to the workflow (root + handoffs)
 * the caller derived from the durable message graph.
 */
export const recordCancelRequest = (db, rootMessageId, { messageIds = [], now = Date.now(), requestedBy = "operator" } = {}) => {
  if (!isValidWorkflowId(rootMessageId)) throw new Error("workflow-id-invalid");
  db.exec("PRAGMA busy_timeout=10000;");
  ensureWorkflowControl(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db.prepare(
      "INSERT OR IGNORE INTO workflow_control (root_message_id, state, requested_at, requested_by) VALUES (?, 'cancel_requested', ?, ?)",
    ).run(rootMessageId, now, requestedBy);
    let retired = 0;
    const hasDispatch = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wake_dispatch'").get();
    if (hasDispatch) {
      const ids = [...new Set([rootMessageId, ...messageIds])].filter(isValidWorkflowId);
      const update = db.prepare(`
        UPDATE wake_dispatch
           SET state = 'rejected', last_error = ?, claimed_at = NULL, updated_at = ?
         WHERE msg_id = ? AND state IN ('pending', 'deferred', 'failed')
      `);
      for (const id of ids) retired += Number(update.run(IGNORED_DUE_TO_CANCELLED_WORKFLOW, now, id).changes);
      // A reply whose `replyToMessageId` is one of the workflow's handoffs is a descendant
      // result: it must not wake a continuation either.
      const replyUpdate = db.prepare(`
        UPDATE wake_dispatch
           SET state = 'rejected', last_error = ?, claimed_at = NULL, updated_at = ?
         WHERE state IN ('pending', 'deferred', 'failed') AND json_extract(payload_json, '$.replyToMessageId') = ?
      `);
      for (const id of ids) retired += Number(replyUpdate.run(IGNORED_DUE_TO_CANCELLED_WORKFLOW, now, id).changes);
    }
    // Open continuations of this workflow can never be resumed now: close them as terminal so
    // nothing reports a task that waits forever (the row stays, with its reason).
    const hasHandoffs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_handoffs'").get();
    let closedContinuations = 0;
    if (hasHandoffs) {
      closedContinuations = Number(db.prepare(
        "UPDATE agent_handoffs SET state = 'terminal', terminal_reason = ?, closed_at = ? WHERE root_message_id = ? AND state = 'open'",
      ).run(WORKFLOW_CANCELLED_REASON, now, rootMessageId).changes);
    }
    db.exec("COMMIT");
    return { newlyRequested: Number(inserted.changes) === 1, retiredDispatches: retired, closedContinuations };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    throw error;
  }
};

/** Open a project agent database for a control write (never creates a missing one). */
export const openAgentDbForControl = (dbPath) => new DatabaseSync(dbPath);
