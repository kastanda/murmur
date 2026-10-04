/**
 * claude-mcp.mjs — the canonical Claude Code MCP registration for ONE Murmur project.
 *
 * A Claude session launched from a project directory starts whatever `murmur` MCP server
 * Claude Code resolves for it. Claude Code resolves a server name local > project
 * (`.mcp.json`) > user, so a hand-made `claude mcp add murmur -e DATA_DIR=<repo>/.data-claude`
 * silently pins the session to a LEGACY profile. This module is the one place that says what
 * the registration must be: the send-side server bound to the project's own Claude agent
 * profile `~/.murmur/projects/<projectId>/agents/claude`, with the project id stated
 * explicitly and legacy-bound sends refused.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectIdFor, projectPathsFor } from "./project.mjs";

export const MCP_SERVER_NAME = "murmur";
export const MCP_SERVER_ENTRY = path.join("packages", "mcp-server", "dist", "src", "index.js");

/** The `mcpServers.murmur` entry for a project. Pure: derives everything from its inputs. */
export const buildClaudeMcpServer = ({ projectPath, murmurRoot, home, agent = "claude", node = "node" }) => {
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home });
  return {
    type: "stdio",
    command: node,
    args: [path.join(murmurRoot, MCP_SERVER_ENTRY)],
    env: {
      DATA_DIR: paths.agentDir(agent),
      MURMUR_PROJECT_ID: projectId,
      MURMUR_REQUIRE_PROJECT_PROFILE: "1",
    },
  };
};

export const buildClaudeMcpJson = (options) => ({
  mcpServers: { [MCP_SERVER_NAME]: buildClaudeMcpServer(options) },
});

/**
 * Registrations in a parsed `~/.claude.json` that would take part in resolving `murmur` for
 * this project, with the scope Claude Code resolves them under. `shadowing` is true for a
 * local-scope entry (it outranks `.mcp.json`) that does not equal the canonical entry.
 */
export const inspectClaudeRegistrations = (claudeJson, { projectPath, expected }) => {
  const same = (entry) => JSON.stringify(entry?.env ?? null) === JSON.stringify(expected.env)
    && JSON.stringify(entry?.args ?? null) === JSON.stringify(expected.args);
  const found = [];
  const local = claudeJson?.projects?.[projectPath]?.mcpServers?.[MCP_SERVER_NAME];
  if (local) found.push({ scope: "local", dataDir: local.env?.DATA_DIR ?? null, shadowing: !same(local) });
  const user = claudeJson?.mcpServers?.[MCP_SERVER_NAME];
  if (user) found.push({ scope: "user", dataDir: user.env?.DATA_DIR ?? null, shadowing: false });
  return found;
};

/** Atomically write `<projectPath>/.mcp.json`. */
export const writeProjectMcpJson = async (projectPath, document) => {
  const target = path.join(projectPath, ".mcp.json");
  await mkdir(projectPath, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
  return target;
};
