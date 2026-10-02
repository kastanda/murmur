/**
 * codex-model-control.test.mjs — per-project Codex model/reasoning control.
 *
 * Protocol facts these tests encode were verified against the installed App Server
 * (codex-cli 0.159.2; docs/agent-model-discovery.md): `model/list` enumerates models,
 * `thread/start` takes `model` + `config.model_reasoning_effort`, `turn/start` takes
 * `model` + `effort` scoped to the thread, and the server confirms through
 * `thread/settings/updated`. The fake servers below mimic those shapes; model ids in them
 * are SYNTHETIC unless they come from a live capture, and prove parsing only.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  buildCodexModelOptions,
  discoverCodexCapabilities,
  normalizeCodexModel,
  probeCodexAppServer,
} from "../scripts/codex-capabilities.mjs";
import {
  INHERIT,
  codexEffortOptions,
  codexEffortsFor,
  isSupportedCodexEffort,
  isSupportedCodexModel,
  loadCodexPreferences,
  readCodexRuntimeCache,
  resolveCodexConfig,
  resolveCodexRuntimePolicy,
  validateCodexPreferences,
  writeCodexPreferences,
  writeCodexRuntimeCache,
  clearCodexRuntimeCache,
} from "../scripts/operator/codex-config.mjs";
import { commandCodex } from "../scripts/operator/codex-model.mjs";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { CODEX_APP_SERVER_MEMBER_SLOT, CodexAppServerRuntimeAdapter } from "../scripts/agent-runtime-adapter.mjs";
import { buildThreadStartParams, createCodexAppServerInjector } from "../scripts/codex-app-server-wake.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

// SYNTHETIC catalog rows shaped like a real `model/list` response.
const ROW = (model, displayName, efforts, extra = {}) => ({
  id: model, model, displayName, isDefault: false, hidden: false, defaultReasoningEffort: "medium",
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })), ...extra,
});
const LIST = [
  ROW("model-a", "Model A", ["low", "medium", "high", "xhigh"], { isDefault: true }),
  ROW("model-b", "Model B", ["low", "medium", "high"]),
  ROW("model-hidden", "Hidden", ["low"], { hidden: true }),
];

const CAPS = () => ({
  available: true, binary: "/fake/codex", serverVersion: "9.9.9", catalogSource: "app-server",
  models: buildCodexModelOptions(LIST.map(normalizeCodexModel)),
  defaults: { model: "model-a", reasoningEffort: "high" },
});
const CAPS_DOWN = () => ({ available: false, binary: null, models: [], defaults: null, serverVersion: null, catalogSource: "none" });

// ---------------------------------------------------------------------------
// Catalog decoding + probe
// ---------------------------------------------------------------------------

test("model/list rows decode to stable ids, labels and per-model effort levels; hidden models are not offered", () => {
  const options = buildCodexModelOptions(LIST.map(normalizeCodexModel));
  assert.deepEqual(options.map((o) => o.id), ["model-a", "model-b"]);
  assert.equal(options[0].label, "Model A");
  assert.equal(options[0].kind, "catalog");
  assert.deepEqual(options[1].efforts, ["low", "medium", "high"]);
  assert.equal(normalizeCodexModel(null), null);
  assert.equal(normalizeCodexModel({ displayName: "no id" }), null);
});

const fakeServer = ({ pages, startResult, failThreadStart = false, log = [] }) => (command, args) => {
  assert.equal(command, "/fake/codex");
  assert.deepEqual(args, ["app-server", "--listen", "stdio://"], "private stdio server, never the project's socket");
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
      log.push(message);
      if (message.id === undefined) continue;
      const reply = (result, error) => child.stdout.write(`${JSON.stringify({ id: message.id, ...(error ? { error } : { result }) })}\n`);
      if (message.method === "initialize") reply({ userAgent: "murmur-model-discovery/0.159.2 (test)" });
      else if (message.method === "model/list") reply(pages[message.params.cursor ?? "first"]);
      else if (message.method === "thread/start") failThreadStart ? reply(null, { message: "nope" }) : reply(startResult);
    }
  });
  return child;
};

test("the probe reads every model/list page and the inherited default via ONE ephemeral thread/start with no overrides", async () => {
  const log = [];
  const spawnImpl = fakeServer({
    log,
    pages: { first: { data: [LIST[0]], nextCursor: "p2" }, p2: { data: [LIST[1], LIST[2]], nextCursor: null } },
    startResult: { model: "model-b", reasoningEffort: "low", thread: { id: "t" } },
  });
  const result = await probeCodexAppServer({ command: "/fake/codex", spawnImpl, timeoutMs: 2000 });
  assert.deepEqual(result.models.map((m) => m.id), ["model-a", "model-b", "model-hidden"]);
  assert.deepEqual(result.defaults, { model: "model-b", reasoningEffort: "low" });
  assert.equal(result.serverVersion, "0.159.2");
  const starts = log.filter((m) => m.method === "thread/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.ephemeral, true, "never persisted");
  assert.equal(starts[0].params.model, undefined, "no model override while reading defaults");
  assert.equal(log.some((m) => m.method === "turn/start"), false, "no turn: zero model tokens");
});

test("a failing default-read does not lose the catalog", async () => {
  const spawnImpl = fakeServer({ pages: { first: { data: [LIST[0]], nextCursor: null } }, startResult: null, failThreadStart: true });
  const result = await probeCodexAppServer({ command: "/fake/codex", spawnImpl, timeoutMs: 2000 });
  assert.equal(result.models.length, 1);
  assert.equal(result.defaults, null);
});

test("discovery caches the catalog, falls back to the stale cache, and reports unavailable when nothing is known", async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-codex-caps-"));
  try {
    const cacheFile = path.join(dir, "codex.json");
    let probes = 0;
    const base = { env: { CODEX_HOME: path.join(dir, "home") }, homedir: dir, cacheFile, discoverExecutable: () => ({ path: process.execPath }) };
    const probe = async () => { probes += 1; return { models: LIST.map(normalizeCodexModel), defaults: { model: "model-a", reasoningEffort: "high" }, serverVersion: "1.2.3" }; };
    const first = await discoverCodexCapabilities({ ...base, probe });
    assert.equal(first.catalogSource, "app-server");
    assert.deepEqual(first.models.map((m) => m.id), ["model-a", "model-b"]);
    const second = await discoverCodexCapabilities({ ...base, probe });
    assert.equal(second.catalogSource, "cache");
    assert.equal(probes, 1);
    const stale = await discoverCodexCapabilities({ ...base, refresh: true, now: Date.now() + 7 * 3600_000, probe: async () => { throw new Error("down"); } });
    assert.equal(stale.catalogSource, "stale-cache");
    const none = await discoverCodexCapabilities({ ...base, cacheFile: path.join(dir, "none.json"), probe: async () => { throw new Error("down"); } });
    assert.equal(none.available, false);
    assert.deepEqual(none.models, []);
    const noBinary = await discoverCodexCapabilities({ ...base, discoverExecutable: () => ({ path: null }) });
    assert.equal(noBinary.available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Allowlist + preferences
// ---------------------------------------------------------------------------

test("only models the App Server offers are accepted; arbitrary strings, hidden and unknown ids are rejected", () => {
  const caps = CAPS();
  assert.equal(isSupportedCodexModel("model-a", caps), true);
  assert.equal(isSupportedCodexModel(INHERIT, caps), true);
  for (const bad of ["model-hidden", "model-z", "gpt-5.5 --yolo", "model-a; x", "", null, "../model-a"]) {
    assert.equal(isSupportedCodexModel(bad, caps), false, String(bad));
  }
  assert.equal(isSupportedCodexModel("model-a", CAPS_DOWN()), false, "nothing but inherit while the catalog is unreadable");
  assert.equal(isSupportedCodexModel(INHERIT, CAPS_DOWN()), true);
});

test("effort is validated against the chosen model's own levels (inherit -> the default model's)", () => {
  const caps = CAPS();
  assert.equal(isSupportedCodexEffort("xhigh", caps, "model-a"), true);
  assert.equal(isSupportedCodexEffort("xhigh", caps, "model-b"), false);
  assert.equal(isSupportedCodexEffort("xhigh", caps, INHERIT), true, "default model-a takes xhigh");
  assert.equal(isSupportedCodexEffort("extreme", caps, "model-a"), false);
  assert.equal(isSupportedCodexEffort("high; rm", caps, "model-a"), false);
  assert.deepEqual(codexEffortsFor("model-b", caps), ["low", "medium", "high"]);
  assert.deepEqual(codexEffortOptions({ capabilities: caps, selectedModel: "model-a", selectedEffort: "xhigh" }).map((o) => o.id), ["low", "medium", "high", "xhigh", "inherit"]);
  assert.deepEqual(codexEffortOptions({ capabilities: caps, selectedModel: "model-b", selectedEffort: "low" }).map((o) => o.id), ["low", "medium", "high", "inherit"]);
});

const tmpPaths = () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-codex-config-"));
  return { dir, codexPreferencesFile: path.join(dir, "codex-preferences.json"), codexRuntimeCacheFile: path.join(dir, "codex-runtime-cache.json") };
};

test("preferences persist exactly, and malformed files fail closed", async () => {
  const paths = tmpPaths();
  try {
    assert.deepEqual(await loadCodexPreferences(paths), { state: "absent" });
    await writeCodexPreferences(paths, { version: 1, model: "model-a", effort: "high" });
    assert.deepEqual(JSON.parse(readFileSync(paths.codexPreferencesFile, "utf8")), { version: 1, model: "model-a", effort: "high" });
    assert.deepEqual((await loadCodexPreferences(paths)).preferences, { version: 1, model: "model-a", effort: "high" });
    writeFileSync(paths.codexPreferencesFile, "{ not json", { mode: 0o600 });
    assert.equal((await loadCodexPreferences(paths)).state, "invalid");
    assert.throws(() => validateCodexPreferences({ version: 1, model: "a b", effort: "high" }), /model-malformed/);
    assert.throws(() => validateCodexPreferences({ version: 2, model: "a", effort: "high" }), /version-unsupported/);
    assert.throws(() => validateCodexPreferences({ version: 1, model: "a", effort: "$(x)" }), /effort-malformed/);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the runtime policy forwards only what the live catalog still offers", () => {
  const caps = CAPS();
  assert.deepEqual(resolveCodexRuntimePolicy({ preferences: { model: "model-b", effort: "high" }, capabilities: caps }), { model: "model-b", effort: "high", reasons: [] });
  assert.deepEqual(resolveCodexRuntimePolicy({ preferences: { model: INHERIT, effort: INHERIT }, capabilities: caps }), { model: null, effort: null, reasons: [] });
  const gone = resolveCodexRuntimePolicy({ preferences: { model: "retired", effort: "high" }, capabilities: caps });
  assert.equal(gone.model, null);
  assert.ok(gone.reasons.includes("model-no-longer-offered"));
  const badEffort = resolveCodexRuntimePolicy({ preferences: { model: "model-b", effort: "xhigh" }, capabilities: caps });
  assert.deepEqual([badEffort.model, badEffort.effort], ["model-b", null]);
  const down = resolveCodexRuntimePolicy({ preferences: { model: "model-b", effort: INHERIT }, capabilities: CAPS_DOWN() });
  assert.deepEqual([down.model, down.effort, down.reasons], [null, null, ["catalog-unavailable"]]);
  assert.deepEqual(resolveCodexRuntimePolicy({ preferences: null, capabilities: caps }), { model: null, effort: null, reasons: [] });
});

// ---------------------------------------------------------------------------
// Selected vs effective
// ---------------------------------------------------------------------------

const resolveWith = async (prefs, observed) => {
  const paths = tmpPaths();
  try {
    if (prefs) await writeCodexPreferences(paths, prefs);
    if (observed) await writeCodexRuntimeCache(paths, { observedAt: "2026-01-01T00:00:00.000Z", source: "thread-settings", ...observed });
    return await resolveCodexConfig({ paths, capabilities: CAPS() });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
};

test("no preference and no turn yet: inherit resolves to the model Codex itself would use", async () => {
  const resolved = await resolveWith(null, null);
  assert.equal(resolved.effectiveModel, "model-a");
  assert.equal(resolved.effectiveEffort, "high");
  assert.equal(resolved.source, "codex-config");
  assert.equal(resolved.requiresNewThread, false);
  assert.equal(resolved.pendingNextTurn, false);
  assert.equal(resolved.selected.view.resolvesToLabel, "Model A");
});

test("an explicit choice that has not run yet has no effective model — it is not invented", async () => {
  const resolved = await resolveWith({ version: 1, model: "model-b", effort: "low" }, null);
  assert.equal(resolved.effectiveModel, null);
  assert.equal(resolved.source, "murmur-project");
  assert.equal(resolved.pendingNextTurn, true, "selected is not running: it applies from the next turn");
});

test("going back to inherit is conservatively a NEW-session change when the default itself is unknown", async () => {
  const paths = tmpPaths();
  try {
    await writeCodexPreferences(paths, { version: 1, model: INHERIT, effort: INHERIT });
    await writeCodexRuntimeCache(paths, { model: "model-b", effort: "low", selection: { model: "model-b", effort: "low" }, observedAt: "2026-01-01T00:00:00.000Z" });
    const resolved = await resolveCodexConfig({ paths, capabilities: { ...CAPS(), defaults: null } });
    assert.equal(resolved.requiresNewThread, true);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("selected differs from what last ran: applies from the NEXT TURN, no restart", async () => {
  const resolved = await resolveWith(
    { version: 1, model: "model-b", effort: "high" },
    { model: "model-a", effort: "high", selection: { model: INHERIT, effort: INHERIT } },
  );
  assert.equal(resolved.effectiveModel, "model-a");
  assert.equal(resolved.pendingNextTurn, true);
  assert.equal(resolved.requiresNewThread, false);
});

test("going back to inherit while the thread holds an explicit model needs a NEW session", async () => {
  const resolved = await resolveWith(
    { version: 1, model: INHERIT, effort: INHERIT },
    { model: "model-b", effort: "low", selection: { model: "model-b", effort: "low" } },
  );
  assert.equal(resolved.requiresNewThread, true);
  assert.equal(resolved.pendingNextTurn, false);
  const same = await resolveWith(
    { version: 1, model: INHERIT, effort: INHERIT },
    { model: "model-a", effort: "high", selection: { model: "model-a", effort: "high" } },
  );
  assert.equal(same.requiresNewThread, false, "the explicit choice equals the default: nothing to transition");
});

test("the runtime cache reader rejects malformed data instead of guessing", async () => {
  const paths = tmpPaths();
  try {
    assert.equal(await readCodexRuntimeCache({ codexRuntimeCacheFile: undefined }), null);
    assert.equal(await readCodexRuntimeCache(paths), null);
    writeFileSync(paths.codexRuntimeCacheFile, JSON.stringify({ version: 2, model: "x" }), { mode: 0o600 });
    assert.equal(await readCodexRuntimeCache(paths), null);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a daemon restart forgets the previous run's observation instead of misreporting a held thread setting", async () => {
  const paths = tmpPaths();
  try {
    await writeCodexRuntimeCache(paths, { model: "model-b", effort: "low", selection: { model: "model-b", effort: "low" }, observedAt: "2026-01-01T00:00:00.000Z" });
    await writeCodexPreferences(paths, { version: 1, model: INHERIT, effort: INHERIT });
    assert.equal((await resolveCodexConfig({ paths, capabilities: CAPS() })).requiresNewThread, true);
    await clearCodexRuntimeCache(paths);
    await clearCodexRuntimeCache(paths); // idempotent
    const after = await resolveCodexConfig({ paths, capabilities: CAPS() });
    assert.equal(after.requiresNewThread, false);
    assert.equal(after.effectiveModel, "model-a", "inherit falls back to what Codex itself would use");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Protocol payloads (injector)
// ---------------------------------------------------------------------------

test("thread/start carries model + per-thread effort config; absent overrides keep the legacy null shape", () => {
  const withBoth = buildThreadStartParams(null, { cwd: "/p", model: "model-b", effort: "low" });
  assert.equal(withBoth.model, "model-b");
  assert.deepEqual(withBoth.config, { model_reasoning_effort: "low" });
  const none = buildThreadStartParams(null, { cwd: "/p" });
  assert.equal(none.model, null);
  assert.equal(none.config, null);
});

test("the injector sends model + effort on thread/start and every turn/start, and returns the server-reported effective settings", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "t1" }, model: "model-b", reasoningEffort: "low" };
      return { turn: { id: "turn-1" } };
    }
    async startTurnAndWaitForFinal(params) {
      calls.push({ method: "turn/start:wait", params });
      return { finalText: "ok", turnId: "turn-1", effectiveSettings: { model: "model-b", effort: "medium" } };
    }
  }
  const processing = { attemptId: "a1", completed() {}, started() {} };
  const injector = createCodexAppServerInjector({ Client: FakeClient });
  const peer = { mode: "codex_app_server", socketPath: "/tmp/x.sock", model: "model-b", effort: "medium", returnFinalToCaller: true };
  const result = await injector({ msgId: "m", from: "sender", conversationId: "c", text: "hi" }, peer, processing);
  const start = calls.find((c) => c.method === "thread/start").params;
  assert.equal(start.model, "model-b");
  assert.deepEqual(start.config, { model_reasoning_effort: "medium" });
  const turn = calls.find((c) => c.method === "turn/start:wait").params;
  assert.equal(turn.model, "model-b");
  assert.equal(turn.effort, "medium");
  assert.deepEqual(result.effective, { model: "model-b", effort: "medium" });
  assert.equal(result.effectiveSource, "thread-settings");
});

test("with no policy the injector sends no model/effort at all (the legacy behaviour)", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) { calls.push({ method, params }); return method === "thread/start" ? { thread: { id: "t" } } : { turn: { id: "x" } }; }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient });
  await injector({ msgId: "m", from: "s", conversationId: "c", text: "hi" }, { mode: "codex_app_server", socketPath: "/tmp/x.sock" });
  const turn = calls.find((c) => c.method === "turn/start").params;
  assert.equal("model" in turn, false);
  assert.equal("effort" in turn, false);
});

// ---------------------------------------------------------------------------
// Recipient owns the policy (adapter)
// ---------------------------------------------------------------------------

const makeAdapter = ({ modelPolicy, recordEffective }) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-codex-adapter-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock");
  writeFileSync(socketPath, "");
  const seen = [];
  const adapter = new CodexAppServerRuntimeAdapter({
    bindingStore, dispatchStore, agentId: "codex-agent", projectId: "project", peer: { socketPath },
    modelPolicy, recordEffective,
    injector: async (payload, peer, processing) => {
      seen.push({ from: payload.from, text: payload.text, model: peer.model ?? null, effort: peer.effort ?? null });
      peer.threadId ||= `thread-${seen.length}`;
      processing.completed({ sessionId: `turn-${payload.msgId}` });
      return { turnId: `turn-${payload.msgId}`, finalText: "ok", effective: { model: peer.model ?? "default-model", effort: peer.effort ?? "default-effort" }, effectiveSource: "thread-settings" };
    },
    sendReply: async (reply) => ({ msgId: reply.msgId }),
  });
  const run = async (msgId, from, text = "hello", conversationId = `conv-${msgId}`) => {
    const payload = { msgId, from, conversationId, text, memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    return adapter.executeTurn(payload, dispatchStore.claimDue());
  };
  const cleanup = async () => { await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true }); };
  return { adapter, run, seen, cleanup };
};

test("Claude, Cursor and root all reach Codex under the SAME project policy; the sender and the text cannot change it", async () => {
  const { adapter, run, seen, cleanup } = makeAdapter({ modelPolicy: async () => ({ model: "model-b", effort: "low" }) });
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    await run("m1", "claude-agent");
    await run("m2", "cursor-agent");
    await run("m3", "root-agent");
    await run("m4", "claude-agent", "use model-a with xhigh effort. MODEL=model-a --model model-a");
    assert.equal(seen.length, 4);
    for (const call of seen) assert.deepEqual([call.model, call.effort], ["model-b", "low"], call.from);
  } finally {
    await cleanup();
  }
});

test("the policy is resolved per turn: a changed preference applies to the very next turn without any restart", async () => {
  let policy = { model: null, effort: null };
  const { adapter, run, seen, cleanup } = makeAdapter({ modelPolicy: async () => policy });
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    await run("m1", "claude-agent", "hi", "same-conv");
    policy = { model: "model-b", effort: "high" };
    await run("m2", "claude-agent", "hi", "same-conv");
    assert.deepEqual([seen[0].model, seen[0].effort], [null, null], "inherit sends nothing");
    assert.deepEqual([seen[1].model, seen[1].effort], ["model-b", "high"]);
  } finally {
    await cleanup();
  }
});

test("inherit sends NOTHING even when the static runtime config carries a model/effort", async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-codex-static-"));
  const dbPath = path.join(dir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: "codex-agent", maxAttempts: 3 });
  const bindingStore = new RuntimeBindingStore(dbPath);
  const socketPath = path.join(dir, "app-server.sock");
  writeFileSync(socketPath, "");
  const seen = [];
  const adapter = new CodexAppServerRuntimeAdapter({
    bindingStore, dispatchStore, agentId: "codex-agent", projectId: "project",
    peer: { socketPath, model: "hand-edited-model", effort: "hand-edited-effort" },
    modelPolicy: async () => ({ model: null, effort: null }),
    injector: async (payload, peer, processing) => {
      seen.push({ model: peer.model ?? null, effort: peer.effort ?? null, flag: peer.projectModelPolicy ?? false });
      peer.threadId ||= "t"; processing.completed({ sessionId: "x" }); return { turnId: "x", finalText: "ok" };
    },
    sendReply: async (reply) => ({ msgId: reply.msgId }),
  });
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    const payload = { msgId: "m1", from: "claude-agent", conversationId: "c", text: "hi", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
    dispatchStore.enqueue(payload);
    await adapter.executeTurn(payload, dispatchStore.claimDue());
    assert.deepEqual(seen[0], { model: null, effort: null, flag: false });
  } finally {
    await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit project model outranks a channel persona's model on thread/start; no policy keeps the legacy precedence", async () => {
  const binding = { model: "persona-model" };
  assert.equal(buildThreadStartParams(binding, { model: "model-b", projectModelPolicy: true }).model, "model-b");
  assert.equal(buildThreadStartParams(binding, { model: "static-model" }).model, "persona-model");
  assert.equal(buildThreadStartParams(binding, {}).model, "persona-model");
  const { adapter, run, seen, cleanup } = makeAdapter({ modelPolicy: async () => ({ model: "model-b", effort: null }) });
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    await run("m1", "claude-agent");
    assert.equal(seen[0].model, "model-b");
  } finally {
    await cleanup();
  }
});

test("a failing policy resolver degrades to no override rather than failing or guessing", async () => {
  const logs = [];
  const { adapter, run, seen, cleanup } = makeAdapter({ modelPolicy: async () => { throw new Error("boom"); } });
  adapter.log = (level, message) => logs.push([level, message]);
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    const result = await run("m1", "claude-agent");
    assert.equal(result.status, "completed");
    assert.deepEqual([seen[0].model, seen[0].effort], [null, null]);
    assert.ok(logs.some(([, message]) => /model policy/.test(message)));
  } finally {
    await cleanup();
  }
});

test("the server-reported effective settings are recorded with the selection that produced them", async () => {
  const records = [];
  const { adapter, run, cleanup } = makeAdapter({
    modelPolicy: async () => ({ model: "model-b", effort: "low" }),
    recordEffective: async (record) => { records.push(record); },
  });
  try {
    adapter.start({ bindingId: "b", leaseTtlMs: 1_000 });
    await run("m1", "claude-agent");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].model, records[0].effort, records[0].source], ["model-b", "low", "thread-settings"]);
    assert.deepEqual(records[0].selection, { model: "model-b", effort: "low" });
    assert.match(records[0].threadId, /^thread-/);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Operator CLI
// ---------------------------------------------------------------------------

const CLAUDE_CAPS_NONE = async () => ({ available: false, modelFlagSupported: false, effortFlagSupported: false, supportedModels: [], supportedEfforts: [] });

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-codex-cli-"));
  const rawProjectPath = path.join(dir, "project");
  mkdirSync(rawProjectPath, { recursive: true });
  const projectPath = realpathSync(rawProjectPath);
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  await bootstrapProfile({ projectId, projectPath, paths, discoverCapabilities: CLAUDE_CAPS_NONE });
  // A fixture standing in for ~/.codex: the CLI must never touch it.
  const codexHome = path.join(dir, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const globalConfig = path.join(codexHome, "config.toml");
  writeFileSync(globalConfig, 'model = "model-a"\nmodel_reasoning_effort = "high"\n');
  const hash = () => createHash("sha256").update(readFileSync(globalConfig)).digest("hex");
  return { dir, projectPath, paths, globalConfig, hash, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const run = async (ctx, args, flags = {}, discover = async () => CAPS()) => {
  const out = [];
  const err = [];
  const code = await commandCodex({
    args: [ctx.projectPath, ...args], flags, out: (l) => out.push(l), err: (l) => err.push(l),
    home: ctx.paths.home, discoverCapabilities: discover,
  });
  return { code, out, err };
};

test("config --json exposes selected/effective/available/effort fields and never writes", async () => {
  const ctx = await setup();
  try {
    const { code, out } = await run(ctx, ["config"], { json: true });
    assert.equal(code, 0);
    const { codex } = JSON.parse(out.join("\n"));
    assert.equal(codex.controllable, true);
    assert.equal(codex.selectedModel, INHERIT);
    assert.equal(codex.selectedModelLabel, "По настройкам Codex");
    assert.equal(codex.effectiveModel, "model-a");
    assert.equal(codex.effectiveModelLabel, "Model A");
    assert.equal(codex.reasoningEffort, INHERIT);
    assert.equal(codex.effectiveReasoningEffort, "high");
    assert.equal(codex.effectiveReasoningEffortLabel, "Высокое");
    assert.deepEqual(codex.availableModels.map((m) => m.id), ["model-a", "model-b", "inherit"]);
    assert.equal(codex.availableModels.at(-1).resolvesToLabel, "Model A");
    assert.equal(codex.pendingRestart, false);
    assert.equal(codex.requiresNewThread, false);
    assert.equal(existsSync(ctx.paths.codexPreferencesFile), false, "reading never creates the file");
  } finally {
    ctx.cleanup();
  }
});

test("model and effort are set per project, validated, persisted, and the global Codex config is untouched", async () => {
  const ctx = await setup();
  try {
    const before = ctx.hash();
    assert.equal((await run(ctx, ["model", "model-b"])).code, 0);
    assert.equal((await run(ctx, ["effort", "low"])).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(ctx.paths.codexPreferencesFile, "utf8")), { version: 1, model: "model-b", effort: "low" });
    const { codex } = JSON.parse((await run(ctx, ["config"], { json: true })).out.join("\n"));
    assert.equal(codex.selectedModel, "model-b");
    assert.equal(codex.selectedModelLabel, "Model B");
    assert.equal(codex.reasoningEffortLabel, "Низкое");
    assert.equal(codex.source, "murmur-project");
    assert.equal(ctx.hash(), before, "no write to the global Codex configuration");
  } finally {
    ctx.cleanup();
  }
});

test("invalid model, invalid effort, effort the model lacks, and arbitrary strings are rejected with nothing written", async () => {
  const ctx = await setup();
  try {
    assert.equal((await run(ctx, ["effort", "xhigh"])).code, 0); // model inherits -> default model-a takes xhigh
    const before = readFileSync(ctx.paths.codexPreferencesFile, "utf8");
    for (const bad of ["model-z", "model-hidden", "model-a --yolo", "$(touch x)", "../model-a"]) {
      const { code, err } = await run(ctx, ["model", bad]);
      assert.equal(code, 1, bad);
      assert.match(err.join("\n"), /not supported/);
    }
    const incompatible = await run(ctx, ["model", "model-b"]);
    assert.equal(incompatible.code, 1);
    assert.match(incompatible.err.join("\n"), /does not support the current effort 'xhigh'/);
    assert.equal((await run(ctx, ["effort", "extreme"])).code, 1);
    assert.equal(readFileSync(ctx.paths.codexPreferencesFile, "utf8"), before);
  } finally {
    ctx.cleanup();
  }
});

test("when the App Server catalog is unreadable only inherit is accepted; no fake selector data is reported", async () => {
  const ctx = await setup();
  try {
    const refused = await run(ctx, ["model", "model-a"], {}, async () => CAPS_DOWN());
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), /could not be read/);
    assert.equal((await run(ctx, ["model", "inherit"], {}, async () => CAPS_DOWN())).code, 0);
    const { codex } = JSON.parse((await run(ctx, ["config"], { json: true }, async () => CAPS_DOWN())).out.join("\n"));
    assert.equal(codex.controllable, false);
    assert.equal(codex.reason, "codex-model-catalog-unavailable");
    assert.deepEqual(codex.availableModels, []);
    assert.deepEqual(codex.effortOptions, []);
  } finally {
    ctx.cleanup();
  }
});

test("going back to inherit after a run under an explicit model reports the new-session transition", async () => {
  const ctx = await setup();
  try {
    await run(ctx, ["model", "model-b"]);
    await writeCodexRuntimeCache(ctx.paths, { model: "model-b", effort: "medium", selection: { model: "model-b", effort: INHERIT }, observedAt: "2026-01-01T00:00:00.000Z", source: "thread-settings" });
    const result = await run(ctx, ["model", "inherit"]);
    assert.equal(result.code, 0);
    assert.match(result.out.join("\n"), /new Codex session/);
    const { codex } = JSON.parse((await run(ctx, ["config"], { json: true })).out.join("\n"));
    assert.equal(codex.requiresNewThread, true);
  } finally {
    ctx.cleanup();
  }
});

test("a malformed preferences file is never written over", async () => {
  const ctx = await setup();
  try {
    writeFileSync(ctx.paths.codexPreferencesFile, "garbage", { mode: 0o600 });
    const { code, err } = await run(ctx, ["model", "model-a"]);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /invalid/);
    assert.equal(readFileSync(ctx.paths.codexPreferencesFile, "utf8"), "garbage");
  } finally {
    ctx.cleanup();
  }
});

test("the preferences file and the CLI output carry no secret field", async () => {
  const ctx = await setup();
  try {
    await run(ctx, ["model", "model-b"]);
    assert.doesNotMatch(readFileSync(ctx.paths.codexPreferencesFile, "utf8"), /key|token|secret|password|credential/i);
    assert.doesNotMatch((await run(ctx, ["config"], { json: true })).out.join("\n"), /privateKey|botToken|natsToken|auth/i);
  } finally {
    ctx.cleanup();
  }
});
