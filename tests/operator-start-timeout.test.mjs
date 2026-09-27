import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writePrivateJson } from "../scripts/secure-state.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { isOwnedProcessAlive, pidExists, readStartIdentity } from "../scripts/operator/proc.mjs";
import { readLock, readRunState } from "../scripts/operator/runstate.mjs";

const execFileAsync = promisify(execFile);
const MURMUR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(MURMUR_ROOT, "bin", "murmur.mjs");
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal NATS wire endpoint: enough INFO/PING/PONG for the real client used by
 * preflight to connect. It keeps this production-path test free of any live service.
 */
const startFakeNats = async () => {
  const server = net.createServer((socket) => {
    socket.write(`INFO ${JSON.stringify({
      server_id: "MURMUR-TEST", server_name: "murmur-test", version: "2.10.0", proto: 1,
      go: "", host: "127.0.0.1", port: 0, headers: true, max_payload: 1048576, client_id: 1,
    })}\r\n`);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n")) if (line.startsWith("PING")) socket.write("PONG\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `nats://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};

const AUTHED_CLAUDE = '#!/bin/sh\nif [ "$1" = "auth" ]; then echo \'{"loggedIn":true}\'; fi\nexit 0\n';
const AUTHED_AGENT = '#!/bin/sh\necho "Logged in as tester"\nexit 0\n';

/**
 * A Codex App Server that starts, stays alive, and NEVER creates its socket — so the
 * supervisor is genuinely, legitimately slow to become ready. Nothing about the CLI or
 * the supervisor is stubbed.
 *
 * It must not depend on PATH (these tests run the CLI with a deliberately minimal one),
 * so it runs under an absolute node shebang rather than a shell builtin.
 */
const SLOW_APP_SERVER = (nodeBin) => `#!${nodeBin}\nsetInterval(() => {}, 1000);\n`;
/** Same, but binds the socket after a delay, to drive the readiness race. */
const SLOW_THEN_READY_APP_SERVER = (nodeBin, delayMs) =>
  `#!${nodeBin}\nconst net=require("node:net");const p=process.argv[2].replace(/^unix:\\/*/,"/");\n`
  + `setTimeout(()=>{const s=net.createServer(()=>{});s.listen(p);},${delayMs});\nsetInterval(()=>{},1000);\n`;

const setup = async ({ appServer = SLOW_APP_SERVER(process.execPath) } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-to-"));
  mkdirSync(path.join(dir, "project"), { recursive: true });
  const projectPath = realpathSync(path.join(dir, "project"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["claude", AUTHED_CLAUDE], ["agent", AUTHED_AGENT], ["codex", appServer]]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }

  const home = path.join(dir, ".murmur");
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home });
  const nats = await startFakeNats();

  const murmur = async (...args) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
        env: { HOME: dir, PATH: bin, MURMUR_HOME: home },
        encoding: "utf8",
        timeout: 180_000,
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  // Bootstrap through the real CLI, then point the profile at the fake broker.
  await murmur("doctor", projectPath);
  const { bootstrapProfile } = await import("../scripts/operator/profile.mjs");
  await bootstrapProfile({ projectId, projectPath, paths, natsUrl: nats.url });
  const project = JSON.parse(readFileSync(paths.projectFile, "utf8"));
  project.natsUrl = nats.url;
  await writePrivateJson(paths.projectFile, project);

  return {
    dir, projectPath, projectId, paths, murmur,
    cleanup: async () => {
      await murmur("stop", projectPath).catch(() => {});
      await nats.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const recordedChildren = async (paths) => Object.values((await readRunState(paths))?.children || {});

test("a CLI start timeout tears down the exact supervisor it just created", async () => {
  const ctx = await setup();
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const bystanderExit = new Promise((resolve) => bystander.on("exit", resolve));
  try {
    const startedAt = Date.now();
    const result = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");

    // Guard against the stub dying early and silently turning this into the
    // supervisor's own fail-fast rollback instead of the CLI timeout path.
    assert.ok(Date.now() - startedAt >= 3_000, "the CLI-side readiness timeout must be what fired");
    assert.match(result.stderr, /timed out after 3s/);
    assert.equal(result.code, 4, `expected exit 4, got ${result.code}: ${result.stderr}`);
    assert.match(result.stderr, /did not reach ready/);
    assert.match(result.stderr, /Cleaned up the supervisor this command started/);
    assert.equal(result.stderr.includes("CLEANUP INCOMPLETE"), false);

    // The supervisor this invocation spawned, and every child it recorded, are gone.
    const state = await readRunState(ctx.paths);
    assert.equal(state === null || !isOwnedProcessAlive(state.supervisor), true, "supervisor must not survive");
    for (const child of await recordedChildren(ctx.paths)) {
      assert.equal(isOwnedProcessAlive(child), false, `${child.name} must not survive`);
    }
    // No `codex`/`sleep` child is left behind either.
    const { stdout } = await execFileAsync("/bin/ps", ["-eo", "pid,command"], { encoding: "utf8" });
    assert.equal(stdout.includes(path.join(ctx.dir, "bin", "codex")), false, "the App Server child must be gone");

    // An unrelated process is untouched, and the project is recoverable.
    assert.equal(pidExists(bystander.pid), true);
    const lock = readLock(ctx.paths);
    assert.equal(lock === null || !isOwnedProcessAlive(lock), true, "a stale lock must not block a retry");
    assert.equal(existsSync(ctx.paths.projectFile), true, "the profile survives a failed start");

    // Recoverable means a later start is not refused as a duplicate.
    const retry = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.notEqual(retry.code, 3, `a retry must not be refused as a duplicate: ${retry.stderr}`);
  } finally {
    bystander.kill("SIGKILL");
    await bystanderExit;
    await ctx.cleanup();
  }
});

test("a readiness race resolves to EITHER a truthful success OR a fully cleaned failure", async () => {
  const ctx = await setup({ appServer: SLOW_THEN_READY_APP_SERVER(process.execPath, 2_500) });
  try {
    const result = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");

    if (result.code === 0) {
      // Truthful success: the project really is up.
      assert.match(result.stdout, /Murmur started/);
      const state = await readRunState(ctx.paths);
      assert.equal(state.phase, "ready");
      assert.equal(isOwnedProcessAlive(state.supervisor), true, "a reported success must actually be running");
    } else {
      // Fully cleaned failure: nothing from this start may be left running.
      assert.equal(result.stderr.includes("CLEANUP INCOMPLETE"), false, result.stderr);
      const state = await readRunState(ctx.paths);
      assert.equal(state === null || !isOwnedProcessAlive(state.supervisor), true,
        "a reported failure must never leave its supervisor running");
      for (const child of await recordedChildren(ctx.paths)) {
        assert.equal(isOwnedProcessAlive(child), false, `${child.name} must not survive a reported failure`);
      }
    }
  } finally {
    await ctx.cleanup();
  }
});

test("a start that times out never touches a pre-existing supervisor", async () => {
  const ctx = await setup();
  // A live process standing in for another project's supervisor, recorded nowhere in
  // this project's run state.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const otherExit = new Promise((resolve) => other.on("exit", resolve));
  try {
    await sleep(100);
    const identity = readStartIdentity(other.pid);
    const result = await ctx.murmur("start", ctx.projectPath, "--timeout", "3");
    assert.equal(result.code, 4);
    assert.match(result.stderr, /timed out after 3s/);
    assert.equal(isOwnedProcessAlive({ pid: other.pid, startIdentity: identity }), true,
      "cleanup must only ever touch the supervisor this invocation created");
  } finally {
    other.kill("SIGKILL");
    await otherExit;
    await ctx.cleanup();
  }
});
