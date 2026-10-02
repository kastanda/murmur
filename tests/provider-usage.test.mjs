/**
 * provider-usage.test.mjs — provider/account usage parsing, classification, staleness,
 * caching and the `murmur usage` command. Payloads are SYNTHETIC shapes modelled on the
 * installed tools' real responses (see docs/usage-observability.md); no live provider, no
 * real account figures, no real identifiers.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CURSOR_USAGE_UNAVAILABLE, USAGE_STALE_MS, USAGE_TTL_MS, finalizeProviderUsage, parseClaudeUsage, parseCodexUsage,
  probeClaudeUsage, probeCodexUsage, readProviderUsage, readUsageCache, safeUsageError, writeUsageCache,
} from "../scripts/provider-usage.mjs";
import { commandUsage, lowLimitWarnings } from "../scripts/operator/usage.mjs";
import { makeWorld } from "./fixtures/work-world.mjs";

const OBSERVED = "2026-10-03T12:00:00.000Z";
const NOW = Date.parse(OBSERVED);
const inMinutes = (m) => new Date(NOW + m * 60_000).toISOString();

const claudeResponse = (overrides = {}) => ({
  subscription_type: "pro",
  rate_limits_available: true,
  session: { total_cost_usd: 4.2, model_usage: { "claude-x": { inputTokens: 999999 } } },
  rate_limits: {
    five_hour: { utilization: 36, resets_at: inMinutes(138) },
    seven_day: { utilization: 62, resets_at: inMinutes(60 * 24 * 3) },
    extra_usage: { is_enabled: true, used_credits: 12, monthly_limit: 50, utilization: 24 },
    spend: { used: { amount_minor: 1234, currency: "USD" }, percent: 99 },
    limits: [
      { kind: "session", group: "session", percent: 36, severity: "normal", resets_at: inMinutes(138) },
      { kind: "weekly_all", group: "weekly", percent: 62, severity: "normal", resets_at: inMinutes(60 * 24 * 3) },
      { kind: "weekly_scoped", group: "weekly", percent: 5, severity: "normal", resets_at: inMinutes(60 * 24 * 3), scope: { model: { id: null, display_name: "ModelZ" } } },
    ],
    ...overrides,
  },
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test("Claude: the 5-hour and weekly windows are separate; USED percent becomes remaining; reset times kept", () => {
  const usage = parseClaudeUsage(claudeResponse(), { observedAt: OBSERVED });
  assert.equal(usage.available, true);
  assert.equal(usage.kind, "subscription_usage");
  assert.equal(usage.source, "claude-cli-get-usage");
  assert.deepEqual(usage.windows.map((w) => [w.id, w.label, w.usedPercent, w.remainingPercent, w.windowMinutes]), [
    ["session", "5 часов", 36, 64, 300],
    ["weekly", "Неделя", 62, 38, 10080],
    ["weekly:modelz", "Неделя · ModelZ", 5, 95, 10080],
  ]);
  assert.equal(usage.windows[0].resetsAt, inMinutes(138));
  assert.equal(usage.plan, "pro");
});

test("Claude: spend, credits, per-turn tokens and cost are NOT quota and never become windows", () => {
  const usage = parseClaudeUsage(claudeResponse(), { observedAt: OBSERVED });
  const text = JSON.stringify(usage);
  assert.doesNotMatch(text, /extra_usage|used_credits|amount_minor|inputTokens|total_cost|model_usage|1234/);
  assert.equal(usage.windows.length, 3);
  // only context/turn/spend data present => unavailable, never a fabricated percentage
  assert.deepEqual(parseClaudeUsage({ rate_limits_available: false, session: { model_usage: { a: { outputTokens: 5 } } } }), { available: false, reason: "rate-limits-unavailable" });
  assert.equal(parseClaudeUsage({ rate_limits_available: true, rate_limits: { extra_usage: { utilization: 80 }, spend: { percent: 80 } } }).available, false);
});

test("Claude: zero remaining, missing reset, out-of-range and non-numeric percents, malformed input", () => {
  const empty = parseClaudeUsage(claudeResponse({ limits: [{ kind: "session", percent: 100, resets_at: null }], five_hour: { utilization: 100 }, seven_day: null }), { observedAt: OBSERVED });
  assert.equal(empty.windows[0].remainingPercent, 0);
  assert.equal(empty.windows[0].resetsAt, null, "an unknown reset is omitted, never invented");
  for (const bad of [150, -3, "50", null, NaN]) {
    const usage = parseClaudeUsage({ rate_limits_available: true, rate_limits: { limits: [{ kind: "session", percent: bad, resets_at: inMinutes(5) }] } });
    assert.equal(usage.available, false, String(bad));
  }
  for (const garbage of [null, undefined, 5, "x", {}, { rate_limits_available: true }, { rate_limits_available: true, rate_limits: "x" }]) {
    assert.doesNotThrow(() => parseClaudeUsage(garbage));
    assert.equal(parseClaudeUsage(garbage).available, false);
  }
});

test("Claude: the older shape without limits[] still yields the two named windows", () => {
  const usage = parseClaudeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10, resets_at: inMinutes(60) }, seven_day: { utilization: 20, resets_at: inMinutes(600) },
  } }, { observedAt: OBSERVED });
  assert.deepEqual(usage.windows.map((w) => [w.id, w.remainingPercent]), [["session", 90], ["weekly", 80]]);
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const codexLimits = (extra = {}) => ({
  accountId: "acct-should-never-appear",
  rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor((NOW + 43 * 60_000) / 1000) },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor((NOW + 3 * 86_400_000) / 1000) },
    credits: { hasCredits: true, unlimited: false, balance: "12.34" }, rateLimitReachedType: null },
  rateLimitsByLimitId: { codex: { limitId: "codex", limitName: null, planType: "pro",
    primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor((NOW + 43 * 60_000) / 1000) },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor((NOW + 3 * 86_400_000) / 1000) },
    credits: { hasCredits: true, unlimited: false, balance: "12.34" } } },
  ...extra,
});

test("Codex: ChatGPT-plan windows are subscription usage; each window stays separate; epoch SECONDS become a date", () => {
  const usage = parseCodexUsage(codexLimits(), { type: "chatgpt" }, { observedAt: OBSERVED });
  assert.equal(usage.kind, "subscription_usage");
  assert.deepEqual(usage.windows.map((w) => [w.label, w.remainingPercent, w.windowMinutes]), [["5 часов", 82, 300], ["Неделя", 60, 10080]]);
  assert.equal(usage.windows[0].resetsAt, inMinutes(43));
  assert.equal(usage.plan, "pro");
});

test("Codex: an API-key login's limits are API rate limits, an unknown login is unknown — never 'account quota'", () => {
  assert.equal(parseCodexUsage(codexLimits(), { type: "apiKey" }).kind, "api_rate_limit");
  assert.equal(parseCodexUsage(codexLimits(), null).kind, "unknown");
});

test("Codex: credits, balances and account ids are dropped at the parser boundary", () => {
  const text = JSON.stringify(parseCodexUsage(codexLimits(), { type: "chatgpt", email: "someone@example.invalid" }));
  assert.doesNotMatch(text, /acct-should-never-appear|12\.34|balance|credits|example\.invalid|email/);
});

test("Codex: multiple buckets, a reached limit, missing windows and malformed data", () => {
  const multi = parseCodexUsage({ rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(NOW / 1000) + 600 }, rateLimitReachedType: "rate_limit_reached" },
    spark: { limitId: "spark", limitName: "Spark", primary: { usedPercent: 3, windowDurationMins: 60 }, secondary: null },
  } }, { type: "chatgpt" }, { observedAt: OBSERVED });
  assert.equal(multi.limitReached, "rate_limit_reached");
  assert.deepEqual(multi.windows.map((w) => [w.id, w.label, w.remainingPercent]), [["codex:primary", "5 часов", 0], ["spark:primary", "1 ч · Spark", 97]]);
  assert.equal(multi.windows[1].resetsAt, null);
  for (const garbage of [null, {}, { rateLimits: {} }, { rateLimits: { primary: { usedPercent: "x" } } }, { rateLimitsByLimitId: "x" }]) {
    assert.equal(parseCodexUsage(garbage, { type: "chatgpt" }).available, false);
  }
});

// ---------------------------------------------------------------------------
// Cursor, staleness, derived summary
// ---------------------------------------------------------------------------

test("Cursor exposes nothing: unavailable with a stable reason, not an estimate", () => {
  assert.deepEqual(CURSOR_USAGE_UNAVAILABLE, { available: false, reason: "not-exposed-by-runtime" });
});

test("staleness: an old snapshot, or a window whose reset already passed, is stale — never shown as current", () => {
  const usage = parseClaudeUsage(claudeResponse(), { observedAt: OBSERVED });
  assert.equal(finalizeProviderUsage(usage, { now: NOW + 1_000 }).stale, false);
  assert.equal(finalizeProviderUsage(usage, { now: NOW + USAGE_STALE_MS + 1_000 }).stale, true);
  const passed = finalizeProviderUsage(usage, { now: NOW + 139 * 60_000 });
  assert.equal(passed.stale, true, "the 5-hour window reset since it was observed");
  assert.equal(passed.windows[0].expired, true);
  assert.equal(passed.minRemaining, null, "no derived summary from stale data");
});

test("the derived summary names the most constraining window and is flagged derived; all windows remain", () => {
  const usage = finalizeProviderUsage(parseClaudeUsage(claudeResponse(), { observedAt: OBSERVED }), { now: NOW });
  assert.deepEqual(usage.minRemaining, { windowId: "weekly", remainingPercent: 38, derived: true });
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0].resetsInMs, 138 * 60_000);
});

test("diagnostics are redacted and bounded", () => {
  const text = safeUsageError(new Error(`failed with token ${"A".repeat(60)} and more text ${"b".repeat(200)}`));
  assert.ok(text.length <= 80);
  assert.doesNotMatch(text, /A{24}/);
});

// ---------------------------------------------------------------------------
// Probes (fake processes)
// ---------------------------------------------------------------------------

const fakeProcess = (onLine) => (binary, args) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      onLine(message, (payload) => child.stdout.write(`${JSON.stringify(payload)}\n`), { binary, args });
    }
  });
  return child;
};

test("the Claude probe sends only get_usage (no user message) and returns the response", async () => {
  const seen = [];
  const spawnImpl = fakeProcess((message, reply) => {
    seen.push(message.request?.subtype);
    reply({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: claudeResponse() } });
  });
  const response = await probeClaudeUsage({ binary: "/fake/claude", spawnImpl, timeoutMs: 2000 });
  assert.deepEqual(seen, ["get_usage"]);
  assert.equal(response.rate_limits_available, true);
});

test("the Codex probe asks rateLimits/read and account/read only, and only the login TYPE leaves it", async () => {
  const methods = [];
  const spawnImpl = fakeProcess((message, reply) => {
    if (message.method) methods.push(message.method);
    if (message.id === undefined) return;
    if (message.method === "initialize") reply({ id: message.id, result: {} });
    else if (message.method === "account/rateLimits/read") reply({ id: message.id, result: codexLimits() });
    else if (message.method === "account/read") reply({ id: message.id, result: { account: { type: "chatgpt", email: "someone@example.invalid", planType: "pro" } } });
  });
  const result = await probeCodexUsage({ command: "/fake/codex", spawnImpl, timeoutMs: 2000 });
  assert.deepEqual(methods, ["initialize", "initialized", "account/rateLimits/read", "account/read"]);
  assert.deepEqual(result.account, { type: "chatgpt" });
  assert.equal(methods.includes("turn/start") || methods.includes("thread/start"), false, "no model turn");
});

// ---------------------------------------------------------------------------
// Cache / cadence / CLI
// ---------------------------------------------------------------------------

const tmpCache = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-usage-"));
  return { dir, file: path.join(dir, "usage.json") };
};

test("reads are cached for the TTL; --refresh re-reads; a failed refresh keeps the last snapshot as STALE with a redacted reason", async () => {
  const { dir, file } = tmpCache();
  try {
    let calls = 0;
    const good = async () => { calls += 1; return parseClaudeUsage(claudeResponse(), { observedAt: new Date(NOW).toISOString() }); };
    const first = await readProviderUsage({ probes: { claude: good }, cacheFile: file, now: NOW });
    assert.equal(first.claude.stale, false);
    await readProviderUsage({ probes: { claude: good }, cacheFile: file, now: NOW + USAGE_TTL_MS - 1_000 });
    assert.equal(calls, 1, "within the TTL: no provider call");
    await readProviderUsage({ probes: { claude: good }, cacheFile: file, now: NOW + 5_000, refresh: true });
    assert.equal(calls, 2);
    const failing = async () => { throw new Error(`boom ${"Z".repeat(50)}`); };
    const later = await readProviderUsage({ probes: { claude: failing }, cacheFile: file, now: NOW + USAGE_TTL_MS + 1_000 });
    assert.equal(later.claude.available, true);
    assert.equal(later.claude.stale, true, "the failed refresh leaves the last snapshot, flagged stale");
    assert.ok(later.claude.refreshError.length <= 80);
    assert.doesNotMatch(later.claude.refreshError, /Z{24}/);
    const down = await readProviderUsage({ probes: { codex: failing }, cacheFile: path.join(dir, "none.json"), now: NOW });
    assert.deepEqual([down.codex.available, down.codex.reason], [false, "probe-failed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only public figures are cached: no account id, email, balance or token ever reaches the cache file", async () => {
  const { dir, file } = tmpCache();
  try {
    await readProviderUsage({ probes: { codex: async () => parseCodexUsage(codexLimits(), { type: "chatgpt" }, { observedAt: OBSERVED }) }, cacheFile: file, now: NOW });
    const raw = JSON.stringify(await readUsageCache(file));
    assert.doesNotMatch(raw, /acct-should-never-appear|12\.34|balance|email|token/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`murmur usage --json`: every enabled provider, kinds classified, Cursor honestly unavailable", async () => {
  const world = await makeWorld();
  const { dir, file } = tmpCache();
  try {
    const out = []; const err = [];
    const code = await commandUsage({
      args: [world.projectPath], flags: { json: true }, out: (l) => out.push(l), err: (l) => err.push(l),
      home: world.paths.home, now: NOW, cacheFile: file,
      probes: {
        claude: async () => parseClaudeUsage(claudeResponse(), { observedAt: OBSERVED }),
        codex: async () => parseCodexUsage(codexLimits(), { type: "chatgpt" }, { observedAt: OBSERVED }),
        cursor: async () => CURSOR_USAGE_UNAVAILABLE,
      },
    });
    assert.equal(code, 0);
    const report = JSON.parse(out.join("\n"));
    assert.deepEqual(Object.keys(report.providers), ["claude", "codex", "cursor"]);
    assert.equal(report.providers.claude.kind, "subscription_usage");
    assert.equal(report.providers.cursor.available, false);
    assert.equal(report.providers.claude.windows.length, 3, "windows are never collapsed into one number");
    assert.doesNotMatch(JSON.stringify(report), /acct-should-never-appear|12\.34|email|token|authorization/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    world.cleanup();
  }
});

test("low-limit warnings: only fresh subscription windows under 10%; stale, API-rate-limit and healthy ones stay quiet", async () => {
  const { dir, file } = tmpCache();
  try {
    const low = parseClaudeUsage(claudeResponse({ limits: [{ kind: "session", percent: 93, resets_at: inMinutes(50) }], five_hour: { utilization: 93 }, seven_day: null }), { observedAt: OBSERVED });
    const apiLow = parseCodexUsage(codexLimits(), { type: "apiKey" }, { observedAt: OBSERVED });
    apiLow.windows[0].remainingPercent = 2;
    await writeUsageCache(file, { claude: low, codex: apiLow });
    const lines = await lowLimitWarnings({ cacheFile: file, now: NOW + 1_000 });
    assert.deepEqual(lines, ["Claude: осталось 7% лимита (5 часов). Задача может не завершиться до сброса."]);
    assert.deepEqual(await lowLimitWarnings({ cacheFile: file, now: NOW + USAGE_STALE_MS + 5_000 }), [], "stale data raises no alarm");
    assert.deepEqual(await lowLimitWarnings({ cacheFile: path.join(dir, "missing.json"), now: NOW }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnostics redact emails, account ids and token-like runs, and stay bounded", () => {
  const text = safeUsageError(new Error("failed for someone@example.invalid acct 0b8f2a3c-1111-2222-3333-444455556666 key abcdefghijklmnopqrstuv"));
  assert.doesNotMatch(text, /example\.invalid|0b8f2a3c|abcdefghijklmnop/);
  assert.ok(text.length <= 80);
});

test("a cached snapshot belongs to the provider executable it was read from: another binary never inherits it", async () => {
  const { dir, file } = tmpCache();
  try {
    let calls = 0;
    const probe = async () => { calls += 1; return parseClaudeUsage(claudeResponse(), { observedAt: new Date(NOW).toISOString() }); };
    await readProviderUsage({ probes: { claude: probe }, cacheFile: file, now: NOW, identities: { claude: "/opt/a/claude" } });
    await readProviderUsage({ probes: { claude: probe }, cacheFile: file, now: NOW + 1_000, identities: { claude: "/opt/a/claude" } });
    assert.equal(calls, 1, "same executable: cached");
    await readProviderUsage({ probes: { claude: probe }, cacheFile: file, now: NOW + 2_000, identities: { claude: "/opt/b/claude" } });
    assert.equal(calls, 2, "a different executable (possibly another account) triggers its own read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
