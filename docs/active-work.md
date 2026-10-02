# Active work and per-task cancellation

`murmur tasks | task | cancel <project> …` and the menu bar's «Активные задачи» show and control
what the project is doing **right now**. Nothing here is a second workflow database: the view is
reconstructed, read-only, from the durable records the runtime already keeps.

## What a task is

One **operator task** is ONE root request — the message `murmur send` (or the menu bar's send
action) enqueued. Every descendant handoff belongs to it: Root → Claude → Codex → Cursor → Codex →
Claude → Root is **one** task, so the menu says «Активные задачи: 1», not 6. The chain is shown
inside the task.

The **workflow id is the root message id** — the same id every handoff already carries as
`rootMessageId`. A task therefore stays traceable through root message, handoffs, replies and the
final result; there is no GUI-only identifier.

## Where each fact comes from

| Fact | Durable record |
|---|---|
| root task, request text, final result | root identity's `local_messages` (+ `outbox`) |
| pending handoff / waiting parent | `agent_handoffs` (`open`/`closed`/`terminal`) in the delegator's database |
| queued work / the turn executing now | `wake_dispatch` (+ `runtime_bindings` liveness) in the recipient's database |
| cancel intent | `workflow_control` (one row per cancelled root id), in every agent database |

The view survives restarts because nothing about it lives in memory.

## States

| State | Meaning |
|---|---|
| `queued` | accepted durably; no agent execution has started (a pending dispatch nothing owns, or not yet delivered) |
| `running` | a turn of this workflow is assigned to a runtime binding that is **live** (fresh heartbeat) |
| `waiting` | nothing is executing but work is outstanding — a parent waits for its child. A turn whose runtime stopped heartbeating is **not** shown as running: it is `waiting` with `stalled: true` |
| `cancel_requested` | the operator asked; a turn of the workflow is still executing on a **live** runtime |
| `cancelled` | the intent exists and no turn of the workflow is executing. **Derived, never stored**, and monotonic: every gate refuses new work for a cancelled workflow |
| `completed` | the correlated final reply to the root message exists |
| `failed` | terminal failure with no reply |

`active` in the summary = running + waiting + cancel_requested; `queued` is reported separately.
**Current agent** is whoever is executing (or whom the workflow waits on) — a parent Claude waiting
for Codex shows Codex. **Stage** is deterministic (the handoff task's first line, or «Обработка
запроса» / «Ожидание ответа …»); no LLM labels it. **Elapsed** is computed from the submit
timestamp at render time. Requests are redacted (`redactSecrets`) and bounded (160 chars in
lists, 4000 in detail).

## Cancellation

```bash
murmur cancel <project> <workflow-id> [--json]
```

Exit codes: `0` accepted (idempotent), `1` invalid id, `2` unknown workflow, `3` no profile,
`4` already finished (completed/failed), `5` is returned by a waiting `murmur send` that was
cancelled. The id must be a valid message id; it must belong to this project's root tasks.

`cancel` **never** stops the project, a daemon or any other task. It writes a durable intent and
the runtime does the rest:

* **No new work.** `fencedCreate` (new handoff) refuses inside its own transaction; a queued root
  or child dispatch is refused at the claim gate (`prepareTurn`); a late child reply cannot resume
  the parent; the open continuation becomes `terminal` (`workflow-cancelled`). Refused messages
  stay in history, recorded as **`ignored_due_to_cancelled_workflow`**.
* **Queued work is retired immediately** by the command itself (`pending`/`deferred`/`failed`
  dispatches → `rejected` with that disposition), so cancelling a queued task is instant.
* **The turn executing now is interrupted with the runtime's own scoped mechanism**, by a daemon
  watcher (1 s): Claude — SIGTERM to that one `claude -p` child; Codex — `turn/interrupt` for that
  exact thread + turn; Cursor — ACP `session/cancel` for that session (never shutting the agent
  process down). If a runtime cannot interrupt (no turn id yet, or the interrupt is not honoured),
  the turn finishes or times out on its own and its result is **discarded**: it is kept in the
  receipt for audit but never delivered, never delegates, never resumes anything.
* **Delayed replies and transport retries cannot resurrect a task**: a redelivered message hits
  the same gate; a `rejected` dispatch is never re-enqueued.
* **Delivery after the intent is never a completion.** A final root reply that arrives *after* the
  cancel stays in history but the task stays `cancelled` (monotonic); a reply that arrived *before*
  it is a genuine completion (and then `cancel` refuses: already finished). A reply is also
  re-checked right before it is enqueued, and durable reply **recovery after a restart** skips
  results of cancelled workflows.
* **The intent must be in every agent database** (every gate reads its own). `cancel` reports
  `ok: true` only if all were written; otherwise `cancel-partially-recorded` (exit 1) and the
  operator retries — the write is idempotent.
* A waiting `murmur send` stops waiting and reports a **system** result — «Задача отменена
  пользователем.» — never text attributed to an agent. History is never deleted.

`cancel_requested` («Отмена запрошена») means the intent is recorded but a turn is still ending;
`cancelled` («Отменено») means nothing of the workflow is executing any more.

What cancellation cannot do immediately: stop a model turn that ignores the interrupt (it ends on
its own; its output is dropped), or un-send a message already delivered to a peer.
