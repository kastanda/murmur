# Delivery, exactly-once execution and output finalization

## What was wrong (observed live)

1. **The receive handler ran the model turn.** `WakeMonitor.onInbound` awaited `drain()`, i.e. the
   whole autonomous turn (minutes), inside the broker's receive handler. The receive loop was
   blocked, so the ACK left only when the turn ended; the sender (15 s ack-timeout) re-published the
   same msgId a dozen times; each queued duplicate then drew a *valid* `duplicate-ignored` ACK that
   arrived after the first ACK had terminalized the row → `Invalid ACK rejected
   reason=message-not-in-flight`. Nothing was spoofed: valid duplicate ACKs were classified as invalid.
2. **Retries re-seeded Codex threads.** The Codex wait (180 s) timed out while the turn kept running on
   the App Server; the dispatch retry then seeded a **new thread** and started a **new turn** for the
   same msgId (three thread ids, three minutes apart).
3. **Non-answers were answers.** `claude -p` can exit 0 with `is_error: true` (an API error sentence
   as `result`), with an empty result, or on a tool-use stop; a delegation frame wrapped in a code
   fence is only an intent. All of these were relayed as the final result.
4. **Readiness polling dropped half-handshakes.** `probeUnixSocket` did a bare `net.connect` and closed
   it; the App Server logged `Handshake not finished` for each (≈1000 warnings from the 5 s poll).

## What guarantees now hold

* **Receive = durable accept.** `onInbound` enqueues the dispatch (durable) and returns; the single
  drain loop runs the turn in the background (`backgroundDrain`; a mid-turn arrival makes the running
  loop take another pass). The ACK is sent after the durable insert, not after the model.
* **ACK security is unchanged, and duplicates are classified correctly.** A later ACK from the right
  peer for an already-`acked` message is *benign* only after the same full verification as any ACK
  (digest, conversation, sender/recipient, in-window timestamp, signature, one-time nonce — and for
  the WS relay a durable nonce store). Stale, spoofed, wrong-peer, replayed, NACK-for-acked and
  ACK-for-failed frames are still rejected with their specific reason.
* **One logical msgId, one thread, one turn.** `runtime_turns` (per `msgId/recipient/slot`) records the
  seeded thread and the launched turn. A retry or a restarted daemon **reuses the thread**, or
  **attaches** to the launched turn (`thread/resume` + wait for that turn / read its rollout) — it never
  seeds another thread or starts another turn. Redelivery of an already-completed msgId is a no-op
  (`wake_dispatch` is unique per message). The record is retired only after the result was *settled*.
  The one exception is explicit and logged: the App Server itself was replaced (identity changed) or
  the thread no longer exists — that turn is gone, so a fresh one is started.
* **Outputs are classified before they can be results** (`runtime-output.mjs`): `text`, `handoff`,
  `tool-intent-only`, `empty`, `error`. Only `text` can be a final reply. `claude -p` exit 0 with empty
  output → `claude-one-shot-empty-output:exit=0,subtype=…,stop=…,ms=…` (bounded, redacted
  diagnostics); `is_error` → `…-runtime-reported-error`; `stop_reason: tool_use` or a fenced
  delegation frame → `…-tool-intent-only`. A valid exact handoff frame still creates the handoff,
  suppresses the parent reply and keeps the root workflow waiting until the correlated continuation
  produces a substantive result. Failures use the dispatch retry budget, then end `terminal` with the
  reason; nothing is relayed.
* **Review gate.** `murmur send` reports `ok` only for a substantive correlated reply
  (`"substantive": true`); empty/tool-intent replies return `non-substantive-reply` (exit 3).
  `satisfiesReviewGate(result)` is true only for a waited, correlated, substantive reply — never for
  queued/delivered/ACKed, a timeout, a cancellation or an empty/intent reply. It establishes that a
  review *response* exists; whether its verdict is SAFE remains the caller's decision.
* **Cancelled continuations are never open after a restart**: `reconcileCancelledContinuations`
  (daemon flush loop) closes any open continuation whose root has a cancel intent.
* **Health polling is protocol-correct**: a real WebSocket upgrade, closed politely; a listener that
  accepts TCP but never upgrades is *not ready*.

## Remaining limitations

* The persistence of the seeded thread / launched turn happens the instant the server answers; a
  process death in that instant (before the row is written) can still leave a retry unable to find the
  first thread. The window is one event-loop tick; it is logged when persistence fails.
* A killed Claude/Cursor turn is re-run by the retry budget (its first execution was terminated, so it
  is not concurrent, and Claude runs with tools disabled).
* The readiness probe proves the WebSocket upgrade, not an App Server `initialize` exchange.
