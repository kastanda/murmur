import { DatabaseSync } from "node:sqlite";

export const RUNTIME_BINDING_STATES = Object.freeze({
  unbound: "UNBOUND",
  starting: "STARTING",
  idle: "BOUND_IDLE",
  claimed: "CLAIMED",
  waking: "WAKING",
  running: "RUNNING",
  stopping: "STOPPING",
  offline: "OFFLINE",
  stale: "STALE",
});

const ACTIVE_STATES = ["STARTING", "BOUND_IDLE", "CLAIMED", "WAKING", "RUNNING", "STOPPING"];
const TRANSITIONS = new Map([
  ["UNBOUND", new Set(["STARTING", "OFFLINE"])],
  ["STARTING", new Set(["BOUND_IDLE", "OFFLINE", "STALE"])],
  ["BOUND_IDLE", new Set(["CLAIMED", "STOPPING", "OFFLINE", "STALE"])],
  ["CLAIMED", new Set(["WAKING", "BOUND_IDLE", "OFFLINE", "STALE"])],
  ["WAKING", new Set(["RUNNING", "BOUND_IDLE", "OFFLINE", "STALE"])],
  ["RUNNING", new Set(["BOUND_IDLE", "STOPPING", "OFFLINE", "STALE"])],
  ["STOPPING", new Set(["OFFLINE", "STALE"])],
  ["OFFLINE", new Set(["STARTING"])],
  ["STALE", new Set(["STARTING", "OFFLINE"])],
]);

const DDL = `
  CREATE TABLE IF NOT EXISTS runtime_bindings (
    binding_id             TEXT PRIMARY KEY,
    agent_id               TEXT NOT NULL,
    runtime_kind           TEXT NOT NULL,
    runtime_session_id     TEXT,
    runtime_generation     INTEGER NOT NULL,
    pid                    INTEGER,
    process_start_identity TEXT,
    project_id             TEXT NOT NULL,
    task_id                TEXT,
    member_slot            TEXT NOT NULL,
    lease_token            INTEGER NOT NULL DEFAULT 0,
    fencing_epoch          INTEGER NOT NULL,
    state                  TEXT NOT NULL,
    lease_ttl_ms           INTEGER NOT NULL,
    last_heartbeat         INTEGER NOT NULL,
    last_assigned_message_id TEXT,
    started_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL,
    metadata_json          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_binding_route
    ON runtime_bindings(agent_id, project_id, member_slot, state, task_id, last_heartbeat);
`;

const requiredString = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`runtime-binding-${name}-required`);
  return value;
};

export class RuntimeBindingStore {
  constructor(dbOrPath) {
    this.ownsDb = typeof dbOrPath === "string";
    this.db = this.ownsDb ? new DatabaseSync(dbOrPath) : dbOrPath;
    if (!this.db) throw new Error("runtime-binding-db-required");
    if (this.ownsDb) this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;");
    this.db.exec(DDL);
  }

  register(binding, now = Date.now()) {
    const bindingId = requiredString(binding?.bindingId, "bindingId");
    const agentId = requiredString(binding?.agentId, "agentId");
    const runtimeKind = requiredString(binding?.runtimeKind, "runtimeKind");
    const projectId = requiredString(binding?.projectId, "projectId");
    const memberSlot = requiredString(binding?.memberSlot, "memberSlot");
    const generation = Number(binding.runtimeGeneration ?? 1);
    const ttlMs = Number(binding.leaseTtlMs ?? 30_000);
    if (!Number.isInteger(generation) || generation < 1) throw new Error("runtime-binding-generation-invalid");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("runtime-binding-ttl-invalid");
    const state = binding.state ?? "STARTING";
    if (!TRANSITIONS.has(state)) throw new Error("runtime-binding-state-invalid");
    this.db.prepare(`
      INSERT INTO runtime_bindings
        (binding_id, agent_id, runtime_kind, runtime_session_id, runtime_generation,
         pid, process_start_identity, project_id, task_id, member_slot, lease_token,
         fencing_epoch, state, lease_ttl_ms, last_heartbeat,
         last_assigned_message_id, started_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      bindingId, agentId, runtimeKind, binding.runtimeSessionId ?? null, generation,
      binding.pid ?? null, binding.processStartIdentity ?? null, projectId,
      binding.taskId ?? null, memberSlot, generation, state, ttlMs, now, now, now,
      binding.metadata == null ? null : JSON.stringify(binding.metadata),
    );
    return this.get(bindingId);
  }

  replace(bindingId, replacement, now = Date.now()) {
    const old = this.get(bindingId);
    if (!old) throw new Error("runtime-binding-not-found");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE runtime_bindings SET state = 'STALE', updated_at = ? WHERE binding_id = ?`)
        .run(now, bindingId);
      const next = this.register({
        ...replacement,
        agentId: replacement.agentId ?? old.agentId,
        runtimeKind: replacement.runtimeKind ?? old.runtimeKind,
        projectId: replacement.projectId ?? old.projectId,
        taskId: replacement.taskId ?? old.taskId,
        memberSlot: replacement.memberSlot ?? old.memberSlot,
        leaseTtlMs: replacement.leaseTtlMs ?? old.leaseTtlMs,
        runtimeGeneration: old.runtimeGeneration + 1,
        state: replacement.state ?? "STARTING",
      }, now);
      this.db.exec("COMMIT");
      return next;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  heartbeat(fence, now = Date.now()) {
    const result = this.db.prepare(`
      UPDATE runtime_bindings SET last_heartbeat = ?, updated_at = ?
      WHERE binding_id = ? AND runtime_generation = ?
        AND (? IS NULL OR lease_token = ?)
        AND state IN ('STARTING','BOUND_IDLE','CLAIMED','WAKING','RUNNING','STOPPING')
    `).run(now, now, fence.bindingId, fence.ownerGeneration, fence.fencingToken ?? null, fence.fencingToken ?? null);
    return Number(result.changes);
  }

  updateProcess(fence, { pid = null, processStartIdentity = null } = {}, now = Date.now()) {
    const result = this.db.prepare(`
      UPDATE runtime_bindings
      SET pid = ?, process_start_identity = ?, updated_at = ?, last_heartbeat = ?
      WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ?
        AND fencing_epoch = ? AND state IN ('STARTING','BOUND_IDLE','CLAIMED','WAKING','RUNNING')
    `).run(
      pid, processStartIdentity, now, now, fence.bindingId, fence.ownerGeneration,
      fence.fencingToken, fence.fencingEpoch,
    );
    return Number(result.changes);
  }

  confirmRuntimeSession(fence, runtimeSessionId, now = Date.now()) {
    requiredString(runtimeSessionId, "session-id");
    const result = this.db.prepare(`
      UPDATE runtime_bindings
      SET runtime_session_id = COALESCE(runtime_session_id, ?), updated_at = ?, last_heartbeat = ?
      WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ?
        AND fencing_epoch = ? AND state = 'RUNNING'
        AND (runtime_session_id IS NULL OR runtime_session_id = ?)
    `).run(
      runtimeSessionId, now, now, fence.bindingId, fence.ownerGeneration,
      fence.fencingToken, fence.fencingEpoch, runtimeSessionId,
    );
    return Number(result.changes);
  }

  releaseAssignment(fence, identity, {
    state = "deferred", reason = "runtime-assignment-released", nextAttemptAt = Date.now(),
  } = {}, now = Date.now()) {
    if (!["deferred", "failed", "terminal"].includes(state)) {
      throw new Error("runtime-binding-release-state-invalid");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.validateFence(fence, identity)) {
        this.db.exec("ROLLBACK");
        return 0;
      }
      const dispatch = this.db.prepare(`
        UPDATE wake_dispatch
        SET state = ?, next_attempt_at = ?, claimed_at = NULL, last_error = ?, updated_at = ?,
            owner_binding_id = NULL, owner_generation = NULL,
            fencing_token = NULL, fencing_epoch = NULL
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
          AND owner_binding_id = ? AND owner_generation = ?
          AND fencing_token = ? AND fencing_epoch = ?
          AND state IN ('claimed','dispatched')
      `).run(
        state, nextAttemptAt, reason, now, identity.msgId, identity.recipientId,
        identity.memberSlot, fence.bindingId, fence.ownerGeneration,
        fence.fencingToken, fence.fencingEpoch,
      );
      if (Number(dispatch.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return 0;
      }
      const binding = this.db.prepare(`
        UPDATE runtime_bindings
        SET state = 'BOUND_IDLE', task_id = CASE
              WHEN json_extract(metadata_json, '$.stickyTask') = 1 THEN task_id ELSE NULL END,
            pid = CASE WHEN json_extract(metadata_json, '$.persistentProcess') = 1 THEN pid ELSE NULL END,
            process_start_identity = CASE
              WHEN json_extract(metadata_json, '$.persistentProcess') = 1 THEN process_start_identity ELSE NULL END,
            updated_at = ?, last_heartbeat = ?
        WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ?
          AND fencing_epoch = ? AND state IN ('CLAIMED','WAKING','RUNNING')
      `).run(
        now, now, fence.bindingId, fence.ownerGeneration, fence.fencingToken, fence.fencingEpoch,
      );
      if (Number(binding.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return 0;
      }
      this.db.exec("COMMIT");
      return 1;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  markIdle(fence, now = Date.now()) {
    const row = this.get(fence?.bindingId);
    if (!row || row.runtimeGeneration !== fence.ownerGeneration
      || (fence.fencingToken != null && row.leaseToken !== fence.fencingToken)
      || !TRANSITIONS.get(row.state)?.has("BOUND_IDLE")) return 0;
    const sticky = row.metadata?.stickyTask === true;
    const persistentProcess = row.metadata?.persistentProcess === true;
    const result = this.db.prepare(`
      UPDATE runtime_bindings
      SET state = 'BOUND_IDLE', task_id = CASE WHEN ? THEN task_id ELSE NULL END,
          pid = CASE WHEN ? THEN pid ELSE NULL END,
          process_start_identity = CASE WHEN ? THEN process_start_identity ELSE NULL END,
          updated_at = ?, last_heartbeat = ?
      WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ? AND state = ?
    `).run(sticky ? 1 : 0, persistentProcess ? 1 : 0, persistentProcess ? 1 : 0,
      now, now, row.bindingId, row.runtimeGeneration, row.leaseToken, row.state);
    return Number(result.changes);
  }

  markWaking(fence, now = Date.now()) {
    return this.transition(fence, "WAKING", now);
  }

  markRunning(fence, now = Date.now()) {
    return this.transition(fence, "RUNNING", now);
  }

  markStopping(fence, now = Date.now()) {
    return this.transition(fence, "STOPPING", now);
  }

  markOffline(fence, now = Date.now()) {
    return this.transition(fence, "OFFLINE", now);
  }

  markStale(fence, now = Date.now()) {
    return this.transition(fence, "STALE", now);
  }

  transition(fence, nextState, now = Date.now()) {
    if (!TRANSITIONS.has(nextState)) throw new Error("runtime-binding-state-invalid");
    const row = this.get(fence?.bindingId);
    if (!row || row.runtimeGeneration !== fence.ownerGeneration
      || (fence.fencingToken != null && row.leaseToken !== fence.fencingToken)) return 0;
    if (!TRANSITIONS.get(row.state)?.has(nextState)) return 0;
    const result = this.db.prepare(`
      UPDATE runtime_bindings SET state = ?,
        pid = CASE WHEN ? = 'OFFLINE' THEN NULL ELSE pid END,
        process_start_identity = CASE WHEN ? = 'OFFLINE' THEN NULL ELSE process_start_identity END,
        updated_at = ?, last_heartbeat = ?
      WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ? AND state = ?
    `).run(nextState, nextState, nextState, now, now,
      row.bindingId, row.runtimeGeneration, row.leaseToken, row.state);
    return Number(result.changes);
  }

  assignDispatch(identity, route, now = Date.now()) {
    requiredString(route?.agentId, "agentId");
    requiredString(route?.projectId, "projectId");
    requiredString(route?.memberSlot, "memberSlot");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const dispatch = this.db.prepare(`
        SELECT * FROM wake_dispatch
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
          AND state = 'claimed' AND owner_binding_id IS NULL
      `).get(identity.msgId, identity.recipientId, identity.memberSlot);
      if (!dispatch) {
        this.db.exec("COMMIT");
        return null;
      }
      if (route.memberSlot !== dispatch.member_slot) {
        throw new Error("runtime-binding-member-slot-mismatch");
      }
      const taskId = route.taskId ?? dispatch.conversation_id;
      const binding = this.db.prepare(`
        SELECT * FROM runtime_bindings
        WHERE agent_id = ? AND project_id = ? AND member_slot = ?
          AND state = 'BOUND_IDLE' AND (? - last_heartbeat) <= lease_ttl_ms
          AND (task_id = ? OR task_id IS NULL)
        ORDER BY CASE WHEN task_id = ? THEN 0 ELSE 1 END, started_at ASC, binding_id ASC
        LIMIT 1
      `).get(route.agentId, route.projectId, dispatch.member_slot, now, taskId, taskId);
      if (!binding) {
        this.db.exec("COMMIT");
        return null;
      }
      const claimed = this.db.prepare(`
        UPDATE runtime_bindings
        SET state = 'CLAIMED', task_id = COALESCE(task_id, ?),
            lease_token = lease_token + 1, fencing_epoch = fencing_epoch + 1,
            last_assigned_message_id = ?, updated_at = ?, last_heartbeat = ?
        WHERE binding_id = ? AND runtime_generation = ? AND state = 'BOUND_IDLE'
        RETURNING *
      `).get(taskId, identity.msgId, now, now, binding.binding_id, binding.runtime_generation);
      if (!claimed) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const assigned = this.db.prepare(`
        UPDATE wake_dispatch
        SET owner_binding_id = ?, owner_generation = ?, fencing_token = ?, fencing_epoch = ?, updated_at = ?
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
          AND state = 'claimed' AND owner_binding_id IS NULL
      `).run(
        claimed.binding_id, claimed.runtime_generation, claimed.lease_token, claimed.fencing_epoch, now,
        identity.msgId, identity.recipientId, identity.memberSlot,
      );
      if (Number(assigned.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.exec("COMMIT");
      return this.fenceFromRow(claimed);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  validateFence(fence, identity = null) {
    if (!fence) return false;
    const binding = this.db.prepare(`
      SELECT 1 FROM runtime_bindings
      WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ?
        AND fencing_epoch = ? AND state NOT IN ('OFFLINE','STALE')
    `).get(fence.bindingId, fence.ownerGeneration, fence.fencingToken, fence.fencingEpoch);
    if (!binding) return false;
    if (!identity) return true;
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

  reconcileStale({ now = Date.now(), retryAt = now, processingStartedTtlMs = 300_000 } = {}) {
    const stale = this.db.prepare(`
      SELECT * FROM runtime_bindings
      WHERE state IN ('STARTING','BOUND_IDLE','CLAIMED','WAKING','RUNNING','STOPPING')
        AND (? - last_heartbeat) > lease_ttl_ms
    `).all(now);
    const diagnostics = [];
    for (const binding of stale) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const changed = this.db.prepare(`
          UPDATE runtime_bindings SET state = 'STALE', updated_at = ?
          WHERE binding_id = ? AND runtime_generation = ? AND lease_token = ?
            AND state IN ('STARTING','BOUND_IDLE','CLAIMED','WAKING','RUNNING','STOPPING')
            AND (? - last_heartbeat) > lease_ttl_ms
        `).run(now, binding.binding_id, binding.runtime_generation, binding.lease_token, now);
        if (Number(changed.changes) !== 1) {
          this.db.exec("COMMIT");
          continue;
        }
        const assignments = this.db.prepare(`
          SELECT d.*, p.status AS processing_status, p.started_at AS processing_started_at
          FROM wake_dispatch d
          LEFT JOIN processing_attempts p ON p.attempt_id = (
            SELECT p2.attempt_id FROM processing_attempts p2
            WHERE p2.inbound_message_id = d.msg_id AND p2.recipient_id = d.recipient_id
              AND p2.member_slot = d.member_slot
            ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1
          )
          WHERE d.owner_binding_id = ? AND d.owner_generation = ?
            AND d.fencing_token = ? AND d.state IN ('claimed','dispatched')
        `).all(binding.binding_id, binding.runtime_generation, binding.lease_token);
        for (const dispatch of assignments) {
          if (dispatch.processing_status === "completed") {
            this.db.prepare(`
              UPDATE wake_dispatch
              SET state = 'handed_off', handed_off_at = COALESCE(handed_off_at, ?),
                  claimed_at = NULL, last_error = NULL, updated_at = ?
              WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
                AND owner_binding_id = ? AND owner_generation = ? AND fencing_token = ?
            `).run(
              now, now, dispatch.msg_id, dispatch.recipient_id, dispatch.member_slot,
              binding.binding_id, binding.runtime_generation, binding.lease_token,
            );
            diagnostics.push({ type: "processing-completed", bindingId: binding.binding_id, msgId: dispatch.msg_id });
            continue;
          }
          const freshStarted = dispatch.processing_status === "started"
            && dispatch.processing_started_at != null
            && now - Number(dispatch.processing_started_at) < processingStartedTtlMs;
          if (freshStarted) {
            diagnostics.push({ type: "processing-in-flight", bindingId: binding.binding_id, msgId: dispatch.msg_id });
            continue;
          }
          this.db.prepare(`
            UPDATE wake_dispatch
            SET state = CASE WHEN state = 'claimed' THEN 'deferred'
                             WHEN attempts >= max_attempts THEN 'terminal' ELSE 'failed' END,
                next_attempt_at = ?, claimed_at = NULL,
                last_error = 'runtime-binding-stale', updated_at = ?,
                owner_binding_id = NULL, owner_generation = NULL,
                fencing_token = NULL, fencing_epoch = NULL
            WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
              AND owner_binding_id = ? AND owner_generation = ? AND fencing_token = ?
          `).run(
            retryAt, now, dispatch.msg_id, dispatch.recipient_id, dispatch.member_slot,
            binding.binding_id, binding.runtime_generation, binding.lease_token,
          );
          diagnostics.push({ type: "assignment-retryable", bindingId: binding.binding_id, msgId: dispatch.msg_id });
        }
        this.db.exec("COMMIT");
        diagnostics.push({ type: "binding-stale", bindingId: binding.binding_id });
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    const retained = this.db.prepare(`
      SELECT d.*, b.binding_id, b.runtime_generation, b.lease_token,
             p.status AS processing_status, p.started_at AS processing_started_at
      FROM wake_dispatch d
      JOIN runtime_bindings b ON b.binding_id = d.owner_binding_id
        AND b.runtime_generation = d.owner_generation
        AND b.lease_token = d.fencing_token
      LEFT JOIN processing_attempts p ON p.attempt_id = (
        SELECT p2.attempt_id FROM processing_attempts p2
        WHERE p2.inbound_message_id = d.msg_id AND p2.recipient_id = d.recipient_id
          AND p2.member_slot = d.member_slot
        ORDER BY p2.created_at DESC, p2.rowid DESC LIMIT 1
      )
      WHERE b.state = 'STALE' AND d.state IN ('claimed','dispatched')
    `).all();
    for (const dispatch of retained) {
      if (dispatch.processing_status === "completed") {
        const changed = this.db.prepare(`
          UPDATE wake_dispatch
          SET state = 'handed_off', handed_off_at = COALESCE(handed_off_at, ?),
              claimed_at = NULL, last_error = NULL, updated_at = ?
          WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
            AND owner_binding_id = ? AND owner_generation = ? AND fencing_token = ?
            AND state IN ('claimed','dispatched')
        `).run(now, now, dispatch.msg_id, dispatch.recipient_id, dispatch.member_slot,
          dispatch.binding_id, dispatch.runtime_generation, dispatch.lease_token);
        if (Number(changed.changes) === 1) {
          diagnostics.push({ type: "processing-completed", bindingId: dispatch.binding_id, msgId: dispatch.msg_id });
        }
        continue;
      }
      const freshStarted = dispatch.processing_status === "started"
        && dispatch.processing_started_at != null
        && now - Number(dispatch.processing_started_at) < processingStartedTtlMs;
      if (freshStarted) continue;
      const changed = this.db.prepare(`
        UPDATE wake_dispatch
        SET state = CASE WHEN state = 'claimed' THEN 'deferred'
                         WHEN attempts >= max_attempts THEN 'terminal' ELSE 'failed' END,
            next_attempt_at = ?, claimed_at = NULL,
            last_error = 'runtime-binding-stale', updated_at = ?,
            owner_binding_id = NULL, owner_generation = NULL,
            fencing_token = NULL, fencing_epoch = NULL
        WHERE msg_id = ? AND recipient_id = ? AND member_slot = ?
          AND owner_binding_id = ? AND owner_generation = ? AND fencing_token = ?
          AND state IN ('claimed','dispatched')
      `).run(retryAt, now, dispatch.msg_id, dispatch.recipient_id, dispatch.member_slot,
        dispatch.binding_id, dispatch.runtime_generation, dispatch.lease_token);
      if (Number(changed.changes) === 1) {
        diagnostics.push({ type: "assignment-retryable", bindingId: dispatch.binding_id, msgId: dispatch.msg_id });
      }
    }
    return diagnostics;
  }

  expireRoute({ agentId, projectId, memberSlot, runtimeKind }, now = Date.now()) {
    requiredString(agentId, "agentId");
    requiredString(projectId, "projectId");
    requiredString(memberSlot, "memberSlot");
    requiredString(runtimeKind, "runtimeKind");
    const result = this.db.prepare(`
      UPDATE runtime_bindings
      SET last_heartbeat = ? - lease_ttl_ms - 1, updated_at = ?
      WHERE agent_id = ? AND project_id = ? AND member_slot = ? AND runtime_kind = ?
        AND state IN ('STARTING','BOUND_IDLE','CLAIMED','WAKING','RUNNING','STOPPING')
    `).run(now, now, agentId, projectId, memberSlot, runtimeKind);
    return Number(result.changes);
  }

  get(bindingId) {
    const row = this.db.prepare(`SELECT * FROM runtime_bindings WHERE binding_id = ?`).get(bindingId);
    return row ? this.fromRow(row) : null;
  }

  listActive(filters = {}, now = Date.now()) {
    return this.db.prepare(`
      SELECT * FROM runtime_bindings
      WHERE (? IS NULL OR agent_id = ?) AND (? IS NULL OR project_id = ?)
        AND (? IS NULL OR member_slot = ?) AND state IN (${ACTIVE_STATES.map(() => "?").join(",")})
        AND (? - last_heartbeat) <= lease_ttl_ms
      ORDER BY started_at, binding_id
    `).all(
      filters.agentId ?? null, filters.agentId ?? null,
      filters.projectId ?? null, filters.projectId ?? null,
      filters.memberSlot ?? null, filters.memberSlot ?? null,
      ...ACTIVE_STATES, now,
    ).map((row) => this.fromRow(row));
  }

  fenceFromRow(row) {
    return {
      bindingId: row.binding_id,
      ownerGeneration: Number(row.runtime_generation),
      fencingToken: Number(row.lease_token),
      fencingEpoch: Number(row.fencing_epoch),
    };
  }

  fromRow(row) {
    return {
      bindingId: row.binding_id,
      agentId: row.agent_id,
      runtimeKind: row.runtime_kind,
      runtimeSessionId: row.runtime_session_id ?? null,
      runtimeGeneration: Number(row.runtime_generation),
      pid: row.pid == null ? null : Number(row.pid),
      processStartIdentity: row.process_start_identity ?? null,
      projectId: row.project_id,
      taskId: row.task_id ?? null,
      memberSlot: row.member_slot,
      leaseToken: Number(row.lease_token),
      fencingEpoch: Number(row.fencing_epoch),
      state: row.state,
      leaseTtlMs: Number(row.lease_ttl_ms),
      lastHeartbeat: Number(row.last_heartbeat),
      lastAssignedMessageId: row.last_assigned_message_id ?? null,
      startedAt: Number(row.started_at),
      updatedAt: Number(row.updated_at),
      metadata: row.metadata_json == null ? null : JSON.parse(row.metadata_json),
    };
  }

  close() {
    if (this.ownsDb) this.db.close();
  }
}
