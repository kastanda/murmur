/**
 * cursor.mjs — operator surface for Cursor model VISIBILITY.
 *
 *   murmur cursor <project> config [--json]
 *
 * There is deliberately no `murmur cursor <project> model <id>` writer. The installed
 * Cursor ACP server's model selection (`session/set_model`) is a real, working protocol
 * method — but it was proven, by live local probing, to mutate the operator's own
 * GLOBAL Cursor configuration (`~/.cursor/cli-config.json`), not anything scoped to a
 * Murmur project. Adding a per-project selector here would silently reach outside Murmur
 * into the operator's personal Cursor settings, with no way to undo that scoping — so
 * this module only ever reads and displays, exactly like `murmur claude <project> config`
 * does for Claude's "inherit" case. See `cursor-config.mjs`'s header for the full
 * evidence trail.
 */
import os from "node:os";
import path from "node:path";
import { cursorCliConfigPath, resolveCursorModelInfo } from "./cursor-config.mjs";
import { agentByName, loadProfile, profileExists } from "./profile.mjs";
import { locateProject, murmurHome } from "./project.mjs";

export const CURSOR_USAGE = `murmur cursor — Cursor model visibility (read-only)

Usage:
  murmur cursor <project> config [--json]

Murmur does NOT offer a Cursor model selector. The installed Cursor ACP server's model
selection is a real protocol capability, but it changes the operator's own GLOBAL Cursor
configuration, not anything scoped to one Murmur project — so Murmur only displays what
Cursor itself is currently configured to use, and never writes to it. See
docs/cursor-model-discovery.md for the investigation this is based on.
`;

export const buildCursorConfigReport = async ({ homedir = os.homedir() } = {}) => {
  const cursor = await resolveCursorModelInfo({ cursorCliConfigPath: cursorCliConfigPath(homedir) });
  return { cursor };
};

const renderCursorConfigHuman = (out, report, projectArg) => {
  out(`Project: ${projectArg}`);
  out("");
  out(`Cursor: ${report.cursor.effectiveModelLabel ?? "по настройкам Cursor"}`);
  out("Источник: настройки Cursor (глобальные, не Murmur)");
  out("Murmur не управляет выбором модели Cursor — см. docs/cursor-model-discovery.md");
};

export const commandCursor = async ({
  args, flags, out, err, env = process.env, home = undefined,
  // Injectable so tests can point at a fixture `~/.cursor/cli-config.json` instead of
  // reading (and never touching) the real operator homedir.
  cursorHomedir = os.homedir(),
}) => {
  const projectArg = args[0];
  if (!projectArg) {
    err("murmur: cursor requires <project>");
    err(CURSOR_USAGE);
    return 1;
  }
  const subcommand = args[1];
  if (!subcommand || subcommand === "help") {
    out(CURSOR_USAGE);
    return subcommand ? 0 : 1;
  }

  let projectPath, paths;
  try {
    ({ projectPath, paths } = locateProject(projectArg, { home: home ?? murmurHome(env) }));
  } catch (error) {
    err(`murmur: ${error.message}`);
    return 1;
  }

  if (!(await profileExists(paths))) {
    err("murmur: no profile for this project. Run `murmur start <project>` first.");
    return 3;
  }
  const project = await loadProfile(paths);
  if (!agentByName(project, "cursor")) {
    err("murmur: this project has no Cursor identity.");
    return 3;
  }

  if (subcommand === "config") {
    const report = await buildCursorConfigReport({ homedir: cursorHomedir });
    if (flags.json) {
      out(JSON.stringify({ project: path.basename(projectPath), ...report }, null, 2));
      return 0;
    }
    renderCursorConfigHuman(out, report, projectArg);
    return 0;
  }

  if (subcommand === "model") {
    err("murmur: Cursor model selection is not offered by Murmur.");
    err("The installed Cursor ACP server's model selection changes the operator's own");
    err("global Cursor configuration, not anything scoped to this project — Murmur only");
    err("displays what Cursor itself is using. Run `murmur cursor <project> config` to see it.");
    return 1;
  }

  err(`murmur: unknown cursor subcommand '${subcommand}'`);
  err(CURSOR_USAGE);
  return 1;
};
