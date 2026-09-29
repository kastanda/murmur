import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { peerSupportsHandoffV1 } from "@murmurv2/core";
import { readPrivateJson, writePrivateJson } from "../scripts/secure-state.mjs";
import {
  COORDINATOR,
  DEFAULT_AGENTS,
  DEFAULT_TRUST_EDGES,
  agentIdFor,
  bootstrapProfile,
  enabledAgents,
  loadProfile,
  peersForAgent,
  profileExists,
  publicProfileSummary,
} from "../scripts/operator/profile.mjs";
import { codexAppServerCommand } from "../scripts/operator/codex.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const setup = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-operator-profile-"));
  const projectPath = path.join(dir, "project");
  const home = path.join(dir, "home", ".murmur");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  return { dir, projectPath, projectId, paths: projectPathsFor(projectId, { home }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("bootstrap creates the default four-agent topology with isolated data dirs", async () => {
  const ctx = setup();
  try {
    const result = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    assert.equal(result.created, true);
    assert.deepEqual(result.createdAgents, ["root", "claude", "codex", "cursor"]);
    assert.equal(result.project.coordinator, COORDINATOR);

    const dirs = readdirSync(ctx.paths.agentsDir).sort();
    assert.deepEqual(dirs, ["claude", "codex", "cursor", "root"]);
    for (const agent of DEFAULT_AGENTS) {
      const config = await readPrivateJson(ctx.paths.agentConfigFile(agent.name));
      assert.equal(config.agentId, agentIdFor(ctx.projectId, agent.name));
      assert.equal(config.subject, `msg.${config.agentId}`);
      assert.equal(path.resolve(config.dataDir), path.resolve(ctx.paths.agentDir(agent.name)));
      assert.ok(config.keys.encryption.privateKey && config.keys.signing.privateKey);
      assert.equal(statSync(ctx.paths.agentConfigFile(agent.name)).mode & 0o777, 0o600);
    }
  } finally {
    ctx.cleanup();
  }
});

test("only handoff-capable agents advertise protocol 1.1 + handoff-v1", async () => {
  const ctx = setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const root = await readPrivateJson(ctx.paths.agentConfigFile("root"));
    const claude = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    assert.deepEqual(root.protocolVersions, ["1.0"]);
    assert.deepEqual(root.features, []);
    assert.ok(claude.protocolVersions.includes("1.1"));
    assert.ok(claude.features.includes("handoff-v1"));

    // Claude can delegate to both workers, and to nobody else.
    for (const worker of ["codex", "cursor"]) {
      assert.ok(peerSupportsHandoffV1(claude.peers[agentIdFor(ctx.projectId, worker)]), worker);
    }
    assert.equal(peerSupportsHandoffV1(claude.peers[agentIdFor(ctx.projectId, "root")]), false);
  } finally {
    ctx.cleanup();
  }
});

test("pairing implements exactly the worker mesh: codex<->cursor paired, root coordinator-only", async () => {
  const ctx = setup();
  try {
    const { project } = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    assert.deepEqual(project.trustEdges, DEFAULT_TRUST_EDGES.map((edge) => [...edge]));
    assert.deepEqual(peersForAgent("claude").sort(), ["codex", "cursor", "root"]);
    assert.deepEqual(peersForAgent("codex").sort(), ["claude", "cursor"]);
    assert.deepEqual(peersForAgent("cursor").sort(), ["claude", "codex"]);

    // Root stays the coordinator's counterpart and NOTHING else: a worker must never be
    // able to take work from, or answer directly to, the human operator slot.
    assert.deepEqual(peersForAgent("root"), ["claude"]);

    const root = await readPrivateJson(ctx.paths.agentConfigFile("root"));
    const codex = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    const cursor = await readPrivateJson(ctx.paths.agentConfigFile("cursor"));
    assert.deepEqual(Object.keys(root.peers), [agentIdFor(ctx.projectId, "claude")]);
    assert.equal(codex.peers[agentIdFor(ctx.projectId, "root")], undefined);
    assert.equal(cursor.peers[agentIdFor(ctx.projectId, "root")], undefined);

    // Pairing is mutual: each side holds the other's real public signing key.
    const claude = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    assert.equal(codex.peers[claude.agentId].signing.publicKey, claude.keys.signing.publicKey);
    assert.equal(claude.peers[codex.agentId].signing.publicKey, codex.keys.signing.publicKey);
    assert.equal(codex.peers[cursor.agentId].signing.publicKey, cursor.keys.signing.publicKey);
    assert.equal(cursor.peers[codex.agentId].signing.publicKey, codex.keys.signing.publicKey);
  } finally {
    ctx.cleanup();
  }
});

test("each runtime agent enables exactly one autonomous runtime, scoped to the project", async () => {
  const ctx = setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const expectations = {
      claude: "claudeOneShot",
      codex: "codexAppServer",
      cursor: "cursorAcp",
    };
    for (const [name, key] of Object.entries(expectations)) {
      const config = await readPrivateJson(ctx.paths.agentConfigFile(name));
      const enabled = Object.entries(config.runtime).filter(([, value]) => value.enabled === true);
      assert.equal(enabled.length, 1, name);
      assert.equal(enabled[0][0], key);
      assert.equal(enabled[0][1].cwd, ctx.projectPath);
      assert.equal(enabled[0][1].projectId, ctx.projectId);
    }
    const codex = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    assert.equal(codex.runtime.codexAppServer.socketPath, ctx.paths.codexSocket);
    const root = await readPrivateJson(ctx.paths.agentConfigFile("root"));
    assert.equal(root.runtime, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("bootstrap is idempotent and never rotates an existing identity", async () => {
  const ctx = setup();
  try {
    const first = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const before = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    const second = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const after = await readPrivateJson(ctx.paths.agentConfigFile("claude"));

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.repaired, false);
    assert.deepEqual(second.createdAgents, []);
    assert.deepEqual(after, before);
    assert.equal(second.project.createdAt, first.project.createdAt);
  } finally {
    ctx.cleanup();
  }
});

test("an interrupted bootstrap is completed without touching the identities that exist", async () => {
  const ctx = setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const keptRoot = await readPrivateJson(ctx.paths.agentConfigFile("root"));
    rmSync(ctx.paths.agentDir("cursor"), { recursive: true, force: true });
    rmSync(ctx.paths.projectFile, { force: true });

    const repaired = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    assert.equal(repaired.created, true);
    assert.deepEqual(repaired.createdAgents, ["cursor"]);

    const rootAfter = await readPrivateJson(ctx.paths.agentConfigFile("root"));
    assert.equal(rootAfter.keys.signing.privateKey, keptRoot.keys.signing.privateKey);
    const claudeAfter = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    const cursorAfter = await readPrivateJson(ctx.paths.agentConfigFile("cursor"));
    // Pairing was re-derived so Claude holds the NEW cursor key, not a stale one.
    assert.equal(claudeAfter.peers[cursorAfter.agentId].signing.publicKey, cursorAfter.keys.signing.publicKey);
  } finally {
    ctx.cleanup();
  }
});

test("two projects get independent profiles, identities and NATS subjects", async () => {
  const a = setup();
  const b = setup();
  try {
    await bootstrapProfile({ projectId: a.projectId, projectPath: a.projectPath, paths: a.paths });
    await bootstrapProfile({ projectId: b.projectId, projectPath: b.projectPath, paths: b.paths });
    const claudeA = await readPrivateJson(a.paths.agentConfigFile("claude"));
    const claudeB = await readPrivateJson(b.paths.agentConfigFile("claude"));
    assert.notEqual(claudeA.agentId, claudeB.agentId);
    assert.notEqual(claudeA.subject, claudeB.subject);
    assert.notEqual(claudeA.keys.signing.publicKey, claudeB.keys.signing.publicKey);
    assert.notEqual(claudeA.runtime.claudeOneShot.cwd, claudeB.runtime.claudeOneShot.cwd);
    assert.notEqual(a.paths.codexSocket, b.paths.codexSocket);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("bootstrap writes nothing into the project repository", async () => {
  const ctx = setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    assert.deepEqual(readdirSync(ctx.projectPath), []);
    assert.equal(ctx.paths.root.startsWith(ctx.projectPath), false);
  } finally {
    ctx.cleanup();
  }
});

test("no private key material leaks into the project file or a public summary", async () => {
  const ctx = setup();
  try {
    const { project } = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const raw = readFileSync(ctx.paths.projectFile, "utf8");
    assert.equal(raw.includes("privateKey"), false);
    assert.equal(raw.includes("publicKey"), false);
    const summary = JSON.stringify(publicProfileSummary({ ...project, natsToken: "super-secret" }));
    assert.equal(summary.includes("super-secret"), false);
    assert.equal(summary.includes("privateKey"), false);
    assert.match(summary, /"natsTokenConfigured":true/);
  } finally {
    ctx.cleanup();
  }
});

test("loadProfile rejects an unsupported profile version", async () => {
  const ctx = setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    assert.equal(await profileExists(ctx.paths), true);
    const project = await loadProfile(ctx.paths);
    assert.equal(project.version, 1);
    await writePrivateJson(ctx.paths.projectFile, { ...project, version: 99 });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:version-unsupported:99/);
  } finally {
    ctx.cleanup();
  }
});

test("disabling an optional agent removes it from the active topology", async () => {
  const ctx = setup();
  try {
    const { project } = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    await writePrivateJson(ctx.paths.projectFile, {
      ...project,
      agents: project.agents.map((agent) => (agent.name === "codex" ? { ...agent, enabled: false } : agent)),
    });
    const reloaded = await loadProfile(ctx.paths);
    assert.deepEqual(enabledAgents(reloaded).map((agent) => agent.name), ["root", "claude", "cursor"]);

    // A re-run must not silently re-enable it.
    const again = await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    assert.equal(again.project.agents.find((agent) => agent.name === "codex").enabled, false);

    // The operator identity and the coordinator are not optional.
    await writePrivateJson(ctx.paths.projectFile, {
      ...project,
      agents: project.agents.map((agent) => (agent.name === "claude" ? { ...agent, enabled: false } : agent)),
    });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:required-agent-disabled:claude/);
  } finally {
    ctx.cleanup();
  }
});

test("the Codex App Server command uses the profile-owned socket as a canonical unix:/// endpoint", () => {
  const fakeCodex = "/fake/bin/codex";
  const isExecutable = (candidate) => candidate === fakeCodex;
  const built = codexAppServerCommand({ codexAppServer: { command: fakeCodex } }, "/run/x.sock", { isExecutable, env: { PATH: "" } });
  assert.deepEqual(built.args, ["app-server", "--listen", "unix:///run/x.sock"]);
  assert.equal(built.command, fakeCodex);
  // A profile still carrying the old two-slash template is normalized, not obeyed.
  const legacy = codexAppServerCommand(
    { codexAppServer: { command: fakeCodex, args: ["app-server", "--listen", "unix:{socket}"] } },
    "/run/y.sock",
    { isExecutable, env: { PATH: "" } },
  );
  assert.deepEqual(legacy.args, ["app-server", "--listen", "unix:///run/y.sock"]);
});
