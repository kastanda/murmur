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
