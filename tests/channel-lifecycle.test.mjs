/**
 * Channel-server lifecycle and diagnostics: ownership-based exit, evidence-based
 * classification, and a cleanup that can only ever touch a provably orphaned server.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { watchOwner } from "../scripts/channel-server-lifecycle.mjs";
import {
  CHANNEL_STATE, cleanupOrphanedChannelServers, commandChannels, listChannelServers, parseEtime, parsePsRow, summarizeChannelServers,
} from "../scripts/operator/channel-servers.mjs";
import { createKeyPair, createSigningKeyPair } from "../packages/security/dist/src/index.js";
import { writePrivateJson } from "../scripts/secure-state.mjs";

// ---- watchOwner (pure) -------------------------------------------------------------------
const fakeTimers = () => {
  let tick = null;
  return {
    setIntervalImpl: (fn) => { tick = fn; return { unref() {} }; },
    clearIntervalImpl: () => { tick = null; },
    fire: () => tick?.(),
    armed: () => tick !== null,
  };
};

test("watchOwner: a live, unchanged owner never triggers", () => {
  const timers = fakeTimers();
  const gone = [];
  watchOwner({ originalParentPid: 100, getParentPid: () => 100, isAlive: () => true, onOwnerGone: (r) => gone.push(r), ...timers });
  for (let i = 0; i < 5; i += 1) timers.fire();
  assert.deepEqual(gone, []);
});

test("watchOwner: reparenting or a vanished owner triggers exactly once", () => {
  for (const [getParentPid, isAlive, reason] of [[() => 1, () => true, "owner-reparented"], [() => 100, () => false, "owner-gone"]]) {
    const timers = fakeTimers();
    const gone = [];
    watchOwner({ originalParentPid: 100, getParentPid, isAlive, onOwnerGone: (r) => gone.push(r), ...timers });
    timers.fire();
    timers.fire();
    assert.deepEqual(gone, [reason]);
    assert.equal(timers.armed(), false, "stops polling once fired");
  }
});

// ---- classification (pure, fake ps) ------------------------------------------------------
const NODE = "/opt/homebrew/bin/node";
const SCRIPT = "/Users/u/Projects/murmur/scripts/murmur-mcp-channel-server.mjs";
const psRow = (pid, ppid, command, etime = "01:00:00", lstart = "Sat Oct  4 10:00:00 2026") => `${pid} ${ppid} ${etime} ${lstart} ${command}`;
const fakePs = (rows, env = {}) => (args) => (args[0] === "eww" ? `${rows.find((r) => r.startsWith(`${args[2]} `)) ?? ""} DATA_DIR=${env[args[2]] ?? "/Users/u/Projects/murmur/.data-codex"}` : rows.join("\n"));

test("parsers: etime and ps rows", () => {
  assert.equal(parseEtime("01-02:03:04"), ((1 * 24 + 2) * 60 + 3) * 60 + 4);
  assert.equal(parseEtime("05:00"), 300);
  assert.equal(parseEtime("garbage"), null);
  const row = parsePsRow(psRow(42, 7, `${NODE} ${SCRIPT}`));
  assert.deepEqual([row.pid, row.ppid, row.startedAt], [42, 7, "Sat Oct  4 10:00:00 2026"]);
});

test("classification: an old server under a LIVE owner is live; only a broken ownership is orphaned", () => {
  const rows = [
    psRow(7, 1, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen unix:///x.sock"),
    psRow(10, 7, `${NODE} ${SCRIPT}`, "09-00:00:00"), // days old, owner alive -> live
    psRow(11, 1, `${NODE} ${SCRIPT}`, "00:10"), // reparented to launchd -> orphaned
    psRow(12, 9999, `${NODE} ${SCRIPT}`, "00:10"), // parent pid not in table -> orphaned
    psRow(13, 7, `grep ${SCRIPT}`), // mentions the script, is not a channel server
    psRow(14, 7, `/usr/bin/vim ${SCRIPT}`),
  ];
  const snapshot = listChannelServers({ psImpl: fakePs(rows) });
  assert.equal(snapshot.total, 3);
  const byPid = Object.fromEntries(snapshot.servers.map((s) => [s.pid, s]));
  assert.equal(byPid[10].state, CHANNEL_STATE.live);
  assert.equal(byPid[10].parentKind, "codex-app-server");
  assert.equal(byPid[11].state, CHANNEL_STATE.orphaned);
  assert.match(byPid[11].evidence, /launchd/);
  assert.equal(byPid[12].state, CHANNEL_STATE.orphaned);
  assert.equal(byPid[10].profileKind, "legacy");
  assert.equal(snapshot.orphaned, 2);
});

test("accumulation under one owner is reported as crowded but never as orphaned", () => {
  const rows = [psRow(7, 1, "codex app-server --listen stdio://")];
  for (let pid = 100; pid < 112; pid += 1) rows.push(psRow(pid, 7, `${NODE} ${SCRIPT}`, "20:00:00"));
  const snapshot = listChannelServers({ psImpl: fakePs(rows), crowdedThreshold: 8 });
  assert.equal(snapshot.total, 12);
  assert.equal(snapshot.orphaned, 0);
  assert.equal(snapshot.parents[0].crowded, true);
  const summary = summarizeChannelServers(snapshot);
  assert.equal(summary.status, "WARN");
  assert.match(summary.detail, /not proven stale/);
  assert.equal(summarizeChannelServers({ total: 0, orphaned: 0, parents: [], legacySharedProfile: 0 }).status, "PASS");
});

test("cleanup signals only orphaned servers, re-verified, and never a live one", () => {
  const live = psRow(10, 7, `${NODE} ${SCRIPT}`);
  const orphan = psRow(11, 1, `${NODE} ${SCRIPT}`);
  const rows = [psRow(7, 1, "codex app-server"), live, orphan];
  const snapshot = listChannelServers({ psImpl: fakePs(rows) });
  const signalled = [];
  const results = cleanupOrphanedChannelServers({ snapshot, psImpl: fakePs(rows), kill: (pid, signal) => signalled.push([pid, signal]) });
  assert.deepEqual(signalled, [[11, "SIGTERM"]]);
  assert.equal(results.find((r) => r.pid === 10).outcome, "skipped-not-orphaned");
});

test("cleanup refuses a pid whose identity changed or that gained a live owner since the snapshot", () => {
  const orphan = psRow(11, 1, `${NODE} ${SCRIPT}`);
  const snapshot = listChannelServers({ psImpl: fakePs([orphan]) });
  const signalled = [];
  const kill = (pid) => signalled.push(pid);
  // pid recycled: same number, different start time
  const recycled = psRow(11, 1, `${NODE} ${SCRIPT}`, "00:01", "Sat Oct  4 12:00:00 2026");
  assert.equal(cleanupOrphanedChannelServers({ snapshot, psImpl: fakePs([recycled]), kill })[0].outcome, "skipped-identity-changed");
  // pid recycled into an unrelated process
  const other = psRow(11, 1, "/usr/bin/some-editor", "00:01");
  assert.equal(cleanupOrphanedChannelServers({ snapshot, psImpl: fakePs([other]), kill })[0].outcome, "skipped-identity-changed");
  // gone
  assert.equal(cleanupOrphanedChannelServers({ snapshot, psImpl: fakePs([]), kill })[0].outcome, "already-gone");
  assert.deepEqual(signalled, []);
});

test("murmur channels: --json reports ownership; --cleanup stops only the orphan", async () => {
  const rows = [psRow(7, 1, "codex app-server"), psRow(10, 7, `${NODE} ${SCRIPT}`), psRow(11, 1, `${NODE} ${SCRIPT}`)];
  const lines = [];
  const signalled = [];
  const code = await commandChannels({
    flags: { json: true, cleanup: true }, out: (l) => lines.push(l), err: () => {}, psImpl: fakePs(rows), kill: (pid) => signalled.push(pid),
  });
  assert.equal(code, 0);
  const report = JSON.parse(lines.join("\n"));
  assert.equal(report.total, 2);
  assert.equal(report.orphaned, 1);
  assert.deepEqual(signalled, [11]);
  assert.deepEqual(report.cleanup.map((r) => [r.pid, r.outcome]), [[10, "skipped-not-orphaned"], [11, "terminated"]]);
  assert.ok(!JSON.stringify(report).includes("DATA_DIR"), "no environment is echoed");
});

test("murmur channels: an unreadable process table is an error, not an empty OK", async () => {
  const errors = [];
  const code = await commandChannels({ flags: {}, out: () => {}, err: (l) => errors.push(l), psImpl: () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); } });
  assert.equal(code, 3);
  assert.match(errors[0], /ETIMEDOUT/);
});

// ---- the real channel server process ------------------------------------------------------
const hasNats = (() => { try { execFileSync("nats-server", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const waitFor = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const harness = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "murmur-chan-"));
  const port = await freePort();
  const nats = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", path.join(dir, "js")], { stdio: "ignore" });
  const data = path.join(dir, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await writePrivateJson(path.join(data, "agent-config.json"), {
    agentId: "a", natsUrl: `nats://127.0.0.1:${port}`, subject: "msg.a", dataDir: data,
    keys: { encryption: await createKeyPair(), signing: await createSigningKeyPair() }, peers: {},
  });
  await new Promise((r) => setTimeout(r, 300));
  const env = {
    ...process.env, DATA_DIR: data, MURMUR_STORE_PATH: path.join(data, "murmur.db"), MURMUR_LEASE_DB: path.join(data, "lease.db"),
    MURMUR_MCP_LOG_PATH: path.join(dir, "channel.log"), MURMUR_MCP_OWNER_POLL_MS: "100",
  };
  return { dir, env, cleanup: async () => { nats.kill("SIGTERM"); await rm(dir, { recursive: true, force: true }); } };
};
const SERVER_JS = path.resolve("scripts/murmur-mcp-channel-server.mjs");

test("channel server: exits on session end; many sequential sessions do not accumulate", { skip: !hasNats && "nats-server not installed" }, async () => {
  const h = await harness();
  try {
    const pids = [];
    for (let i = 0; i < 5; i += 1) {
      const proc = spawn(process.execPath, [SERVER_JS], { env: h.env, stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
      pids.push(proc.pid);
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(alive(proc.pid), "alive while its session is open");
      proc.stdin.end(); // the MCP client goes away
      assert.equal(await exited, 0);
    }
    assert.deepEqual(pids.filter(alive), [], "no channel server survived its session");
  } finally {
    await h.cleanup();
  }
});

test("channel server: a live owner keeps it alive; a dead owner (pipe still open) ends it", { skip: !hasNats && "nats-server not installed" }, async () => {
  const h = await harness();
  // The owner is a node process that starts the channel server with INHERITED stdin, and the
  // test holds the pipe's write end — so EOF can NOT be what ends the server below.
  const ownerScript = `const {spawn}=require("node:child_process");
    const c=spawn(process.execPath,[${JSON.stringify(SERVER_JS)}],{env:process.env,stdio:["inherit","ignore","ignore"]});
    console.log(c.pid); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ["-e", ownerScript], { env: h.env, stdio: ["pipe", "pipe", "ignore"] });
  let serverPid = null;
  try {
    serverPid = await new Promise((resolve) => owner.stdout.once("data", (d) => resolve(Number(String(d).trim()))));
    await new Promise((r) => setTimeout(r, 1200)); // >10 owner polls at 100ms
    assert.ok(alive(serverPid), "a live owner must not be mistaken for a dead one");
    process.kill(owner.pid, "SIGKILL");
    assert.ok(await waitFor(() => !alive(serverPid)), "server exits once its owner is gone, without any EOF");
  } finally {
    if (serverPid && alive(serverPid)) process.kill(serverPid, "SIGTERM");
    owner.stdin.end();
    await h.cleanup();
  }
});
