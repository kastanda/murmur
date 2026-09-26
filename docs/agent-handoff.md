# Explicit agent handoff / routing

Murmur's final functional layer: one agent **explicitly delegates one bounded piece of
work** to another paired agent, gets back an **exactly correlated** result, and **resumes
its own original runtime context** to continue — with no human copying messages between
agents and no heuristic interpretation of prose as a delegation.

Target capability, end to end:

```
root request R ─► Claude
                   ├─ H1 ──► Codex            (bounded delegated task)
                   │◄─ C1 ──┘                 (exact correlated result, replyTo = H1)
                   │  Claude resumes its ORIGINATING session
                   ├─ H2 ──► Cursor           (sibling delegation)
                   │◄─ C2 ──┘                 (replyTo = H2)
                   └─ final reply to R        (replyTo = R)
```

## The three structural message cases

There are exactly three, and they are mutually exclusive:

| Case | `handoff` | `replyToMessageId` | Wire version |
|---|---|---|---|
| **ORDINARY** | absent | absent | `1.0` |
| **REPLY** | absent | present | `1.0` |
| **HANDOFF** | present | **absent** | `1.1` |

A handoff is: *agent A explicitly delegates one bounded piece of work to agent B and
expects an exact correlated result.* `handoff` + `replyToMessageId` together is rejected
(`handoff-reply-conflict`) by both the schema and the runtime guards.

**The handoff envelope's own `msgId` IS the handoff id.** There is no separate
`handoffId`.

## Wire revision 1.1

Security-critical lineage must never be bolted onto 1.0's canonical signing semantics, so
handoff envelopes use `schemaVersion: "1.1"`.

```jsonc
{
  "schemaVersion": "1.1",
  "msgId": "H1",                      // this IS the handoff id
  "conversationId": "handoff:H1",     // derived, isolated conversation
  "senderAgentId": "claude-agent",
  "recipients": ["codex-agent"],      // exactly one
  "createdAt": "…",
  "payloadCiphertext": "…",           // the bounded task, still sealed E2E
  "payloadNonce": "…",
  "handoff": {
    "rootMessageId": "R",
    "rootConversationId": "conv-root",
    "causedByMessageId": "R",
    "ancestry": ["claude-agent"]
  },
  "signature": "…"
}
```

Guarantees (all pinned by tests):

- **1.0 canonical bytes are unchanged.** `handoff` is appended to
  `stableEnvelopePayload` only when present, after `authToken`, in a fixed final position.
  Every ordinary/reply envelope signs byte-identically to before 1.1 existed.
- **All handoff metadata is signed.** Mutating `rootMessageId`, `rootConversationId`,
  `causedByMessageId` or `ancestry` — or stripping the lineage, or changing the recipient
  or the derived conversation — breaks signature verification.
- **Canonical inclusion keys on PRESENCE, not on the version string.** Smuggling a
  `handoff` into a `"1.0"` envelope still changes the signed bytes, and `isEnvelopeV1`
  rejects it outright, so lineage can never be downgraded into unsigned ignorable data.
- **An unsupported old reader rejects 1.1** rather than ignoring the lineage:
  `isEnvelopeV1` gates on `const "1.0"`, and the JSON Schema **root** stays `EnvelopeV1`
  on purpose. Readers that must accept handoffs validate against `#/$defs/EnvelopeAny`.
- **A present-but-malformed `handoff` throws** (`envelope-handoff-malformed`) rather than
  producing ambiguous canonical bytes.
- Ordinary/reply writers **stay on 1.0**; only the handoff writer emits 1.1.

Roll-out order is the same as for `replyToMessageId`: upgrade every reader first, then
enable handoff emitters (which is what advertising `handoff-v1` does).

See [`protocol-compatibility.md`](protocol-compatibility.md) for the field-level matrix.

## Signed lineage

```ts
handoff: {
  rootMessageId: string;        // the original/root request msgId
  rootConversationId: string;   // the original/root conversation
  causedByMessageId: string;    // the exact message/result that caused THIS delegation
  ancestry: string[];           // the ACTIVE delegation path only
}
```

The legacy, **unsigned** `parentMsgId` is best-effort ancestry metadata and can never
substitute for this lineage.

### ACTIVE ancestry — the critical rule

`ancestry` is **not** the history of every agent that has participated. It is the
currently-in-flight delegation path, ending with the delegating agent.

Runtime turn context carries `parentActivePath`. **The currently executing agent is not
already in it.** When agent A delegates:

```
handoffAncestry = appendUnique(parentActivePath, A)
```

| Situation | `parentActivePath` | resulting `ancestry` |
|---|---|---|
| Claude handling root R | `[]` | `[claude]` for H1 |
| Codex handling H1 | `[claude]` | `[claude, codex]` for a nested H2 |
| Claude resumed after C1 closed H1 | `[]` (restored from the continuation) | `[claude]` for sibling H2 |

A completed child branch **must not** remain in the parent's active path — that is what
makes a sibling delegation after a child completes legal instead of a false cycle.
Historical participation is represented by `rootMessageId`, `rootConversationId`,
`causedByMessageId`, the exact `replyToMessageId` chain and the continuation records —
never by overloading `ancestry`.

## Derived handoff conversations

Every handoff runs in its own isolated conversation:

1. generate the handoff `msgId`
2. `conversationId = "handoff:" + handoffMsgId`
3. the root conversation survives only inside signed `handoff.rootConversationId`

The target's result rides the **same** derived conversation with
`replyToMessageId = <handoff msgId>`. The original/root conversation is **never** passed
to the target runtime as its conversation/session key, so a delegated task can never be
confused with the delegator's own thread.

### The derived conversation is ENFORCED, both ways

Session isolation is only real if it is checked, so it is a hard rule on both sides:

- **Inbound handoff.** `validateHandoffEnvelope` requires
  `conversationId === derivedHandoffConversationId(msgId)` — literally `handoff:<msgId>`.
  A handoff that is structurally valid, correctly signed, correctly addressed and carries
  valid lineage but points at any *other* conversation (the root conversation, another
  handoff's conversation, an attacker-chosen one) is refused with
  `handoff-conversation-mismatch` **before any runtime executes**, and gets the usual
  correlated failure result. Because the rule is a pure function of `msgId` and `msgId` is
  part of the signed payload, it cannot be satisfied by rewriting one field.
  The same check runs on the **emit** side, so this agent can never send such an envelope.
- **Child reply.** Resolving a continuation requires ALL THREE of:
  `replyToMessageId === continuation.handoffMsgId`,
  `senderAgentId === continuation.recipientId`, and
  `conversationId === continuation.handoffConversationId` — the persisted **derived**
  conversation, never `rootConversationId`. A reply with exact msgId correlation and the
  expected sender but the wrong conversation does **not** close the continuation, does not
  resume the parent, does not mutate the row and produces no parent result
  (`handoff-continuation-conversation-mismatch`); the continuation stays `open` for the
  real result. The check is part of the durable CAS, not only a caller-side guard.

This rule is deliberately a runtime check rather than a JSON-Schema assertion: JSON Schema
cannot express "this field equals a prefix plus another field", and the schema↔guard
agreement matrix stays exact.

## Loop and depth safety

Deterministic, stable reason codes (`HANDOFF_REASONS` in `@murmurv2/core`):

| Condition | Reason |
|---|---|
| target == sender | `handoff-self` |
| target already on the active ancestry | `handoff-cycle` |
| duplicate / malformed / empty ancestry entries | `handoff-ancestry-invalid` |
| sender is not the final ancestry element | `handoff-ancestry-sender-mismatch` |
| active depth exceeded (default **4**) | `handoff-depth-exceeded` |
| more or fewer than one recipient | `handoff-recipients-invalid` |
| recipient is not this agent | `handoff-recipient-mismatch` |
| `handoff` together with `replyToMessageId` | `handoff-reply-conflict` |
| lineage missing / empty / wrong shape | `handoff-lineage-invalid` |
| `conversationId` is not `handoff:<msgId>` | `handoff-conversation-mismatch` |
| child reply in the wrong derived conversation | `handoff-continuation-conversation-mismatch` |

Enforced on **both** sides: `AgentHandoffController.planDelegation` before emitting, and
`admitInboundHandoff` on receipt before any runtime executes. The default maximum active
depth is `4` (`config.handoff.maxActiveDepth` / `MURMUR_HANDOFF_MAX_DEPTH`).

The existing **sender-window loop breaker** remains an additional volumetric safeguard; it
defers, it does not replace the deterministic ancestry rules.

## Peer capability and authorization

A handoff target must **explicitly** advertise support. In `agent-config.json`:

```jsonc
"peers": {
  "codex-agent": {
    "encryption": { "publicKey": "…" },
    "signing":    { "publicKey": "…" },
    "subject":    "msg.codex-agent",
    "protocolVersions": ["1.0", "1.1"],
    "features":   ["handoff-v1"]
  }
}
```

`sendHandoff` **fails closed** when the target is unknown (`handoff-target-unknown`),
unpaired (`handoff-target-unpaired`), does not advertise `handoff-v1` **and** protocol
`1.1` (`handoff-target-capability-missing`), or has no configured subject
(`handoff-target-subject-missing`). Peers paired before handoff existed carry neither
field, so they keep working for ordinary traffic and are never offered to the model as a
delegation target.

`murmur-invite`, `murmur-join` and `murmur-add-peer` now carry these fields through the
pairing handshake, and `agent-config-init` writes the local advertisement.

**The transport subject comes only from the paired peer config.** The model cannot supply
a NATS subject — the action frame rejects any extra field, and the daemon re-checks that
the subject it was handed equals `peers[to].subject`.

Receiver side additionally requires: sender paired, signature valid, schema valid,
intended recipient exact, signed lineage valid. Normal audit policy still applies —
`deny` rejects the dispatch before any model runs (and returns `handoff-unauthorized`),
and `require_approval` keeps its deferred semantics with no failure result.

## The model action contract

**Delegation is never detected from prose.** The only programmatic handoff action is an
exact terminal structured frame — the model's *entire* final answer must be:

```json
{"murmur":{"action":"handoff","to":"<paired-agent-id>","task":"<bounded task>"}}
```

### The reserved control-frame grammar

There is exactly one framing rule, and it is a fixed prefix on the trimmed terminal
output:

```
^\{ \s* "murmur" \s* :
```

An answer that begins with an object whose **first key is `"murmur"`** has entered the
**reserved Murmur control-frame namespace**. That is the whole boundary: no prose scanning,
no keyword search (`handoff`, `delegate`, `murmur` in prose mean nothing), no JSON
extraction from surrounding text, and no heuristics of any kind. The runtime instruction
block tells the model the namespace is reserved.

Classification (`parseHandoffAction`) has exactly three outcomes:

| Input | Outcome |
|---|---|
| free-form prose, however it is worded | **ordinary result** |
| a complete JSON object with no `murmur.action` discriminator (e.g. `{"result":"ok"}`, or a `murmur` key that is not the first key) | **ordinary result** (unchanged contract) |
| a markdown-fenced frame — it does not start with `{"murmur"` | **ordinary result** (unchanged contract) |
| the exact, complete, valid action frame | **handoff** |
| inside the reserved namespace but **truncated or unparseable** | **FAIL CLOSED** `control-frame-incomplete` / `control-frame-unparseable` |
| inside the reserved namespace with trailing prose after the object | **FAIL CLOSED** `control-frame-incomplete` |
| inside the reserved namespace but `murmur` is not a control object | **FAIL CLOSED** `murmur-not-an-object` |
| inside the reserved namespace with no `action` key (e.g. an echoed system `murmur.result` frame) | **FAIL CLOSED** `control-frame-missing-action` |
| carries `murmur.action` but is malformed — unknown action, missing/blank `to` or `task`, unexpected fields, extra top-level keys, task over 16 KiB | **FAIL CLOSED** `unsupported-action:*` / `to-required` / `task-required` / `unexpected-fields:*` / `unexpected-top-level-keys` / `task-too-large` |

Every fail-closed case reports the stable reason `handoff-action-malformed` with the detail
above. A recognisable-but-malformed control frame is **never** downgraded into an ordinary
parent reply, so it can never prematurely complete a parent task as successful model
output. Concretely it does **not**: create a handoff, create a continuation, enqueue child
work, become an ordinary parent result, or mark the parent turn successful. The turn fails
with the stable reason, the existing at-least-once budget retries the model, and exhaustion
becomes a `terminal` dispatch with the usual notification.

The model controls **only** the target agent identity and the bounded task text. Murmur
owns `msgId`, recipient, subject, conversation, lineage, ancestry, wire version,
signature, memberSlot and routing.

Every autonomous runtime receives the contract as an instruction block prepended to its
prompt (`buildHandoffInstructions`). When no peer advertises `handoff-v1` the block is
empty, so prompts are byte-identical to pre-handoff behaviour until an operator opts in.
No extra tools are enabled for delegation.

## Routing

```
explicit recipient → paired peer subject → recipient daemon
                   → exact locally configured autonomous runtime / memberSlot
                   → AgentRuntimeRegistry exact lookup
```

For **handoff only** there is **no fallback**, ever: not to the legacy wake hook, not to
the stateless inbox, not to an interactive Claude drain, not to another runtime adapter.
No autonomous adapter available ⇒ `handoff-runtime-unavailable`. Unknown memberSlot ⇒
fail closed (`runtime-adapter-unavailable:<slot>`). There is no fallback between Claude,
Codex and Cursor.

The NATS ingress gate accepts both supported wire versions (a 1.1 handoff NACKed as
`invalid-envelope` would make the feature undeliverable). The proxy-subject path refuses
any non-1.0 envelope outright: it performs no signed-lineage validation and owns no
autonomous runtime, so a handoff must never be laundered through it as ordinary text.
The WebSocket broker likewise stays 1.0-only inbound.

## Continuation storage

`scripts/agent-handoff-store.mjs` persists **only** continuation/routing state. It does
not duplicate outbox state, transport status, `wake_dispatch` state or
`processing_attempts` status — those remain authoritative for delivery, wake and model
execution.

`agent_handoffs`:

| Column | Purpose |
|---|---|
| `handoff_msg_id` (PK) | the handoff id = the envelope's msgId |
| `delegator_id`, `recipient_id` | who delegated, who must answer |
| `caused_by_message_id` | the exact causative message/result |
| `root_message_id`, `root_conversation_id` | root lineage |
| `handoff_conversation_id` | derived, isolated conversation |
| `parent_active_ancestry_json` | the delegator's SAVED parent active path |
| `handoff_ancestry_json` | the emitted active ancestry |
| `originating_binding_id`, `originating_binding_generation` | originating runtime instance |
| `originating_runtime_kind`, `originating_member_slot` | only this kind/slot may resume |
| `originating_runtime_session_id` | Claude session / Codex thread / ACP session |
| `originating_server_generation`, `originating_server_identity` | Codex App Server boundary |
| `parent_message_id`, `parent_conversation_id`, `parent_sender_id` | what the delegator must ultimately answer |
| `task_text` | the bounded task (stable across replay) |
| `state` | `open` \| `closed` \| `terminal` |
| `enqueued_at` | envelope reached the durable outbox |
| `closed_by_message_id`, `closed_at`, `terminal_reason`, `created_at` | audit |

`UNIQUE (delegator_id, caused_by_message_id)` is the idempotency key.

### Fenced authority: every irreversible mutation is atomic with the fence

`runtime_bindings`, `wake_dispatch`, `agent_handoffs` and `outbox` all live in **one**
SQLite database, which makes one durable authority boundary possible — and mandatory.

`validateFence(); await …; mutate()` is **not** sufficient authority: a binding
replacement can land in the gap, after which a stale generation would still create a
continuation, enqueue child work, or close/terminalize a continuation a replacement runtime
now owns. Every such mutation therefore runs inside a single `BEGIN IMMEDIATE` transaction
that **re-reads the fence as part of the same transaction**:

| Primitive | One transaction does |
|---|---|
| `fencedCreate` | re-read fence → idempotently create/reuse the continuation → insert/reuse the exact outbound **outbox row** → set `enqueued_at` |
| `fencedClose` | re-read fence → verify continuation `open` → verify exact msgId + sender + **derived conversation** → CAS `open → closed` |
| `fencedTerminate` | re-read fence → mark terminal with an explicit reason |

The re-read mirrors `RuntimeBindingStore.validateFence` exactly: the binding row
(`binding_id`, `runtime_generation`, `lease_token`, `fencing_epoch`, not `OFFLINE`/`STALE`)
**and** the `wake_dispatch` ownership row for this exact message. Losing either — a replaced
generation, or just the dispatch assignment being released to a retry — is a lost fence.

A stale generation therefore leaves behind **no continuation row and no outbound handoff
outbox row**: both are in the refused transaction. Signing happens *before* the
transaction opens (it is async and must not hold a write lock), so a signing failure is
total and equally leaves nothing behind. The actual NATS publication is unchanged: it
still happens later through the normal durable outbox flush, and the non-authoritative
`local_messages` audit mirror is written only *after* the commit.

### Continuation CAS

When a child reply arrives with `replyToMessageId == handoff_msg_id`:

1. locate the continuation (ours only — another delegator's id is not ours to close).
   This is a **lookup**, not authority.
2. verify the reply sender == the expected handoff recipient
3. verify the reply arrived in the persisted **derived** handoff conversation
4. verify originating runtime kind/slot and that the exact session can genuinely be resumed
5. `fencedClose`: fence re-read + `open` check + exact correlation + CAS, all in one
   transaction, setting `closed_by_message_id` exactly once
6. resume the originating runtime session/context
7. restore `parent_active_ancestry_json`
8. insert the child result into the resumed model turn

Steps 2–5 all commit or none do. A **distinct** second reply can never resume again
(`handoff-continuation-already-closed`) and remains auditable. A redelivery of the **same**
closing message is reported as a replay so a retried dispatch can still finish the work it
already claimed.

### Why `open → closed` is enough (no third state)

The close commits *before* the model resume, which raises the obvious question: does a
crash between them lose the child result? No. The close records **which** message closed
it, and a redelivery of that same message is a `replay` that is allowed to resume. So:

- crash after close, before resume → the child dispatch retries → `replay` → the parent
  resumes and answers. Nothing is lost.
- a *different* second reply → refused forever. No duplicate resume.
- a stale generation → loses the CAS. No stale resume.

A `resume-pending` third state would add a lifecycle without adding a guarantee, so the
existing two-state CAS plus the same-message replay rule is what ships.

## Idempotency

The logical key is `(delegatorId, causedByMessageId)`: **one child handoff per causative
message / model turn.** A crash or replay of the same delegation action reuses the
existing handoff and its exact `msgId` — the outbox is `INSERT OR IGNORE` on msgId, so
re-enqueue is safe and no second delegated task is ever created. A causative turn may not
retarget its child (`one-handoff-per-causative-message`).

Lower-level idempotency continues to come from outbox retry, inbound dedupe,
`wake_dispatch` dedupe, processing receipts and deterministic reply ids.

**Fan-out is explicitly out of scope.**

## Local message audit

`local_messages` gained explicit nullable columns — `recipient_id`,
`handoff_root_message_id`, `handoff_root_conversation_id`,
`handoff_caused_by_message_id`, `handoff_ancestry_json` — so a handoff can be audited
without parsing plaintext. Existing ordinary rows stay valid with NULLs, and reads keep
the pre-handoff shape (absent optional scalars read back as `null`). Inbound backfill
rebuilds a recovered handoff's lineage from those columns, never from text.

## Handoff result flow

A successful handoff action means:

- the child handoff is durably created and enqueued
- the originating model's **ordinary parent reply is SUPPRESSED**
- the originating binding returns to `BOUND_IDLE` (safe idle/wait)
- the continuation remains `open`

The completed processing receipt for a delegated turn deliberately carries **no reply
correlation** (`disposition: "handoff"`), so durable reply recovery can never manufacture
a parent reply for a turn that delegated instead of answering.

When the child reply arrives the continuation closes once, the originating runtime is
resumed, the child result is inserted into the resumed context and the restored
`parentActivePath` is used. The resumed model may then either return an ordinary result to
its parent, or create another valid handoff — whose ancestry is rebuilt from the restored
parent path.

## Runtime continuation semantics and limits

Handoff semantics are implemented **once** (`HandoffTurnCoordinator` +
`settleRuntimeTurn`); each runtime contributes only a small `resumeGuard` answering "can
I genuinely resume this exact originating session right now?".

### Claude (one-shot)

- One-shot/resume architecture preserved; tools stay disabled.
- A continuation resumes the **exact** originating session id via `--resume`, which is
  CLI-side state and therefore survives a Murmur process restart. A restarted delegator
  reloads the open continuation from disk and resumes that session.
- Refused (`handoff-continuation-session-unavailable`) when the continuation has no
  recorded session, or the binding has meanwhile confirmed a **different** session — one
  binding holds one session, and starting an unrelated one is not a resume.

### Codex (App Server)

- External App Server design preserved; Murmur never kills it or unlinks its socket.
- The continuation stores the originating **thread id**. A resumed child result goes to
  that exact thread — **never** to a thread derived from the child sender or the derived
  handoff conversation. Ordinary turns keep their per-sender/per-conversation affinity,
  and a resumed turn re-registers the thread under the **originating** route.
- The Unix-socket identity is the durable App Server generation. If it changed, or was
  never captured, the continuation fails closed with
  `handoff-continuation-server-generation-changed`. The existing in-process
  server-generation invalidation rules remain authoritative.

### Cursor (ACP)

- ACP design preserved. A continuation resumes the originating ACP session **only while it
  is live** in the running client.
- Daemon-restart / `session/load` continuity is **not** claimed: if the exact session is
  not currently loaded, the continuation fails closed with
  `handoff-continuation-session-unavailable` rather than pretending a fresh session is a
  resume.

## Crash and recovery

All existing guarantees are preserved.

| Failure | Behaviour |
|---|---|
| target crashes during work | existing processing/retry semantics |
| target completed but reply enqueue crashed | durable completed receipt drives reply-only recovery (to the parent correlation for a resumed turn) |
| delegator crashed while the child works | the continuation is durable; restart reloads it and logs the open set |
| continuation row written but envelope never enqueued | cannot happen on the current path — the continuation and its outbox row commit in one transaction. `recoverPendingEnqueues()` remains as a safety net for rows predating that atomicity, and re-enqueues the **same** msgId without creating a second handoff |
| failure before the fenced commit (e.g. signing unavailable) | nothing is persisted at all: no continuation, no outbox row |
| safe continuation impossible | **fail closed**: an explicit `terminal_reason` is recorded and no unrelated new model session is created |

A stale runtime/binding generation may **not** create a handoff, enqueue its outbound
outbox row, close a continuation, terminalize a continuation, resume the parent, or send an
authoritative parent result. This is enforced by the fenced transactions above
(`handoff-continuation-stale-binding`), not by a check-then-mutate sequence. For Codex the
App Server generation boundary is enforced in addition.

## System-generated handoff failure

For a deterministic receiver-side rejection **after transport acceptance but before model
execution**, the recipient returns an exact correlated failure result:

```json
{"murmur":{"result":"handoff-failed","reason":"handoff-cycle","handoffMsgId":"H1"}}
```

with `replyToMessageId = <handoff msgId>`. It is not model success and it is not a new
handoff. Its msgId is derived from the handoff id (`handoff-failed-<handoffMsgId>`), so a
redelivery or an inbound-backfill replay can never produce a second distinct failure
result. Reasons include `handoff-self`, `handoff-cycle`, `handoff-depth-exceeded`,
`handoff-recipient-mismatch`, `handoff-runtime-unavailable`, `handoff-unauthorized`.

Two cases deliberately return **no** correlated failure, and keep durable evidence
instead:

- **A structurally malformed 1.1 envelope**, or one whose signature does not verify. It
  cannot be authenticated, so a "correlated" reply would itself be unauthenticated. It is
  NACKed at the transport boundary and, for a malformed shape, refused at the NATS ingress
  gate.
- **A sender-side refusal** (unknown/uncapable target, self, cycle, depth, malformed
  action frame). Nothing was delegated, so there is nobody to answer. The turn fails with
  a stable reason, the existing at-least-once budget retries the model, and an exhausted
  budget becomes a `terminal` dispatch with the usual terminal notification. The reason is
  durable in `wake_dispatch.last_error` and in the failed processing attempt.

Murmur never fabricates success.

## Non-goals

This slice deliberately does **not** add: a workflow engine, a DAG scheduler, a planner, a
voting system, an alternate transport, a `ChannelRoster`-based second routing system, an
MCP handoff tool, a UI, fan-out, or a persistent Claude `stream-json` optimization. It
also does not claim exactly-once model execution, more than one child handoff per
causative turn, or cross-runtime session continuity that the native protocol cannot
demonstrate.

## Related

- [`protocol-compatibility.md`](protocol-compatibility.md) — the 1.0/1.1 wire matrix
- [`agent-runtime-adapter.md`](agent-runtime-adapter.md) — the adapter contract and capability matrix
- [`runtime-bindings.md`](runtime-bindings.md) — binding states, fencing, generations
- [`processing-receipts.md`](processing-receipts.md) — durable model-execution receipts
