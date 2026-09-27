import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readPrivateJson } from "../scripts/secure-state.mjs";
import { parseArgs } from "../scripts/operator/cli.mjs";
import { loadProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { readStartIdentity } from "../scripts/operator/proc.mjs";
import { readRunState, writeRunState } from "../scripts/operator/runstate.mjs";

const execFileAsync = promisify(execFile);
const MURMUR_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(MURMUR_ROOT, "bin", "murmur.mjs");
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const stub = (dir, name, body) => {
  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return bin;
};

/**
 * A closed port: preflight's NATS check then fails deterministically on ANY host, so
 * these tests never depend on a live broker — and never accidentally start a real
 * project just because this machine happens to have one running.
 */
const UNREACHABLE_NATS = "nats://127.0.0.1:1";

const setup = ({ tools = {} } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-cli-"));
  mkdirSync(path.join(dir, "project"), { recursive: true });
  // The CLI canonicalizes the project path, so the test must compare against the same
  // canonical form (on macOS `/tmp` is a symlink to `/private/tmp`).
  const projectPath = realpathSync(path.join(dir, "project"));
  const home = path.join(dir, ".murmur");
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home });
  let bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) bin = stub(dir, name, body);
  return {
    dir,
    projectPath,
    projectId,
    paths,
    /**
     * Create the profile directly. Tests that only need "a profile exists and nothing
     * is running" use this instead of a `murmur start` that is expected to fail, so
     * what they assert does not depend on which agent CLIs this host has installed.
     */
    bootstrap: async () => {
      const { bootstrapProfile } = await import("../scripts/operator/profile.mjs");
      return bootstrapProfile({ projectId, projectPath, paths, natsUrl: UNREACHABLE_NATS });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    murmur: async (...args) => {
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
          env: { HOME: dir, PATH: bin, MURMUR_HOME: home },
          encoding: "utf8",
          timeout: 60_000,
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
      }
    },
  };
};

const AUTHED_CLAUDE = '#!/bin/sh\nif [ "$1" = "auth" ]; then echo \'{"loggedIn":true}\'; fi\nexit 0\n';
const AUTHED_AGENT = '#!/bin/sh\necho "Logged in as tester"\nexit 0\n';

test("argument parsing covers the documented flags and rejects unknown ones", () => {
  assert.deepEqual(parseArgs(["status", "murmur", "--json"]), {
    command: "status",
    args: ["murmur"],
    flags: { json: true, foreground: false, follow: false, wait: true, lines: 200, timeoutSeconds: null },
  });
  const started = parseArgs(["start", "/a/b", "--foreground", "--timeout", "30"]);
  assert.equal(started.flags.foreground, true);
  assert.equal(started.flags.timeoutSeconds, 30);
  assert.equal(parseArgs(["send", "p", "do", "a", "thing", "--no-wait"]).flags.wait, false);
  assert.throws(() => parseArgs(["status", "p", "--nope"]), /unknown-flag:--nope/);
  assert.throws(() => parseArgs(["logs", "p", "-n", "0"]), /invalid-lines/);
  assert.throws(() => parseArgs(["start", "p", "--timeout", "x"]), /invalid-timeout/);
});

test("no command prints usage; an unknown command and a missing project are usage errors", async () => {
  const ctx = setup();
  try {
    const bare = await ctx.murmur();
    assert.equal(bare.code, 1);
    assert.match(bare.stdout, /Usage:/);

    const unknown = await ctx.murmur("frobnicate", "x");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown command 'frobnicate'/);

    const noProject = await ctx.murmur("status");
    assert.equal(noProject.code, 1);
    assert.match(noProject.stderr, /status requires <project>/);
  } finally {
    ctx.cleanup();
  }
});

test("an unresolvable project fails clearly and starts nothing", async () => {
  const ctx = setup();
  try {
    const missing = await ctx.murmur("start", path.join(ctx.dir, "does-not-exist"));
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /project-not-found/);
    assert.equal(existsSync(ctx.paths.root), false);

    const traversal = await ctx.murmur("doctor", "../../etc");
    assert.equal(traversal.code, 1);
    assert.match(traversal.stderr, /project-name-must-be-plain/);
  } finally {
    ctx.cleanup();
  }
});

test("doctor describes a never-started project without creating a profile", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    const result = await ctx.murmur("doctor", ctx.projectPath);
    assert.match(result.stdout, /Project: /);
    assert.match(result.stdout, /Profile: /);
    assert.match(result.stdout, /WARN\s+profile/);
    assert.equal(existsSync(ctx.paths.projectFile), false);
    assert.deepEqual(readdirSync(ctx.projectPath), []);
  } finally {
    ctx.cleanup();
  }
});

test("start bootstraps a profile, then refuses to launch anything when preflight fails", async () => {
  const ctx = setup({ tools: { agent: AUTHED_AGENT } }); // no `claude` on PATH
  try {
    const result = await ctx.murmur("start", ctx.projectPath);
    assert.equal(result.code, 2);
    assert.match(result.stdout, /Created a new Murmur profile/);
    assert.match(result.stderr, /preflight failed — nothing was started/);
    assert.match(result.stderr, /claude-binary/);

    // Profile exists; no supervisor, no lock, no logs from a partial start.
    assert.equal(existsSync(ctx.paths.projectFile), true);
    assert.equal(await readRunState(ctx.paths), null);
    assert.equal(existsSync(ctx.paths.lockFile), false);
    assert.equal(existsSync(ctx.paths.logFile("claude")), false);
    assert.deepEqual(readdirSync(ctx.projectPath), [], "nothing is written into the repository");
  } finally {
    ctx.cleanup();
  }
});

test("an unauthenticated Claude blocks start before any process is launched", async () => {
  const ctx = setup({
    tools: { claude: '#!/bin/sh\necho \'{"loggedIn":false}\'\nexit 1\n', agent: AUTHED_AGENT },
  });
  try {
    const result = await ctx.murmur("start", ctx.projectPath);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /claude-auth/);
    assert.match(result.stderr, /fix: claude auth login/);
    assert.equal(await readRunState(ctx.paths), null);
  } finally {
    ctx.cleanup();
  }
});

test("an unauthenticated Cursor blocks start and prints `agent login`", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: '#!/bin/sh\necho "Not logged in"\nexit 0\n' } });
  try {
    const result = await ctx.murmur("start", ctx.projectPath);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /fix: agent login/);
    assert.equal(await readRunState(ctx.paths), null);
  } finally {
    ctx.cleanup();
  }
});

test("a second start is refused while a live supervisor owns the project", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await ctx.bootstrap();
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "ready",
      supervisor: { pid: process.pid, startIdentity: readStartIdentity(process.pid) },
      children: {},
    });

    const duplicate = await ctx.murmur("start", ctx.projectPath);
    assert.equal(duplicate.code, 3);
    assert.match(duplicate.stderr, /refusing to start/);
    assert.match(duplicate.stderr, new RegExp(`pid ${process.pid}`));
  } finally {
    ctx.cleanup();
  }
});

test("status on a project with no profile exits non-zero and says so", async () => {
  const ctx = setup();
  try {
    const result = await ctx.murmur("status", ctx.projectPath);
    assert.equal(result.code, 3);
    assert.match(result.stdout, /Profile:  none/);
  } finally {
    ctx.cleanup();
  }
});

test("status reports an unhealthy, stopped project and exits non-zero", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await ctx.bootstrap();
    const project = await loadProfile(ctx.paths);
    assert.equal(project.natsUrl, UNREACHABLE_NATS);

    const result = await ctx.murmur("status", ctx.projectPath);
    assert.equal(result.code, 3);
    assert.match(result.stdout, /Supervisor:  not running/);
    assert.match(result.stdout, /UNHEALTHY/);
    assert.match(result.stdout, /Open continuations: 0/);

    const json = await ctx.murmur("status", ctx.projectPath, "--json");
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.healthy, false);
    assert.equal(parsed.profile.natsTokenConfigured, false);
    assert.equal(JSON.stringify(parsed).includes("privateKey"), false);
  } finally {
    ctx.cleanup();
  }
});

test("stop is idempotent and never deletes identities, profile or history", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await ctx.bootstrap();
    const before = await readPrivateJson(ctx.paths.agentConfigFile("claude"));

    const first = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /Nothing to stop|Murmur stopped/);

    const second = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(second.code, 0);

    const after = await readPrivateJson(ctx.paths.agentConfigFile("claude"));
    assert.deepEqual(after, before);
    assert.equal(existsSync(ctx.paths.projectFile), true);
  } finally {
    ctx.cleanup();
  }
});

test("stop reaps only the children this project recorded, and leaves the rest alone", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  const { spawn } = await import("node:child_process");
  const owned = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const ownedExit = new Promise((resolve) => owned.on("exit", resolve));
  const bystanderExit = new Promise((resolve) => bystander.on("exit", resolve));
  try {
    await ctx.bootstrap();
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "ready",
      supervisor: { pid: 999_993, startIdentity: "Thu Jan  1 00:00:00 1970" },
      children: {
        claude: { name: "claude", pid: owned.pid, startIdentity: readStartIdentity(owned.pid) },
        // Present in run state but NOT actually ours: the identity does not match.
        impostor: { name: "impostor", pid: bystander.pid, startIdentity: "Thu Jan  1 00:00:00 1970" },
      },
    });

    const result = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /stopped claude/);
    assert.equal(result.stdout.includes("impostor"), false);
    await ownedExit;

    let bystanderAlive = true;
    try {
      process.kill(bystander.pid, 0);
    } catch {
      bystanderAlive = false;
    }
    assert.equal(bystanderAlive, true, "an unrelated process must never be signalled");
  } finally {
    owned.kill("SIGKILL");
    bystander.kill("SIGKILL");
    await Promise.all([ownedExit, bystanderExit]);
    ctx.cleanup();
  }
});

test("stop clears stale run state and lock left by a dead supervisor", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await ctx.bootstrap();
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "ready",
      supervisor: { pid: 999_992, startIdentity: "Thu Jan  1 00:00:00 1970" },
      children: {},
    });
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ pid: 999_992, startIdentity: "Thu Jan  1 00:00:00 1970" }));

    const result = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(result.code, 0);
    assert.equal(existsSync(ctx.paths.supervisorFile), false);
    assert.equal(existsSync(ctx.paths.lockFile), false);
  } finally {
    ctx.cleanup();
  }
});

test("a stop/start cycle reuses the SAME identities, pairing and profile", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    const first = await ctx.bootstrap();
    assert.equal(first.created, true);
    const identities = {};
    for (const name of ["root", "claude", "codex", "cursor"]) {
      identities[name] = await readPrivateJson(ctx.paths.agentConfigFile(name));
    }
    const created = (await loadProfile(ctx.paths)).createdAt;

    await ctx.murmur("stop", ctx.projectPath);
    // A real `murmur start` against the reused profile: it stops at the NATS preflight,
    // which is exactly what proves it neither recreated nor repaired anything.
    const second = await ctx.murmur("start", ctx.projectPath);
    assert.equal(second.code, 2);
    assert.equal(second.stdout.includes("Created a new Murmur profile"), false);
    assert.equal(second.stdout.includes("Repaired missing profile pieces"), false);

    for (const name of ["root", "claude", "codex", "cursor"]) {
      assert.deepEqual(await readPrivateJson(ctx.paths.agentConfigFile(name)), identities[name], name);
    }
    assert.equal((await loadProfile(ctx.paths)).createdAt, created);
  } finally {
    ctx.cleanup();
  }
});

test("two projects keep entirely separate profiles, sockets, logs and run state", async () => {
  const a = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  const b = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await a.bootstrap();
    await b.bootstrap();
    const claudeA = await readPrivateJson(a.paths.agentConfigFile("claude"));
    const claudeB = await readPrivateJson(b.paths.agentConfigFile("claude"));
    assert.notEqual(claudeA.agentId, claudeB.agentId);
    assert.notEqual(claudeA.subject, claudeB.subject);
    assert.notEqual(a.paths.codexSocket, b.paths.codexSocket);
    assert.notEqual(a.paths.supervisorFile, b.paths.supervisorFile);
    assert.notEqual(a.paths.logFile("claude"), b.paths.logFile("claude"));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("logs rejects an unknown child and reports a missing log honestly", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await ctx.bootstrap();
    const unknown = await ctx.murmur("logs", ctx.projectPath, "nonsense");
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unknown log 'nonsense'/);

    const missing = await ctx.murmur("logs", ctx.projectPath, "claude");
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /no log yet/);
  } finally {
    ctx.cleanup();
  }
});

test("send refuses when the project is not running, and enqueues nothing at all", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    const noProfile = await ctx.murmur("send", ctx.projectPath, "hello");
    assert.equal(noProfile.code, 3);
    assert.match(noProfile.stderr, /no profile for this project/);

    await ctx.bootstrap();
    const notRunning = await ctx.murmur("send", ctx.projectPath, "hello");
    assert.equal(notRunning.code, 3);
    assert.match(notRunning.stderr, /refusing to send/);
    assert.match(notRunning.stderr, /supervisor is not running/);

    // FAIL CLOSED means nothing reached the root identity's durable state: no outbox
    // row, no local message, not even a database.
    assert.equal(existsSync(ctx.paths.agentDbFile("root")), false, "send must not create the root store");

    const noText = await ctx.murmur("send", ctx.projectPath);
    assert.equal(noText.code, 1);
    assert.match(noText.stderr, /send requires a task/);
  } finally {
    ctx.cleanup();
  }
});

test("send refuses when the coordinator binding is unusable, and enqueues nothing", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  const { spawn } = await import("node:child_process");
  const procs = [];
  const live = (name) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
    procs.push({ child, exited: new Promise((resolve) => child.on("exit", resolve)) });
    return { name, pid: child.pid, startIdentity: readStartIdentity(child.pid) };
  };
  try {
    await ctx.bootstrap();
    // Supervisor, root and claude all "running" — but Claude never registered a binding.
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "ready",
      supervisor: live("supervisor"),
      children: { root: live("root"), claude: live("claude") },
    });

    const result = await ctx.murmur("send", ctx.projectPath, "do a thing");
    assert.equal(result.code, 3);
    assert.match(result.stderr, /no autonomous runtime binding/);
    assert.equal(existsSync(ctx.paths.agentDbFile("root")), false, "nothing may be enqueued behind a failed gate");
  } finally {
    for (const proc of procs) {
      proc.child.kill("SIGKILL");
      await proc.exited;
    }
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Residual ownership must keep the project fail-closed, end to end through the CLI.
// ---------------------------------------------------------------------------

test("stop reports STOP INCOMPLETE and retains evidence when a child cannot be proven gone", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  const { spawn } = await import("node:child_process");
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const bystanderExit = new Promise((resolve) => bystander.on("exit", resolve));
  try {
    await ctx.bootstrap();
    // A live PID with NO recorded identity: ownership is unprovable, so it is UNKNOWN
    // and must never be signalled nor reported as stopped.
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "ready",
      supervisor: { pid: 999_402, startIdentity: "Thu Jan  1 00:00:00 1970" },
      children: { claude: { name: "claude", pid: bystander.pid, startIdentity: null } },
    });
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ pid: 999_402, startIdentity: "Thu Jan  1 00:00:00 1970" }));

    const stop = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(stop.code, 3, stop.stderr);
    assert.match(stop.stderr, /STOP INCOMPLETE/);
    assert.match(stop.stderr, /claude pid=/);

    // Evidence survives for the retry, and the unrelated process was never signalled.
    const retained = await readRunState(ctx.paths);
    assert.equal(retained.children.claude.pid, bystander.pid);
    assert.equal(retained.phase, "stop-incomplete");
    let alive = true;
    try {
      process.kill(bystander.pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, "an unprovable process must never be killed");

    // And a new start stays refused while that residual is unresolved.
    const start = await ctx.murmur("start", ctx.projectPath);
    assert.equal(start.code, 3, start.stderr);
    assert.match(start.stderr, /not proven stopped/);
  } finally {
    bystander.kill("SIGKILL");
    await bystanderExit;
    ctx.cleanup();
  }
});

test("once the residual is genuinely gone, stop completes and start is allowed again", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const childExit = new Promise((resolve) => child.on("exit", resolve));
  try {
    await ctx.bootstrap();
    await writeRunState(ctx.paths, {
      projectId: ctx.projectId,
      phase: "stop-incomplete",
      supervisor: { pid: 999_403, startIdentity: "Thu Jan  1 00:00:00 1970" },
      children: { claude: { name: "claude", pid: child.pid, startIdentity: readStartIdentity(child.pid) } },
    });

    const stop = await ctx.murmur("stop", ctx.projectPath);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /Murmur stopped/);
    await childExit;
    assert.equal(existsSync(ctx.paths.supervisorFile), false, "a proven-clean stop clears the evidence");

    // Fail-closed no longer applies: a start gets as far as preflight.
    const start = await ctx.murmur("start", ctx.projectPath);
    assert.equal(start.code, 2, start.stderr);
    assert.equal(start.stderr.includes("not proven stopped"), false);
  } finally {
    child.kill("SIGKILL");
    await childExit;
    ctx.cleanup();
  }
});

test("a start is refused while the lock owner cannot be verified", async () => {
  const ctx = setup({ tools: { claude: AUTHED_CLAUDE, agent: AUTHED_AGENT } });
  try {
    await ctx.bootstrap();
    // A lock with no recorded owner: not provably abandoned, so not reclaimable.
    writeFileSync(ctx.paths.lockFile, JSON.stringify({ acquiredAt: new Date().toISOString() }));
    const start = await ctx.murmur("start", ctx.projectPath);
    assert.equal(start.code, 3, start.stderr);
    assert.match(start.stderr, /lock is unknown/);
    assert.equal(existsSync(ctx.paths.lockFile), true, "an unverifiable lock is never deleted by a start attempt");
  } finally {
    ctx.cleanup();
  }
});
