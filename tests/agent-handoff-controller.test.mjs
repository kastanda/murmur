import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentHandoffController,
  HANDOFF_REASONS,
  HandoffRejection,
  buildHandoffFailureText,
  buildHandoffInstructions,
  entersReservedControlFrame,
  localHandoffCapabilities,
  parseHandoffAction,
  peerCapabilityFields,
} from "../scripts/agent-handoff-controller.mjs";
import {
  claimFencedDispatch,
  createHandoffDatabase,
  enqueuedEnvelopes,
  registerIdleBinding,
  replaceBindingGeneration,
} from "./fixtures/handoff-fence.mjs";

const contexts = [];
test.afterEach(() => {
  while (contexts.length) {
    const ctx = contexts.pop();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const HANDOFF_PEER = {
  encryption: { publicKey: "enc" },
  signing: { publicKey: "sig" },
  subject: "msg.codex-agent",
  protocolVersions: ["1.0", "1.1"],
  features: ["handoff-v1"],
};

const peerSet = (overrides = {}) => ({
  "codex-agent": { ...HANDOFF_PEER },
  "cursor-agent": { ...HANDOFF_PEER, subject: "msg.cursor-agent" },
  "legacy-agent": {
    encryption: { publicKey: "enc" },
    signing: { publicKey: "sig" },
    subject: "msg.legacy-agent",
  },
  "unpaired-agent": { subject: "msg.unpaired-agent", protocolVersions: ["1.0", "1.1"], features: ["handoff-v1"] },
  ...overrides,
});

let msgCounter = 0;

/**
 * A controller wired to a REAL fenced context: real runtime binding, real dispatch
 * assignment, real shared outbox. `delegate` therefore exercises the actual durable
 * authority boundary rather than an injected send callback.
 */
const setup = ({ agentId = "claude-agent", peers = peerSet(), maxDepth = 4 } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-controller-"));
  const db = createHandoffDatabase({ dir, agentId });
  registerIdleBinding(db.bindingStore, { agentId, now: 1_000 });
  const claimed = claimFencedDispatch(db, { agentId, now: 1_000 });
  const built = [];
  msgCounter = 0;
  const controller = new AgentHandoffController({
    store: db.handoffStore,
    agentId,
    peers,
    maxDepth,
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
    now: () => 1_000,
    newMsgId: () => `h${++msgCounter}`,
  });
  const ctx = {
    dir,
    db,
    store: db.handoffStore,
    controller,
    built,
    fence: claimed.fence,
    identity: claimed.identity,
    /** What actually reached the durable outbox — the honest "was it sent" answer. */
    sent: () => enqueuedEnvelopes(db.dbPath).map((row) => ({
      msgId: row.msgId,
      subject: row.subject,
      to: row.envelope.recipients[0],
      conversationId: row.envelope.conversationId,
      handoff: row.envelope.handoff,
      text: Buffer.from(row.envelope.payloadCiphertext, "base64").toString("utf8"),
    })),
  };
  contexts.push(ctx);
  return ctx;
};

/** Every controller test delegates with the real fence obtained above. */
const delegate = (ctx, options) => ctx.controller.delegate({ ...options, fence: ctx.fence, identity: ctx.identity });

const turn = (overrides = {}) => ({
  parentActivePath: [],
  rootMessageId: "root-1",
  rootConversationId: "conv-root",
  causedByMessageId: "root-1",
  reply: { to: "human-agent", conversationId: "conv-root", replyToMessageId: "root-1" },
  binding: {
    bindingId: "binding-a",
    runtimeGeneration: 7,
    runtimeKind: "claude_one_shot",
    memberSlot: "claude:auto",
    runtimeSessionId: "claude-session-1",
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Strict terminal action contract
// ---------------------------------------------------------------------------

test("ordinary prose is never interpreted as a delegation", () => {
  const prose = [
    "Sure, I'll ask codex-agent to review the retry path.",
    "handoff to codex-agent",
    'Here you go:\n```json\n{"murmur":{"action":"handoff","to":"codex-agent","task":"x"}}\n```',
    "",
    "   ",
    "{not json}",
    '{"result":"ok"}',
    '{"nested":{"murmur":{"action":"handoff","to":"codex-agent","task":"x"}}}',
    // a `murmur` key that is NOT the first key stays ordinary: the reserved grammar is a
    // fixed prefix, so this never enters it
    '{"note":"see below","murmur":{"result":"handoff-failed","reason":"handoff-cycle"}}',
  ];
  for (const text of prose) {
    assert.equal(parseHandoffAction(text).kind, "none", `must not be a handoff: ${JSON.stringify(text)}`);
  }
});

test("the exact terminal frame is the only accepted delegation", () => {
  const action = parseHandoffAction('{"murmur":{"action":"handoff","to":"codex-agent","task":"audit retries"}}');
  assert.deepEqual(action, { kind: "handoff", to: "codex-agent", task: "audit retries" });
  // surrounding whitespace only
  assert.equal(parseHandoffAction('\n  {"murmur":{"action":"handoff","to":"codex-agent","task":"t"}}  \n').kind, "handoff");
});

test("a malformed murmur.action frame FAILS CLOSED and is never downgraded to prose", () => {
  const malformed = [
    // reserved frame with trailing prose: inside the reserved grammar, not one JSON object
    ['{"murmur":{"action":"handoff","to":"codex-agent","task":"x"}} — and some trailing prose', "control-frame-incomplete"],
    // reserved namespace misuse: `murmur` is not a control object
    ['{"murmur":"handoff"}', "murmur-not-an-object"],
    // reserved namespace with no action discriminator at all
    ['{"murmur":{"result":"handoff-failed","reason":"handoff-cycle","handoffMsgId":"h1"}}', "control-frame-missing-action"],
    ['{"murmur":{"action":"handoff"}}', "to-required"],
    ['{"murmur":{"action":"handoff","to":"","task":"t"}}', "to-required"],
    ['{"murmur":{"action":"handoff","to":"codex-agent"}}', "task-required"],
    ['{"murmur":{"action":"handoff","to":"codex-agent","task":"   "}}', "task-required"],
    ['{"murmur":{"action":"handoff","to":"codex-agent","task":"t","subject":"msg.evil"}}', "unexpected-fields:subject"],
    ['{"murmur":{"action":"handoff","to":"codex-agent","task":"t","ancestry":["x"]}}', "unexpected-fields:ancestry"],
    ['{"murmur":{"action":"delegate","to":"codex-agent","task":"t"}}', "unsupported-action:delegate"],
    ['{"murmur":{"action":"handoff","to":"codex-agent","task":"t"},"extra":1}', "unexpected-top-level-keys"],
  ];
  for (const [text, detail] of malformed) {
    const action = parseHandoffAction(text);
    assert.equal(action.kind, "invalid", `must fail closed: ${text}`);
    assert.equal(action.reason, HANDOFF_REASONS.actionMalformed);
    assert.equal(action.detail, detail);
  }
});

test("an oversized task is refused rather than truncated", () => {
  const task = "x".repeat(40);
  const text = JSON.stringify({ murmur: { action: "handoff", to: "codex-agent", task } });
  assert.equal(parseHandoffAction(text, { maxTaskBytes: 16 }).detail, "task-too-large");
  assert.equal(parseHandoffAction(text, { maxTaskBytes: 4096 }).kind, "handoff");
});

test("the model can only choose a target id and a task, never routing metadata", () => {
  const instructions = buildHandoffInstructions({ agentId: "claude-agent", targets: ["codex-agent"] });
  assert.match(instructions, /"action":"handoff"/);
  assert.match(instructions, /Murmur owns routing, ids, lineage and signatures/);
  assert.equal(buildHandoffInstructions({ agentId: "claude-agent", targets: [] }), "");
});

// ---------------------------------------------------------------------------
// Capability / authorization
// ---------------------------------------------------------------------------

test("only peers advertising protocol 1.1 AND handoff-v1 are delegation targets", () => {
  const ctx = setup();
  assert.deepEqual(ctx.controller.handoffTargets(), ["codex-agent", "cursor-agent"]);
  // unpaired / capability-less peers are never offered to the model as targets
  assert.ok(!ctx.controller.handoffTargets().includes("unpaired-agent"));
  assert.ok(!ctx.controller.handoffTargets().includes("legacy-agent"));
});

test("fail closed on unknown, unpaired, capability-less and subject-less targets", () => {
  const ctx = setup({
    peers: peerSet({ "no-subject-agent": { ...HANDOFF_PEER, subject: "" } }),
  });
  assert.equal(ctx.controller.resolveTarget("ghost-agent").reason, HANDOFF_REASONS.targetUnknown);
  assert.equal(ctx.controller.resolveTarget("").reason, HANDOFF_REASONS.targetUnknown);
  assert.equal(ctx.controller.resolveTarget("unpaired-agent").reason, HANDOFF_REASONS.targetUnpaired);
  assert.equal(ctx.controller.resolveTarget("legacy-agent").reason, HANDOFF_REASONS.targetCapabilityMissing);
  assert.equal(ctx.controller.resolveTarget("no-subject-agent").reason, HANDOFF_REASONS.targetSubjectMissing);
  assert.equal(ctx.controller.resolveTarget("codex-agent").subject, "msg.codex-agent");
});

test("the transport subject comes ONLY from paired peer config", async () => {
  const ctx = setup();
  await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  assert.equal(ctx.sent()[0].subject, "msg.codex-agent");
  // A model-supplied subject is structurally unrepresentable: the action frame rejects the field.
  assert.equal(parseHandoffAction('{"murmur":{"action":"handoff","to":"codex-agent","task":"t","subject":"msg.evil"}}').kind, "invalid");
});

test("a peer paired before handoff existed keeps working for ordinary traffic but refuses delegation", async () => {
  const ctx = setup();
  await assert.rejects(
    delegate(ctx, { to: "legacy-agent", task: "t", turn: turn() }),
    (error) => error instanceof HandoffRejection && error.reason === HANDOFF_REASONS.targetCapabilityMissing,
  );
  assert.deepEqual(peerCapabilityFields({}), {});
  assert.deepEqual(peerCapabilityFields(localHandoffCapabilities()), {
    protocolVersions: ["1.0", "1.1"], features: ["handoff-v1"],
  });
});

// ---------------------------------------------------------------------------
// ACTIVE ancestry / loop safety
// ---------------------------------------------------------------------------

test("a root handoff has ancestry [sender]", async () => {
  const ctx = setup();
  const { continuation } = await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  assert.deepEqual(continuation.handoffAncestry, ["claude-agent"]);
  assert.deepEqual(ctx.sent()[0].handoff.ancestry, ["claude-agent"]);
  assert.equal(ctx.sent()[0].handoff.rootMessageId, "root-1");
  assert.equal(ctx.sent()[0].handoff.rootConversationId, "conv-root");
  assert.equal(ctx.sent()[0].handoff.causedByMessageId, "root-1");
  assert.equal(ctx.sent()[0].conversationId, `handoff:${ctx.sent()[0].msgId}`);
});

test("a nested handoff appends the CURRENT sender to the inherited active path", async () => {
  const ctx = setup({ agentId: "codex-agent", peers: peerSet() });
  await delegate(ctx, {
    to: "cursor-agent",
    task: "t",
    turn: turn({
      parentActivePath: ["claude-agent"],
      causedByMessageId: "h1",
      reply: { to: "claude-agent", conversationId: "handoff:h1", replyToMessageId: "h1" },
      binding: { bindingId: "b", runtimeGeneration: 1, runtimeKind: "codex_app_server", memberSlot: "codex:app-server" },
    }),
  });
  assert.deepEqual(ctx.sent()[0].handoff.ancestry, ["claude-agent", "codex-agent"]);
  // root lineage is unchanged by nesting
  assert.equal(ctx.sent()[0].handoff.rootMessageId, "root-1");
  assert.equal(ctx.sent()[0].handoff.rootConversationId, "conv-root");
});

test("sibling delegation after a completed child excludes that child (no false cycle)", async () => {
  const ctx = setup();
  const first = await delegate(ctx, { to: "codex-agent", task: "first", turn: turn() });
  const closed = ctx.controller.closeContinuation({
    fence: ctx.fence,
    identity: ctx.identity,
    handoffMsgId: first.continuation.handoffMsgId,
    replySenderId: "codex-agent",
    replyConversationId: first.continuation.handoffConversationId,
    closedByMessageId: "c1",
  });
  assert.equal(closed.closed, true);
  const second = await delegate(ctx, {
    to: "cursor-agent",
    task: "second",
    // the delegator restores its SAVED parent active path, which never contained the child
    turn: turn({ parentActivePath: closed.handoff.parentActiveAncestry, causedByMessageId: "c1" }),
  });
  assert.deepEqual(second.continuation.handoffAncestry, ["claude-agent"]);
  assert.deepEqual(ctx.sent()[1].handoff.ancestry, ["claude-agent"]);
  assert.equal(ctx.sent()[1].handoff.causedByMessageId, "c1");
  assert.equal(ctx.sent()[1].handoff.rootMessageId, "root-1");
  // and delegating to the already-completed child again is still allowed
  const third = await delegate(ctx, {
    to: "codex-agent", task: "third", turn: turn({ causedByMessageId: "c2" }),
  });
  assert.deepEqual(third.continuation.handoffAncestry, ["claude-agent"]);
});

test("a target already on the ACTIVE ancestry is a cycle", async () => {
  const ctx = setup({ agentId: "codex-agent" });
  await assert.rejects(
    delegate(ctx, {
      to: "cursor-agent",
      task: "t",
      turn: turn({ parentActivePath: ["cursor-agent", "claude-agent"], causedByMessageId: "h1" }),
    }),
    (error) => error.reason === HANDOFF_REASONS.cycle,
  );
});

test("self handoff is rejected", async () => {
  const ctx = setup({
    agentId: "codex-agent",
    peers: peerSet({ "codex-agent": { ...HANDOFF_PEER } }),
  });
  await assert.rejects(
    delegate(ctx, { to: "codex-agent", task: "t", turn: turn() }),
    (error) => error.reason === HANDOFF_REASONS.self,
  );
});

test("the delegator already on its own inherited active path is a cycle, not an append", async () => {
  const ctx = setup();
  await assert.rejects(
    delegate(ctx, {
      to: "codex-agent",
      task: "t",
      turn: turn({ parentActivePath: ["claude-agent"] }),
    }),
    (error) => error.reason === HANDOFF_REASONS.cycle,
  );
});

test("a duplicate or malformed inherited ancestry is rejected", async () => {
  const ctx = setup();
  for (const parentActivePath of [["a", "a"], ["", "b"], "claude-agent", [1]]) {
    await assert.rejects(
      delegate(ctx, { to: "codex-agent", task: "t", turn: turn({ parentActivePath }) }),
      (error) => error.reason === HANDOFF_REASONS.ancestryInvalid,
      `must reject ${JSON.stringify(parentActivePath)}`,
    );
  }
});

test("maximum active delegation depth is enforced", async () => {
  const ctx = setup({ agentId: "d-agent", maxDepth: 4 });
  const deep = ["a-agent", "b-agent", "c-agent", "e-agent"];
  await assert.rejects(
    delegate(ctx, { to: "codex-agent", task: "t", turn: turn({ parentActivePath: deep }) }),
    (error) => error.reason === HANDOFF_REASONS.depthExceeded,
  );
  // depth 4 exactly is allowed
  const ok = await delegate(ctx, {
    to: "codex-agent", task: "t", turn: turn({ parentActivePath: ["a-agent", "b-agent", "c-agent"] }),
  });
  assert.equal(ok.continuation.handoffAncestry.length, 4);
});

// ---------------------------------------------------------------------------
// Idempotency / recovery
// ---------------------------------------------------------------------------

test("a crash/replay of the same delegation reuses the handoff and never delegates twice", async () => {
  const ctx = setup();
  const first = await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  const replay = await delegate(ctx, { to: "codex-agent", task: "t-rewritten", turn: turn() });
  assert.equal(replay.created, false);
  assert.equal(replay.continuation.handoffMsgId, first.continuation.handoffMsgId);
  assert.equal(ctx.store.list().length, 1);
  // the durable outbox holds exactly ONE outbound handoff: the replay re-inserts the same
  // msgId, which `INSERT OR IGNORE` collapses instead of delegating twice
  assert.equal(ctx.sent().length, 1);
  // and both build attempts produced the identical msgId, conversation, lineage and task
  assert.equal(ctx.built.length, 2);
  assert.equal(ctx.built[0].msgId, ctx.built[1].msgId);
  assert.equal(ctx.built[0].conversationId, ctx.built[1].conversationId);
  assert.deepEqual(ctx.built[0].handoff, ctx.built[1].handoff);
  assert.equal(ctx.built[1].text, "t", "a reused row keeps its original task text");
});

test("the same causative turn may not retarget its child handoff", async () => {
  const ctx = setup();
  await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  await assert.rejects(
    delegate(ctx, { to: "cursor-agent", task: "t", turn: turn() }),
    (error) => error.reason === HANDOFF_REASONS.actionMalformed && error.detail === "one-handoff-per-causative-message",
  );
});

test("a failure BEFORE the fenced commit leaves no continuation and no outbound handoff", async () => {
  const ctx = setup();
  const failing = new AgentHandoffController({
    store: ctx.store,
    agentId: "claude-agent",
    peers: peerSet(),
    // signing/encryption happens before the transaction opens, so a failure here is total
    buildHandoffEnvelope: async () => { throw new Error("signing-unavailable"); },
    now: () => 1_000,
    newMsgId: () => "h-crash",
  });
  await assert.rejects(
    failing.delegate({ to: "codex-agent", task: "t", turn: turn(), fence: ctx.fence, identity: ctx.identity }),
    /signing-unavailable/,
  );
  assert.deepEqual(ctx.store.list(), [], "no continuation row");
  assert.deepEqual(ctx.sent(), [], "no outbound handoff");
});

test("the continuation and its outbound outbox row commit together, never one without the other", async () => {
  const ctx = setup();
  const { continuation } = await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  const rows = ctx.sent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msgId, continuation.handoffMsgId);
  assert.equal(rows[0].conversationId, continuation.handoffConversationId);
  assert.equal(continuation.enqueuedAt, 1_000, "enqueued_at is set inside the same transaction");
  assert.equal(ctx.store.pendingEnqueue().length, 0, "the atomic path never leaves a pending enqueue");
});

test("recovery re-enqueues a legacy continuation whose outbox row is missing, idempotently", async () => {
  const ctx = setup();
  const { continuation } = await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  // Simulate a row written by a pre-atomic build: outbox row gone, enqueued_at cleared.
  ctx.store.db.exec(`DELETE FROM outbox WHERE msg_id = '${continuation.handoffMsgId}'`);
  ctx.store.db.exec(`UPDATE agent_handoffs SET enqueued_at = NULL WHERE handoff_msg_id = '${continuation.handoffMsgId}'`);
  assert.deepEqual(ctx.sent(), []);
  assert.deepEqual(ctx.store.pendingEnqueue().map((row) => row.handoffMsgId), [continuation.handoffMsgId]);

  assert.deepEqual(await ctx.controller.recoverPendingEnqueues(), [continuation.handoffMsgId]);
  assert.equal(ctx.store.pendingEnqueue().length, 0);
  assert.equal(ctx.sent().length, 1);
  assert.equal(ctx.sent()[0].msgId, continuation.handoffMsgId);
  // recovery creates no second handoff and is idempotent
  assert.equal(ctx.store.list().length, 1);
  assert.deepEqual(await ctx.controller.recoverPendingEnqueues(), []);
  assert.equal(ctx.sent().length, 1);
});

test("a pending handoff to a peer that lost its capability becomes explicitly terminal", async () => {
  const ctx = setup();
  const { continuation } = await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  ctx.store.db.exec(`DELETE FROM outbox WHERE msg_id = '${continuation.handoffMsgId}'`);
  ctx.store.db.exec(`UPDATE agent_handoffs SET enqueued_at = NULL WHERE handoff_msg_id = '${continuation.handoffMsgId}'`);
  ctx.controller.peers = {};
  assert.deepEqual(await ctx.controller.recoverPendingEnqueues(), []);
  assert.equal(ctx.store.get(continuation.handoffMsgId).state, "terminal");
  assert.equal(ctx.store.get(continuation.handoffMsgId).terminalReason, HANDOFF_REASONS.targetUnknown);
  assert.deepEqual(ctx.sent(), []);
});

// ---------------------------------------------------------------------------
// Exact reply resolution
// ---------------------------------------------------------------------------

test("a child result correlates ONLY by exact replyToMessageId, never by conversation", async () => {
  const ctx = setup();
  const { continuation } = await delegate(ctx, { to: "codex-agent", task: "t", turn: turn() });
  assert.equal(ctx.controller.matchChildReply({ replyToMessageId: continuation.handoffMsgId }).handoffMsgId, continuation.handoffMsgId);
  assert.equal(ctx.controller.matchChildReply({ conversationId: continuation.handoffConversationId }), null);
  assert.equal(ctx.controller.matchChildReply({ replyToMessageId: "root-1" }), null);
  assert.equal(ctx.controller.matchChildReply({}), null);
});

test("another delegator's handoff id is not ours to close", async () => {
  const ctx = setup();
  ctx.store.createOrReuse({
    handoffMsgId: "foreign",
    delegatorId: "someone-else",
    recipientId: "codex-agent",
    causedByMessageId: "x",
    rootMessageId: "x",
    rootConversationId: "c",
    handoffConversationId: "handoff:foreign",
    parentActiveAncestry: [],
    handoffAncestry: ["someone-else"],
    originatingBindingId: "b",
    originatingBindingGeneration: 1,
    originatingRuntimeKind: "claude_one_shot",
    originatingMemberSlot: "claude:auto",
    parentMessageId: "x",
    parentConversationId: "c",
    parentSenderId: "y",
    taskText: "t",
  });
  assert.equal(ctx.controller.matchChildReply({ replyToMessageId: "foreign" }), null);
});

test("the system failure result is machine-readable, correlated and not a handoff", () => {
  const text = buildHandoffFailureText({ reason: HANDOFF_REASONS.cycle, detail: "codex-agent", handoffMsgId: "h1" });
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, { murmur: { result: "handoff-failed", reason: "handoff-cycle", detail: "codex-agent", handoffMsgId: "h1" } });
  // it can never be re-parsed as a delegation action...
  assert.notEqual(parseHandoffAction(text).kind, "handoff");
  // ...and because it occupies the RESERVED namespace, a model echoing it verbatim as its
  // own terminal answer fails closed rather than being relayed as an ordinary reply
  assert.equal(entersReservedControlFrame(text), true);
  assert.equal(parseHandoffAction(text).kind, "invalid");
  assert.equal(parseHandoffAction(text).detail, "control-frame-missing-action");
});
