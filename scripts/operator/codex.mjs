/**
 * codex.mjs — the ONE canonical place that answers two Codex questions:
 *
 *   1. which Codex executable to run, and
 *   2. what the App Server `--listen` endpoint string looks like.
 *
 * Profile generation, doctor, the supervisor and the tests all go through here, so they
 * cannot disagree. Execution is always `executable + argv` with no shell.
 */
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Codex shipped inside the ChatGPT desktop app. This is a FALLBACK, never the only
 * supported installation: an explicit override and a PATH `codex` both win over it.
 */
export const MACOS_CHATGPT_CODEX_PATH =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

export const CODEX_SOURCES = Object.freeze({
  override: "configured-override",
  path: "path",
  chatgptBundle: "chatgpt-app-bundle",
});

const isExecutableFile = (candidate) => {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** PATH lookup without a shell. A value containing a separator is used verbatim. */
export const resolveOnPath = (command, env = process.env, isExecutable = isExecutableFile) => {
  if (typeof command !== "string" || !command.trim()) return null;
  const value = command.trim();
  if (value.includes("/")) return isExecutable(value) ? path.resolve(value) : null;
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, value);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
};

/**
 * Deterministic Codex discovery, in the documented preferred order:
 *
 *   1. an explicit configured override, when it resolves to a real executable;
 *   2. `codex` on PATH;
 *   3. on macOS, the ChatGPT-bundled Codex CLI.
 *
 * Returns `{ path, source }` for the winner. An override that does not resolve does not
 * abort discovery — it is reported through `overrideIgnored` so `doctor` can surface it
 * instead of silently pretending it was honoured.
 */
export const discoverCodexExecutable = ({
  override = null,
  env = process.env,
  platform = process.platform,
  isExecutable = isExecutableFile,
  bundlePath = MACOS_CHATGPT_CODEX_PATH,
} = {}) => {
  const attempted = [];
  const configured = typeof override === "string" && override.trim() ? override.trim() : null;

  if (configured) {
    const resolved = resolveOnPath(configured, env, isExecutable);
    attempted.push({ source: CODEX_SOURCES.override, candidate: configured, ok: Boolean(resolved) });
    if (resolved) return { path: resolved, source: CODEX_SOURCES.override, overrideIgnored: null, attempted };
  }

  const onPath = resolveOnPath("codex", env, isExecutable);
  attempted.push({ source: CODEX_SOURCES.path, candidate: "codex", ok: Boolean(onPath) });
  if (onPath) {
    return { path: onPath, source: CODEX_SOURCES.path, overrideIgnored: configured, attempted };
  }

  if (platform === "darwin") {
    const ok = isExecutable(bundlePath);
    attempted.push({ source: CODEX_SOURCES.chatgptBundle, candidate: bundlePath, ok });
    if (ok) {
      return { path: bundlePath, source: CODEX_SOURCES.chatgptBundle, overrideIgnored: configured, attempted };
    }
  }

  return { path: null, source: null, overrideIgnored: configured, attempted };
};

/**
 * The canonical App Server endpoint for a unix-domain socket.
 *
 * `unix:/abs/path` is NOT the form the Codex CLI accepts; the proven working form has an
 * empty authority, so an absolute path produces three slashes: `unix:///abs/path`.
 */
export const unixEndpoint = (socketPath) => {
  if (typeof socketPath !== "string" || !socketPath.trim()) throw new Error("codex-socket-path-required");
  const absolute = path.resolve(socketPath.trim());
  return `unix://${absolute}`;
};

/**
 * Repair a `unix:`-scheme argument into the canonical three-slash form. This keeps an
 * older or hand-edited profile that still says `unix:{socket}` from silently emitting
 * the broken two-slash endpoint.
 */
export const normalizeUnixEndpointArg = (arg) => {
  if (typeof arg !== "string") return arg;
  const match = /^unix:(\/+)(.*)$/.exec(arg);
  if (!match) return arg;
  const remainder = match[2];
  if (!remainder) return arg;
  return `unix:///${remainder.replace(/^\/+/, "")}`;
};

export const DEFAULT_CODEX_APP_SERVER_ARGS = Object.freeze(["app-server", "--listen", "{endpoint}"]);

/**
 * Build the exact argv for the Codex App Server this project owns.
 *
 * `{endpoint}` expands to the canonical `unix:///...` endpoint and `{socket}` to the raw
 * path; every produced argument is then normalized, so the canonical endpoint wins no
 * matter which placeholder the profile used.
 */
export const codexAppServerCommand = (project, socketPath, { env = process.env, platform = process.platform, isExecutable = isExecutableFile, bundlePath = MACOS_CHATGPT_CODEX_PATH } = {}) => {
  const spec = project?.codexAppServer || {};
  const discovery = discoverCodexExecutable({ override: spec.command, env, platform, isExecutable, bundlePath });
  const endpoint = unixEndpoint(socketPath);
  const absoluteSocket = path.resolve(socketPath);
  const template = Array.isArray(spec.args) && spec.args.length > 0 ? spec.args : DEFAULT_CODEX_APP_SERVER_ARGS;
  const args = template.map((arg) =>
    normalizeUnixEndpointArg(String(arg).replaceAll("{endpoint}", endpoint).replaceAll("{socket}", absoluteSocket)));
  return { command: discovery.path, args, endpoint, discovery };
};
