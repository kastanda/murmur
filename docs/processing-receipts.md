# Processing Receipts

Processing receipts are local control-plane records. They are not Murmur messages,
conversation entries, replies, acknowledgements, or user notifications. In
particular, `replyToMessageId` never serves as a processing receipt.

## Lifecycle and runtime capabilities

The durable lifecycle is:

`local_messages persisted` → `dispatch pending` → `claimed` → `dispatched` →
`handed_off`, with an independent processing attempt that can move from `created`
to `started` and then to `completed` or `failed`.

| Runtime path | Trustworthy started point | Trustworthy completed point | Trustworthy failed point | Capability |
|---|---|---|---|---|
| Codex App Server | None guaranteed on the autonomous Unix/WebSocket path; observed `turn/started` remains diagnostic only | `turn/completed`, or a correlated rollout `task_complete` fallback | app-server error, close, or completion timeout | `completed` (created → completed) |
| Claude Code `asyncRewake` | None. Exit 2 only proves wake text was emitted to Claude Code | None. The current Stop hook has no durable binding from a Stop event to one inbound message and attempt | Wake script faults are observable but do not prove a model-turn failure | `none` |
| Codex one-shot responder | The responder process can claim its send, but model generation occurred outside this script | None for the model turn; successful reply persistence/send is only a reply-delivery fact | Responder/send failure only | `none` for model processing |
| `on-receive-llm.mjs` | Immediately before the real LLM request | Successful LLM response, before reply delivery | Configuration error or LLM invocation error; the hook exits non-zero so normal retry policy applies | `completed` when `onReceiveProcessingReceipts` is enabled |
| Generic shell `onReceive` | No model-level event is defined | Exit 0 means only that the hook process exited successfully | Non-zero/timeout proves hook failure, not necessarily model failure | `none` |
| Stateless/pull inbox | None; durable inbox availability is only `handed_off` | None | None | `none` |

Claude wake output, cursor advancement, watcher re-arming, hook launch, and inbox
persistence must never be reported as completed model processing. Supporting a
Claude `completed` receipt requires a future session-local active-attempt binding
that a correlated Claude lifecycle event can close.

## ProcessingAttemptV1

SQLite table `processing_attempts` stores one row per true runtime call:

- `attempt_id` (UUID generated before handoff);
- `inbound_message_id`, `recipient_id`, and `member_slot`;
- `runtime` and receipt `capability` (`none`, `started`, or `completed`);
- monotonic `status` (`created`, `started`, `completed`, `failed`);
- created/started/completed/failed timestamps;
- optional error, session id, result message id, and metadata.

The attempt identity is
`(inboundMessageId, recipientId, memberSlot, attemptId)`. The integer
`wake_dispatch.attempts` remains only the bounded retry counter. Lease deferral,
audit deferral, loop suppression, and a claim without a runtime call do not create
an attempt id.

Receipts are accepted only through the local SQLite control path and must match an
existing exact attempt identity. There is no receipt transport endpoint for a
remote agent to forge. Duplicate equal receipts are idempotent. Terminal state is
monotonic: late `started` cannot undo `completed`, and conflicting terminal
receipts are rejected and logged.

## Recovery

Receipt reconciliation runs before stale dispatch recovery at daemon startup and
again on the daemon's normal flush cadence, so an in-flight attempt can age past
its TTL without requiring a second restart:

- Latest `completed`: restore the dispatch to `handed_off` and do not call the
  runtime again.
- Latest fresh `started`: keep the dispatch in flight and do not call the runtime.
- Latest expired `started`: mark that attempt failed/abandoned and permit retry
  under the existing delivery budget. Configure the deadline with
  `MURMUR_PROCESSING_STARTED_TTL_MS` (default 300000 ms).
- Latest `failed`: permit retry under the existing delivery budget.
- No receipt, or only `created`: preserve the previous at-least-once recovery.

For `on-receive-llm.mjs`, set `onReceiveProcessingReceipts` to `"completed"` in
agent configuration. Murmur then passes the local attempt identity and store path
through the hook environment. Arbitrary hooks remain capability `none` by default.

Periodic passes inspect only dispatches in active/retryable states. Terminal
transitions are idempotent, and an already-reconciled expiry is not logged again.
If a hook reports durable `completed` and then its reply/post-processing tail
fails, completion wins: the dispatch remains `handed_off`, the model is not
replayed, and the tail failure is emitted as a separate operator diagnostic.

## Guarantees and remaining crash windows

Receipts reduce uncertainty and prevent replay when durable completion is already
known. They do not provide exactly-once model execution. A runtime can begin before
`started` is durable, finish before `completed` is durable, or perform external side
effects before either write. A crash in any such window can still cause retry.

A conversational reply is independent: it may arrive before or after completion,
completion may occur with no reply, and a reply with `replyToMessageId` does not
imply that processing completed. Reply delivery failure after a successful LLM or
Codex turn is logged separately and does not rewrite a completed model receipt as
failed.

For the autonomous Codex adapter, completed metadata records the actual
per-attempt App Server thread. Thread affinity is scoped to sender+conversation
and to the current external server generation; it is not derived from the runtime
binding's single `runtime_session_id`. A server-generation change before durable
completion leaves the attempt without fabricated completion and permits normal
at-least-once recovery. Completed reply recovery uses stored metadata and does not
require the original thread or a currently connected App Server.
