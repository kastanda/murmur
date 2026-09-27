// THE LIVE DEFECT: the real Codex App Server does not create a socket AT the pathname it is
// given — it materialises that pathname as a SYMLINK to its own socket under
// /private/tmp/codex-daemon-<uid>/<hash>. Profile containment treated that leaf like a managed
// directory replaced by a symlink and refused the whole profile:
//
//   murmur start  -> everything READY
//   murmur status -> invalid-profile:codex-socket:symlink
//
// These tests pin the distinction: ANCESTOR containment stays absolute, the endpoint LEAF gets
// runtime alias semantics, and the alias target is never treated as ours to manage or delete.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrapProfile, loadProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { readStartIdentity } from "../scripts/operator/proc.mjs";
import { writeRunState } from "../scripts/operator/runstate.mjs";
import { collectStatus } from "../scripts/operator/status.mjs";
import { runDiagnostics } from "../scripts/operator/doctor.mjs";
import {
  CODEX_APP_SERVER_CHILD,
  ProjectSupervisor,
  cleanupRuntimeArtifacts,
  inspectSocketEndpoint,
  probeUnixSocket,
} from "../scripts/operator/supervisor.mjs";

const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "bin", "murmur.mjs");

/** AF_UNIX caps a socket path at 104 bytes, so both ends need short directories. */
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const DEAD = { pid: 999_801, startIdentity: "Thu Jan  1 00:00:00 1970" };

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-sock-"));
  mkdirSync(path.join(dir, "project"), { recursive: true });
  // The CLI canonicalises the project path (on macOS /tmp is a link to /private/tmp), so the
  // fixture must use the same canonical form or it computes a different project id.
  const projectPath = realpathSync(path.join(dir, "project"));
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  await bootstrapProfile({ projectId, projectPath, paths });
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  /** An "external", runtime-owned directory, standing in for /private/tmp/codex-daemon-501. */
  const external = mkdtempSync(path.join(shortTmp(), "cdx-"));
  return {
    dir, projectPath, projectId, paths, external,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    },
  };
};

/** A real listening Unix socket, at `target`. */
const listenAt = async (target) => {
  const server = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, resolve);
  });
  return { server, close: () => new Promise((resolve) => server.close(resolve)) };
};

/** Exactly the live shape: `run/codex.sock -> <external>/<hash>`, target a live socket. */
const aliasToLiveSocket = async (ctx) => {
  const target = path.join(ctx.external, "38ab65b0025d5c21");
  const listener = await listenAt(target);
  symlinkSync(target, ctx.paths.codexSocket);
  return { target, listener };
};

const sleeper = () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, record: (name) => ({ name, pid: child.pid, startIdentity: readStartIdentity(child.pid) }) };
};

// ---------------------------------------------------------------------------
// A + B — both legitimate endpoint shapes are valid profiles
// ---------------------------------------------------------------------------

test("A. a Unix socket directly at the configured path is a valid profile", async () => {
  const ctx = await setup();
  let listener;
  try {
    listener = await listenAt(ctx.paths.codexSocket);
    const project = await loadProfile(ctx.paths);
    assert.equal(project.projectId, ctx.projectId, "the profile loads");

    const endpoint = inspectSocketEndpoint(ctx.paths.codexSocket);
    assert.deepEqual(
      { present: endpoint.present, alias: endpoint.alias, targetKind: endpoint.targetKind, reason: endpoint.reason },
      { present: true, alias: false, targetKind: "socket", reason: null },
    );
    const probe = await probeUnixSocket(ctx.paths.codexSocket);
    assert.equal(probe.ok, true);
    assert.equal(probe.reason, "connected");
    assert.equal(probe.alias, false);
  } finally {
    await listener?.close();
    ctx.cleanup();
  }
});

test("B. the real App Server shape — a symlink alias to an external Unix socket — is a valid profile", async () => {
  const ctx = await setup();
  let alias;
  try {
    alias = await aliasToLiveSocket(ctx);

    // THE EXACT LIVE FAILURE: this used to throw invalid-profile:codex-socket:symlink.
    const project = await loadProfile(ctx.paths);
    assert.equal(project.projectId, ctx.projectId);
    assert.equal(lstatSync(ctx.paths.codexSocket).isSymbolicLink(), true, "the leaf really is a symlink");

    const endpoint = inspectSocketEndpoint(ctx.paths.codexSocket);
    assert.equal(endpoint.alias, true);
    assert.equal(endpoint.targetKind, "socket");
    assert.equal(endpoint.reason, null);
    // `realpath` canonicalises (on macOS /tmp is itself a link to /private/tmp) — exactly the
    // `/private/tmp/codex-daemon-501/...` form the live acceptance saw.
    assert.equal(endpoint.target, realpathSync(alias.target));

    const probe = await probeUnixSocket(ctx.paths.codexSocket);
    assert.equal(probe.ok, true, probe.reason);
    assert.equal(probe.reason, "connected-via-alias");
    assert.equal(probe.alias, true);
  } finally {
    await alias?.listener.close();
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C + D — an alias is only healthy when it resolves to an actual socket
// ---------------------------------------------------------------------------

test("C. an alias whose target is missing is unhealthy, but not a broken profile", async () => {
  const ctx = await setup();
  try {
    symlinkSync(path.join(ctx.external, "vanished"), ctx.paths.codexSocket);
    // Containment is unaffected: a dangling runtime alias is a health problem, not tampering.
    await loadProfile(ctx.paths);

    const endpoint = inspectSocketEndpoint(ctx.paths.codexSocket);
    assert.equal(endpoint.present, true, "a dangling symlink IS an entry, even though existsSync says no");
    assert.equal(endpoint.alias, true);
    assert.match(endpoint.reason, /^socket-alias-broken:/);

    const probe = await probeUnixSocket(ctx.paths.codexSocket);
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /^socket-alias-broken:/);

    // doctor must not report "no socket present" for a dangling alias.
    const results = await runDiagnostics({ projectPath: ctx.projectPath, projectId: ctx.projectId, paths: ctx.paths });
    const socketCheck = results.find((entry) => entry.name === "codex-socket");
    assert.ok(["WARN", "FAIL"].includes(socketCheck.status), JSON.stringify(socketCheck));
    assert.equal(socketCheck.detail.includes("no socket present"), false, socketCheck.detail);
  } finally {
    ctx.cleanup();
  }
});

test("D. an alias resolving to a regular file is rejected as unhealthy", async () => {
  const ctx = await setup();
  try {
    const target = path.join(ctx.external, "not-a-socket");
    writeFileSync(target, "definitely not a socket");
    symlinkSync(target, ctx.paths.codexSocket);
    await loadProfile(ctx.paths);

    const endpoint = inspectSocketEndpoint(ctx.paths.codexSocket);
    assert.equal(endpoint.alias, true);
    assert.equal(endpoint.targetKind, "file");
    assert.equal(endpoint.reason, "socket-alias-not-a-socket");

    const probe = await probeUnixSocket(ctx.paths.codexSocket);
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, "socket-alias-not-a-socket");

    const results = await runDiagnostics({ projectPath: ctx.projectPath, projectId: ctx.projectId, paths: ctx.paths });
    const socketCheck = results.find((entry) => entry.name === "codex-socket");
    assert.equal(socketCheck.status, "FAIL", JSON.stringify(socketCheck));
    assert.match(socketCheck.detail, /resolves to a file, not a socket/);
    // The external target is inspected, never consumed or removed.
    assert.equal(existsSync(target), true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// E + F — ancestor containment is NOT relaxed
// ---------------------------------------------------------------------------

test("E. a run directory replaced by an external symlink is still an invalid profile", async () => {
  const ctx = await setup();
  const escape = mkdtempSync(path.join(shortTmp(), "esc-"));
  try {
    rmSync(ctx.paths.runDir, { recursive: true, force: true });
    symlinkSync(escape, ctx.paths.runDir);
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:run-dir:symlink/);

    // And the socket leaf check refuses through its ancestor chain, too.
    const { assertEndpointWithinProfile } = await import("../scripts/operator/profile.mjs");
    assert.throws(() => assertEndpointWithinProfile(ctx.paths.codexSocket, ctx.paths.root, "codex-socket"),
      /invalid-profile:codex-socket:symlink/);
  } finally {
    rmSync(escape, { recursive: true, force: true });
    ctx.cleanup();
  }
});

test("F. logs, agents and data-dir ancestor protections are unchanged", async () => {
  const ctx = await setup();
  const escape = mkdtempSync(path.join(shortTmp(), "esc-"));
  try {
    // For `agents` the per-agent data-dir check fires first; either refusal is the protection.
    for (const [dir, reason] of [
      [ctx.paths.logsDir, /invalid-profile:logs-dir:symlink/],
      [ctx.paths.agentsDir, /invalid-profile:(agents-dir|agent-data-dir:[a-z]+):symlink/],
    ]) {
      const stash = `${dir}.real`;
      renameSync(dir, stash);
      symlinkSync(escape, dir);
      await assert.rejects(() => loadProfile(ctx.paths), reason, `${dir} must be refused`);
      rmSync(dir, { force: true });
      renameSync(stash, dir);
    }
    // An individual agent directory replaced by a symlink is still refused.
    const agentDir = ctx.paths.agentDir("claude");
    const stash = `${agentDir}.real`;
    renameSync(agentDir, stash);
    symlinkSync(escape, agentDir);
    await assert.rejects(() => loadProfile(ctx.paths), /invalid-profile:agent-data-dir:claude:symlink/);
    rmSync(agentDir, { force: true });
    renameSync(stash, agentDir);
    // With everything restored the profile is valid again.
    await loadProfile(ctx.paths);
  } finally {
    rmSync(escape, { recursive: true, force: true });
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// G — foreign-socket protection is not weakened by alias support
// ---------------------------------------------------------------------------

test("G. a pre-existing foreign alias to a live socket blocks the start and is never touched", async () => {
  const ctx = await setup();
  let alias;
  try {
    // Somebody else's App Server, exposed at our configured path before we start anything.
    alias = await aliasToLiveSocket(ctx);
    const project = await loadProfile(ctx.paths);
    const fakeRoot = path.join(ctx.dir, "fake-murmur");
    mkdirSync(path.join(fakeRoot, "scripts"), { recursive: true });
    writeFileSync(path.join(fakeRoot, "scripts", "murmur-daemon.mjs"), "setInterval(() => {}, 1000);\n");
    const supervisor = new ProjectSupervisor({
      project, paths: ctx.paths, murmurRoot: fakeRoot, readyTimeoutMs: 1_500, stopGraceMs: 500,
    });

    const result = await supervisor.startCodexAppServer();
    assert.equal(result.ok, undefined === result.ok ? undefined : false, "start must not proceed");
    assert.equal(lstatSync(ctx.paths.codexSocket).isSymbolicLink(), true, "the foreign alias is left in place");
    assert.equal(existsSync(alias.target), true, "and so is its target");

    // doctor calls it out instead of accepting it as ours just because it resolves to a socket.
    const results = await runDiagnostics({ projectPath: ctx.projectPath, projectId: ctx.projectId, paths: ctx.paths });
    const socketCheck = results.find((entry) => entry.name === "codex-socket");
    assert.equal(socketCheck.status, "FAIL");
    assert.match(socketCheck.detail, /no Murmur supervisor owns it/);
  } catch (err) {
    // `startCodexAppServer` throws for an in-use socket; either shape is a refusal.
    assert.match(String(err?.message || err), /codex-app-server-socket-in-use/);
    assert.equal(lstatSync(ctx.paths.codexSocket).isSymbolicLink(), true);
    assert.equal(existsSync(alias.target), true);
  } finally {
    await alias?.listener.close();
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// H + I — status and doctor accept the real running shape
// ---------------------------------------------------------------------------

test("H. status accepts a valid owned socket alias", async () => {
  const ctx = await setup();
  const appServer = sleeper();
  let alias;
  try {
    alias = await aliasToLiveSocket(ctx);
    const project = await loadProfile(ctx.paths);
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      phase: "ready",
      supervisor: { pid: process.pid, startIdentity: readStartIdentity(process.pid) },
      children: { [CODEX_APP_SERVER_CHILD]: appServer.record(CODEX_APP_SERVER_CHILD) },
    });

    const status = await collectStatus({ project, paths: ctx.paths, includeNats: false });
    assert.equal(status.appServer.alive, true);
    assert.equal(status.appServer.socket.ok, true, status.appServer.socket.reason);
    assert.equal(status.appServer.socket.alias, true, "the alias form is reported, not rejected");
    assert.equal(status.appServer.socket.targetKind, "socket");
    assert.equal(
      status.problems.some((problem) => problem.includes("codex app-server is not accepting connections")), false,
      JSON.stringify(status.problems),
    );
  } finally {
    appServer.child.kill("SIGKILL");
    await appServer.exited;
    await alias?.listener.close();
    ctx.cleanup();
  }
});

test("I. doctor reports a running alias as owned and healthy", async () => {
  const ctx = await setup();
  let alias;
  try {
    alias = await aliasToLiveSocket(ctx);
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      phase: "ready",
      // This test process stands in for the running supervisor that owns the App Server.
      supervisor: { pid: process.pid, startIdentity: readStartIdentity(process.pid) },
      children: {},
    });
    const results = await runDiagnostics({ projectPath: ctx.projectPath, projectId: ctx.projectId, paths: ctx.paths });
    const socketCheck = results.find((entry) => entry.name === "codex-socket");
    assert.equal(socketCheck.status, "PASS", JSON.stringify(socketCheck));
    assert.match(socketCheck.detail, /owned by the running supervisor \(socket alias\)/);
    // The profile itself is not reported as invalid anywhere.
    for (const entry of results) {
      assert.equal(String(entry.detail || "").includes("invalid-profile"), false, JSON.stringify(entry));
    }
  } finally {
    await alias?.listener.close();
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// J — cleanup removes OUR alias only, never the external target
// ---------------------------------------------------------------------------

test("J. cleanup settles only Murmur's own endpoint and never deletes the external target", async () => {
  const ctx = await setup();
  try {
    // A stale alias: the target exists but is not a live socket, so it is removable garbage
    // from OUR side — and entirely someone else's file on the other side.
    const target = path.join(ctx.external, "left-behind");
    writeFileSync(target, "runtime-owned");
    symlinkSync(target, ctx.paths.codexSocket);
    await writeRunState(ctx.paths, { projectId: ctx.projectId, phase: "stopped", supervisor: DEAD, children: {} });

    const result = await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(result.retained, false);
    assert.ok(result.removed.includes(ctx.paths.codexSocket), JSON.stringify(result.removed));
    assert.equal(existsSync(ctx.paths.codexSocket), false, "our configured alias is gone");
    assert.equal(lstatExists(ctx.paths.codexSocket), false);

    // THE IMPORTANT HALF: the external target and its directory survive untouched.
    assert.equal(existsSync(target), true, "the runtime-owned target must NOT be deleted");
    assert.equal(existsSync(ctx.external), true, "and neither must its directory");
    assert.equal(existsSync(ctx.paths.root), true, "the profile stays reusable");
    assert.equal(existsSync(ctx.paths.agentConfigFile("claude")), true);

    // A dangling alias is also settled rather than silently left behind.
    symlinkSync(path.join(ctx.external, "gone-for-good"), ctx.paths.codexSocket);
    await writeRunState(ctx.paths, { projectId: ctx.projectId, phase: "stopped", supervisor: DEAD, children: {} });
    await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(lstatExists(ctx.paths.codexSocket), false, "a dangling alias is cleaned up too");
  } finally {
    ctx.cleanup();
  }
});

/** `existsSync` follows links; this answers "is there an entry at all". */
const lstatExists = (target) => {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// K — the exact live command, end to end through bin/murmur.mjs
// ---------------------------------------------------------------------------

test("K. `murmur status` on the real alias shape no longer fails with invalid-profile", async () => {
  const ctx = await setup();
  let alias;
  try {
    alias = await aliasToLiveSocket(ctx);
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      phase: "ready",
      supervisor: { pid: process.pid, startIdentity: readStartIdentity(process.pid) },
      children: {},
    });

    // The literal live invocation: `murmur status <project>` against a profile whose
    // run/codex.sock is an App Server alias into an external runtime directory.
    const run = (...args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, HOME: ctx.dir, MURMUR_HOME: path.join(ctx.dir, ".murmur") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });

    const status = await run("status", ctx.projectPath);
    assert.equal(status.stderr.includes("invalid-profile"), false, status.stderr);
    assert.equal(status.stderr.includes("codex-socket:symlink"), false, status.stderr);
    assert.match(status.stdout, /Codex App Server:/);
    assert.match(status.stdout, /socket=listening \(alias\)/);

    const json = await run("status", ctx.projectPath, "--json");
    assert.equal(json.stderr.includes("invalid-profile"), false, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.appServer.socket.ok, true);
    assert.equal(parsed.appServer.socket.alias, true);

    // doctor, the other read-only command, is equally unaffected.
    const doctor = await run("doctor", ctx.projectPath);
    assert.equal(doctor.stdout.includes("invalid-profile"), false, doctor.stdout);
    assert.match(doctor.stdout, /codex-socket\s+owned by the running supervisor \(socket alias\)/);
  } finally {
    await alias?.listener.close();
    ctx.cleanup();
  }
});
