# Protocol Compatibility Matrix

Companion to [`protocol-v1.md`](protocol-v1.md) (prose) and the machine-readable
[`packages/core/schema/protocol-v1.schema.json`](../packages/core/schema/protocol-v1.schema.json)
(JSON Schema, Draft 2020-12). The schema is the canonical wire contract; the runtime
guards `isEnvelopeV1` / `isEnvelopeV11` / `isHandoffLineageV1` in `@murmurv2/core` mirror
it, and the conformance suite (`packages/core/test/conformance.test.mjs`) asserts the two
cannot drift. Explicit agent handoff (wire revision `1.1`) is specified in
[`agent-handoff.md`](agent-handoff.md).

## Versions

| `schemaVersion` | Status  | Envelope | Ack    | Notes |
|-----------------|---------|----------|--------|-------|
| `1.0`           | current | `EnvelopeV1` | `AckV1` | Shipped in v2.x. ORDINARY and REPLY messages. Also covers the discovery (`PresenceFrameV1`, `SignedPresenceFrameV1`) and streaming (`StreamStart`/`StreamChunk`/`StreamEnd`) frames below. |
| `1.1`           | current | `EnvelopeV11` | `AckV1` | HANDOFF messages only — exactly one recipient, signed `handoff` lineage, never a `replyToMessageId`. Safe wire revision: it does not change any 1.0 canonical signing bytes. See [`agent-handoff.md`](agent-handoff.md). |

Both versions are read and acked by this build (`isSupportedEnvelope`); only the handoff
writer emits `1.1`, ordinary/reply writers stay on `1.0`.

Only the envelope carries `schemaVersion` on the wire; the presence and stream frames
are versioned together with `1.0` (they ship and break as one protocol version) and are
discriminated structurally — `presenceVersion: "1.0"` for presence, `kind` for streams.
`AckV1`/`SignedAckV1` are unchanged by the 1.1 revision and ack both versions.

## Compatibility policy

- **Two wire versions, one per structural case.** `EnvelopeV1.schemaVersion` is a
  `const "1.0"` and `EnvelopeV11.schemaVersion` a `const "1.1"`; any other value is
  rejected. `isEnvelopeV1` accepts only 1.0, `isEnvelopeV11` only 1.1, and
  `isSupportedEnvelope` is the union a delivery path uses.
- **A 1.0-only reader MUST reject 1.1.** Handoff lineage is security-critical and is part
  of the canonical signed payload, so it is not an unknown optional field an older
  consumer may ignore. `isEnvelopeV1` gates on the const, and the JSON Schema document
  **root** deliberately stays `EnvelopeV1`.
- **A 1.0 envelope may not carry `handoff`.** Both the schema (`"handoff": false`) and
  `isEnvelopeV1` reject it, and canonical inclusion keys on the field's PRESENCE rather
  than on the version string — so a downgrade attack cannot turn signed lineage into
  unsigned metadata.
- **Forward-compatible reads.** Unknown top-level fields are **permitted and ignored**
  (no `additionalProperties: false`). A future minor MAY add optional fields without
  bumping `schemaVersion`; older consumers ignore them only when they do not alter
  canonical signing bytes. Current ordinary optional fields are `ttlSeconds`,
  `traceId`, `sequence`, and `parentMsgId`. Signed extensions require the rollout
  rules below and are not silently ignorable.
- **Breaking change ⇒ new version.** Removing/renaming a required field, changing a
  type, or tightening an enum bumps `schemaVersion` (e.g. `2.0`). Consumers gate on it.
- **Signature/crypto are out of band of the schema.** The schema validates *shape*;
  `signature` non-emptiness is required, but signature *verification* and payload
  decryption are runtime concerns (`@murmurv2/security`), not JSON-Schema constraints.
- **`createdAt`** carries `format: date-time` (advisory in JSON Schema) and is
  enforced at runtime by `isEnvelopeV1` via `Date.parse`.

## Required vs optional (EnvelopeV1)

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `schemaVersion` | ✅ | string | `const "1.0"` |
| `msgId` | ✅ | string | non-empty |
| `conversationId` | ✅ | string | non-empty |
| `senderAgentId` | ✅ | string | non-empty |
| `recipients` | ✅ | string[] | ≥1, each non-empty |
| `createdAt` | ✅ | string | ISO-8601 date-time |
| `payloadCiphertext` | ✅ | string | non-empty |
| `payloadNonce` | ✅ | string | non-empty |
| `signature` | ✅ | string | non-empty (on the wire) |
| `ttlSeconds` | — | number | |
| `traceId` | — | string | |
| `sequence` | — | number | |
| `parentMsgId` | — | string | |
| `replyToMessageId` | — | string | non-empty; exact parent message for reply correlation |
| `authToken` | — | string | non-empty if present; bearer (`MURMUR-AUTH:…`) |
| `handoff` | ⛔ | — | **forbidden** on 1.0 (`"handoff": false`); handoff lineage belongs to 1.1 only |

**`authToken` is part of the signed payload.** When present it is appended to
`stableEnvelopePayload` in a fixed final position, so it cannot be stripped or swapped
without invalidating the signature. When absent, the signing payload is byte-identical
to envelopes from before the field existed (forward/backward compatible). Verification is a
runtime concern (`@murmurv2/federation` `verifyAuthToken`), not a schema constraint;
ingress enforcement (an `authorizeInbound` helper gated by `MURMUR_ENFORCE_AUTH`) is
forthcoming in auth/authz #47 PR-D.

`msgId` identifies the current message. `conversationId` groups messages into a
logical conversation but does not correlate requests and replies.
`replyToMessageId` identifies the immediate parent message. `murmur_request` matches
only this exact field plus the expected sender; messages without it remain ordinary
inbox messages and never satisfy a strict request.

### Signed extension compatibility: `replyToMessageId`

`replyToMessageId` is part of the canonical signed payload when present. An envelope
without it retains the exact canonical bytes used before this field was introduced.
An envelope with it requires an upgraded verifier that includes the field in the
canonical form; an older verifier computes different bytes and rejects the envelope
as signature-invalid. It is therefore not an unknown optional field that an older
consumer can safely ignore, and mixed-version interoperability is not promised for
envelopes that carry it.

Roll out support in this order:

1. Upgrade verifiers/readers on every peer.
2. Only then enable emitters to send `replyToMessageId`.

The legacy A2A `parentMsgId` fallback is best-effort ancestry metadata, not a
substitute for strict `replyToMessageId` correlation. `murmur_request` does not use
that fallback, and it can never substitute for signed handoff lineage either.

## EnvelopeV11 (schemaVersion `1.1`, HANDOFF only)

Validate against `#/$defs/EnvelopeV11`, or `#/$defs/EnvelopeAny` to accept either
supported version. Semantics live in [`agent-handoff.md`](agent-handoff.md).

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `schemaVersion` | ✅ | string | `const "1.1"` |
| `msgId` | ✅ | string | non-empty — **this IS the handoff id** |
| `conversationId` | ✅ | string | **MUST equal `handoff:<msgId>`** — the derived, isolated conversation. Enforced at runtime by `validateHandoffEnvelope` (`handoff-conversation-mismatch`); not expressible in JSON Schema |
| `senderAgentId` | ✅ | string | non-empty; MUST be the final `handoff.ancestry` element |
| `recipients` | ✅ | string[] | **exactly 1**, non-empty |
| `createdAt` | ✅ | string | ISO-8601 date-time |
| `payloadCiphertext` | ✅ | string | non-empty; the bounded task, sealed E2E as usual |
| `payloadNonce` | ✅ | string | non-empty |
| `signature` | ✅ | string | non-empty; covers the lineage |
| `handoff` | ✅ | object | a valid `HandoffLineageV1` |
| `replyToMessageId` | ⛔ | — | **forbidden** (`handoff-reply-conflict`) — handoff and reply are exclusive |
| `ttlSeconds`, `traceId`, `sequence`, `parentMsgId`, `authToken` | — | | as on 1.0 |

### HandoffLineageV1

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `rootMessageId` | ✅ | string | non-empty; msgId of the original/root request |
| `rootConversationId` | ✅ | string | non-empty; the original/root conversation |
| `causedByMessageId` | ✅ | string | non-empty; the exact message/result that caused this delegation |
| `ancestry` | ✅ | string[] | ≥1, each non-empty, **unique**; the ACTIVE delegation path only, ending with the sender |

### Signed extension compatibility: `handoff`

`handoff` is appended to `stableEnvelopePayload` **after** `authToken`, in a fixed final
position, and only when present. Consequences:

- An envelope without it retains the exact canonical bytes used before 1.1 existed —
  every ordinary and reply envelope is byte-identical to before.
- Mutating **any** lineage field, stripping the lineage, or changing the recipient or the
  derived conversation invalidates the signature.
- Field order inside `handoff` is fixed regardless of input key order, and `ancestry` is
  copied (no shared mutable reference).
- A present-but-malformed `handoff` makes `stableEnvelopePayload` **throw**
  (`envelope-handoff-malformed`) rather than emit ambiguous bytes.

Deterministic ancestry/loop/depth/recipient/conversation rules (`handoff-self`,
`handoff-cycle`, `handoff-depth-exceeded`, `handoff-ancestry-sender-mismatch`,
`handoff-recipient-mismatch`, `handoff-conversation-mismatch`, …) are **runtime** concerns
enforced by `validateHandoffEnvelope` / `admitInboundHandoff`, not JSON-Schema assertions.
`handoff-conversation-mismatch` in particular cannot be a schema assertion: JSON Schema
cannot express "this field equals a fixed prefix plus the value of another field".

### Peer capability

A handoff target must advertise **both** `protocolVersions` containing `"1.1"` and
`features` containing `"handoff-v1"` (`peerSupportsHandoffV1`). Peers paired before
handoff existed carry neither and are refused as delegation targets, while continuing to
work normally for ordinary 1.0 traffic.

### Transport support

| Transport | 1.0 | 1.1 inbound | Notes |
|---|---|---|---|
| NATS (`@murmurv2/broker-nats`) | ✅ | ✅ | the handoff transport; ingress accepts both versions |
| WebSocket (`@murmurv2/broker-ws`) | ✅ | ⛔ | implements no handoff admission, so it refuses 1.1 inbound; it may still flush 1.1 bytes from a shared outbox |
| proxy subjects (daemon) | ✅ | ⛔ | no signed-lineage validation and no autonomous runtime — refused outright |

## AckV1

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `msgId` | ✅ | string | non-empty |
| `consumerId` | ✅ | string | non-empty |
| `status` | ✅ | string | enum `ack` \| `nack` |
| `at` | ✅ | string | ISO-8601 date-time |
| `reason` | — | string | |

## PresenceFrameV1 (discovery)

Public discovery metadata only — no secret. The signed wrapper proves integrity, not
identity; trust is an out-of-band operator promotion.

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `presenceVersion` | ✅ | string | `const "1.0"` |
| `agentId` | ✅ | string | non-empty |
| `encryptionPublicKey` | ✅ | string | non-empty |
| `signingPublicKey` | ✅ | string | non-empty |
| `subject` | ✅ | string | non-empty |
| `capabilities` | ✅ | string[] | each a string (may be empty array) |
| `ttlMs` | ✅ | number | `> 0` (`exclusiveMinimum`) |
| `ts` | ✅ | string | ISO-8601 date-time (validity runtime-only) |
| `nonce` | ✅ | string | non-empty |

### SignedPresenceFrameV1

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `frame` | ✅ | object | a valid `PresenceFrameV1` |
| `signature` | ✅ | string | non-empty (Ed25519 over the canonical frame) |

## Stream frames

Discriminated by `kind`. `StreamFrame` is the `oneOf` union of the three.

### StreamStart (`kind: "stream.start"`)

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `kind` | ✅ | string | `const "stream.start"` |
| `streamId` | ✅ | string | non-empty |
| `chunkCount` | ✅ | number | declared total chunks |
| `totalBytes` | ✅ | number | declared total bytes |
| `contentType` | — | string | |
| `startedAt` | — | string | |

### StreamChunk (`kind: "stream.chunk"`)

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `kind` | ✅ | string | `const "stream.chunk"` |
| `streamId` | ✅ | string | non-empty |
| `chunkIndex` | ✅ | number | |
| `chunkCount` | ✅ | number | |
| `data` | ✅ | string | **non-empty** (zero-byte chunk rejected: `stream-chunk-data-required`) |
| `isLast` | ✅ | boolean | |
| `sha256` | — | string | optional per-chunk integrity tag |

### StreamEnd (`kind: "stream.end"`)

| Field | Required | Type | Constraint |
|-------|----------|------|------------|
| `kind` | ✅ | string | `const "stream.end"` |
| `streamId` | ✅ | string | non-empty |
| `chunkCount` | ✅ | number | |
| `totalBytes` | ✅ | number | |
| `digest` | — | string | optional whole-stream integrity tag |
| `sha256` | — | string | optional whole-stream integrity tag |

## Entrypoints

`protocol-v1.schema.json` is a single file; validate each wire type against its target:

| Validate | Entrypoint |
|----------|------------|
| an inbound **1.0 envelope** | the document **root** (it `$ref`s `#/$defs/EnvelopeV1`) — so validating against the file directly is correct |
| an inbound **1.1 handoff envelope** | `#/$defs/EnvelopeV11` |
| an inbound envelope of **either** supported version | `#/$defs/EnvelopeAny` |
| a **handoff lineage** | `#/$defs/HandoffLineageV1` |
| an **ack** | `#/$defs/AckV1` |
| a **presence frame** | `#/$defs/PresenceFrameV1` |
| a **signed presence frame** | `#/$defs/SignedPresenceFrameV1` |
| a **stream frame** | `#/$defs/StreamFrame` (or a specific `#/$defs/StreamStart` \| `StreamChunk` \| `StreamEnd`) |

There is one canonical machine-readable schema (`packages/core/schema/protocol-v1.schema.json`);
no other protocol JSON schemas exist in the repo.

### Runtime-only checks (not assertable in JSON Schema)

The schema validates structural shape. A few checks live only in the runtime guards
and are intentionally **outside** the schema↔guard agreement matrices:

- **`createdAt` / `ts` date-time validity** — `format: date-time` is an advisory
  annotation in Draft 2020-12; the runtime guards enforce it via `Date.parse`
  (`isEnvelopeV1` for `EnvelopeV1.createdAt`, `isPresenceFrameV1` for `PresenceFrameV1.ts`).
- **`AckV1.at`** — generated as an ISO-8601 string by `createAck`, but there is **no
  `isAckV1` guard**: its `format: date-time` is advisory only (validator-dependent) with
  no runtime enforcement on read.
- **signature verification & payload decryption** — `@murmurv2/security`, not shape.
- **stream semantics** — `chunkIndex` bounds, `totalBytes` accounting, and
  `digest`/`sha256` matching are the reassembler's job, not the frame guards'.

## For third-party implementations

Validate inbound 1.0 envelopes against `protocol-v1.schema.json` (the root) and reject on
failure; validate acks against its `#/$defs/AckV1`. To participate in explicit handoff,
validate against `#/$defs/EnvelopeAny`, include `handoff` in the canonical signing payload
exactly as described above, enforce the deterministic ancestry/loop/depth/recipient rules,
and advertise `protocolVersions: ["1.0","1.1"]` + `features: ["handoff-v1"]`. An
implementation that does **not** do all of that MUST keep rejecting `1.1` rather than
ignoring its lineage. The conformance suite is the
reference behaviour for accept/reject decisions; run it (or port its fixtures) to check
an independent implementation against this contract.
