/**
 * agent-models.mjs — the common representation of "which model can this agent run".
 *
 * Every agent (Claude, Codex) feeds the operator surface and the menu bar the SAME option
 * shape, so labels, selectability and the disabled-reason story are decided in exactly
 * one place and Swift never has to parse a model id.
 *
 *   {
 *     id:             machine value — the ONLY thing that may ever reach a runtime argv/protocol field
 *     canonicalId:    the concrete model id this option runs ("claude-sonnet-5-5"); null if not known
 *     alias:          the moving alias that produced it ("sonnet"), or null for a concrete id
 *     family:         "sonnet" | "opus" | ... (derived from the canonical id; null if unknown)
 *     version:        "5.5" (derived from the canonical id; null if unknown)
 *     label:          human label, Russian where Murmur owns the wording
 *     resolvesToLabel: for an alias/inherit: the concrete model it currently resolves to
 *     kind:           "alias" | "pinned" | "inherit" | "catalog"
 *     selectable:     true only when the local catalog actually offers it
 *     disabledReason: why not, when selectable is false
 *     efforts:        reasoning/effort levels this model supports (null = not specified)
 *   }
 *
 * `alias` = a name the vendor CLI keeps pointing at "the latest in that tier" (moves over
 * time); `pinned` = one concrete version that never moves; `catalog` = a concrete id an
 * app-server catalog lists (Codex — it does not distinguish aliases); `inherit` = Murmur
 * passes NO override and the vendor tool's own configuration decides.
 *
 * Nothing here knows or guesses a model: options are built from authoritative local
 * evidence by the per-agent discovery modules.
 */
import os from "node:os";
import path from "node:path";
import { readPrivateJson, writePrivateJson } from "./secure-state.mjs";

export const INHERIT = "inherit";
export const MODEL_KINDS = Object.freeze({ alias: "alias", pinned: "pinned", inherit: "inherit", catalog: "catalog" });

/** Conservative shape of any model id/effort value that may reach a runtime. */
export const SAFE_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
export const isSafeValue = (value) => typeof value === "string" && SAFE_VALUE_PATTERN.test(value);

/**
 * The strict allowlist gate. A value is accepted only if it is `"inherit"` or the id of an
 * option the local catalog marks selectable. An arbitrary string — even a plausible
 * looking id — is rejected.
 */
export const isSelectableModelId = (value, options) =>
  value === INHERIT || (isSafeValue(value) && Array.isArray(options) && options.some((o) => o.id === value && o.selectable === true));

export const findOption = (options, id) => (Array.isArray(options) ? options.find((o) => o.id === id) || null : null);

export const capitalize = (value) => (typeof value === "string" && value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

/**
 * `claude-<family>-<major>[-<minor>][-<yyyymmdd>]` -> { family, version, label }. Returns
 * null for anything else — a version is never invented. A trailing 8-digit snapshot date
 * is a release stamp, not part of the version.
 */
export const parseClaudeCanonicalId = (canonicalId) => {
  if (typeof canonicalId !== "string") return null;
  const match = canonicalId.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (!match) return null;
  const [, family, major, minor] = match;
  const version = minor ? `${major}.${minor}` : major;
  return { family: family.toLowerCase(), version, label: `${capitalize(family.toLowerCase())} ${version}` };
};

/**
 * Catalog cache shared by the discovery modules: a JSON file under the Murmur home (never
 * inside a repository) keyed by an `identity` string that covers whatever invalidates it
 * (binary identity, relevant config stat). Holds only public model metadata.
 */
export const CATALOG_CACHE_VERSION = 1;
export const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export const readCatalogCache = async (file, identity, { now = Date.now(), ttlMs = DEFAULT_CATALOG_TTL_MS, allowStale = false } = {}) => {
  if (!file) return null;
  try {
    const raw = await readPrivateJson(file);
    if (raw?.version !== CATALOG_CACHE_VERSION || raw.identity !== identity || !raw.catalog) return null;
    const age = now - Date.parse(raw.fetchedAt);
    if (!Number.isFinite(age)) return null;
    if (age > ttlMs && !allowStale) return null;
    return { catalog: raw.catalog, fetchedAt: raw.fetchedAt, stale: age > ttlMs };
  } catch {
    return null;
  }
};

export const writeCatalogCache = async (file, identity, catalog, { now = Date.now() } = {}) => {
  if (!file) return;
  try {
    await writePrivateJson(file, { version: CATALOG_CACHE_VERSION, identity, fetchedAt: new Date(now).toISOString(), catalog });
  } catch {
    // Cache only: a failed write costs one extra probe next time, never a wrong answer.
  }
};

/** `~/.murmur/cache/agent-models/<agent>.json`, honouring MURMUR_HOME. */
export const defaultCatalogCacheFile = (agent, env = process.env, homedir = os.homedir()) => {
  const override = typeof env.MURMUR_HOME === "string" ? env.MURMUR_HOME.trim() : "";
  const home = override ? path.resolve(override) : path.join(homedir, ".murmur");
  return path.join(home, "cache", "agent-models", `${agent}.json`);
};
