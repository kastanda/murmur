/**
 * runtime-output.test.mjs — empty / error / tool-intent output classification, the Claude CLI
 * "exit 0 but no answer" cases, intermediate-intent finalization, and the review gate.
 * Message ids and outputs are synthetic.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { derivedHandoffConversationId, SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";
import { AgentHandoffController } from "../scripts/agent-handoff-controller.mjs";
import { AgentHandoffStore } from "../scripts/agent-handoff-store.mjs";
import { HandoffTurnCoordinator } from "../scripts/agent-handoff-runtime.mjs";
import { CLAUDE_AUTO_MEMBER_SLOT, ClaudeOneShotRuntime, runClaudeOneShot } from "../scripts/claude-one-shot-runtime.mjs";
import { OUTPUT_KINDS, classifyRuntimeOutput, isSubstantiveResult, safeDiagnostics, satisfiesReviewGate } from "../scripts/runtime-output.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { enqueuedEnvelopes } from "./fixtures/handoff-fence.mjs";

const FRAME = JSON.stringify({ murmur: { action: "handoff", to: "codex-agent", task: "review this change" } });

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("classification: text, handoff, tool-intent-only, empty, error", () => {
  const kind = (output) => classifyRuntimeOutput(output).kind;
  assert.equal(kind({ text: "A substantive analysis of the diff." }), OUTPUT_KINDS.text);
  assert.equal(kind({ text: FRAME }), OUTPUT_KINDS.handoff);
  assert.equal(kind({ text: `  \n${FRAME}\n` }), OUTPUT_KINDS.handoff);
  for (const empty of ["", "   ", "\n\t\n", null, undefined, 42]) assert.equal(kind({ text: empty }), OUTPUT_KINDS.empty, String(empty));
  assert.equal(kind({ text: "```json\n" + FRAME + "\n```" }), OUTPUT_KINDS.toolIntentOnly, "a FENCED delegation frame is an intent, not a result");
  assert.equal(kind({ text: "```\n" + FRAME + "\n```" }), OUTPUT_KINDS.toolIntentOnly);
  assert.equal(kind({ text: "Let me check that.", stopReason: "tool_use" }), OUTPUT_KINDS.toolIntentOnly, "the runtime stopped on a tool call");
  assert.equal(kind({ text: "<function_calls><invoke name=\"Read\"></invoke></function_calls>" }), OUTPUT_KINDS.toolIntentOnly);
  assert.equal(kind({ text: "There's an issue with the selected model", isError: true }), OUTPUT_KINDS.error);
  assert.equal(kind({ text: "", isError: true }), OUTPUT_KINDS.error);
  // prose that merely MENTIONS the protocol is ordinary text (no prose scanning)
  assert.equal(kind({ text: `To delegate, reply with ${FRAME} as your whole answer.` }), OUTPUT_KINDS.text);
});

test("only substantive text is a result", () => {
  assert.equal(isSubstantiveResult({ text: "SAFE — no blockers found." }), true);
  for (const bad of [{ text: "" }, { text: FRAME }, { text: "```json\n" + FRAME + "\n```" }, { text: "x", stopReason: "tool_use" }, { text: "x", isError: true }]) {
    assert.equal(isSubstantiveResult(bad), false, JSON.stringify(bad));
  }
});

test("diagnostics are bounded and redacted", () => {
  const d = safeDiagnostics({ exit: 0, stderr: `warn api_key=hunter22222 ${"x".repeat(500)}`, nothing: null });
  assert.ok(d.stderr.length <= 200);
  assert.doesNotMatch(JSON.stringify(d), /hunter22222/);
  assert.equal("nothing" in d, false);
});

// ---------------------------------------------------------------------------
// The REVIEW GATE
// ---------------------------------------------------------------------------

test("REVIEW GATE: only a waited, correlated, substantive reply satisfies it", () => {
  const ok = { ok: true, waited: true, text: "BLOCKED: the retry budget is not enforced (file.mjs:10)." };
  assert.equal(satisfiesReviewGate(ok), true);
  const rejected = [
    ["transport/ACK-only success (queued, not waited)", { ok: true, waited: false, msgId: "m" }],
    ["empty correlated reply", { ok: true, waited: true, text: "" }],
    ["whitespace reply", { ok: true, waited: true, text: " \n " }],
    ["tool-intent-only reply", { ok: true, waited: true, text: FRAME }],
    ["fenced intent reply", { ok: true, waited: true, text: "```json\n" + FRAME + "\n```" }],
    ["timeout", { ok: false, reason: "timeout" }],
    ["cancelled", { ok: false, reason: "cancelled" }],
    ["non-substantive reply refused by the CLI", { ok: false, reason: "non-substantive-reply", kind: "empty" }],
    ["notification success shape", { ok: true, waited: true }],
    ["missing", null],
  ];
  for (const [name, result] of rejected) assert.equal(satisfiesReviewGate(result), false, name);
});

// ---------------------------------------------------------------------------
// Claude CLI: exit 0 is not an answer (a fake `claude` binary)
// ---------------------------------------------------------------------------

const fakeClaude = (json, { stderr = "", code = 0 } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-fake-claude-"));
  const file = path.join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n${stderr ? `echo ${JSON.stringify(stderr)} >&2\n` : ""}cat <<'JSON'\n${JSON.stringify(json)}\nJSON\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return { command: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const base = { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", terminal_reason: "completed", session_id: "11111111-2222-3333-4444-555555555555", num_turns: 1, duration_ms: 1234 };
const runWith = async (json, opts) => {
  const f = fakeClaude(json, opts);
  try {
    return await runClaudeOneShot({ prompt: "p", sessionId: base.session_id, cwd: os.tmpdir(), command: f.command, onSpawn: () => {} });
  } finally { f.cleanup(); }
};

test("Claude CLI: a substantive result passes", async () => {
  const result = await runWith({ ...base, result: "The diff is safe." });
  assert.equal(result.text, "The diff is safe.");
});

test("Claude CLI: exit 0 with an EMPTY result is an explicit empty-output failure carrying safe diagnostics", async () => {
  for (const empty of ["", "  \n "]) {
    await assert.rejects(runWith({ ...base, result: empty }, { stderr: "note token=sk-AAAAAAAAAAAAAAAAAAAAAAAA" }), (error) => {
      assert.equal(error.name, "RuntimeOutputError");
      assert.equal(error.kind, "empty");
      assert.match(error.message, /^claude-one-shot-empty-output:/);
      assert.deepEqual([error.diagnostics.exit, error.diagnostics.subtype, error.diagnostics.stop, error.diagnostics.turns, error.diagnostics.ms], [0, "success", "end_turn", 1, 1234]);
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /sk-AAAA/, "no secret in the failure reason");
      return true;
    });
  }
});

test("Claude CLI: is_error with exit 0 (e.g. an unknown model) is a runtime error, NOT a result", async () => {
  await assert.rejects(
    runWith({ ...base, is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", api_error_status: 404, result: "There's an issue with the selected model (x)." }),
    (error) => error.kind === "error" && /^claude-one-shot-runtime-reported-error:/.test(error.message) && error.diagnostics.api === 404,
  );
});

test("Claude CLI: stopping on tool use is tool-intent-only, never a final answer", async () => {
  await assert.rejects(
    runWith({ ...base, stop_reason: "tool_use", result: "I will look at the file first." }),
    (error) => error.kind === "tool-intent-only" && /^claude-one-shot-tool-intent-only:/.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// Runtime level: no root final for a non-substantive or intermediate output
// ---------------------------------------------------------------------------

const AGENT = "claude-agent";
const TARGET = "codex-agent";
const ROOT = "root-message-0001";
const peer = (id) => ({ encryption: { publicKey: `e-${id}` }, signing: { publicKey: `s-${id}` }, subject: `msg.${id}`, protocolVersions: ["1.0", "1.1"], features: ["handoff-v1"] });
const contexts = [];
test.afterEach(async () => { while (contexts.length) { const c = contexts.pop(); await c.teardown(); rmSync(c.dir, { recursive: true, force: true }); } });

const harness = ({ script = [] } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-output-"));
  const db = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(db, { recipientId: AGENT, maxAttempts: 2 });
  const outbox = new SQLiteDedupeOutboxStore(db);
  const bindingStore = new RuntimeBindingStore(db);
  const handoffStore = new AgentHandoffStore(db);
  let n = 0;
  const controller = new AgentHandoffController({
    store: handoffStore, agentId: AGENT, peers: { [TARGET]: peer(TARGET) },
    buildHandoffEnvelope: async ({ msgId, to, subject, conversationId, handoff, text }) => ({
      subject, envelope: { schemaVersion: "1.1", msgId, conversationId, senderAgentId: AGENT, recipients: [to], createdAt: "2026-09-26T00:00:00.000Z", payloadCiphertext: Buffer.from(text).toString("base64"), payloadNonce: "n", handoff, signature: "s" },
    }),
    newMsgId: () => `handoff-msg-${++n}`,
  });
  const replies = [];
  const queue = [...script];
  const runtime = new ClaudeOneShotRuntime({
    bindingStore, dispatchStore, agentId: AGENT, projectId: "p", cwd: dir, retryDelayMs: 0, heartbeatIntervalMs: 10,
    runner: async ({ sessionId, onSpawn }) => { onSpawn({ pid: 1, processStartIdentity: "1:1" }); return { text: queue.shift() ?? "", sessionId }; },
    sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; },
    handoff: new HandoffTurnCoordinator({ controller }),
  });
  runtime.start({ bindingId: "b", runtimeGeneration: 1, leaseTtlMs: 5_000 });
  const ctx = {
    dir, db, dispatchStore, handoffStore, runtime, replies, bindingStore,
    run: async (payload) => { dispatchStore.enqueue(payload); const dispatch = dispatchStore.claimDue(Date.now() + 60_000); return runtime.executeTurn(payload, dispatch); },
    teardown: async () => { runtime.shutdown(); handoffStore.close(); bindingStore.close(); dispatchStore.close(); },
  };
  contexts.push(ctx);
  return ctx;
};
const rootPayload = (extra = {}) => ({ msgId: ROOT, from: "human-agent", conversationId: "conv-root", text: "please review", memberSlot: CLAUDE_AUTO_MEMBER_SLOT, ...extra });

test("an EMPTY runtime result is never relayed: the turn fails, retries within budget, and ends terminal with a clear reason", async () => {
  const ctx = harness({ script: ["", "  "] });
  const first = await ctx.run(rootPayload());
  assert.equal(first.status, "failed");
  assert.match(first.error.message, /^claude_one_shot-empty-output/);
  const dispatch = ctx.dispatchStore.claimDue(Date.now() + 60_000);
  assert.equal((await ctx.runtime.executeTurn(rootPayload(), dispatch)).status, "failed");
  assert.deepEqual(ctx.replies, [], "no empty answer ever reached the root");
  const row = ctx.dispatchStore.get({ msgId: ROOT, recipientId: AGENT, memberSlot: CLAUDE_AUTO_MEMBER_SLOT });
  assert.equal(row.state, "terminal");
  assert.match(row.lastError, /empty-output/);
});

test("a FENCED delegation frame as the whole answer is tool-intent-only: no root reply and no half-created handoff", async () => {
  const ctx = harness({ script: ["```json\n" + FRAME + "\n```"] });
  const result = await ctx.run(rootPayload());
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /tool-intent-only/);
  assert.deepEqual(ctx.replies, []);
  assert.equal(ctx.handoffStore.list().length, 0);
  assert.equal(enqueuedEnvelopes(ctx.db).length, 0);
});

test("Root → Claude emits a handoff intent only; Codex has not replied: NO root final. Then Codex replies, Claude continues: exactly ONE final", async () => {
  const ctx = harness({ script: [FRAME, "Final analysis: the change is safe because X and Y."] });
  const first = await ctx.run(rootPayload());
  assert.equal(first.status, "completed-handoff");
  assert.deepEqual(ctx.replies, [], "the raw intent is NOT exposed as the root result");
  assert.equal(ctx.handoffStore.listOpen().length, 1, "the root workflow keeps waiting");
  assert.equal(enqueuedEnvelopes(ctx.db).length, 1, "the child was handed off exactly once");
  // time passes, Codex has not finished: still no final
  assert.deepEqual(ctx.replies, []);

  const handoff = ctx.handoffStore.listOpen()[0];
  const childReply = {
    msgId: "codex-reply-0001", from: TARGET, conversationId: handoff.handoffConversationId,
    text: "Codex: reviewed, no blockers.", replyToMessageId: handoff.handoffMsgId, memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
  };
  const second = await ctx.run(childReply);
  assert.equal(second.status, "completed");
  assert.equal(ctx.replies.length, 1, "exactly ONE final root result");
  assert.equal(ctx.replies[0].to, "human-agent");
  assert.equal(ctx.replies[0].replyToMessageId, ROOT);
  assert.match(ctx.replies[0].text, /^Final analysis/);
  assert.equal(ctx.handoffStore.listOpen().length, 0);
  // the same child reply delivered AGAIN produces no second final
  const dup = ctx.dispatchStore.enqueue(childReply);
  assert.equal(ctx.dispatchStore.claimDue(Date.now() + 60_000), null);
  void dup;
  assert.equal(ctx.replies.length, 1);
});

test("a final reply that is itself a tool intent while delegated work is still pending is not exposed", async () => {
  const ctx = harness({ script: [FRAME, FRAME] });
  await ctx.run(rootPayload());
  const handoff = ctx.handoffStore.listOpen()[0];
  // Claude resumes but answers with ANOTHER bare intent wrapped in a fence instead of a result
  ctx.runtime.runner = async ({ sessionId, onSpawn }) => { onSpawn({ pid: 1, processStartIdentity: "1:1" }); return { text: "```json\n" + FRAME + "\n```", sessionId }; };
  const resumed = await ctx.run({ msgId: "codex-reply-0002", from: TARGET, conversationId: handoff.handoffConversationId, text: "done", replyToMessageId: handoff.handoffMsgId, memberSlot: CLAUDE_AUTO_MEMBER_SLOT });
  assert.equal(resumed.status, "failed");
  assert.deepEqual(ctx.replies, []);
});
