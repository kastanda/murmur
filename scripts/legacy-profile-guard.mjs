/**
 * legacy-profile-guard.mjs — a LEGACY profile (`<repo>/.data-*`, no project id) must never
 * carry new work unless the caller said so.
 *
 * `murmur-shell-send.mjs` takes whatever `DATA_DIR` it is given. An agent working inside a
 * modern project that points it at `.data-codex` sends on the shared legacy subject
 * (`msg.claude`) into the legacy Claude profile instead of the project's own agents. The
 * only profiles that are project-scoped live at `$MURMUR_HOME/projects/<id>/agents/<name>`.
 * Everything else is legacy and is refused unless `MURMUR_ALLOW_LEGACY_PROFILE=1`
 * (explicit opt-in) — and always refused under `MURMUR_REQUIRE_PROJECT_PROFILE=1`.
 */
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT_PROFILE = /^projects[\\/]([^\\/]+)[\\/]agents[\\/][^\\/]+$/;
const truthy = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

const canonical = (target) => {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

/** `{ kind: "project", projectId } | { kind: "legacy", projectId: null }` for a data directory. */
export const classifyProfile = (dataDir, env = process.env, homeDir = os.homedir()) => {
  const absolute = canonical(dataDir);
  const murmurHome = canonical(env.MURMUR_HOME?.trim() || path.join(homeDir, ".murmur"));
  // Exactly `<MURMUR_HOME>/projects/<id>/agents/<name>` — nothing nested or prefixed.
  const match = path.relative(murmurHome, absolute).match(PROJECT_PROFILE);
  if (match) return { kind: "project", projectId: match[1], dataDir: absolute };
  return { kind: "legacy", projectId: null, dataDir: absolute };
};

/** Returns `null` when the send may proceed, else a refusal `{ code, message }`. */
export const legacyProfileRefusal = (dataDir, env = process.env, homeDir = os.homedir()) => {
  const profile = classifyProfile(dataDir, env, homeDir);
  if (profile.kind === "project") return null;
  if (truthy(env.MURMUR_REQUIRE_PROJECT_PROFILE)) {
    return { code: "legacy-profile-rejected", message: "DATA_DIR is a legacy (project-less) profile and a project profile is required" };
  }
  if (truthy(env.MURMUR_ALLOW_LEGACY_PROFILE)) return null;
  return {
    code: "legacy-profile-rejected",
    message: "DATA_DIR is a legacy (project-less) profile; use the project profile (~/.murmur/projects/<id>/agents/<agent>) or set MURMUR_ALLOW_LEGACY_PROFILE=1 to send on the legacy profile deliberately",
  };
};

/**
 * The outbox this send writes must be the profile's own `<DATA_DIR>/murmur.db`. A project
 * DATA_DIR paired with `MURMUR_STORE_PATH=<legacy>/murmur.db` would otherwise put the row in a
 * legacy archive while the receipt names the project.
 */
export const storePathRefusal = (dataDir, storePath) => {
  if (storePath === undefined || storePath === "") return null;
  // canonicalise the directory: the file itself may not exist yet, and /var -> /private/var must not matter
  if (path.join(canonical(path.dirname(storePath)), path.basename(storePath)) === path.join(canonical(dataDir), "murmur.db")) return null;
  return { code: "profile-binding-invalid", message: "MURMUR_STORE_PATH is not this profile's murmur.db" };
};
