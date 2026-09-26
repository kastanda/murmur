/**
 * The NATS ingress gate must deliver BOTH supported wire versions.
 *
 * A 1.1 handoff NACKed as `invalid-envelope` at the broker would make explicit handoff
 * undeliverable over the real transport while every in-process test still passed, so this
 * pins the gate itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";

const sc = StringCodec();

const base = {
  msgId: "h1",
  senderAgentId: "claude-agent",
  recipients: ["codex-agent"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("bounded task").toString("base64"),
  payloadNonce: "nonce",
  signature: "sig",
};

const handoffEnvelope = {
  ...base,
  schemaVersion: "1.1",
  conversationId: "handoff:h1",
  handoff: {
    rootMessageId: "root-1",
    rootConversationId: "conv-root",
    causedByMessageId: "root-1",
    ancestry: ["claude-agent"],
  },
};

const drive = async (envelope) => {
  const published = [];
  const delivered = [];
  const fakeSub = {
    async *[Symbol.asyncIterator]() { yield { data: sc.encode(JSON.stringify(envelope)) }; },
  };
  const fakeNc = {
    subscribe() { return fakeSub; },
    publish(subject, data) { published.push({ subject, body: JSON.parse(sc.decode(data)) }); },
    async drain() {},
  };
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  broker.nc = fakeNc;
  await broker.subscribeWithAck({
    subject: "msg.codex-agent",
    consumerId: "codex-agent",
    dedupe: { async seen() { return false; }, async markSeen() {} },
    onMessage: async (received) => { delivered.push(received); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { published, delivered };
};

test("a 1.1 handoff envelope is DELIVERED and acked, with its signed lineage intact", async () => {
  const { published, delivered } = await drive(handoffEnvelope);
  assert.equal(delivered.length, 1, "the handoff must reach the recipient daemon");
  assert.equal(delivered[0].schemaVersion, "1.1");
  assert.deepEqual(delivered[0].handoff, handoffEnvelope.handoff);
  assert.equal(published.length, 1);
  assert.equal(published[0].subject, "ack.claude-agent");
  assert.equal(published[0].body.status, "ack");
  assert.equal(published[0].body.reason, undefined);
});

test("an ordinary 1.0 envelope is still delivered unchanged", async () => {
  const { published, delivered } = await drive({ ...base, schemaVersion: "1.0", conversationId: "conv-root" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].schemaVersion, "1.0");
  assert.equal(published[0].body.status, "ack");
});

test("a structurally invalid handoff is NACKed at ingress and never delivered", async () => {
  for (const broken of [
    { ...handoffEnvelope, handoff: undefined },
    { ...handoffEnvelope, handoff: { rootMessageId: "root-1" } },
    { ...handoffEnvelope, handoff: { ...handoffEnvelope.handoff, ancestry: ["a", "a"] } },
    { ...handoffEnvelope, replyToMessageId: "root-1" },
    { ...handoffEnvelope, recipients: ["codex-agent", "cursor-agent"] },
    { ...handoffEnvelope, schemaVersion: "1.2" },
    // handoff lineage smuggled into a 1.0 envelope
    { ...handoffEnvelope, schemaVersion: "1.0" },
  ]) {
    const { published, delivered } = await drive(broken);
    assert.deepEqual(delivered, [], `must not deliver: ${JSON.stringify(broken.handoff)}`);
    assert.equal(published[0].body.status, "nack");
    assert.equal(published[0].body.reason, "invalid-envelope");
  }
});
