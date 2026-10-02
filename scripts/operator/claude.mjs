/**
 * claude.mjs — operator surface for the per-project Claude model/effort preference.
 *
 *   murmur claude <project> config [--json]
 *   murmur claude <project> model <id|inherit>        (an id from `config --json` `models`)
 *   murmur claude <project> effort <low|medium|high|xhigh|max|inherit>
 *
 * This is the ONLY writer of `claude-preferences.json`: the menu bar app, and any other
 * future client, go through this exactly like every other Murmur lifecycle action — never
 * by editing the project's files directly. `config` is the single source of truth for
 * "what did the operator ask for" vs "what is actually running right now" vs "what would
 * run if Murmur were started now" (see `operator/claude-config.mjs`'s `resolveClaudeConfig`
 * for how those three are distinguished).
 */
import os from "node:os";
import path from "node:path";
import {
  INHERIT,
  claudeEffortApplies,
  claudeEffortOptions,
  claudeModelOptions,
  defaultClaudePreferencesFor,
  effortLabel,
  isSupportedEffort,
  isSupportedModel,
  loadClaudePreferences,
  modelLabel,
  resolveClaudeConfig,
  writeClaudePreferences,
} from "./claude-config.mjs";
import { discoverClaudeCapabilities } from "../claude-capabilities.mjs";
import { agentByName, loadProfile, profileExists } from "./profile.mjs";
import { locateProject, murmurHome } from "./project.mjs";
import { readAgentRuntimeState } from "./status.mjs";

export const CLAUDE_USAGE = `murmur claude — per-project Claude model/effort preference

Usage:
  murmur claude <project> config [--json] [--refresh]
  murmur claude <project> model <id|inherit>
  murmur claude <project> effort <low|medium|high|xhigh|max|inherit>

A model id is either a moving ALIAS ("sonnet" = "Актуальный Sonnet", whatever the CLI
currently resolves it to) or a PINNED concrete version ("claude-sonnet-5"). "inherit"
means Murmur passes no override at all: the installed Claude CLI's own configuration
decides, exactly as it did before this preference existed.

Only values the INSTALLED Claude CLI actually offers right now are accepted (its own
model catalog, read locally — never a web list); run \`murmur claude <project> config\`
to see them. --refresh re-reads the catalog instead of using the 6-hour cache. This never touches
~/.claude/settings.json or any other global Claude Code preference — it is scoped to
this one Murmur project.
`;

const readLiveClaudeBindingFor = (project) => {
  const claudeAgent = agentByName(project, "claude");
  if (!claudeAgent) return () => null;
  return (paths) => readAgentRuntimeState(paths.agentDbFile("claude"), claudeAgent.agentId);
};

/** `~/.claude/settings.json` — read-only, for display, never written. See module header. */
export const claudeSettingsPath = (homedir = os.homedir()) => path.join(homedir, ".claude", "settings.json");

/**
 * The assembled `claude` block of `murmur claude <project> config`'s JSON, and the data
 * every human-facing rendering below is built from.
 */
export const buildClaudeConfigReport = async ({
  paths, project, discoverCapabilities = discoverClaudeCapabilities, refresh = false,
  // Injectable so tests never have to mutate the real $HOME to prove this path is never
  // written to — a global env mutation in a shared test process can corrupt whatever else
  // happens to be running concurrently in the same `node --test` invocation.
  settingsPath = claudeSettingsPath(),
} = {}) => {
  const capabilities = await discoverCapabilities({ refresh });
  const resolved = await resolveClaudeConfig({
    paths,
    capabilities,
    claudeSettingsPath: settingsPath,
    readLiveClaudeBinding: project ? readLiveClaudeBindingFor(project) : undefined,
  });
  const options = claudeModelOptions(capabilities);
  // A value -> Russian-label map for EVERY selectable option, so a client never has to
  // maintain its own copy of a label.
  const modelLabels = Object.fromEntries([...options.filter((o) => o.selectable).map((o) => o.id), INHERIT].map((v) => [v, modelLabel(v, options)]));
  const effortLabels = Object.fromEntries([...capabilities.supportedEfforts, INHERIT].map((v) => [v, effortLabel(v)]));
  const inheritView = resolved.model.inheritView;
  const view = (v) => (v ? {
    id: v.id, kind: v.kind, label: v.label, canonicalId: v.canonicalId,
    resolvesToLabel: v.resolvesToLabel, effectiveLabel: v.effectiveLabel,
  } : null);
  // The picker, complete and ordered: aliases, then pinned versions, then inherit. Each
  // entry already carries its final label — Swift renders, it never parses a model id.
  const models = [
    ...options.map((o) => ({
      id: o.id, kind: o.kind, label: o.label, resolvesToLabel: o.resolvesToLabel ?? null,
      canonicalId: o.canonicalId ?? null, family: o.family ?? null, version: o.version ?? null,
      selectable: o.selectable === true, disabledReason: o.disabledReason ?? null,
    })),
    {
      id: INHERIT, kind: "inherit", label: modelLabel(INHERIT), canonicalId: null, family: null, version: null,
      resolvesToLabel: inheritView ? inheritView.resolvesToLabel : null, selectable: true, disabledReason: null,
    },
  ];
  return {
    capabilities: {
      available: capabilities.available,
      modelSupported: capabilities.modelFlagSupported,
      effortSupported: capabilities.effortFlagSupported,
      supportedModels: capabilities.supportedModels,
      supportedEfforts: capabilities.supportedEfforts,
      modelLabels,
      effortLabels,
      catalogSource: capabilities.catalogSource ?? null,
    },
    claude: {
      model: resolved.model.selected,
      modelLabel: resolved.model.selectedLabel,
      effort: resolved.effort.selected,
      effortLabel: resolved.effort.selectedLabel,
      runningModel: resolved.model.running,
      runningEffort: resolved.effort.running,
      effectiveModel: resolved.model.effective,
      effectiveModelLabel: resolved.model.effectiveLabel,
      // The canonical model id the effective selection runs as ("claude-sonnet-5-5") —
      // from a real completed turn when it correlates, else the CLI's own catalog
      // resolution; null when neither is known.
      canonicalModel: resolved.model.canonicalModel,
      effectiveEffort: resolved.effort.effective,
      effectiveEffortLabel: resolved.effort.effectiveLabel,
      source: resolved.model.source,
      effortSource: resolved.effort.source,
      pendingRestart: resolved.model.pendingRestart || resolved.effort.pendingRestart,
      configState: resolved.configState,
      ...(resolved.configReason ? { configReason: resolved.configReason } : {}),
      // Structured views (one resolver): what was SELECTED, what is RUNNING, the EFFECTIVE
      // one, and the complete option list + effort choices for the menu.
      selected: view(resolved.model.selectedView),
      running: view(resolved.model.runningView),
      effective: view(resolved.model.effectiveView),
      models,
      effortOptions: claudeEffortOptions({
        capabilities, selectedModel: resolved.model.selected, selectedEffort: resolved.effort.selected,
      }),
    },
  };
};

const renderClaudeConfigHuman = (out, report, projectArg) => {
  const { claude } = report;
  out(`Project: ${projectArg}`);
  out("");
  out(`Claude model:   ${claude.modelLabel}${claude.model !== INHERIT ? ` (${claude.model}, ${claude.selected?.kind})` : ""}`);
  out(`Claude effort:  ${claude.effortLabel}${claude.effort !== INHERIT ? ` (${claude.effort})` : ""}`);
  out(`Effective model:  ${claude.effectiveModelLabel ?? "unknown"}${claude.canonicalModel ? ` (${claude.canonicalModel})` : ""}`);
  out(`Effective effort: ${claude.effectiveEffortLabel ?? "unknown"}`);
  out(`Source: ${claude.source}`);
  if (claude.pendingRestart) {
    out("");
    out("A Claude daemon is already running with a different model/effort than currently");
    out("selected. The change applies after Murmur is restarted for this project.");
  }
  if (claude.configState === "invalid") {
    out("");
    out(`WARNING: claude-preferences.json is invalid (${claude.configReason}); running without an override.`);
  }
  out("");
  out(`Models (installed CLI, source: ${report.capabilities.catalogSource ?? "unknown"}):`);
  for (const option of claude.models) {
    const extra = option.kind === "alias" && option.resolvesToLabel ? ` -> ${option.resolvesToLabel}` : "";
    out(`  ${option.id === claude.model ? "*" : " "} ${option.id}  [${option.kind}]  ${option.label}${extra}${option.selectable ? "" : `  (unavailable: ${option.disabledReason ?? "n/a"})`}`);
  }
  out(`Supported effort levels (installed CLI): ${report.capabilities.supportedEfforts.join(", ") || "(none discovered)"}`);
};

export const commandClaude = async ({
  args, flags, out, err, env = process.env, home = undefined,
  discoverCapabilities = discoverClaudeCapabilities,
  settingsPath = undefined,
}) => {
  const projectArg = args[0];
  if (!projectArg) {
    err("murmur: claude requires <project>");
    err(CLAUDE_USAGE);
    return 1;
  }
  const subcommand = args[1];
  if (!subcommand || subcommand === "help") {
    out(CLAUDE_USAGE);
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
  if (!agentByName(project, "claude")) {
    err("murmur: this project has no Claude identity.");
    return 3;
  }

  if (subcommand === "config") {
    const report = await buildClaudeConfigReport({ paths, project, discoverCapabilities, settingsPath, refresh: Boolean(flags.refresh) });
    if (flags.json) {
      out(JSON.stringify({ project: path.basename(projectPath), ...report }, null, 2));
      return 0;
    }
    renderClaudeConfigHuman(out, report, projectArg);
    return 0;
  }

  if (subcommand === "model" || subcommand === "effort") {
    const value = args[2];
    if (!value) {
      err(`murmur: claude ${subcommand} requires a value`);
      err(CLAUDE_USAGE);
      return 1;
    }
    const capabilities = await discoverCapabilities({ refresh: Boolean(flags.refresh) });
    const isModel = subcommand === "model";
    const supported = isModel ? isSupportedModel(value, capabilities) : isSupportedEffort(value, capabilities);
    if (!supported) {
      const allowed = isModel
        ? claudeModelOptions(capabilities).filter((o) => o.selectable).map((o) => o.id)
        : capabilities.supportedEfforts;
      err(`murmur: '${value}' is not supported by the installed Claude CLI.`);
      err(`Supported: ${[...allowed, INHERIT].join(", ")}`);
      return 1;
    }

    const loaded = await loadClaudePreferences(paths);
    if (loaded.state === "invalid") {
      err(`murmur: claude-preferences.json is invalid (${loaded.reason}) — refusing to write over it.`);
      err("Fix or remove the file by hand, then retry.");
      return 1;
    }
    const current = loaded.state === "configured"
      ? loaded.preferences
      : defaultClaudePreferencesFor(capabilities);
    const next = isModel ? { ...current, model: value } : { ...current, effort: value };
    // A concrete model can lack an effort level (an older Opus has no "xhigh"; Haiku takes
    // none): refuse the combination rather than store something the runtime will drop.
    if (!claudeEffortApplies(next.model, next.effort, capabilities)) {
      err(`murmur: the model '${next.model}' does not support effort '${next.effort}'.`);
      err("Change the effort first (low/medium/high), or choose another model.");
      return 1;
    }
    await writeClaudePreferences(paths, next);

    const label = isModel ? modelLabel(value, claudeModelOptions(capabilities)) : effortLabel(value);
    out(`Claude ${subcommand} set to ${label}${value !== INHERIT ? ` (${value})` : ""}.`);

    const report = await buildClaudeConfigReport({ paths, project, discoverCapabilities, settingsPath });
    if (report.claude.pendingRestart) {
      out("A Claude daemon is already running with a different value. The change applies");
      out("after Murmur is restarted for this project.");
    }
    return 0;
  }

  err(`murmur: unknown claude subcommand '${subcommand}'`);
  err(CLAUDE_USAGE);
  return 1;
};
