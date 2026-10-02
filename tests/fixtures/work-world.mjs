/**
 * A realistic multi-agent project on disk for the active-work tests: a bootstrapped profile
 * and one REAL agent database per agent at `paths.agentDbFile(name)`, built with the actual
 * stores (`wake_dispatch`, `runtime_bindings`, `agent_handoffs`, `outbox`, `local_messages`),
 * so the operator view is exercised against the real durable schema — never a mock.
 * All message ids are synthetic.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteMessageStore } from "../../packages/core/dist/src/index.js";
import { bootstrapProfile, loadProfile } from "../../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../../scripts/operator/project.mjs";
import { createHandoffDatabase, registerIdleBinding } from "./handoff-fence.mjs";

const noCaps = async () => ({ available: false, modelFlagSupported: false, effortFlagSupported: false, supportedModels: [], supportedEfforts: [] });
const AGENTS = ["root", "claude", "codex", "cursor"];
const SLOT = { root: "root:default", claude: "claude:auto", codex: "codex:app-server", cursor: "cursor:acp" };

export const NOW = Date.parse("2026-10-03T12:00:00.000Z");

export const makeWorld = async () => {
  const dir = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "mur-work-"));
  const raw = path.join(dir, "project");
  mkdirSync(raw, { recursive: true });
  const projectPath = realpathSync(raw);
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  await bootstrapProfile({ projectId, projectPath, paths, discoverCapabilities: noCaps });
  const project = await loadProfile(paths);
  const id = Object.fromEntries(project.agents.map((a) => [a.name, a.agentId]));
  const dbs = {};
  for (const name of AGENTS) {
    if (!id[name]) continue;
    dbs[name] = createHandoffDatabase({ dir: paths.agentDir(name), agentId: id[name] });
  }
  // `local_messages` for the root identity (the real core store creates it).
  const rootMessages = new SQLiteMessageStore(paths.agentDbFile("root"));
  const raw$ = new DatabaseSync(paths.agentDbFile("root"));
  raw$.exec("PRAGMA busy_timeout=5000;");
  let seq = 0;

  const world = {
    dir, projectPath, projectId, paths, project, id, dbs, now: NOW,
    sql(name, statement, ...params) {
      const db = new DatabaseSync(paths.agentDbFile(name));
      try { db.exec("PRAGMA busy_timeout=5000;"); return db.prepare(statement).run(...params); } finally { db.close(); }
    },
    rootTask(msgId, text, { ageMs = 60_000 } = {}) {
      raw$.prepare(`INSERT INTO local_messages (id, conversation_id, msg_id, reply_to_message_id, direction, sender, text, created_at)
        VALUES (?, ?, ?, NULL, 'outbound', ?, ?, ?)`).run(`row-${++seq}`, `dm:${id.root}:${id.claude}`, msgId, id.root, text, new Date(NOW - ageMs).toISOString());
      return msgId;
    },
    finalReply(rootMsgId, text, { ageMs = 1_000 } = {}) {
      raw$.prepare(`INSERT INTO local_messages (id, conversation_id, msg_id, reply_to_message_id, direction, sender, text, created_at)
        VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?)`).run(`row-${++seq}`, `dm:${id.root}:${id.claude}`, `reply-${rootMsgId}`, rootMsgId, id.claude, text, new Date(NOW - ageMs).toISOString());
    },
    binding(name, { state = "RUNNING", heartbeatAgeMs = 1_000, bindingId = `binding-${name}` } = {}) {
      registerIdleBinding(dbs[name].bindingStore, { bindingId, agentId: id[name], memberSlot: SLOT[name], now: NOW - 5_000 });
      world.sql(name, "UPDATE runtime_bindings SET state = ?, last_heartbeat = ? WHERE binding_id = ?", state, NOW - heartbeatAgeMs, bindingId);
      return bindingId;
    },
    dispatch(name, msgId, { state = "pending", ownerBindingId = null, rootId = null, replyTo = null, from = "root", lastError = null, claimedAgeMs = 30_000, updatedAgeMs = 5_000 } = {}) {
      dbs[name].dispatchStore.enqueue({
        from: id[from] ?? from, text: "x", msgId, conversationId: `conv-${msgId}`, memberSlot: SLOT[name],
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(rootId ? { handoff: { rootMessageId: rootId, rootConversationId: "rc", causedByMessageId: rootId, ancestry: [id.claude] } } : {}),
      }, NOW - 40_000);
      world.sql(name, `UPDATE wake_dispatch SET state = ?, owner_binding_id = ?, claimed_at = ?, updated_at = ?, last_error = ? WHERE msg_id = ?`,
        state, ownerBindingId, ["claimed", "dispatched"].includes(state) ? NOW - claimedAgeMs : null, NOW - updatedAgeMs, lastError, msgId);
    },
    handoff(delegator, recipient, rootId, handoffId, { state = "open", task = "review the change", terminalReason = null, ageMs = 30_000 } = {}) {
      dbs[delegator].handoffStore.createOrReuse({
        handoffMsgId: handoffId, delegatorId: id[delegator], recipientId: id[recipient], causedByMessageId: `cause-${handoffId}`,
        rootMessageId: rootId, rootConversationId: "rc", handoffConversationId: `handoff:${handoffId}`,
        parentActiveAncestry: [], handoffAncestry: [id[delegator]],
        originatingBindingId: "binding-x", originatingBindingGeneration: 1, originatingRuntimeKind: "claude_one_shot",
        originatingMemberSlot: SLOT[delegator], parentMessageId: rootId, parentConversationId: "rc", parentSenderId: id.root, taskText: task,
      }, NOW - ageMs);
      if (state !== "open") world.sql(delegator, "UPDATE agent_handoffs SET state = ?, terminal_reason = ?, closed_at = ? WHERE handoff_msg_id = ?", state, terminalReason, NOW - 1_000, handoffId);
    },
    cleanup() {
      try { raw$.close(); rootMessages.close?.(); } catch { /* already closed */ }
      for (const db of Object.values(dbs)) { try { db.close(); } catch { /* already closed */ } }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
};
