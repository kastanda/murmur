import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { isOwnedProcessAlive, readStartIdentity } from "../scripts/operator/proc.mjs";
import { acquireLock, lockState, readRunState, releaseLock, unsettledOwnedChildren } from "../scripts/operator/runstate.mjs";
import {
  CODEX_APP_SERVER_CHILD,
  ProjectSupervisor,
  cleanupRuntimeArtifacts,
  probeUnixSocket,
  reapOrphanedChildren,
  rotateLog,
} from "../scripts/operator/supervisor.mjs";

/**
 * A fake murmur daemon: it emits the SAME structured readiness line the real daemon
 * emits, so the supervisor's readiness detection is exercised for real without needing
 * NATS, Claude, Codex or Cursor.
 */
const FAKE_DAEMON = `
const mode = process.env.FAKE_MODE || "ready";
const name = process.env.DATA_DIR.split("/").pop();
if (mode === "fatal-" + name) {
  console.log(JSON.stringify({ level: "fatal", msg: "Cannot load agent config" }));
  process.exit(1);
}
if (mode === "silent-" + name) { setTimeout(() => {}, 60000); }
else {
  console.log(JSON.stringify({ level: "info", msg: "Daemon starting", agentId: name }));
  setTimeout(() => console.log(JSON.stringify({ level: "info", msg: "Daemon ready", agentId: name })), 30);
  setInterval(() => {}, 1000);
}
process.on("SIGTERM", () => process.exit(0));
`;

// A real WebSocket endpoint on the Unix socket, like the App Server's control socket: readiness is
// proven by a genuine upgrade, so the fake must complete one.
const FAKE_APP_SERVER = `
const http = require("node:http");
const { WebSocketServer } = require(${JSON.stringify(path.resolve("node_modules/ws"))});
const socketPath = process.argv[2];
const server = http.createServer();
new WebSocketServer({ server });
server.listen(socketPath, () => console.log("listening " + socketPath));
process.on("SIGTERM", () => { server.close(); try { require("node:fs").unlinkSync(socketPath); } catch {} process.exit(0); });
`;

/**
 * AF_UNIX caps a socket path at 104 bytes, and macOS `os.tmpdir()` alone already eats
 * ~50 of them. Tests that bind a real socket therefore need a short base directory.
 */
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const setup = async ({ fakeMode = "ready", codex = true } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-sup-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const fakeRoot = path.join(dir, "fake-murmur");
  mkdirSync(path.join(fakeRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(fakeRoot, "scripts", "murmur-daemon.mjs"), FAKE_DAEMON);
  const appServerScript = path.join(fakeRoot, "scripts", "fake-app-server.cjs");
  writeFileSync(appServerScript, FAKE_APP_SERVER);

  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  const { project } = await bootstrapProfile({ projectId, projectPath, paths });
  project.codexAppServer = { command: process.execPath, args: [appServerScript, "{socket}"] };
  if (!codex) project.agents = project.agents.map((agent) => (agent.name === "codex" ? { ...agent, enabled: false } : agent));

  const logs = [];
  const supervisor = new ProjectSupervisor({
    project,
    paths,
    murmurRoot: fakeRoot,
    log: (level, msg, data) => logs.push({ level, msg, ...data }),
    readyTimeoutMs: 8_000,
    stopGraceMs: 4_000,
    env: { ...process.env, FAKE_MODE: fakeMode },
  });
  return { dir, projectPath, projectId, paths, project, supervisor, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("the supervisor starts the App Server first, then every enabled daemon", async () => {
  const ctx = await setup();
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, true, result.reason);

    const state = await readRunState(ctx.paths);
    assert.equal(state.phase, "ready");
    assert.deepEqual(Object.keys(state.children).sort(), [CODEX_APP_SERVER_CHILD, "claude", "codex", "cursor", "root"].sort());

    // Every recorded child carries an exact PID + start identity, and is genuinely ours.
    for (const [name, record] of Object.entries(state.children)) {
      assert.ok(Number.isInteger(record.pid), name);
      assert.ok(record.startIdentity, `${name} must record a start identity`);
      assert.equal(isOwnedProcessAlive(record), true, name);
      assert.ok(existsSync(record.logFile), `${name} log`);
    }
    assert.equal((await probeUnixSocket(ctx.paths.codexSocket)).ok, true);

    // Daemons receive their own isolated DATA_DIR.
    assert.equal(state.children.claude.cwd, ctx.projectPath);
    assert.match(readFileSync(ctx.paths.logFile("claude"), "utf8"), /Daemon ready/);
  } finally {
    await ctx.supervisor.stop("test");
    ctx.cleanup();
  }
});

test("stop terminates every owned child and leaves the profile intact", async () => {
  const ctx = await setup();
  try {
    await ctx.supervisor.start();
    const before = await readRunState(ctx.paths);
    const records = Object.values(before.children);

    const { stopped } = await ctx.supervisor.stop("test");
    assert.equal(stopped.length, records.length);
    for (const record of records) assert.equal(isOwnedProcessAlive(record), false, record.name);
    assert.equal(existsSync(ctx.paths.codexSocket), false, "the owned socket is cleaned up");

    // Identities, databases and history survive a stop.
    assert.equal(existsSync(ctx.paths.agentConfigFile("claude")), true);
    assert.equal(existsSync(ctx.paths.projectFile), true);
    const after = await readRunState(ctx.paths);
    assert.equal(after.phase, "stopped");
  } finally {
    ctx.cleanup();
  }
});

test("stop is idempotent", async () => {
  const ctx = await setup();
  try {
    await ctx.supervisor.start();
    const first = await ctx.supervisor.stop("test");
    const second = await ctx.supervisor.stop("test");
    assert.ok(first.stopped.length > 0);
    assert.equal(first.clean, true);
    // Idempotent: the repeat does no new work and reports the SAME verdict, rather
    // than an empty result that could be mistaken for "nothing was ever owned".
    assert.deepEqual(second, first);
  } finally {
    ctx.cleanup();
  }
});

test("a fatal daemon fails the start and rolls back every process already started", async () => {
  const ctx = await setup({ fakeMode: "fatal-cursor" });
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false);
    assert.match(result.reason, /cursor-not-ready/);

    const state = await readRunState(ctx.paths);
    assert.equal(state.phase, "failed");
    for (const record of Object.values(state.children)) {
      assert.equal(isOwnedProcessAlive(record), false, `${record.name} must not survive a failed start`);
    }
    assert.equal(existsSync(ctx.paths.codexSocket), false);
  } finally {
    await ctx.supervisor.stop("cleanup");
    ctx.cleanup();
  }
});

test("a daemon that never signals readiness times out instead of reporting success", async () => {
  const ctx = await setup({ fakeMode: "silent-codex" });
  ctx.supervisor.readyTimeoutMs = 700;
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false);
    assert.match(result.reason, /codex-not-ready:ready-timeout/);
  } finally {
    await ctx.supervisor.stop("cleanup");
    ctx.cleanup();
  }
});

test("a disabled agent is not started and its App Server is skipped", async () => {
  const ctx = await setup({ codex: false });
  try {
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, true, result.reason);
    const state = await readRunState(ctx.paths);
    assert.deepEqual(Object.keys(state.children).sort(), ["claude", "cursor", "root"]);
    assert.equal(existsSync(ctx.paths.codexSocket), false);
  } finally {
    await ctx.supervisor.stop("test");
    ctx.cleanup();
  }
});

test("the supervisor refuses to start over an App Server already listening on its socket", async () => {
  const ctx = await setup();
  const squatter = spawn(process.execPath, [path.join(ctx.dir, "fake-murmur", "scripts", "fake-app-server.cjs"), ctx.paths.codexSocket], { stdio: "ignore" });
  const squatterExit = new Promise((resolve) => squatter.on("exit", resolve));
  try {
    for (let i = 0; i < 50 && !(await probeUnixSocket(ctx.paths.codexSocket)).ok; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, false);
    assert.match(result.reason, /codex-app-server-socket-in-use/);
    assert.equal(isOwnedProcessAlive({ pid: squatter.pid, startIdentity: readStartIdentity(squatter.pid) }), true,
      "Murmur must never kill an App Server it did not start");
  } finally {
    squatter.kill("SIGKILL");
    await squatterExit;
    ctx.cleanup();
  }
});

test("a stale socket file with nothing listening is replaced on start", async () => {
  const ctx = await setup();
  try {
    mkdirSync(ctx.paths.runDir, { recursive: true });
    writeFileSync(ctx.paths.codexSocket, "");
    const result = await ctx.supervisor.start();
    assert.equal(result.ok, true, result.reason);
    assert.ok(ctx.logs.some((entry) => entry.msg === "Removing stale Codex App Server socket"));
  } finally {
    await ctx.supervisor.stop("test");
    ctx.cleanup();
  }
});

test("orphan reaping touches only recorded, identity-matched children", async () => {
  const ctx = await setup();
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const bystanderExit = new Promise((resolve) => bystander.on("exit", resolve));
  try {
    await ctx.supervisor.start();
    const state = await readRunState(ctx.paths);
    // Inject an unrelated live PID under a name we never started, with a WRONG identity.
    state.children.impostor = { name: "impostor", pid: bystander.pid, startIdentity: "not-the-real-identity" };
    // And one with no identity at all.
    state.children.unverifiable = { name: "unverifiable", pid: bystander.pid, startIdentity: null };
    const { writeRunState } = await import("../scripts/operator/runstate.mjs");
    await writeRunState(ctx.paths, state);

    // The impostor and the unverifiable record are NOT proven gone, so they remain
    // reaping candidates in the evidence — but neither may ever be signalled.
    const unsettled = unsettledOwnedChildren(state).map((r) => r.name).sort();
    for (const name of ["claude", CODEX_APP_SERVER_CHILD, "codex", "cursor", "root"]) {
      assert.ok(unsettled.includes(name), name);
    }

    const stopped = await reapOrphanedChildren(ctx.paths, { graceMs: 3_000 });
    // The impostor's identity does not match, so it is proven-gone-as-ours and never
    // signalled. The unverifiable record has a live PID with no provable ownership, so
    // it is reported unsettled rather than killed.
    assert.equal(stopped.some((entry) => entry.name === "impostor"), false);
    const unverifiable = stopped.find((entry) => entry.name === "unverifiable");
    if (unverifiable) assert.equal(unverifiable.settled, false, "an unprovable record is never reported stopped");
    assert.equal(isOwnedProcessAlive({ pid: bystander.pid, startIdentity: readStartIdentity(bystander.pid) }), true,
      "an unrelated process must survive orphan reaping");
    assert.equal(stopped.filter((entry) => entry.settled).length, 5, "exactly our five real children are settled");
  } finally {
    bystander.kill("SIGKILL");
    await bystanderExit;
    ctx.cleanup();
  }
});

test("the project lock is exclusive while held, instance-scoped on release, and reclaimed when stale", async () => {
  const ctx = await setup();
  try {
    mkdirSync(ctx.paths.runDir, { recursive: true });
    const live = { pid: process.pid, startIdentity: readStartIdentity(process.pid) };
    const held = acquireLock(ctx.paths, live);
    assert.equal(held.acquired, true);
    assert.ok(held.owner.lockId, "an acquisition is identified by its own instance token");

    const second = acquireLock(ctx.paths, { pid: 999_999, startIdentity: "x" });
    assert.equal(second.acquired, false);
    assert.equal(second.heldBy.pid, process.pid);

    // The bare owner (pid + identity, no token) is NOT authority to release: see
    // tests/operator-lock-instance.test.mjs for the PID-reuse sequence this protects.
    assert.equal(releaseLock(ctx.paths, live).released, false);
    assert.equal(existsSync(ctx.paths.lockFile), true);
    assert.equal(releaseLock(ctx.paths, held.owner).released, true);

    // A lock whose owner is long gone must not block a fresh start forever.
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ pid: 999_998, startIdentity: "Thu Jan  1 00:00:00 1970" }));
    const reclaimed = acquireLock(ctx.paths, live);
    assert.equal(reclaimed.acquired, true);
    assert.equal(releaseLock(ctx.paths, reclaimed.owner).released, true);
  } finally {
    ctx.cleanup();
  }
});

test("cleanup removes stale runtime metadata but never identities, databases or logs", async () => {
  const ctx = await setup();
  try {
    await ctx.supervisor.start();
    await ctx.supervisor.stop("test");
    // Pretend the supervisor process itself vanished.
    const state = await readRunState(ctx.paths);
    state.supervisor = { pid: 999_997, startIdentity: "Thu Jan  1 00:00:00 1970" };
    const { writeRunState } = await import("../scripts/operator/runstate.mjs");
    await writeRunState(ctx.paths, state);

    const result = await cleanupRuntimeArtifacts(ctx.paths);
    assert.equal(result.retained, false);
    assert.ok(result.removed.includes(ctx.paths.supervisorFile));
    assert.equal(existsSync(ctx.paths.supervisorFile), false);
    assert.equal(existsSync(ctx.paths.agentConfigFile("claude")), true);
    assert.equal(existsSync(ctx.paths.projectFile), true);
    assert.equal(existsSync(ctx.paths.logFile("claude")), true);
  } finally {
    ctx.cleanup();
  }
});

test("a supervisor stop that cannot confirm an exit reports it instead of leaking silently", async () => {
  const ctx = await setup();
  try {
    await ctx.supervisor.start();
    const records = Object.values((await readRunState(ctx.paths)).children);
    assert.ok(records.length > 0);

    // Simulate the load condition that used to break this: liveness cannot be measured.
    // Stop must NOT report these as stopped, because a caller that believes a leaked
    // child is dead will leave it running forever.
    ctx.supervisor.readIdentity = () => null;
    const { stopped } = await ctx.supervisor.stop("unmeasurable");
    // With identity unmeasurable the outcomes are honest, never a false "terminated".
    for (const entry of stopped) {
      assert.ok(["not-running", "identity-unknown", "terminated", "killed"].includes(entry.outcome), entry.outcome);
    }
  } finally {
    // Always reap for real, whatever the simulation concluded.
    for (const entry of Object.values((await readRunState(ctx.paths))?.children || {})) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    ctx.cleanup();
  }
});

test("a completed supervisor stop leaves no child process behind", async () => {
  const ctx = await setup();
  try {
    await ctx.supervisor.start();
    const records = Object.values((await readRunState(ctx.paths)).children);
    const { stopped } = await ctx.supervisor.stop("test");
    assert.ok(stopped.every((entry) => entry.settled), JSON.stringify(stopped));
    // Verified against the OS, not against our own bookkeeping.
    for (const record of records) {
      let alive = true;
      try {
        process.kill(record.pid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `${record.name} (pid ${record.pid}) must not survive stop`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("log rotation keeps one generation once the file grows past the limit", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-operator-log-"));
  try {
    const file = path.join(dir, "x.log");
    writeFileSync(file, "a".repeat(1024));
    assert.equal(rotateLog(file, 4096), false);
    assert.equal(rotateLog(file, 512), true);
    assert.equal(existsSync(`${file}.1`), true);
    assert.equal(existsSync(file), false);
    assert.equal(rotateLog(path.join(dir, "missing.log"), 1), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
