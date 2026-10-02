/**
 * claude.mjs — operator surface for the per-project Claude model/effort preference.
 *
 *   murmur claude <project> config [--json]
 *   murmur claude <project> model <sonnet|opus|inherit>
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
  murmur claude <project> config [--json]
  murmur claude <project> model <sonnet|opus|inherit>
  murmur claude <project> effort <low|medium|high|xhigh|max|inherit>

"inherit" means Murmur passes no override at all: the installed Claude CLI's own
configuration decides, exactly as it did before this preference existed.

Only values the INSTALLED Claude CLI actually supports right now are accepted; run
\`murmur claude <project> config\` to see what was discovered. This never touches
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
  paths, project, discoverCapabilities = discoverClaudeCapabilities,
  // Injectable so tests never have to mutate the real $HOME to prove this path is never
  // written to — a global env mutation in a shared test process can corrupt whatever else
  // happens to be running concurrently in the same `node --test` invocation.
  settingsPath = claudeSettingsPath(),
} = {}) => {
  const capabilities = await discoverCapabilities();
  const resolved = await resolveClaudeConfig({
    paths,
    capabilities,
    claudeSettingsPath: settingsPath,
    readLiveClaudeBinding: project ? readLiveClaudeBindingFor(project) : undefined,
  });
  // A value -> Russian-label map for EVERY selectable option, so a client (the menu bar
  // app) never has to maintain its own copy of `modelLabel`/`effortLabel` and can never
  // drift from the one place those labels are decided.
  const modelLabels = Object.fromEntries([...capabilities.supportedModels, INHERIT].map((v) => [v, modelLabel(v)]));
  const effortLabels = Object.fromEntries([...capabilities.supportedEfforts, INHERIT].map((v) => [v, effortLabel(v)]));
  return {
    capabilities: {
      available: capabilities.available,
      modelSupported: capabilities.modelFlagSupported,
      effortSupported: capabilities.effortFlagSupported,
      supportedModels: capabilities.supportedModels,
      supportedEfforts: capabilities.supportedEfforts,
      modelLabels,
      effortLabels,
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
      // The THIRD, separate concept (Part A1): the canonical model id actually observed
      // on a completed real turn (e.g. "claude-sonnet-5"), never inferred from the alias.
      // `null` whenever no real turn has run yet under the currently effective alias —
      // `effectiveModelLabel` above already falls back to the bare alias label in that
      // case, so a client never has to branch on this field just to render correctly.
      canonicalModel: resolved.model.canonicalModel,
      effectiveEffort: resolved.effort.effective,
      effectiveEffortLabel: resolved.effort.effectiveLabel,
      source: resolved.model.source,
      effortSource: resolved.effort.source,
      pendingRestart: resolved.model.pendingRestart || resolved.effort.pendingRestart,
      configState: resolved.configState,
      ...(resolved.configReason ? { configReason: resolved.configReason } : {}),
    },
  };
};

const renderClaudeConfigHuman = (out, report, projectArg) => {
  out(`Project: ${projectArg}`);
  out("");
  out(`Claude model:   ${report.claude.modelLabel}${report.claude.model !== INHERIT ? ` (${report.claude.model})` : ""}`);
  out(`Claude effort:  ${report.claude.effortLabel}${report.claude.effort !== INHERIT ? ` (${report.claude.effort})` : ""}`);
  out(`Effective model:  ${report.claude.effectiveModelLabel ?? "unknown"}`);
  out(`Effective effort: ${report.claude.effectiveEffortLabel ?? "unknown"}`);
  out(`Source: ${report.claude.source}`);
  if (report.claude.pendingRestart) {
    out("");
    out("A Claude daemon is already running with a different model/effort than currently");
    out("selected. The change applies after Murmur is restarted for this project.");
  }
  if (report.claude.configState === "invalid") {
    out("");
    out(`WARNING: claude-preferences.json is invalid (${report.claude.configReason}); running without an override.`);
  }
  out("");
  out(`Supported models (installed CLI): ${report.capabilities.supportedModels.join(", ") || "(none discovered)"}`);
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
    const report = await buildClaudeConfigReport({ paths, project, discoverCapabilities, settingsPath });
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
    const capabilities = await discoverCapabilities();
    const isModel = subcommand === "model";
    const supported = isModel ? isSupportedModel(value, capabilities) : isSupportedEffort(value, capabilities);
    if (!supported) {
      const allowed = (isModel ? capabilities.supportedModels : capabilities.supportedEfforts);
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
    await writeClaudePreferences(paths, next);

    const label = isModel ? modelLabel(value) : effortLabel(value);
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
