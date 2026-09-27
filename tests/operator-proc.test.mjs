import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ownedProcessState,
  probeStartIdentity,
  stopSettled,
  isOwnedProcessAlive,
  pidExists,
  readStartIdentity,
  signalOwnedProcess,
  stopOwnedProcess,
} from "../scripts/operator/proc.mjs";

const PROC_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "operator", "proc.mjs");

/** Spawn a fake child and capture its exit promise IMMEDIATELY, so a test can never
 *  miss an `exit` event that fired before it attached a listener. */
const spawnFake = (source) => {
  const child = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, record: () => ({ pid: child.pid, startIdentity: readStartIdentity(child.pid) }) };
};

const spawnSleeper = (seconds = 30) => spawnFake(`setTimeout(() => {}, ${seconds * 1000});`);

test("the start identity is the same under a different locale and timezone", async () => {
  const { child, exited } = spawnSleeper(30);
  try {
    const probe = (env) =>
      execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(PROC_MODULE)}).then((m) => console.log(m.readStartIdentity(${child.pid})))`],
        { env, encoding: "utf8" },
      ).trim();
    const russian = probe({ ...process.env, LANG: "ru_RU.UTF-8", LC_ALL: "ru_RU.UTF-8", TZ: "Europe/Moscow" });
    const minimal = probe({ PATH: "/usr/bin:/bin" });
    assert.equal(russian, minimal, "identity must not depend on the caller's locale or timezone");
    assert.ok(russian.length > 0);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("a real process reports a stable start identity", async () => {
  const { child, exited } = spawnSleeper(30);
  try {
    const first = readStartIdentity(child.pid);
    assert.ok(first, "expected a start identity");
    assert.equal(readStartIdentity(child.pid), first);
    assert.equal(pidExists(child.pid), true);
    assert.equal(isOwnedProcessAlive({ pid: child.pid, startIdentity: first }), true);
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("a mismatched start identity is treated as a DIFFERENT process (PID reuse defence)", async () => {
  const { child, exited } = spawnSleeper(30);
  try {
    assert.equal(isOwnedProcessAlive({ pid: child.pid, startIdentity: "Thu Jan  1 00:00:00 1970" }), false);
    // Refusing to signal is the safe direction: no identity recorded means not ours.
    assert.equal(isOwnedProcessAlive({ pid: child.pid, startIdentity: null }), false);
    assert.equal(signalOwnedProcess({ pid: child.pid, startIdentity: "bogus" }, "SIGTERM"), false);
    assert.equal(pidExists(child.pid), true, "the unrelated process must survive");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("a dead PID is never alive and is never signalled", async () => {
  const { child, exited } = spawnSleeper(30);
  const identity = readStartIdentity(child.pid);
  const pid = child.pid;
  child.kill("SIGKILL");
  await exited;
  assert.equal(readStartIdentity(pid), null);
  assert.equal(isOwnedProcessAlive({ pid, startIdentity: identity }), false);
  assert.equal(signalOwnedProcess({ pid, startIdentity: identity }, "SIGTERM"), false);
  assert.equal(await stopOwnedProcess({ pid, startIdentity: identity }), "not-running");
});

test("stopOwnedProcess terminates a cooperative child with SIGTERM", async () => {
  const { exited, record } = spawnSleeper(30);
  const outcome = await stopOwnedProcess(record(), { graceMs: 10_000, pollMs: 50 });
  await exited;
  assert.equal(outcome, "terminated");
});

test("stopOwnedProcess escalates to SIGKILL for a child that ignores SIGTERM", async () => {
  const { exited, record } = spawnFake("process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const outcome = await stopOwnedProcess(record(), { graceMs: 1_000, pollMs: 50 });
  await exited;
  assert.equal(outcome, "killed");
});

test("stop never signals a PID whose identity changed between record and stop", async () => {
  const { child, exited } = spawnSleeper(30);
  const signals = [];
  const outcome = await stopOwnedProcess(
    { pid: child.pid, startIdentity: "recorded-at-an-earlier-time" },
    { graceMs: 100, pollMs: 10, kill: (pid, signal) => signals.push([pid, signal]) },
  );
  assert.equal(outcome, "not-running");
  assert.deepEqual(signals, []);
  assert.equal(pidExists(child.pid), true);
  child.kill("SIGKILL");
  await exited;
});

// ---------------------------------------------------------------------------
// An UNMEASURABLE process must never be mistaken for a dead one.
//
// Under load `ps` can exceed its timeout. Treating that as "already gone" makes stop
// skip the kill and silently leak the child it was asked to stop — observed in
// practice as a supervised fake daemon surviving its test runner for hours.
// ---------------------------------------------------------------------------

const unknownProbe = () => ({ state: "unknown", identity: null, error: "ETIMEDOUT" });
const aliveProbe = (identity) => () => ({ state: "alive", identity });
const goneProbe = () => ({ state: "gone", identity: null });

test("probeStartIdentity separates alive, gone and unmeasurable", async () => {
  const { child, exited } = spawnSleeper(30);
  try {
    const alive = probeStartIdentity(child.pid);
    assert.equal(alive.state, "alive");
    assert.ok(alive.identity);
    // A PID that cannot exist: ps answers cleanly with nothing.
    assert.equal(probeStartIdentity(2 ** 30).state, "gone");
    assert.equal(probeStartIdentity(0).state, "gone");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

test("the three ownership facts are never collapsed into each other", () => {
  const known = { pid: 4242, startIdentity: "recorded" };
  const unidentified = { pid: 4242, startIdentity: null };

  // stored identity known ...
  assert.equal(ownedProcessState(known, { probe: aliveProbe("recorded") }), "ours");
  assert.equal(ownedProcessState(known, { probe: goneProbe }), "gone");
  assert.equal(ownedProcessState(known, { probe: aliveProbe("someone-else") }), "gone", "PID reuse: our process is gone");
  assert.equal(ownedProcessState(known, { probe: unknownProbe }), "unknown");

  // ... and stored identity MISSING. A record whose initial measurement failed means
  // "ownership cannot yet be proven", NOT "the process is absent".
  assert.equal(ownedProcessState(unidentified, { probe: unknownProbe }), "unknown",
    "null identity + unmeasurable must never be reported as gone");
  assert.equal(ownedProcessState(unidentified, { probe: goneProbe }), "gone");
  assert.equal(ownedProcessState(unidentified, { probe: aliveProbe("whatever") }), "unknown",
    "a live PID we cannot tie to our spawn is unknown, never automatically ours");

  // No PID at all: nothing can be running.
  assert.equal(ownedProcessState({ pid: null, startIdentity: null }, { probe: unknownProbe }), "gone");
});

test("stop refuses to signal an unmeasurable process and reports it unsettled", async () => {
  const signals = [];
  const outcome = await stopOwnedProcess(
    { pid: 4242, startIdentity: "recorded" },
    { graceMs: 60, pollMs: 10, probe: unknownProbe, kill: (...args) => signals.push(args) },
  );
  assert.equal(outcome, "identity-unknown");
  assert.deepEqual(signals, [], "nothing may be signalled on an unverified identity");
  assert.equal(stopSettled(outcome), false, "an unconfirmed stop must not count as settled");
});

test("stop recovers when the measurement becomes available again", async () => {
  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls <= 2) return { state: "unknown", identity: null };
    return calls <= 4 ? { state: "alive", identity: "recorded" } : { state: "gone", identity: null };
  };
  const signals = [];
  const outcome = await stopOwnedProcess(
    { pid: 4242, startIdentity: "recorded" },
    { graceMs: 2_000, pollMs: 1, probe: flaky, kill: (...args) => signals.push(args) },
  );
  assert.equal(outcome, "terminated");
  assert.deepEqual(signals.map(([, signal]) => signal), ["SIGTERM"]);
  assert.equal(stopSettled(outcome), true);
});

test("settled outcomes are exactly the ones that prove the process is gone", () => {
  for (const outcome of ["not-running", "terminated", "killed"]) assert.equal(stopSettled(outcome), true, outcome);
  for (const outcome of ["identity-unknown", "escalation-failed"]) assert.equal(stopSettled(outcome), false, outcome);
});
