# Channel sends, channel-server lifecycle and dispatch accounting

Three things operators kept misreading. Each now has one defined meaning.

## 1. What `queued` means (`murmur_send` / `murmur_request`)

`murmur_send` returns `status: "queued"` **only together with `durable: true`**, and only after
the outbox row has been committed to the sender profile's SQLite store **and read back** from
it. Nothing else may produce `queued`: an enqueue error, or an enqueue that leaves no matching
row, is an error result (`outbox-write-failed`, `outbox-commit-unverified`).

Receipt (no payload, signature, key or token is ever included):

```json
{ "status": "queued", "durable": true, "msgId": "…", "to": "codex",
  "recipientAgentId": "codex", "senderAgentId": "claude",
  "conversationId": "dm:claude:codex", "replyToMessageId": "…",
  "profile": "project", "projectId": "murmur-f6a3a362f2bb",
  "dataDir": "/…/agents/claude", "subject": "msg.codex",
  "outboxStatus": "pending", "localCopy": true }
```

* The row to look for is `outbox.msg_id` in `<dataDir>/murmur.db` (`dataDir` is in the receipt).
* `queued` is **not** delivery. The daemon flushes the outbox to NATS; `outbox.status` then
  moves `pending → sent → acked`. Delivered/acked is not a completed review (see the review
  gate policy).
* `localCopy: false` means only the sender's own `local_messages` bookkeeping failed; the
  message itself is committed and will be sent.

### Where did "my msgId is not under ~/.murmur" come from?

The `murmur` MCP server is registered per CLIENT, not per project
(`claude mcp get murmur` → `DATA_DIR=…/.data-claude`). It writes to that **legacy
profile**, not to `~/.murmur/projects/<id>/agents/<agent>`. The send was durable — in
`.data-claude/murmur.db`, status `acked` — it just was not where a modern-profile search
looks. Every receipt now names the profile (`profile: "legacy" | "project"`, `dataDir`).

### Routing is explicit

* A server is bound to exactly one profile: its resolved `DATA_DIR`. It never creates or starts
  another profile and never reaches into one.
* `projectId` (optional tool argument) pins the send to a project. A server bound to a
  different project — or to a legacy profile, which belongs to no project — **refuses**
  (`profile-mismatch`). An unknown recipient is refused (`unknown peer`).
* `MURMUR_REQUIRE_PROJECT_PROFILE=1` makes a legacy-bound server refuse every send
  (`legacy-profile-rejected`).

Legacy profiles also share one NATS subject per agent (`msg.codex`). Every Codex MCP session
that loads the legacy `murmur-channel` server subscribes to it with its own consumer id, and a
lease picks one winner to surface the message — in whichever thread won, not necessarily the
project you meant. That is why project-scoped sends should use a project profile.

## 2. Channel-server lifecycle

`scripts/murmur-mcp-channel-server.mjs` is **session-scoped**: the MCP client (a Codex App Server
thread) starts one per MCP session and owns its stdio pipes. One per loaded thread is expected.
Measured: 30 channel servers under one Codex App Server ⇔ 30 `thread/loaded/list` threads on
that App Server — a 1:1 match, i.e. retention of loaded threads by the App Server, not a leak
in the channel server.

It exits on:

* stdin EOF / close (the normal end of a session) and stdout `EPIPE`;
* `SIGTERM` / `SIGINT`;
* loss of its owner while the pipe stays open elsewhere (`owner-reparented`, `owner-gone`),
  polled every `MURMUR_MCP_OWNER_POLL_MS` (default 5 s).

Deliberately **not** an idle timeout: an MCP client sends nothing after `initialize`, so idle is
indistinguishable from a live thread waiting for a message, and exiting would silently deafen
it. The send-side `murmur` MCP server also exits on stdin EOF, after letting an already-accepted
call finish (bounded at 30 s).

### Diagnostics and cleanup

```
murmur channels [--json]        # every channel server: owner, age, profile kind, state
murmur channels --cleanup       # stop ONLY orphaned servers
murmur doctor <project>         # includes a `channel-servers` line (never fatal)
```

* `orphaned` is the only stale classification, and it needs positive evidence: reparented to
  launchd, or the parent pid no longer exists. **Age is never evidence.**
* `crowded` (many servers under one live owner) is reported, never cleaned: the owner is
  keeping many sessions loaded.
* `--cleanup` re-reads each target's start time and command immediately before `SIGTERM`, so a
  recycled pid is never touched, and never uses a pattern kill.

To shrink a crowded owner, end its sessions on the owner's side (e.g. restart that project's
runtime); that closes the pipes and the channel servers exit by themselves.

## 3. `Dispatches: active=… pending=… unretired=…`

`wake_dispatch` rows are an internal delivery ledger, not operator work. `murmur status` now
reports:

| field | meaning |
|---|---|
| `active` | `claimed`/`dispatched` rows whose owner binding is `CLAIMED`/`WAKING`/`RUNNING` with a fresh heartbeat — or an unowned claim younger than 10 min. A runtime is doing it now. |
| `pending` | `pending`/`deferred`/`failed`: waiting to be (re)tried. |
| `unretired` | `claimed`/`dispatched` rows whose owner is gone, idle (`BOUND_IDLE`), stale or absent. A record that outlived its runtime (crash/restart before the turn's outcome was reconciled). Not active work. |
| `byState` (JSON) | raw row counts per state. |

`murmur tasks` is independent: it counts workflows (root msgId → work/cancel state), not
dispatch rows. A day-old `dispatched` row therefore shows as `unretired` in status and as
nothing in tasks — consistent, because nothing is being worked.
