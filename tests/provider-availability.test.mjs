/**
 * provider-availability.test.mjs — quota classification, stale/reset semantics, error classification,
 * the durable observation file and the CLI surfaces. Payloads are SYNTHETIC; no provider is contacted.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AVAILABILITY, NO_RESET_HOLD_MS, availabilityFile, classifyProviderError, classifyUsageAvailability,
  clearExhaustion, evidenceFromError, nextCheckAt, providerOfAgent, readAvailabilityRecords, recordExhaustion,
  resolveAvailability, reviewWaitStateFor, routingResult, waitReasonFor,
} from "../scripts/provider-availability.mjs";
import { parseCodexUsage, writeUsageCache } from "../scripts/provider-usage.mjs";
import { annotateAvailability, commandAvailability, commandUsage, coordinatorQuotaGate } from "../scripts/operator/usage.mjs";
import { makeWorld } from "./fixtures/work-world.mjs";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const inMin = (m) => iso(NOW + m * 60_000);

const win = (id, remaining, { resetMin = 120, scope = null } = {}) => ({
  id, label: id, usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: resetMin === null ? null : inMin(resetMin),
  windowMinutes: null, scope,
});
const usage = (windows, extra = {}) => ({
  available: true, source: "claude-cli-get-usage", kind: "subscription_usage", observedAt: iso(NOW - 60_000), windows, ...extra,
});
const state = (u, now = NOW) => classifyUsageAvailability(u, { now });

// ---------------------------------------------------------------------------
// State classification
// ---------------------------------------------------------------------------

test("50% remaining => AVAILABLE; 9% and 1% => DEGRADED (still routable); 0% => EXHAUSTED", () => {
  assert.equal(state(usage([win("session", 50)])).state, AVAILABILITY.available);
  assert.equal(state(usage([win("session", 10)])).state, AVAILABILITY.degraded);
  assert.equal(state(usage([win("session", 9)])).state, AVAILABILITY.degraded);
  assert.equal(state(usage([win("session", 1)])).state, AVAILABILITY.degraded);
  assert.equal(state(usage([win("session", 11)])).state, AVAILABILITY.available);
  const exhausted = state(usage([win("session", 0)]));
  assert.equal(exhausted.state, AVAILABILITY.exhausted);
  for (const s of [AVAILABILITY.available, AVAILABILITY.degraded, AVAILABILITY.unknown]) {
    const r = resolveAvailability({ provider: "codex", usage: s === AVAILABILITY.unknown ? null : usage([win("session", s === AVAILABILITY.degraded ? 3 : 60)]), now: NOW });
    assert.equal(r.eligible, true, `${s} must stay routable`);
  }
});

test("ANY constraining window exhausted => EXHAUSTED (weekly 0% with session 70%); the later reset binds", () => {
  const r = state(usage([win("session", 70, { resetMin: 30 }), win("weekly", 0, { resetMin: 3000 })]));
  assert.equal(r.state, AVAILABILITY.exhausted);
  assert.equal(r.windowId, "weekly");
  assert.equal(r.resetsAt, inMin(3000));
  const both = state(usage([win("session", 0, { resetMin: 30 }), win("weekly", 0, { resetMin: 3000 })]));
  assert.equal(both.resetsAt, inMin(3000), "every exhausted window must reset: the latest binds");
  const noReset = state(usage([win("session", 0, { resetMin: null }), win("weekly", 0, { resetMin: 3000 })]));
  assert.equal(noReset.resetsAt, null, "one exhausted window without a reset makes the combined reset unknown");
});

test("one low window with none exhausted => DEGRADED; all above threshold => AVAILABLE", () => {
  assert.equal(state(usage([win("session", 80), win("weekly", 7)])).state, AVAILABILITY.degraded);
  assert.equal(state(usage([win("session", 80), win("weekly", 30)])).state, AVAILABILITY.available);
});

test("per-model scoped windows and non-account Codex buckets never exclude the whole agent", () => {
  assert.equal(state(usage([win("session", 70), win("weekly:modelz", 0, { scope: "ModelZ" })])).state, AVAILABILITY.available);
  assert.equal(state(usage([win("codex:primary", 60), win("codex_other:primary", 0)])).state, AVAILABILITY.available);
  assert.equal(state(usage([win("codex:secondary", 0)])).state, AVAILABILITY.exhausted);
});

test("usage unavailable / malformed / no usable window => UNKNOWN and routable", () => {
  for (const u of [null, undefined, { available: false, reason: "not-exposed-by-runtime" }, { available: false, reason: "probe-failed" }]) {
    const r = resolveAvailability({ provider: "cursor", usage: u, now: NOW });
    assert.equal(r.availability, AVAILABILITY.unknown);
    assert.equal(r.eligible, true);
  }
  assert.equal(state(usage([])).state, AVAILABILITY.unknown);
});

test("a stale snapshot is UNKNOWN + refresh-required, even one that said 0%", () => {
  const stale = usage([win("session", 0)], { observedAt: iso(NOW - 30 * 60_000) });
  const r = resolveAvailability({ provider: "claude", usage: stale, now: NOW });
  assert.equal(r.availability, AVAILABILITY.unknown);
  assert.equal(r.pendingRefresh, true);
  assert.equal(r.eligible, true);
});

test("a failed refresh (flagged by readProviderUsage) is UNKNOWN, not the last number", () => {
  const r = resolveAvailability({ provider: "claude", usage: usage([win("session", 0)], { stale: true, refreshError: "boom" }), now: NOW });
  assert.equal(r.availability, AVAILABILITY.unknown);
  assert.equal(r.pendingRefresh, true);
});

test("a snapshot whose reset has PASSED no longer disables the agent (UNKNOWN / pending refresh)", () => {
  const old = usage([win("weekly", 0, { resetMin: 10 })], { observedAt: inMin(-1) });
  assert.equal(resolveAvailability({ provider: "codex", usage: old, now: NOW }).availability, AVAILABILITY.exhausted);
  const later = NOW + 11 * 60_000;
  const r = resolveAvailability({ provider: "codex", usage: old, now: later });
  assert.equal(r.availability, AVAILABILITY.unknown);
  assert.equal(r.pendingRefresh, true);
  assert.equal(r.eligible, true);
});

test("API rate limits stay distinct from subscription exhaustion", () => {
  const api = { ...usage([win("codex:primary", 0)]), kind: "api_rate_limit" };
  const r = resolveAvailability({ provider: "codex", usage: api, now: NOW });
  assert.equal(r.availability, AVAILABILITY.unknown);
  assert.equal(r.eligible, true);
  assert.equal(r.apiRateLimit, true);
  const parsed = parseCodexUsage({ rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 1, resetsAt: Math.floor(NOW / 1000) + 60 } } }, { type: "apiKey" }, { observedAt: iso(NOW) });
  assert.equal(resolveAvailability({ provider: "codex", usage: parsed, now: NOW }).availability, AVAILABILITY.unknown);
});

// ---------------------------------------------------------------------------
// Provider errors
// ---------------------------------------------------------------------------

test("structured provider quota errors classify EXHAUSTED; generic failures never do", () => {
  const codex = classifyProviderError("codex", { code: "usageLimitExceeded" });
  assert.equal(codex.exhausted, true);
  assert.equal(codex.category, "usage_limit_reached");
  const claude = classifyProviderError("claude", { isError: true, status: 429, text: "You've hit your limit · resets 3am" });
  assert.equal(claude.exhausted, true);
  const event = classifyProviderError("claude", { rateLimitInfo: { status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor(NOW / 1000) + 3600 } });
  assert.equal(event.exhausted, true);
  assert.equal(event.category, "subscription_limit_reached");
  assert.equal(event.resetsAt, iso(Math.floor(NOW / 1000) * 1000 + 3_600_000));
  const old = classifyProviderError("claude", { isError: true, status: 429, text: `Claude AI usage limit reached|${Math.floor(NOW / 1000) + 600}` });
  assert.equal(old.resetsAt, iso(Math.floor(NOW / 1000) * 1000 + 600_000));
  assert.equal(classifyProviderError("cursor", { code: "usage_limit_exceeded" }).exhausted, true);

  const notQuota = [
    ["claude", { isError: true, status: 429, text: "Rate limited, retry later" }],
    ["claude", { isError: true, status: 429, text: "overloaded" }],
    ["claude", { isError: true, status: 500, text: "You've hit your limit" }],         // not a 429
    ["claude", { isError: false, status: 429, text: "You've hit your limit" }],        // not an error result
    ["claude", { rateLimitInfo: { status: "allowed", rateLimitType: "five_hour" } }],
    ["claude", { rateLimitInfo: { status: "rejected", rateLimitType: "overage" }}],
    ["claude", { status: 401, text: "Invalid API key" }],
    ["codex", { code: "httpConnectionFailed" }],
    ["codex", { code: "serverOverloaded" }],
    ["codex", { status: 429 }],
    ["cursor", { status: 429 }],
    ["cursor", { code: "timeout" }],
    ["cursor", { text: "usage limit exceeded" }],                                       // prose alone is not structured
    ["codex", {}],
  ];
  for (const [provider, evidence] of notQuota) {
    assert.notEqual(classifyProviderError(provider, evidence)?.exhausted, true, `${provider} ${JSON.stringify(evidence)} must not be quota exhaustion`);
  }
  // A short RPM/TPM API limit is explicitly NOT account quota.
  const rpm = classifyProviderError("claude", { code: "rate_limit_error", isError: true, status: 429, text: "You've hit your limit" });
  assert.equal(rpm.exhausted, false);
  assert.equal(rpm.category, "api_rate_limit");
});

test("evidence is read from structured fields only (Cursor RPC string code; numeric RPC code is not evidence)", () => {
  assert.deepEqual(evidenceFromError(Object.assign(new Error("x"), { rpcError: { code: -32000, data: { code: "quota_exceeded" } } })), { code: "quota_exceeded" });
  assert.equal(evidenceFromError(Object.assign(new Error("x"), { rpcError: { code: -32000, message: "usage limit" } })), null);
  assert.equal(evidenceFromError(new Error("usage limit exceeded")), null);
});

// ---------------------------------------------------------------------------
// Durable observation + recovery
// ---------------------------------------------------------------------------

const tmpFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-avail-"));
  return { dir, file: path.join(dir, "provider-availability.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("an error-derived exhaustion persists no raw payload, is not a repeated transition, and expires at its reset", () => {
  const t = tmpFile();
  try {
    const first = recordExhaustion(t.file, "codex", { observedAt: iso(NOW), source: "codex-turn-error", resetsAt: inMin(60), category: "usage_limit_reached", rawBody: "Bearer sk-secret", email: "a@b.c" });
    assert.equal(first.changed, true);
    assert.equal(recordExhaustion(t.file, "codex", { observedAt: iso(NOW + 5), source: "codex-turn-error", resetsAt: inMin(60), category: "usage_limit_reached" }).changed, false, "same state/reset is not a new transition");
    const text = readFileSync(t.file.replace(/\.json$/, ".codex.json"), "utf8");
    assert.doesNotMatch(text, /secret|a@b\.c|Bearer|rawBody/);
    assert.deepEqual(Object.keys(readAvailabilityRecords(t.file).codex).sort(), ["category", "observedAt", "resetsAt", "source", "state"]);
    const rec = readAvailabilityRecords(t.file).codex;
    assert.equal(resolveAvailability({ provider: "codex", record: rec, now: NOW + 59 * 60_000 }).availability, AVAILABILITY.exhausted);
    const after = resolveAvailability({ provider: "codex", record: rec, now: NOW + 61 * 60_000 });
    assert.equal(after.availability, AVAILABILITY.unknown);
    assert.equal(after.pendingRefresh, true);
    assert.equal(after.reason, "reset-passed-pending-refresh");
  } finally { t.done(); }
});

test("an exhaustion WITHOUT a reset is held only for a bounded time, then re-checked (never forever)", () => {
  const rec = { state: "exhausted", observedAt: iso(NOW), source: "x", resetsAt: null, category: "quota_exhausted" };
  assert.equal(resolveAvailability({ provider: "cursor", record: rec, now: NOW + 5 * 60_000 }).availability, AVAILABILITY.exhausted);
  const after = resolveAvailability({ provider: "cursor", record: rec, now: NOW + NO_RESET_HOLD_MS + 1 });
  assert.equal(after.availability, AVAILABILITY.unknown);
  assert.equal(after.eligible, true);
});

test("automatic recovery: a LATER authoritative usage reading, or a successful turn (clear), makes the agent routable again", () => {
  const rec = { state: "exhausted", observedAt: iso(NOW), source: "codex-turn-error", resetsAt: inMin(600), category: "usage_limit_reached" };
  assert.equal(resolveAvailability({ provider: "codex", record: rec, now: NOW + 1000 }).eligible, false);
  const refreshed = usage([win("codex:primary", 60)], { observedAt: iso(NOW + 30_000) });
  const r = resolveAvailability({ provider: "codex", record: rec, usage: refreshed, now: NOW + 60_000 });
  assert.equal(r.availability, AVAILABILITY.available);
  assert.equal(r.eligible, true);
  // an OLDER reading does not override a newer error
  const older = usage([win("codex:primary", 60)], { observedAt: iso(NOW - 30_000) });
  assert.equal(resolveAvailability({ provider: "codex", record: rec, usage: older, now: NOW + 60_000 }).eligible, false);
  const t = tmpFile();
  try {
    recordExhaustion(t.file, "codex", { observedAt: iso(NOW), source: "s", resetsAt: inMin(60), category: "usage_limit_reached" });
    assert.equal(clearExhaustion(t.file, "codex").changed, true);
    assert.equal(clearExhaustion(t.file, "codex").changed, false);
    assert.deepEqual(readAvailabilityRecords(t.file), {});
  } finally { t.done(); }
});

test("routing result: a refusal is structured, names no substitute, and a mandatory route is never substitutable", () => {
  const exhausted = resolveAvailability({ provider: "codex", usage: usage([win("codex:primary", 0, { resetMin: 41 })]), now: NOW });
  const optional = routingResult(exhausted);
  assert.equal(optional.eligible, false);
  assert.equal(optional.reason, "provider-quota-exhausted");
  assert.equal(optional.waitReason, "waiting_for_provider");
  assert.equal(optional.substitutionAllowed, true, "the coordinator may choose; the router never does");
  assert.equal("substitute" in optional, false);
  const mandatory = routingResult(exhausted, { mandatory: true });
  assert.equal(mandatory.substitutionAllowed, false);
  assert.equal(mandatory.reviewState, "WAITING_FOR_PROVIDER_RESET");
  const noReset = resolveAvailability({ provider: "codex", usage: usage([win("codex:primary", 0, { resetMin: null })]), now: NOW });
  assert.equal(waitReasonFor(noReset), "blocked_by_provider_quota");
  assert.equal(reviewWaitStateFor(noReset), "BLOCKED_BY_PROVIDER_QUOTA");
  assert.equal(routingResult(resolveAvailability({ provider: "cursor", usage: null, now: NOW })).eligible, true);
  assert.equal(nextCheckAt(exhausted, NOW) > NOW + 41 * 60_000, true);
  assert.equal(nextCheckAt(noReset, NOW), NOW + 10 * 60_000);
});

test("providerOfAgent maps only the project's own agent ids", () => {
  assert.equal(providerOfAgent("proj-codex", "proj"), "codex");
  assert.equal(providerOfAgent("proj-root", "proj"), null);
  assert.equal(providerOfAgent("other-codex", "proj"), null);
});

// ---------------------------------------------------------------------------
// CLI surfaces
// ---------------------------------------------------------------------------

const world = async () => {
  const w = await makeWorld();
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-avail-cli-"));
  return { ...w, cache: path.join(dir, "usage.json"), record: path.join(dir, "avail.json"), dir, done: () => { rmSync(dir, { recursive: true, force: true }); w.cleanup(); } };
};
const run = async (fn, w, flags = {}, extra = {}) => {
  const lines = [];
  const code = await fn({ args: [w.projectPath], flags: { json: true, ...flags }, out: (l) => lines.push(l), err: () => {}, home: w.paths.home, probes: {}, now: NOW, cacheFile: w.cache, recordFile: w.record, ...extra });
  return { code, json: JSON.parse(lines.join("\n")) };
};

test("`murmur usage --json` carries availability + routing per provider; Cursor is UNKNOWN and eligible", async (t) => {
  const w = await world();
  try {
    await writeUsageCache(w.cache, {
      claude: usage([win("session", 64), win("weekly", 40)]),
      codex: parseCodexUsage({ rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 97, windowDurationMins: 10080, resetsAt: Math.floor(NOW / 1000) + 86400 } } } }, { type: "chatgpt" }, { observedAt: iso(NOW - 1000) }),
    });
    const { code, json } = await run(commandUsage, w, {}, { probes: { claude: async () => usage([win("session", 64), win("weekly", 40)], { observedAt: iso(NOW) }), codex: async () => { throw new Error("boom"); }, cursor: async () => ({ available: false, reason: "not-exposed-by-runtime" }) } });
    assert.equal(code, 0);
    assert.equal(json.providers.claude.availability, "available");
    assert.equal(json.providers.codex.availability, "degraded");
    assert.equal(json.providers.codex.routing.eligible, true);
    assert.equal(json.providers.cursor.availability, "unknown");
    assert.equal(json.providers.cursor.routing.eligible, true);
  } finally { w.done(); }
});

test("`murmur availability --json` is the compact routing view; an exhausted provider is excluded with its reset", async () => {
  const w = await world();
  try {
    const reset = Math.floor(NOW / 1000) + 41 * 60;
    const codexUsage = parseCodexUsage({ rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: reset } } } }, { type: "chatgpt" }, { observedAt: iso(NOW - 1000) });
    const { code, json } = await run(commandAvailability, w, {}, { probes: { codex: async () => codexUsage, cursor: async () => ({ available: false, reason: "not-exposed-by-runtime" }) } });
    assert.equal(code, 0);
    assert.equal(json.providers.codex.availability, "exhausted");
    assert.equal(json.providers.codex.eligible, false);
    assert.equal(json.providers.codex.waitReason, "waiting_for_provider");
    assert.equal(json.providers.codex.resetsAt, iso(reset * 1000));
    assert.equal(json.providers.cursor.eligible, true);
    assert.equal(JSON.stringify(json).includes("windows"), false, "the compact view carries no percentage snapshot");
  } finally { w.done(); }
});

test("annotateAvailability is a pure read: a newer authoritative reading supersedes an old error record without writing", async () => {
  const t = tmpFile();
  try {
    recordExhaustion(t.file, "claude", { observedAt: iso(NOW - 120_000), source: "s", resetsAt: inMin(600), category: "usage_limit_reached" });
    const { annotated } = annotateAvailability({ claude: usage([win("session", 70)], { observedAt: iso(NOW - 1000) }) }, { recordFile: t.file, now: NOW });
    assert.equal(annotated.claude.availability, "available");
    assert.equal(Object.keys(readAvailabilityRecords(t.file)).length, 1, "reads never mutate state");
  } finally { t.done(); }
});

test("coordinatorQuotaGate: exhausted refuses (no refresh needed when reset is still ahead), unknown/degraded stay routable", async () => {
  const w = await world();
  try {
    await writeUsageCache(w.cache, { claude: usage([win("session", 0, { resetMin: 90 })], { observedAt: iso(NOW - 1000) }) });
    let probed = 0;
    const probes = { claude: async () => { probed += 1; throw new Error("down"); } };
    const gate = await coordinatorQuotaGate({ project: w.project, provider: "claude", now: NOW, probes, cacheFile: w.cache, recordFile: w.record });
    assert.equal(gate.eligible, false);
    assert.equal(gate.resetsAt, inMin(90));
    await writeUsageCache(w.cache, { claude: usage([win("session", 4)], { observedAt: iso(NOW - 1000) }) });
    assert.equal((await coordinatorQuotaGate({ project: w.project, provider: "claude", now: NOW, probes, cacheFile: w.cache, recordFile: w.record })).eligible, true);
    await writeUsageCache(w.cache, {});
    assert.equal((await coordinatorQuotaGate({ project: w.project, provider: "claude", now: NOW, probes, cacheFile: w.cache, recordFile: w.record })).availability, "unknown");
    assert.ok(probed >= 1);
  } finally { w.done(); }
});
