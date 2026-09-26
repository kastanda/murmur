# Runtime bindings

Runtime bindings are the durable ownership layer between an agent identity and a
concrete runtime process. They are optional in this iteration: existing wake paths
continue to operate without creating a binding.

## Identity boundaries

- An **agent** is the stable Murmur identity used for transport and signatures.
- A **runtime binding** is one process/session generation eligible to execute work
  for an agent in one project and member slot.
- A **processing attempt** records lifecycle evidence for one actual runtime call.
  It is not presence, routing, or session state.

A binding includes a durable `bindingId`, `runtimeGeneration`, process start
identity, runtime session id, project/task affinity, member slot, heartbeat,
lease TTL, and fencing token/epoch. PID is diagnostic metadata only and is never
sufficient identity because operating systems reuse PIDs.

## State machine

```text
UNBOUND -> STARTING -> BOUND_IDLE -> CLAIMED -> WAKING -> RUNNING
              |           ^           |          |         |
              |           +-----------+----------+---------+
              |                                   |
              +------> OFFLINE <---- STOPPING <---+

Any live state -> STALE after heartbeat lease expiry.
OFFLINE or STALE -> a newly registered replacement generation in STARTING.
```

Only `BOUND_IDLE` is assignment-eligible. The supervisor owns heartbeat and
runtime transitions. The dispatcher owns `BOUND_IDLE -> CLAIMED` together with
the dispatch assignment. A runtime may request `WAKING`, `RUNNING`, or idle only
with the current durable fence. Reconciliation owns `STALE`.

## Member slots and isolation

Routing identity is `(agentId, projectId, taskId/conversationId, memberSlot)`.
Runtime kind and slot are separate fields. Recommended slots include:

- `claude:auto` for a supervisor-owned autonomous Claude runtime;
- `claude:interactive:<session-id>` for a manual Claude session;
- `codex:app-server`;
- `cursor:acp`.

Interactive and autonomous Claude bindings must never share a member slot. The
dispatch row's `member_slot` is authoritative: `assignDispatch` rejects a caller
route whose slot differs and uses the dispatch slot for binding selection. A
message for `claude:auto` therefore cannot be claimed by an interactive binding
even when all bindings use the same agent identity and SQLite inbox. Agent and
project consistency remain caller-enforced until those fields become durable
dispatch routing metadata in a later slice.

## Assignment and fencing

Assignment and binding claim occur in one `BEGIN IMMEDIATE` transaction in the
same database as `wake_dispatch`:

1. Require an unassigned `claimed` dispatch.
2. Select one live `BOUND_IDLE` binding matching agent, project, and member slot.
3. Prefer an existing exact task affinity over an unpinned binding.
4. Change the binding to `CLAIMED`, increment its lease token/epoch, and pin the
   task when it was previously unpinned.
5. Persist `owner_binding_id`, `owner_generation`, `fencing_token`, and
   `fencing_epoch` on the dispatch.

Every handoff, authoritative reply/result, and processing receipt must validate
the complete fence against both the binding and dispatch. Replacement or lease
expiry invalidates the old generation. A stale runtime cannot heartbeat, change
state, send an authoritative result, or close a newer processing attempt.

Task affinity is a preference, not a permanent reservation. A normal reusable
binding clears `task_id` when it returns to `BOUND_IDLE`, so one `claude:auto`
worker can serve a later conversation. A binding may retain affinity only when
its metadata explicitly declares `stickyTask: true`; stale or offline sticky
bindings are never eligible and cannot block a healthy replacement.

## Heartbeat and stale recovery

Heartbeat is supervisor-owned. Claude Stop hooks are not a heartbeat source for
an autonomous runtime. Reconciliation uses the binding's configurable TTL and a
compare-and-swap on generation and token so a concurrent successful heartbeat
cannot be overwritten using stale observations.

When a binding becomes stale before handoff, its assignment becomes deferred and
reassignable without consuming a runtime attempt. When it becomes stale after
handoff, the existing processing receipt evidence remains authoritative:

- fresh `started` evidence stays in flight until its processing TTL expires;
- durable `completed` evidence makes the dispatch `handed_off`;
- missing, failed, or expired evidence permits the existing bounded retry policy.

Binding state and processing state remain separate even though recovery considers
both.

Recovery has one ownership authority per dispatch:

- an unowned `wake_dispatch` row is recovered by
  `WakeDispatchStore.recoverStaleClaims`;
- a row with `owner_binding_id` is recovered only by
  `RuntimeBindingStore.reconcileStale`;
- processing receipt reconciliation supplies lifecycle evidence but never owns
  or reassigns a runtime binding.

Future daemon wiring must reconcile processing evidence first, reconcile stale
runtime bindings second, and apply legacy unowned-claim recovery last.

## Relation to SessionLeaseStore

`SessionLeaseStore` remains the compatible conversation/member-slot CAS used by
current scoped-channel wake paths. Runtime bindings reuse its core principles:
durable ownership, monotonic token/epoch, heartbeat TTL, and outbound fencing.
They do not change the existing tables or default daemon behavior.

The new registry is colocated with `wake_dispatch` because binding selection and
dispatch ownership must commit atomically. A future integration may consolidate
shared primitives, but must not split assignment across two SQLite databases or
introduce an unfenced check-then-write window.

## Backward compatibility

The four assignment columns on `wake_dispatch` are nullable. Existing rows and
deployments without runtime bindings retain their previous behavior. Bounded
Claude hooks and the current Codex App Server path are not switched to binding
assignment in this slice. Runtime profiles must explicitly opt in during a later
production-wiring iteration.

This foundation does not implement the future Claude `stream-json` worker; it
only defines the durable identity, assignment, state, and fencing contract that
such a supervisor will use.
