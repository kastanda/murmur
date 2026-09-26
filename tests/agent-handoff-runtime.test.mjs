/**
 * Runtime continuation behaviour for all three autonomous adapters.
 *
 * These drive the real ClaudeOneShotRuntime / CodexAppServerRuntimeAdapter /
 * CursorAcpRuntime against the real handoff controller + coordinator, so what is under
 * test is the actual resume path each runtime takes, not a simulation of it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { HANDOFF_REASONS } from "../packages/core/dist/src/index.js";
import { AgentHandoffController } from "../scripts/agent-handoff-controller.mjs";
import { HandoffTurnCoordinator } from "../scripts/agent-handoff-runtime.mjs";
import { AgentHandoffStore } from "../scripts/agent-handoff-store.mjs";
import {
  CODEX_APP_SERVER_MEMBER_SLOT,
  CodexAppServerRuntimeAdapter,
  codexConversationKey,
} from "../scripts/agent-runtime-adapter.mjs";
import {
  CLAUDE_AUTO_MEMBER_SLOT,
  ClaudeOneShotRuntime,
  claudeHandoffResumeGuard,
} from "../scripts/claude-one-shot-runtime.mjs";
import {
  CURSOR_ACP_MEMBER_SLOT,
  CursorAcpRuntime,
  cursorHandoffResumeGuard,
} from "../scripts/cursor-acp-runtime.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";
import { enqueuedEnvelopes, replaceBindingGeneration } from "./fixtures/handoff-fence.mjs";

const AGENT = "claude-agent";
const TARGET = "codex-agent";
const OTHER = "cursor-agent";
const handoffAction = (to, task) => JSON.stringify({ murmur: { action: "handoff", to, task } });

const peer = (agentId) => ({
  encryption: { publicKey: `enc-${agentId}` },
  signing: { publicKey: `sig-${agentId}` },
  subject: `msg.${agentId}`,
  protocolVersions: ["1.0", "1.1"],
  features: ["handoff-v1"],
});

const contexts = [];
test.afterEach(async () => {
  while (contexts.length) {
    const ctx = contexts.pop();
    await ctx.teardown();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

/** One agent with real stores, a real controller/coordinator and a recording transport. */
function harness({ agentId = AGENT, peers = { [TARGET]: peer(TARGET), [OTHER]: peer(OTHER) }, dir, dbPath } = {}) {
  const baseDir = dir ?? mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-runtime-"));
  const db = dbPath ?? path.join(baseDir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(db, { recipientId: agentId, maxAttempts: 3 });
  // The shared outbox must exist: the fenced transaction inserts the outbound handoff row
  // into it atomically with the continuation.
  const outboxStore = new SQLiteDedupeOutboxStore(db);
  const bindingStore = new RuntimeBindingStore(db);
  const handoffStore = new AgentHandoffStore(db);
  const built = [];
  const replies = [];
  let msgCounter = 0;
  const controller = new AgentHandoffController({
    store: handoffStore,
    agentId,
    peers,
    buildHandoffEnvelope: async ({ msgId, to, subject, conversationId, handoff, text }) => {
      const envelope = {
        schemaVersion: "1.1",
        msgId,
        conversationId,
        senderAgentId: agentId,
        recipients: [to],
        createdAt: "2026-09-26T00:00:00.000Z",
        payloadCiphertext: Buffer.from(text, "utf8").toString("base64"),
        payloadNonce: "test-nonce",
        handoff,
        signature: "test-signature",
      };
      built.push({ msgId, to, subject, conversationId, handoff, text, envelope });
      return { subject, envelope };
    },
    newMsgId: () => `h-${++msgCounter}`,
  });
  const coordinator = new HandoffTurnCoordinator({ controller });
  const sendReply = async (reply) => { replies.push(reply); return { msgId: reply.msgId }; };
  /**
   * DURABLE outbound handoffs, read back from the shared outbox. Assertions use this
   * rather than a send callback so "was it actually sent" means "did it commit".
   */
  const handoffs = () => enqueuedEnvelopes(db).map((row) => ({
    msgId: row.msgId,
    subject: row.subject,
    to: row.envelope.recipients[0],
    conversationId: row.envelope.conversationId,
    handoff: row.envelope.handoff,
    text: Buffer.from(row.envelope.payloadCiphertext, "base64").toString("utf8"),
  }));
  return {
    dir: baseDir, dbPath: db, dispatchStore, outboxStore, bindingStore, handoffStore,
    controller, coordinator, built, handoffs, replies, sendReply,
  };
}

const claim = (ctx, { msgId, from, conversationId, text, replyToMessageId, handoff, memberSlot }) => {
  const payload = {
    from, text, msgId, conversationId, memberSlot,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(handoff ? { handoff } : {}),
  };
  ctx.dispatchStore.enqueue(payload);
  return { payload, dispatch: ctx.dispatchStore.claimDue() };
};

// ===========================================================================
// CLAUDE
// ===========================================================================

function claudeHarness(options = {}) {
  const base = harness(options);
  const runner = async ({ prompt, sessionId, resume, onSpawn }) => {
    base.runs.push({ prompt, sessionId, resume });
    onSpawn({ pid: 100 + base.runs.length, processStartIdentity: `100:${base.runs.length}` });
    const scripted = base.script.shift();
    if (typeof scripted === "function") return scripted({ prompt, sessionId });
    return { text: scripted ?? `answer:${prompt}`, sessionId };
  };
  base.runs = [];
  base.script = options.script ? [...options.script] : [];
  const runtime = new ClaudeOneShotRuntime({
    bindingStore: base.bindingStore,
    dispatchStore: base.dispatchStore,
    agentId: options.agentId ?? AGENT,
    projectId: "project-a",
    cwd: base.dir,
    runner,
    sendReply: base.sendReply,
    handoff: base.coordinator,
    heartbeatIntervalMs: 10,
    retryDelayMs: 1,
  });
  runtime.start({ bindingId: options.bindingId ?? "binding-a", runtimeGeneration: options.runtimeGeneration ?? 7,
    leaseTtlMs: options.leaseTtlMs ?? 1_000 });
  const ctx = {
    ...base,
    runtime,
    teardown: async () => {
      runtime.shutdown();
      base.handoffStore.close();
      base.bindingStore.close();
      base.dispatchStore.close();
    },
  };
  contexts.push(ctx);
  return ctx;
}

const claudeClaim = (ctx, overrides) => claim(ctx, {
  msgId: "root-1", from: "human-agent", conversationId: "conv-root", text: "root request",
  memberSlot: CLAUDE_AUTO_MEMBER_SLOT, ...overrides,
});

test("Claude: a handoff action suppresses the parent reply and keeps the continuation open", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "bounded task")] });
  const { payload, dispatch } = claudeClaim(ctx);
  const result = await ctx.runtime.executeTurn(payload, dispatch);

  assert.equal(result.status, "completed-handoff");
  assert.deepEqual(ctx.replies, [], "the parent reply is SUPPRESSED");
  assert.equal(ctx.handoffs().length, 1);
  assert.equal(ctx.handoffs()[0].to, TARGET);
  assert.equal(ctx.handoffs()[0].subject, "msg.codex-agent");
  assert.deepEqual(ctx.handoffs()[0].handoff.ancestry, [AGENT]);
  const open = ctx.handoffStore.listOpen();
  assert.equal(open.length, 1);
  assert.equal(open[0].originatingRuntimeSessionId, ctx.runs[0].sessionId);
  // the binding is back to a safe idle wait state
  assert.equal(ctx.bindingStore.get("binding-a").state, "BOUND_IDLE");
  assert.equal(ctx.dispatchStore.get(dispatch).state, "handed_off");
  // the completed receipt carries NO reply correlation, so reply recovery cannot invent one
  const attempt = ctx.dispatchStore.getProcessingAttempt(result.attemptId);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.metadata.disposition, "handoff");
  assert.equal(attempt.metadata.recipient, undefined);
  assert.equal(attempt.metadata.replyToMessageId, undefined);
  assert.deepEqual(await ctx.runtime.recoverCompletedReplies(), [], "recovery must not reply for a delegated turn");
  assert.deepEqual(ctx.replies, []);
});

test("Claude: the exact child result resumes the ORIGINATING session and answers the root", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "bounded task"), "final answer"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const handoffMsgId = ctx.handoffs()[0].msgId;

  const child = claudeClaim(ctx, {
    msgId: "c1", from: TARGET, conversationId: ctx.handoffs()[0].conversationId,
    text: "child result", replyToMessageId: handoffMsgId,
  });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);

  assert.equal(result.status, "completed");
  // resumed the same logical Claude session
  assert.equal(ctx.runs.length, 2);
  assert.equal(ctx.runs[1].sessionId, ctx.runs[0].sessionId);
  assert.equal(ctx.runs[1].resume, true);
  assert.match(ctx.runs[1].prompt, /MURMUR HANDOFF RESULT/);
  assert.match(ctx.runs[1].prompt, /child result/);
  assert.match(ctx.runs[1].prompt, /bounded task/);
  // the reply goes to the ROOT request, not to the child's derived conversation
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].to, "human-agent");
  assert.equal(ctx.replies[0].conversationId, "conv-root");
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
  assert.equal(ctx.replies[0].text, "final answer");
  // continuation closed exactly once
  const row = ctx.handoffStore.get(handoffMsgId);
  assert.equal(row.state, "closed");
  assert.equal(row.closedByMessageId, "c1");
  assert.deepEqual(ctx.handoffStore.listOpen(), []);
});

test("Claude: a sibling handoff after the child completes rebuilds ancestry from the restored parent path", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "first"), handoffAction(OTHER, "second"), "done"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const child = claudeClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r1", replyToMessageId: h1.msgId });
  await ctx.runtime.executeTurn(child.payload, child.dispatch);

  assert.equal(ctx.handoffs().length, 2);
  const h2 = ctx.handoffs()[1];
  assert.equal(h2.to, OTHER);
  assert.deepEqual(h2.handoff.ancestry, [AGENT], "the completed child is not on the active path");
  assert.equal(h2.handoff.rootMessageId, "root-1");
  assert.equal(h2.handoff.rootConversationId, "conv-root");
  assert.equal(h2.handoff.causedByMessageId, "c1");
  assert.deepEqual(ctx.replies, [], "still no premature parent reply");
  // the second continuation remembers the same parent to answer
  const row = ctx.handoffStore.get(h2.msgId);
  assert.equal(row.parentMessageId, "root-1");
  assert.equal(row.parentSenderId, "human-agent");
  assert.deepEqual(row.parentActiveAncestry, []);
});

test("Claude: a DISTINCT second reply to the same handoff can never resume the runtime again", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task"), "final answer"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const c1 = claudeClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r1", replyToMessageId: h1.msgId });
  await ctx.runtime.executeTurn(c1.payload, c1.dispatch);
  assert.equal(ctx.runs.length, 2);

  const c2 = claudeClaim(ctx, { msgId: "c2", from: TARGET, conversationId: h1.conversationId, text: "r2", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(c2.payload, c2.dispatch);

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, HANDOFF_REASONS.continuationAlreadyClosed);
  assert.equal(ctx.runs.length, 2, "no second resume");
  assert.equal(ctx.replies.length, 1, "no second authoritative parent result");
  assert.equal(ctx.handoffStore.get(h1.msgId).closedByMessageId, "c1");
  assert.equal(ctx.dispatchStore.get(c2.dispatch).state, "terminal");
});

test("Claude: a retried dispatch of the SAME child reply may still finish the resumed work", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task"), "answer-a", "answer-b"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const c1 = claudeClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r1", replyToMessageId: h1.msgId });
  await ctx.runtime.executeTurn(c1.payload, c1.dispatch);
  // redeliver the identical child reply (at-least-once)
  const retry = { msgId: "c1", recipientId: AGENT, memberSlot: CLAUDE_AUTO_MEMBER_SLOT };
  ctx.dispatchStore.db.prepare(`UPDATE wake_dispatch SET state='deferred', attempts=0, next_attempt_at=0,
    owner_binding_id=NULL, owner_generation=NULL, fencing_token=NULL, fencing_epoch=NULL WHERE msg_id=?`).run("c1");
  const again = ctx.dispatchStore.claimDue();
  const result = await ctx.runtime.executeTurn(c1.payload, again);
  assert.equal(result.status, "completed");
  assert.equal(ctx.runs.length, 3);
  assert.equal(ctx.handoffStore.get(h1.msgId).closedByMessageId, "c1");
  assert.equal(ctx.dispatchStore.get(retry).state, "handed_off");
});

test("Claude: a reply from the WRONG agent cannot close the continuation", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task")] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const imposter = claudeClaim(ctx, { msgId: "x1", from: OTHER, conversationId: h1.conversationId, text: "not mine", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(imposter.payload, imposter.dispatch);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, HANDOFF_REASONS.continuationSenderMismatch);
  assert.equal(ctx.runs.length, 1, "no model execution");
  assert.equal(ctx.handoffStore.get(h1.msgId).state, "open", "the continuation stays open for the real target");
});

test("Claude: a child reply from the right sender but the WRONG conversation leaves the continuation OPEN", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task"), "must never run"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];

  // exact msgId correlation, expected sender, but the root conversation instead of the
  // derived handoff conversation
  const spoofed = claudeClaim(ctx, {
    msgId: "c1", from: TARGET, conversationId: "conv-root", text: "child result", replyToMessageId: h1.msgId,
  });
  const result = await ctx.runtime.executeTurn(spoofed.payload, spoofed.dispatch);

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, HANDOFF_REASONS.continuationConversationMismatch);
  assert.equal(ctx.runs.length, 1, "the parent runtime is NOT resumed");
  assert.deepEqual(ctx.replies, [], "no authoritative parent result");
  const row = ctx.handoffStore.get(h1.msgId);
  assert.equal(row.state, "open", "the continuation remains open");
  assert.equal(row.closedByMessageId, null);
  assert.equal(row.closedAt, null);
  assert.equal(row.terminalReason, null, "and it is not terminalized");

  // the SAME reply in the correct derived conversation then succeeds exactly once
  const genuine = claudeClaim(ctx, {
    msgId: "c2", from: TARGET, conversationId: h1.conversationId, text: "child result", replyToMessageId: h1.msgId,
  });
  const ok = await ctx.runtime.executeTurn(genuine.payload, genuine.dispatch);
  assert.equal(ok.status, "completed");
  assert.equal(ctx.runs.length, 2);
  assert.equal(ctx.handoffStore.get(h1.msgId).state, "closed");
  assert.equal(ctx.handoffStore.get(h1.msgId).closedByMessageId, "c2");
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
});

test("Claude: a TRUNCATED reserved control frame fails closed and never becomes a parent reply", async () => {
  for (const truncated of [
    '{"murmur":{"action":"handoff","to":"codex-agent","task":"do the thing"',
    '{"murmur":{"action":"handoff","to":"codex-agent","task":',
    '{"murmur": {',
    '{"murmur":{"action":"handoff","to":"codex-agent","task":"x"}} trailing prose',
  ]) {
    const ctx = claudeHarness({ script: [truncated] });
    const { payload, dispatch } = claudeClaim(ctx);
    const result = await ctx.runtime.executeTurn(payload, dispatch);
    assert.equal(result.status, "failed", `must fail closed: ${truncated}`);
    assert.match(result.error.message, /handoff-action-malformed/);
    assert.deepEqual(ctx.replies, [], "the truncated frame is NEVER relayed as an ordinary parent reply");
    assert.deepEqual(ctx.handoffs(), [], "and no child work is enqueued");
    assert.deepEqual(ctx.handoffStore.list(), [], "and no continuation is created");
  }
});

test("Claude: free-form prose that merely mentions handoff stays an ordinary reply", async () => {
  const ctx = claudeHarness({ script: ["Here is the result. I considered a handoff to codex-agent but did it myself."] });
  const { payload, dispatch } = claudeClaim(ctx);
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed");
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
  assert.match(ctx.replies[0].text, /^Here is the result\./);
  assert.deepEqual(ctx.handoffs(), []);
  assert.deepEqual(ctx.handoffStore.list(), []);
});

test("Claude: a malformed handoff frame FAILS CLOSED and is not downgraded into a reply", async () => {
  const ctx = claudeHarness({ script: ['{"murmur":{"action":"handoff","to":"codex-agent"}}'] });
  const { payload, dispatch } = claudeClaim(ctx);
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /handoff-action-malformed:task-required/);
  assert.deepEqual(ctx.replies, [], "a malformed frame is never relayed as a model reply");
  assert.deepEqual(ctx.handoffs(), []);
  assert.deepEqual(ctx.handoffStore.list(), []);
});

test("Claude: an unauthorized target fails closed without emitting an envelope", async () => {
  const ctx = claudeHarness({
    peers: { [TARGET]: peer(TARGET), "legacy-agent": { encryption: { publicKey: "e" }, signing: { publicKey: "s" }, subject: "msg.legacy-agent" } },
    script: [handoffAction("legacy-agent", "task"), handoffAction("ghost-agent", "task")],
  });
  const first = claudeClaim(ctx);
  const capability = await ctx.runtime.executeTurn(first.payload, first.dispatch);
  assert.equal(capability.status, "failed");
  assert.match(capability.error.message, new RegExp(HANDOFF_REASONS.targetCapabilityMissing));

  const second = claudeClaim(ctx, { msgId: "root-2" });
  const unknown = await ctx.runtime.executeTurn(second.payload, second.dispatch);
  assert.equal(unknown.status, "failed");
  assert.match(unknown.error.message, new RegExp(HANDOFF_REASONS.targetUnknown));
  assert.deepEqual(ctx.handoffs(), []);
  assert.deepEqual(ctx.replies, []);
});

test("Claude: an ordinary terminal result is unchanged by the handoff layer", async () => {
  const ctx = claudeHarness({ script: ["plain answer"] });
  const { payload, dispatch } = claudeClaim(ctx);
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed");
  assert.equal(ctx.replies.length, 1);
  assert.deepEqual(
    { to: ctx.replies[0].to, conversationId: ctx.replies[0].conversationId, replyToMessageId: ctx.replies[0].replyToMessageId },
    { to: "human-agent", conversationId: "conv-root", replyToMessageId: "root-1" },
  );
  const attempt = ctx.dispatchStore.getProcessingAttempt(result.attemptId);
  assert.equal(attempt.metadata.recipient, "human-agent");
  assert.equal(attempt.metadata.replyToMessageId, "root-1");
  assert.equal(attempt.resultMessageId, ctx.replies[0].msgId);
  assert.deepEqual(ctx.handoffStore.list(), []);
});

test("Claude: an inbound handoff task inherits the signed active path for its own delegation", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "nested task")] });
  const turn = ctx.coordinator.prepareTurn({
    payload: {
      from: "delegator-agent", msgId: "h-in", conversationId: "handoff:h-in", text: "do the thing",
      handoff: { rootMessageId: "root-9", rootConversationId: "conv-9", causedByMessageId: "root-9", ancestry: ["delegator-agent"] },
    },
    binding: { bindingId: "b", runtimeGeneration: 1, runtimeSessionId: null },
    runtimeKind: "claude_one_shot",
    memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
  });
  assert.equal(turn.kind, "ordinary");
  assert.equal(turn.isHandoffInbound, true);
  assert.deepEqual(turn.parentActivePath, ["delegator-agent"]);
  assert.equal(turn.rootMessageId, "root-9");
  assert.equal(turn.rootConversationId, "conv-9");
  assert.equal(turn.causedByMessageId, "h-in");
  assert.deepEqual(turn.reply, { to: "delegator-agent", conversationId: "handoff:h-in", replyToMessageId: "h-in" });
  assert.match(turn.promptText, /MURMUR HANDOFF TASK/);
  assert.match(turn.promptText, /activeDelegationPath=delegator-agent/);
});

test("Claude: a stale runtime generation cannot create a handoff", async () => {
  let release;
  const ctx = claudeHarness({
    leaseTtlMs: 20,
    script: [({ sessionId }) => new Promise((resolve) => {
      release = () => resolve({ text: handoffAction(TARGET, "task"), sessionId });
    })],
  });
  const { payload, dispatch } = claudeClaim(ctx);
  const pending = ctx.runtime.executeTurn(payload, dispatch);
  await delay(5);
  ctx.runtime.stopHeartbeat();
  ctx.bindingStore.expireRoute({ agentId: AGENT, projectId: "project-a", memberSlot: CLAUDE_AUTO_MEMBER_SLOT,
    runtimeKind: "claude_one_shot" }, Date.now());
  ctx.bindingStore.reconcileStale({ now: Date.now() });
  release();
  const result = await pending;
  assert.equal(result.status, "late-result-dropped");
  assert.deepEqual(ctx.handoffs(), [], "a stale generation may not delegate");
  assert.deepEqual(ctx.handoffStore.list(), [], "and may not write a continuation");
  assert.deepEqual(ctx.replies, []);
});

test("Claude: after a binding replacement the NEW generation is the one that may resume", async () => {
  // The stale-generation matrix lives in agent-handoff-fencing.test.mjs, which drives the
  // durable authority boundary directly. Here we pin the complementary fact: a legitimate
  // replacement runtime on the same route is allowed to resume, exactly once.
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task"), "final answer"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const staleFence = { bindingId: "binding-a", ownerGeneration: 7, fencingToken: 1, fencingEpoch: 2 };

  replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: Date.now() });

  // the OLD fence value is refused by every fenced primitive
  assert.equal(ctx.handoffStore.fenceIsCurrent(staleFence), false);
  assert.equal(ctx.handoffStore.fencedTerminate({ fence: staleFence, handoffMsgId: h1.msgId, reason: "x" }).ok, false);
  assert.equal(ctx.handoffStore.get(h1.msgId).state, "open");

  // the replacement generation resumes normally
  const child = claudeClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);
  assert.equal(result.status, "completed");
  assert.equal(ctx.handoffStore.get(h1.msgId).closedByMessageId, "c1");
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
});

test("Claude: a restarted delegator resumes the exact originating session recorded durably", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-restart-"));
  const dbPath = path.join(dir, "murmur.db");
  const first = claudeHarness({ dir, dbPath, script: [handoffAction(TARGET, "task")], bindingId: "binding-1" });
  const claimed = claudeClaim(first);
  await first.runtime.executeTurn(claimed.payload, claimed.dispatch);
  const h1 = first.handoffs()[0];
  const originatingSession = first.runs[0].sessionId;
  // simulate a daemon restart: the runtime binding is retired and a brand new one appears
  first.runtime.shutdown();

  const restarted = claudeHarness({ dir, dbPath, script: ["final after restart"], bindingId: "binding-2", runtimeGeneration: 9 });
  assert.deepEqual(restarted.handoffStore.listOpen().map((row) => row.handoffMsgId), [h1.msgId],
    "the open continuation is reloaded from disk");
  const child = claim(restarted, { msgId: "c1", from: TARGET, conversationId: h1.conversationId,
    text: "child result", replyToMessageId: h1.msgId, memberSlot: CLAUDE_AUTO_MEMBER_SLOT });
  const result = await restarted.runtime.executeTurn(child.payload, child.dispatch);
  assert.equal(result.status, "completed");
  assert.equal(restarted.runs[0].sessionId, originatingSession, "resumed the ORIGINATING Claude session");
  assert.equal(restarted.runs[0].resume, true);
  assert.equal(restarted.replies[0].replyToMessageId, "root-1");
  assert.equal(restarted.replies[0].to, "human-agent");
});

test("Claude: a resumed turn whose reply enqueue crashes recovers the reply to the PARENT, once", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task"), "final answer"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];

  // the child result arrives, the model answers, but the reply enqueue fails
  let failSend = true;
  ctx.runtime.sendReply = async (reply) => {
    if (failSend) throw new Error("outbox-unavailable");
    ctx.replies.push(reply);
    return { msgId: reply.msgId };
  };
  const child = claudeClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);
  assert.equal(result.status, "completed-reply-pending");
  assert.deepEqual(ctx.replies, []);
  // the durable completed receipt carries the PARENT correlation, not the child's
  const attempt = ctx.dispatchStore.getProcessingAttempt(result.attemptId);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.resultMessageId, null);
  assert.equal(attempt.metadata.recipient, "human-agent");
  assert.equal(attempt.metadata.conversationId, "conv-root");
  assert.equal(attempt.metadata.replyToMessageId, "root-1");

  failSend = false;
  const recovered = await ctx.runtime.recoverCompletedReplies();
  assert.equal(recovered.length, 1);
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].to, "human-agent");
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
  assert.equal(ctx.replies[0].text, "final answer");
  assert.equal(ctx.replies[0].msgId, result.attemptId, "the attempt id is the deterministic outbound msgId");
  // recovery is idempotent
  assert.deepEqual(await ctx.runtime.recoverCompletedReplies(), []);
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.handoffStore.get(h1.msgId).state, "closed");
});

test("Claude resume guard: a diverged binding session fails closed instead of faking continuity", () => {
  const continuation = { originatingRuntimeSessionId: "session-A" };
  assert.deepEqual(claudeHandoffResumeGuard({ continuation, binding: { runtimeSessionId: null } }), { ok: true });
  assert.deepEqual(claudeHandoffResumeGuard({ continuation, binding: { runtimeSessionId: "session-A" } }), { ok: true });
  const diverged = claudeHandoffResumeGuard({ continuation, binding: { runtimeSessionId: "session-B" } });
  assert.equal(diverged.ok, false);
  assert.equal(diverged.reason, HANDOFF_REASONS.continuationSessionUnavailable);
  const missing = claudeHandoffResumeGuard({ continuation: { originatingRuntimeSessionId: null }, binding: {} });
  assert.equal(missing.reason, HANDOFF_REASONS.continuationSessionUnavailable);
});

test("Claude: an unresumable continuation is refused with an explicit terminal reason", async () => {
  const ctx = claudeHarness({ script: [handoffAction(TARGET, "task"), "should never run"] });
  const first = claudeClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  // the binding moves on to a different Claude session
  ctx.bindingStore.db.prepare("UPDATE runtime_bindings SET runtime_session_id = 'unrelated-session' WHERE binding_id = ?").run("binding-a");
  const child = claudeClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, HANDOFF_REASONS.continuationSessionUnavailable);
  assert.equal(ctx.runs.length, 1, "no unrelated new model session is started");
  assert.deepEqual(ctx.replies, []);
  const row = ctx.handoffStore.get(h1.msgId);
  assert.equal(row.state, "terminal");
  assert.equal(row.terminalReason, HANDOFF_REASONS.continuationSessionUnavailable);
  assert.equal(ctx.dispatchStore.get(child.dispatch).state, "terminal");
});

// ===========================================================================
// CODEX
// ===========================================================================

function codexHarness({ script = [], serverIdentity = () => "identity-1", ...options } = {}) {
  const base = harness(options);
  base.runs = [];
  base.script = [...script];
  const socketPath = path.join(base.dir, "app-server.sock");
  writeFileSync(socketPath, "");
  let nextThread = 1;
  const runtime = new CodexAppServerRuntimeAdapter({
    bindingStore: base.bindingStore,
    dispatchStore: base.dispatchStore,
    agentId: options.agentId ?? AGENT,
    projectId: "project-a",
    peer: { socketPath, mode: "codex_app_server" },
    sendReply: base.sendReply,
    handoff: base.coordinator,
    readServerIdentity: serverIdentity,
    heartbeatIntervalMs: 10,
    retryDelayMs: 1,
    injector: async (payload, runtimePeer, processing) => {
      const threadId = runtimePeer.threadId || `codex-thread-${nextThread++}`;
      runtimePeer.threadId = threadId;
      base.runs.push({ prompt: payload.text, threadId });
      processing.completed({ sessionId: `turn-${base.runs.length}` });
      return { threadId, turnId: `turn-${base.runs.length}`, finalText: base.script.shift() ?? "codex answer" };
    },
  });
  runtime.start({ bindingId: "codex-binding", runtimeGeneration: 3, leaseTtlMs: 1_000 });
  const ctx = {
    ...base,
    runtime,
    teardown: async () => {
      runtime.shutdown();
      base.handoffStore.close();
      base.bindingStore.close();
      base.dispatchStore.close();
    },
  };
  contexts.push(ctx);
  return ctx;
}

const codexClaim = (ctx, overrides) => claim(ctx, {
  msgId: "root-1", from: "human-agent", conversationId: "conv-root", text: "root request",
  memberSlot: CODEX_APP_SERVER_MEMBER_SLOT, ...overrides,
});

test("Codex: the child result returns to the ORIGINATING thread, not one derived from the child sender", async () => {
  const ctx = codexHarness({ script: [handoffAction(OTHER, "bounded task"), "codex final"] });
  const first = codexClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const originatingThread = ctx.runs[0].threadId;
  const row = ctx.handoffStore.get(h1.msgId);
  assert.equal(row.originatingRuntimeSessionId, originatingThread);
  assert.equal(row.originatingServerIdentity, "identity-1");

  const child = codexClaim(ctx, { msgId: "c1", from: OTHER, conversationId: h1.conversationId, text: "cursor result", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);

  assert.equal(result.status, "completed");
  assert.equal(ctx.runs.length, 2);
  assert.equal(ctx.runs[1].threadId, originatingThread, "resumed the exact originating Codex thread");
  assert.match(ctx.runs[1].prompt, /MURMUR HANDOFF RESULT/);
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
  // the thread stays keyed by the ORIGINATING route, never by (child sender, derived conversation)
  assert.equal(ctx.runtime.threadStore.get(codexConversationKey({ from: "human-agent", conversationId: "conv-root" }),
    ctx.runtime.serverGeneration).threadId, originatingThread);
  assert.equal(ctx.runtime.threadStore.get(codexConversationKey({ from: OTHER, conversationId: h1.conversationId }),
    ctx.runtime.serverGeneration), null, "no thread is created for the child's derived route");
});

test("Codex: a changed App Server identity refuses the continuation instead of faking continuity", async () => {
  let identity = "identity-1";
  const ctx = codexHarness({ script: [handoffAction(OTHER, "task"), "never runs"], serverIdentity: () => identity });
  const first = codexClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  identity = "identity-2";

  const child = codexClaim(ctx, { msgId: "c1", from: OTHER, conversationId: h1.conversationId, text: "r", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, HANDOFF_REASONS.continuationServerGenerationChanged);
  assert.equal(ctx.runs.length, 1, "the invalid old thread is never resumed");
  assert.deepEqual(ctx.replies, []);
  const row = ctx.handoffStore.get(h1.msgId);
  assert.equal(row.state, "terminal");
  assert.equal(row.terminalReason, HANDOFF_REASONS.continuationServerGenerationChanged);
});

test("Codex: a handoff action suppresses the parent reply and returns the binding to idle", async () => {
  const ctx = codexHarness({ script: [handoffAction(OTHER, "task")] });
  const { payload, dispatch } = codexClaim(ctx);
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed-handoff");
  assert.deepEqual(ctx.replies, []);
  assert.equal(ctx.bindingStore.get("codex-binding").state, "BOUND_IDLE");
  assert.equal(ctx.handoffStore.listOpen().length, 1);
  assert.deepEqual(await ctx.runtime.recoverCompletedReplies(), []);
  assert.deepEqual(ctx.replies, []);
});

// ===========================================================================
// CURSOR
// ===========================================================================

class MeshlessCursorClient {
  constructor(base) { this.base = base; this.sessions = new Set(); this.running = false; this.n = 0; this.loads = []; }
  async start() { this.running = true; return { pid: 900, processStartIdentity: "900:x" }; }
  health() { return { healthy: this.running, pid: 900, sessionIds: [...this.sessions] }; }
  async createSession() { const id = `cursor-session-${++this.n}`; this.sessions.add(id); return id; }
  async loadSession(id) { this.loads.push(id); this.sessions.add(id); return id; }
  async executeTurn({ sessionId, prompt, onSubmitted, onUpdate }) {
    onSubmitted();
    onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "" } });
    this.base.runs.push({ prompt, sessionId });
    return { text: this.base.script.shift() ?? "cursor answer", sessionId, stopReason: "end_turn" };
  }
  async cancel() { return true; }
  async shutdown() { this.running = false; return true; }
}

function cursorHarness({ script = [], ...options } = {}) {
  const base = harness(options);
  base.runs = [];
  base.script = [...script];
  const client = new MeshlessCursorClient(base);
  const runtime = new CursorAcpRuntime({
    bindingStore: base.bindingStore,
    dispatchStore: base.dispatchStore,
    agentId: options.agentId ?? AGENT,
    projectId: "project-a",
    cwd: base.dir,
    client,
    sendReply: base.sendReply,
    handoff: base.coordinator,
    heartbeatIntervalMs: 10,
    retryDelayMs: 1,
  });
  const ctx = {
    ...base,
    client,
    runtime,
    teardown: async () => {
      await runtime.shutdown();
      base.handoffStore.close();
      base.bindingStore.close();
      base.dispatchStore.close();
    },
  };
  contexts.push(ctx);
  return ctx;
}

const cursorClaim = (ctx, overrides) => claim(ctx, {
  msgId: "root-1", from: "human-agent", conversationId: "conv-root", text: "root request",
  memberSlot: CURSOR_ACP_MEMBER_SLOT, ...overrides,
});

test("Cursor: the child result resumes the same live ACP session and answers the root", async () => {
  const ctx = cursorHarness({ script: [handoffAction(TARGET, "bounded task"), "cursor final"] });
  await ctx.runtime.start({ bindingId: "cursor-binding", runtimeGeneration: 2, leaseTtlMs: 1_000 });
  const first = cursorClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  const originatingSession = ctx.runs[0].sessionId;
  assert.equal(ctx.handoffStore.get(h1.msgId).originatingRuntimeSessionId, originatingSession);

  const child = cursorClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "child result", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);

  assert.equal(result.status, "completed");
  assert.equal(ctx.runs.length, 2);
  assert.equal(ctx.runs[1].sessionId, originatingSession, "resumed the SAME ACP session");
  assert.equal(ctx.client.n, 1, "no new ACP session was created");
  assert.match(ctx.runs[1].prompt, /MURMUR HANDOFF RESULT/);
  assert.equal(ctx.replies[0].replyToMessageId, "root-1");
  assert.equal(ctx.replies[0].conversationId, "conv-root");
  assert.equal(ctx.handoffStore.get(h1.msgId).state, "closed");
});

test("Cursor: a lost ACP session refuses the continuation rather than claiming restart continuity", async () => {
  const ctx = cursorHarness({ script: [handoffAction(TARGET, "task"), "never runs"] });
  await ctx.runtime.start({ bindingId: "cursor-binding", runtimeGeneration: 2, leaseTtlMs: 1_000 });
  const first = cursorClaim(ctx);
  await ctx.runtime.executeTurn(first.payload, first.dispatch);
  const h1 = ctx.handoffs()[0];
  // the persistent ACP child died and came back with no loaded sessions
  ctx.client.sessions.clear();

  const child = cursorClaim(ctx, { msgId: "c1", from: TARGET, conversationId: h1.conversationId, text: "r", replyToMessageId: h1.msgId });
  const result = await ctx.runtime.executeTurn(child.payload, child.dispatch);

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, HANDOFF_REASONS.continuationSessionUnavailable);
  assert.equal(ctx.runs.length, 1);
  assert.deepEqual(ctx.client.loads, [], "no session/load continuity is claimed for a continuation");
  assert.deepEqual(ctx.replies, []);
  const row = ctx.handoffStore.get(h1.msgId);
  assert.equal(row.state, "terminal");
  assert.equal(row.terminalReason, HANDOFF_REASONS.continuationSessionUnavailable);
});

test("Cursor resume guard: only an exact, live originating session is resumable", () => {
  const continuation = { originatingRuntimeSessionId: "s1" };
  assert.deepEqual(cursorHandoffResumeGuard({ continuation, binding: { runtimeSessionId: "s1" }, liveSessionIds: ["s1"] }), { ok: true });
  assert.equal(cursorHandoffResumeGuard({ continuation, binding: { runtimeSessionId: "s1" }, liveSessionIds: [] }).detail, "acp-session-not-live");
  assert.equal(cursorHandoffResumeGuard({ continuation, binding: { runtimeSessionId: "s2" }, liveSessionIds: ["s1", "s2"] }).detail, "binding-session-diverged");
  assert.equal(cursorHandoffResumeGuard({ continuation: { originatingRuntimeSessionId: null }, binding: {} }).detail, "no-originating-session");
});

test("Cursor: an ordinary result is unaffected and a nested delegation inherits the active path", async () => {
  const ctx = cursorHarness({ script: ["plain cursor answer"] });
  await ctx.runtime.start({ bindingId: "cursor-binding", runtimeGeneration: 2, leaseTtlMs: 1_000 });
  const { payload, dispatch } = cursorClaim(ctx, {
    msgId: "h-in", from: "delegator-agent", conversationId: "handoff:h-in", text: "bounded task",
    handoff: { rootMessageId: "root-9", rootConversationId: "conv-9", causedByMessageId: "root-9", ancestry: ["delegator-agent"] },
  });
  const result = await ctx.runtime.executeTurn(payload, dispatch);
  assert.equal(result.status, "completed");
  assert.match(ctx.runs[0].prompt, /MURMUR HANDOFF TASK/);
  assert.equal(ctx.replies[0].replyToMessageId, "h-in");
  assert.equal(ctx.replies[0].to, "delegator-agent");
  assert.equal(ctx.replies[0].conversationId, "handoff:h-in");
  assert.deepEqual(ctx.handoffStore.list(), []);
});
