/**
 * claude-capabilities.mjs — what the INSTALLED Claude CLI actually supports, discovered
 * locally.
 *
 * Why this exists
 * ----------------
 * Murmur must let an operator choose a Claude model/effort level, but it must never
 * invent a flag or a model identifier the installed CLI does not actually accept — a
 * fabricated `--model claude-sonnet-5.5` would either be silently misinterpreted or
 * rejected with a confusing API error (`is_error: true`, exit code 0 — see below) deep
 * inside a turn that already consumed tokens.
 *
 * The CLI's own `--help` output is the one place this information lives without a
 * network round trip: `--model <model>` documents its accepted ALIASES inline ("Provide
 * an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')"), and `--effort
 * <level>` documents its accepted LEVELS inline ("(low, medium, high, xhigh, max)").
 * Parsing that text is the authoritative, zero-network, zero-cost discovery mechanism —
 * and if a future CLI renames its flags or aliases, the regexes below simply stop
 * matching and every caller treats the feature as unsupported rather than guessing.
 *
 * What was verified empirically against the installed CLI before this file was written
 * (claude 2.1.274): `--model sonnet` resolves to `claude-sonnet-5`, `--model opus`
 * resolves to `claude-opus-5` (confirmed via the `modelUsage[...].canonicalModel` field
 * of one real `--output-format json` turn each); an unknown `--model` value does NOT
 * fail the process (exit 0) but returns `is_error: true` with `api_error_status: 404` in
 * the JSON body; an unknown `--effort` value is silently ignored with a stderr warning
 * and the default effort is used. Both failure modes are exactly why Murmur validates
 * against a locally discovered allowlist before ever building argv, rather than trusting
 * the CLI to reject a bad value.
 */
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  INHERIT,
  MODEL_KINDS,
  capitalize,
  defaultCatalogCacheFile,
  parseClaudeCanonicalId,
  readCatalogCache,
  writeCatalogCache,
} from "./agent-models.mjs";

const execFileAsync = promisify(execFile);

/** PATH lookup without a shell — mirrors `operator/doctor.mjs`'s `findExecutable`. */
export const findClaudeExecutable = (command = "claude", env = process.env) => {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

/**
 * Parse `--help` text for what `--model`/`--effort` actually document.
 *
 * Pure and synchronous so it is trivially unit-testable against captured real and
 * malformed help text, independent of the installed CLI being present at all. The
 * quoted ALIASES next to `--model` are only the FALLBACK catalog (used when the real
 * model catalog cannot be read); full ids such as 'claude-fable-5' in the example text
 * are not aliases and are ignored here.
 */
export const parseClaudeHelp = (helpText) => {
  const text = String(helpText ?? "");
  const modelFlagPresent = /--model\s*<model>/.test(text);
  const effortFlagPresent = /--effort\s*<level>/.test(text);

  // Only the quoted aliases MENTIONED NEXT TO the --model flag's own description count —
  // a model name elsewhere in a multi-page --help dump must not be mistaken for an alias.
  const modelSection = text.match(/--model\s*<model>[\s\S]{0,400}?(?=\n\s*(?:-{1,2}\S|\n)|$)/)?.[0] || "";
  const quoted = [...modelSection.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  const supportedModels = modelFlagPresent
    ? [...new Set(quoted.filter((alias) => !alias.startsWith("claude-")))]
    : [];

  // The effort section states its full valid set as one literal parenthesised list.
  const effortSection = text.match(/--effort\s*<level>[\s\S]{0,400}?\(([a-z, ]+)\)/)?.[1] || "";
  const supportedEfforts = effortFlagPresent
    ? effortSection.split(",").map((level) => level.trim()).filter(Boolean)
    : [];

  return {
    modelFlagPresent,
    modelFlagSupported: modelFlagPresent && supportedModels.length > 0,
    effortFlagSupported: effortFlagPresent && supportedEfforts.length > 0,
    supportedModels,
    supportedEfforts,
  };
};

/**
 * Model catalog discovery — what the installed CLI/account actually offers
 * -------------------------------------------------------------------------
 * `claude --help` only documents a few example aliases. The authoritative, machine
 * readable catalog is the one Claude Code's OWN `/model` picker uses: the SDK
 * `initialize` control request answers with `models: [{ value, resolvedModel,
 * displayName, supportedEffortLevels, ... }]`. Sending exactly that one request (no user
 * message, so zero model tokens) over `--input-format stream-json` is the local,
 * documented-by-use way to read it. Verified against claude 2.1.285: 12 entries, e.g.
 * `{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" }`
 * (a moving ALIAS: value != resolvedModel) next to `{ value: "claude-sonnet-5",
 * resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5" }` (a PINNED concrete id).
 *
 * The result is cached on disk (6 h, keyed by the binary's identity) so the 5-second menu
 * poll never spawns it; the probe's `account` block (an email) is discarded and never
 * cached.
 */
export const CLAUDE_CATALOG_SOURCE = Object.freeze({ sdk: "sdk-initialize", cache: "cache", staleCache: "stale-cache", help: "help", none: "none" });

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];
const familyRank = (family) => {
  const index = FAMILY_ORDER.indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
};
const versionParts = (version) => String(version ?? "").split(".").map((part) => Number(part) || 0);
const compareVersionsDesc = (a, b) => {
  const [pa, pb] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
};

/** Reduce one SDK `models[]` entry to the public fields Murmur keeps. Pure. */
export const normalizeSdkModel = (entry) => {
  if (!entry || typeof entry !== "object") return null;
  const { value, resolvedModel, displayName, supportedEffortLevels, supportsEffort } = entry;
  if (typeof value !== "string" || !value || typeof resolvedModel !== "string" || !resolvedModel) return null;
  return {
    value,
    resolvedModel,
    displayName: typeof displayName === "string" && displayName ? displayName : null,
    efforts: Array.isArray(supportedEffortLevels)
      ? supportedEffortLevels.filter((level) => typeof level === "string")
      : (supportsEffort === false || supportsEffort === undefined ? [] : null),
  };
};

/**
 * Build the picker options from normalized SDK rows. Pure — the parser the tests drive
 * with synthetic future ids.
 *
 *   value !== resolvedModel  -> ALIAS ("Актуальный <Family>", moves with the CLI)
 *   value === resolvedModel  -> PINNED concrete version
 *   every alias's resolvedModel that is not already listed as pinned is added as a
 *   PINNED option too — it is the exact id the CLI itself resolves that alias to, so it
 *   is accepted by construction (this is how "Sonnet 5.5" and "Haiku 4.5" become fixed
 *   choices next to "Актуальный Sonnet").
 *   value === "default" is Anthropic's recommendation, not an option: it is reported
 *   separately as `defaultModel` and the operator's equivalent is `inherit`.
 */
export const buildClaudeModelOptions = (rows) => {
  const aliases = [];
  const pinned = new Map();
  let defaultModel = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.value !== "string") continue;
    if (row.value === "default") {
      // `displayName` here is "Default (recommended)" — the concrete label comes from the id.
      defaultModel = { canonicalId: row.resolvedModel, label: parseClaudeCanonicalId(row.resolvedModel)?.label ?? null };
      continue;
    }
    const parsed = parseClaudeCanonicalId(row.resolvedModel);
    const concreteLabel = row.displayName || parsed?.label || row.resolvedModel;
    if (row.value !== row.resolvedModel) {
      const family = parsed?.family ?? row.value;
      aliases.push({
        id: row.value,
        canonicalId: row.resolvedModel,
        alias: row.value,
        family,
        version: parsed?.version ?? null,
        label: `Актуальный ${capitalize(family)}`,
        resolvesToLabel: concreteLabel,
        kind: MODEL_KINDS.alias,
        selectable: true,
        disabledReason: null,
        efforts: row.efforts,
      });
      if (!pinned.has(row.resolvedModel)) {
        pinned.set(row.resolvedModel, {
          id: row.resolvedModel, canonicalId: row.resolvedModel, alias: null,
          family, version: parsed?.version ?? null, label: concreteLabel, resolvesToLabel: null,
          kind: MODEL_KINDS.pinned, selectable: true, disabledReason: null, efforts: row.efforts,
        });
      }
    } else {
      // An explicit listing always wins over an alias-derived one.
      pinned.set(row.value, {
        id: row.value, canonicalId: row.resolvedModel, alias: null,
        family: parsed?.family ?? null, version: parsed?.version ?? null,
        label: concreteLabel, resolvesToLabel: null,
        kind: MODEL_KINDS.pinned, selectable: true, disabledReason: null, efforts: row.efforts,
      });
    }
  }
  const pinnedOptions = [...pinned.values()].sort((a, b) =>
    familyRank(a.family) - familyRank(b.family)
    || String(a.family).localeCompare(String(b.family))
    || compareVersionsDesc(a.version, b.version));
  return { options: [...aliases, ...pinnedOptions], defaultModel };
};

/**
 * One bounded local probe: spawn `claude` in stream-json mode, send ONLY the
 * `initialize` control request, read its response, kill the process. Argv only — no
 * shell. `spawnImpl` is injectable so tests never run the real binary.
 */
export const probeClaudeModelCatalog = ({
  binary, timeoutMs = 15_000, cwd = os.tmpdir(), env = process.env, spawnImpl = spawn,
} = {}) => new Promise((resolve, reject) => {
  const child = spawnImpl(binary, [
    "-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--no-session-persistence",
  ], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const requestId = "murmur-model-catalog";
  let buffer = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    if (error) reject(error); else resolve(value);
  };
  const timer = setTimeout(() => finish(new Error("claude-model-catalog-timeout")), timeoutMs);
  timer.unref?.();
  child.once("error", (error) => finish(error));
  child.once("close", () => finish(new Error("claude-model-catalog-closed")));
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
      if (message.response.subtype !== "success" || !Array.isArray(message.response.response?.models)) {
        finish(new Error("claude-model-catalog-unavailable"));
        return;
      }
      // Only the public model rows leave this function — never the `account` block.
      finish(null, message.response.response.models.map(normalizeSdkModel).filter(Boolean));
      return;
    }
  });
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } })}\n`);
});

const binaryIdentity = (binary) => {
  try {
    const stat = statSync(binary);
    return `${binary}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  } catch {
    return `${binary}|unknown`;
  }
};

const EMPTY_CAPABILITIES = Object.freeze({
  available: false,
  modelFlagSupported: false,
  effortFlagSupported: false,
  supportedModels: [],
  supportedEfforts: [],
  models: [],
  defaultModel: null,
  catalogSource: CLAUDE_CATALOG_SOURCE.none,
});

/**
 * The CANONICAL model id actually used for a completed turn, e.g. `claude-sonnet-5-5` —
 * distinct from the ALIAS Murmur configured (`sonnet`) and from the human LABEL
 * ("Sonnet 5.5"). Extracted from the real `modelUsage` object a completed
 * `--output-format json` turn already returns (see `claude-one-shot-runtime.mjs`) —
 * never from a dedicated probe turn, so establishing it costs nothing beyond work
 * Murmur was already doing.
 *
 * `modelUsage` can carry more than one entry (a tiny Haiku helper call alongside the
 * main answering model is routinely observed). A PINNED selection (`claude-sonnet-5`) is
 * matched EXACTLY — never by substring, which would also match `claude-sonnet-5-5`. A
 * moving ALIAS (`sonnet`) is matched as a case-insensitive substring of the key, so
 * "sonnet" only ever matches a key containing "sonnet" rather than the largest entry.
 */
export const extractCanonicalModel = (modelUsage, selected) => {
  if (!modelUsage || typeof modelUsage !== "object" || typeof selected !== "string" || !selected) return null;
  const keys = Object.keys(modelUsage);
  if (selected.startsWith("claude-")) {
    return keys.find((key) => key === selected || key.startsWith(`${selected}[`)) ?? null;
  }
  const needle = selected.toLowerCase();
  const matches = keys.filter((key) => key.toLowerCase().includes(needle));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // More than one match: the entry with the most output tokens actually produced the answer.
  return matches.reduce((best, key) => {
    const tokens = (entry) => Number(modelUsage[entry]?.outputTokens) || 0;
    return tokens(key) > tokens(best) ? key : best;
  });
};

/**
 * Parse a canonical model id into a truthful human label — "Sonnet 5", "Opus 5.5",
 * "Haiku 4.5" (a dated snapshot stamp is dropped). NEVER invents a version: an id that
 * does not match the expected shape returns `null` and every caller falls back to the
 * alias label rather than guessing.
 */
export const canonicalModelLabel = (canonicalId) => parseClaudeCanonicalId(canonicalId)?.label ?? null;

/**
 * Discover what the installed `claude` CLI supports, right now, with no model tokens:
 * one local `--help` (flags + effort levels) and the model catalog (cache, else one local
 * `initialize` probe). Returns a value object rather than throwing: "the CLI is missing"
 * is an ORDINARY state every caller must render as "not supported", never crash on.
 */
export const discoverClaudeCapabilities = async ({
  command = "claude",
  env = process.env,
  timeoutMs = 10_000,
  // Injectable so tests exercise the real parsing logic against FAKE output, without
  // spawning the installed CLI.
  run,
  // `probe` yields normalized catalog rows. When `run` is faked and no `probe` is given the
  // catalog is skipped (help-only), so a unit test never reaches the real binary.
  probe,
  cacheFile,
  refresh = false,
  now = Date.now(),
} = {}) => {
  const binary = findClaudeExecutable(command, env);
  if (!binary) return { ...EMPTY_CAPABILITIES, binary: null };
  const runHelp = run ?? ((bin, args) => execFileAsync(bin, args, { timeout: timeoutMs, encoding: "utf8" }));
  let help;
  try {
    const { stdout } = await runHelp(binary, ["--help"]);
    help = parseClaudeHelp(stdout);
  } catch {
    return { ...EMPTY_CAPABILITIES, binary };
  }

  const probeFn = probe !== undefined ? probe
    : (run ? null : (bin) => probeClaudeModelCatalog({ binary: bin, env }));
  const cachePath = cacheFile !== undefined ? cacheFile
    : (probe === undefined && !run ? defaultCatalogCacheFile("claude", env) : null);
  const identity = binaryIdentity(binary);

  let rows = null;
  let defaultFromRows = null;
  let source = CLAUDE_CATALOG_SOURCE.none;
  if (probeFn) {
    const cached = refresh ? null : await readCatalogCache(cachePath, identity, { now });
    if (cached) {
      rows = cached.catalog.models;
      source = CLAUDE_CATALOG_SOURCE.cache;
    } else {
      try {
        rows = await probeFn(binary);
        source = CLAUDE_CATALOG_SOURCE.sdk;
        await writeCatalogCache(cachePath, identity, { models: rows }, { now });
      } catch {
        const stale = await readCatalogCache(cachePath, identity, { now, allowStale: true });
        if (stale) {
          rows = stale.catalog.models;
          source = CLAUDE_CATALOG_SOURCE.staleCache;
        }
      }
    }
  }
  let models = [];
  if (rows) {
    const built = buildClaudeModelOptions(rows);
    models = built.options;
    defaultFromRows = built.defaultModel;
  } else if (help.modelFlagSupported) {
    // The catalog is unreachable: fall back to the aliases `--help` itself documents.
    models = help.supportedModels.map((alias) => ({
      id: alias, canonicalId: null, alias, family: alias, version: null,
      label: `Актуальный ${capitalize(alias)}`, resolvesToLabel: null,
      kind: MODEL_KINDS.alias, selectable: true, disabledReason: null, efforts: null,
    }));
    if (models.length) source = CLAUDE_CATALOG_SOURCE.help;
  }
  const selectable = models.filter((option) => option.selectable).map((option) => option.id);
  return {
    available: true,
    binary,
    modelFlagSupported: help.modelFlagPresent && selectable.length > 0,
    effortFlagSupported: help.effortFlagSupported,
    supportedModels: selectable,
    supportedEfforts: help.supportedEfforts,
    models,
    defaultModel: defaultFromRows,
    catalogSource: source,
  };
};
