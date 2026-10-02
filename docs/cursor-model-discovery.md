# Cursor model selection: local investigation and why Murmur only displays it

This documents the local, empirical investigation behind `scripts/operator/cursor-config.mjs`
and `scripts/operator/cursor.mjs` (`murmur cursor <project> config`). No web research was
used as evidence for any runtime behavior below — every claim here was verified against
the operator's own installed Cursor Agent CLI (`agent`, version `2026.09.02-c22c1a3`) and
its ACP server, run locally.

## What was probed

The installed `agent` binary has two relevant surfaces:

- A top-level CLI: `agent --model <id>`, `agent --list-models`. No ACP involvement.
- `agent acp`: starts an Agent Client Protocol JSON-RPC server over stdin/stdout. This is
  the mode Murmur's `cursor_acp` runtime actually drives.

Talking to `agent acp` directly (a local Node script piping JSON-RPC frames to the
spawned process, never the network) surfaced these methods: `initialize`, `authenticate`,
`session/new`, `session/set_mode`, `session/set_model`, `session/list`, `session/load`,
`session/prompt`, `session/cancel`, `session/fork`, `session/resume`,
`session/set_config_option`.

`session/new`'s own response carries a full model catalogue:
`models: { currentModelId, availableModels: [{ modelId, name }] }`. Model ids use a
bracket-encoded parameter syntax, e.g. `claude-sonnet-5[thinking=true,context=300k,effort=high]`.

`session/set_model` (internally reached via an unstable-flagged `unstable_setSessionModel`,
found by grepping the installed JS bundle) accepts exactly one of those catalogue ids and
applies it immediately, with no session loss.

## The critical finding: it is account-global, not session- or project-scoped

`session/set_model` was called once in a live probe process, selecting a different model
than the operator's prior default. A **second, independent** `agent acp` process was then
started from a **separate** Node invocation — a fresh process, fresh stdin/stdout, no
shared state deliberately passed between them. That second process's `session/new` reported
`currentModelId` as the value the **first** process had set, not the operator's original
default.

This proves the selection is not scoped to:
- the ACP session,
- the ACP process,
- or a Murmur project/profile.

It persists in the operator's own global Cursor configuration files:

- `~/.cursor/cli-config.json` — fields observed: `model: {modelId, displayModelId,
  displayName, displayNameShort, aliases, maxMode}`, `selectedModel: {modelId,
  parameters}`, `hasChangedDefaultModel`, `modelSelectionHistory` (array, most-recent-
  first), and `authInfo: {email, displayName, userId, authId}` (secret-adjacent — never
  read or surfaced by Murmur's code).
- `~/.cursor/acp-config.json` — `{ selectedModelVariantId: "<bracketed-id>" }`.

It is whatever the same account's interactive `agent` CLI or the Cursor IDE would also see
and use next — i.e. this is the operator's personal Cursor preference, identical in scope
to signing in once and having it apply everywhere that account is used on the machine.

## Why Murmur does not call `session/set_model`

Calling `session/set_model` from a per-project Murmur preference would not be "Cursor
model control for this Murmur project" — it would silently reach outside Murmur into the
operator's own personal Cursor configuration and change it for *every* other use of Cursor
on this machine (the IDE, a manual `agent` session, another Murmur project), with no
mechanism to scope the effect. There is no project-scoped or session-scoped variant of
this RPC to fall back to.

This is exactly the case this project's own design policy calls out: an "inherently
global" mechanism gets **shown**, never silently used. So:

- `scripts/operator/cursor-config.mjs` only ever **reads** `~/.cursor/cli-config.json`,
  for display. It has no write/set/mutate-named export (enforced by a structural test in
  `tests/operator-cursor-config.test.mjs`).
- `scripts/operator/cursor.mjs`'s `murmur cursor <project> model <id>` subcommand **exists
  only to refuse**, with an explanation and exit code 1 — never a silent no-op, never a
  partial write.
- The macOS menu bar's Cursor section is a single read-only line (`Cursor: <label>`, with
  a note that Murmur does not control it) — no submenu, no button, matching the Claude
  section's `INHERIT` case but with no selector offered at all, since there is nothing
  Murmur could safely apply.

## Incidental side effect during investigation, and its remediation

Running the live probes above (calling `session/set_model` twice, to exercise both the
"it works" and "it is global" claims) necessarily mutated the operator's real global
Cursor configuration, exactly as described above — there was no way to observe the global
scoping behavior without actually triggering it once.

Before any of this probing, the operator's real `~/.cursor/cli-config.json` had
`model.modelId: "default"` (`displayName: "Auto"`) — confirmed from the first entry that
appeared at the tail of `modelSelectionHistory` once two probe changes had been made
(`["claude-opus-5", "claude-sonnet-5", "default"]`, most-recent-first — the oldest entry
anchors what was there before). This was remediated immediately after discovery, before
any further work: `session/set_model` was called once more with `modelId: "default[]"`,
and the restoration was verified by re-reading the config
(`model.modelId: "default"`, `model.displayName: "Auto"`,
`modelSelectionHistory: ["default", "claude-opus-5", "claude-sonnet-5"]`). No other global
Cursor file was touched at any point.

## Summary

| Question | Answer |
| --- | --- |
| Does the installed Cursor ACP server support model enumeration? | Yes — `session/new`'s `models.availableModels`. |
| Does it support model selection? | Yes — `session/set_model`, functional, no session loss. |
| Is the effective model verifiable? | Yes — `session/new`'s `models.currentModelId`, and `~/.cursor/cli-config.json`. |
| Is selection scoped to a session, process, or Murmur project? | **No — it is account-global.** |
| Does Murmur offer a per-project Cursor model selector? | **No**, by design — see above. |
| What does Murmur show instead? | A read-only `murmur cursor <project> config` report and menu bar line, sourced from the same global file, truthfully labeled `controllable: false`. |
