/**
 * ADVERSARIAL fencing tests for the handoff continuation authority boundary.
 *
 * These drive the durable boundary directly — real `runtime_bindings`, real
 * `wake_dispatch` assignment, real shared `outbox`, real SQLite transactions — because
 * `validateFence(); await …; mutate()` cannot be proved safe with a mocked fence. A stale
 * runtime generation must lose EVERY irreversible continuation mutation atomically.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HANDOFF_REASONS, derivedHandoffConversationId } from "../packages/core/dist/src/index.js";
import {
  claimFencedDispatch,
  createHandoffDatabase,
  enqueuedEnvelopes,
  registerIdleBinding,
  replaceBindingGeneration,
} from "./fixtures/handoff-fence.mjs";

const AGENT = "claude-agent";
const TARGET = "codex-agent";

const contexts = [];
test.afterEach(() => {
  while (contexts.length) {
    const ctx = contexts.pop();
    ctx.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const setup = () => {
  const ctx = createHandoffDatabase({ agentId: AGENT });
  contexts.push(ctx);
  registerIdleBinding(ctx.bindingStore, { agentId: AGENT, now: 1_000 });
  const claimed = claimFencedDispatch(ctx, { agentId: AGENT, now: 1_000 });
  return { ...ctx, ...claimed };
};

const handoffRecord = (overrides = {}) => ({
  handoffMsgId: "h1",
  delegatorId: AGENT,
  recipientId: TARGET,
  causedByMessageId: "root-1",
  rootMessageId: "root-1",
  rootConversationId: "conv-root",
  handoffConversationId: derivedHandoffConversationId("h1"),
  parentActiveAncestry: [],
  handoffAncestry: [AGENT],
  originatingBindingId: "binding-a",
  originatingBindingGeneration: 1,
  originatingRuntimeKind: "claude_one_shot",
  originatingMemberSlot: "claude:auto",
  originatingRuntimeSessionId: "claude-session-1",
  parentMessageId: "root-1",
  parentConversationId: "conv-root",
  parentSenderId: "human-agent",
  taskText: "bounded task",
  ...overrides,
});

const outboxPayload = (msgId = "h1") => ({
  subject: `msg.${TARGET}`,
  envelope: {
    schemaVersion: "1.1",
    msgId,
    conversationId: derivedHandoffConversationId(msgId),
    senderAgentId: AGENT,
    recipients: [TARGET],
    createdAt: "2026-09-26T00:00:00.000Z",
    payloadCiphertext: "Y3Q=",
    payloadNonce: "nonce",
    handoff: {
      rootMessageId: "root-1",
      rootConversationId: "conv-root",
      causedByMessageId: "root-1",
      ancestry: [AGENT],
    },
    signature: "sig",
  },
});

// ---------------------------------------------------------------------------
// Required test 4 — fence replacement before handoff creation
// ---------------------------------------------------------------------------

test("a stale generation creates NEITHER a continuation NOR an outbound handoff outbox row", () => {
  const ctx = setup();
  // the fence was valid a moment ago...
  assert.equal(ctx.handoffStore.fenceIsCurrent(ctx.fence, ctx.identity), true);
  // ...and a replacement runtime takes over the route before the mutation commits
  replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: 2_000 });

  const result = ctx.handoffStore.fencedCreate({
    fence: ctx.fence, identity: ctx.identity, record: handoffRecord(), outbox: outboxPayload(),
  }, 2_000);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "handoff-continuation-stale-binding");
  assert.deepEqual(ctx.handoffStore.list(), [], "no continuation row");
  assert.deepEqual(enqueuedEnvelopes(ctx.dbPath), [], "no outbound handoff outbox row");
});

test("a current generation commits the continuation and its outbox row together", () => {
  const ctx = setup();
  const result = ctx.handoffStore.fencedCreate({
    fence: ctx.fence, identity: ctx.identity, record: handoffRecord(), outbox: outboxPayload(),
  }, 1_500);

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.handoff.state, "open");
  assert.equal(result.handoff.enqueuedAt, 1_500, "enqueued_at commits in the same transaction");
  const rows = enqueuedEnvelopes(ctx.dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].msgId, "h1");
  assert.equal(rows[0].subject, `msg.${TARGET}`);
  assert.equal(rows[0].envelope.schemaVersion, "1.1");
});

test("a LATER replacement cannot retroactively corrupt an already committed handoff", () => {
  const ctx = setup();
  const committed = ctx.handoffStore.fencedCreate({
    fence: ctx.fence, identity: ctx.identity, record: handoffRecord(), outbox: outboxPayload(),
  }, 1_500);
  assert.equal(committed.ok, true);

  replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: 2_000 });

  const row = ctx.handoffStore.get("h1");
  assert.equal(row.state, "open");
  assert.equal(row.closedByMessageId, null);
  assert.equal(row.terminalReason, null);
  assert.equal(row.enqueuedAt, 1_500);
  assert.deepEqual(row.handoffAncestry, [AGENT]);
  assert.equal(enqueuedEnvelopes(ctx.dbPath).length, 1, "the durable outbound handoff survives");
});

test("an idempotent replay under a CURRENT fence reuses the row and the single outbox entry", () => {
  const ctx = setup();
  ctx.handoffStore.fencedCreate({
    fence: ctx.fence, identity: ctx.identity, record: handoffRecord(), outbox: outboxPayload(),
  }, 1_500);
  const replay = ctx.handoffStore.fencedCreate({
    fence: ctx.fence, identity: ctx.identity, record: handoffRecord({ taskText: "rewritten" }), outbox: outboxPayload(),
  }, 1_600);

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.handoff.taskText, "bounded task");
  assert.equal(ctx.handoffStore.list().length, 1);
  assert.equal(enqueuedEnvelopes(ctx.dbPath).length, 1);
});

// ---------------------------------------------------------------------------
// Required test 5 — fence replacement before continuation close / reject
// ---------------------------------------------------------------------------

const withOpenContinuation = () => {
  const ctx = setup();
  const created = ctx.handoffStore.fencedCreate({
    fence: ctx.fence, identity: ctx.identity, record: handoffRecord(), outbox: outboxPayload(),
  }, 1_500);
  assert.equal(created.ok, true);
  return ctx;
};

test("a stale generation cannot CLOSE a continuation", () => {
  const ctx = withOpenContinuation();
  replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: 2_000 });

  const closed = ctx.handoffStore.fencedClose({
    fence: ctx.fence,
    identity: ctx.identity,
    handoffMsgId: "h1",
    replySenderId: TARGET,
    replyConversationId: derivedHandoffConversationId("h1"),
    closedByMessageId: "c1",
  }, 2_000);

  assert.equal(closed.ok, false);
  assert.equal(closed.reason, "handoff-continuation-stale-binding");
  const row = ctx.handoffStore.get("h1");
  assert.equal(row.state, "open");
  assert.equal(row.closedByMessageId, null);
  assert.equal(row.closedAt, null);
});

test("a stale generation cannot TERMINALIZE a continuation", () => {
  const ctx = withOpenContinuation();
  replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: 2_000 });

  const terminated = ctx.handoffStore.fencedTerminate({
    fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1", reason: HANDOFF_REASONS.continuationSessionUnavailable,
  }, 2_000);

  assert.equal(terminated.ok, false);
  assert.equal(terminated.changed, 0);
  const row = ctx.handoffStore.get("h1");
  assert.equal(row.state, "open");
  assert.equal(row.terminalReason, null);
});

test("losing only the wake_dispatch assignment is also a lost fence", () => {
  const ctx = withOpenContinuation();
  // The binding is still live, but the dispatch ownership row was released to a retry:
  // authority over THIS message is gone even though the binding generation is current.
  ctx.dispatchStore.db.exec(`UPDATE wake_dispatch SET owner_binding_id = NULL, owner_generation = NULL,
    fencing_token = NULL, fencing_epoch = NULL WHERE msg_id = 'root-1'`);

  assert.equal(ctx.handoffStore.fenceIsCurrent(ctx.fence, ctx.identity), false);
  assert.equal(ctx.handoffStore.fenceIsCurrent(ctx.fence), true, "the binding itself is still current");
  const closed = ctx.handoffStore.fencedClose({
    fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1",
    replySenderId: TARGET, replyConversationId: derivedHandoffConversationId("h1"), closedByMessageId: "c1",
  }, 2_000);
  assert.equal(closed.ok, false);
  assert.equal(ctx.handoffStore.get("h1").state, "open");
});

test("a CURRENT generation closes exactly once and a distinct second reply still cannot resume", () => {
  const ctx = withOpenContinuation();
  const conv = derivedHandoffConversationId("h1");
  const first = ctx.handoffStore.fencedClose({
    fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1",
    replySenderId: TARGET, replyConversationId: conv, closedByMessageId: "c1",
  }, 1_600);
  assert.equal(first.ok, true);
  assert.equal(first.closed, true);

  const replay = ctx.handoffStore.fencedClose({
    fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1",
    replySenderId: TARGET, replyConversationId: conv, closedByMessageId: "c1",
  }, 1_700);
  assert.equal(replay.closed, false);
  assert.equal(replay.replay, true, "the SAME closing message may finish work it already claimed");

  const second = ctx.handoffStore.fencedClose({
    fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1",
    replySenderId: TARGET, replyConversationId: conv, closedByMessageId: "c2",
  }, 1_800);
  assert.equal(second.closed, false);
  assert.equal(second.replay, false);
  assert.equal(second.reason, "handoff-continuation-already-closed");
  assert.equal(ctx.handoffStore.get("h1").closedByMessageId, "c1");
});

// ---------------------------------------------------------------------------
// HIGH 1 at the durable boundary — wrong derived conversation
// ---------------------------------------------------------------------------

test("a reply with exact msgId and expected sender but the WRONG conversation closes nothing", () => {
  const ctx = withOpenContinuation();
  for (const wrong of ["conv-root", derivedHandoffConversationId("h2"), "handoff:", "", "attacker-conversation"]) {
    const closed = ctx.handoffStore.fencedClose({
      fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1",
      replySenderId: TARGET, replyConversationId: wrong, closedByMessageId: "c1",
    }, 1_600);
    assert.equal(closed.ok, true, "the fence itself was fine");
    assert.equal(closed.closed, false, `must not close for conversation ${JSON.stringify(wrong)}`);
    assert.equal(closed.reason, "handoff-continuation-conversation-mismatch");
    const row = ctx.handoffStore.get("h1");
    assert.equal(row.state, "open");
    assert.equal(row.closedByMessageId, null);
    assert.equal(row.closedAt, null);
    assert.equal(row.terminalReason, null);
  }
  // and the correct derived conversation still succeeds afterwards, exactly once
  const ok = ctx.handoffStore.fencedClose({
    fence: ctx.fence, identity: ctx.identity, handoffMsgId: "h1",
    replySenderId: TARGET, replyConversationId: derivedHandoffConversationId("h1"), closedByMessageId: "c1",
  }, 1_700);
  assert.equal(ok.closed, true);
  assert.equal(ctx.handoffStore.get("h1").closedByMessageId, "c1");
});

// ---------------------------------------------------------------------------
// Required test 6 — genuinely separate processes / connections
// ---------------------------------------------------------------------------

const runContender = (dbPath, operation) => new Promise((resolve, reject) => {
  const helper = path.join(import.meta.dirname, "fixtures", "handoff-fence-contender.mjs");
  const child = fork(helper, [dbPath, JSON.stringify(operation)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child.stderr.on("data", () => {});
  let ready = false;
  child.on("error", reject);
  child.on("message", (message) => {
    if (message.type === "ready") {
      ready = true;
      resolve({
        child,
        release: () => child.send("start"),
        outcome: new Promise((res, rej) => {
          child.on("message", (m) => {
            if (m.type === "result") res(m.result);
            if (m.type === "error") rej(new Error(m.error));
          });
        }),
      });
    }
  });
  child.on("exit", (code) => {
    if (!ready && code !== 0) reject(new Error(`handoff-fence-contender-exit-${code}`));
  });
});

test("a separate PROCESS holding a stale fence cannot create a continuation or an outbox row", async () => {
  const ctx = setup();
  const contender = await runContender(ctx.dbPath, {
    kind: "create",
    fence: ctx.fence,
    identity: ctx.identity,
    record: handoffRecord(),
    outbox: outboxPayload(),
    now: 2_000,
  });
  try {
    // The replacement lands BEFORE the contender is released, so its fence is stale by the
    // time its own transaction opens on its own connection.
    replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: 1_900 });
    contender.release();
    const result = await contender.outcome;

    assert.equal(result.ok, false);
    assert.equal(result.reason, "handoff-continuation-stale-binding");
    assert.deepEqual(ctx.handoffStore.list(), [], "no continuation from another process");
    assert.deepEqual(enqueuedEnvelopes(ctx.dbPath), [], "no outbound handoff from another process");
  } finally {
    if (contender.child.connected) contender.child.disconnect();
  }
});

test("a separate PROCESS holding a CURRENT fence does commit, and is visible to the parent connection", async () => {
  const ctx = setup();
  const contender = await runContender(ctx.dbPath, {
    kind: "create",
    fence: ctx.fence,
    identity: ctx.identity,
    record: handoffRecord(),
    outbox: outboxPayload(),
    now: 1_500,
  });
  try {
    contender.release();
    const result = await contender.outcome;
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    // read through the PARENT's own connection
    assert.equal(ctx.handoffStore.get("h1").state, "open");
    assert.equal(enqueuedEnvelopes(ctx.dbPath).length, 1);
  } finally {
    if (contender.child.connected) contender.child.disconnect();
  }
});

test("a separate PROCESS holding a stale fence cannot close or terminalize a continuation", async () => {
  const ctx = withOpenContinuation();
  const conv = derivedHandoffConversationId("h1");
  const closer = await runContender(ctx.dbPath, {
    kind: "close",
    fence: ctx.fence,
    identity: ctx.identity,
    handoffMsgId: "h1",
    replySenderId: TARGET,
    replyConversationId: conv,
    closedByMessageId: "c1",
    now: 2_000,
  });
  const terminator = await runContender(ctx.dbPath, {
    kind: "terminate",
    fence: ctx.fence,
    identity: ctx.identity,
    handoffMsgId: "h1",
    reason: HANDOFF_REASONS.continuationSessionUnavailable,
    now: 2_000,
  });
  try {
    replaceBindingGeneration(ctx.bindingStore, "binding-a", { now: 1_900 });
    closer.release();
    terminator.release();
    const [closed, terminated] = await Promise.all([closer.outcome, terminator.outcome]);

    assert.equal(closed.ok, false);
    assert.equal(terminated.ok, false);
    const row = ctx.handoffStore.get("h1");
    assert.equal(row.state, "open");
    assert.equal(row.closedByMessageId, null);
    assert.equal(row.terminalReason, null);
  } finally {
    for (const c of [closer, terminator]) if (c.child.connected) c.child.disconnect();
  }
});

test("two separate PROCESSES racing the same close produce exactly one winner", async () => {
  const ctx = withOpenContinuation();
  const conv = derivedHandoffConversationId("h1");
  const op = {
    kind: "close",
    fence: ctx.fence,
    identity: ctx.identity,
    handoffMsgId: "h1",
    replySenderId: TARGET,
    replyConversationId: conv,
    now: 1_600,
  };
  const a = await runContender(ctx.dbPath, { ...op, closedByMessageId: "c1" });
  const b = await runContender(ctx.dbPath, { ...op, closedByMessageId: "c2" });
  try {
    a.release();
    b.release();
    const results = await Promise.all([a.outcome, b.outcome]);
    assert.equal(results.filter((r) => r.closed === true).length, 1, "exactly one close wins");
    const loser = results.find((r) => r.closed !== true);
    assert.equal(loser.reason, "handoff-continuation-already-closed");
    const row = ctx.handoffStore.get("h1");
    assert.equal(row.state, "closed");
    assert.ok(["c1", "c2"].includes(row.closedByMessageId));
  } finally {
    for (const c of [a, b]) if (c.child.connected) c.child.disconnect();
  }
});
