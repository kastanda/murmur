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
`runtime.cursorAcp`. Existing manual/legacy Codex wake configuration continues to
use the original injector when the autonomous Codex adapter is disabled.

For a scoped live investigation, `runtime.codexAppServer.protocolDiagnostics`
may be set to `true`. It emits only protocol method, thread/turn identifiers,
turn status, timestamp, transport and completion source through the daemon's
structured logger. Prompt and response content are never included. A
`turn/started` diagnostic, when present, does not strengthen the advertised
receipt capability or create a durable `started` receipt. Diagnostics are disabled
by default.

## Deliberate non-goals

This slice does not add channels, task handoff, workspace/write leases, Cursor
IDE automation, persistent Claude stream-json, or a claim of exactly-once model
execution. It also does not manufacture cross-runtime session semantics that the
native protocol cannot demonstrate.
