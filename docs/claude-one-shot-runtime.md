# Claude one-shot runtime

## Scope

The one-shot runtime is Murmur's first autonomous Claude execution path. It is
opt-in and intentionally does not replace the bounded interactive Claude
`asyncRewake` hook. The hook can wake an already-running human session, but it
does not own that session or provide a durable process/session lifecycle.

Enable the runtime only for a dedicated autonomous identity:

```json
{
  "runtime": {
    "claudeOneShot": {
      "enabled": true,
      "projectId": "canonical-project-id",
      "cwd": "/absolute/path/to/canonical/workspace",
      "leaseTtlMs": 30000,
      "heartbeatIntervalMs": 5000,
      "turnTimeoutMs": 300000,
      "terminateGraceMs": 5000,
      "permissionMode": "dontAsk"
    }
  }
}
```

All inbound dispatches for an enabled dedicated daemon use member slot
`claude:auto`. Interactive slots such as `claude:interactive:<session-id>` are
separate and cannot win autonomous assignments. Do not enable this profile on
an identity whose inbound traffic must continue through a legacy wake hook.
The daemon also persists `member_slot = 'claude:auto'` on the local inbound
message before dispatch. Interactive Claude drains exclude those rows, so an
interactive session sharing the database cannot observe autonomous work.
Legacy rows have a null slot and remain visible.

## Execution and session identity

Each assigned message starts one public Claude Code CLI process:

```text
claude -p --safe-mode --output-format json --permission-mode dontAsk --tools "" \
  --session-id <uuid> <prompt>
```

The next turn uses `--resume <confirmed-session-id>`. The display `--name` is
not used as identity. A new UUID is proposed to the CLI, but it is stored as
`runtime_session_id` only after a successful terminal JSON result confirms the
same `session_id`. The child inherits the configured canonical workspace as
its working directory; no worktree or repository copy is created.

`--safe-mode` is required to prevent project/user hooks and plugins from
turning a bounded one-shot invocation into another wake loop. The installed
Claude Code 2.1.178 CLI was verified to support `-p`, `--session-id`,
`--resume`, JSON output, `--safe-mode`, and `--permission-mode dontAsk`.

## Ownership and fencing

The supervisor registers a `claude_one_shot` runtime binding in
`claude:auto`. A dispatch must be durably assigned to a `BOUND_IDLE` binding
before the child can start. The supervisor checks the binding generation,
lease token, fencing epoch, and dispatch owner:

1. before child launch;
2. before recording completion;
3. before enqueuing the authoritative reply;
4. before returning the binding to `BOUND_IDLE`.

A late result from a stale or replaced generation is discarded. The old
generation cannot complete another attempt, reply, or change the replacement
binding's state.

## Processing receipts and replies

The runtime advertises processing capability `completed`. Claude's one-shot
JSON protocol provides a trustworthy terminal result but no separate event
that this implementation treats as a trustworthy model-start boundary, so it
does not synthesize `started`.

The processing attempt is created in the child `spawn` callback, at the real
runtime handoff boundary. A successful terminal result is persisted as
`completed` before reply delivery. Its metadata durably contains the result
text and correlation route. The reply uses:

- the inbound conversation ID;
- the original sender as recipient;
- `replyToMessageId` equal to the inbound message ID;
- the processing attempt UUID as a deterministic reply message ID.

If reply enqueue fails after completion, the model is not invoked again.
Periodic recovery retries only the deterministic reply enqueue and then adds
`result_message_id` to the receipt. Processing completion and reply delivery
remain independent facts. The local outbound mirror uses an idempotent
`(direction, msg_id)` append, so recovery cannot duplicate conversation rows.
Conversely, an outbound reply does not manufacture a completed processing
receipt.

## Recovery, heartbeat, timeout, and cancellation

Unowned dispatches remain under `WakeDispatchStore` recovery. The generic
processing reconciler skips binding-owned rows. `RuntimeBindingStore` alone
marks stale bindings, interprets receipt evidence, and releases their
assignments. A fresh `started` receipt may temporarily hold an assignment;
the periodic binding reconciler revisits already-stale ownership after its TTL
and releases it when the evidence expires.

Before child spawn, a supervisor failure creates no processing attempt and the
claimed assignment is retryable. After spawn but before a terminal receipt,
the outcome is unknown and recovery is explicitly at-least-once. A durable
completion suppresses model replay even when the daemon crashes before reply
persistence. The confirmed runtime session ID is stored in SQLite and survives
daemon restart.

The supervisor owns one heartbeat timer for its entire lifetime, including
`BOUND_IDLE`, `CLAIMED`, `WAKING`, and `RUNNING`. The interval is clamped below
the lease TTL. Repeated turns do not create additional timers. Shutdown stops
the timer and marks the binding `OFFLINE`; daemon startup expires the previous
route before registering the new generation. A stale generation's timer is
fenced to its own binding and cannot heartbeat a replacement.

Turn execution has a configurable timeout: SIGTERM is sent first and SIGKILL
follows after a bounded grace period. A timeout is recorded as unknown, not as
false model completion or failure. Shutdown and explicit cancellation signal
the owned child and do not use terminal keystrokes, private sockets, or Remote
Control internals.

## Permission limitation

The safe default is `dontAsk` with an empty built-in tool set. This cannot wait
forever for interactive approval and is suitable for reasoning/message tests,
but it deliberately cannot modify files or run shell commands. Deployments
that enable tools must define and review an explicit allowlist and workspace
write policy first. The runtime does not automatically grant
`bypassPermissions` or other dangerous permissions.

## Why one-shot first

One process per turn is less efficient than a persistent stream-JSON worker,
but it establishes durable ownership, real Claude session continuity,
fencing, recovery, bounded cancellation, and exact reply correlation without
depending on private runtime interfaces. A persistent worker can later reuse
these contracts as an optimization rather than redefining their semantics.
