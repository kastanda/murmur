# Murmur Runtime/Communication Layer — Architecture Audit

Date: 2026-09-17  
Scope: canonical physical repository `/Users/andrejlitvinov/Projects/murmur`  
Mode: read-only architecture audit. Runtime code, commits, remotes, and worktrees were not changed.

## Executive conclusion

Murmur already has a credible encrypted at-least-once transport and several strong primitives: durable SQLite outbox/deduplication, signed delivery ACKs, a typed channel roster, a fenced session lease, Claude wake scripts, and a Codex App Server injector. It is not yet a unified autonomous multi-runtime communication layer.

The missing center is a durable orchestration state machine between transport delivery and runtime completion. Today `WakeMonitor` is an in-memory dispatcher, runtime integrations use different implicit contracts, correlation is conversation-based rather than request-based, presence is not wired end-to-end, and Cursor has no implementation. Most importantly, a wake cursor is advanced even when a wake is deferred, denied, or fails. That converts recoverable runtime failures into permanently consumed work.

The reported “first answer succeeds, later messages stop” symptom has several plausible causes, but two are highest priority:

1. Claude's cold-idle mechanisms are one-shot. `murmur-coldidle-watch.sh` explicitly exits after a wake and requires re-arm. The Node poller also exits after one wake and relies on Claude invoking the Stop hook again. If that lifecycle event does not happen after an `asyncRewake`, no poller remains.
2. `WakeMonitor.processPayload()` records a message as seen before runtime dispatch and advances its in-memory cursor in all terminal branches, including lease defer, audit deny, loop-breaker suppression, and injector failure. There is no durable wake job or retry. A transient stale session, lock, socket, or lease condition therefore loses the only wake attempt.

Recommendation: preserve the current transport, but insert a durable `Delivery -> Dispatch -> Turn -> Reply` state machine and make every runtime implement one `AgentRuntimeAdapter`. Treat Cursor CLI ACP (`agent acp`) as Cursor's native interface; do not automate Cursor IDE.

## Current Architecture

### 1. Agent identity

- Local identity is static configuration in `.data/agent-config.json`: `agentId`, NATS subject, Curve25519 encryption keys, Ed25519 signing keys, and a map of trusted peers.
- An envelope carries `senderAgentId` and `recipients`. The daemon looks up the sender in the configured peer map, verifies the Ed25519 signature, and decrypts using the peer encryption key.
- Discovery defines signed presence frames and an in-memory `CandidateRegistry`. Discovery is explicitly candidate-only; trust promotion remains an operator action.
- Federation adds `org/agentId` naming and roster/auth-token primitives, but daemon auth enforcement is not wired in the audited path. The README also marks this as remaining work.
- Identity currently conflates a logical agent with one configured daemon identity. Runtime instance, session, persona/member slot, and workspace identity are separate ad hoc fields rather than one canonical identity model.

Assessment: cryptographic peer identity is solid for configured peers; runtime-instance identity and live identity lifecycle are incomplete.

### 2. Presence

There are two unrelated notions of presence:

- Network discovery presence: `PresenceFrameV1` + signed frame verification + in-memory candidate expiry.
- Local runtime presence: `session_presence` in `lease.db`, populated through `SessionLeaseStore.registerSession()` and refreshed by `sessionHeartbeat()`.

`hasLiveInteractiveSession()` considers `foreground` and `mcp-channel` rows live within a TTL. Native wake defers when such a row exists.

Gaps:

- The daemon does not publish or consume discovery presence in its main loop.
- There is no durable runtime registry that maps `agentId -> runtime -> session -> health -> capabilities`.
- No general session unregister/cleanup API exists; rows become harmless only through TTL comparison and remain stored indefinitely.
- The repository does not show a complete heartbeat loop for Claude or Codex foreground sessions. The cold-start watcher registers once, but does not heartbeat during a possibly 30-minute Codex turn.
- Presence means “heartbeat was recently written,” not “runtime can accept the next turn.”

### 3. Direct messaging

`murmur_send` builds an encrypted/signed `EnvelopeV1`, enqueues it in the SQLite outbox, and appends an outbound local message. The daemon flushes the outbox to a peer's NATS subject. The receiving daemon verifies, decrypts, appends an inbound local message, optionally notifies, then invokes `WakeMonitor`.

Delivery mode is at-least-once. Duplicate envelopes are detected by `(consumerId, msgId)` and acknowledged as `duplicate-ignored`.

Limitations:

- The daemon accepts a configured `recipients` field but subscribes by subject; it does not explicitly reject an envelope whose recipients do not include the local agent.
- Optional envelope metadata (`ttlSeconds`, `traceId`, `sequence`, `parentMsgId`) is defined, but the canonical signed payload currently covers only the required routing/cipher fields plus optional auth token. These optional correlation fields therefore are not integrity-bound.
- Local message persistence does not retain parent/correlation/channel addressing metadata.

### 4. Request/reply correlation

`murmur_request` sends a normal envelope, then waits for the first inbound local message that:

- is in the same `conversationId`;
- is from the requested peer;
- was stored after `sentAt`.

A read-only ephemeral NATS subscription only accelerates the SQLite recheck; the daemon remains the decrypt/persistence authority. The wait loop correctly arms its wake promise before checking the store, avoiding a lost wakeup.

This is temporal heuristic correlation, not request/reply correlation. `parentMsgId` exists but is neither set by `murmur_request`, propagated by reply paths, persisted in `local_messages`, nor matched by `buildReplyMatcher`. Two concurrent requests to the same peer and conversation can both resolve to the same first reply or cross-match replies. A spontaneous peer message can also satisfy a request.

### 5. Conversation and channel routing

- `conversationId` is the durable history label and the effective routing key used by current send/reply flows.
- `ChannelRosterStore` introduces a distinct `channelId`, channel type (`dm`, `group`, `consult`), members, slots, roles, persona/model bindings, eligibility, and close state.
- `evaluateAddressing()` supports legacy traffic, explicit member/agent addressing, observer mute, membership validation, and broadcast semantics.
- Codex thread seeding can resolve a member binding into model/personality/base instructions.

The roster is currently an optional side database and MCP utility. `EnvelopeV1` has no `channelId`, addressee, message kind, or broadcast policy fields. The main daemon inbound path does not call `evaluateAddressing()`. Consequently, group routing and `@agent` semantics exist as a policy helper, not as end-to-end protocol behavior.

### 6. Session affinity and `SessionLeaseStore`

The lease key is `(conversation_id, member_slot)`. `claimOrSkip()` performs a single-statement SQLite CAS. A successful claim increments a monotonic fencing token; ownership changes increment an epoch. A same-session re-claim also increments the token. `heartbeat()` extends a lease without changing the token. `isCurrentToken()` provides an outbound fence. A real session can preempt a `native:` fallback owner.

Strengths:

- Correct atomic acquisition in SQLite WAL.
- Explicit stale takeover based on stored TTL.
- Monotonic per-turn fencing.
- Separate lease DB avoids contention with the message store.
- Native wake is demoted when a live interactive session exists.

Gaps and hazards:

- Feature is default-off (`MURMUR_SCOPED_CHANNELS`).
- The native daemon gate claims before wake, but the Codex App Server relay does not verify the fencing token immediately before sending its answer.
- No heartbeat is held across a long native/App Server turn. A 20-second default TTL can expire while an agent is thinking, allowing takeover and duplicate turns.
- Native ownership is not released after completion or failure. Same-owner subsequent messages still re-claim successfully, but failed owners persist until staleness and obscure lifecycle state.
- `session_presence` and channel ownership are separate tables with no foreign key or liveness reconciliation.
- Staleness uses wall-clock deltas. Clock rollback/large skew can extend a stale lease; process identity and boot identity are not checked.
- Presence rows and owner rows are never pruned.
- The Python cold-start path duplicates the canonical SQL and lifecycle logic, increasing drift risk.
- A cold-start session registers presence once and can lose its lease during `codex exec`; it checks the token before send, preventing a stale emit, but wastes the completed turn and does not retry/requeue the message itself.

### 7. Native wake

`WakeMonitor` is constructed by the daemon and serializes an in-memory FIFO. It supports:

- in-memory msgId cooldown dedup;
- sender loop breaker;
- audit hook;
- optional native lease gate;
- stateless shell hook;
- Codex App Server injector;
- backlog loading from `local_messages` after an in-memory cursor.

The daemon initializes the cursor to the current inbound tip. This prevents replay on daemon restart, but also means any message persisted before a crash and not successfully woken is skipped after restart unless another component separately scans it.

There is a `message_events` model with `queued`, `delivered`, `woke`, `wake_failed`, `handled`, `replied`, and `failed`, but the daemon/wake flow does not use it to drive retries or completion.

### 8. Retry and ACK

Transport reliability is the strongest area:

- SQLite outbox with `pending/sent/acked/failed/dlq`.
- Exponential backoff with jitter.
- ACK-timeout requeue of stale sent rows.
- Compare-and-swap version prevents a late `markSent()` from resurrecting a settled row.
- Signed ACKs bind digest, conversation, sender, recipient, status, timestamp, and nonce.
- Durable ACK nonce claims protect against replay across daemon restart.
- Optional JetStream durable consumers, explicit ACK, finite redelivery, and advisory-to-DLQ handling.

But this is delivery ACK, not agent-processing ACK. The receiver ACK is emitted after `onMessage()` returns. Because `onMessage()` currently awaits wake injection, a Codex relay may delay delivery ACK for the entire turn; with other wake modes an ACK can still mean only “hook command returned,” not “agent handled and replied.” There is no protocol-level `accepted`, `started`, `completed`, or `reply` receipt.

### 9. Stale lock and session recovery

- Node Claude poller lock contains PID, is exclusively created, reclaims a dead PID, and enforces a finite age ceiling for PID reuse or legacy malformed locks. Cleanup only removes a lock still owned by its PID.
- Shell cold-idle watcher uses `flock`, so kernel process exit releases the lock. Waiting duplicate watchers can take over, but the watcher exits after a message and depends on queued watchers or external re-arm.
- Codex App Server injector re-seeds only for the exact `thread not found` error. Other stale/busy/cancelled/thread-corrupt states are terminal for that wake.
- Cold-start watcher uses a process-level file lock and a persistent row cursor; its lease can expire during work.
- No central reconciler scans stale runtime jobs, sessions, leases, or wake attempts after daemon restart.

## What Already Works

1. Encrypted and signed peer-to-peer envelopes for configured peers.
2. Durable, idempotent transport with outbox retry, dedupe, signed ACK hardening, and DLQ.
3. Correct lost-wakeup handling inside `murmur_request`'s wait loop.
4. Durable local message history and an additive lifecycle-event schema.
5. Atomic session ownership and fencing primitive with tested stale takeover.
6. Native-fallback deferral to recent interactive presence.
7. Claude per-session cursors, avoiding the old shared-cursor “random session wins” defect.
8. Node Claude poller recovery from dead or stale lock owners.
9. Codex App Server initialize, thread resume/start, turn start, stale-thread re-seed, final-answer capture, and relay scaffolding.
10. Typed channel/member/persona model and a reusable addressing decision function.
11. Codex one-shot responder dedupe and final outbound token fence.
12. A practical Cursor-native entry point is available locally: installed Cursor Agent `2026.09.02-c22c1a3` exposes `agent acp`.

## Gaps

### P0 — correctness blockers

1. **Wake work is not durable.** The persistent inbound row is treated as a cursor stream, but wake status and attempts are in memory.
2. **Cursor advances on failure/defer.** `WakeMonitor` advances after lease mute, audit suppression, loop breaker, duplicate cooldown, and caught injector/hook errors.
3. **Restart skips unhandled messages.** Daemon starts the wake cursor at the current inbound tip, with no reconciliation against `woke/handled/replied` state.
4. **No strict request correlation.** The first later message in a conversation can satisfy any waiter.
5. **No lease heartbeat around long turns.** Runtime work can outlive TTL and lose ownership.
6. **No universal outbound fence.** Only the cold-start one-shot path enforces the lease token at reply send.
7. **No exactly-one live responder for Claude.** Per-session cursors intentionally wake every live Claude session. The lease system is not integrated into Claude hook handling.

### P1 — architecture gaps

1. No `AgentRuntimeAdapter` or normalized runtime/session state.
2. No Cursor runtime integration in the repository.
3. Channel addressing is not carried and enforced end-to-end.
4. Presence/discovery is not wired into the daemon runtime path.
5. No explicit processing ACK or task/turn lifecycle protocol.
6. No durable automatic reply route (`replyToMsgId`, origin session, expected responder).
7. No workspace/task/write lease for a shared physical repository.
8. No durable per-conversation ordering or concurrency policy.
9. In-memory WakeMonitor dedup and loop-breaker state vanish on restart.
10. Optional envelope metadata is not integrity-bound by the canonical signature payload.

### P2 — operational and product gaps

1. Feature flags make key semantics default-off and combinatorially hard to reason about.
2. Config is read only on daemon start; session changes require daemon restart.
3. Runtime health is inferred from errors instead of actively probed.
4. No capability negotiation for resume, cancel, streaming, permissions, tools, or workspace writes.
5. No end-to-end three-runtime acceptance harness.
6. No policy for headless permission questions; a runtime can block indefinitely.

## Root Cause Candidates

### Reported symptom: first successful response, then later messages stop

| Priority | Candidate | Evidence and failure sequence | How to prove/disprove |
|---|---|---|---|
| P0 | Claude watcher is not re-armed | `murmur-coldidle-watch.sh` exits after first wake and prints “Re-arm the watcher after handling.” Node poller also exits after emitting. If the rewoken turn does not reach the Stop hook or the harness does not relaunch the background watcher, no process watches the next message. | Record poller PID/lock and hook invocation ID across 10 turns; assert a new armed poller exists before each reply is sent. |
| P0 | Failed wake is consumed | `WakeMonitor` inserts `seen` before dispatch, catches injector errors, and always advances cursor in `finally`. There is no retry row. The next daemon restart seeds to tip, cementing loss. | Force one socket failure after persistence; restore socket; verify the same msgId is never retried today. |
| P0 | Lease defer consumes work | Live-but-stale-in-practice `session_presence` makes native gate return `live-interactive-session`; WakeMonitor advances. If that session is not actually polling, nobody handles the message. | Insert/retain a fresh presence row with no functional runtime; send message; observe no wake and advanced cursor. |
| P0 | Loop breaker suppresses ordinary conversation | Default is five wakes per sender per 60 seconds. A fast 10-turn dialogue can trip it. While suspended, each inbound extends suspension and is consumed. | Run turns faster than 12 seconds; inspect `loop-breaker tripped/suspended` logs. |
| P1 | Claude cursor is advanced before successful handling | Drain scripts write the cursor before emitting exit 2. If Claude ignores/fails the reminder, the message will not wake again. | Inject a message, make the rewake fail, rerun drain; it reports nothing. |
| P1 | Shell drain skips a concurrent row | Shell version selects rows, then separately advances to current MAX inbound. A row inserted between those queries can be advanced past without being printed. The Node port correctly advances to last reported row. | Add a barrier between SELECT and MAX and insert another inbound row. |
| P1 | Lease expires during runtime turn | Native/cold-start claims use 20s default TTL but do not heartbeat during long model execution. Another session can take over. Cold-start suppresses stale output, while App Server relay lacks a final fence. | Use a >20s turn and trigger competing claim; inspect duplicate/lost response behavior. |
| P1 | Stale App Server state not recognized | Only error text beginning `thread not found` triggers re-seed. Busy turn, invalid lifecycle, closed socket, timeout, or session-log mismatch does not recover. WakeMonitor consumes the message. | Fault-inject each App Server error class and verify no retry today. |
| P1 | Request waiter consumes wrong reply | Matcher is only conversation + peer and DB selection is “after sentAt, limit 1.” A previous late reply or concurrent request can satisfy the second turn, making the actual later reply appear ignored. | Start two requests concurrently in one conversation and reverse reply order. |
| P2 | Cursor/lock key collision | Claude session key uses only the first eight characters. Collisions are unlikely for UUIDs but possible; missing `CLAUDE_CODE_SESSION_ID` collapses all sessions to the legacy shared cursor/lock. | Log full session ID, derived key, cursor, and lock for all live sessions. |
| P2 | Daemon is blocked by a long native turn | `onMessage()` awaits `wakeMonitor.onInbound()`, and the monitor serially awaits App Server final relay. Subsequent deliveries for that subscription wait behind the active turn. | Send message 2 while message 1 runs for minutes; compare NATS delivery and local persistence times. |

The likely Claude-specific primary cause is re-arm failure combined with “advance before handle.” The likely system-wide cause is the absence of a durable wake/turn job whose completion, retry, and lease are transactional.

## Runtime Integration Audit

### Claude Code / `asyncRewake`

Current integration:

- Shell one-shot drain for Stop/PostToolUse/UserPromptSubmit.
- Node long-poll drain for Stop hook, with per-session cursor and PID lock.
- Separate shell cold-idle watcher using `flock`.
- Exit code 2 + stderr reminder is the turn injection mechanism.

What is good: it uses Claude's native hook behavior, has per-session isolation, avoids polling gaps in the Node variant, and contains strong stale-lock handling.

What is missing: no runtime session API, no positive acknowledgment that Claude accepted the reminder, no durable re-arm state, no lease acquisition/fence in the hook, no heartbeat, no cancellation, no health probe, and no reliable mapping from a Murmur channel to exactly one Claude session.

### Codex / App Server

Current integration:

- WS-over-UDS client performs `initialize` and `initialized`.
- Supports `thread/start`, optional `thread/resume`, and `turn/start`.
- Re-seeds an absent thread.
- Can wait for final events, fall back to session JSONL, and relay a final answer through Murmur.
- Can seed model/personality/instruction metadata from a channel member.

What is good: this is a real native runtime protocol, and it is the closest current component to a reusable adapter.

What is missing: persistent connection/session supervisor, normalized health, cancel, busy-turn policy, multi-turn queue, durable thread mapping, lease heartbeat, final outbound fencing, permission-request policy, and reliable separation between Desktop-visible and headless App Server sessions. The current per-message connection also loses runtime notifications outside that call.

### Cursor

There is no Cursor runtime implementation in the repository. Existing files named `murmur-to-acp-producer` refer to a separate local “agent control plane,” not Cursor's Agent Client Protocol.

The installed Cursor Agent reports version `2026.09.02-c22c1a3` and exposes:

```text
agent acp
Start the Cursor Agent as an ACP (Agent Client Protocol) server
```

Cursor's official ACP documentation defines a stdio, newline-delimited JSON-RPC server with this flow:

1. `initialize`
2. `authenticate` (`cursor_login`, or pre-authenticated CLI/API key)
3. `session/new` or `session/load`
4. repeated `session/prompt`
5. streamed `session/update`
6. `session/request_permission` responses
7. optional `session/cancel`

Source: [Cursor ACP documentation](https://prod.cursor.com/docs/cli/acp).

Conclusion: `agent acp` should be the full native Cursor runtime interface. IDE automation would add focus/window fragility, no durable protocol correlation, and ambiguous session targeting while ACP already provides session creation/load, prompt, streaming, cancellation, and permission negotiation.

## Target Architecture

### 1. Layering

```text
Encrypted transport (NATS/JetStream + SQLite outbox + signed delivery ACK)
        |
        v
Durable inbox and protocol ledger
        |
        v
Channel router + reply correlation + addressing policy
        |
        v
Durable dispatch/turn state machine + session/workspace leases
        |
        v
AgentRuntimeAdapter
   | ClaudeRuntime | CodexRuntime | CursorRuntime |
        |
        v
Processing receipts, reply envelopes, task handoffs, observability
```

Transport delivery and runtime completion must be independent states. A message is not consumed merely because it was persisted or a wake was attempted.

### 2. Canonical message model

Introduce a protocol v2 envelope or a signed extension block containing:

- `messageId`
- `channelId`
- `conversationId`
- `sender: { agentId, runtimeSessionId? }`
- `targets: [{ agentId?, memberId?, role? }]`
- `mode: direct | addressed | broadcast`
- `kind: message | request | reply | task_handoff | receipt | control`
- `correlationId`
- `causationId`
- `replyToMessageId`
- `sequence`
- `deliveryPolicy`
- `createdAt`, `expiresAt`
- encrypted content and attachments

All fields affecting routing, authorization, ordering, or correlation must be signed. Persist them in normalized inbox/outbox rows rather than discarding them into local text-only history.

For migration, accept v1 envelopes and derive `channelId = conversationId`, `kind = message`, and legacy broadcast semantics.

### 3. Durable processing state machine

Create one durable row per `(messageId, targetMemberSlot)`:

```text
received -> eligible -> claimed -> dispatching -> accepted -> running
        -> completed -> reply_queued -> replied
        -> deferred(retryAt)
        -> failed_retryable(retryAt)
        -> failed_terminal
        -> expired
```

Rules:

- Transport dedupe prevents duplicate inbox rows.
- Dispatch dedupe prevents duplicate runtime turns.
- Cursor/checkpoint advances only when a durable dispatch row exists, never as a substitute for processing state.
- Retryable runtime failure retains the same message/dispatch identity and increments attempt.
- Runtime completion records a processing receipt distinct from transport ACK.
- Reply enqueue and marking the inbound `replied` occur in one SQLite transaction when local.
- On daemon restart, reconcile all nonterminal rows; never seed past unhandled work.

### 4. `AgentRuntimeAdapter`

Proposed TypeScript contract:

```ts
interface AgentRuntimeAdapter {
  readonly runtime: "claude-code" | "codex" | "cursor";

  capabilities(): Promise<RuntimeCapabilities>;
  health(ref?: RuntimeSessionRef): Promise<RuntimeHealth>;

  startSession(input: StartSessionInput): Promise<RuntimeSession>;
  resumeSession(ref: RuntimeSessionRef): Promise<RuntimeSession>;
  wake(ref: RuntimeSessionRef, signal: WakeSignal): Promise<WakeReceipt>;
  sendTurn(ref: RuntimeSessionRef, turn: RuntimeTurn): Promise<RuntimeTurnHandle>;
  cancel(ref: RuntimeSessionRef, turnId?: string): Promise<CancelResult>;
}
```

Required common semantics:

- Every session and turn has stable Murmur IDs plus runtime-native IDs.
- `sendTurn` is idempotent on Murmur `dispatchId`.
- Adapter emits normalized events: `accepted`, `started`, `output_delta`, `permission_required`, `completed`, `failed`, `cancelled`.
- `wake` only makes a dormant session able to accept a turn; `sendTurn` carries the actual message. An adapter may combine them internally but must report both outcomes.
- `health` distinguishes process reachable, session loadable, session busy, auth required, permission blocked, and degraded.
- Capabilities declare `resume`, `cancel`, `streaming`, `permissions`, `parallelTurns`, `headless`, `workspaceWrites`, and supported modes.
- A session supervisor heartbeats the Murmur session lease while a turn is running and fences any reply/write commit.

### 5. Adapter implementations

#### `ClaudeRuntime`

Near-term implementation:

- `startSession`: register a Claude session/hook endpoint supplied by a launcher wrapper.
- `resumeSession`: validate the registered session and re-arm a managed long poll.
- `wake`: native `asyncRewake` reminder through the hook bridge.
- `sendTurn`: enqueue a session-targeted inbox item consumed by the hook; wait for explicit runtime receipt, not cursor movement.
- `cancel`: mark dispatch cancelled; if Claude provides no native turn cancel, expose `supported: false` and prevent reply commit.
- `health`: verify recent session heartbeat, poller generation, lock owner identity, and last hook receipt.

Replace file cursors as the source of truth with durable dispatch claims. Keep a cursor only as an efficient scan checkpoint. Run the poller under a supervisor that immediately re-arms after each fire, independently of whether a Stop hook happens.

#### `CodexRuntime`

- Long-lived App Server connection owned by a supervisor.
- `startSession -> thread/start`.
- `resumeSession -> thread/resume` with stale-thread re-seed policy.
- `wake`: health/resume the headless runtime; no UI promise.
- `sendTurn -> turn/start`, normalize events and final output.
- `cancel -> turn/cancel` when supported by the active App Server schema.
- `health`: socket connect, initialize, thread loadability, active turn, and auth/permission state.

Persist `(murmurSessionId, channel/member slot) -> socket identity + threadId + threadPath + generation`. Handle all recoverable error classes, not only string-matched `thread not found`. Heartbeat and fence during the full turn and relay.

#### `CursorRuntime`

- Spawn one managed `agent acp` child per runtime instance or bounded session pool in the canonical repository cwd.
- `startSession -> session/new`.
- `resumeSession -> session/load`.
- `wake`: ensure ACP process is alive/authenticated and session is loaded.
- `sendTurn -> session/prompt`; collect `session/update` chunks and terminal stop reason.
- `cancel -> session/cancel`.
- `health`: process, protocol initialization, auth, session availability, and blocked permission request.
- `capabilities`: sourced from ACP initialize response plus Murmur policy.

The ACP client must answer `session/request_permission` and Cursor blocking extension methods (`cursor/ask_question`, `cursor/create_plan`) by deterministic policy: allow from a scoped permission profile, reject, or transition the Murmur job to `needs_approval`. Never leave a JSON-RPC request unanswered.

### 6. Pairwise and three-way conversation routing

Represent Claude, Codex, and Cursor as channel members with stable `memberId` and `memberSlot` values.

- **DM:** channel has two active members; unaddressed input targets the other member.
- **Three-way channel:** all three members receive history, but responder eligibility is explicit.
- **`@agent`:** parser resolves mentions against channel roster and writes exact target member IDs into signed routing metadata. Do not route based on plaintext regex at the receiver.
- **Broadcast:** `mode=broadcast` creates one dispatch target per eligible active member. Each target has its own delivery/processing state and lease.
- **Automatic reply:** reply inherits `channelId` and `conversationId`, sets `replyToMessageId`, `correlationId`, and targets the original sender unless an explicit handoff/mention overrides it.
- **Multi-turn:** one ordered session binding per `(channelId, memberSlot)`; reuse native runtime session while healthy, rehydrate or replace it with a new generation when stale.
- **Task handoff:** `kind=task_handoff` includes objective, artifacts/paths, constraints, expected output, lease requirements, and correlation. Recipient emits accepted/rejected, progress, and completion receipts. Handoff does not grant write authority outside the declared scope.
- **Exactly-one responder:** addressed messages create one target slot. Multiple runtime sessions compete for the target's dispatch lease; only the fenced winner may start a turn or send a reply.

For open group discussion, avoid accidental reply storms. Require either explicit targets, a moderator policy, or a bounded responder policy such as `first-eligible`, `all-addressed`, or `round-robin`. Broadcast is not synonymous with “everyone replies.”

### 7. Canonical repository workspace/task/write leases

All runtimes must operate on the same physical repository. Do not create worktrees or copies for isolation.

Add three lease scopes in the same durable coordination service:

1. **Workspace lease** — shared read lease for `/Users/andrejlitvinov/Projects/murmur`; an exclusive maintenance lease only for operations that change repository-wide state (dependency install, branch switch, generated lockfile rewrite).
2. **Task lease** — one owner for a task/handoff ID, preventing two sessions from implementing the same task.
3. **Write lease** — exclusive leases on normalized repo-relative paths or conservative path prefixes. Acquire all paths in sorted order atomically to prevent deadlocks.

Lease row fields:

```text
scope_type, scope_key, owner_session_id, task_id, token, epoch,
heartbeat_at, expires_at, mode(read|write), intent, generation
```

Rules:

- Read-only analysis requires no path write lease.
- Before editing, runtime declares an intended write set. Unknown write set acquires a conservative directory prefix.
- Overlapping write prefixes conflict; disjoint paths can proceed.
- Every write operation and final patch/commit boundary checks the fencing token.
- Heartbeat runs independently of model/tool activity.
- On lease loss, adapter cancels or switches to read-only and cannot publish a “completed write” result.
- Git index/branch operations require a repository-wide exclusive lease.
- A task can transfer leases only via an explicit handoff transaction: old owner releases/fences, new owner claims next epoch.
- Daemon restart reconciles by TTL + owner generation; it never trusts PID alone.

This prevents concurrent writes without violating the canonical-single-repository constraint.

## Migration Plan

### Phase 0 — Observability and reproduction

1. Wire existing `message_events` into receive, wake attempt, wake failure, handled, and reply paths.
2. Log `messageId`, `dispatchId`, channel/member slot, session ID, lease token/epoch, runtime-native session/turn ID, poller generation, and retry attempt.
3. Add a deterministic reproduction for 10 Claude turns and fault injection after turn 1.
4. Change no routing behavior yet; establish which root-cause candidate occurs in production.

Exit criterion: every delivered message can be classified as unclaimed, deferred, running, completed, replied, or terminally failed.

### Phase 1 — Durable dispatch ledger

1. Add inbox routing and dispatch tables.
2. Make WakeMonitor a compatibility producer into the ledger, not the owner of correctness.
3. Stop advancing/settling work on runtime error or lease defer; schedule retry.
4. Reconcile nonterminal work on startup.
5. Persist loop-breaker and retry state; do not extend suspension indefinitely on every suppressed message.

Exit criterion: daemon restart or transient wake failure cannot lose a message.

### Phase 2 — Correlation and protocol v2

1. Add signed channel/target/kind/correlation fields.
2. Persist them locally.
3. Make replies carry `replyToMessageId`; make request waiters match it exactly.
4. Keep v1 compatibility with a clearly marked heuristic matcher.

Exit criterion: concurrent same-channel requests cannot cross-match.

### Phase 3 — Adapter boundary

1. Define adapter types and conformance suite.
2. Move Codex App Server code behind `CodexRuntime` first.
3. Move Claude hook/poller behavior behind `ClaudeRuntime` with a supervisor-owned re-arm loop.
4. Add lease heartbeat and universal outbound fence.

Exit criterion: Claude and Codex pass the same lifecycle, restart, cancellation, and stale-session contract tests.

### Phase 4 — Cursor ACP

1. Implement the stdio JSON-RPC ACP client.
2. Support initialize/auth/new/load/prompt/update/permission/cancel.
3. Add deterministic policies for permissions and Cursor blocking extensions.
4. Bind sessions to channel member slots and the canonical repository cwd.

Exit criterion: Cursor passes adapter conformance and both pairwise 10-turn suites.

### Phase 5 — Channels and handoff

1. Enforce roster/addressing in the daemon before append/wake.
2. Add explicit mention and broadcast target expansion.
3. Add responder policies for three-way channels.
4. Add task handoff receipts and artifact references.

Exit criterion: three-way tests have deterministic target and response counts with no storms.

### Phase 6 — Workspace safety and rollout

1. Add task/workspace/path leases.
2. Put all adapter writes behind lease middleware.
3. Enable scoped routing by default for v2 channels.
4. Run soak tests, then retire legacy shell cold-idle and heuristic reply behavior.

Exit criterion: overlapping writes are rejected/fenced and disjoint writes can proceed in the one canonical repository.

## Acceptance Test Matrix

All tests must assert both final output and the durable state/event sequence. A “turn” means one request and its correlated reply. Unless stated otherwise, timeout is bounded, no human action is allowed, and every reply must contain the exact `replyToMessageId` expected.

| ID | Scenario | Setup / fault | Required assertions |
|---|---|---|---|
| AT-01 | 10 sequential Claude -> Codex -> Claude turns | One stable DM channel and session binding | 10/10 exact correlations; one Codex turn and one reply per request; same or explicitly migrated native session; no unhandled dispatches; all leases heartbeated/fenced. |
| AT-02 | 10 sequential Codex -> Cursor -> Codex turns | Cursor via `agent acp`, one ACP session | 10/10 `session/prompt` completions; session ID reused; streamed updates terminate; zero unanswered permission requests; one reply each. |
| AT-03 | 10 sequential Cursor -> Claude -> Cursor turns | Claude managed poller supervisor | A poller is armed before every inbound; 10 distinct wake receipts and replies; no dependency on manual Stop-hook invocation; cursor never outruns handled state. |
| AT-04 | Three-way Claude + Codex + Cursor | Group channel with explicit addressing and broadcast | `@claude`, `@codex`, `@cursor` wake exactly one target each; observer history appends without observer wake; broadcast expands to exactly three target records; configured responder policy determines 1 or 3 replies, never accidental extra replies. |
| AT-05 | Restart Murmur daemon mid-conversation | Kill after inbound persistence and before runtime accepted; repeat after runtime complete but before reply enqueue | On restart, ledger reconciliation resumes exactly once; no message loss; completed native turn is not repeated if final is recoverable; reply eventually sent once. |
| AT-06 | Restart one agent runtime | Kill Claude poller, Codex App Server, or Cursor ACP process during a turn | Health becomes unavailable; running dispatch becomes retryable or cancelled; supervisor starts/resumes a new generation; stale generation cannot reply; conversation continues. |
| AT-07 | Stale session | Leave fresh-looking registry row with dead runtime, then exceed TTL | Native fallback initially defers without settling; health check/TTL marks stale; next eligible session claims; exactly one reply; stale token rejected. |
| AT-08 | Duplicate delivery | Deliver identical envelope/msgId 2–5 times before and after restart | One inbox row/dispatch/turn/reply; transport returns duplicate ACK; duplicate processing receipt references original outcome. |
| AT-09 | Agent offline -> online | Recipient daemon/runtime unavailable for longer than multiple retry intervals | Sender outbox remains retryable, not falsely completed; when online, message delivers and runs once; correlation survives delay; no manual inbox poll. |
| AT-10 | Exactly-one responder with multiple sessions | Start three live sessions for the same logical agent/member slot | All may observe availability, but only one claims dispatch and starts a native turn; one reply; losers record non-owner/deferred without consuming work; winner loss permits fenced takeover. |
| AT-11 | Concurrent same-channel requests | Send two requests to same peer/conversation and return replies in reverse order | Each waiter resolves only its own `replyToMessageId`; neither reply is returned twice. |
| AT-12 | Wake failure retry | Fail UDS/ACP/hook on first attempt, restore it | First attempt records `wake_failed`; cursor/checkpoint does not settle job; backoff retry succeeds with same dispatch ID; one native turn. |
| AT-13 | Claude re-arm regression | Complete first rewoken response without emitting the expected lifecycle hook | Supervisor still arms next wait; messages 2–10 succeed; lock owner/generation changes safely. |
| AT-14 | Loop-breaker under valid dialogue | 10 valid turns inside 60 seconds | Normal correlated replies do not trigger sender-abuse suspension; if policy threshold applies, messages are deferred and later resumed, never dropped. |
| AT-15 | Lease expiry during long turn | Model turn exceeds 3x lease TTL | Independent heartbeat retains ownership; if heartbeat is stopped, takeover occurs and old reply/write is fenced. |
| AT-16 | Permission-required runtime | Cursor or Codex asks for tool/write permission | Policy auto-allows only scoped operations; otherwise job enters `needs_approval` or returns a structured blocked reply; runtime never hangs indefinitely. |
| AT-17 | Overlapping file writes | Claude and Cursor request write lease on the same file/prefix | One wins; loser waits/declines; stale owner cannot write after takeover; repository stays coherent. |
| AT-18 | Disjoint file writes | Codex and Cursor request non-overlapping paths | Both leases can run concurrently; neither creates a repository copy/worktree; both operate in the canonical physical repository. |
| AT-19 | Task handoff | Claude hands a scoped task to Cursor, Cursor hands review to Codex | Accepted/progress/completed receipts correlate to one task; context/artifacts preserved; task and write lease ownership transfers by epoch; no duplicate executor. |
| AT-20 | Optional metadata tamper | Alter channel/target/correlation/sequence in transit | Signature/auth validation rejects the envelope; no append, dispatch, or wake. |
| AT-21 | Ordering and burst | Queue 20 messages across two channels while one runtime is busy | FIFO is preserved per configured channel/session policy; channels may progress independently; no starvation; backpressure visible. |
| AT-22 | Crash after reply creation | Crash after native final, before/after outbox transaction boundary | Recovery emits one reply with stable message ID; inbound reaches `replied`; no second model turn if final was durably captured. |

### Test harness requirements

- Use fake protocol servers for deterministic Claude hook, Codex App Server, and Cursor ACP contract tests.
- Run live-runtime smoke separately and tag versions/capabilities in evidence.
- Use a controllable clock for lease/TTL/backoff tests.
- Add crash points at every state transition and SQLite transaction boundary.
- Assert database rows, fencing tokens, runtime call counts, and event ordering—not only text output.
- Run with core NATS and JetStream modes.
- Repeat the full matrix with daemon restart between each turn for a smaller three-turn variant.
- Keep all runtime cwd values fixed to `/Users/andrejlitvinov/Projects/murmur`; assert no worktree or repository copy is created.

## Audit verification notes

- Repository build completed before unit execution.
- Unit run result: 149 passed, 3 failed out of 152.
- The three failures were the Unix-socket Codex App Server tests and failed while binding test sockets with `listen EPERM` inside the audit sandbox; they did not reach protocol assertions. The remaining Codex wake, channel, lease-adjacent, request/reply, ACK, Claude drain, stale-lock, and retry tests passed.
- This audit did not execute live NATS, Claude, Codex App Server, or Cursor model turns and therefore does not claim end-to-end runtime validation.

