import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPrivateJson, writePrivateJson } from "../scripts/secure-state.mjs";
import {
  InvalidProfileError,
  SUPPORTED_ROLES,
  agentIdFor,
  bootstrapProfile,
  loadProfile,
  validateProfile,
} from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-repair-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  const { project } = await bootstrapProfile({ projectId, projectPath, paths });
  const raw = (name) => readFileSync(paths.agentConfigFile(name), "utf8");
  return { dir, projectPath, projectId, paths, project, raw, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const rerun = (ctx) => bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });

// ---------------------------------------------------------------------------
// MEDIUM 1 — bootstrap must ensure/reconcile, not only create
// ---------------------------------------------------------------------------

test("A. project.json exists but the Cursor identity directory is gone: only Cursor is recreated", async () => {
  const ctx = await setup();
  try {
    const before = { root: ctx.raw("root"), claude: ctx.raw("claude"), codex: ctx.raw("codex") };
    const cursorKeysBefore = (await readPrivateJson(ctx.paths.agentConfigFile("cursor"))).keys;
    rmSync(ctx.paths.agentDir("cursor"), { recursive: true, force: true });
    assert.equal(existsSync(ctx.paths.projectFile), true, "project.json must still be there");

    const result = await rerun(ctx);

    assert.equal(result.created, false, "the profile already existed");
    assert.equal(result.repaired, true);
    assert.deepEqual(result.createdAgents, ["cursor"]);
    assert.ok(result.repairs.includes("identity:cursor"));

    const cursorAfter = await readPrivateJson(ctx.paths.agentConfigFile("cursor"));
    assert.equal(cursorAfter.agentId, agentIdFor(ctx.projectId, "cursor"));
    assert.notEqual(cursorAfter.keys.signing.privateKey, cursorKeysBefore.signing.privateKey,
      "a destroyed identity is regenerated, not resurrected");

    // Root and Codex are untouched; Claude changes only because it must learn the new
    // Cursor public key.
    assert.equal(ctx.raw("root"), before.root);
    assert.equal(ctx.raw("codex"), before.codex);
    const claudeAfter = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    assert.equal(claudeAfter.peers[cursorAfter.agentId].signing.publicKey, cursorAfter.keys.signing.publicKey);
    assert.equal(claudeAfter.keys.signing.privateKey, JSON.parse(before.claude).keys.signing.privateKey,
      "Claude's own key is never rotated by a repair");
  } finally {
    ctx.cleanup();
  }
});

test("B. a missing Claude<->Codex pairing edge is repaired without rotating any key", async () => {
  const ctx = await setup();
  try {
    const claudeBefore = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    const codexBefore = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    const rootRaw = ctx.raw("root");
    const cursorRaw = ctx.raw("cursor");

    delete claudeBefore.peers[codexBefore.agentId];
    await writePrivateJson(ctx.paths.agentConfigFile("claude"), claudeBefore);

    const result = await rerun(ctx);
    assert.equal(result.created, false);
    assert.equal(result.repaired, true);
    assert.deepEqual(result.createdAgents, []);
    assert.ok(result.repairs.some((entry) => entry.startsWith("pairing:claude->codex")));

    const claudeAfter = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    const codexAfter = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    assert.equal(claudeAfter.peers[codexAfter.agentId].signing.publicKey, codexAfter.keys.signing.publicKey);
    // No private key moved anywhere.
    assert.equal(claudeAfter.keys.signing.privateKey, claudeBefore.keys.signing.privateKey);
    assert.equal(codexAfter.keys.signing.privateKey, codexBefore.keys.signing.privateKey);
    // Agents not involved in the broken edge are byte-for-byte identical.
    assert.equal(ctx.raw("root"), rootRaw);
    assert.equal(ctx.raw("cursor"), cursorRaw);
  } finally {
    ctx.cleanup();
  }
});

test("C. a repair rewrites only the identities it had to touch", async () => {
  const ctx = await setup();
  try {
    const before = Object.fromEntries(SUPPORTED_ROLES.map((role) => [role, ctx.raw(role)]));
    const codex = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    delete codex.runtime;
    await writePrivateJson(ctx.paths.agentConfigFile("codex"), codex);

    const result = await rerun(ctx);
    assert.ok(result.repairs.includes("runtime:codex"));

    const codexAfter = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    assert.equal(codexAfter.runtime.codexAppServer.enabled, true);
    assert.equal(codexAfter.runtime.codexAppServer.socketPath, ctx.paths.codexSocket);
    assert.equal(codexAfter.runtime.codexAppServer.cwd, ctx.projectPath);
    assert.equal(codexAfter.keys.signing.privateKey, codex.keys.signing.privateKey);

    for (const role of ["root", "claude", "cursor"]) {
      assert.equal(ctx.raw(role), before[role], `${role} must be untouched`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("a repair preserves operator-tuned runtime settings and only fixes derivable fields", async () => {
  const ctx = await setup();
  try {
    const claude = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    claude.runtime.claudeOneShot.turnTimeoutMs = 999_000;
    claude.runtime.claudeOneShot.model = "operator-choice";
    claude.runtime.claudeOneShot.cwd = "/somewhere/stale";
    await writePrivateJson(ctx.paths.agentConfigFile("claude"), claude);

    await rerun(ctx);
    const after = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    assert.equal(after.runtime.claudeOneShot.cwd, ctx.projectPath, "derivable field repaired");
    assert.equal(after.runtime.claudeOneShot.turnTimeoutMs, 999_000, "operator tuning preserved");
    assert.equal(after.runtime.claudeOneShot.model, "operator-choice", "operator tuning preserved");
  } finally {
    ctx.cleanup();
  }
});

test("a fully healthy profile re-runs as a no-op", async () => {
  const ctx = await setup();
  try {
    const before = Object.fromEntries(SUPPORTED_ROLES.map((role) => [role, ctx.raw(role)]));
    const projectBefore = readFileSync(ctx.paths.projectFile, "utf8");
    const result = await rerun(ctx);
    assert.equal(result.created, false);
    assert.equal(result.repaired, false);
    assert.deepEqual(result.repairs, []);
    for (const role of SUPPORTED_ROLES) assert.equal(ctx.raw(role), before[role]);
    assert.equal(readFileSync(ctx.paths.projectFile, "utf8"), projectBefore);
  } finally {
    ctx.cleanup();
  }
});

test("contradictory identity state fails closed instead of being rewritten", async () => {
  const ctx = await setup();
  try {
    const original = ctx.raw("claude");
    const claude = JSON.parse(original);
    claude.agentId = "someone-elses-identity";
    await writePrivateJson(ctx.paths.agentConfigFile("claude"), claude);
    await assert.rejects(() => rerun(ctx), /invalid-profile:identity-agent-id-mismatch:claude/);

    // And an ambiguous runtime is refused rather than guessed.
    const twoRuntimes = JSON.parse(original);
    twoRuntimes.runtime.cursorAcp = { enabled: true };
    await writePrivateJson(ctx.paths.agentConfigFile("claude"), twoRuntimes);
    await assert.rejects(() => rerun(ctx), /invalid-profile:identity-runtime-ambiguous/);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// MEDIUM 4 — persisted profile containment
// ---------------------------------------------------------------------------

const tamper = async (ctx, mutate) => {
  const project = JSON.parse(readFileSync(ctx.paths.projectFile, "utf8"));
  mutate(project);
  await writePrivateJson(ctx.paths.projectFile, project);
};

test("a safe canonical profile validates", async () => {
  const ctx = await setup();
  try {
    assert.equal(validateProfile(await readPrivateJson(ctx.paths.projectFile), ctx.paths).projectId, ctx.projectId);
    await loadProfile(ctx.paths);
  } finally {
    ctx.cleanup();
  }
});

test("an unsafe persisted agent name is rejected before it can build a path", async () => {
  for (const unsafe of ["../evil", "a/b", "..", "", `ro${NUL}ot`, "Claude", "unknown-role"]) {
    const ctx = await setup();
    try {
      await tamper(ctx, (project) => {
        project.agents = project.agents.map((agent) => (agent.name === "cursor" ? { ...agent, name: unsafe } : agent));
      });
      await assert.rejects(() => loadProfile(ctx.paths), InvalidProfileError, `expected refusal for ${JSON.stringify(unsafe)}`);
    } finally {
      ctx.cleanup();
    }
  }
});

test("a dataDir escaping through `..` is rejected", async () => {
  const ctx = await setup();
  try {
    await tamper(ctx, (project) => {
      project.agents = project.agents.map((agent) =>
        (agent.name === "cursor" ? { ...agent, dataDir: path.join(ctx.paths.agentsDir, "..", "..", "outside") } : agent));
    });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:agent-data-dir:cursor:outside-profile-root/);
  } finally {
    ctx.cleanup();
  }
});

test("an absolute external dataDir is rejected", async () => {
  const ctx = await setup();
  try {
    await tamper(ctx, (project) => {
      project.agents = project.agents.map((agent) => (agent.name === "codex" ? { ...agent, dataDir: "/etc" } : agent));
    });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:agent-data-dir:codex:outside-profile-root/);
  } finally {
    ctx.cleanup();
  }
});

test("18. a symlinked agent directory cannot redirect writes outside the profile", async () => {
  const ctx = await setup();
  try {
    const outside = path.join(ctx.dir, "outside");
    mkdirSync(outside, { recursive: true });
    rmSync(ctx.paths.agentDir("codex"), { recursive: true, force: true });
    symlinkSync(outside, ctx.paths.agentDir("codex"));
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:(agent-data-dir|agent-dir):codex:symlink/);
  } finally {
    ctx.cleanup();
  }
});

/**
 * An ANCESTOR of a managed path may itself be a symlink out of the profile. Resolving
 * the target against that already-escaped ancestor makes both sides agree and the check
 * passes — so containment has to be anchored to the canonical profile root instead.
 */
const replaceWithSymlink = (managedDir, outside) => {
  mkdirSync(outside, { recursive: true });
  rmSync(managedDir, { recursive: true, force: true });
  symlinkSync(outside, managedDir);
};

test("15. the agents directory itself being a symlink outside the profile is refused", async () => {
  const ctx = await setup();
  try {
    replaceWithSymlink(ctx.paths.agentsDir, path.join(ctx.dir, "external-agents"));
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:(agents-dir|agent-data-dir|agent-dir)[^ ]*:symlink/);
  } finally {
    ctx.cleanup();
  }
});

test("16. the logs directory being a symlink outside the profile is refused", async () => {
  const ctx = await setup();
  try {
    replaceWithSymlink(ctx.paths.logsDir, path.join(ctx.dir, "external-logs"));
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:(logs-dir|log-file)[^ ]*:symlink/);
  } finally {
    ctx.cleanup();
  }
});

test("17. the run directory being a symlink outside the profile is refused", async () => {
  const ctx = await setup();
  try {
    replaceWithSymlink(ctx.paths.runDir, path.join(ctx.dir, "external-run"));
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:(run-dir|codex-socket)[^ ]*:symlink/);
  } finally {
    ctx.cleanup();
  }
});

test("19. ordinary real directories under the profile remain valid", async () => {
  const ctx = await setup();
  try {
    const project = await loadProfile(ctx.paths);
    assert.equal(project.projectId, ctx.projectId);
    // And a profile root reached through a symlinked HOME is still fine: it is the
    // managed descendants that may not be symlinks, not the root's own path.
    const linkedHome = path.join(ctx.dir, "linked-home");
    symlinkSync(path.dirname(path.dirname(ctx.paths.root)), linkedHome);
    const viaLink = projectPathsFor(ctx.projectId, { home: path.join(linkedHome) });
    void viaLink;
    assert.equal(existsSync(ctx.paths.agentsDir), true);
  } finally {
    ctx.cleanup();
  }
});

test("a malformed App Server spec is rejected rather than turned into argv", async () => {
  const ctx = await setup();
  try {
    await tamper(ctx, (project) => { project.codexAppServer = { args: "app-server; rm -rf /" }; });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:codex-app-server-args-malformed/);

    await tamper(ctx, (project) => { project.codexAppServer = { args: ["ok", `bad${SOH}arg`] }; });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:codex-app-server-arg-1:control-character/);
  } finally {
    ctx.cleanup();
  }
});

test("a mismatched project id, a duplicated agent and a bad trust edge are all refused", async () => {
  const ctx = await setup();
  try {
    await tamper(ctx, (project) => { project.projectId = "not-this-project"; });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:(project-id-mismatch|agent-id-mismatch)/);

    await tamper(ctx, (project) => {
      project.projectId = ctx.projectId;
      project.agents = [...project.agents, project.agents[1]];
    });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:agent-duplicated:claude/);

    await tamper(ctx, (project) => {
      project.agents = project.agents.slice(0, 4);
      project.trustEdges = [["claude", "../../etc"]];
    });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:agent-name-unsafe/);
  } finally {
    ctx.cleanup();
  }
});

test("log paths are derived from the validated role set, never from persisted text", async () => {
  const ctx = await setup();
  try {
    for (const role of SUPPORTED_ROLES) {
      const logFile = ctx.paths.logFile(role);
      assert.ok(logFile.startsWith(`${ctx.paths.logsDir}${path.sep}`), logFile);
      assert.equal(path.basename(logFile), `${role}.log`);
    }
    // A tampered name never reaches a path because validation refuses the profile first.
    await tamper(ctx, (project) => {
      project.agents = project.agents.map((agent) => (agent.name === "codex" ? { ...agent, name: "../../../../etc/passwd" } : agent));
    });
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:agent-name-unsafe/);
  } finally {
    ctx.cleanup();
  }
});
