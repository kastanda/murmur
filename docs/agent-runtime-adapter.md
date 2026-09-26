# Agent runtime adapters

Murmur exposes its autonomous runtimes through one small internal contract. The
adapter layer standardizes ownership, routing and lifecycle calls; it does not
pretend that the underlying protocols have identical semantics.

## Contract

Every adapter has immutable `runtimeKind`, `memberSlot` and `capabilities`
properties and implements:

- `start(options)` — establish the runtime binding and runtime-specific resources.
- `executeTurn(payload, dispatch)` — execute one already-claimed dispatch.
- `cancel(options)` — cancel only when the advertised capability is true.
- `health()` — report binding health plus runtime-specific process or transport data.
- `shutdown()` — stop heartbeats, retire the binding and release owned resources.

Adapters may additionally implement `recoverCompletedReplies()` for deterministic
reply recovery. `AgentRuntimeRegistry` selects an adapter by the dispatch's exact
member slot. An unknown slot fails closed; there is no default runtime fallback.

## Capability matrix

| Capability | Claude one-shot | Codex App Server | Cursor ACP |
|---|---:|---:|---:|
| runtime kind | `claude_one_shot` | `codex_app_server` | `cursor_acp` |
| member slot | `claude:auto` | `codex:app-server` | `cursor:acp` |
| persistent process owned by Murmur | no | no (external server) | yes |
| session continuity | yes, `--resume` | yes, per sender+conversation within one App Server generation | yes, live ACP session |
| resume across Murmur process restart | yes | not claimed | not claimed |
| trustworthy started receipt | no | no; not guaranteed on the autonomous Unix/WebSocket path | yes, `session/update` |
| trustworthy completed receipt | yes, successful CLI result | yes, `turn/completed` | yes, terminal prompt result |
| native cancel advertised | yes, child termination | no | yes, ACP cancel/fallback termination |
| adapter-owned binding heartbeat | yes | yes | yes |
| autonomous | yes | yes | yes |
| interactive | no | no | no |
| handoff continuation resume | yes, `--resume <session>` (survives a Murmur restart) | yes, the exact originating thread, only while the App Server socket identity is unchanged | yes, only while the exact originating ACP session is live |

Claude owns a short-lived `claude -p` child per turn and persists the confirmed
Claude session id. Codex connects to an externally managed App Server socket per
turn and maintains independent thread affinity for each Murmur
sender+conversation route; it does not claim to own or cancel that server. Cursor
owns one persistent ACP child and keeps its ACP
session live until shutdown, but daemon-restart `session/load` continuity remains
explicitly unclaimed.

## Codex thread and server generations

One Codex runtime binding represents the autonomous worker, not a single model
thread. The live adapter keys thread affinity by the exact pair
`(senderId, conversationId)`, so one daemon may manage multiple independent Codex
threads. Repeated turns on the same pair reuse its thread while different senders
or conversations never share one. `runtime_bindings.runtime_session_id` is not an
authoritative Codex thread field; each completed processing attempt records the
actual thread used in its recovery metadata.

The Unix socket identity defines the external App Server generation. If that
identity changes or disappears, all thread mappings from the previous generation
are invalidated. The next turn reconnects, initializes normally, and seeds a new
thread without restarting the Murmur daemon. A single server-side invalid-thread
response replaces only that conversation's mapping.

If the server generation changes during a turn, the old result cannot produce an
authoritative completion or reply. The created attempt remains an honest unknown
outcome and the dispatch is released for the existing at-least-once retry policy.
Murmur never kills the external App Server or unlinks its socket. Codex model
thread context continuity across an App Server restart is intentionally not
promised.

## Binding and receipt invariants

All autonomous adapters assign work through `RuntimeBindingStore` using their
exact member slot. Generation, lease token and fencing epoch remain authoritative
for completion, reply emission and the transition back to `BOUND_IDLE`.

The generic registry never creates processing receipts. Each runtime records only
events its production path can prove: Claude records completion but no synthetic
start; Codex advances an attempt directly from `created` to `completed` after a
correlated terminal result; Cursor maps correlated ACP updates and terminal prompt
results. A durable completed attempt is independent from
reply delivery, and reply recovery uses the attempt id as the deterministic
outbound message id.

Only one autonomous runtime may be enabled in a daemon configuration. The
supported opt-in keys are `runtime.claudeOneShot`, `runtime.codexAppServer`, and
`runtime.cursorAcp`. An inbound handoff routes to that exact member slot and to nothing
else: there is no fallback to the legacy wake hook, the stateless inbox, an interactive
drain, or another adapter. Existing manual/legacy Codex wake configuration continues to
use the original injector when the autonomous Codex adapter is disabled.

For a scoped live investigation, `runtime.codexAppServer.protocolDiagnostics`
may be set to `true`. It emits only protocol method, thread/turn identifiers,
turn status, timestamp, transport and completion source through the daemon's
structured logger. Prompt and response content are never included. A
`turn/started` diagnostic, when present, does not strengthen the advertised
receipt capability or create a durable `started` receipt. Diagnostics are disabled
by default.

## Explicit handoff continuation

Handoff semantics are implemented **once** and shared by all three adapters — no adapter
re-implements them. Two collaborators do the work:

- `HandoffTurnCoordinator.prepareTurn(...)` classifies a claimed dispatch as an ordinary
  turn, an inbound bounded handoff task, or a **continuation** resume of a delegator, and
  produces the prompt, the exact reply correlation, the root lineage, the restored
  `parentActivePath` and the session to resume.
- `settleRuntimeTurn(...)` turns a terminal model result into exactly one durable outcome:
  an ordinary correlated reply, a durably created child handoff with the parent reply
  **suppressed**, or a fail-closed error. Without a coordinator it is byte-for-byte the
  pre-handoff behaviour.

Each adapter contributes only a small `resumeGuard` answering "can I genuinely resume this
exact originating session right now?", and passes its `fence` + dispatch `identity` through
so every irreversible continuation mutation commits atomically with a re-read of that
fence (see the fenced-authority section of `agent-handoff.md`). A stale runtime generation
cannot create a handoff, enqueue its outbound outbox row, close a continuation, or
terminalize one:

| Adapter | Guard | Refusal reason when it cannot resume |
|---|---|---|
| Claude | the recorded session id exists and the binding has not confirmed a different one | `handoff-continuation-session-unavailable` |
| Codex | the App Server **socket identity** (and in-process generation) is unchanged | `handoff-continuation-server-generation-changed` |
| Cursor | the exact originating ACP session is currently loaded in the live client | `handoff-continuation-session-unavailable` |

A Codex continuation resumes the **exact originating thread** recorded in the
continuation — never a thread derived from the child sender or the derived handoff
conversation — and re-registers it under the **originating** `(sender, conversation)`
affinity route. Ordinary Codex turns keep their existing per-sender/per-conversation
affinity unchanged.

A refused continuation records an explicit terminal reason and retires the dispatch; no
adapter silently starts an unrelated new model session and calls it a resume.

A delegated turn's completed processing receipt deliberately carries no reply correlation
(`disposition: "handoff"`), so `recoverCompletedReplies()` can never manufacture a parent
reply for a turn that delegated instead of answering. A resumed turn's receipt carries the
**parent** correlation, so reply-only recovery answers the right message.

Full specification: [`agent-handoff.md`](agent-handoff.md).

## Deliberate non-goals

This slice does not add channels, workspace/write leases, Cursor IDE automation,
persistent Claude stream-json, or a claim of exactly-once model execution. It also does
not manufacture cross-runtime session semantics that the native protocol cannot
demonstrate. Explicit handoff (added separately) supports exactly **one child handoff per
causative model turn**; fan-out, planners and DAG scheduling remain out of scope.
