/**
 * legacy-routing-guard.test.mjs — modern project traffic can never fall back to a legacy
 * (`.data-*`) profile, and a legacy send is only possible when asked for explicitly.
 */
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";
import { createKeyPair, createSigningKeyPair } from "../packages/security/dist/src/index.js";
import { SQLiteDedupeOutboxStore } from "../packages/core/dist/src/index.js";
import { assertRouting, modernProjectForCwd, resolveProfileIdentity } from "../packages/mcp-server/dist/src/outbound.js";
import { classifyProfile, legacyProfileRefusal } from "../scripts/legacy-profile-guard.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repoRoot, "scripts", "murmur-shell-send.mjs");

const world = async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mur-legacy-guard-")));
  const home = path.join(base, ".murmur");
  const profile = async (dir, agentId, peerId, subject) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const peerEnc = await createKeyPair();
    const peerSig = await createSigningKeyPair();
    writeFileSync(path.join(dir, "agent-config.json"), JSON.stringify({
      agentId,
      keys: { encryption: await createKeyPair(), signing: await createSigningKeyPair() },
      peers: { [peerId]: { subject, encryption: { publicKey: peerEnc.publicKey }, signing: { publicKey: peerSig.publicKey } } },
    }), { mode: 0o600 });
  };
  const legacy = path.join(base, "repo", ".data-codex");
  await profile(legacy, "codex", "claude", "msg.claude");
  const projectDir = path.join(home, "projects", "ribambelle-x-1", "agents", "codex");
  await profile(projectDir, "ribambelle-x-1-codex", "ribambelle-x-1-claude", "msg.ribambelle-x-1-claude");
  return { base, home, legacy, projectDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
};

const send = (dataDir, to, env = {}) => {
  const clean = { ...process.env };
  for (const key of ["MURMUR_ALLOW_LEGACY_PROFILE", "MURMUR_REQUIRE_PROJECT_PROFILE", "MURMUR_STORE_PATH", "MURMUR_HOME"]) delete clean[key];
  return spawnSync(process.execPath, [script, "--to", to, "--text", "ROUTING-SMOKE"], {
    cwd: repoRoot, encoding: "utf8", env: { ...clean, DATA_DIR: dataDir, ...env },
  });
};
const fingerprint = (dir) => {
  const dbPath = path.join(dir, "murmur.db");
  try { return createHash("sha256").update(readFileSync(dbPath)).digest("hex"); } catch { return "absent"; }
};

test("shell send refuses a legacy DATA_DIR by default and writes nothing", async () => {
  const w = await world();
  try {
    const before = fingerprint(w.legacy);
    const result = send(w.legacy, "claude", { MURMUR_HOME: w.home });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /legacy-profile-rejected/);
    assert.equal(fingerprint(w.legacy), before);
  } finally { w.cleanup(); }
});

test("legacy send still works when explicitly requested, unless a project profile is required", async () => {
  const w = await world();
  try {
    const ok = send(w.legacy, "claude", { MURMUR_HOME: w.home, MURMUR_ALLOW_LEGACY_PROFILE: "1" });
    assert.equal(ok.status, 0, ok.stderr);
    const queued = JSON.parse(ok.stdout.trim().split("\n").pop());
    const record = await new SQLiteDedupeOutboxStore(path.join(w.legacy, "murmur.db")).getOutboxRecord(queued.msgId);
    assert.equal(record.subject, "msg.claude");
    const required = send(w.legacy, "claude", { MURMUR_HOME: w.home, MURMUR_ALLOW_LEGACY_PROFILE: "1", MURMUR_REQUIRE_PROJECT_PROFILE: "1" });
    assert.equal(required.status, 3);
  } finally { w.cleanup(); }
});

test("modern codex -> claude stays on the project subject and leaves the legacy DB untouched", async () => {
  const w = await world();
  try {
    const before = fingerprint(w.legacy);
    const result = send(w.projectDir, "ribambelle-x-1-claude", { MURMUR_HOME: w.home });
    assert.equal(result.status, 0, result.stderr);
    const queued = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(queued.conversationId, "dm:ribambelle-x-1-codex:ribambelle-x-1-claude");
    const record = await new SQLiteDedupeOutboxStore(path.join(w.projectDir, "murmur.db")).getOutboxRecord(queued.msgId);
    assert.equal(record.subject, "msg.ribambelle-x-1-claude");
    assert.equal(fingerprint(w.legacy), before);
    // the generic legacy recipient does not exist in a project profile: no cross-over
    const generic = send(w.projectDir, "claude", { MURMUR_HOME: w.home });
    assert.notEqual(generic.status, 0);
    assert.match(generic.stderr, /unknown peer/);
  } finally { w.cleanup(); }
});

test("profile classification: only ~/.murmur/projects/<id>/agents/<name> is a project profile", async () => {
  const w = await world();
  try {
    assert.equal(classifyProfile(w.projectDir, { MURMUR_HOME: w.home }).projectId, "ribambelle-x-1");
    assert.equal(classifyProfile(w.legacy, { MURMUR_HOME: w.home }).kind, "legacy");
    // a look-alike layout outside MURMUR_HOME is still legacy
    const fake = path.join(w.base, "other", "projects", "p", "agents", "codex");
    assert.equal(classifyProfile(fake, { MURMUR_HOME: w.home }).kind, "legacy");
    assert.equal(legacyProfileRefusal(w.projectDir, { MURMUR_HOME: w.home }), null);
  } finally { w.cleanup(); }
});

test("a legacy-bound MCP server inside a registered project is refused unless opted in", async () => {
  const w = await world();
  try {
    const projectPath = path.join(w.base, "Ribambelle Operations");
    mkdirSync(path.join(projectPath, "sub"), { recursive: true });
    writeFileSync(path.join(w.home, "projects", "ribambelle-x-1", "project.json"), JSON.stringify({ projectId: "ribambelle-x-1", projectPath }));
    const env = { MURMUR_HOME: w.home };
    assert.equal(modernProjectForCwd(path.join(projectPath, "sub"), env), "ribambelle-x-1");
    assert.equal(modernProjectForCwd(w.base, env), null);
    const legacy = resolveProfileIdentity(w.legacy, env);
    assert.throws(() => assertRouting(legacy, { cwdProjectId: "ribambelle-x-1" }), (e) => e.code === "legacy-profile-in-project");
    assert.doesNotThrow(() => assertRouting(legacy, { cwdProjectId: "ribambelle-x-1", allowLegacy: true }));
    assert.doesNotThrow(() => assertRouting(legacy, { cwdProjectId: null }));
    // a project-bound server is fine in its own project, and cannot carry another project's send
    const project = resolveProfileIdentity(w.projectDir, env);
    assert.doesNotThrow(() => assertRouting(project, { cwdProjectId: "ribambelle-x-1", requestedProjectId: "ribambelle-x-1" }));
    assert.throws(() => assertRouting(project, { requestedProjectId: "saby-1" }), (e) => e.code === "profile-mismatch");
  } finally { w.cleanup(); }
});

test("a project DATA_DIR cannot be paired with a legacy MURMUR_STORE_PATH", async () => {
  const w = await world();
  try {
    const before = fingerprint(w.legacy);
    const result = send(w.projectDir, "ribambelle-x-1-claude", { MURMUR_HOME: w.home, MURMUR_STORE_PATH: path.join(w.legacy, "murmur.db") });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /profile-binding-invalid/);
    assert.equal(fingerprint(w.legacy), before);
    assert.equal(fingerprint(w.projectDir), "absent");
    const own = send(w.projectDir, "ribambelle-x-1-claude", { MURMUR_HOME: w.home, MURMUR_STORE_PATH: path.join(w.projectDir, "murmur.db") });
    assert.equal(own.status, 0, own.stderr);
  } finally { w.cleanup(); }
});

test("only the exact <home>/projects/<id>/agents/<name> shape is a project profile", async () => {
  const w = await world();
  try {
    const nested = path.join(w.home, "archive", "projects", "p", "agents", "codex");
    assert.equal(classifyProfile(nested, { MURMUR_HOME: w.home }).kind, "legacy");
    assert.equal(resolveProfileIdentity(nested, { MURMUR_HOME: w.home }).kind, "legacy");
    assert.equal(resolveProfileIdentity(w.projectDir, { MURMUR_HOME: w.home }).kind, "project");
  } finally { w.cleanup(); }
});

test("a git worktree of a registered project is still inside that project", async () => {
  const w = await world();
  try {
    const projectPath = path.join(w.base, "Ribambelle Operations");
    mkdirSync(path.join(projectPath, ".git", "worktrees", "feat"), { recursive: true });
    writeFileSync(path.join(w.home, "projects", "ribambelle-x-1", "project.json"), JSON.stringify({ projectId: "ribambelle-x-1", projectPath }));
    const wt = path.join(w.base, "_worktrees", "Ribambelle Operations", "feat");
    mkdirSync(path.join(wt, "src"), { recursive: true });
    writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(projectPath, ".git", "worktrees", "feat")}\n`);
    const env = { MURMUR_HOME: w.home };
    assert.equal(modernProjectForCwd(path.join(wt, "src"), env), "ribambelle-x-1");
    const other = path.join(w.base, "_worktrees", "elsewhere");
    mkdirSync(other, { recursive: true });
    assert.equal(modernProjectForCwd(other, env), null);
  } finally { w.cleanup(); }
});
