// Golden test for the canonical envelope signing payload (single source of truth).
// stableEnvelopePayload was previously copy-pasted across mcp-server / daemon / bridges
// / demos; this locks its exact byte output so a change can't silently break cross-agent
// signature interop. If this test fails, EVERY signer must change together (wire-breaking).
import test from "node:test";
import assert from "node:assert/strict";
import { derivedHandoffConversationId, stableAckPayload, stableEnvelopePayload } from "../dist/src/index.js";

const ENV = Object.freeze({
  schemaVersion: "1.0",
  msgId: "m1",
  conversationId: "c1",
  senderAgentId: "agent-a",
  recipients: ["agent-b", "agent-c"],
  createdAt: "2026-06-22T00:00:00.000Z",
  payloadCiphertext: "ct",
  payloadNonce: "no",
  signature: "SIG-SHOULD-BE-EXCLUDED",
});

test("stableEnvelopePayload emits the exact canonical string (golden)", () => {
  assert.equal(
    stableEnvelopePayload(ENV),
    '{"schemaVersion":"1.0","msgId":"m1","conversationId":"c1","senderAgentId":"agent-a","recipients":["agent-b","agent-c"],"createdAt":"2026-06-22T00:00:00.000Z","payloadCiphertext":"ct","payloadNonce":"no"}',
  );
});

test("stableEnvelopePayload appends authToken ONLY when present (back-compat for un-authed)", () => {
  // absent → byte-identical to before the field existed (the golden above)
  assert.ok(!stableEnvelopePayload(ENV).includes("authToken"));
  // present → appended in a fixed FINAL position, so it is covered by the signature
  assert.equal(
    stableEnvelopePayload({ ...ENV, authToken: "MURMUR-AUTH:tok" }),
    '{"schemaVersion":"1.0","msgId":"m1","conversationId":"c1","senderAgentId":"agent-a","recipients":["agent-b","agent-c"],"createdAt":"2026-06-22T00:00:00.000Z","payloadCiphertext":"ct","payloadNonce":"no","authToken":"MURMUR-AUTH:tok"}',
  );
});

test("stableEnvelopePayload signs replyToMessageId while preserving legacy bytes when absent", () => {
  assert.ok(!stableEnvelopePayload(ENV).includes("replyToMessageId"));
  assert.equal(
    stableEnvelopePayload({ ...ENV, replyToMessageId: "request-1" }),
    '{"schemaVersion":"1.0","msgId":"m1","conversationId":"c1","senderAgentId":"agent-a","recipients":["agent-b","agent-c"],"createdAt":"2026-06-22T00:00:00.000Z","payloadCiphertext":"ct","payloadNonce":"no","replyToMessageId":"request-1"}',
  );
});

test("stableEnvelopePayload excludes the signature field (it is what gets signed)", () => {
  const signed = stableEnvelopePayload(ENV);
  const unsigned = stableEnvelopePayload({ ...ENV, signature: "" });
  assert.equal(signed, unsigned);
  assert.ok(!signed.includes("signature"));
});

test("stableEnvelopePayload field order is fixed regardless of input key order", () => {
  const reordered = {
    payloadNonce: "no",
    signature: "x",
    recipients: ["agent-b", "agent-c"],
    msgId: "m1",
    schemaVersion: "1.0",
    payloadCiphertext: "ct",
    createdAt: "2026-06-22T00:00:00.000Z",
    senderAgentId: "agent-a",
    conversationId: "c1",
  };
  assert.equal(stableEnvelopePayload(reordered), stableEnvelopePayload(ENV));
});

test("stableEnvelopePayload copies recipients (no shared mutable reference)", () => {
  const recipients = ["agent-b", "agent-c"];
  const out = stableEnvelopePayload({ ...ENV, recipients });
  recipients.push("agent-d");
  // the serialized string already captured the 2-recipient state
  assert.ok(out.includes('"recipients":["agent-b","agent-c"]'));
  assert.ok(!out.includes("agent-d"));
});

test("stableAckPayload emits an exact canonical string and excludes the signature", () => {
  const ack = {
    ackVersion: "1.0",
    msgId: "m1",
    messageDigest: `sha256:${"a".repeat(64)}`,
    conversationId: "c1",
    senderAgentId: "agent-b",
    recipientAgentId: "agent-a",
    status: "nack",
    reason: "retry",
    at: "2026-06-22T00:00:01.000Z",
    nonce: "nonce-1",
    signature: "SIG-SHOULD-BE-EXCLUDED",
  };

  assert.equal(
    stableAckPayload(ack),
    `{"ackVersion":"1.0","msgId":"m1","messageDigest":"sha256:${"a".repeat(64)}","conversationId":"c1","senderAgentId":"agent-b","recipientAgentId":"agent-a","status":"nack","reason":"retry","at":"2026-06-22T00:00:01.000Z","nonce":"nonce-1"}`,
  );
  assert.ok(!stableAckPayload(ack).includes("signature"));
});

// ---------------------------------------------------------------------------
// schemaVersion 1.1 — signed handoff lineage
// ---------------------------------------------------------------------------
const LINEAGE = Object.freeze({
  rootMessageId: "root-1",
  rootConversationId: "conv-root",
  causedByMessageId: "root-1",
  ancestry: ["claude-agent"],
});
const HANDOFF_ENV = Object.freeze({
  schemaVersion: "1.1",
  msgId: "h1",
  conversationId: "handoff:h1",
  senderAgentId: "claude-agent",
  recipients: ["codex-agent"],
  createdAt: "2026-06-22T00:00:00.000Z",
  payloadCiphertext: "ct",
  payloadNonce: "no",
  handoff: LINEAGE,
  signature: "SIG-SHOULD-BE-EXCLUDED",
});

test("1.0 canonical bytes are UNCHANGED by the 1.1 revision (no handoff key appears)", () => {
  assert.equal(
    stableEnvelopePayload(ENV),
    '{"schemaVersion":"1.0","msgId":"m1","conversationId":"c1","senderAgentId":"agent-a","recipients":["agent-b","agent-c"],"createdAt":"2026-06-22T00:00:00.000Z","payloadCiphertext":"ct","payloadNonce":"no"}',
  );
  assert.ok(!stableEnvelopePayload(ENV).includes("handoff"));
  assert.ok(!stableEnvelopePayload({ ...ENV, replyToMessageId: "request-1" }).includes("handoff"));
  assert.ok(!stableEnvelopePayload({ ...ENV, authToken: "MURMUR-AUTH:tok" }).includes("handoff"));
});

test("stableEnvelopePayload emits the exact canonical 1.1 handoff string (golden)", () => {
  assert.equal(
    stableEnvelopePayload(HANDOFF_ENV),
    '{"schemaVersion":"1.1","msgId":"h1","conversationId":"handoff:h1","senderAgentId":"claude-agent","recipients":["codex-agent"],"createdAt":"2026-06-22T00:00:00.000Z","payloadCiphertext":"ct","payloadNonce":"no","handoff":{"rootMessageId":"root-1","rootConversationId":"conv-root","causedByMessageId":"root-1","ancestry":["claude-agent"]}}',
  );
});

test("handoff is appended AFTER authToken in a fixed final position", () => {
  const out = stableEnvelopePayload({ ...HANDOFF_ENV, authToken: "MURMUR-AUTH:tok" });
  assert.ok(out.indexOf('"authToken"') < out.indexOf('"handoff"'));
  assert.ok(out.endsWith('"ancestry":["claude-agent"]}}'));
});

test("mutating ANY handoff field changes the canonical bytes (so it breaks verification)", () => {
  const base = stableEnvelopePayload(HANDOFF_ENV);
  const mutations = {
    rootMessageId: { ...LINEAGE, rootMessageId: "root-2" },
    rootConversationId: { ...LINEAGE, rootConversationId: "conv-other" },
    causedByMessageId: { ...LINEAGE, causedByMessageId: "reply-1" },
    "ancestry (append)": { ...LINEAGE, ancestry: ["claude-agent", "codex-agent"] },
    "ancestry (replace)": { ...LINEAGE, ancestry: ["codex-agent"] },
  };
  for (const [label, handoff] of Object.entries(mutations)) {
    assert.notEqual(stableEnvelopePayload({ ...HANDOFF_ENV, handoff }), base, `mutation must change bytes: ${label}`);
  }
  // stripping the lineage entirely also changes the bytes
  const stripped = { ...HANDOFF_ENV };
  delete stripped.handoff;
  assert.notEqual(stableEnvelopePayload(stripped), base);
});

test("handoff field order is fixed regardless of input key order", () => {
  const reordered = {
    ancestry: ["claude-agent"],
    causedByMessageId: "root-1",
    rootConversationId: "conv-root",
    rootMessageId: "root-1",
  };
  assert.equal(stableEnvelopePayload({ ...HANDOFF_ENV, handoff: reordered }), stableEnvelopePayload(HANDOFF_ENV));
});

test("handoff ancestry is copied (no shared mutable reference)", () => {
  const ancestry = ["claude-agent"];
  const out = stableEnvelopePayload({ ...HANDOFF_ENV, handoff: { ...LINEAGE, ancestry } });
  ancestry.push("cursor-agent");
  assert.ok(out.includes('"ancestry":["claude-agent"]}'));
  assert.ok(!out.includes("cursor-agent"));
});

test("a present-but-malformed handoff throws instead of producing ambiguous bytes", () => {
  for (const handoff of ["junk", 7, [], {}, { ...LINEAGE, ancestry: [] }, { ...LINEAGE, rootMessageId: "" }]) {
    assert.throws(() => stableEnvelopePayload({ ...HANDOFF_ENV, handoff }), /envelope-handoff-malformed/);
  }
});

test("handoff lineage smuggled into a 1.0 envelope still changes the signed bytes", () => {
  // Inclusion keys on PRESENCE, not on the version string, so a downgrade attack cannot
  // turn signed lineage into unsigned metadata.
  assert.notEqual(
    stableEnvelopePayload({ ...ENV, handoff: LINEAGE }),
    stableEnvelopePayload(ENV),
  );
});

test("derivedHandoffConversationId isolates each handoff", () => {
  assert.equal(derivedHandoffConversationId("h1"), "handoff:h1");
  assert.notEqual(derivedHandoffConversationId("h1"), derivedHandoffConversationId("h2"));
  assert.throws(() => derivedHandoffConversationId(""), /handoff-msg-id-required/);
});
