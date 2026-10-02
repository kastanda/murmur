/**
 * claude-config.mjs — the PER-PROJECT Claude model/effort preference.
 *
 * Why a separate file
 * --------------------
 * `~/.murmur/projects/<id>/claude-preferences.json` holds exactly `{ version, model,
 * effort }` and NOTHING else. It is deliberately not part of `agent-config.json` (which
 * holds the Claude identity's private signing/encryption keypair) or `project.json`
 * (which can hold a NATS token): this file never needs to be protected as a credential,
 * so it never shares a file with one. It is read/written only through `secure-state.mjs`
 * (0600, atomic) like every other Murmur preference, as a matter of consistent hygiene —
 * not because its contents are secret.
 *
 * What "model"/"effort" mean here
 * --------------------------------
 *   model  — "sonnet" | "opus" | "inherit". "sonnet"/"opus" are the CLI's own ALIASES
 *            for "the latest model in that tier" (its own `--help` text: "Provide an
 *            alias for the latest model"), not a pinned version — so this setting never
 *            goes stale when the underlying model updates. "inherit" means Murmur passes
 *            no `--model` at all and the installed Claude CLI's own configuration
 *            decides, exactly as it did before this feature existed.
 *   effort — "low" | "medium" | "high" | "xhigh" | "max" | "inherit", the installed
 *            CLI's own `--effort` levels verbatim (see `claude-capabilities.mjs`).
 *            "inherit" means no `--effort` flag is passed.
 *
 * Values are validated against the INSTALLED CLI's discovered capabilities, never a
 * fixed Murmur-side list — see `discoverClaudeCapabilities()`.
 */
import { readPrivateJson, writePrivateJson } from "../secure-state.mjs";
import { canonicalModelLabel, discoverClaudeCapabilities } from "../claude-capabilities.mjs";

export const CLAUDE_PREFERENCES_VERSION = 1;
export const INHERIT = "inherit";

export class ClaudeConfigError extends Error {
  constructor(reason, detail = null) {
    super(`invalid-claude-config:${reason}${detail ? `:${detail}` : ""}`);
    this.name = "ClaudeConfigError";
    this.reason = reason;
    this.detail = detail;
  }
}

const refuse = (reason, detail) => {
  throw new ClaudeConfigError(reason, detail);
};

/** Human labels. "Sonnet"/"Opus" — bare, no fabricated minor version (see module header). */
const MODEL_LABELS_RU = Object.freeze({
  sonnet: "Sonnet",
  opus: "Opus",
  inherit: "По настройкам Claude Code",
});

const EFFORT_LABELS_RU = Object.freeze({
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
  xhigh: "Повышенное",
  max: "Максимальное",
  inherit: "По настройкам Claude Code",
});

export const modelLabel = (value) => MODEL_LABELS_RU[value] || value || null;
export const effortLabel = (value) => EFFORT_LABELS_RU[value] || value || null;

/** Fail-closed shape validation. A half-written or hand-edited file is a diagnostic. */
export const validateClaudePreferences = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("not-an-object");
  if (raw.version !== CLAUDE_PREFERENCES_VERSION) refuse("version-unsupported", String(raw.version));
  if (typeof raw.model !== "string" || !raw.model.trim()) refuse("model-missing");
  if (typeof raw.effort !== "string" || !raw.effort.trim()) refuse("effort-missing");
  return { version: CLAUDE_PREFERENCES_VERSION, model: raw.model.trim(), effort: raw.effort.trim() };
};

/**
 * Load the project's preferences.
 *
 *   { state: "absent" }                 — no file: this project has never set a
 *                                          Murmur-specific Claude preference, so it
 *                                          inherits the installed CLI's own configuration
 *                                          exactly as it always has. An ORDINARY state,
 *                                          not an error.
 *   { state: "configured", preferences } — a valid `{ model, effort }`.
 *   { state: "invalid", reason }         — present but malformed; callers fail closed
 *                                          rather than silently falling back to inherit.
 */
export const loadClaudePreferences = async (paths) => {
  let raw;
  try {
    raw = await readPrivateJson(paths.claudePreferencesFile);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    return { state: "invalid", reason: error?.message || "unreadable" };
  }
  try {
    return { state: "configured", preferences: validateClaudePreferences(raw) };
  } catch (error) {
    return { state: "invalid", reason: error?.message || "invalid" };
  }
};

export const writeClaudePreferences = async (paths, preferences) => {
  await writePrivateJson(paths.claudePreferencesFile, validateClaudePreferences(preferences));
};

/**
 * Validate one requested value (a model OR an effort) against the installed CLI's
 * discovered capabilities. `"inherit"` is always accepted: it asks Murmur to pass
 * nothing, which needs no CLI support to be meaningful.
 */
export const isSupportedModel = (value, capabilities) =>
  value === INHERIT || (capabilities.modelFlagSupported && capabilities.supportedModels.includes(value));

export const isSupportedEffort = (value, capabilities) =>
  value === INHERIT || (capabilities.effortFlagSupported && capabilities.supportedEfforts.includes(value));

/**
 * The default preferences for a BRAND-NEW project profile ONLY — never applied to an
 * existing profile (see `bootstrapProfile`'s reconciliation path, which never calls
 * this). Sonnet/Medium when the installed CLI actually supports both; falls back to
 * "inherit" for whichever one it does not, rather than ever claiming to apply an option
 * that was never validated.
 */
export const defaultClaudePreferencesFor = (capabilities) => ({
  version: CLAUDE_PREFERENCES_VERSION,
  model: isSupportedModel("sonnet", capabilities) ? "sonnet" : INHERIT,
  effort: isSupportedEffort("medium", capabilities) ? "medium" : INHERIT,
});

/**
 * Read the non-secret `model` field Claude Code itself would otherwise fall back to,
 * straight from its OWN global settings file — for DISPLAY ONLY, when this project has
 * no override. Never written to, never copied into Murmur's own config, and read with
 * the same private-file reader as everything else (it is 0600 but holds no credential
 * Murmur cares about; only Claude Code's own preferences, such as `"model": "sonnet"`).
 * Absent or unreadable is reported as unknown, never guessed at.
 */
export const readClaudeCodeDefaultModel = async ({ claudeSettingsPath }) => {
  try {
    const raw = await readPrivateJson(claudeSettingsPath);
    return typeof raw?.model === "string" && raw.model.trim() ? raw.model.trim() : null;
  } catch {
    return null;
  }
};

/**
 * The opportunistically cached CANONICAL model id from `claude-one-shot-runtime.mjs`
 * (e.g. "claude-sonnet-5"), read back for display — only USABLE when its
 * `selectedAlias` still matches the alias actually in effect right now. If the operator
 * switched aliases since the cache was written, the cached id belongs to the PREVIOUS
 * selection and must not be shown as if it described the new one; the caller then falls
 * back to the bare alias label until a turn runs under the new alias and refreshes it.
 * Absent, unreadable or stale is reported as unknown, never guessed at.
 */
export const readCachedCanonicalModel = async ({ claudeRuntimeCacheFile, effectiveAlias }) => {
  if (!claudeRuntimeCacheFile) return null;
  try {
    const raw = await readPrivateJson(claudeRuntimeCacheFile);
    if (raw?.version !== 1 || typeof raw.canonicalModel !== "string" || !raw.canonicalModel) return null;
    if (raw.selectedAlias !== effectiveAlias) return null;
    return raw.canonicalModel;
  } catch {
    return null;
  }
};

/**
 * One live binding's recorded `{ model, effort }`, if the project's Claude daemon is
 * currently running. `readLiveClaudeBinding` is injected so this never has to know
 * about SQLite directly — see `operator/status.mjs`'s `readAgentRuntimeState`, which
 * already selects `runtime_bindings.metadata_json`.
 */
const liveClaudeRuntime = ({ paths, readLiveClaudeBinding }) => {
  if (typeof readLiveClaudeBinding !== "function") return null;
  const state = readLiveClaudeBinding(paths);
  const binding = state?.bindings?.find((row) => row.live) || null;
  if (!binding?.metadata) return null;
  return {
    model: typeof binding.metadata.model === "string" ? binding.metadata.model : null,
    effort: typeof binding.metadata.effort === "string" ? binding.metadata.effort : null,
  };
};

/**
 * Assemble the FULL truthful picture: selected preference, the installed CLI's
 * capabilities, what is actually running right now, and whether those two have
 * diverged. This is the single function both `murmur claude <project> config` and the
 * doctor check build on, so the CLI's human output, its `--json` output and the menu bar
 * can never tell three different stories about the same project.
 */
export const resolveClaudeConfig = async ({
  paths,
  capabilities,
  claudeSettingsPath,
  readLiveClaudeBinding,
  claudeRuntimeCacheFile = paths?.claudeRuntimeCacheFile,
} = {}) => {
  const loaded = await loadClaudePreferences(paths);
  const selected = loaded.state === "configured" ? loaded.preferences : { model: INHERIT, effort: INHERIT };
  const configState = loaded.state; // "absent" | "configured" | "invalid"

  const running = liveClaudeRuntime({ paths, readLiveClaudeBinding });
  const inheritedModel = await readClaudeCodeDefaultModel({ claudeSettingsPath });

  const runningIsLive = running !== null;

  /**
   * One rule, uniform for both the running and the not-running case: the GROUND-TRUTH
   * value is whichever of "what is actually running" / "what is currently selected"
   * applies, each already normalized to either an explicit alias or the literal
   * `"inherit"` sentinel — so comparing them by simple inequality is always correct, with
   * no special-casing for "both happen to be inherit" or "reverted back to inherit while
   * something explicit is still running".
   */
  const describe = (selectedValue, runningValue, inheritedValue, labelFn) => {
    const groundTruth = runningIsLive ? runningValue : selectedValue;
    const effective = groundTruth !== INHERIT ? groundTruth : inheritedValue;
    const source = groundTruth !== INHERIT ? "murmur-project" : "claude-code";
    // A daemon that is ACTUALLY running right now is ground truth: a project can have a
    // brand-new selection on disk while an already-running Claude daemon keeps answering
    // under whatever it was started with — including reverting an explicit choice back to
    // "inherit" while an explicit override is still live. Telling the operator the new
    // selection is already active in that case is exactly the lie section 8 forbids.
    const pendingRestart = runningIsLive && runningValue !== selectedValue;
    return {
      selected: selectedValue,
      selectedLabel: labelFn(selectedValue),
      running: runningIsLive ? runningValue : null,
      runningLabel: runningIsLive ? labelFn(runningValue) : null,
      effective,
      effectiveLabel: effective ? labelFn(effective) : null,
      source,
      pendingRestart,
    };
  };

  const modelDescribed = describe(selected.model, running?.model ?? null, inheritedModel, modelLabel);

  // The CANONICAL model id (e.g. "claude-sonnet-5") is a THIRD, separate concept from the
  // selected alias ("sonnet") and the human label ("Sonnet") — never inferred from the
  // alias, only ever read back from a real completed turn's own evidence (see
  // `readCachedCanonicalModel`). When it correlates to the alias actually in effect, the
  // human label is upgraded from the bare tier name to the precise version ("Sonnet 5");
  // when it does not (no turn has run yet under this alias, or the cache is stale), the
  // bare alias label is kept rather than ever guessing a version.
  //
  // SELECTED and RUNNING/EFFECTIVE are upgraded INDEPENDENTLY, against whichever alias
  // each one actually names — not both against the same "effective" value. Without this,
  // a pending-restart operator who just selected "opus" while "sonnet" is still running
  // would see the bare word "Opus" for their new choice (correct — nothing has executed
  // under it yet) but ALSO a bare "Sonnet" for `Сейчас:`, even though the running daemon
  // has already revealed its exact version. Each label is upgraded by correlating the
  // cache against the matching alias, so "Sonnet 5" / "Opus 5" appear exactly where each
  // is actually known, per Part A4's worked example.
  const canonicalFor = async (alias) => (alias && alias !== INHERIT
    ? readCachedCanonicalModel({ claudeRuntimeCacheFile, effectiveAlias: alias })
    : null);
  const selectedCanonical = await canonicalFor(selected.model);
  const runningCanonical = runningIsLive ? await canonicalFor(running.model) : null;
  const effectiveCanonical = runningIsLive ? runningCanonical : selectedCanonical;
  const upgrade = (label, canonical) => (canonical ? canonicalModelLabel(canonical) ?? label : label);

  const model = {
    ...modelDescribed,
    canonicalModel: effectiveCanonical,
    selectedLabel: upgrade(modelDescribed.selectedLabel, selectedCanonical),
    runningLabel: modelDescribed.runningLabel ? upgrade(modelDescribed.runningLabel, runningCanonical) : modelDescribed.runningLabel,
    effectiveLabel: upgrade(modelDescribed.effectiveLabel, effectiveCanonical),
  };

  return {
    configState,
    configReason: loaded.state === "invalid" ? loaded.reason : null,
    capabilities,
    model,
    // Effort has no local non-network way to read Claude Code's own inherited default
    // (unlike `model`, it is not a plain settings.json field we can safely attribute);
    // an inherited effort is reported as unresolved rather than guessed.
    effort: describe(selected.effort, running?.effort ?? null, null, effortLabel),
  };
};
