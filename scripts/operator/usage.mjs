/**
 * usage.mjs — `murmur usage <project> [--json] [--refresh]`
 *
 * Provider/account usage as the providers THEMSELVES report it (see provider-usage.mjs for
 * the exact sources). Subscription usage windows only; spend, context-window and per-turn
 * token figures are never presented as quota. Where a provider exposes nothing the answer
 * is `available:false` with a reason — never an estimate.
 *
 * Reads are cached (2 min) so a menu polling this does not hammer a provider; `--refresh`
 * re-reads now. A failed refresh keeps the last real snapshot and marks it stale.
 */
import os from "node:os";
import path from "node:path";
import { findClaudeExecutable } from "../claude-capabilities.mjs";
import {
  CURSOR_USAGE_UNAVAILABLE, finalizeProviderUsage, parseClaudeUsage, parseCodexUsage, probeClaudeUsage, probeCodexUsage,
  readProviderUsage, readUsageCache, usageCacheFile,
} from "../provider-usage.mjs";
import { discoverCodexExecutable } from "./codex.mjs";
import { enabledAgents, loadProfile, profileExists } from "./profile.mjs";
import { locateProject, murmurHome } from "./project.mjs";

export const USAGE_USAGE = `murmur usage — provider usage windows

Usage:
  murmur usage <project> [--json] [--refresh]

Subscription usage as reported by Claude (get_usage) and Codex (account/rateLimits/read).
Cursor exposes none. Cached for 2 minutes; --refresh re-reads. Never an estimate.
`;

/** The default probes: one parsed provider object each. Injectable for tests. */
export const defaultUsageProbes = ({ project, env = process.env }) => {
  const names = new Set(enabledAgents(project).map((agent) => agent.name));
  const probes = {};
  if (names.has("claude")) {
    probes.claude = async () => {
      const binary = findClaudeExecutable("claude", env);
      if (!binary) return { available: false, reason: "claude-not-installed" };
      return parseClaudeUsage(await probeClaudeUsage({ binary, env }));
    };
  }
  if (names.has("codex")) {
    probes.codex = async () => {
      const found = discoverCodexExecutable({ override: project.codexAppServer?.command ?? null, env });
      if (!found?.path) return { available: false, reason: "codex-not-installed" };
      const { rateLimits, account } = await probeCodexUsage({ command: found.path, env });
      return parseCodexUsage(rateLimits, account);
    };
  }
  if (names.has("cursor")) probes.cursor = async () => CURSOR_USAGE_UNAVAILABLE;
  return probes;
};

/** What each cached snapshot is keyed to: the provider executable it was read from. */
export const usageIdentities = ({ project, env = process.env }) => ({
  claude: findClaudeExecutable("claude", env),
  codex: discoverCodexExecutable({ override: project.codexAppServer?.command ?? null, env })?.path ?? null,
});

const remainingLine = (w) => {
  const reset = Number.isFinite(w.resetsInMs) ? `, resets in ${Math.round(w.resetsInMs / 60000)} min` : "";
  return `${w.label}: ${w.remainingPercent}% left${reset}`;
};

export const commandUsage = async ({
  args, flags, out, err, env = process.env, home = undefined, probes = null, now = Date.now(),
  cacheFile = undefined,
}) => {
  const projectArg = args[0];
  let paths, project, projectPath;
  try {
    ({ paths, projectPath } = locateProject(projectArg, { home: home ?? murmurHome(env) }));
    if (!(await profileExists(paths))) throw new Error("no-profile");
    project = await loadProfile(paths);
  } catch (error) {
    const reason = error?.message === "no-profile" ? "no-profile" : (error?.message || "error");
    if (flags.json) out(JSON.stringify({ ok: false, reason }, null, 2));
    else err(`murmur: ${reason === "no-profile" ? "no profile for this project. Run `murmur start <project>` first." : reason}`);
    return 3;
  }
  const providers = await readProviderUsage({
    probes: probes ?? defaultUsageProbes({ project, env }),
    identities: probes ? {} : usageIdentities({ project, env }),
    cacheFile: cacheFile ?? usageCacheFile(env, os.homedir()),
    refresh: Boolean(flags.refresh),
    now,
  });
  const report = { project: path.basename(projectPath), observedAt: new Date(now).toISOString(), providers };
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  out(`Project: ${report.project}`);
  for (const [name, usage] of Object.entries(providers)) {
    if (!usage.available) { out(`${name}: unavailable (${usage.reason ?? "unknown"})`); continue; }
    out(`${name}: ${usage.kind}${usage.plan ? ` (${usage.plan})` : ""}${usage.stale ? "  [STALE]" : ""}`);
    for (const w of usage.windows) out(`  ${remainingLine(w)}`);
  }
  return 0;
};

export const LOW_REMAINING_PERCENT = 10;
const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" };

/**
 * Passive low-limit lines from the CACHED snapshot only (fresh, non-stale, real windows).
 * Never refreshes, never blocks; an empty/unreadable cache yields no warning.
 */
export const lowLimitWarnings = async ({ cacheFile = usageCacheFile(), now = Date.now() } = {}) => {
  const cached = await readUsageCache(cacheFile);
  const lines = [];
  for (const [name, raw] of Object.entries(cached)) {
    const usage = finalizeProviderUsage(raw, { now });
    if (!usage.available || usage.stale || usage.kind !== "subscription_usage") continue;
    for (const w of usage.windows) {
      if (w.expired || w.remainingPercent >= LOW_REMAINING_PERCENT) continue;
      lines.push(`${PROVIDER_NAMES[name] ?? name}: осталось ${Math.round(w.remainingPercent)}% лимита (${w.label}). Задача может не завершиться до сброса.`);
    }
  }
  return lines;
};
