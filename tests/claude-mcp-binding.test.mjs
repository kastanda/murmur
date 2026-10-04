/**
 * claude-mcp-binding.test.mjs — a Claude session's `murmur` MCP registration is bound to
 * the project's own modern profile, never a legacy one, and never another project's.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveProfileIdentity, assertRouting } from "../packages/mcp-server/dist/src/outbound.js";
import { buildClaudeMcpJson, buildClaudeMcpServer, inspectClaudeRegistrations, writeProjectMcpJson } from "../scripts/operator/claude-mcp.mjs";
import { projectIdFor } from "../scripts/operator/project.mjs";

const setup = () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mur-mcp-bind-")));
  const home = path.join(dir, ".murmur");
  const mk = (name) => { const p = path.join(dir, name); mkdirSync(p); return p; };
  return { dir, home, mk, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};
const root = "/opt/murmur";

test("resolved config binds the channel server to the project's own modern profile", () => {
  const t = setup();
  try {
    const projectPath = t.mk("murmur");
    const id = projectIdFor(projectPath);
    const entry = buildClaudeMcpServer({ projectPath, murmurRoot: root, home: t.home });
    assert.equal(entry.env.MURMUR_PROJECT_ID, id);
    assert.equal(entry.env.DATA_DIR, path.join(t.home, "projects", id, "agents", "claude"));
    assert.equal(entry.env.MURMUR_REQUIRE_PROJECT_PROFILE, "1");
    const identity = resolveProfileIdentity(entry.env.DATA_DIR, { MURMUR_HOME: t.home });
    assert.deepEqual({ kind: identity.kind, projectId: identity.projectId }, { kind: "project", projectId: id });
    assert.notEqual(identity.kind, "legacy");
    assert.doesNotThrow(() => assertRouting(identity, { requestedProjectId: id, requireProject: true }));
  } finally { t.cleanup(); }
});

test("another project resolves to its own profile and cannot inherit this one's", () => {
  const t = setup();
  try {
    const a = t.mk("murmur");
    const b = t.mk("other");
    const ea = buildClaudeMcpServer({ projectPath: a, murmurRoot: root, home: t.home });
    const eb = buildClaudeMcpServer({ projectPath: b, murmurRoot: root, home: t.home });
    assert.notEqual(ea.env.DATA_DIR, eb.env.DATA_DIR);
    assert.notEqual(ea.env.MURMUR_PROJECT_ID, eb.env.MURMUR_PROJECT_ID);
    assert.equal(eb.env.MURMUR_PROJECT_ID, projectIdFor(b));
    const ib = resolveProfileIdentity(eb.env.DATA_DIR, { MURMUR_HOME: t.home });
    assert.throws(() => assertRouting(ib, { requestedProjectId: ea.env.MURMUR_PROJECT_ID }), /profile-mismatch/);
  } finally { t.cleanup(); }
});

test("a legacy local-scope registration is reported as shadowing; the canonical one is not", () => {
  const t = setup();
  try {
    const projectPath = t.mk("murmur");
    const expected = buildClaudeMcpServer({ projectPath, murmurRoot: root, home: t.home });
    const legacy = { type: "stdio", command: "node", args: ["x"], env: { DATA_DIR: `${projectPath}/.data-claude` } };
    const bad = inspectClaudeRegistrations({ projects: { [projectPath]: { mcpServers: { murmur: legacy } } } }, { projectPath, expected });
    assert.deepEqual(bad.map((r) => [r.scope, r.shadowing]), [["local", true]]);
    const good = inspectClaudeRegistrations({ projects: { [projectPath]: { mcpServers: { murmur: expected } } } }, { projectPath, expected });
    assert.equal(good[0].shadowing, false);
  } finally { t.cleanup(); }
});

test("writeProjectMcpJson writes the canonical document", async () => {
  const t = setup();
  try {
    const projectPath = t.mk("murmur");
    const doc = buildClaudeMcpJson({ projectPath, murmurRoot: root, home: t.home });
    const file = await writeProjectMcpJson(projectPath, doc);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), doc);
  } finally { t.cleanup(); }
});
