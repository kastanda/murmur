/**
 * cursor-config.mjs — read-only discovery of the Cursor model Murmur's `cursor_acp`
 * runtime is actually using.
 *
 * Why this is READ-ONLY, unlike `claude-config.mjs`
 * --------------------------------------------------
 * The installed Cursor Agent CLI (2026.09.02-c22c1a3) genuinely supports explicit model
 * selection over ACP: `session/new`'s own response already carries
 * `models.{currentModelId,availableModels}`, and an (internally unstable-flagged, but
 * functional) `session/set_model` RPC accepts the exact bracketed model id from that
 * catalogue and applies it immediately with no session loss.
 *
 * It was verified EMPIRICALLY, live, against the installed binary — by calling
 * `session/set_model` in one process and then starting a brand-new `agent acp` process
 * in a SEPARATE process — that the selection is NOT scoped to the ACP session, the ACP
 * process, or a Murmur project: it persists in the user's own global Cursor
 * configuration (`~/.cursor/cli-config.json` and `~/.cursor/acp-config.json`) and is
 * whatever the SAME account's interactive `agent`/Cursor IDE would also see and use next.
 *
 * Calling `session/set_model` from a per-project Murmur preference would therefore not
 * be "Cursor model control for this Murmur project" — it would be silently reaching
 * into the operator's own personal Cursor configuration and changing it for every other
 * use of Cursor on this machine, with no way to scope the effect to Murmur. That is
 * exactly the "inherently global" mechanism this project's own policy says to SHOW,
 * never silently use — so this module only ever READS the two files above, for display,
 * and never calls `session/set_model`. See `docs/cursor-model-discovery.md` for the full
 * investigation trail, including the exact probe sequence and the restoration of the
 * operator's real selection to what it was before this investigation (it was "default" /
 * "Auto") after the discovery probes were run.
 */
import path from "node:path";
import { readPrivateJson } from "../secure-state.mjs";

/** `~/.cursor/cli-config.json` — read-only, for display, never written. */
export const cursorCliConfigPath = (homedir) => path.join(homedir, ".cursor", "cli-config.json");

export const CURSOR_SOURCE = "cursor-global";
export const CURSOR_NOT_CONTROLLABLE_REASON = "cursor-model-selection-is-account-global";

/**
 * Read the `{ modelId, displayName }` Cursor's own global CLI config currently records —
 * for DISPLAY ONLY. Never written to, never copied into any Murmur-owned file. Absent,
 * unreadable or missing the expected shape resolves to `null`, never guessed at.
 */
export const readCursorGlobalModel = async ({ cursorCliConfigPath: configPath }) => {
  try {
    const raw = await readPrivateJson(configPath);
    const modelId = raw?.model?.modelId;
    const displayName = raw?.model?.displayName;
    if (typeof modelId !== "string" || !modelId.trim()) return null;
    return {
      modelId: modelId.trim(),
      // `displayName` is Cursor's OWN human label (e.g. "Claude Opus 5 300K High") — used
      // verbatim, exactly like `modelId`: never reformatted, shortened or guessed at.
      displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : null,
    };
  } catch {
    return null;
  }
};

/**
 * The full truthful picture for `murmur cursor <project> config`: Murmur has no
 * selection of its own to report (there is nothing it could safely apply — see the
 * module header), so `selectedModel`/`supportedModels` are honestly empty, and
 * `effectiveModel`/`effectiveModelLabel` are read straight from Cursor's own global
 * state. `controllable: false` is the one field every caller (CLI, menu bar) must check
 * before ever considering building a selector.
 */
export const resolveCursorModelInfo = async ({ cursorCliConfigPath: configPath }) => {
  const global = await readCursorGlobalModel({ cursorCliConfigPath: configPath });
  return {
    controllable: false,
    reason: CURSOR_NOT_CONTROLLABLE_REASON,
    selectedModel: null,
    selectedModelLabel: null,
    effectiveModel: global?.modelId ?? null,
    effectiveModelLabel: global?.displayName ?? global?.modelId ?? null,
    source: CURSOR_SOURCE,
    supportedModels: [],
    requiresRestart: false,
    requiresNewSession: false,
  };
};
