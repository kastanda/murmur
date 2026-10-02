/**
 * provider-usage.mjs — what each provider REALLY says about the account's usage.
 *
 * Evidence (installed tools, 2026-10; see docs/usage-observability.md):
 *
 *   Claude  `claude -p --input-format stream-json` + the SDK control request `get_usage`
 *           (the same data as the CLI's own `/usage`): `rate_limits.limits[]` — the
 *           5-hour SESSION window and the WEEKLY windows (all models, and per-model scopes),
 *           each with `percent` USED and an ISO `resets_at`. No model turn, ~1.2 s.
 *           Proven semantics: `claude -p "/usage"` prints "Current session: 23% used" for
 *           the same number the control response calls `percent`/`utilization`.
 *   Codex   App Server `account/rateLimits/read`: `primary`/`secondary` windows with
 *           `usedPercent`, `windowDurationMins`, `resetsAt` (epoch seconds), plus the plan.
 *           `account/read` says whether the login is a ChatGPT plan or an API key — which
 *           decides whether these windows are subscription usage or API rate limits.
 *   Cursor  Neither the CLI (`agent`) nor ACP exposes any usage/quota: not available.
 *
 * Every number is classified (`kind`) and kept in its own window. Spend/credits balances,
 * context-window and per-turn token figures are NOT quota and are never rendered as one.
 * Account identifiers and emails are dropped at the parser boundary.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { defaultCatalogCacheFile } from "./agent-models.mjs";
import { readPrivateJson, writePrivateJson } from "./secure-state.mjs";

export const USAGE_KINDS = Object.freeze({
  subscription: "subscription_usage",
  apiRateLimit: "api_rate_limit",
  spendBudget: "spend_budget",
  contextWindow: "context_window",
  turnTokens: "turn_tokens",
  unknown: "unknown",
});

/** A snapshot older than this is shown as stale ("Данные устарели"), never as current. */
export const USAGE_STALE_MS = 10 * 60 * 1000;
/** `murmur usage` re-reads a provider no more often than this unless `--refresh`. */
export const USAGE_TTL_MS = 2 * 60 * 1000;

const pct = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null);
const label = (minutes) => {
  if (!Number.isFinite(minutes)) return null;
  if (minutes === 300) return "5 часов";
  if (minutes === 10080) return "Неделя";
  if (minutes % 1440 === 0) return `${minutes / 1440} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
};
const windowOf = ({ id, name, usedPercent, resetsAt = null, windowMinutes = null, scope = null, severity = null }) => {
  const used = pct(usedPercent);
  if (used === null) return null;
  return {
    id, label: name, usedPercent: used, remainingPercent: Math.round((100 - used) * 100) / 100,
    resetsAt: Number.isFinite(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null,
    windowMinutes, scope, ...(severity ? { severity } : {}),
  };
};

/** Claude `get_usage` response -> provider usage. Pure; every missing field degrades to "less data". */
export const parseClaudeUsage = (response, { observedAt = new Date().toISOString() } = {}) => {
  const limits = response?.rate_limits;
  if (response?.rate_limits_available !== true || !limits || typeof limits !== "object") {
    return { available: false, reason: "rate-limits-unavailable" };
  }
  const windows = [];
  const fiveHour = limits.five_hour;
  const sevenDay = limits.seven_day;
  for (const entry of Array.isArray(limits.limits) ? limits.limits : []) {
    if (entry?.kind === "session") {
      windows.push(windowOf({
        id: "session", name: fiveHour ? "5 часов" : "Сессия", usedPercent: entry.percent, resetsAt: entry.resets_at,
        windowMinutes: fiveHour ? 300 : null, severity: entry.severity,
      }));
    } else if (entry?.kind === "weekly_all") {
      windows.push(windowOf({
        id: "weekly", name: "Неделя", usedPercent: entry.percent, resetsAt: entry.resets_at,
        windowMinutes: sevenDay ? 10080 : null, severity: entry.severity,
      }));
    } else if (entry?.kind === "weekly_scoped" && typeof entry?.scope?.model?.display_name === "string") {
      const model = entry.scope.model.display_name.slice(0, 40);
      windows.push(windowOf({
        id: `weekly:${model.toLowerCase()}`, name: `Неделя · ${model}`, usedPercent: entry.percent,
        resetsAt: entry.resets_at, windowMinutes: sevenDay ? 10080 : null, scope: model, severity: entry.severity,
      }));
    }
  }
  if (windows.filter(Boolean).length === 0) {
    // Older shape without `limits[]`: the two named windows.
    windows.push(
      fiveHour ? windowOf({ id: "session", name: "5 часов", usedPercent: fiveHour.utilization, resetsAt: fiveHour.resets_at, windowMinutes: 300 }) : null,
      sevenDay ? windowOf({ id: "weekly", name: "Неделя", usedPercent: sevenDay.utilization, resetsAt: sevenDay.resets_at, windowMinutes: 10080 }) : null,
    );
  }
  const good = windows.filter(Boolean);
  if (good.length === 0) return { available: false, reason: "no-usable-windows" };
  return {
    available: true,
    source: "claude-cli-get-usage",
    kind: USAGE_KINDS.subscription,
    plan: typeof response.subscription_type === "string" ? response.subscription_type.slice(0, 24) : null,
    observedAt,
    windows: good,
  };
};

/** Codex `account/rateLimits/read` (+ `account/read` login type) -> provider usage. Pure. */
export const parseCodexUsage = (rateLimits, account, { observedAt = new Date().toISOString() } = {}) => {
  const buckets = rateLimits?.rateLimitsByLimitId && typeof rateLimits.rateLimitsByLimitId === "object"
    ? Object.values(rateLimits.rateLimitsByLimitId)
    : (rateLimits?.rateLimits ? [rateLimits.rateLimits] : []);
  const windows = [];
  let plan = null;
  let reached = null;
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    plan = plan ?? (typeof bucket.planType === "string" ? bucket.planType : null);
    reached = reached ?? (typeof bucket.rateLimitReachedType === "string" ? bucket.rateLimitReachedType : null);
    const bucketName = typeof bucket.limitName === "string" && bucket.limitName ? bucket.limitName
      : (typeof bucket.limitId === "string" && bucket.limitId !== "codex" ? bucket.limitId : null);
    for (const [slot, raw] of [["primary", bucket.primary], ["secondary", bucket.secondary]]) {
      if (!raw || typeof raw !== "object") continue;
      const minutes = Number.isFinite(raw.windowDurationMins) ? raw.windowDurationMins : null;
      windows.push(windowOf({
        id: `${bucket.limitId ?? "codex"}:${slot}`,
        name: [label(minutes) ?? (slot === "primary" ? "Основное окно" : "Дополнительное окно"), bucketName].filter(Boolean).join(" · "),
        usedPercent: raw.usedPercent,
        // epoch SECONDS (verified: the live value is ~a week ahead as seconds, absurd as ms)
        resetsAt: Number.isFinite(raw.resetsAt) ? new Date(raw.resetsAt * 1000).toISOString() : null,
        windowMinutes: minutes,
      }));
    }
  }
  const good = windows.filter(Boolean);
  if (good.length === 0) return { available: false, reason: "no-usable-windows" };
  // ChatGPT-plan login => these are plan usage windows; an API-key login => API rate limits.
  const kind = account?.type === "chatgpt" ? USAGE_KINDS.subscription
    : account?.type === "apiKey" ? USAGE_KINDS.apiRateLimit : USAGE_KINDS.unknown;
  return {
    available: true,
    source: "codex-app-server-rate-limits",
    kind,
    plan,
    observedAt,
    ...(reached ? { limitReached: reached } : {}),
    windows: good,
  };
};

export const CURSOR_USAGE_UNAVAILABLE = Object.freeze({ available: false, reason: "not-exposed-by-runtime" });

/**
 * Derive display facts at READ time (never persisted): staleness, an already-passed reset,
 * ms until reset, and the most constraining window (clearly derived, not a replacement).
 */
export const finalizeProviderUsage = (usage, { now = Date.now() } = {}) => {
  if (!usage?.available) return usage ?? { available: false, reason: "unknown" };
  const observedMs = Date.parse(usage.observedAt);
  const ageStale = !Number.isFinite(observedMs) || now - observedMs > USAGE_STALE_MS;
  const windows = usage.windows.map((w) => {
    const resetMs = Date.parse(w.resetsAt);
    const expired = Number.isFinite(resetMs) && resetMs <= now;
    return { ...w, observedAt: usage.observedAt, resetsInMs: Number.isFinite(resetMs) ? Math.max(0, resetMs - now) : null, expired };
  });
  // A window whose reset has passed since it was observed describes a window that no longer
  // exists: the number is outdated, so the provider is stale rather than shown as current.
  const stale = ageStale || windows.some((w) => w.expired);
  const live = windows.filter((w) => !w.expired);
  const tightest = live.length ? live.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a)) : null;
  return {
    ...usage,
    stale,
    windows,
    minRemaining: tightest && !stale ? { windowId: tightest.id, remainingPercent: tightest.remainingPercent, derived: true } : null,
  };
};

/** Redacted, bounded diagnostic text — never a header, token or account id. */
export const safeUsageError = (error) => {
  const text = String(error?.message ?? error ?? "error").replace(/\s+/g, " ");
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<redacted>")           // emails
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<redacted>") // uuids / account ids
    .replace(/[A-Za-z0-9._-]{16,}/g, "<redacted>")                    // token-like runs
    .slice(0, 80);
};

// ---------------------------------------------------------------------------
// Probes (argv only, bounded; `spawnImpl` injectable so tests never run a provider)
// ---------------------------------------------------------------------------

export const probeClaudeUsage = ({ binary, timeoutMs = 20_000, cwd = os.tmpdir(), env = process.env, spawnImpl = spawn }) =>
  new Promise((resolve, reject) => {
    const child = spawnImpl(binary, [
      "-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--no-session-persistence",
    ], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const requestId = "murmur-usage";
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("claude-usage-timeout")), timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.once("close", () => finish(new Error("claude-usage-closed")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.type !== "control_response" || message.response?.request_id !== requestId) continue;
        if (message.response.subtype !== "success") { finish(new Error("claude-usage-unavailable")); return; }
        finish(null, message.response.response);
        return;
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "get_usage" } })}\n`);
  });

export const probeCodexUsage = ({ command, args = ["app-server", "--listen", "stdio://"], timeoutMs = 20_000, cwd = os.tmpdir(), env = process.env, spawnImpl = spawn }) =>
  new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    const pending = new Map();
    let nextId = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const waiter of pending.values()) waiter.reject(error || new Error("codex-usage-finished"));
      pending.clear();
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("codex-usage-timeout")), timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.once("close", () => finish(new Error("codex-usage-closed")));
    child.stdin.on("error", () => {});
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.id === undefined || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`codex-app-server-error:${message.error.message || "unknown"}`));
      else waiter.resolve(message.result);
    });
    const request = (method, params) => new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { resolve: res, reject: rej });
      child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
    (async () => {
      await request("initialize", { clientInfo: { name: "murmur-usage", title: "Murmur usage", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const rateLimits = await request("account/rateLimits/read");
      let account = null;
      try { account = (await request("account/read", { refreshToken: false }))?.account ?? null; } catch { account = null; }
      // Only the login TYPE leaves this function — never an email or account id.
      return { rateLimits, account: account ? { type: account.type } : null };
    })().then((value) => finish(null, value), (error) => finish(error));
  });

// ---------------------------------------------------------------------------
// Cache (public figures only, under the Murmur home — never inside a repository)
// ---------------------------------------------------------------------------

export const usageCacheFile = (env = process.env, homedir = os.homedir()) =>
  defaultCatalogCacheFile("provider-usage", env, homedir);

export const readUsageCache = async (file) => {
  try {
    const raw = await readPrivateJson(file);
    return raw?.version === 1 && raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  } catch {
    return {};
  }
};

export const writeUsageCache = async (file, providers) => {
  try { await writePrivateJson(file, { version: 1, providers }); } catch { /* cache only */ }
};

/**
 * Read each provider's usage: cached when fresh (TTL), otherwise one probe. A failed probe
 * keeps the previous snapshot (so it can be shown as STALE with its real `observedAt`) and
 * attaches only a redacted reason. `probes` are injectable async functions returning the
 * already-parsed provider object.
 */
export const readProviderUsage = async ({ probes, cacheFile, refresh = false, now = Date.now(), identities = {} }) => {
  const cached = await readUsageCache(cacheFile);
  const next = { ...cached };
  const result = {};
  for (const [name, probe] of Object.entries(probes)) {
    // A snapshot belongs to the provider binary it was read from: another project's different
    // Codex/Claude executable (possibly another account) never inherits it.
    const identity = identities[name] ?? null;
    const previous = identity && cached[name]?.identity !== identity ? undefined : cached[name];
    const fresh = previous?.available && Number.isFinite(Date.parse(previous.observedAt))
      && now - Date.parse(previous.observedAt) < USAGE_TTL_MS;
    if (fresh && !refresh) {
      result[name] = finalizeProviderUsage(previous, { now });
      continue;
    }
    try {
      const data = await probe();
      if (data?.available) next[name] = identity ? { ...data, identity } : data;
      result[name] = finalizeProviderUsage(data, { now });
    } catch (error) {
      result[name] = previous?.available
        ? { ...finalizeProviderUsage(previous, { now }), stale: true, refreshError: safeUsageError(error) }
        : { available: false, reason: "probe-failed", detail: safeUsageError(error) };
    }
  }
  await writeUsageCache(cacheFile, next);
  return result;
};
