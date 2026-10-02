/**
 * codex-capabilities.mjs — what the INSTALLED Codex App Server actually offers, read from
 * the App Server itself.
 *
 * What was verified against codex-cli 0.159.2 (see docs/agent-model-discovery.md):
 *   - `model/list` enumerates models (`id`/`model` slug, `displayName`, `isDefault`,
 *     `hidden`, `defaultReasoningEffort`, `supportedReasoningEfforts`);
 *   - `thread/start` accepts `model` and `config.model_reasoning_effort`; its response
 *     reports the EFFECTIVE `model` and `reasoningEffort`;
 *   - `turn/start` accepts `model` and `effort` ("for this turn and subsequent turns" —
 *     scoped to that thread, same context) and the server confirms the result with a
 *     `thread/settings/updated` notification;
 *   - none of that touches `~/.codex/config.toml` (hash unchanged across the probes).
 *
 * So a Codex model/effort choice can be project-scoped. This module only DISCOVERS: one
 * short-lived, private `codex app-server --listen stdio://` process (no socket, nothing
 * shared with the project's own App Server), `initialize`, `model/list`, and one
 * EPHEMERAL `thread/start` with no overrides — which costs zero model tokens and is never
 * persisted — to read what Codex itself would use when Murmur passes nothing ("inherit").
 * The result is cached (6 h, keyed by the binary and `config.toml`'s stat) so the menu's
 * 5-second poll never spawns it. Argv only, never a shell.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { MODEL_KINDS, defaultCatalogCacheFile, readCatalogCache, writeCatalogCache } from "./agent-models.mjs";
import { discoverCodexExecutable } from "./operator/codex.mjs";

export const CODEX_CATALOG_SOURCE = Object.freeze({ appServer: "app-server", cache: "cache", staleCache: "stale-cache", none: "none" });

const asEffortList = (list) => (Array.isArray(list) ? list : [])
  .map((entry) => (typeof entry === "string" ? entry : entry?.reasoningEffort))
  .filter((level) => typeof level === "string" && level);

/** One `model/list` row -> the public fields Murmur keeps. Pure. */
export const normalizeCodexModel = (row) => {
  if (!row || typeof row !== "object") return null;
  const id = typeof row.model === "string" && row.model ? row.model : (typeof row.id === "string" ? row.id : null);
  if (!id) return null;
  return {
    id,
    displayName: typeof row.displayName === "string" && row.displayName ? row.displayName : null,
    isDefault: row.isDefault === true,
    hidden: row.hidden === true,
    defaultEffort: typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : null,
    efforts: asEffortList(row.supportedReasoningEfforts),
  };
};

/** Normalized rows -> picker options (`catalog` kind: Codex lists concrete ids, no aliases). */
export const buildCodexModelOptions = (rows) => (Array.isArray(rows) ? rows : [])
  .filter((row) => row && !row.hidden)
  .map((row) => ({
    id: row.id, canonicalId: row.id, alias: null, family: null, version: null,
    label: row.displayName || row.id, resolvesToLabel: null,
    kind: MODEL_KINDS.catalog, selectable: true, disabledReason: null,
    efforts: row.efforts, isDefault: row.isDefault, defaultEffort: row.defaultEffort,
  }));

/**
 * One bounded probe of a private stdio App Server. `spawnImpl` is injectable so the
 * protocol handling is tested against a fake server, never the installed binary.
 */
export const probeCodexAppServer = ({
  command, args = ["app-server", "--listen", "stdio://"], cwd = os.tmpdir(), env = process.env,
  timeoutMs = 20_000, spawnImpl = spawn, readDefaults = true,
} = {}) => new Promise((resolve, reject) => {
  const child = spawnImpl(command, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let nextId = 0;
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    for (const waiter of pending.values()) waiter.reject(error || new Error("codex-probe-finished"));
    pending.clear();
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (error) reject(error); else resolve(value);
  };
  const timer = setTimeout(() => finish(new Error("codex-model-catalog-timeout")), timeoutMs);
  timer.unref?.();
  child.once("error", (error) => finish(error));
  child.once("close", () => finish(new Error("codex-model-catalog-closed")));
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
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  (async () => {
    const init = await request("initialize", {
      clientInfo: { name: "murmur-model-discovery", title: "Murmur model discovery", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const rows = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const listed = await request("model/list", { includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const row of listed?.data ?? []) {
        const normalized = normalizeCodexModel(row);
        if (normalized) rows.push(normalized);
      }
      cursor = listed?.nextCursor || null;
      if (!cursor) break;
    }
    let defaults = null;
    if (readDefaults) {
      try {
        // Ephemeral: not persisted, no turn, no tokens. Reports what Codex uses by default.
        const started = await request("thread/start", { ephemeral: true, cwd });
        if (typeof started?.model === "string") {
          defaults = {
            model: started.model,
            reasoningEffort: typeof started.reasoningEffort === "string" ? started.reasoningEffort : null,
          };
        }
      } catch {
        defaults = null;
      }
    }
    const version = typeof init?.userAgent === "string" ? init.userAgent.match(/\/(\d+\.\d+\.\d+)/)?.[1] ?? null : null;
    return { models: rows, defaults, serverVersion: version };
  })().then((value) => finish(null, value), (error) => finish(error));
});

const stat = (file) => {
  try {
    const s = statSync(file);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return "absent";
  }
};

const EMPTY = Object.freeze({
  available: false, binary: null, models: [], defaults: null, serverVersion: null,
  catalogSource: CODEX_CATALOG_SOURCE.none,
});

/**
 * Discover the Codex model catalog and the default model/effort. Never throws: a missing
 * or unreachable Codex is an ordinary "not controllable" state.
 */
export const discoverCodexCapabilities = async ({
  override = null, env = process.env, homedir = os.homedir(), now = Date.now(),
  probe = probeCodexAppServer, cacheFile, refresh = false, discoverExecutable = discoverCodexExecutable,
} = {}) => {
  const found = discoverExecutable({ override, env });
  const binary = found?.path ?? null;
  if (!binary) return { ...EMPTY };
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : path.join(homedir, ".codex");
  // Identity covers what changes the answer: the binary, and `config.toml` (it decides the
  // inherited default). Only `stat` metadata is read — the file's contents are never read here.
  const identity = `${binary}|${stat(binary)}|${stat(path.join(codexHome, "config.toml"))}`;
  const cachePath = cacheFile !== undefined ? cacheFile : defaultCatalogCacheFile("codex", env, homedir);

  const cached = refresh ? null : await readCatalogCache(cachePath, identity, { now });
  let catalog = cached?.catalog ?? null;
  let source = cached ? CODEX_CATALOG_SOURCE.cache : CODEX_CATALOG_SOURCE.none;
  if (!catalog) {
    try {
      catalog = await probe({ command: binary, env });
      source = CODEX_CATALOG_SOURCE.appServer;
      await writeCatalogCache(cachePath, identity, catalog, { now });
    } catch {
      const stale = await readCatalogCache(cachePath, identity, { now, allowStale: true });
      if (stale) {
        catalog = stale.catalog;
        source = CODEX_CATALOG_SOURCE.staleCache;
      }
    }
  }
  if (!catalog) return { ...EMPTY, binary };
  return {
    available: true,
    binary,
    models: buildCodexModelOptions(catalog.models),
    defaults: catalog.defaults ?? null,
    serverVersion: catalog.serverVersion ?? null,
    catalogSource: source,
  };
};
