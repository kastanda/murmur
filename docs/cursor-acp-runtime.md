# Cursor ACP runtime

`cursor_acp` is an opt-in autonomous Murmur runtime for the official Cursor Agent Client Protocol (ACP) interface. It does not automate Cursor IDE windows or use private editor APIs.

## Verified installed contract

The implementation was developed against the installed Cursor Agent CLI `2026.09.02-c22c1a3` at `/Users/andrejlitvinov/.local/bin/agent`.

`agent acp` starts an ACP v1 server over stdin/stdout. The wire format is newline-delimited JSON-RPC 2.0: Murmur writes requests and notifications to stdin, reads protocol messages from stdout, and treats stderr as diagnostic output. The verified initialization response advertises:

- protocol version `1`;
- `cursor_login` authentication;
- `loadSession: true`;
- image prompts, but not audio or embedded-context prompts;
- HTTP and SSE MCP capability.

The request sequence is `initialize`, `authenticate`, `session/new` or `session/load`, `session/set_mode`, then one or more `session/prompt` turns. Model text arrives in `session/update` notifications with `agent_message_chunk`; the response to `session/prompt` is the terminal turn result and contains `stopReason`. `session/cancel` is a notification. Cursor may issue blocking `session/request_permission`, `cursor/ask_question`, or `cursor/create_plan` requests.

Sources: [Cursor ACP documentation](https://cursor.com/docs/cli/acp) and the [ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json).

The installed CLI is currently not authenticated (`agent status` reports `Not logged in`). It answers `initialize`, but `authenticate(cursor_login)` cannot complete without a prior `agent login` or supported API/auth token. Deterministic tests use a protocol fixture; a real model continuity probe therefore remains blocked on operator authentication.

## Configuration

The runtime is disabled by default. Enable it only on the daemon identity intended to represent autonomous Cursor:

```json
{
  "runtime": {
    "cursorAcp": {
      "enabled": true,
      "projectId": "murmur-canonical",
      "cwd": "/absolute/path/to/workspace",
      "command": "agent",
      "mode": "ask",
      "permissionPolicy": "reject-once",
      "leaseTtlMs": 30000,
      "heartbeatIntervalMs": 5000,
      "startupTimeoutMs": 30000,
      "turnTimeoutMs": 300000,
      "terminateGraceMs": 5000
    }
  }
}
```

The daemon currently permits one autonomous runtime kind per identity. Enabling both `claudeOneShot` and `cursorAcp` in one daemon fails startup instead of ambiguously routing every inbound message.

## Ownership and lifecycle

The Murmur supervisor owns one persistent `agent acp` child and its stdin/stdout connection. Startup is bounded and requires successful ACP initialization and authentication before the runtime binding becomes `BOUND_IDLE`. The binding uses:

- runtime kind `cursor_acp`;
- member slot `cursor:acp`;
- a durable binding ID, generation, lease token, fencing epoch, process ID/start identity, and confirmed ACP session ID;
- supervisor heartbeat in `BOUND_IDLE`, `WAKING`, and `RUNNING`.

The turn lifecycle is:

```text
BOUND_IDLE
  -> CLAIMED (atomic dispatch assignment and new fence)
  -> WAKING
  -> session/new for the first turn, otherwise the live confirmed session
  -> RUNNING
  -> session/prompt submitted
  -> optional started receipt on first session/update
  -> completed receipt on successful terminal session/prompt response
  -> correlated Murmur reply
  -> BOUND_IDLE
```

The first confirmed `session/new` identity is stored only after the binding is running under the current fence. Later turns on the same owned ACP process use that exact session. A deterministic two-turn test verifies actual remembered context, not only ID equality.

## Receipts and replies

Murmur creates a processing attempt immediately before `session/prompt` is written. Submission creates a `created` receipt. The first correlated `session/update` advances it to `started`; absence of an update does not fabricate a start. A successful terminal response advances it to `completed`, independently of reply delivery.

Terminal protocol errors are `failed`. A transport loss or timeout after prompt submission has unknown model outcome: Murmur leaves non-terminal processing evidence and reports `unknown` rather than claiming failure or completion. Timeout sends `session/cancel` and terminates the owned child if necessary, so it cannot remain orphaned.

After durable completion, Murmur enqueues a reply with:

- `msgId = processing attemptId`;
- the inbound `conversationId`;
- `replyToMessageId = inbound msgId`;
- recipient equal to the original sender.

If reply enqueue fails, the completed Cursor turn is not replayed. Recovery retries only the deterministic reply, and both the outbox and local message mirror are idempotent by message ID.

## Fencing and recovery

The active binding fence is validated before session use, prompt submission, started/completed receipts, reply enqueue, and return to idle. A late event from a replaced generation cannot complete the dispatch, emit an authoritative reply, or mark the replacement idle.

Recovery semantics are deliberately conservative:

- before prompt submission: no processing attempt is created; ownership is released and the dispatch is retryable;
- after prompt submission without a terminal result: outcome is unknown and no false terminal receipt is written;
- after durable completion but before reply: only reply enqueue is recovered;
- child death while idle: heartbeat stops, and normal binding reconciliation marks the binding stale; this slice does not silently spawn a replacement process;
- late old-process result: rejected by the persisted fence;
- daemon restart: the old owned process/session is not assumed reconnectable. The previous generation is expired and a new ACP process/binding is created. Although Cursor advertises `session/load`, this slice does not claim restart continuity until live reconnect behavior has been independently proven.

## Cancellation and shutdown

For an active turn, Murmur sends `session/cancel`. If a terminal response does not arrive within the grace period, it closes stdin, sends `SIGTERM`, then `SIGKILL` if required. A graceful daemon shutdown cancels active work, marks the binding offline, stops heartbeat, and terminates the owned ACP child. No arbitrary Cursor UI or unrelated CLI process is touched.

## Permission and workspace policy

The initial slice forces ACP session mode `ask`, advertises no client filesystem or terminal capabilities, passes no MCP servers in `session/new`, rejects tool permission requests by default, and cancels Cursor-specific blocking questions/plans. Live probes must remain read-only and non-destructive.

This is defense in depth, not a workspace sandbox. Cursor CLI runs with the daemon user's OS permissions, reads workspace rules such as `AGENTS.md`, and future Cursor versions may change native tool behavior. Operators must not change the mode or permission policy to grant writes until Murmur has workspace/write leases and an explicit deployment policy.

## Isolation and compatibility

Inbound rows routed to this runtime persist `member_slot = 'cursor:acp'`. Runtime binding assignment requires the same slot, so manual Cursor sessions and other autonomous kinds cannot claim the dispatch. Existing Claude one-shot, interactive Claude, generic hooks, Codex App Server, transport envelopes, and public protocol remain unchanged when `runtime.cursorAcp.enabled` is absent or false.
