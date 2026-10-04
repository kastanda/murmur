/**
 * provider-availability.mjs — the ONE routing availability model.
 *
 *   available   authoritative subscription usage says quota remains (or a real turn just succeeded)
 *   degraded    authoritative usage is low (<= 10% but > 0 on a constraining window): warning only
 *   exhausted   authoritative usage reports 0% remaining on a constraining window, OR a provider
 *               returned a positively identified quota-exhaustion error
 *   unknown     no/stale/malformed/failed usage, or a provider exposing none (Cursor): ROUTABLE
 *
 * Murmur excludes an agent from NEW work ONLY on `exhausted`. Nothing here infers exhaustion
 * from staleness, missing data, context-window size, token or message counts, elapsed time, or a
 * low (but non-zero) percentage.
 *
 * Sources of truth (nothing else is stored):
 *   - the provider-usage snapshot cache (provider-usage.mjs) — percentages stay THERE;
 *   - a tiny durable observation file holding only error-derived exhaustion
 *     (`provider-availability.json`: provider, state, observedAt, source, resetsAt, category).
 *     Raw provider payloads, headers and account identifiers are never persisted.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { defaultCatalogCacheFile } from "./agent-models.mjs";
import { USAGE_KINDS, finalizeProviderUsage } from "./provider-usage.mjs";

export const AVAILABILITY = Object.freeze({
  available: "available",
  degraded: "degraded",
  exhausted: "exhausted",
  unknown: "unknown",
});

/** remaining <= this (and > 0) on a constraining window is DEGRADED (warning only). */
export const DEGRADED_REMAINING_PERCENT = 10;
/** An error-derived exhaustion with NO authoritative reset is re-checked after this, never held forever. */
export const NO_RESET_HOLD_MS = 30 * 60_000;
/** Spacing for re-evaluating a wait/hold that has no authoritative reset. */
export const NO_RESET_RECHECK_MS = 10 * 60_000;
/** Settling margin after an authoritative reset before the provider is re-read. */
export const RESET_SETTLE_MS = 5_000;

export const WAIT_REASONS = Object.freeze({
  waitingForProvider: "waiting_for_provider",
  blockedByProviderQuota: "blocked_by_provider_quota",
});
/** Mandatory-reviewer variants: the gate is never weakened, only reported truthfully. */
export const REVIEW_WAIT_STATES = Object.freeze({
  waitingForProviderReset: "WAITING_FOR_PROVIDER_RESET",
  blockedByProviderQuota: "BLOCKED_BY_PROVIDER_QUOTA",
});
export const PROVIDER_REASONS = Object.freeze({ quotaExhausted: "provider-quota-exhausted" });

export const ERROR_CATEGORIES = Object.freeze({
  quotaExhausted: "quota_exhausted",
  usageLimitReached: "usage_limit_reached",
  subscriptionLimitReached: "subscription_limit_reached",
  apiRateLimit: "api_rate_limit",
});

// ---------------------------------------------------------------------------
// Usage -> availability (pure)
// ---------------------------------------------------------------------------

/**
 * Only the account-level subscription windows constrain EXECUTION. Per-model scoped windows
 * (Claude `weekly:<model>`, Codex extra buckets) constrain a model/feature the routing layer
 * does not know is in use, so they never exclude the whole agent.
 */
const constrainsExecution = (w) => w.scope == null && (w.id === "session" || w.id === "weekly" || /^codex:(primary|secondary)$/.test(w.id));

const latestReset = (windows) => {
  let latest = null;
  for (const w of windows) {
    const ms = Date.parse(w.resetsAt);
    // A window with no authoritative reset makes the combined reset unknown.
    if (!Number.isFinite(ms)) return null;
    latest = latest === null ? ms : Math.max(latest, ms);
  }
  return latest === null ? null : new Date(latest).toISOString();
};

export const classifyUsageAvailability = (usage, { now = Date.now() } = {}) => {
  const base = { state: AVAILABILITY.unknown, reason: "usage-unavailable", resetsAt: null, windowId: null, pendingRefresh: false, apiRateLimit: false };
  if (!usage?.available) return { ...base, reason: usage?.reason ?? "usage-unavailable" };
  // A failed refresh (flagged by readProviderUsage) means the reading cannot be trusted as current.
  if (usage.stale === true || usage.refreshError) {
    return { ...base, reason: usage.refreshError ? "refresh-failed" : "stale", pendingRefresh: true };
  }
  const finalized = finalizeProviderUsage(usage, { now });
  if (finalized.kind === USAGE_KINDS.apiRateLimit) {
    // A short, resettable API limit — kept distinct, never labelled subscription exhaustion.
    return { ...base, reason: "api-rate-limit-not-account-quota", apiRateLimit: true };
  }
  if (finalized.kind !== USAGE_KINDS.subscription) return { ...base, reason: "not-subscription-usage" };
  if (finalized.stale) return { ...base, reason: "stale", pendingRefresh: true };
  const windows = finalized.windows.filter((w) => !w.expired && constrainsExecution(w));
  if (windows.length === 0) return { ...base, reason: "no-constraining-window" };
  const exhausted = windows.filter((w) => w.usedPercent >= 100 || w.remainingPercent <= 0);
  if (exhausted.length > 0) {
    return { ...base, state: AVAILABILITY.exhausted, reason: "usage-window-exhausted", resetsAt: latestReset(exhausted), windowId: exhausted[0].id };
  }
  const low = windows.filter((w) => w.remainingPercent <= DEGRADED_REMAINING_PERCENT);
  if (low.length > 0) {
    const tightest = low.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a));
    return { ...base, state: AVAILABILITY.degraded, reason: "usage-window-low", windowId: tightest.id };
  }
  return { ...base, state: AVAILABILITY.available, reason: "usage-ok" };
};

// ---------------------------------------------------------------------------
// Provider errors -> exhaustion evidence (pure; only positively identified shapes)
// ---------------------------------------------------------------------------

const SUBSCRIPTION_RATE_LIMIT_TYPES = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]);
const CODEX_QUOTA_CODES = new Set(["usagelimitexceeded", "usage_limit_exceeded", "usage_limit_reached"]);
const CURSOR_QUOTA_CODES = new Set(["quota_exceeded", "quota_exhausted", "usage_limit_exceeded", "usage_limit_reached"]);
// The CLI's own wording for a SUBSCRIPTION limit. Only trusted together with `is_error` + HTTP 429.
const CLAUDE_LIMIT_TEXT = /^\s*(?:claude(?: ai)? usage limit reached|you['’]ve hit your (?:[a-z0-9-]+ ){0,2}limit|you(?:['’]ve| have) reached your (?:[a-z0-9-]+ ){0,2}(?:usage )?limit)/i;
const API_RATE_CODES = new Set(["rate_limit_error", "rate_limit_exceeded", "overloaded_error", "tokens_per_minute", "requests_per_minute"]);

const epochToIso = (value) => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
};
const isoOrNull = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);

/**
 * @param {string} provider  claude | codex | cursor
 * @param {object} evidence  structured fields the runtime extracted: { status, code, text, isError,
 *                           rateLimitInfo: {status, rateLimitType, resetsAt}, resetsAt }
 * @returns {null | { exhausted: boolean, category: string, resetsAt: string|null, source: string }}
 *   `null` = not provider quota evidence at all (generic 429, timeout, network, auth, 5xx, …).
 */
export const classifyProviderError = (provider, evidence = {}) => {
  const code = typeof evidence.code === "string" ? evidence.code.toLowerCase() : "";
  const resetsAt = isoOrNull(evidence.resetsAt) ?? null;
  if (API_RATE_CODES.has(code)) return { exhausted: false, category: ERROR_CATEGORIES.apiRateLimit, resetsAt: null, source: `${provider}-error` };
  if (provider === "claude") {
    const info = evidence.rateLimitInfo;
    if (info && info.status === "rejected" && SUBSCRIPTION_RATE_LIMIT_TYPES.has(info.rateLimitType)) {
      return { exhausted: true, category: ERROR_CATEGORIES.subscriptionLimitReached, resetsAt: epochToIso(info.resetsAt) ?? resetsAt, source: "claude-rate-limit-event" };
    }
    if (evidence.isError === true && Number(evidence.status) === 429 && typeof evidence.text === "string" && CLAUDE_LIMIT_TEXT.test(evidence.text)) {
      // Older CLI wording carries the reset as `...limit reached|<epoch>`; nothing else is parsed out of the text.
      const tail = /\|(\d{9,13})\s*$/.exec(evidence.text.trim());
      return { exhausted: true, category: ERROR_CATEGORIES.usageLimitReached, resetsAt: tail ? epochToIso(tail[1]) : resetsAt, source: "claude-result-error" };
    }
    return null;
  }
  if (provider === "codex") {
    if (CODEX_QUOTA_CODES.has(code)) return { exhausted: true, category: ERROR_CATEGORIES.usageLimitReached, resetsAt, source: "codex-turn-error" };
    return null;
  }
  if (provider === "cursor") {
    if (CURSOR_QUOTA_CODES.has(code)) return { exhausted: true, category: ERROR_CATEGORIES.quotaExhausted, resetsAt, source: "cursor-rpc-error" };
    return null;
  }
  return null;
};

/** Pull provider evidence off a thrown runtime error (set by the runtime that saw the payload). */
export const evidenceFromError = (error) => {
  if (!error || typeof error !== "object") return null;
  if (error.providerEvidence && typeof error.providerEvidence === "object") return error.providerEvidence;
  // Cursor ACP: a structured JSON-RPC error. Only a STRING code in `data` is evidence; a numeric RPC code is not.
  const rpc = error.rpcError;
  if (rpc && typeof rpc === "object") {
    const code = [rpc.data?.code, rpc.data?.type, typeof rpc.code === "string" ? rpc.code : null].find((c) => typeof c === "string");
    if (code) return { code };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Durable observation file (error-derived exhaustion only; no raw payloads)
// ---------------------------------------------------------------------------

export const availabilityFile = (env = process.env, homedir = os.homedir()) => defaultCatalogCacheFile("provider-availability", env, homedir);

const KNOWN_PROVIDERS = ["claude", "codex", "cursor"];
/** One file PER provider: concurrent daemons observing different providers never overwrite each other. */
const providerRecordFile = (file, provider, identity = null) => file.replace(/\.json$/, `.${provider}${identity ? `.${createHash("sha256").update(identity).digest("hex").slice(0, 12)}` : ""}.json`);

const readRecord = (file, provider, identity = null) => {
  try {
    const raw = JSON.parse(readFileSync(providerRecordFile(file, provider, identity), "utf8"));
    return raw?.version === 1 && raw.record && typeof raw.record === "object" ? raw.record : null;
  } catch {
    return null;
  }
};

export const readAvailabilityRecords = (file, identities = {}) => {
  const out = {};
  for (const provider of KNOWN_PROVIDERS) {
    // An observation belongs to the provider executable it was seen on: it lives in its own file per
    // (provider, identity), so another project's/account's different binary neither inherits nor touches it.
    const record = readRecord(file, provider, identities[provider] ?? null);
    if (record) out[provider] = record;
  }
  return out;
};

const writeRecord = (file, provider, record, identity = null) => {
  const target = providerRecordFile(file, provider, identity);
  try {
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (record === null) { rmSync(target, { force: true }); return true; }
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, record }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
};

const sanitizeRecord = ({ observedAt, source, resetsAt, category, identity = null }) => ({
  state: AVAILABILITY.exhausted,
  observedAt: isoOrNull(observedAt) ?? new Date().toISOString(),
  source: String(source ?? "unknown").slice(0, 40),
  resetsAt: isoOrNull(resetsAt),
  category: String(category ?? ERROR_CATEGORIES.quotaExhausted).slice(0, 40),
  ...(typeof identity === "string" && identity ? { identity: identity.slice(0, 300) } : {}),
});

/**
 * Record an authoritative exhaustion. Returns `{ changed }`: a repeat of the same state with the
 * same reset is NOT a transition (no rewrite, so no repeated event/log).
 */
export const recordExhaustion = (file, provider, observation) => {
  const next = sanitizeRecord(observation);
  const previous = readRecord(file, provider, next.identity ?? null);
  const same = previous?.state === AVAILABILITY.exhausted && previous.resetsAt === next.resetsAt && previous.category === next.category;
  if (same) return { changed: false, record: previous };
  writeRecord(file, provider, next, next.identity ?? null);
  return { changed: true, record: next };
};

/** A real successful execution (or an authoritative refresh) proves availability. */
export const clearExhaustion = (file, provider, identity = null) => {
  if (!readRecord(file, provider, identity)) return { changed: false };
  writeRecord(file, provider, null, identity);
  return { changed: true };
};

// ---------------------------------------------------------------------------
// Effective availability
// ---------------------------------------------------------------------------

const recordExpired = (record, now) => {
  const reset = Date.parse(record.resetsAt);
  if (Number.isFinite(reset)) return now >= reset;
  const observed = Date.parse(record.observedAt);
  return !Number.isFinite(observed) || now - observed >= NO_RESET_HOLD_MS;
};

/**
 * The single resolution every consumer (routing, CLI, Menu Bar) uses.
 * @param usage  the cached provider usage snapshot (raw or finalized) or null
 * @param record the error-derived exhaustion observation or null
 */
export const resolveAvailability = ({ provider, usage = null, record = null, now = Date.now() }) => {
  const fromUsage = classifyUsageAvailability(usage, { now });
  const usageObserved = Date.parse(usage?.observedAt);
  const usageFresh = !fromUsage.pendingRefresh && (fromUsage.state === AVAILABILITY.available || fromUsage.state === AVAILABILITY.degraded);
  const recordActive = Boolean(record && record.state === AVAILABILITY.exhausted && !recordExpired(record, now));
  // An authoritative usage reading taken AFTER the error shows quota again: it wins.
  const superseded = Boolean(record) && usageFresh && Number.isFinite(usageObserved) && usageObserved > Date.parse(record.observedAt);
  const shape = (state, extra) => ({
    provider, availability: state, eligible: state !== AVAILABILITY.exhausted,
    reason: null, source: null, observedAt: null, resetsAt: null, pendingRefresh: false, apiRateLimit: fromUsage.apiRateLimit, ...extra,
  });
  if (recordActive && !superseded) {
    // Prefer the later authoritative reset when usage also reports exhaustion.
    const usageReset = fromUsage.state === AVAILABILITY.exhausted ? fromUsage.resetsAt : null;
    const resetsAt = [record.resetsAt, usageReset].filter(Boolean).sort().pop() ?? null;
    return shape(AVAILABILITY.exhausted, { reason: record.category, source: record.source, observedAt: record.observedAt, resetsAt });
  }
  if (fromUsage.state === AVAILABILITY.exhausted) {
    return shape(AVAILABILITY.exhausted, { reason: fromUsage.reason, source: usage?.source ?? "usage", observedAt: usage?.observedAt ?? null, resetsAt: fromUsage.resetsAt });
  }
  const expiredRecord = Boolean(record) && !recordActive;
  if (usageFresh) {
    return shape(fromUsage.state, { reason: fromUsage.reason, source: usage?.source ?? "usage", observedAt: usage?.observedAt ?? null });
  }
  // Nothing authoritative and current: UNKNOWN stays routable. A passed reset (or hold) asks for a refresh.
  return shape(AVAILABILITY.unknown, {
    reason: expiredRecord ? "reset-passed-pending-refresh" : fromUsage.reason,
    pendingRefresh: expiredRecord || fromUsage.pendingRefresh,
  });
};

/** When should a waiting item be re-evaluated? Authoritative reset (+settle), else a bounded recheck. */
export const nextCheckAt = (resolution, now = Date.now()) => {
  const reset = Date.parse(resolution?.resetsAt);
  return Number.isFinite(reset) ? Math.max(reset + RESET_SETTLE_MS, now + 1_000) : now + NO_RESET_RECHECK_MS;
};

export const waitReasonFor = (resolution) => (Number.isFinite(Date.parse(resolution?.resetsAt))
  ? WAIT_REASONS.waitingForProvider : WAIT_REASONS.blockedByProviderQuota);

export const reviewWaitStateFor = (resolution) => (Number.isFinite(Date.parse(resolution?.resetsAt))
  ? REVIEW_WAIT_STATES.waitingForProviderReset : REVIEW_WAIT_STATES.blockedByProviderQuota);

/** The structured routing result a refusal carries (also what the coordinator is shown). */
export const routingResult = (resolution, { mandatory = false } = {}) => ({
  eligible: resolution.eligible,
  availability: resolution.availability,
  provider: resolution.provider,
  ...(resolution.eligible ? {} : {
    reason: PROVIDER_REASONS.quotaExhausted,
    category: resolution.reason,
    resetsAt: resolution.resetsAt,
    waitReason: waitReasonFor(resolution),
    // The router NEVER invents a substitute. A mandatory (reviewer) route cannot be substituted at all.
    substitutionAllowed: !mandatory,
    mandatory,
    ...(mandatory ? { reviewState: reviewWaitStateFor(resolution) } : {}),
  }),
});

/** A provider name from a project agent id (`<projectId>-<name>`). */
export const providerOfAgent = (agentId, projectId) => {
  if (typeof agentId !== "string") return null;
  const prefix = projectId ? `${projectId}-` : "";
  const name = prefix && agentId.startsWith(prefix) ? agentId.slice(prefix.length) : null;
  return name && ["claude", "codex", "cursor"].includes(name) ? name : null;
};

/**
 * Synchronous reader over the two durable sources. `usageFile` is the usage snapshot cache; the
 * snapshot is ignored when it was read from a different provider executable than `identities[provider]`.
 */
export const createAvailabilityReader = ({ usageFile, recordFile, identities = {}, now = () => Date.now() }) => {
  const readUsage = (provider) => {
    try {
      const raw = JSON.parse(readFileSync(usageFile, "utf8"));
      const snap = raw?.version === 1 ? raw.providers?.[provider] : null;
      if (!snap) return null;
      const identity = identities[provider] ?? null;
      if (identity && snap.identity !== identity) return null;
      return snap;
    } catch {
      return null;
    }
  };
  return {
    resolve: (provider) => resolveAvailability({ provider, usage: readUsage(provider), record: readAvailabilityRecords(recordFile, identities)[provider] ?? null, now: now() }),
    recordFile,
  };
};
