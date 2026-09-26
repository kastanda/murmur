/**
 * A genuine fenced runtime context for handoff tests.
 *
 * Every table the fenced primitives touch (`runtime_bindings`, `wake_dispatch`,
 * `agent_handoffs`, `outbox`) lives in ONE real SQLite file, and the fence is a real one
 * obtained from `RuntimeBindingStore.assignDispatch` — not a mock. That is the point:
 * fencing must be proved against the actual durable authority boundary.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLiteDedupeOutboxStore } from "../../packages/core/dist/src/index.js";
import { AgentHandoffStore } from "../../scripts/agent-handoff-store.mjs";
import { RuntimeBindingStore } from "../../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../../scripts/wake-dispatch-store.mjs";

/** Create the shared database with every table the fenced path needs. */
export const createHandoffDatabase = ({ dir, agentId = "claude-agent" } = {}) => {
  const baseDir = dir ?? mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-fence-"));
  const dbPath = path.join(baseDir, "murmur.db");
  // Order matters only in that every table must exist before a fenced mutation runs.
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: agentId, maxAttempts: 3 });
  const outboxStore = new SQLiteDedupeOutboxStore(dbPath);
  const bindingStore = new RuntimeBindingStore(dbPath);
  const handoffStore = new AgentHandoffStore(dbPath);
  return {
    dir: baseDir,
    dbPath,
    dispatchStore,
    outboxStore,
    bindingStore,
    handoffStore,
    close() {
      handoffStore.close();
      bindingStore.close();
      dispatchStore.close();
      try { outboxStore.db?.close?.(); } catch { /* already closed */ }
    },
  };
};

/** Register an idle binding and return it. */
export const registerIdleBinding = (bindingStore, {
  bindingId = "binding-a", agentId = "claude-agent", projectId = "project-a",
  memberSlot = "claude:auto", runtimeKind = "claude_one_shot", runtimeGeneration = 1,
  leaseTtlMs = 60_000, now = Date.now(),
} = {}) => {
  const binding = bindingStore.register({
    bindingId, agentId, runtimeKind, runtimeGeneration, projectId, memberSlot,
    leaseTtlMs, state: "STARTING",
  }, now);
  const fence = {
    bindingId,
    ownerGeneration: binding.runtimeGeneration,
    fencingToken: binding.leaseToken,
    fencingEpoch: binding.fencingEpoch,
  };
  if (bindingStore.markIdle(fence, now) !== 1) throw new Error("fixture-binding-idle-failed");
  return bindingStore.get(bindingId);
};

/**
 * Claim a dispatch and assign it to the idle binding, yielding a REAL fence + identity
 * pair exactly as a runtime would hold them.
 */
export const claimFencedDispatch = (ctx, {
  msgId = "root-1", conversationId = "conv-root", text = "root request",
  from = "human-agent", agentId = "claude-agent", memberSlot = "claude:auto",
  projectId = "project-a", now = Date.now(),
} = {}) => {
  const payload = { from, text, msgId, conversationId, memberSlot };
  ctx.dispatchStore.enqueue(payload, now);
  const dispatch = ctx.dispatchStore.claimDue(now);
  if (!dispatch) throw new Error("fixture-dispatch-claim-failed");
  const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
  const fence = ctx.bindingStore.assignDispatch(identity, { agentId, projectId, memberSlot }, now);
  if (!fence) throw new Error("fixture-fence-assign-failed");
  return { payload, dispatch, identity, fence };
};

/**
 * Advance the binding to a NEW generation, exactly as a replacement runtime would: the
 * old row becomes STALE and a fresh generation takes over the route.
 */
export const replaceBindingGeneration = (bindingStore, bindingId, {
  replacementId = `${bindingId}-next`, now = Date.now(),
} = {}) => {
  const next = bindingStore.replace(bindingId, { bindingId: replacementId, state: "STARTING" }, now);
  const fence = {
    bindingId: replacementId,
    ownerGeneration: next.runtimeGeneration,
    fencingToken: next.leaseToken,
    fencingEpoch: next.fencingEpoch,
  };
  bindingStore.markIdle(fence, now);
  return bindingStore.get(replacementId);
};

/** Committed outbox rows, newest last — the durable "was it actually sent" answer. */
export const enqueuedEnvelopes = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT msg_id, subject, envelope_json FROM outbox ORDER BY rowid").all()
      .map((row) => ({ msgId: row.msg_id, subject: row.subject, envelope: JSON.parse(row.envelope_json) }));
  } finally {
    db.close();
  }
};

export const cleanup = (ctx) => {
  ctx.close();
  rmSync(ctx.dir, { recursive: true, force: true });
};
