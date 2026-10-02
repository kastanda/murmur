# Agent model discovery — Claude and Codex

Evidence behind `murmur claude <project> …` and `murmur codex <project> …`, gathered from the
**locally installed** tools on 2026-10-02 (Claude Code 2.1.285, codex-cli 0.159.2). Nothing here
comes from a web model list: the installed tools and the account they are logged into are the
only authority, and the menu never shows a model they do not offer. Cursor is unchanged — see
[cursor-model-discovery.md](cursor-model-discovery.md).

## Claude

**Where the catalog comes from.** `claude --help` documents only a few example aliases. The
machine-readable catalog is the one Claude Code's own `/model` picker uses: the SDK `initialize`
control request answers with `models: [{ value, resolvedModel, displayName,
supportedEffortLevels, … }]`. Murmur spawns `claude -p --safe-mode --input-format stream-json
--output-format stream-json --verbose --no-session-persistence` (argv only, neutral cwd),
sends **only** that one request — no user message, so zero model tokens — reads the response and
kills the process (~1.5–2 s). The `account` block of the response (an email) is discarded and never
cached. The normalized rows are cached for 6 h in `~/.murmur/cache/agent-models/claude.json`,
keyed by the binary's path/size/mtime, so the menu's 5-second poll never spawns it; a failed
probe falls back to the stale cache, then to the aliases `--help` itself documents.

**Alias vs pinned.** A row whose `value` differs from its `resolvedModel` is a moving **alias**
(`sonnet` → `claude-sonnet-5-5`; label «Актуальный Sonnet — сейчас Sonnet 5.5»). A row where they
are equal is a **pinned** concrete version (`claude-sonnet-5`, label «Sonnet 5»). An alias's
resolved id is also offered as a pinned choice when the catalog does not list it separately
(«Sonnet 5.5», «Haiku 4.5») — it is the exact id the CLI itself resolves that alias to. This was
checked live with one-word turns: `--model claude-sonnet-5-5` and `--model
claude-haiku-4-5-20251001` are accepted (`modelUsage` reports exactly that id); an unlisted id
(`claude-sonnet-9`) is rejected by the CLI (`unrecognized_model` / API 404), which is also why
Murmur validates against the catalog instead of trusting the CLI to refuse.

`default` ("Default (recommended)") is not an option: it is Anthropic's recommendation, reported
separately as the catalog default and used only to label "по настройкам Claude Code".

**Selection semantics.** Stored in `claude-preferences.json` (`{version, model, effort}`),
unchanged format. `sonnet`/`opus`/`haiku` are aliases and stay aliases — an existing `sonnet`
preference is never rewritten to a pinned version. A pinned id is an explicit choice. Applied when
the Claude daemon boots («Применится после перезапуска Murmur»). The exact model a turn ran as is
read back from that turn's own `modelUsage` (pinned ids match **exactly**, aliases by family) and
cached for display.

**Effort.** Per-model `supportedEffortLevels` are authoritative (an older Opus lacks `xhigh`);
`murmur claude <p> effort|model` refuses an incompatible pair. A model that advertises no effort
control (Haiku) is not refused — the CLI was verified to ignore `--effort` for it.

## Codex App Server

Probed with a private `codex app-server --listen stdio://` process (never the project's socket),
plus `codex app-server generate-json-schema --experimental` for the protocol.

| Question | Answer (evidence) |
|---|---|
| Can it enumerate models? | Yes: `model/list` (paginated; `includeHidden:false`). 8 models returned here. |
| Stable ids? | Yes: `id`/`model` slug + `displayName`, `isDefault`, `hidden`, `defaultReasoningEffort`, `supportedReasoningEfforts` per model. |
| Per thread/session/turn? | Both: `thread/start {model, config.model_reasoning_effort}`; `turn/start {model, effort}` — schema: "for this turn **and subsequent turns**" (scoped to that thread). |
| Effective model readable? | Yes: `thread/start`/`thread/resume` responses carry `model` + `reasoningEffort`; a `turn/start` override is confirmed by a `thread/settings/updated` notification (`threadSettings.model`, `.effort`). |
| Reasoning effort selectable/readable? | Yes, same mechanisms. Levels differ per model (up to `ultra`). |
| What does a change require? | Nothing: it applies on the next `turn/start`. No restart, no new thread. |
| Context across a model change? | Preserved: turn 1 "remember PINEAPPLE" (gpt-5.5/low), turn 2 under another model + effort answered PINEAPPLE, and the notification reported the new model/effort. |
| Resumed thread, different model? | `thread/resume` accepts `model`; Murmur sends the policy on every `turn/start` anyway. |
| Touches global config? | No: `~/.codex/config.toml` hash identical before and after every probe, including real turns with overrides. |

Limit: a thread keeps its last explicit settings. Murmur cannot *unset* them, so going back to
`inherit` (send nothing) re-applies the Codex default only on a **new** thread. `murmur codex …
config --json` reports this as `requiresNewThread` and the menu says «Применится к новой сессии
Codex». An explicit change is reported as `pendingNextTurn` («Применится со следующего запроса
к Codex»). Codex never reports `pendingRestart`.

**Inherit** means Murmur sends no `model`/`effort`; the effective default is what an *ephemeral*
`thread/start` with no overrides reports (read once, cached with the catalog in
`~/.murmur/cache/agent-models/codex.json`, keyed by the binary and `config.toml`'s stat — its
contents are never read).

**Project policy.** `codex-preferences.json` (`{version, model, effort}`). The Codex daemon reads it
**per turn**, re-validates it against the live catalog (a model that is no longer offered is
dropped to "no override" and logged), and sends it on `thread/start`, `thread/resume` and every
`turn/start`. The runtime records what the server reported (`codex-runtime-cache.json`) for the
selected-vs-effective display.

## Ownership rule

The **recipient's** project policy chooses its model. Claude→Codex, Cursor→Codex and root→Codex
all run under the project's Codex preference; Codex→Claude and Cursor→Claude under its Claude
preference. The policy is resolved inside the recipient's runtime; message text and sender
identity never reach it (`tests/codex-model-control.test.mjs` sends "use model-a … --model
model-a" text and different senders and asserts the project policy is unchanged).
