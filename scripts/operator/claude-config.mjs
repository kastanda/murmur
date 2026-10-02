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
 *   model  — an id from the installed CLI's OWN model catalog (see
 *            `claude-capabilities.mjs`), or "inherit".
 *              • an ALIAS ("sonnet", "opus", "haiku") is the CLI's moving "latest in that
 *                tier" name — "Актуальный Sonnet". It is never silently converted to a
 *                pinned version, so a preference written before pinned models existed
 *                keeps meaning exactly what it always did;
 *              • a PINNED id ("claude-sonnet-5") is one concrete version that never moves;
 *              • "inherit" means Murmur passes no `--model` at all and the installed
 *                Claude CLI's own configuration decides.
 *   effort — "low" | "medium" | "high" | "xhigh" | "max" | "inherit", the installed
 *            CLI's own `--effort` levels verbatim (see `claude-capabilities.mjs`).
 *            "inherit" means no `--effort` flag is passed.
 *
 * Values are validated against the INSTALLED CLI's discovered capabilities, never a
 * fixed Murmur-side list — see `discoverClaudeCapabilities()`.
 */
import { readPrivateJson, writePrivateJson } from "../secure-state.mjs";
import { canonicalModelLabel } from "../claude-capabilities.mjs";
import { INHERIT, MODEL_KINDS, findOption, isSelectableModelId } from "../agent-models.mjs";

export { INHERIT };

export const CLAUDE_PREFERENCES_VERSION = 1;

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

const INHERIT_LABEL_RU = "По настройкам Claude Code";

const EFFORT_LABELS_RU = Object.freeze({
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
  xhigh: "Повышенное",
  max: "Максимальное",
  inherit: INHERIT_LABEL_RU,
});

/**
 * The model options the installed CLI offers. A capabilities object from a catalog-less
 * source (a test double, or the `--help` fallback) carries only `supportedModels`; those
 * are aliases, exactly what `--help` documents.
 */
export const claudeModelOptions = (capabilities) => {
  if (Array.isArray(capabilities?.models)) return capabilities.models;
  return (capabilities?.supportedModels ?? []).map((id) => ({
    id, canonicalId: null, alias: id, family: id, version: null,
    label: `Актуальный ${id.charAt(0).toUpperCase()}${id.slice(1)}`, resolvesToLabel: null,
    kind: MODEL_KINDS.alias, selectable: true, disabledReason: null, efforts: null,
  }));
};

/** Label of a bare model value — the ONE resolver every surface goes through. */
export const modelLabel = (value, options = []) =>
  value === INHERIT ? INHERIT_LABEL_RU : (findOption(options, value)?.label ?? value ?? null);
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
  value === INHERIT || (Boolean(capabilities?.modelFlagSupported) && isSelectableModelId(value, claudeModelOptions(capabilities)));

export const isSupportedEffort = (value, capabilities) =>
  value === INHERIT || (capabilities.effortFlagSupported && capabilities.supportedEfforts.includes(value));

/**
 * Does `effort` apply to `modelId`? A catalog entry that lists its supported effort
 * levels is authoritative (an older Opus lacks "xhigh"); a model with no listing, an alias the catalog does not know, or "inherit" is not
 * second-guessed.
 */
export const claudeEffortApplies = (modelId, effort, capabilities) => {
  if (effort === INHERIT || modelId === INHERIT) return true;
  const efforts = findOption(claudeModelOptions(capabilities), modelId)?.efforts;
  // An EMPTY list means the catalog advertises no effort control for that model (Haiku);
  // verified live that the CLI then simply ignores `--effort`, so it is not refused.
  return !Array.isArray(efforts) || efforts.length === 0 || efforts.includes(effort);
};

/**
 * The effort choices the menu offers — the simple levels the GUI intentionally supports
 * (low/medium/high) that the selected model takes, plus whichever other valid level the
 * operator already chose through the CLI so the checkmark never vanishes, plus
 * "inherit". Built here so Swift never decides what is selectable.
 */
export const claudeEffortOptions = ({ capabilities, selectedModel, selectedEffort }) => {
  const supported = capabilities?.supportedEfforts ?? [];
  const wanted = ["low", "medium", "high"];
  if (selectedEffort && selectedEffort !== INHERIT && !wanted.includes(selectedEffort)) wanted.push(selectedEffort);
  const ids = wanted.filter((level) => supported.includes(level) && claudeEffortApplies(selectedModel, level, capabilities));
  return [...ids, INHERIT].map((id) => ({ id, label: effortLabel(id) }));
};

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
 * The single description of one model selection. `id` is the selection ("sonnet",
 * "claude-sonnet-5", "inherit"); `label` names THAT SELECTION ("Актуальный Sonnet",
 * "Sonnet 5"); `canonicalId`/`effectiveLabel` name the concrete model it runs as
 * ("claude-sonnet-5-5" / "Sonnet 5.5"), taken from a real completed turn when one
 * correlates, else from the CLI's own catalog resolution — and left null/label-only when
 * neither is known, never guessed.
 */
export const claudeModelView = (id, { options = [], observedCanonical = new Map(), inheritedModel = null, defaultModel = null } = {}) => {
  if (id === INHERIT) {
    const inheritedId = inheritedModel && inheritedModel !== "default" ? inheritedModel : null;
    const inner = inheritedId ? claudeModelView(inheritedId, { options, observedCanonical, inheritedModel: null, defaultModel }) : null;
    const canonicalId = inner ? inner.canonicalId : (defaultModel?.canonicalId ?? null);
    const effectiveLabel = inner ? inner.effectiveLabel : (defaultModel?.label ?? null);
    return {
      id: INHERIT, kind: MODEL_KINDS.inherit, label: INHERIT_LABEL_RU,
      canonicalId, resolvesToLabel: effectiveLabel, effectiveLabel, selectable: true,
    };
  }
  const option = findOption(options, id);
  const kind = option?.kind ?? (id.startsWith("claude-") ? MODEL_KINDS.pinned : MODEL_KINDS.alias);
  const label = option?.label ?? id;
  const canonicalId = (kind === MODEL_KINDS.alias ? observedCanonical.get(id) : null) ?? option?.canonicalId ?? null;
  const concrete = canonicalId
    ? (findOption(options, canonicalId)?.label ?? canonicalModelLabel(canonicalId))
    : null;
  return {
    id, kind, label, canonicalId,
    resolvesToLabel: kind === MODEL_KINDS.alias ? (concrete ?? option?.resolvesToLabel ?? null) : null,
    effectiveLabel: kind === MODEL_KINDS.pinned ? label : (concrete ?? label),
    selectable: option ? option.selectable === true : false,
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

  // ONE label resolver (`claudeModelView`) describes the selected, the running and the
  // effective model, so the menu's main line, the model submenu, the details window, the
  // CLI JSON and the pending-restart text can never name the same option differently.
  //
  // Three separate concepts are kept apart: the SELECTION id ("sonnet" — a moving alias —
  // or "claude-sonnet-5" — a pinned version), the CANONICAL id it runs as
  // ("claude-sonnet-5-5"), and the human LABEL of each. An alias is never rendered as, or
  // converted into, a pinned version: "Актуальный Sonnet" stays that even while it
  // resolves to Sonnet 5.5.
  const options = claudeModelOptions(capabilities);
  const observedCanonical = new Map();
  for (const id of new Set([selected.model, running?.model].filter((v) => v && v !== INHERIT))) {
    observedCanonical.set(id, await readCachedCanonicalModel({ claudeRuntimeCacheFile, effectiveAlias: id }));
  }
  const viewCtx = { options, observedCanonical, inheritedModel, defaultModel: capabilities?.defaultModel ?? null };
  const modelDescribed = describe(selected.model, running?.model ?? null, inheritedModel, (v) => modelLabel(v, options));
  const selectedView = claudeModelView(selected.model, viewCtx);
  const runningView = runningIsLive ? claudeModelView(running.model, viewCtx) : null;
  const effectiveView = runningIsLive ? runningView : selectedView;

  const model = {
    ...modelDescribed,
    selectedView,
    runningView,
    effectiveView,
    inheritView: claudeModelView(INHERIT, viewCtx),
    canonicalModel: effectiveView.canonicalId,
    selectedLabel: selectedView.label,
    runningLabel: runningView ? runningView.label : null,
    effectiveLabel: effectiveView.effectiveLabel,
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
