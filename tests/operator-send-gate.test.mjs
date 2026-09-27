import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { coordinatorGate } from "../scripts/operator/cli.mjs";
import { bootstrapProfile, enabledAgents } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { readStartIdentity } from "../scripts/operator/proc.mjs";
import { writeRunState } from "../scripts/operator/runstate.mjs";
import { collectStatus } from "../scripts/operator/status.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const NOW = 1_700_000_000_000;

const sleeper = () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, record: (name) => ({ name, pid: child.pid, startIdentity: readStartIdentity(child.pid) }) };
};

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-gate-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  const { project } = await bootstrapProfile({ projectId, projectPath, paths });
  return { dir, project, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Give one agent a binding in a chosen state/slot/heartbeat. */
const seedBinding = (paths, project, name, { state = "BOUND_IDLE", memberSlot, heartbeatAt = NOW } = {}) => {
  const agent = project.agents.find((entry) => entry.name === name);
  const dbPath = paths.agentDbFile(name);
  const dispatch = new WakeDispatchStore(dbPath, { recipientId: agent.agentId });
  const bindings = new RuntimeBindingStore(dbPath);
  try {
    bindings.register({
      bindingId: `${name}-binding`,
      agentId: agent.agentId,
      runtimeKind: agent.runtimeKind,
      runtimeGeneration: 1,
      projectId: project.projectId,
      memberSlot: memberSlot ?? agent.memberSlot,
      leaseTtlMs: 30_000,
      state: "STARTING",
    }, heartbeatAt);
    const row = bindings.get(`${name}-binding`);
    const fence = { bindingId: row.bindingId, ownerGeneration: row.runtimeGeneration, fencingToken: row.leaseToken };
    bindings.markIdle(fence, heartbeatAt);
    if (state !== "BOUND_IDLE") {
      // Drive the row to the requested state without going through a dispatch claim.
      bindings.db?.exec?.(`UPDATE runtime_bindings SET state = '${state}' WHERE binding_id = '${name}-binding'`);
    }
  } finally {
    bindings.close?.();
    dispatch.close?.();
  }
};

/** Build a live status snapshot with the given agents "running". */
const liveStatus = async (ctx, { alive = ["root", "claude", "codex", "cursor"], supervisorAlive = true, now = NOW + 1_000 } = {}) => {
  const procs = [];
  const supervisor = sleeper();
  procs.push(supervisor);
  const children = {};
  for (const agent of enabledAgents(ctx.project)) {
    if (!alive.includes(agent.name)) continue;
    const proc = sleeper();
    procs.push(proc);
    children[agent.name] = proc.record(agent.name);
  }
  await writeRunState(ctx.paths, {
    projectId: ctx.project.projectId,
    phase: "ready",
    supervisor: supervisorAlive
      ? supervisor.record("supervisor")
      : { pid: 999_991, startIdentity: "Thu Jan  1 00:00:00 1970" },
    children,
  });
  const status = await collectStatus({
    project: ctx.project,
    paths: ctx.paths,
    includeNats: false,
    socketProbe: async () => ({ ok: true, reason: "connected" }),
    now,
  });
  const release = async () => {
    for (const proc of procs) {
      proc.child.kill("SIGKILL");
      await proc.exited;
    }
  };
  return { status, release };
};

test("a healthy coordinator passes the gate", async () => {
  const ctx = await setup();
  try {
    seedBinding(ctx.paths, ctx.project, "claude");
    const { status, release } = await liveStatus(ctx);
    try {
      assert.deepEqual(coordinatorGate(status), { ok: true, reason: null });
    } finally {
      await release();
    }
  } finally {
    ctx.cleanup();
  }
});

test("a dead Claude daemon blocks the send", async () => {
  const ctx = await setup();
  try {
    seedBinding(ctx.paths, ctx.project, "claude");
    const { status, release } = await liveStatus(ctx, { alive: ["root", "codex", "cursor"] });
    try {
      const gate = coordinatorGate(status);
      assert.equal(gate.ok, false);
      assert.match(gate.reason, /claude coordinator daemon is not running/);
    } finally {
      await release();
    }
  } finally {
    ctx.cleanup();
  }
});

test("a stale coordinator heartbeat blocks the send", async () => {
  const ctx = await setup();
  try {
    seedBinding(ctx.paths, ctx.project, "claude", { heartbeatAt: NOW - 600_000 });
    const { status, release } = await liveStatus(ctx, { now: NOW });
    try {
      const gate = coordinatorGate(status);
      assert.equal(gate.ok, false);
      assert.match(gate.reason, /heartbeat is stale/);
    } finally {
      await release();
    }
  } finally {
    ctx.cleanup();
  }
});

test("a missing coordinator binding blocks the send", async () => {
  const ctx = await setup();
  try {
    const { status, release } = await liveStatus(ctx);
    try {
      const gate = coordinatorGate(status);
      assert.equal(gate.ok, false);
      assert.match(gate.reason, /no autonomous runtime binding/);
    } finally {
      await release();
    }
  } finally {
    ctx.cleanup();
  }
});

test("a binding on the wrong member slot blocks the send", async () => {
  const ctx = await setup();
  try {
    seedBinding(ctx.paths, ctx.project, "claude", { memberSlot: "claude:interactive:abc" });
    const { status, release } = await liveStatus(ctx);
    try {
      const gate = coordinatorGate(status);
      assert.equal(gate.ok, false);
      assert.match(gate.reason, /member slot claude:interactive:abc, expected claude:auto/);
    } finally {
      await release();
    }
  } finally {
    ctx.cleanup();
  }
});

test("an OFFLINE or STALE binding blocks the send", async () => {
  for (const state of ["OFFLINE", "STALE"]) {
    const ctx = await setup();
    try {
      seedBinding(ctx.paths, ctx.project, "claude", { state });
      const { status, release } = await liveStatus(ctx);
      try {
        const gate = coordinatorGate(status);
        assert.equal(gate.ok, false, state);
        assert.match(gate.reason, new RegExp(state));
      } finally {
        await release();
      }
    } finally {
      ctx.cleanup();
    }
  }
});

test("a coordinator mid-turn is reported as BUSY, not as dead", async () => {
  for (const state of ["CLAIMED", "WAKING", "RUNNING"]) {
    const ctx = await setup();
    try {
      seedBinding(ctx.paths, ctx.project, "claude", { state });
      const { status, release } = await liveStatus(ctx);
      try {
        const gate = coordinatorGate(status);
        assert.equal(gate.ok, false, state);
        assert.match(gate.reason, /busy with another task/);
        assert.match(gate.fix, /Wait for the current task/);
      } finally {
        await release();
      }
    } finally {
      ctx.cleanup();
    }
  }
});

test("a dead supervisor or a dead root daemon blocks the send before the coordinator is even considered", async () => {
  const ctx = await setup();
  try {
    seedBinding(ctx.paths, ctx.project, "claude");

    const down = await liveStatus(ctx, { supervisorAlive: false });
    try {
      assert.match(coordinatorGate(down.status).reason, /supervisor is not running/);
    } finally {
      await down.release();
    }

    const noRoot = await liveStatus(ctx, { alive: ["claude", "codex", "cursor"] });
    try {
      assert.match(coordinatorGate(noRoot.status).reason, /root\/operator daemon is not running/);
    } finally {
      await noRoot.release();
    }
  } finally {
    ctx.cleanup();
  }
});
