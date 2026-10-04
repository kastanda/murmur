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
  availabilityFile, readAvailabilityRecords, resolveAvailability, routingResult,
} from "../provider-availability.mjs";
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
Each provider also carries its routing \`availability\` (available | degraded | exhausted | unknown) and
\`routing.eligible\`: only an authoritatively exhausted provider is excluded from NEW work.
`;

export const AVAILABILITY_USAGE = `murmur availability — routing availability per provider

Usage:
  murmur availability <project> [--json] [--refresh]

The effective routing availability Murmur uses before creating a handoff: available, degraded
(<= 10% left, still routable), exhausted (authoritative; refused for NEW work until the reset) or
unknown (no/stale data, e.g. Cursor; routable). Same sources as \`murmur usage\`.
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

/**
 * Attach the routing availability to each provider's usage (same facts, one resolution function).
 * A pure read: it never writes. A newer authoritative reading supersedes an old error-derived
 * exhaustion in the RESOLUTION; the daemon retires the stale record when it next re-evaluates.
 */
export const annotateAvailability = (providers, { recordFile = availabilityFile(), now = Date.now(), identities = {} } = {}) => {
  const records = readAvailabilityRecords(recordFile, identities);
  const resolutions = {};
  const annotated = {};
  for (const [name, usage] of Object.entries(providers)) {
    const resolution = resolveAvailability({ provider: name, usage, record: records[name] ?? null, now });
    resolutions[name] = resolution;
    const routing = routingResult(resolution);
    annotated[name] = {
      ...usage,
      availability: resolution.availability,
      routing: {
        eligible: resolution.eligible,
        ...(resolution.reason ? { reason: resolution.reason } : {}),
        ...(resolution.source ? { source: resolution.source } : {}),
        ...(resolution.resetsAt ? { resetsAt: resolution.resetsAt } : {}),
        ...(resolution.pendingRefresh ? { pendingRefresh: true } : {}),
        ...(resolution.apiRateLimit ? { apiRateLimit: true } : {}),
        ...(resolution.eligible ? {} : { waitReason: routing.waitReason }),
      },
    };
  }
  return { annotated, resolutions };
};

export const commandUsage = async ({
  args, flags, out, err, env = process.env, home = undefined, probes = null, now = Date.now(),
  cacheFile = undefined, recordFile = undefined,
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
  const rawProviders = await readProviderUsage({
    probes: probes ?? defaultUsageProbes({ project, env }),
    identities: probes ? {} : usageIdentities({ project, env }),
    cacheFile: cacheFile ?? usageCacheFile(env, os.homedir()),
    refresh: Boolean(flags.refresh),
    now,
  });
  const { annotated: providers } = annotateAvailability(rawProviders, { recordFile: recordFile ?? availabilityFile(env, os.homedir()), now, identities: probes ? {} : usageIdentities({ project, env }) });
  const report = { project: path.basename(projectPath), observedAt: new Date(now).toISOString(), providers };
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  out(`Project: ${report.project}`);
  for (const [name, usage] of Object.entries(providers)) {
    const route = `[${usage.availability}${usage.routing?.eligible === false ? ", excluded from new work" : ""}${usage.routing?.resetsAt ? `, resets ${usage.routing.resetsAt}` : ""}]`;
    if (!usage.available) { out(`${name}: unavailable (${usage.reason ?? "unknown"}) ${route}`); continue; }
    out(`${name}: ${usage.kind}${usage.plan ? ` (${usage.plan})` : ""}${usage.stale ? "  [STALE]" : ""} ${route}`);
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

/** `murmur availability <project>`: just the routing view of the same facts. */
export const commandAvailability = async ({ args, flags, out, err, env = process.env, home = undefined, probes = null, now = Date.now(), cacheFile = undefined, recordFile = undefined }) => {
  const lines = [];
  const code = await commandUsage({
    args, flags: { ...flags, json: true }, out: (line) => lines.push(line), err, env, home, probes, now, cacheFile, recordFile,
  });
  let report;
  try { report = JSON.parse(lines.join("\n")); } catch { return code; }
  if (report.ok === false) {
    if (flags.json) out(JSON.stringify(report, null, 2)); else err(`murmur: ${report.reason}`);
    return code;
  }
  const providers = {};
  for (const [name, usage] of Object.entries(report.providers)) {
    providers[name] = { availability: usage.availability, ...usage.routing };
  }
  if (flags.json) { out(JSON.stringify({ project: report.project, observedAt: report.observedAt, providers }, null, 2)); return 0; }
  out(`Project: ${report.project}`);
  for (const [name, entry] of Object.entries(providers)) {
    out(`${name}: ${entry.availability}${entry.eligible ? "" : " — excluded from new work"}${entry.resetsAt ? `, resets ${entry.resetsAt}` : ""}${entry.pendingRefresh ? " (refresh pending)" : ""}`);
  }
  return 0;
};

/**
 * Pre-send check for a NEW root task: is the coordinator's provider authoritatively exhausted?
 * Reads the cached state; when it asks for a refresh (stale snapshot / passed reset) one best-effort
 * provider read is made. UNKNOWN stays routable — only an authoritative EXHAUSTED refuses.
 * Nothing is queued and no other agent is substituted for the coordinator.
 */
export const coordinatorQuotaGate = async ({
  project, provider, env = process.env, now = Date.now(), probes = null, cacheFile = undefined, recordFile = undefined,
}) => {
  const usageFile = cacheFile ?? usageCacheFile(env, os.homedir());
  const records = recordFile ?? availabilityFile(env, os.homedir());
  const identities = probes ? {} : usageIdentities({ project, env });
  const resolve = async () => {
    let cached = (await readUsageCache(usageFile))[provider] ?? null;
    if (cached && identities[provider] && cached.identity !== identities[provider]) cached = null;
    return resolveAvailability({ provider, usage: cached, record: readAvailabilityRecords(records, identities)[provider] ?? null, now });
  };
  let resolution = await resolve();
  if (resolution.pendingRefresh || resolution.availability === "exhausted") {
    const all = probes ?? defaultUsageProbes({ project, env });
    if (all[provider]) {
      try {
        await readProviderUsage({
          probes: { [provider]: all[provider] }, identities,
          cacheFile: usageFile, refresh: true, now,
        });
      } catch { /* a failed refresh leaves the state as it was */ }
      resolution = await resolve();
    }
  }
  return resolution;
};
