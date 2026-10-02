import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringCodec } from "nats";
import { NatsBroker } from "../packages/broker-nats/dist/src/index.js";
import {
  JsonFileOutboxStore,
  createAck,
  createBoundAck,
  isSignedAckV1,
  stableAckPayload,
} from "../packages/core/dist/src/index.js";
import {
  createSigningKeyPair,
  signEnvelope,
  verifyEnvelopeSignature,
} from "../packages/security/dist/src/index.js";

const sc = StringCodec();

const envelope = {
  schemaVersion: "1.0",
  msgId: "msg-signed-ack",
  conversationId: "conv-signed-ack",
  senderAgentId: "agent-sender",
  recipients: ["agent-receiver"],
  createdAt: new Date().toISOString(),
  payloadCiphertext: Buffer.from("encrypted-message").toString("base64"),
  payloadNonce: "nonce",
  signature: "envelope-signature",
};

const createSentOutbox = async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-signed-ack-"));
  const outbox = new JsonFileOutboxStore(join(dir, "outbox.json"));
  await outbox.enqueue("msg.agent-receiver", envelope);
  await outbox.markSent(envelope.msgId);
  return outbox;
};

const signAck = async (unsignedAck, privateKey) => ({
  ...unsignedAck,
  signature: await signEnvelope(stableAckPayload(unsignedAck), privateKey),
});

const processAck = async (broker, outbox, ack, verifyAck, events = []) => {
  await broker.processAckFrame(sc.encode(JSON.stringify(ack)), {
    outbox,
    requireSignedAcks: true,
    verifyAck,
    onInvalidAck: (event) => events.push(event),
  });
  return events;
};

test("subscribeWithAck emits a signed message-bound ACK when a signer is supplied", async () => {
  const signing = await createSigningKeyPair();
  const published = [];
  const fakeSub = {
    async *[Symbol.asyncIterator]() {
      yield { data: sc.encode(JSON.stringify(envelope)) };
    },
  };
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  broker.nc = {
    subscribe() { return fakeSub; },
    publish(subject, data) { published.push({ subject, ack: JSON.parse(sc.decode(data)) }); },
    async drain() {},
  };

  await broker.subscribeWithAck({
    subject: "msg.agent-receiver",
    consumerId: "agent-receiver",
    dedupe: {
      async seen() { return false; },
      async markSeen() {},
    },
    onMessage: async () => {},
    signAck: (unsigned) => signAck(unsigned, signing.privateKey),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(published[0].subject, "ack.agent-sender");
  assert.equal(isSignedAckV1(published[0].ack), true);
  assert.equal(published[0].ack.messageDigest, createBoundAck(envelope, "agent-receiver", "ack").messageDigest);
  assert.equal(
    await verifyEnvelopeSignature(
      stableAckPayload(published[0].ack),
      published[0].ack.signature,
      signing.publicKey,
    ),
    true,
  );
});

test("strict ACK correlation rejects unsigned ACKs without changing the outbox", async () => {
  const outbox = await createSentOutbox();
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  const events = await processAck(
    broker,
    outbox,
    createAck(envelope.msgId, "agent-receiver", "ack"),
    async () => true,
  );

  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "sent");
  assert.equal(events[0].reason, "unsigned-or-malformed");
  assert.equal(broker.getAckSecurityMetrics()["unsigned-or-malformed"], 1);
});

test("a valid signed ACK is bound to the pending message and expected peer", async () => {
  const outbox = await createSentOutbox();
  const signing = await createSigningKeyPair();
  const unsigned = createBoundAck(envelope, "agent-receiver", "ack");
  const ack = await signAck(unsigned, signing.privateKey);
  const broker = new NatsBroker({ url: "nats://example.invalid" });

  await processAck(
    broker,
    outbox,
    ack,
    (candidate) => verifyEnvelopeSignature(
      stableAckPayload(candidate),
      candidate.signature,
      signing.publicKey,
    ),
  );

  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked");
});

test("wrong peer, conversation, recipient, digest, time, and signature cannot change outbox state", async () => {
  const signing = await createSigningKeyPair();
  const wrongSigning = await createSigningKeyPair();
  const cases = [
    { name: "unexpected-peer", patch: { senderAgentId: "agent-attacker" }, signer: signing },
    { name: "conversation-mismatch", patch: { conversationId: "other-conversation" }, signer: signing },
    { name: "recipient-mismatch", patch: { recipientAgentId: "other-recipient" }, signer: signing },
    { name: "message-digest-mismatch", patch: { messageDigest: `sha256:${"0".repeat(64)}` }, signer: signing },
    { name: "timestamp-out-of-window", patch: { at: "2020-01-01T00:00:00.000Z" }, signer: signing },
    { name: "signature-invalid", patch: {}, signer: wrongSigning },
  ];

  for (const item of cases) {
    const outbox = await createSentOutbox();
    const broker = new NatsBroker({ url: "nats://example.invalid" });
    const unsigned = { ...createBoundAck(envelope, "agent-receiver", "ack"), ...item.patch };
    const ack = await signAck(unsigned, item.signer.privateKey);
    const events = await processAck(
      broker,
      outbox,
      ack,
      (candidate) => verifyEnvelopeSignature(
        stableAckPayload(candidate),
        candidate.signature,
        signing.publicKey,
      ),
    );

    assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "sent", item.name);
    assert.equal(events[0].reason, item.name);
  }
});

test("replaying a signed ACK cannot create another outbox transition", async () => {
  const outbox = await createSentOutbox();
  const signing = await createSigningKeyPair();
  const ack = await signAck(
    createBoundAck(envelope, "agent-receiver", "ack"),
    signing.privateKey,
  );
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  const verifyAck = (candidate) => verifyEnvelopeSignature(
    stableAckPayload(candidate),
    candidate.signature,
    signing.publicKey,
  );

  await processAck(broker, outbox, ack, verifyAck);
  const afterFirst = await outbox.getOutboxRecord(envelope.msgId);
  const events = await processAck(broker, outbox, ack, verifyAck);
  const afterReplay = await outbox.getOutboxRecord(envelope.msgId);

  assert.equal(afterFirst.status, "acked");
  assert.equal(afterReplay.status, "acked");
  assert.equal(afterReplay.version, afterFirst.version);
  assert.equal(events[0].reason, "nonce-replay", "the exact same ACK frame is a replay, whatever the row state");
});


// ---------------------------------------------------------------------------
// Duplicate delivery ACKs (a receiver ACKs EVERY delivery of a msgId)
// ---------------------------------------------------------------------------

const ackContext = async () => {
  const signing = await createSigningKeyPair();
  const outbox = await createSentOutbox();
  const broker = new NatsBroker({ url: "nats://example.invalid" });
  const verifyAck = (candidate) => verifyEnvelopeSignature(stableAckPayload(candidate), candidate.signature, signing.publicKey);
  const invalid = [];
  const duplicates = [];
  const deliver = async (ack) => broker.processAckFrame(sc.encode(JSON.stringify(ack)), {
    outbox, requireSignedAcks: true, verifyAck,
    onInvalidAck: (event) => invalid.push(event.reason),
    onDuplicateAck: (event) => duplicates.push(event.reason),
  });
  const freshAck = async (overrides = {}, status = "ack", sender = "agent-receiver") =>
    signAck({ ...createBoundAck(envelope, sender, status), ...overrides }, signing.privateKey);
  return { signing, outbox, deliver, freshAck, invalid, duplicates };
};

test("RACE: the first valid ACK terminalizes; later valid ACKs for the SAME msgId (one per re-publish) are benign duplicates, not 'invalid'", async () => {
  const { outbox, deliver, freshAck, invalid, duplicates } = await ackContext();
  await deliver(await freshAck());
  const afterFirst = await outbox.getOutboxRecord(envelope.msgId);
  assert.equal(afterFirst.status, "acked");
  for (let i = 0; i < 5; i += 1) await deliver(await freshAck());   // 5 re-publishes -> 5 distinct-nonce ACKs
  assert.deepEqual(invalid, [], "no 'message-not-in-flight' storm");
  assert.equal(duplicates.length, 5);
  const after = await outbox.getOutboxRecord(envelope.msgId);
  assert.equal(after.status, "acked");
  assert.equal(after.version, afterFirst.version, "a duplicate never creates another transition");
});

test("a valid ACK that lands while the row is still 'pending' (publish done, markSent not yet) terminalizes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murmur-signed-ack-pending-"));
  const outbox = new JsonFileOutboxStore(join(dir, "outbox.json"));
  await outbox.enqueue("msg.agent-receiver", envelope);
  const signing = await createSigningKeyPair();
  const ack = await signAck(createBoundAck(envelope, "agent-receiver", "ack"), signing.privateKey);
  const events = [];
  await new NatsBroker({ url: "nats://example.invalid" }).processAckFrame(sc.encode(JSON.stringify(ack)), {
    outbox, requireSignedAcks: true, onInvalidAck: (e) => events.push(e.reason),
    verifyAck: (c) => verifyEnvelopeSignature(stableAckPayload(c), c.signature, signing.publicKey),
  });
  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked");
  assert.deepEqual(events, []);
});

test("SECURITY: a duplicate ACK is still fully verified — stale, spoofed, wrong-peer, mismatched and replayed ones are rejected", async () => {
  const { outbox, deliver, freshAck, invalid, duplicates, signing } = await ackContext();
  await deliver(await freshAck());
  const stale = await freshAck({ at: new Date(Date.now() - 60 * 60_000).toISOString() });
  await deliver(stale);
  const otherKey = await createSigningKeyPair();
  const forged = await signAck(createBoundAck(envelope, "agent-receiver", "ack"), otherKey.privateKey);
  await deliver(forged);
  const wrongPeer = await signAck({ ...createBoundAck(envelope, "agent-intruder", "ack") }, signing.privateKey);
  await deliver(wrongPeer);
  const wrongDigest = await freshAck({ messageDigest: createBoundAck({ ...envelope, payloadCiphertext: "b3RoZXI=" }, "agent-receiver", "ack").messageDigest });
  await deliver(wrongDigest);
  const wrongConversation = await freshAck({ conversationId: "some-other-conversation" });
  await deliver(wrongConversation);
  const replay = await freshAck();
  await deliver(replay);
  await deliver(replay);
  assert.deepEqual(invalid, ["timestamp-out-of-window", "signature-invalid", "unexpected-peer", "message-digest-mismatch", "conversation-mismatch", "nonce-replay"]);
  assert.equal(duplicates.length, 1, "only the one fully verified duplicate is accepted as benign");
  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked");
});

test("a NACK for an already-acknowledged message, and any ACK for a message in another terminal state, are still rejected", async () => {
  const { outbox, deliver, freshAck, invalid } = await ackContext();
  await deliver(await freshAck());
  await deliver(await freshAck({}, "nack"));
  assert.deepEqual(invalid, ["message-not-in-flight"]);
  assert.equal((await outbox.getOutboxRecord(envelope.msgId)).status, "acked");

  const other = await ackContext();
  await other.outbox.markFailed(envelope.msgId, "boom", new Date().toISOString());
  await other.deliver(await other.freshAck());
  assert.deepEqual(other.invalid, ["message-not-in-flight"], "a 'failed' row does not become acked by a late ACK");
});

test("WS broker: a duplicate ACK of an acked message needs the durable nonce store AND an in-window timestamp, else it is still rejected", async () => {
  const { WebSocketBroker } = await import("../packages/broker-ws/dist/src/index.js");
  const signing = await createSigningKeyPair();
  const verifyAck = (c) => verifyEnvelopeSignature(stableAckPayload(c), c.signature, signing.publicKey);
  const subject = `ack.${envelope.senderAgentId}`;
  const run = async ({ ackReceipts, at }) => {
    const outbox = await createSentOutbox();
    await outbox.markAcked(envelope.msgId);
    const invalid = [];
    const broker = new WebSocketBroker({ url: "ws://example.invalid" });
    const ack = await signAck({ ...createBoundAck(envelope, "agent-receiver", "ack"), ...(at ? { at } : {}) }, signing.privateKey);
    await broker.processAckFrame(ack, { outbox, requireSignedAcks: true, verifyAck, ackReceipts, onInvalidAck: (e) => invalid.push(e.reason) }, subject);
    return invalid;
  };
  const seen = new Set();
  const receipts = { claimAckNonce: async (peer, nonce) => { const k = `${peer}:${nonce}`; if (seen.has(k)) return false; seen.add(k); return true; } };
  assert.deepEqual(await run({ ackReceipts: receipts }), [], "fully verified + durable nonce + fresh: benign");
  assert.deepEqual(await run({ ackReceipts: undefined }), ["message-not-in-flight"], "no durable nonce store: rejected");
  assert.deepEqual(await run({ ackReceipts: receipts, at: new Date(Date.now() - 3_600_000).toISOString() }), ["message-not-in-flight"], "stale timestamp: rejected");
});
