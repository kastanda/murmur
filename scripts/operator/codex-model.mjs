/**
 * codex-model.mjs — operator surface for the per-project Codex model/reasoning preference.
 *
 *   murmur codex <project> config [--json] [--refresh]
 *   murmur codex <project> model <id|inherit>
 *   murmur codex <project> effort <level|inherit>
 *
 * The ONLY writer of `codex-preferences.json`: the menu bar app goes through this exactly
 * like every other Murmur action and never edits the file. Everything is validated against
 * the installed Codex App Server's own `model/list`; nothing here touches ~/.codex.
 * (`operator/codex.mjs` is the unrelated executable-discovery module.)
 */
import path from "node:path";
import {
  INHERIT,
  codexEffortLabel,
  codexEffortOptions,
  codexEffortsFor,
  codexModelLabel,
  codexModelOptions,
  isSupportedCodexEffort,
  isSupportedCodexModel,
  loadCodexPreferences,
  resolveCodexConfig,
  writeCodexPreferences,
} from "./codex-config.mjs";
import { discoverCodexCapabilities } from "../codex-capabilities.mjs";
import { agentByName, loadProfile, profileExists } from "./profile.mjs";
import { locateProject, murmurHome } from "./project.mjs";

export const CODEX_USAGE = `murmur codex — per-project Codex model/reasoning-effort preference

Usage:
  murmur codex <project> config [--json] [--refresh]
  murmur codex <project> model <id|inherit>
  murmur codex <project> effort <low|medium|high|...|inherit>

"inherit" means Murmur passes no override: the Codex configuration decides, exactly as
before this preference existed. Models and effort levels come from the installed Codex
App Server's own catalog (\`model/list\`); run \`murmur codex <project> config\` to see
them. The choice is scoped to this Murmur project's Codex threads — it never edits
~/.codex/config.toml. A new choice applies from the next Codex turn; going back to
"inherit" applies to a new Codex session.
`;

export const buildCodexConfigReport = async ({
  paths, project, discoverCapabilities = discoverCodexCapabilities, refresh = false,
} = {}) => {
  const capabilities = await discoverCapabilities({ override: project?.codexAppServer?.command ?? null, refresh });
  const resolved = await resolveCodexConfig({ paths, capabilities });
  const options = codexModelOptions(capabilities);
  const availableModels = [
    ...options.map((o) => ({
      id: o.id, kind: o.kind, label: o.label, resolvesToLabel: null,
      selectable: o.selectable === true, disabledReason: o.disabledReason ?? null, isDefault: o.isDefault === true,
    })),
    {
      id: INHERIT, kind: "inherit", label: codexModelLabel(INHERIT), resolvesToLabel: resolved.selected.view.id === INHERIT
        ? resolved.selected.view.resolvesToLabel
        : (resolved.defaults?.model ? codexModelLabel(resolved.defaults.model, options) : null),
      selectable: true, disabledReason: null, isDefault: false,
    },
  ];
  return {
    codex: {
      controllable: resolved.controllable,
      reason: resolved.reason,
      selectedModel: resolved.selected.model,
      selectedModelLabel: resolved.selected.view.label,
      selected: resolved.selected.view,
      reasoningEffort: resolved.selected.effort,
      reasoningEffortLabel: codexEffortLabel(resolved.selected.effort),
      effectiveModel: resolved.effectiveModel,
      effectiveModelLabel: resolved.effectiveModelLabel,
      effectiveReasoningEffort: resolved.effectiveEffort,
      effectiveReasoningEffortLabel: resolved.effectiveEffortLabel,
      availableModels: resolved.controllable ? availableModels : [],
      effortOptions: resolved.controllable
        ? codexEffortOptions({ capabilities, selectedModel: resolved.selected.model, selectedEffort: resolved.selected.effort })
        : [],
      source: resolved.source,
      // Codex applies a choice per turn; nothing here ever needs a Murmur restart.
      pendingRestart: false,
      pendingNextTurn: resolved.pendingNextTurn,
      requiresNewThread: resolved.requiresNewThread,
      configState: resolved.configState,
      ...(resolved.configReason ? { configReason: resolved.configReason } : {}),
      catalogSource: capabilities.catalogSource ?? null,
      serverVersion: capabilities.serverVersion ?? null,
    },
  };
};

const renderCodexConfigHuman = (out, report, projectArg) => {
  const { codex } = report;
  out(`Project: ${projectArg}`);
  out("");
  out(`Codex model:    ${codex.selectedModelLabel}${codex.selectedModel !== INHERIT ? ` (${codex.selectedModel})` : ""}`);
  out(`Codex effort:   ${codex.reasoningEffortLabel}${codex.reasoningEffort !== INHERIT ? ` (${codex.reasoningEffort})` : ""}`);
  out(`Effective model:  ${codex.effectiveModelLabel ?? "unknown (no Codex turn yet)"}`);
  out(`Effective effort: ${codex.effectiveReasoningEffortLabel ?? "unknown"}`);
  out(`Source: ${codex.source}`);
  if (codex.requiresNewThread) {
    out("");
    out("Applies to a NEW Codex session: an existing thread keeps the settings it last used.");
  } else if (codex.pendingNextTurn) {
    out("");
    out("Applies from the next Codex turn (no restart needed).");
  }
  if (!codex.controllable) {
    out("");
    out("Model selection is unavailable: the Codex App Server's model catalog could not be read.");
  } else {
    out("");
    out(`Models (Codex App Server ${codex.serverVersion ?? ""}, source: ${codex.catalogSource ?? "unknown"}):`);
    for (const option of codex.availableModels) {
      out(`  ${option.id === codex.selectedModel ? "*" : " "} ${option.id}  ${option.label}`);
    }
  }
  if (codex.configState === "invalid") {
    out("");
    out(`WARNING: codex-preferences.json is invalid (${codex.configReason}); running without an override.`);
  }
};

export const commandCodex = async ({
  args, flags, out, err, env = process.env, home = undefined,
  discoverCapabilities = discoverCodexCapabilities,
}) => {
  const projectArg = args[0];
  if (!projectArg) {
    err("murmur: codex requires <project>");
    err(CODEX_USAGE);
    return 1;
  }
  const subcommand = args[1];
  if (!subcommand || subcommand === "help") {
    out(CODEX_USAGE);
    return subcommand ? 0 : 1;
  }

  let projectPath, paths;
  try {
    ({ projectPath, paths } = locateProject(projectArg, { home: home ?? murmurHome(env) }));
  } catch (error) {
    err(`murmur: ${error.message}`);
    return 1;
  }
  if (!(await profileExists(paths))) {
    err("murmur: no profile for this project. Run `murmur start <project>` first.");
    return 3;
  }
  const project = await loadProfile(paths);
  if (!agentByName(project, "codex")) {
    err("murmur: this project has no Codex identity.");
    return 3;
  }

  if (subcommand === "config") {
    const report = await buildCodexConfigReport({ paths, project, discoverCapabilities, refresh: Boolean(flags.refresh) });
    if (flags.json) {
      out(JSON.stringify({ project: path.basename(projectPath), ...report }, null, 2));
      return 0;
    }
    renderCodexConfigHuman(out, report, projectArg);
    return 0;
  }

  if (subcommand === "model" || subcommand === "effort") {
    const value = args[2];
    if (!value) {
      err(`murmur: codex ${subcommand} requires a value`);
      err(CODEX_USAGE);
      return 1;
    }
    const capabilities = await discoverCapabilities({ override: project.codexAppServer?.command ?? null, refresh: Boolean(flags.refresh) });
    if (value !== INHERIT && !capabilities.available) {
      err("murmur: the Codex App Server's model catalog could not be read, so no explicit choice can be validated.");
      err("Only 'inherit' is accepted until Codex is reachable.");
      return 1;
    }
    const loaded = await loadCodexPreferences(paths);
    if (loaded.state === "invalid") {
      err(`murmur: codex-preferences.json is invalid (${loaded.reason}) — refusing to write over it.`);
      err("Fix or remove the file by hand, then retry.");
      return 1;
    }
    const current = loaded.state === "configured" ? loaded.preferences : { version: 1, model: INHERIT, effort: INHERIT };
    const isModel = subcommand === "model";
    const next = isModel ? { ...current, model: value } : { ...current, effort: value };

    if (isModel ? !isSupportedCodexModel(value, capabilities) : !isSupportedCodexEffort(value, capabilities, next.model)) {
      const allowed = isModel
        ? codexModelOptions(capabilities).filter((o) => o.selectable).map((o) => o.id)
        : codexEffortsFor(next.model, capabilities);
      err(`murmur: '${value}' is not supported by the installed Codex App Server${isModel ? "" : ` for model '${next.model}'`}.`);
      err(`Supported: ${[...allowed, INHERIT].join(", ")}`);
      return 1;
    }
    if (isModel && !isSupportedCodexEffort(next.effort, capabilities, next.model)) {
      err(`murmur: the model '${value}' does not support the current effort '${next.effort}'.`);
      err("Set the effort first (murmur codex <project> effort <level>), then choose this model.");
      return 1;
    }
    await writeCodexPreferences(paths, next);

    const options = codexModelOptions(capabilities);
    out(`Codex ${subcommand} set to ${isModel ? codexModelLabel(value, options) : codexEffortLabel(value)}${value !== INHERIT ? ` (${value})` : ""}.`);
    const report = await buildCodexConfigReport({ paths, project, discoverCapabilities });
    if (report.codex.requiresNewThread) out("Applies to a new Codex session (an existing thread keeps its last settings).");
    else out("Applies from the next Codex turn; no restart needed.");
    return 0;
  }

  err(`murmur: unknown codex subcommand '${subcommand}'`);
  err(CODEX_USAGE);
  return 1;
};
