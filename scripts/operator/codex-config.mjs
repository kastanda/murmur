/**
 * codex-config.mjs — the PER-PROJECT Codex model/reasoning-effort preference.
 *
 * Unlike Cursor (whose `session/set_model` rewrites the operator's account-global config),
 * the Codex App Server accepts `model` and reasoning effort scoped to ONE THREAD:
 * `thread/start {model, config.model_reasoning_effort}` and `turn/start {model, effort}`
 * ("this turn and subsequent turns" of that thread). Verified live against codex-cli
 * 0.159.2 that neither touches `~/.codex/config.toml`. So Murmur can honestly offer a
 * project-scoped selector — see `docs/agent-model-discovery.md` for the evidence.
 *
 * `~/.murmur/projects/<id>/codex-preferences.json` holds exactly `{ version, model,
 * effort }` and nothing else; "inherit" means Murmur passes no override and the Codex
 * configuration decides, exactly as before this feature. Values are validated against the
 * App Server's OWN `model/list` (never a fixed list, never a web list).
 *
 * Semantics (all technically true, see `resolveCodexConfig`):
 *   - an explicit model/effort is applied from the NEXT Codex turn (no restart): it is
 *     sent with every turn, so the thread keeps its context;
 *   - switching back to "inherit" cannot UNSET a setting an existing thread already holds
 *     (the server keeps a thread's last explicit settings), so it takes effect on a NEW
 *     Codex thread/session — reported as `requiresNewThread`.
 */
import { rm } from "node:fs/promises";
import { readPrivateJson, writePrivateJson } from "../secure-state.mjs";
import { INHERIT, MODEL_KINDS, findOption, isSafeValue, isSelectableModelId } from "../agent-models.mjs";

export { INHERIT };

export const CODEX_PREFERENCES_VERSION = 1;
const INHERIT_LABEL_RU = "По настройкам Codex";

export class CodexConfigError extends Error {
  constructor(reason, detail = null) {
    super(`invalid-codex-config:${reason}${detail ? `:${detail}` : ""}`);
    this.name = "CodexConfigError";
    this.reason = reason;
    this.detail = detail;
  }
}

const refuse = (reason, detail) => {
  throw new CodexConfigError(reason, detail);
};

const EFFORT_LABELS_RU = Object.freeze({
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
  xhigh: "Повышенное",
  max: "Максимальное",
  ultra: "Ультра",
  inherit: INHERIT_LABEL_RU,
});
export const codexEffortLabel = (value) => EFFORT_LABELS_RU[value] || value || null;
export const codexModelLabel = (value, options = []) =>
  value === INHERIT ? INHERIT_LABEL_RU : (findOption(options, value)?.label ?? value ?? null);

/** Fail-closed shape validation. */
export const validateCodexPreferences = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("not-an-object");
  if (raw.version !== CODEX_PREFERENCES_VERSION) refuse("version-unsupported", String(raw.version));
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const effort = typeof raw.effort === "string" ? raw.effort.trim() : "";
  if (!model) refuse("model-missing");
  if (!effort) refuse("effort-missing");
  if (model !== INHERIT && !isSafeValue(model)) refuse("model-malformed");
  if (effort !== INHERIT && !isSafeValue(effort)) refuse("effort-malformed");
  return { version: CODEX_PREFERENCES_VERSION, model, effort };
};

/** `{state:"absent"}` (ordinary: inherits Codex's own configuration) | `configured` | `invalid`. */
export const loadCodexPreferences = async (paths) => {
  let raw;
  try {
    raw = await readPrivateJson(paths.codexPreferencesFile);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent" };
    return { state: "invalid", reason: error?.message || "unreadable" };
  }
  try {
    return { state: "configured", preferences: validateCodexPreferences(raw) };
  } catch (error) {
    return { state: "invalid", reason: error?.message || "invalid" };
  }
};

export const writeCodexPreferences = async (paths, preferences) => {
  await writePrivateJson(paths.codexPreferencesFile, validateCodexPreferences(preferences));
};

export const codexModelOptions = (capabilities) => (Array.isArray(capabilities?.models) ? capabilities.models : []);

/** Effort levels valid for `modelId`: that model's own list; for "inherit", the default model's. */
export const codexEffortsFor = (modelId, capabilities) => {
  const options = codexModelOptions(capabilities);
  const concrete = modelId === INHERIT ? capabilities?.defaults?.model ?? null : modelId;
  const option = concrete ? findOption(options, concrete) : null;
  if (option) return option.efforts ?? [];
  return [...new Set(options.flatMap((o) => o.efforts ?? []))];
};

export const isSupportedCodexModel = (value, capabilities) =>
  value === INHERIT || (Boolean(capabilities?.available) && isSelectableModelId(value, codexModelOptions(capabilities)));

export const isSupportedCodexEffort = (value, capabilities, modelId = INHERIT) =>
  value === INHERIT || (Boolean(capabilities?.available) && isSafeValue(value) && codexEffortsFor(modelId, capabilities).includes(value));

/**
 * What the runtime may actually send for the project's saved preference, validated NOW
 * against the live catalog: an option that is no longer offered (or an effort the model
 * does not take) is dropped back to "no override" and reported, never forwarded.
 */
export const resolveCodexRuntimePolicy = ({ preferences, capabilities }) => {
  const reasons = [];
  let model = null;
  let effort = null;
  if (preferences && capabilities?.available) {
    if (preferences.model !== INHERIT) {
      if (isSupportedCodexModel(preferences.model, capabilities)) model = preferences.model;
      else reasons.push("model-no-longer-offered");
    }
    if (preferences.effort !== INHERIT) {
      if (isSupportedCodexEffort(preferences.effort, capabilities, model ?? INHERIT)) effort = preferences.effort;
      else reasons.push("effort-not-supported-by-model");
    }
  } else if (preferences && (preferences.model !== INHERIT || preferences.effort !== INHERIT)) {
    reasons.push("catalog-unavailable");
  }
  return { model, effort, reasons };
};

/**
 * What the App Server last REPORTED running for this project (written by the Codex daemon
 * after a turn; display only). Absent/unreadable => null, never a guess.
 */
export const readCodexRuntimeCache = async ({ codexRuntimeCacheFile }) => {
  if (!codexRuntimeCacheFile) return null;
  try {
    const raw = await readPrivateJson(codexRuntimeCacheFile);
    if (raw?.version !== 1 || typeof raw.model !== "string" || !raw.model) return null;
    return {
      model: raw.model,
      effort: typeof raw.effort === "string" ? raw.effort : null,
      observedAt: typeof raw.observedAt === "string" ? raw.observedAt : null,
      source: typeof raw.source === "string" ? raw.source : null,
      selection: {
        model: typeof raw.selection?.model === "string" ? raw.selection.model : INHERIT,
        effort: typeof raw.selection?.effort === "string" ? raw.selection.effort : INHERIT,
      },
    };
  } catch {
    return null;
  }
};

export const writeCodexRuntimeCache = async ({ codexRuntimeCacheFile }, record) => {
  if (!codexRuntimeCacheFile) return;
  await writePrivateJson(codexRuntimeCacheFile, { version: 1, ...record });
};

/**
 * Forget what the previous Codex daemon observed. A daemon restart drops its in-memory
 * thread table, so a record about the old threads must not claim an explicit setting is
 * still held ("requires a new session") or stand in for what is running now.
 */
export const clearCodexRuntimeCache = async ({ codexRuntimeCacheFile }) => {
  if (!codexRuntimeCacheFile) return;
  await rm(codexRuntimeCacheFile, { force: true });
};

export const CODEX_NOT_CONTROLLABLE_REASON = "codex-model-catalog-unavailable";

/**
 * The full truthful picture for `murmur codex <project> config`: SELECTED preference vs
 * EFFECTIVE (what the App Server reported running, else — for "inherit" — what Codex
 * itself would use), plus the transition that applies.
 */
export const resolveCodexConfig = async ({ paths, capabilities, codexRuntimeCacheFile = paths?.codexRuntimeCacheFile } = {}) => {
  const loaded = await loadCodexPreferences(paths);
  const selected = loaded.state === "configured" ? loaded.preferences : { model: INHERIT, effort: INHERIT };
  const options = codexModelOptions(capabilities);
  const observed = await readCodexRuntimeCache({ codexRuntimeCacheFile });
  const defaults = capabilities?.defaults ?? null;
  const controllable = Boolean(capabilities?.available) && options.length > 0;

  const modelInherited = selected.model === INHERIT;
  const effortInherited = selected.effort === INHERIT;
  // What is running: the server's own report; before any turn, only "inherit" has a known
  // answer (Codex's default); an explicit choice that has not run yet has none.
  const effectiveModel = observed?.model ?? (modelInherited ? defaults?.model ?? null : null);
  const effectiveEffort = observed?.effort ?? (effortInherited ? defaults?.reasoningEffort ?? null : null);

  // An existing thread keeps its last explicit settings; "inherit" re-applies the Codex
  // default only on a NEW thread. So reverting to inherit while the last run was explicit
  // and differs from the default needs a new thread — never "restart Murmur".
  // When the default itself is unknown the equality cannot be proven, so the conservative
  // (and possibly redundant) answer is "new session" — never a silent "nothing to do".
  const modelNeedsNewThread = modelInherited && Boolean(observed) && observed.selection.model !== INHERIT
    && (defaults?.model == null || observed.model !== defaults.model);
  const effortNeedsNewThread = effortInherited && Boolean(observed) && observed.selection.effort !== INHERIT
    && (defaults?.reasoningEffort == null || observed.effort == null || observed.effort !== defaults.reasoningEffort);
  const requiresNewThread = modelNeedsNewThread || effortNeedsNewThread;
  // An explicit choice that nothing has run under yet (no observation) is not "running":
  // it applies from the next turn, exactly like one that differs from what last ran.
  const modelPendingNextTurn = !modelInherited && effectiveModel !== selected.model;
  const effortPendingNextTurn = !effortInherited && effectiveEffort !== selected.effort;

  const modelView = (id) => {
    if (id === INHERIT) {
      const label = defaults?.model ? codexModelLabel(defaults.model, options) : null;
      return { id: INHERIT, kind: MODEL_KINDS.inherit, label: INHERIT_LABEL_RU, resolvesToLabel: label, selectable: true };
    }
    const option = findOption(options, id);
    return { id, kind: MODEL_KINDS.catalog, label: option?.label ?? id, resolvesToLabel: null, selectable: option?.selectable === true };
  };

  return {
    configState: loaded.state,
    configReason: loaded.state === "invalid" ? loaded.reason : null,
    controllable,
    reason: controllable ? null : CODEX_NOT_CONTROLLABLE_REASON,
    selected: { ...selected, view: modelView(selected.model) },
    effectiveModel,
    effectiveModelLabel: effectiveModel ? codexModelLabel(effectiveModel, options) : null,
    effectiveEffort,
    effectiveEffortLabel: effectiveEffort ? codexEffortLabel(effectiveEffort) : null,
    observed,
    defaults,
    source: !modelInherited || !effortInherited ? "murmur-project" : "codex-config",
    requiresNewThread,
    pendingNextTurn: modelPendingNextTurn || effortPendingNextTurn,
  };
};

/**
 * The effort choices the menu offers: low/medium/high the selected model takes, plus an
 * already-selected other level, plus "inherit" (same simple-GUI rule as Claude).
 */
export const codexEffortOptions = ({ capabilities, selectedModel, selectedEffort }) => {
  const supported = codexEffortsFor(selectedModel, capabilities);
  const wanted = ["low", "medium", "high"];
  if (selectedEffort && selectedEffort !== INHERIT && !wanted.includes(selectedEffort)) wanted.push(selectedEffort);
  return [...wanted.filter((level) => supported.includes(level)), INHERIT].map((id) => ({ id, label: codexEffortLabel(id) }));
};
