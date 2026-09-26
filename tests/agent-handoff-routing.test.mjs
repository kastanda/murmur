import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HANDOFF_REASONS,
  HANDOFF_WIRE_VERSION,
  derivedHandoffConversationId,
  isEnvelopeV1,
  isEnvelopeV11,
  isSupportedEnvelope,
  stableEnvelopePayload,
} from "../packages/core/dist/src/index.js";
import { createKeyPair, createSigningKeyPair, signEnvelope, verifyEnvelopeSignature } from "@murmurv2/security";
import { admitInboundHandoff } from "../scripts/agent-handoff-controller.mjs";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";

const CLAUDE = "claude-agent";
const CODEX = "codex-agent";
const CURSOR = "cursor-agent";

const lineage = (overrides = {}) => ({
  rootMessageId: "root-1",
  rootConversationId: "conv-root",
  causedByMessageId: "root-1",
  ancestry: [CLAUDE],
  ...overrides,
});

const handoffEnvelope = (overrides = {}) => ({
  schemaVersion: HANDOFF_WIRE_VERSION,
  msgId: "h1",
  conversationId: derivedHandoffConversationId("h1"),
  senderAgentId: CLAUDE,
  recipients: [CODEX],
  createdAt: "2026-09-26T00:00:00.000Z",
  payloadCiphertext: "ct",
  payloadNonce: "no",
  handoff: lineage(),
  signature: "sig",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Signed 1.1 wire: real Ed25519 round trip
// ---------------------------------------------------------------------------

test("a real signed 1.1 handoff verifies, and mutating ANY lineage field breaks verification", async () => {
  const signing = await createSigningKeyPair();
  const envelope = handoffEnvelope({ signature: "" });
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), signing.privateKey);
  assert.equal(await verifyEnvelopeSignature(stableEnvelopePayload(envelope), envelope.signature, signing.publicKey), true);

  const mutations = [
    ["rootMessageId", { ...envelope, handoff: lineage({ rootMessageId: "root-2" }) }],
    ["rootConversationId", { ...envelope, handoff: lineage({ rootConversationId: "conv-other" }) }],
    ["causedByMessageId", { ...envelope, handoff: lineage({ causedByMessageId: "c1" }) }],
    ["ancestry append", { ...envelope, handoff: lineage({ ancestry: [CLAUDE, CODEX] }) }],
    ["ancestry replace", { ...envelope, handoff: lineage({ ancestry: [CURSOR] }) }],
    ["recipient", { ...envelope, recipients: [CURSOR] }],
    ["conversation", { ...envelope, conversationId: "conv-root" }],
  ];
  for (const [label, mutated] of mutations) {
    assert.equal(
      await verifyEnvelopeSignature(stableEnvelopePayload(mutated), envelope.signature, signing.publicKey),
      false,
      `mutation must break verification: ${label}`,
    );
  }
  // stripping the lineage entirely also breaks verification
  const stripped = { ...envelope };
  delete stripped.handoff;
  assert.equal(await verifyEnvelopeSignature(stableEnvelopePayload(stripped), envelope.signature, signing.publicKey), false);
});

test("a 1.1 handoff cannot be downgraded to an unsigned-metadata 1.0 envelope", async () => {
  const signing = await createSigningKeyPair();
  const envelope = handoffEnvelope({ signature: "" });
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), signing.privateKey);
  const downgraded = { ...envelope, schemaVersion: "1.0" };
  // structurally refused by both readers...
  assert.equal(isEnvelopeV1(downgraded), false);
  assert.equal(isEnvelopeV11(downgraded), false);
  assert.equal(isSupportedEnvelope(downgraded), false);
  // ...and the signature no longer verifies either
  assert.equal(await verifyEnvelopeSignature(stableEnvelopePayload(downgraded), envelope.signature, signing.publicKey), false);
});

test("an encrypted handoff payload is still end-to-end sealed to the recipient", async () => {
  // Handoff adds signed metadata only; the bounded task text stays in the sealed payload.
  const sender = await createKeyPair();
  const recipient = await createKeyPair();
  const { encryptPayload, decryptPayload } = await import("@murmurv2/security");
  const sealed = await encryptPayload("bounded task", recipient.publicKey, sender.privateKey);
  const envelope = handoffEnvelope({ payloadCiphertext: sealed.ciphertext, payloadNonce: sealed.nonce });
  assert.equal(isEnvelopeV11(envelope), true);
  assert.equal(await decryptPayload(
    { ciphertext: envelope.payloadCiphertext, nonce: envelope.payloadNonce, senderPublicKey: sender.publicKey },
    recipient.privateKey,
  ), "bounded task");
});

// ---------------------------------------------------------------------------
// Receiver-side admission (before any model execution)
// ---------------------------------------------------------------------------

test("a handoff addressed to a different agent fails closed before runtime execution", () => {
  const admission = admitInboundHandoff({
    envelope: handoffEnvelope(),
    localAgentId: CURSOR,
    hasAutonomousRuntime: true,
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, HANDOFF_REASONS.recipientMismatch);
});

test("multiple recipients are refused for a handoff", () => {
  const admission = admitInboundHandoff({
    envelope: handoffEnvelope({ recipients: [CODEX, CURSOR] }),
    localAgentId: CODEX,
    hasAutonomousRuntime: true,
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, HANDOFF_REASONS.recipientsInvalid);
});

test("handoff + replyToMessageId is refused (the two structural cases are exclusive)", () => {
  const admission = admitInboundHandoff({
    envelope: handoffEnvelope({ replyToMessageId: "root-1" }),
    localAgentId: CODEX,
    hasAutonomousRuntime: true,
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, HANDOFF_REASONS.replyConflict);
});

test("receiver-side ancestry, loop, self and depth rules all fail closed with stable reasons", () => {
  const cases = [
    [handoffEnvelope({ senderAgentId: CODEX, recipients: [CODEX], handoff: lineage({ ancestry: [CODEX] }) }), CODEX, HANDOFF_REASONS.self],
    [handoffEnvelope({ handoff: lineage({ ancestry: [CODEX, CLAUDE] }) }), CODEX, HANDOFF_REASONS.cycle],
    [handoffEnvelope({ senderAgentId: CURSOR }), CODEX, HANDOFF_REASONS.ancestrySenderMismatch],
    [handoffEnvelope({ handoff: lineage({ ancestry: ["a", "b", "c", "d", CLAUDE] }) }), CODEX, HANDOFF_REASONS.depthExceeded],
    [handoffEnvelope({ handoff: lineage({ ancestry: [CLAUDE, CLAUDE] }) }), CODEX, HANDOFF_REASONS.lineageInvalid],
    [handoffEnvelope({ handoff: lineage({ rootConversationId: "" }) }), CODEX, HANDOFF_REASONS.lineageInvalid],
    [handoffEnvelope({ handoff: lineage({ causedByMessageId: "" }) }), CODEX, HANDOFF_REASONS.lineageInvalid],
    [handoffEnvelope({ handoff: undefined }), CODEX, HANDOFF_REASONS.lineageInvalid],
  ];
  for (const [envelope, localAgentId, reason] of cases) {
    const admission = admitInboundHandoff({ envelope, localAgentId, hasAutonomousRuntime: true });
    assert.equal(admission.ok, false, `must refuse: ${reason}`);
    assert.equal(admission.reason, reason);
  }
});

test("an unsigned parentMsgId cannot substitute for signed handoff lineage", () => {
  const admission = admitInboundHandoff({
    envelope: handoffEnvelope({ handoff: undefined, parentMsgId: "root-1" }),
    localAgentId: CODEX,
    hasAutonomousRuntime: true,
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, HANDOFF_REASONS.lineageInvalid);
});

test("a valid handoff with no autonomous runtime is refused, never downgraded", () => {
  const admission = admitInboundHandoff({ envelope: handoffEnvelope(), localAgentId: CODEX, hasAutonomousRuntime: false });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, HANDOFF_REASONS.runtimeUnavailable);
  assert.equal(admitInboundHandoff({ envelope: handoffEnvelope(), localAgentId: CODEX, hasAutonomousRuntime: true }).ok, true);
});

test("the configured maximum active depth is honoured", () => {
  const deep = handoffEnvelope({ handoff: lineage({ ancestry: ["a", "b", CLAUDE] }) });
  assert.equal(admitInboundHandoff({ envelope: deep, localAgentId: CODEX, maxDepth: 4, hasAutonomousRuntime: true }).ok, true);
  assert.equal(admitInboundHandoff({ envelope: deep, localAgentId: CODEX, maxDepth: 2, hasAutonomousRuntime: true }).reason,
    HANDOFF_REASONS.depthExceeded);
});

// ---------------------------------------------------------------------------
// WakeMonitor routing: handoff never falls back
// ---------------------------------------------------------------------------

const contexts = [];
test.afterEach(() => {
  while (contexts.length) {
    const ctx = contexts.pop();
    ctx.dispatchStore.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

const monitorSetup = ({ runtimeDispatcher = null, hook = null, auditHook = null, memberSlot = "claude:auto" } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-routing-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: CODEX, maxAttempts: 3 });
  const runtimeCalls = [];
  const hookCalls = [];
  const rejections = [];
  const monitor = new WakeMonitor({
    dispatchStore,
    runtimeDispatcher: runtimeDispatcher === "record"
      ? async (payload, dispatch) => {
        runtimeCalls.push(payload.msgId);
        dispatchStore.markHandedOff(dispatch);
      }
      : runtimeDispatcher,
    hook: hook === "record" ? async (payload) => { hookCalls.push(payload.msgId); } : hook,
    auditHook,
    onHandoffRejected: async (payload, failure) => { rejections.push({ msgId: payload.msgId, ...failure }); },
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
  });
  const ctx = { dir, dispatchStore, monitor, runtimeCalls, hookCalls, rejections, memberSlot };
  contexts.push(ctx);
  return ctx;
};

const inboundHandoff = (ctx, overrides = {}) => ({
  from: CLAUDE,
  text: "bounded task",
  msgId: "h1",
  conversationId: derivedHandoffConversationId("h1"),
  memberSlot: ctx.memberSlot,
  handoff: lineage(),
  cursor: 1,
  ...overrides,
});

test("a handoff routes ONLY to the exact autonomous runtime adapter", async () => {
  const ctx = monitorSetup({ runtimeDispatcher: "record", hook: "record" });
  await ctx.monitor.onInbound(inboundHandoff(ctx));
  assert.deepEqual(ctx.runtimeCalls, ["h1"]);
  assert.deepEqual(ctx.hookCalls, []);
  assert.deepEqual(ctx.rejections, []);
});

test("a handoff NEVER falls back to the legacy wake hook", async () => {
  const ctx = monitorSetup({ hook: "record" });
  await ctx.monitor.onInbound(inboundHandoff(ctx));
  assert.deepEqual(ctx.hookCalls, []);
  assert.equal(ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot }).state, "rejected");
  assert.deepEqual(ctx.rejections, [{ msgId: "h1", reason: "handoff-runtime-unavailable", detail: "no-autonomous-runtime-adapter" }]);
});

test("a handoff NEVER falls back to the stateless inbox", async () => {
  const ctx = monitorSetup();
  await ctx.monitor.onInbound(inboundHandoff(ctx));
  const row = ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot });
  assert.equal(row.state, "rejected");
  assert.equal(row.lastError, "handoff-runtime-unavailable");
  assert.equal(ctx.rejections.length, 1);
});

test("an ORDINARY message still uses the legacy hook and stateless paths unchanged", async () => {
  const ctx = monitorSetup({ hook: "record" });
  await ctx.monitor.onInbound({ from: CLAUDE, text: "hi", msgId: "m1", conversationId: "conv", memberSlot: ctx.memberSlot, cursor: 1 });
  assert.deepEqual(ctx.hookCalls, ["m1"]);
  assert.deepEqual(ctx.rejections, []);
  assert.equal(ctx.dispatchStore.get({ msgId: "m1", recipientId: CODEX, memberSlot: ctx.memberSlot }).state, "handed_off");
});

test("audit deny rejects a handoff before runtime execution and returns an authorization failure", async () => {
  const ctx = monitorSetup({ runtimeDispatcher: "record", auditHook: async () => "deny" });
  await ctx.monitor.onInbound(inboundHandoff(ctx));
  assert.deepEqual(ctx.runtimeCalls, []);
  const row = ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot });
  assert.equal(row.state, "rejected");
  assert.equal(row.lastError, "audit-denied");
  assert.deepEqual(ctx.rejections, [{ msgId: "h1", reason: "handoff-unauthorized", detail: "audit-denied" }]);
});

test("audit require_approval preserves DEFERRED semantics and sends no failure result", async () => {
  const ctx = monitorSetup({ runtimeDispatcher: "record", auditHook: async () => "require_approval" });
  await ctx.monitor.onInbound(inboundHandoff(ctx));
  assert.deepEqual(ctx.runtimeCalls, []);
  const row = ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot });
  assert.equal(row.state, "deferred");
  assert.equal(row.lastError, "audit-requires-approval");
  assert.deepEqual(ctx.rejections, [], "a deferred approval is not a terminal failure");
});

test("an unknown member slot fails closed with no runtime fallback", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-handoff-slot-"));
  const dispatchStore = new WakeDispatchStore(path.join(dir, "murmur.db"), { recipientId: CODEX, maxAttempts: 1 });
  try {
    const { AgentRuntimeRegistry } = await import("../scripts/agent-runtime-registry.mjs");
    const registry = new AgentRuntimeRegistry([]);
    await assert.rejects(
      registry.executeTurn({ msgId: "h1" }, { memberSlot: "ghost:slot" }),
      /runtime-adapter-unavailable:ghost:slot/,
    );
  } finally {
    dispatchStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused handoff is durably recorded so inbound backfill cannot resurrect it", async () => {
  const ctx = monitorSetup();
  const payload = inboundHandoff(ctx);
  ctx.dispatchStore.rejectInbound(payload, "handoff-cycle");
  const row = ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot });
  assert.equal(row.state, "rejected");
  assert.equal(row.lastError, "handoff-cycle");
  // a re-refusal is idempotent and never resets the row into an executable state
  ctx.dispatchStore.rejectInbound(payload, "handoff-cycle");
  assert.equal(ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot }).state, "rejected");
  assert.equal(ctx.dispatchStore.claimDue(), null, "a rejected row is never claimable");
});

// ---------------------------------------------------------------------------
// Derived-conversation session isolation, end to end at the admission gate
// ---------------------------------------------------------------------------

test("a correctly SIGNED handoff aimed at the wrong conversation is refused before runtime", async () => {
  const signing = await createSigningKeyPair();
  // The attacker/buggy sender signs everything correctly — including the conversation —
  // so the signature verifies. Only the derived-conversation rule stops it.
  const envelope = handoffEnvelope({ conversationId: "conv-root", signature: "" });
  envelope.signature = await signEnvelope(stableEnvelopePayload(envelope), signing.privateKey);
  assert.equal(await verifyEnvelopeSignature(stableEnvelopePayload(envelope), envelope.signature, signing.publicKey), true,
    "the signature is genuinely valid");
  assert.equal(isEnvelopeV11(envelope), true, "and it is structurally a valid 1.1 envelope");

  const admission = admitInboundHandoff({ envelope, localAgentId: CODEX, hasAutonomousRuntime: true });
  assert.equal(admission.ok, false);
  assert.equal(admission.reason, HANDOFF_REASONS.conversationMismatch);
});

test("every non-derived conversation is refused, and only handoff:<msgId> is admitted", () => {
  for (const conversationId of [
    "conv-root", "handoff:h2", "handoff:", "h1", "", "HANDOFF:h1", " handoff:h1",
  ]) {
    const admission = admitInboundHandoff({
      envelope: handoffEnvelope({ conversationId }),
      localAgentId: CODEX,
      hasAutonomousRuntime: true,
    });
    assert.equal(admission.ok, false, `must refuse conversation ${JSON.stringify(conversationId)}`);
    assert.equal(admission.reason, HANDOFF_REASONS.conversationMismatch);
  }
  assert.equal(admitInboundHandoff({
    envelope: handoffEnvelope({ msgId: "h7", conversationId: derivedHandoffConversationId("h7") }),
    localAgentId: CODEX,
    hasAutonomousRuntime: true,
  }).ok, true);
});

test("a wrong-conversation handoff is durably refused and returns a correlated failure", async () => {
  const ctx = monitorSetup({ runtimeDispatcher: "record" });
  const payload = inboundHandoff(ctx, { conversationId: "conv-root" });
  // the daemon path: admission refuses, the dispatch ledger records it, no runtime runs
  const admission = admitInboundHandoff({
    envelope: handoffEnvelope({ conversationId: "conv-root" }),
    localAgentId: CODEX,
    hasAutonomousRuntime: true,
  });
  assert.equal(admission.reason, HANDOFF_REASONS.conversationMismatch);
  ctx.dispatchStore.rejectInbound(payload, admission.reason);
  const row = ctx.dispatchStore.get({ msgId: "h1", recipientId: CODEX, memberSlot: ctx.memberSlot });
  assert.equal(row.state, "rejected");
  assert.equal(row.lastError, HANDOFF_REASONS.conversationMismatch);
  assert.deepEqual(ctx.runtimeCalls, [], "no model execution");
  assert.equal(ctx.dispatchStore.claimDue(), null, "and it is never claimable");
});
