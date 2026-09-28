import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPrivateJson, writePrivateJson } from "../scripts/secure-state.mjs";
import {
  FAIL,
  PASS,
  WARN,
  checkClaude,
  checkCodexBinary,
  checkCursor,
  checkNats,
  findExecutable,
  formatReport,
  hasFatal,
  runDiagnostics,
} from "../scripts/operator/doctor.mjs";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const fakeBin = (dir, names) => {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const file = path.join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return bin;
};

const okConnect = async () => ({ getServer: () => "127.0.0.1:4222", close: async () => {} });
const deadConnect = async () => {
  throw new Error("connection refused");
};
const authedTools = async (file) => {
  if (file.endsWith("claude")) return { ok: true, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
  return { ok: true, stdout: "✓ Logged in as tester", stderr: "" };
};

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-doc-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  const bin = fakeBin(dir, ["claude", "agent", "codex"]);
  return {
    dir,
    projectPath,
    projectId,
    paths,
    env: { PATH: bin },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    diagnose: (overrides = {}) =>
      runDiagnostics({
        projectPath,
        projectId,
        paths,
        env: { PATH: bin },
        connectImpl: okConnect,
        run: authedTools,
        socketProbe: async () => ({ ok: false, reason: "socket-absent" }),
        ...overrides,
      }),
  };
};

const byName = (results, name) => results.find((result) => result.name === name);

test("findExecutable resolves through PATH without a shell", () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-bin-"));
  try {
    const bin = fakeBin(dir, ["tool"]);
    assert.equal(findExecutable("tool", { PATH: bin }), path.join(bin, "tool"));
    assert.equal(findExecutable("missing", { PATH: bin }), null);
    assert.equal(findExecutable(path.join(bin, "tool"), {}), path.join(bin, "tool"));
    assert.equal(findExecutable("tool; rm -rf /", { PATH: bin }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports a missing profile as a bootstrap hint, not a failure", async () => {
  const ctx = await setup();
  try {
    const results = await ctx.diagnose();
    assert.equal(byName(results, "profile").status, WARN);
    assert.equal(byName(results, "profile").bootstrapNeeded, true);
    assert.equal(hasFatal(results), false);
    // Host prerequisites are still checked: they are what the operator must fix BEFORE
    // the first start, and they need no profile.
    assert.equal(byName(results, "claude-auth").status, PASS);
    assert.equal(byName(results, "cursor-auth").status, PASS);
    assert.equal(byName(results, "codex-binary").status, PASS);
  } finally {
    ctx.cleanup();
  }
});

test("doctor without a profile still reports missing tools as fatal", async () => {
  const ctx = await setup();
  try {
    const results = await ctx.diagnose({ env: { PATH: "/nonexistent" }, platform: "linux" });
    assert.equal(byName(results, "profile").status, WARN);
    assert.equal(byName(results, "claude-binary").status, FAIL);
    assert.equal(byName(results, "codex-binary").status, FAIL);
    assert.equal(byName(results, "cursor-binary").status, FAIL);
    assert.equal(hasFatal(results), true);
  } finally {
    ctx.cleanup();
  }
});

test("a freshly bootstrapped project passes every check", async () => {
  const ctx = await setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const results = await ctx.diagnose();
    const failures = results.filter((result) => result.status === FAIL);
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
    assert.equal(hasFatal(results), false);
    // Notifications are an optional subsystem configured once per USER, not per project,
    // so an unconfigured notifier is the one expected WARN here — and it is never fatal.
    const warnings = results.filter((result) => result.status === WARN).map((result) => result.name);
    assert.deepEqual(warnings, ["telegram-notify"]);
    assert.equal(byName(results, "telegram-notify").fatal, false);
    assert.equal(byName(results, "identity:claude").status, PASS);
    assert.equal(byName(results, "pairing:claude<->codex").status, PASS);
    assert.equal(byName(results, "handoff-v1:claude->codex").status, PASS);
    assert.equal(byName(results, "runtime:codex").status, PASS);
    assert.equal(byName(results, "supervisor").status, PASS);
  } finally {
    ctx.cleanup();
  }
});

test("an unreachable NATS endpoint is a fatal preflight failure with no secret in the message", async () => {
  const result = await checkNats({ natsUrl: "nats://127.0.0.1:1", natsToken: "super-secret", connectImpl: deadConnect });
  assert.equal(result.status, FAIL);
  assert.equal(result.fatal, true);
  assert.equal(result.detail.includes("super-secret"), false);
  assert.match(result.fix, /NATS server/);
});

test("an unauthenticated Claude fails preflight and prints the exact corrective command", async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-auth-"));
  try {
    const bin = fakeBin(dir, ["claude"]);
    const results = await checkClaude({
      env: { PATH: bin },
      run: async () => ({ ok: false, stdout: JSON.stringify({ loggedIn: false }), stderr: "" }),
    });
    const auth = byName(results, "claude-auth");
    assert.equal(auth.status, FAIL);
    assert.equal(auth.fatal, true);
    assert.equal(auth.fix, "claude auth login");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unauthenticated Cursor fails preflight and prints `agent login`", async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-auth2-"));
  try {
    const bin = fakeBin(dir, ["agent"]);
    const results = await checkCursor({
      env: { PATH: bin },
      run: async () => ({ ok: true, stdout: "Not logged in", stderr: "" }),
    });
    assert.equal(byName(results, "cursor-auth").status, FAIL);
    assert.equal(byName(results, "cursor-auth").fix, "agent login");

    const good = await checkCursor({ env: { PATH: bin }, run: async () => ({ ok: true, stdout: "✓ Logged in as x", stderr: "" }) });
    assert.equal(byName(good, "cursor-auth").status, PASS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing agent binary fails and skips its auth check", async () => {
  const claude = await checkClaude({ env: { PATH: "/nonexistent" }, run: async () => ({ ok: true, stdout: "" }) });
  assert.equal(byName(claude, "claude-binary").status, FAIL);
  assert.equal(byName(claude, "claude-binary").fatal, true);
  assert.equal(byName(claude, "claude-auth").status, "SKIP");

  const [codex] = checkCodexBinary({ project: {}, env: { PATH: "/nonexistent" }, platform: "linux" });
  assert.equal(codex.status, FAIL);
  assert.equal(codex.fatal, true);
  assert.match(codex.fix, /enabled=false/);
});

test("broken pairing and a missing handoff advertisement are reported as repairable", async () => {
  const ctx = await setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const codex = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    const claudeId = Object.keys(codex.peers)[0];
    delete codex.peers[claudeId];
    await writePrivateJson(ctx.paths.agentConfigFile("codex"), codex);

    const cursor = await readPrivateJson(ctx.paths.agentConfigFile("cursor"));
    cursor.features = [];
    await writePrivateJson(ctx.paths.agentConfigFile("cursor"), cursor);
    const claude = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    claude.peers[cursor.agentId].features = [];
    await writePrivateJson(ctx.paths.agentConfigFile("claude"), claude);

    const results = await ctx.diagnose();
    // Both are derivable from the public halves already on disk, so `start` repairs
    // them; doctor reports them and repairs nothing itself.
    assert.equal(byName(results, "pairing:claude<->codex").status, WARN);
    assert.equal(byName(results, "pairing:claude<->codex").repairable, true);
    assert.equal(byName(results, "handoff-v1:claude->cursor").status, WARN);
    assert.equal(hasFatal(results), false);
  } finally {
    ctx.cleanup();
  }
});

test("two enabled runtimes on one identity is fatal; a wrong derivable field is repairable", async () => {
  const ctx = await setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const codex = await readPrivateJson(ctx.paths.agentConfigFile("codex"));
    codex.runtime.codexAppServer.socketPath = "/tmp/somebody-elses.sock";
    await writePrivateJson(ctx.paths.agentConfigFile("codex"), codex);
    const repairableResult = byName(await ctx.diagnose(), "runtime:codex");
    assert.equal(repairableResult.status, WARN);
    assert.match(repairableResult.detail, /profile-owned socket/);

    // Ambiguity is contradictory: repair would have to guess which runtime was meant.
    codex.runtime.claudeOneShot = { enabled: true };
    await writePrivateJson(ctx.paths.agentConfigFile("codex"), codex);
    const fatalResult = byName(await ctx.diagnose(), "runtime:codex");
    assert.equal(fatalResult.status, FAIL);
    assert.equal(fatalResult.fatal, true);
    assert.match(fatalResult.detail, /exactly one enabled runtime/);
  } finally {
    ctx.cleanup();
  }
});

test("a foreign App Server on the profile socket is fatal; a stale socket file is only a warning", async () => {
  const ctx = await setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    mkdirSync(ctx.paths.runDir, { recursive: true });
    writeFileSync(ctx.paths.codexSocket, "");

    const foreign = await ctx.diagnose({ socketProbe: async () => ({ ok: true, reason: "connected" }) });
    assert.equal(byName(foreign, "codex-socket").status, FAIL);
    assert.match(byName(foreign, "codex-socket").fix, /never kills an App Server it did not start/);

    const stale = await ctx.diagnose({ socketProbe: async () => ({ ok: false, reason: "socket-error:ECONNREFUSED" }) });
    assert.equal(byName(stale, "codex-socket").status, WARN);
    assert.equal(hasFatal(stale), false);
  } finally {
    ctx.cleanup();
  }
});

test("stale supervisor run state and a stale lock are warnings that start can reclaim", async () => {
  const ctx = await setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const { writeRunState } = await import("../scripts/operator/runstate.mjs");
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "ready",
      supervisor: { pid: 999_996, startIdentity: "Thu Jan  1 00:00:00 1970" },
      children: {},
    });
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ pid: 999_995, startIdentity: "Thu Jan  1 00:00:00 1970" }));

    const results = await ctx.diagnose();
    assert.equal(byName(results, "supervisor").status, WARN);
    assert.equal(byName(results, "supervisor-lock").status, WARN);
    assert.equal(hasFatal(results), false);
  } finally {
    ctx.cleanup();
  }
});

test("a profile that would live inside the repository is refused", async () => {
  const ctx = await setup();
  try {
    const inside = projectPathsFor(ctx.projectId, { home: path.join(ctx.projectPath, ".murmur") });
    const results = await runDiagnostics({
      projectPath: ctx.projectPath,
      projectId: ctx.projectId,
      paths: inside,
      env: ctx.env,
      connectImpl: okConnect,
      run: authedTools,
    });
    const check = byName(results, "state-location");
    assert.equal(check.status, FAIL);
    assert.equal(check.fatal, true);
  } finally {
    ctx.cleanup();
  }
});

test("the rendered report never contains key material", async () => {
  const ctx = await setup();
  try {
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths, natsToken: "tok-en-secret" });
    const claude = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    const report = formatReport(await ctx.diagnose());
    assert.equal(report.includes(claude.keys.signing.privateKey), false);
    assert.equal(report.includes(claude.keys.encryption.privateKey), false);
    assert.equal(report.includes("tok-en-secret"), false);
    assert.equal(report.includes("privateKey"), false);
  } finally {
    ctx.cleanup();
  }
});
