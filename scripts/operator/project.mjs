/**
 * project.mjs — project resolution and the deterministic project identity used to
 * locate user-level Murmur state.
 *
 * NOTHING in here writes into the project repository. A project directory is an
 * INPUT: Murmur only reads its canonical path and uses it as the working directory
 * for the agent runtimes.
 */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where a bare `<project>` name is resolved, per the operator policy. */
export const defaultProjectsRoot = (homedir = os.homedir()) => path.join(homedir, "Projects");

/** User-level Murmur state root. Never inside a project repository. */
export const murmurHome = (env = process.env, homedir = os.homedir()) => {
  const override = typeof env.MURMUR_HOME === "string" ? env.MURMUR_HOME.trim() : "";
  return override ? path.resolve(override) : path.join(homedir, ".murmur");
};

/**
 * A bare project NAME must stay a single directory entry under ~/Projects. Anything
 * with a path separator, or a `.`/`..` component, has to be passed as an explicit
 * absolute path — that is the whole path-injection boundary for `<project>`.
 */
const assertPlainProjectName = (name) => {
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`project-name-must-be-plain:${name}`);
  }
  if (name === "." || name === "..") throw new Error(`project-name-must-be-plain:${name}`);
};

const expandHome = (value, homedir) => {
  if (value === "~") return homedir;
  if (value.startsWith("~/")) return path.join(homedir, value.slice(2));
  return value;
};

/**
 * Resolve `<project>` to a canonical, existing project directory.
 *
 * - absolute path (or `~/...`) -> used as given;
 * - bare name -> `<projectsRoot>/<name>` (default `~/Projects/<name>`).
 */
export const resolveProject = (input, { projectsRoot, homedir = os.homedir() } = {}) => {
  if (typeof input !== "string" || !input.trim()) throw new Error("project-required");
  const raw = input.trim();
  if (raw.includes("\0")) throw new Error("project-invalid");
  const expanded = expandHome(raw, homedir);

  let candidate;
  if (path.isAbsolute(expanded)) {
    candidate = path.normalize(expanded);
  } else {
    assertPlainProjectName(expanded);
    candidate = path.join(projectsRoot || defaultProjectsRoot(homedir), expanded);
  }

  let stats;
  try {
    stats = statSync(candidate);
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error(`project-not-found:${candidate}`);
    throw err;
  }
  if (!stats.isDirectory()) throw new Error(`project-not-a-directory:${candidate}`);

  // realpath where possible; a resolvable path that cannot be canonicalized (permissions)
  // still yields a usable normalized absolute path.
  let canonical;
  try {
    canonical = realpathSync.native ? realpathSync.native(candidate) : realpathSync(candidate);
  } catch {
    canonical = candidate;
  }
  return { input: raw, projectPath: canonical };
};

/** Stable, filesystem-safe id derived ONLY from the canonical project path. */
export const projectIdFor = (projectPath) => {
  if (typeof projectPath !== "string" || !projectPath) throw new Error("project-path-required");
  const digest = createHash("sha256").update(projectPath, "utf8").digest("hex").slice(0, 12);
  const slug = path
    .basename(projectPath)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16)
    .replace(/-+$/g, "");
  return `${slug || "project"}-${digest}`;
};

/** Every state path this project owns. All of it lives under the Murmur home. */
export const projectPathsFor = (projectId, { home = murmurHome() } = {}) => {
  const root = path.join(home, "projects", projectId);
  const runDir = path.join(root, "run");
  const logsDir = path.join(root, "logs");
  const agentsDir = path.join(root, "agents");
  return {
    home,
    root,
    projectFile: path.join(root, "project.json"),
    // Per-project RUNTIME POLICY — which Claude model/effort this project's Claude
    // identity should use. Deliberately its OWN file, separate from every
    // `agent-config.json` (which holds private signing/encryption keys) and from
    // `project.json` (which can hold a NATS token): this file holds no credential of any
    // kind, ever, so it can be read/written freely by the operator CLI and the menu bar
    // app without going anywhere near key material.
    claudePreferencesFile: path.join(root, "claude-preferences.json"),
    agentsDir,
    agentDir: (agentName) => path.join(agentsDir, agentName),
    agentConfigFile: (agentName) => path.join(agentsDir, agentName, "agent-config.json"),
    agentDbFile: (agentName) => path.join(agentsDir, agentName, "murmur.db"),
    runDir,
    supervisorFile: path.join(runDir, "supervisor.json"),
    lockFile: path.join(runDir, "supervisor.lock"),
    bootstrapLockFile: path.join(runDir, "bootstrap.lock"),
    // Durable cross-process exclusion for the window between "the CLI is about to spawn a
    // supervisor" and "that supervisor holds the authoritative lock". See runstate.mjs.
    launchGuardFile: path.join(runDir, "launch.guard"),
    codexSocket: path.join(runDir, "codex.sock"),
    logsDir,
    logFile: (name) => path.join(logsDir, `${name}.log`),
  };
};

/** Convenience: resolve + identify + locate in one call. */
export const locateProject = (input, options = {}) => {
  const { projectPath } = resolveProject(input, options);
  const projectId = projectIdFor(projectPath);
  return { projectPath, projectId, paths: projectPathsFor(projectId, { home: options.home ?? murmurHome(options.env) }) };
};

/**
 * macOS caps `sockaddr_un.sun_path` at 104 bytes. A profile whose run directory is
 * deeper than that cannot host the Codex App Server socket, and that must be an
 * explicit diagnostic instead of a confusing bind failure.
 */
export const UNIX_SOCKET_PATH_MAX = 104;
export const socketPathFits = (socketPath) => Buffer.byteLength(socketPath, "utf8") < UNIX_SOCKET_PATH_MAX;
