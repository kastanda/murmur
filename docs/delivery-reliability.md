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
* **One logical msgId, one thread, one turn — across a crash at any of the boundaries below, provided the App Server remains queryable.** Intent is
  written FIRST: before any server call `runtime_turns` records `planned`, and the deterministic
  identities this message uses are sent *to the server*, namespaced by the whole durable identity
  (a SHA-256 over an unambiguous encoding of `[msgId, recipient, slot]`, so neither the same msgId for
  another recipient/slot nor a concatenation trick can be mistaken for it): the thread's **`threadSource =
  murmur:v1:<digest>`** (`thread/start`) and the turn's **`clientUserMessageId = murmur-turn:v1:<digest>`**
  (`turn/start`, stored by the server as the user message's `clientId`). The state then walks
  `planned → seeded → launched → finished`. A retry or a restarted daemon **reconciles with the
  server before mutating anything**:
  * thread accepted but never recorded → `thread/loaded/list` + `thread/read` finds the thread whose
    `threadSource` matches and **adopts** it (verified live: a thread whose creating connection died
    is still loaded, readable and accepts the first turn);
  * turn accepted but never recorded → `thread/turns/list` finds the user message whose `clientId`
    matches and **attaches** to that turn (works after an App Server restart too: a thread with a turn
    is persisted);
  * discovery reads EVERY page of loaded threads (no order assumed); a read that fails for any reason
    other than "that thread is gone" makes the search incomplete, and an incomplete search FAILS the
    attempt instead of seeding a second thread; the turn search likewise reads every page;
  * a turn still in flight whose user message is not listed yet — the server briefly reports a
    just-accepted turn as "not materialized" — is never trusted on first sight: the thread must stay idle
    and the turn absent over several consecutive looks *and for a quiescence period (15 s plus the client's
    send bound) after the durable launch stamp* — the stamp is written (and MUST succeed, or nothing is
    sent) immediately before every `thread/start` / `turn/start`, — long enough for a request still in flight when the process died to have been
    processed — before "no turn" is concluded; a busy thread
    that never lists the turn is an *unknown* state and the attempt **fails rather than start another
    turn**;
  * a thread with **no turn** is not materialized by the server (not listed, not resumable, gone after
    a server restart): nothing ever ran in it, so when it cannot be found a fresh one is created — the
    only case with a second thread *object*, and it is inert;
  * a recorded turn whose thread the server provably no longer has (replaced server) is abandoned and
    the next retry starts fresh.
  A retry never seeds another thread or starts another turn while one can be found or while the state is
  ambiguous; redelivery of an already-completed msgId is a no-op (`wake_dispatch` is unique per message).
  The record is retired only after the result was *settled* — a result dropped by a lost fence leaves it
  `launched` so the newer generation reconciles. Proven by deterministic crash tests at both boundaries and, against the
  real App Server, by `node scripts/codex-crash-recovery-drill.mjs thread|turn` (drops the durable write,
  restarts the adapter, then counts threads/turns on the server): one `thread/start`, one `turn/start`,
  one reply.
* **Outputs are classified before they can be results** (`runtime-output.mjs`): `text`, `handoff`,
  `tool-intent-only`, `empty`, `error`. Only `text` can be a final reply. `claude -p` exit 0 with empty
  output → `claude-one-shot-empty-output:exit=0,subtype=…,stop=…,ms=…` (bounded, redacted
  diagnostics); `is_error` → `…-runtime-reported-error`; `stop_reason: tool_use` or a fenced
  delegation frame → `…-tool-intent-only`. A valid exact handoff frame still creates the handoff,
  suppresses the parent reply and keeps the root workflow waiting until the correlated continuation
  produces a substantive result. Failures use the dispatch retry budget, then end `terminal` with the
  reason; nothing is relayed.
* **Review gate (two layers).** `murmur send` reports `ok` only for a substantive correlated reply
  (`"substantive": true`); empty/tool-intent replies return `non-substantive-reply` (exit 3).
  `satisfiesReviewGate(result)` is true only for a waited, correlated, substantive reply — never for
  queued/delivered/ACKed, a timeout, a cancellation or an empty/intent reply. It establishes that a
  review *response* exists and never reads a verdict. The **release policy layer**
  (`review-gate.mjs`, `evaluateReleaseGate`) additionally requires the reviewer's *declared* verdict
  (the first non-empty line consisting of ONLY `SAFE` / `BLOCKED` / `UNSAFE`) to be SAFE: BLOCKED/UNSAFE,
  a missing or qualified verdict ("SAFE, but …"), a SAFE that lists BLOCKER findings anywhere below, empty/tool-intent replies, and transport/ACK/notification-only
  successes all fail closed. Nothing is inferred from prose. The policy is wired into the CLI:
  `murmur send <project> "<review request>" --release-gate [--json]` exits 3 with
  `reason: release-gate-failed` (and the reviewer's text) unless the correlated reply declares SAFE.
* **Cancelled continuations are never open after a restart**: `reconcileCancelledContinuations`
  (daemon flush loop) closes any open continuation whose root has a cancel intent.
* **Health polling is protocol-correct**: a real WebSocket upgrade, closed politely; a listener that
  accepts TCP but never upgrades is *not ready*.

## Remaining limitations

* This is "exactly one *Murmur-launched* thread/turn per message", not exactly-once for the *external
  effects* a turn may have had. If the whole Codex App Server is replaced, a recorded turn that no
  longer exists is abandoned and re-run; whatever the old turn already did outside the server (files,
  network) is not undone or de-duplicated by Murmur.
* Reconciliation needs the App Server to answer `thread/loaded/list`, `thread/read` and
  `thread/turns/list`; when it cannot, the attempt fails and retries — it never guesses.
* A killed Claude/Cursor turn is re-run by the retry budget (its first execution was terminated, so it
  is not concurrent, and Claude runs with tools disabled).
* The readiness probe proves the WebSocket upgrade, not an App Server `initialize` exchange.
