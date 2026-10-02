/**
 * operator-work.test.mjs — the active-work view (`murmur tasks` / `task`) and safe
 * per-workflow cancellation (`murmur cancel`), against real agent databases.
 * Message ids are synthetic.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildWorkSnapshot, collectWorkRecords, commandWork, detailFor, redactedPreview } from "../scripts/operator/work.mjs";
import { makeWorld, NOW } from "./fixtures/work-world.mjs";

const worlds = [];
test.afterEach(() => { while (worlds.length) worlds.pop().cleanup(); });
const world = async () => { const w = await makeWorld(); worlds.push(w); return w; };

const snapshot = (w) => buildWorkSnapshot(collectWorkRecords({ project: w.project, paths: w.paths, now: NOW }), { projectName: "p", now: NOW });
const find = (w, id) => [...snapshot(w).tasks, ...snapshot(w).recent].find((t) => t.workflowId === id);

const ROOT_A = "root-task-aaaa-0001";
const ROOT_B = "root-task-bbbb-0002";

const cli = async (w, command, args, flags = { json: true }) => {
  const out = []; const err = [];
  const code = await commandWork({ command, args: [w.projectPath, ...args], flags, out: (l) => out.push(l), err: (l) => err.push(l), home: w.paths.home, now: NOW });
  return { code, out, err, json: flags.json && out.length ? JSON.parse(out.join("\n")) : null };
};

// ---------------------------------------------------------------------------
// Root workflow identity + states
// ---------------------------------------------------------------------------

test("a Root → Claude → Codex → Cursor chain is ONE task: count 1, chain of 3, current agent is the one executing", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "Исправить provisioning");
  w.binding("cursor");
  w.dispatch("claude", ROOT_A, { state: "handed_off" });
  w.handoff("claude", "codex", ROOT_A, "h-claude-codex", { state: "closed", task: "implement" });
  w.handoff("codex", "cursor", ROOT_A, "h-codex-cursor", { task: "Проверка UI" });
  w.dispatch("cursor", "h-codex-cursor", { state: "claimed", ownerBindingId: "binding-cursor", rootId: ROOT_A, from: "codex" });
  const snap = snapshot(w);
  assert.equal(snap.summary.active, 1, "one operator task, not one per hop");
  assert.equal(snap.tasks.length, 1);
  const task = snap.tasks[0];
  assert.equal(task.workflowId, ROOT_A);
  assert.equal(task.status, "running");
  assert.equal(task.currentAgent, "cursor", "Claude owns the root continuation but is not the one working");
  assert.equal(task.currentStage, "Проверка UI");
  assert.deepEqual(task.chain.map((c) => `${c.from}>${c.to}`), ["root>claude", "claude>codex", "codex>cursor"]);
  assert.equal(task.elapsedMs, 60_000);
  assert.ok(task.cancellable);
});

test("a parent waiting for a child reports the CHILD as current agent; Claude is not shown as active", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "task");
  w.binding("codex");
  w.dispatch("claude", ROOT_A, { state: "handed_off" });
  w.handoff("claude", "codex", ROOT_A, "h1", { task: "Review the diff" });
  w.dispatch("codex", "h1", { state: "claimed", ownerBindingId: "binding-codex", rootId: ROOT_A, from: "claude" });
  const task = snapshot(w).tasks[0];
  assert.equal(task.status, "running");
  assert.equal(task.currentAgent, "codex");
  assert.equal(task.currentStage, "Review the diff");
});

test("states: queued, running, waiting, completed, failed — and an old claimed row with a dead runtime is NOT running", async () => {
  const w = await world();
  // queued: accepted, no dispatch at all yet
  w.rootTask("task-queued-0001", "q", { ageMs: 12_000 });
  assert.equal(find(w, "task-queued-0001").status, "queued");
  assert.equal(find(w, "task-queued-0001").currentStage, "В очереди");
  // queued: a pending root dispatch nothing owns
  w.rootTask("task-queued-0002", "q2");
  w.dispatch("claude", "task-queued-0002", { state: "pending" });
  assert.equal(find(w, "task-queued-0002").status, "queued");
  // running: executing with a LIVE binding
  w.rootTask("task-running-001", "r");
  w.binding("claude");
  w.dispatch("claude", "task-running-001", { state: "claimed", ownerBindingId: "binding-claude" });
  assert.equal(find(w, "task-running-001").status, "running");
  // waiting: an open handoff, nothing executing
  w.rootTask("task-waiting-001", "w");
  w.dispatch("claude", "task-waiting-001", { state: "handed_off" });
  w.handoff("claude", "codex", "task-waiting-001", "h-wait");
  const waiting = find(w, "task-waiting-001");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.currentAgent, "codex");
  assert.equal(waiting.currentStage, "Ожидание ответа codex");
  // stalled: claimed but the runtime's heartbeat is long gone
  w.rootTask("task-stalled-001", "s");
  w.binding("cursor", { heartbeatAgeMs: 10 * 60_000, bindingId: "binding-dead" });
  w.dispatch("claude", "task-stalled-001", { state: "claimed", ownerBindingId: "binding-dead" });
  const stalled = find(w, "task-stalled-001");
  assert.notEqual(stalled.status, "running", "an old DB row is not proof of execution");
  assert.equal(stalled.status, "waiting");
  assert.equal(stalled.stalled, true);
  // completed: the correlated final reply exists
  w.rootTask("task-done-00001", "d");
  w.finalReply("task-done-00001", "ГОТОВО");
  const done = find(w, "task-done-00001");
  assert.equal(done.status, "completed");
  assert.equal(done.currentAgent, null);
  assert.equal(snapshot(w).summary.queued, 2);
  // failed: the root dispatch terminated without a reply
  w.rootTask("task-failed-0001", "f");
  w.dispatch("claude", "task-failed-0001", { state: "terminal", lastError: "model exploded" });
  assert.equal(find(w, "task-failed-0001").status, "failed");
});

test("sibling handoffs stay in the same workflow; a terminal child with nothing else outstanding is failed", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "task");
  w.dispatch("claude", ROOT_A, { state: "handed_off" });
  w.handoff("claude", "codex", ROOT_A, "h-sib-1", { state: "closed" });
  w.handoff("claude", "cursor", ROOT_A, "h-sib-2", { state: "closed" });
  w.dbs.claude.handoffStore.db.exec("UPDATE agent_handoffs SET caused_by_message_id = 'cause-two' WHERE handoff_msg_id = 'h-sib-2'");
  assert.equal(snapshot(w).tasks.length + snapshot(w).recent.length, 1);
  assert.equal(find(w, ROOT_A).chain.length, 3);
  w.handoff("claude", "codex", ROOT_A, "h-dead", { state: "terminal", terminalReason: "handoff-recipient-down" });
  w.dbs.claude.handoffStore.db.exec("UPDATE agent_handoffs SET caused_by_message_id = 'cause-three' WHERE handoff_msg_id = 'h-dead'");
});

test("task A and task B are isolated: each has its own status, agent and chain", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "A", { ageMs: 90_000 });
  w.rootTask(ROOT_B, "B", { ageMs: 30_000 });
  w.binding("codex"); w.binding("claude");
  w.dispatch("claude", ROOT_A, { state: "handed_off" });
  w.handoff("claude", "codex", ROOT_A, "h-a");
  w.dispatch("codex", "h-a", { state: "claimed", ownerBindingId: "binding-codex", rootId: ROOT_A, from: "claude" });
  w.dispatch("claude", ROOT_B, { state: "claimed", ownerBindingId: "binding-claude" });
  const a = find(w, ROOT_A); const b = find(w, ROOT_B);
  assert.deepEqual([a.currentAgent, b.currentAgent], ["codex", "claude"]);
  assert.equal(a.chain.length, 2);
  assert.equal(b.chain.length, 1);
  assert.equal(snapshot(w).summary.active, 2);
  assert.equal(snapshot(w).tasks[0].workflowId, ROOT_A, "oldest first");
});

test("the view is reconstructed from durable state alone: a fresh read after 'restart' is identical", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "task");
  w.binding("claude");
  w.dispatch("claude", ROOT_A, { state: "claimed", ownerBindingId: "binding-claude" });
  const first = snapshot(w);
  const second = snapshot(w);
  assert.deepEqual(second, first);
  assert.equal(second.tasks[0].status, "running");
});

test("request previews are bounded and redacted; the detail view carries the bounded request and the final result", async () => {
  const w = await world();
  const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
  w.rootTask(ROOT_A, `Deploy with api_key=hunter22222 and ${secret} ${"x".repeat(500)}`);
  w.finalReply(ROOT_A, `Готово. Authorization: Bearer abcdefghijklmnop12345`);
  const task = find(w, ROOT_A);
  assert.ok(task.requestSummary.length <= 160);
  assert.doesNotMatch(JSON.stringify(task), /hunter22222|sk-ABCDEF|abcdefghijklmnop12345/);
  const detail = detailFor(collectWorkRecords({ project: w.project, paths: w.paths, now: NOW }), ROOT_A, NOW);
  assert.match(detail.result, /Готово/);
  assert.doesNotMatch(JSON.stringify(detail), /hunter22222|sk-ABCDEF|abcdefghijklmnop12345/);
  assert.equal(redactedPreview("a\n\n  b   c"), "a b c");
});

test("the JSON never carries credentials, raw prompts, db internals or agent keys", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "plain task");
  w.dispatch("claude", ROOT_A, { state: "pending" });
  const text = JSON.stringify(snapshot(w));
  assert.doesNotMatch(text, /privateKey|natsToken|botToken|payload_json|ownerBindingId|fencing/i);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("cancel a QUEUED root task: intent recorded, the pending dispatch is retired, status is cancelled", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "queued task");
  w.dispatch("claude", ROOT_A, { state: "pending" });
  const { code, json } = await cli(w, "cancel", [ROOT_A]);
  assert.equal(code, 0);
  assert.equal(json.ok, true);
  assert.equal(json.status, "cancelled");
  assert.equal(json.systemResult, "Задача отменена пользователем.");
  const row = new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT state, last_error FROM wake_dispatch WHERE msg_id = ?").get(ROOT_A);
  assert.deepEqual({ ...row }, { state: "rejected", last_error: "ignored_due_to_cancelled_workflow" }, "history retained, with a stable disposition");
});

test("cancel while Claude is RUNNING: cancel_requested (distinct from cancelled) until the turn stops", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "running task");
  w.binding("claude");
  w.dispatch("claude", ROOT_A, { state: "claimed", ownerBindingId: "binding-claude" });
  const { json } = await cli(w, "cancel", [ROOT_A]);
  assert.equal(json.status, "cancel_requested");
  assert.equal(find(w, ROOT_A).status, "cancel_requested");
  assert.equal(find(w, ROOT_A).cancellable, false);
  // the runtime stops the turn (its catch path retires the dispatch as terminal)
  w.sql("claude", "UPDATE wake_dispatch SET state = 'terminal', owner_binding_id = NULL, last_error = 'ignored_due_to_cancelled_workflow' WHERE msg_id = ?", ROOT_A);
  assert.equal(find(w, ROOT_A).status, "cancelled");
});

test("cancel while Claude WAITS for Codex, and while Codex waits for Cursor: queued child work is retired, nothing new can begin", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "chain");
  w.dispatch("claude", ROOT_A, { state: "handed_off" });
  w.handoff("claude", "codex", ROOT_A, "h-claude-codex", { state: "closed" });
  w.handoff("codex", "cursor", ROOT_A, "h-codex-cursor");
  w.dbs.codex.handoffStore.db.exec("UPDATE agent_handoffs SET caused_by_message_id = 'c2' WHERE handoff_msg_id = 'h-codex-cursor'");
  w.dispatch("cursor", "h-codex-cursor", { state: "pending", rootId: ROOT_A, from: "codex" });
  assert.equal(find(w, ROOT_A).status, "waiting");
  const { json } = await cli(w, "cancel", [ROOT_A]);
  assert.equal(json.status, "cancelled");
  assert.equal(json.retiredQueuedDispatches >= 1, true);
  const cursorRow = new DatabaseSync(w.paths.agentDbFile("cursor")).prepare("SELECT state, last_error FROM wake_dispatch WHERE msg_id = 'h-codex-cursor'").get();
  assert.equal(cursorRow.state, "rejected");
  const openAfter = new DatabaseSync(w.paths.agentDbFile("codex")).prepare("SELECT state, terminal_reason FROM agent_handoffs WHERE handoff_msg_id = 'h-codex-cursor'").get();
  assert.deepEqual({ ...openAfter }, { state: "terminal", terminal_reason: "workflow-cancelled" }, "the waiting continuation is closed, not left open forever, and its row is kept");
  // the intent is in EVERY agent's database, so every gate sees it
  for (const name of ["root", "claude", "codex", "cursor"]) {
    const n = new DatabaseSync(w.paths.agentDbFile(name)).prepare("SELECT COUNT(*) AS n FROM workflow_control WHERE root_message_id = ?").get(ROOT_A).n;
    assert.equal(Number(n), 1, name);
  }
});

test("double cancel is idempotent and does not rewrite the original request time", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "task");
  w.dispatch("claude", ROOT_A, { state: "pending" });
  const first = await cli(w, "cancel", [ROOT_A]);
  const at1 = new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT requested_at AS t FROM workflow_control").get().t;
  const second = await cli(w, "cancel", [ROOT_A]);
  assert.equal(first.json.alreadyRequested, false);
  assert.equal(second.code, 0);
  assert.equal(second.json.alreadyRequested, true);
  assert.equal(second.json.status, "cancelled");
  const at2 = new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT requested_at AS t FROM workflow_control").get().t;
  assert.equal(at2, at1);
});

test("cancelling a completed or failed task refuses with already-terminal; unknown and malformed ids refuse", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "done"); w.finalReply(ROOT_A, "ok");
  const done = await cli(w, "cancel", [ROOT_A]);
  assert.equal(done.code, 4);
  assert.equal(done.json.reason, "already-terminal");
  assert.equal(new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT COUNT(*) AS n FROM workflow_control").get().n, 0, "nothing was recorded");
  const unknown = await cli(w, "cancel", ["no-such-task-0001"]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.json.reason, "unknown-workflow");
  for (const bad of ["x", "../../etc/passwd", "id; rm -rf /", "a".repeat(200), "id with space"]) {
    const refused = await cli(w, "cancel", [bad]);
    assert.equal(refused.code, 1, bad);
    assert.equal(refused.json.reason, "workflow-id-invalid");
  }
});

test("cancelling task A does not touch task B (state, dispatch or intent)", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "A"); w.rootTask(ROOT_B, "B");
  w.dispatch("claude", ROOT_A, { state: "pending" });
  w.dispatch("claude", ROOT_B, { state: "pending" });
  await cli(w, "cancel", [ROOT_A]);
  assert.equal(find(w, ROOT_A).status, "cancelled");
  assert.equal(find(w, ROOT_B).status, "queued");
  const b = new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT state FROM wake_dispatch WHERE msg_id = ?").get(ROOT_B);
  assert.equal(b.state, "pending");
  assert.equal(new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT COUNT(*) AS n FROM workflow_control WHERE root_message_id = ?").get(ROOT_B).n, 0);
});

test("cancellation is scoped to one project: another project's databases are never written", async () => {
  const a = await world(); const b = await world();
  a.rootTask(ROOT_A, "A"); a.dispatch("claude", ROOT_A, { state: "pending" });
  b.rootTask(ROOT_A, "same id elsewhere"); b.dispatch("claude", ROOT_A, { state: "pending" });
  await cli(a, "cancel", [ROOT_A]);
  assert.equal(find(b, ROOT_A).status, "queued");
  assert.equal(new DatabaseSync(b.paths.agentDbFile("claude")).prepare("SELECT COUNT(*) AS n FROM workflow_control").get().n, 0);
});

test("cancel needs no daemon and kills no process: it only writes the intent rows", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "A"); w.dispatch("claude", ROOT_A, { state: "pending" });
  const killed = [];
  const original = process.kill;
  process.kill = (...args) => { killed.push(args); return true; };
  try { await cli(w, "cancel", [ROOT_A]); } finally { process.kill = original; }
  assert.deepEqual(killed, [], "no signal is sent by the cancel command");
});

test("`tasks` and `task` read-only commands render, and an unknown task is refused", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "Проверить интеграцию"); w.binding("claude"); w.dispatch("claude", ROOT_A, { state: "claimed", ownerBindingId: "binding-claude" });
  const human = await cli(w, "tasks", [], { json: false });
  assert.equal(human.code, 0);
  assert.match(human.out.join("\n"), /Active: 1/);
  const detail = await cli(w, "task", [ROOT_A]);
  assert.equal(detail.json.task.request, "Проверить интеграцию");
  assert.equal(detail.json.task.status, "running");
  assert.equal((await cli(w, "task", ["no-such-task-0001"])).code, 2);
  assert.equal(existsSync(w.paths.agentDbFile("claude")), true);
});

test("a cancel is NOT reported ok when it could not be recorded in every agent database (partial write)", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "task"); w.dispatch("claude", ROOT_A, { state: "pending" });
  // make one agent's database unusable: a directory where the file should be
  w.dbs.cursor.close();
  const { rmSync, mkdirSync } = await import("node:fs");
  rmSync(w.paths.agentDbFile("cursor")); rmSync(`${w.paths.agentDbFile("cursor")}-wal`, { force: true }); rmSync(`${w.paths.agentDbFile("cursor")}-shm`, { force: true });
  mkdirSync(w.paths.agentDbFile("cursor"));
  const { code, json } = await cli(w, "cancel", [ROOT_A]);
  assert.equal(code, 1);
  assert.equal(json.ok, false);
  assert.equal(json.reason, "cancel-partially-recorded");
  assert.ok(json.detail.some((d) => d.startsWith("cursor:")));
  // the intent that WAS written is idempotent, so a retry once the database is back completes it
  assert.equal(new DatabaseSync(w.paths.agentDbFile("claude")).prepare("SELECT COUNT(*) AS n FROM workflow_control").get().n, 1);
});

test("a final reply that arrives AFTER the cancel is a late delivery: the task stays cancelled (monotonic); one before it is a completion", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "A"); w.rootTask(ROOT_B, "B");
  for (const name of ["root", "claude"]) {
    const db = new DatabaseSync(w.paths.agentDbFile(name));
    const { recordCancelRequest } = await import("../scripts/workflow-control.mjs");
    recordCancelRequest(db, ROOT_A, { now: NOW }); recordCancelRequest(db, ROOT_B, { now: NOW });
    db.close();
  }
  w.finalReply(ROOT_A, "late result", { ageMs: -5_000 });  // 5 s AFTER the cancel
  w.finalReply(ROOT_B, "early result", { ageMs: 5_000 });  // 5 s BEFORE the cancel
  assert.equal(find(w, ROOT_A).status, "cancelled", "the late reply must not resurrect the task");
  assert.equal(find(w, ROOT_B).status, "completed");
  const root = new DatabaseSync(w.paths.agentDbFile("root"));
  assert.equal(root.prepare("SELECT COUNT(*) AS n FROM local_messages WHERE reply_to_message_id = ?").get(ROOT_A).n, 1, "the late reply stays in history");
});

test("a claimed dispatch whose runtime is no longer live cannot keep a cancelled task in 'cancel requested' forever", async () => {
  const w = await world();
  w.rootTask(ROOT_A, "A");
  w.binding("claude", { heartbeatAgeMs: 10 * 60_000 });
  w.dispatch("claude", ROOT_A, { state: "claimed", ownerBindingId: "binding-claude" });
  const db = new DatabaseSync(w.paths.agentDbFile("claude"));
  const { recordCancelRequest } = await import("../scripts/workflow-control.mjs");
  recordCancelRequest(db, ROOT_A, { now: NOW }); db.close();
  assert.equal(find(w, ROOT_A).status, "cancelled", "nothing is executing it, so it is cancelled, not 'requested'");
});

test("a waiting `murmur send` treats a reply that arrived after the cancel as cancelled, one before it as the answer", async () => {
  const { waitForCorrelatedReply } = await import("../scripts/operator/send.mjs");
  const w = await world();
  w.rootTask(ROOT_A, "A"); w.finalReply(ROOT_A, "late", { ageMs: -5_000 });
  const correlation = { msgId: ROOT_A, expectedSender: w.id.claude, conversationId: `dm:${w.id.root}:${w.id.claude}` };
  const late = await waitForCorrelatedReply(w.paths.agentDbFile("root"), correlation, { timeoutMs: 500, pollMs: 10, cancelCheck: () => NOW });
  assert.deepEqual(late, { cancelled: true });
  const early = await waitForCorrelatedReply(w.paths.agentDbFile("root"), correlation, { timeoutMs: 500, pollMs: 10, cancelCheck: () => NOW + 60_000 });
  assert.equal(early.cancelled, undefined);
  const none = await waitForCorrelatedReply(w.paths.agentDbFile("root"), { ...correlation, msgId: "no-such-root-0001" }, { timeoutMs: 200, pollMs: 10, cancelCheck: () => NOW });
  assert.deepEqual(none, { cancelled: true }, "cancelled with no reply at all");
});
