# Provider usage and limits

`murmur usage <project> [--json] [--refresh]` and the menu's «Лимиты ▸». Every figure is what the
**provider itself** reports, read from the installed tool — no scraping, no estimates from message
counts or tokens, no model turn.

## Sources (verified against Claude Code 2.1.285 / codex-cli 0.159.2 on 2026-10-03)

| Provider | Source | Kind | Windows |
|---|---|---|---|
| **Claude** | the SDK control request `get_usage` over `claude -p --input-format stream-json` (the data behind the CLI's own `/usage`; ~1.2 s, no inference) | `subscription_usage` | `rate_limits.limits[]`: the **5-hour session**, **weekly (all models)** and per-model weekly scopes, each with `percent` **used** and an ISO `resets_at`. Semantics proven: `claude -p "/usage"` prints «23% used» for the same number |
| **Codex** | App Server `account/rateLimits/read` (+ `account/read` for the login type; ~0.7 s, no turn) | `subscription_usage` for a ChatGPT-plan login, `api_rate_limit` for an API-key login | `primary`/`secondary` with `usedPercent`, `windowDurationMins` (e.g. 10080 = weekly), `resetsAt` (epoch **seconds**) |
| **Cursor** | none: neither `agent` (CLI) nor ACP exposes usage or quota | — | **unavailable** (`not-exposed-by-runtime`) — a valid outcome, shown as «Данные недоступны» |

Cursor's backend has usage RPCs, but they need Cursor's stored credentials; Murmur does not touch
them. Usage comes only from what a provider's own CLI/App Server hands out.

## What is NOT quota (and is never shown as such)

* **subscription/account usage** — the windows above, the only thing rendered as «осталось N%»;
* **API rate limit** — labelled «Лимиты API (не лимит аккаунта)», never coloured, never a warning;
* **spend / credits / balance** (`extra_usage`, `spend`, `credits`) — dropped at the parser;
* **context window** and **per-turn tokens / cost** (`model_usage`, `thread/tokenUsage`) — never read.

`usedPercent`/`percent` are **used** → `remainingPercent = 100 − used`. Each window is kept
separate; the optional `minRemaining` is clearly marked `derived` and is the tightest *fresh*
window (detail always shows all). Percentages outside 0–100 or non-numeric are rejected.

## Freshness

Each snapshot carries `observedAt`. It is **stale** when older than 10 minutes, or when any of its
windows has already reset since it was observed — the menu then says «Данные устарели», drops the
colour and raises no low-limit warning. A failed refresh keeps the last real snapshot (still with
its real `observedAt`, flagged stale) plus a redacted, bounded reason.

## Cadence and cost

`murmur usage` answers from a cache (`~/.murmur/cache/…/provider-usage.json`, public figures only)
for 2 minutes; `--refresh` re-reads. The menu bar polls tasks every 5 s (local, cheap) but usage
only every **120 s**; «Обновить лимиты» forces a read. A refresh spawns the provider's own
CLI/App Server once (argv only) and costs no model tokens.

## Passive warning

If a fresh **subscription** window has < 10% left, the menu bar asks before sending
(«Всё равно отправить» / «Отмена»); `murmur send` prints a non-blocking stderr line from the
**cached** snapshot. Nothing is ever blocked and no model is switched.

Colours: >25% 🟢, 10–25% 🟡, <10% 🔴 — only when a meaningful remaining percentage exists; the text
is always rendered.

## Privacy

Parsed output holds only provider, kind, plan label, window label, percentages, reset instants and
`observedAt`. Account ids, emails, balances and headers are dropped at the parser boundary and
never cached; diagnostics are redacted and bounded.

## Quota-aware routing (availability)

`murmur usage <project> --json` and `murmur availability <project> [--json] [--refresh]` also report, per
provider, the **routing availability** Murmur uses *before* it creates a handoff or starts a runtime. One
resolution function (`scripts/provider-availability.mjs`) serves the router, the CLI and the Menu Bar.

| availability | meaning | routable |
|---|---|---|
| `available` | every constraining window above 10% remaining (or a real turn just succeeded) | yes |
| `degraded` | a constraining window ≤ 10% but > 0: **warning only** | yes |
| `exhausted` | an authoritative constraining window is 0% remaining, **or** a provider returned a positively identified quota error | **no (new work only)** |
| `unknown` | usage unavailable / stale / malformed / refresh failed / none exposed (Cursor) | yes |

Never inferred from stale or missing data, context size, token or message counts, elapsed time or a low
percentage. *Constraining* windows are the account-level subscription windows (Claude `session`/`weekly`,
Codex `primary`/`secondary` of the main bucket); per-model scoped windows and API-key rate limits
(`api_rate_limit`) never exclude an agent. ANY exhausted constraining window exhausts the agent (5h 40%,
weekly 0% ⇒ exhausted); the reset is the latest exhausted window's.

**Errors.** Only structured evidence counts: Codex `codexErrorInfo` `usageLimitExceeded`; Claude `is_error` +
HTTP 429 + the CLI's own subscription-limit wording (or a `rate_limit_event` rejection of a subscription
window); a Cursor ACP RPC error with a string quota code. A generic 429, timeout, network, auth or 5xx
failure is never quota. Only `provider, state, observedAt, source, resetsAt, category` are persisted
(`~/.murmur/cache/agent-models/provider-availability.json`) — never a payload, header or identifier.

**Stale / reset.** An exhausted snapshot whose `resetsAt` has passed, or that is older than 10 minutes, is
`unknown` (refresh pending) — never a permanent block. An error-derived exhaustion without a reset is held
at most 30 minutes, then re-checked. A later authoritative reading, or a real successful turn, recovers the
agent automatically; no restart is needed.

**Routing.** `AgentHandoffController.delegate` refuses a NEW handoff to an exhausted recipient *before* the
envelope is built, before any durable child row or outbox row, and before any runtime/model. The refusal is a
structured result (`reason: provider-quota-exhausted`, `resetsAt`, `waitReason`, `substitutionAllowed`); the
router never substitutes another agent. Exhausted targets are removed from — and listed in — the coordinator's
handoff instructions, so it can choose for optional work. A refused delegation becomes a durable
`provider_waits` row (`waiting_for_provider` with a reset, else `blocked_by_provider_quota`) that records
provider, `firstObservedAt`, `resetsAt`, the intended recipient and the workflow id. It is re-evaluated only
when due (the authoritative reset + 5 s, else every 10 min), refreshes usage once, and — if the provider is
no longer exhausted — releases the original delegation **exactly once** (CAS + cause-unique continuation in
one transaction). Cancelling the workflow cancels the wait.

**Dispatch gate.** In each provider daemon the claimed dispatch is checked before anything starts: an
exhausted provider defers it in `wake_dispatch` to the reset (no attempt consumed, no model call). A turn
that fails with a positively identified quota error records the exhaustion and moves the failed dispatch to
the same wait (attempt refunded) instead of retrying. A turn the provider already accepted is never
interrupted by usage polling.

**Claude is the coordinator.** No failover: when Claude is exhausted `murmur send` exits 3 with
`reason: provider-quota-exhausted` (`providerState`, `resetsAt`, `queued: false`, `substituted: false`) and
nothing is enqueued. Queueing a *root* task until the reset is not implemented (the root send has no
idempotency key, so a safe exactly-once release is not possible yet).

**Mandatory reviewer.** A required provider is never substituted or waived. `--release-gate` on a refused
send reports `releaseGate.state` `WAITING_FOR_PROVIDER_RESET` (reset known) / `BLOCKED_BY_PROVIDER_QUOTA`;
a delegation to a provider listed in `routing.mandatoryProviders` of the daemon config is marked mandatory
and waits for exactly that provider.

**Menu Bar / Active Tasks.** Exhausted: `🔴 Лимит исчерпан` + `Автоисключён из новых задач` (Claude: `Новые
задачи ожидают сброса`) + `Возобновление после HH:mm`; degraded: yellow + `Лимит почти исчерпан`; unknown is
never red. Tasks waiting for a provider show `Ожидает лимита Codex · Сброс через 41м` or `Заблокировано:
лимит Codex исчерпан`, are never `running` and name no active agent.

There is no “force an exhausted agent” override; “Обновить лимиты” is the only manual action.
