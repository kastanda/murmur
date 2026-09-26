/**
 * Deterministic three-agent handoff fixtures: Claude -> Codex -> Claude -> Cursor -> Claude
 * (sibling) and Claude -> Codex -> Cursor -> Codex -> Claude (nested).
 *
 * No human copies a message: every hop is a signed-shape envelope routed by the paired
 * peer subject through the real controller, store, coordinator and runtime adapters.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HandoffMesh, MEMBER_SLOTS, handoffAction } from "./fixtures/handoff-mesh.mjs";

const meshes = [];
test.afterEach(() => {
  while (meshes.length) {
    const { mesh, dir } = meshes.pop();
    mesh.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const newMesh = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-mesh-"));
  const mesh = new HandoffMesh({ dir });
  meshes.push({ mesh, dir });
  return mesh;
};

test("three-agent fixture: Claude delegates to Codex, resumes, delegates to Cursor, resumes, answers the root", async () => {
  const mesh = newMesh();
  const claude = mesh.agent({
    agentId: "claude-agent",
    kind: "claude",
    respond: ({ prompt, turnIndex }) => {
      if (turnIndex === 0) {
        assert.match(prompt, /ship the release/);
        assert.match(prompt, /MURMUR HANDOFF PROTOCOL/);
        return handoffAction("codex-agent", "audit the outbox retry path");
      }
      if (turnIndex === 1) {
        assert.match(prompt, /MURMUR HANDOFF RESULT/);
        assert.match(prompt, /delegatedTo=codex-agent/);
        assert.match(prompt, /codex: retry path is sound/);
        return handoffAction("cursor-agent", "check the ACP reconnect path");
      }
      assert.equal(turnIndex, 2);
      assert.match(prompt, /delegatedTo=cursor-agent/);
      assert.match(prompt, /cursor: reconnect path is sound/);
      return "release is ready: retries and reconnect both verified";
    },
  });
  const codex = mesh.agent({
    agentId: "codex-agent",
    kind: "codex",
    respond: ({ prompt }) => {
      assert.match(prompt, /MURMUR HANDOFF TASK/);
      assert.match(prompt, /audit the outbox retry path/);
      return "codex: retry path is sound";
    },
  });
  const cursor = mesh.agent({
    agentId: "cursor-agent",
    kind: "cursor",
    respond: ({ prompt }) => {
      assert.match(prompt, /check the ACP reconnect path/);
      return "cursor: reconnect path is sound";
    },
  });
  claude.pairWith(codex).pairWith(cursor);
  codex.pairWith(claude);
  cursor.pairWith(claude);
  await claude.start();
  await codex.start();
  await cursor.start();

  await mesh.run({ to: "claude-agent", text: "ship the release" });

  // ----- exact wire shape -----
  const handoffs = mesh.handoffs();
  assert.equal(handoffs.length, 2, "exactly two delegations");
  const [h1, h2] = handoffs;

  assert.equal(h1.from, "claude-agent");
  assert.equal(h1.to, "codex-agent");
  assert.equal(h1.handoff.rootMessageId, "root-1");
  assert.equal(h1.handoff.rootConversationId, "conv-root");
  assert.equal(h1.handoff.causedByMessageId, "root-1");
  assert.deepEqual(h1.handoff.ancestry, ["claude-agent"]);
  assert.equal(h1.conversationId, `handoff:${h1.msgId}`);
  assert.notEqual(h1.conversationId, "conv-root", "the derived conversation is isolated from the root");
  assert.equal(h1.envelope.schemaVersion, "1.1");
  assert.equal(h1.envelope.replyToMessageId, undefined);
  assert.deepEqual(h1.envelope.recipients, ["codex-agent"]);
  assert.equal(h1.text, "audit the outbox retry path");

  const replies = mesh.replies();
  const c1 = replies.find((reply) => reply.replyToMessageId === h1.msgId);
  assert.ok(c1, "Codex returned an exactly correlated result");
  assert.equal(c1.from, "codex-agent");
  assert.equal(c1.to, "claude-agent");
  assert.equal(c1.conversationId, h1.conversationId, "the result rides the derived handoff conversation");
  assert.equal(c1.text, "codex: retry path is sound");

  assert.equal(h2.from, "claude-agent");
  assert.equal(h2.to, "cursor-agent");
  assert.equal(h2.handoff.rootMessageId, "root-1", "root lineage unchanged");
  assert.equal(h2.handoff.rootConversationId, "conv-root", "root conversation unchanged");
  assert.equal(h2.handoff.causedByMessageId, c1.msgId, "causedBy advances to the exact child result");
  assert.deepEqual(h2.handoff.ancestry, ["claude-agent"],
    "the completed Codex branch is NOT in the active path of a sibling delegation");
  assert.equal(h2.conversationId, `handoff:${h2.msgId}`);
  assert.notEqual(h2.conversationId, h1.conversationId);

  const c2 = replies.find((reply) => reply.replyToMessageId === h2.msgId);
  assert.ok(c2);
  assert.equal(c2.from, "cursor-agent");
  assert.equal(c2.conversationId, h2.conversationId);

  // ----- the final answer goes to the ROOT request -----
  const finals = replies.filter((reply) => reply.replyToMessageId === "root-1");
  assert.equal(finals.length, 1, "exactly one root reply");
  assert.equal(finals[0].to, "human-agent");
  assert.equal(finals[0].conversationId, "conv-root");
  assert.equal(finals[0].text, "release is ready: retries and reconnect both verified");

  // ----- no premature parent reply -----
  assert.equal(mesh.wire.indexOf(h1) < mesh.wire.indexOf(c1), true);
  assert.equal(mesh.wire.indexOf(c1) < mesh.wire.indexOf(h2), true);
  assert.equal(mesh.wire.indexOf(c2) < mesh.wire.indexOf(finals[0]), true);
  assert.equal(replies.filter((reply) => reply.to === "human-agent").length, 1,
    "the root sender hears nothing until the delegations complete");

  // ----- exactly one continuation close each, none left open -----
  const continuations = claude.handoffStore.list();
  assert.equal(continuations.length, 2);
  assert.deepEqual(continuations.map((row) => row.state), ["closed", "closed"]);
  assert.deepEqual(continuations.map((row) => row.closedByMessageId), [c1.msgId, c2.msgId]);
  assert.deepEqual(continuations.map((row) => row.parentActiveAncestry), [[], []]);
  assert.deepEqual(claude.openContinuations(), []);
  assert.deepEqual(codex.handoffStore.list(), [], "Codex created no delegation of its own");
  assert.deepEqual(cursor.handoffStore.list(), []);

  // ----- no duplicate runtime execution -----
  assert.equal(claude.turns.length, 3);
  assert.equal(codex.turns.length, 1);
  assert.equal(cursor.turns.length, 1);

  // ----- Claude resumed its ORIGINATING session, not a fresh one -----
  const claudeSessions = new Set(claude.modelSessions);
  assert.equal(claudeSessions.size, 1, "all three Claude turns ran in one logical session");
  assert.deepEqual(claude.resumes.map((call) => call.resume), [false, true, true]);
  assert.equal(continuations[0].originatingRuntimeSessionId, claude.modelSessions[0]);
  assert.equal(continuations[1].originatingRuntimeSessionId, claude.modelSessions[0]);

  // ----- no cross-talk -----
  assert.equal(mesh.wire.every((message) => message.to !== message.from), true);
  assert.equal(handoffs.every((message) => message.envelope.recipients.length === 1), true);
});

test("nested fixture: Codex delegates to Cursor BEFORE replying, then answers Claude", async () => {
  const mesh = newMesh();
  const claude = mesh.agent({
    agentId: "claude-agent",
    kind: "claude",
    respond: ({ prompt, turnIndex }) => {
      if (turnIndex === 0) return handoffAction("codex-agent", "review the wire revision");
      assert.equal(turnIndex, 1);
      assert.match(prompt, /codex: reviewed with cursor's help/);
      return "final: wire revision approved";
    },
  });
  const codex = mesh.agent({
    agentId: "codex-agent",
    kind: "codex",
    respond: ({ prompt, turnIndex }) => {
      if (turnIndex === 0) {
        assert.match(prompt, /activeDelegationPath=claude-agent/);
        return handoffAction("cursor-agent", "double-check the canonical bytes");
      }
      assert.equal(turnIndex, 1);
      assert.match(prompt, /MURMUR HANDOFF RESULT/);
      assert.match(prompt, /cursor: bytes look right/);
      return "codex: reviewed with cursor's help";
    },
  });
  const cursor = mesh.agent({
    agentId: "cursor-agent",
    kind: "cursor",
    respond: ({ prompt }) => {
      assert.match(prompt, /activeDelegationPath=claude-agent -> codex-agent/);
      return "cursor: bytes look right";
    },
  });
  claude.pairWith(codex).pairWith(cursor);
  codex.pairWith(claude).pairWith(cursor);
  cursor.pairWith(claude).pairWith(codex);
  await claude.start();
  await codex.start();
  await cursor.start();

  await mesh.run({ to: "claude-agent", text: "review the release wire change" });

  const [h1, h2] = mesh.handoffs();
  assert.equal(mesh.handoffs().length, 2);
  assert.deepEqual(h1.handoff.ancestry, ["claude-agent"]);
  assert.equal(h1.to, "codex-agent");
  assert.deepEqual(h2.handoff.ancestry, ["claude-agent", "codex-agent"],
    "a nested delegation appends the CURRENT sender to the inherited active path");
  assert.equal(h2.from, "codex-agent");
  assert.equal(h2.to, "cursor-agent");
  // root lineage survives nesting untouched
  assert.equal(h2.handoff.rootMessageId, "root-1");
  assert.equal(h2.handoff.rootConversationId, "conv-root");
  assert.equal(h2.handoff.causedByMessageId, h1.msgId, "the inbound handoff caused the nested delegation");
  assert.equal(h2.conversationId, `handoff:${h2.msgId}`);

  const replies = mesh.replies();
  const c2 = replies.find((reply) => reply.replyToMessageId === h2.msgId);
  assert.ok(c2, "Cursor replied exactly to H2");
  assert.equal(c2.from, "cursor-agent");
  assert.equal(c2.to, "codex-agent");
  const c1 = replies.find((reply) => reply.replyToMessageId === h1.msgId);
  assert.ok(c1, "Codex replied exactly to H1 after its own child completed");
  assert.equal(c1.from, "codex-agent");
  assert.equal(c1.to, "claude-agent");
  assert.equal(c1.conversationId, h1.conversationId);
  const final = replies.find((reply) => reply.replyToMessageId === "root-1");
  assert.ok(final);
  assert.equal(final.text, "final: wire revision approved");

  // ordering: nested child completes before the intermediate parent answers
  assert.ok(mesh.wire.indexOf(h2) < mesh.wire.indexOf(c2));
  assert.ok(mesh.wire.indexOf(c2) < mesh.wire.indexOf(c1));
  assert.ok(mesh.wire.indexOf(c1) < mesh.wire.indexOf(final));
  assert.equal(replies.filter((reply) => reply.to === "claude-agent" && reply.replyToMessageId === h1.msgId).length, 1);

  // continuations: one per delegator, each closed exactly once, parent paths restored
  const claudeRows = claude.handoffStore.list();
  const codexRows = codex.handoffStore.list();
  assert.equal(claudeRows.length, 1);
  assert.equal(codexRows.length, 1);
  assert.equal(claudeRows[0].state, "closed");
  assert.deepEqual(claudeRows[0].parentActiveAncestry, []);
  assert.equal(claudeRows[0].closedByMessageId, c1.msgId);
  assert.equal(codexRows[0].state, "closed");
  assert.deepEqual(codexRows[0].parentActiveAncestry, ["claude-agent"]);
  assert.equal(codexRows[0].closedByMessageId, c2.msgId);
  assert.deepEqual(cursor.handoffStore.list(), []);

  // Codex resumed its ORIGINATING thread, not one derived from the child sender
  assert.equal(codex.turns.length, 2);
  assert.equal(new Set(codex.codexThreads).size, 1, "both Codex turns ran in one thread");
  assert.equal(codexRows[0].originatingRuntimeSessionId, codex.codexThreads[0]);
  assert.equal(codexRows[0].originatingServerIdentity, mesh.codexServerIdentity);
  assert.equal(claude.turns.length, 2);
  assert.equal(cursor.turns.length, 1);
});

test("a sibling delegation to the agent that just finished is allowed, a live cycle is not", async () => {
  const mesh = newMesh();
  const claude = mesh.agent({
    agentId: "claude-agent",
    kind: "claude",
    respond: ({ turnIndex }) => (turnIndex === 0
      ? handoffAction("codex-agent", "first pass")
      : turnIndex === 1
        ? handoffAction("codex-agent", "second pass")
        : "done"),
  });
  const codex = mesh.agent({
    agentId: "codex-agent",
    kind: "codex",
    // Codex tries to delegate BACK to Claude, which is live on the active path.
    respond: ({ turnIndex }) => (turnIndex === 0
      ? "codex: first pass complete"
      : handoffAction("claude-agent", "please do it yourself")),
  });
  claude.pairWith(codex);
  codex.pairWith(claude);
  await claude.start();
  await codex.start();

  await mesh.run({ to: "claude-agent", text: "two passes please" });

  const handoffs = mesh.handoffs();
  assert.equal(handoffs.length, 2, "both sibling delegations to the SAME completed agent are allowed");
  assert.deepEqual(handoffs.map((message) => message.to), ["codex-agent", "codex-agent"]);
  assert.deepEqual(handoffs[0].handoff.ancestry, ["claude-agent"]);
  assert.deepEqual(handoffs[1].handoff.ancestry, ["claude-agent"], "no false cycle for a sibling delegation");
  assert.notEqual(handoffs[0].msgId, handoffs[1].msgId);
  assert.notEqual(handoffs[0].conversationId, handoffs[1].conversationId);

  // Codex's attempt to delegate back into the live active path never reaches the wire.
  assert.equal(handoffs.filter((message) => message.to === "claude-agent").length, 0);
  assert.equal(codex.handoffStore.list().length, 0, "a real cycle creates no continuation");
  const codexDispatch = codex.dispatchStore.list().find((row) => row.msgId === handoffs[1].msgId);
  // A deterministic sender-side refusal fails the turn; the existing at-least-once budget
  // then retries the model (which repeats the same refusal) until it is exhausted, so the
  // row settles as `failed` or `terminal` depending on how many retries the drain spent.
  assert.ok(["failed", "terminal"].includes(codexDispatch.state),
    `the cycle attempt fails closed and is not a model reply (state=${codexDispatch.state})`);
  assert.match(codexDispatch.lastError, /handoff-cycle/);
  // and Claude never receives a bogus result for H2
  assert.equal(mesh.replies().filter((reply) => reply.replyToMessageId === handoffs[1].msgId).length, 0);
  assert.equal(MEMBER_SLOTS.claude, "claude:auto");
});
