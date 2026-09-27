import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHandoffStore } from "../scripts/agent-handoff-store.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { bootstrapProfile, enabledAgents } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { readStartIdentity } from "../scripts/operator/proc.mjs";
import { writeRunState } from "../scripts/operator/runstate.mjs";
import { collectStatus, readAgentRuntimeState } from "../scripts/operator/status.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());
const NOW = 1_700_000_000_000;

const sleeper = () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, record: (name) => ({ name, pid: child.pid, startIdentity: readStartIdentity(child.pid) }) };
};

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-status-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  const { project } = await bootstrapProfile({ projectId, projectPath, paths });
  return { dir, project, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Give one agent a live BOUND_IDLE binding plus a couple of dispatch rows. */
const seedAgentStore = (paths, project, name, { heartbeatAt = NOW, dispatches = 0, openHandoffs = 0 } = {}) => {
  const agent = project.agents.find((entry) => entry.name === name);
  const dbPath = paths.agentDbFile(name);
  const dispatchStore = new WakeDispatchStore(dbPath, { recipientId: agent.agentId });
  const bindings = new RuntimeBindingStore(dbPath);
  const handoffs = new AgentHandoffStore(dbPath);
  try {
    bindings.register({
      bindingId: `${name}-binding`,
      agentId: agent.agentId,
      runtimeKind: agent.runtimeKind,
      runtimeGeneration: 1,
      projectId: project.projectId,
      memberSlot: agent.memberSlot,
      leaseTtlMs: 30_000,
      state: "STARTING",
    }, heartbeatAt);
    const row = bindings.get(`${name}-binding`);
    bindings.markIdle({ bindingId: row.bindingId, ownerGeneration: row.runtimeGeneration, fencingToken: row.leaseToken }, heartbeatAt);
    for (let i = 0; i < dispatches; i += 1) {
      dispatchStore.enqueue({
        msgId: `msg-${name}-${i}`,
        conversationId: "conv-1",
        from: "peer",
        text: "x",
        memberSlot: agent.memberSlot,
        recipientAgentId: agent.agentId,
      }, NOW);
    }
    for (let i = 0; i < openHandoffs; i += 1) {
      handoffs.createOrReuse({
        handoffMsgId: `handoff-${name}-${i}`,
        delegatorId: agent.agentId,
        recipientId: "worker",
        causedByMessageId: `cause-${i}`,
        rootMessageId: "root-1",
        rootConversationId: "conv-1",
        handoffConversationId: `conv-1#handoff-${name}-${i}`,
        parentActiveAncestry: [agent.agentId],
        handoffAncestry: [agent.agentId, "worker"],
        originatingBindingId: `${name}-binding`,
        originatingBindingGeneration: 1,
        originatingRuntimeKind: agent.runtimeKind,
        originatingMemberSlot: agent.memberSlot,
        parentMessageId: "parent-1",
        parentConversationId: "conv-1",
        parentSenderId: "operator",
        taskText: "do a thing",
      }, NOW);
    }
  } finally {
    handoffs.close?.();
    bindings.close?.();
    dispatchStore.close?.();
  }
};

test("readAgentRuntimeState summarises bindings, dispatch and continuations without dumping rows", async () => {
  const ctx = await setup();
  try {
    seedAgentStore(ctx.paths, ctx.project, "claude", { dispatches: 3, openHandoffs: 2 });
    const state = readAgentRuntimeState(ctx.paths.agentDbFile("claude"), ctx.project.agents[1].agentId, { now: NOW + 1_000 });
    assert.equal(state.bindings.length, 1);
    assert.equal(state.bindings[0].state, "BOUND_IDLE");
    assert.equal(state.bindings[0].heartbeatFresh, true);
    assert.equal(state.dispatch.pending, 3);
    assert.equal(state.openContinuations, 2);
    assert.equal(JSON.stringify(state).includes("do a thing"), false, "task text must not be surfaced");
  } finally {
    ctx.cleanup();
  }
});

test("a store that was never created reads as absent rather than throwing", async () => {
  const ctx = await setup();
  try {
    assert.equal(readAgentRuntimeState(ctx.paths.agentDbFile("cursor"), "x"), null);
  } finally {
    ctx.cleanup();
  }
});

test("status is healthy when the supervisor, every daemon and every binding are live", async () => {
  const ctx = await setup();
  const procs = [];
  try {
    for (const agent of enabledAgents(ctx.project)) {
      if (agent.memberSlot) seedAgentStore(ctx.paths, ctx.project, agent.name, { dispatches: 1, openHandoffs: 1 });
    }
    const supervisor = sleeper();
    procs.push(supervisor);
    const children = {};
    for (const agent of enabledAgents(ctx.project)) {
      const proc = sleeper();
      procs.push(proc);
      children[agent.name] = { ...proc.record(agent.name), state: "ready", logFile: ctx.paths.logFile(agent.name) };
    }
    const appServer = sleeper();
    procs.push(appServer);
    children["codex-app-server"] = appServer.record("codex-app-server");

    await writeRunState(ctx.paths, {
      projectId: ctx.project.projectId,
      phase: "ready",
      supervisor: supervisor.record("supervisor"),
      children,
    });

    const status = await collectStatus({
      project: ctx.project,
      paths: ctx.paths,
      includeNats: false,
      socketProbe: async () => ({ ok: true, reason: "connected" }),
      now: NOW + 1_000,
    });

    assert.equal(status.healthy, true, JSON.stringify(status.problems));
    assert.equal(status.supervisor.alive, true);
    assert.deepEqual(status.agents.map((agent) => agent.name), ["root", "claude", "codex", "cursor"]);
    assert.equal(status.agents.find((agent) => agent.name === "claude").binding.state, "BOUND_IDLE");
    assert.equal(status.totals.openContinuations, 3);
    assert.equal(status.totals.pendingDispatch, 3);
    assert.equal(status.appServer.alive, true);
  } finally {
    for (const proc of procs) {
      proc.child.kill("SIGKILL");
      await proc.exited;
    }
    ctx.cleanup();
  }
});

test("status is unhealthy when the supervisor is gone, and names the problem", async () => {
  const ctx = await setup();
  try {
    await writeRunState(ctx.paths, {
      projectId: ctx.project.projectId,
      phase: "stopped",
      supervisor: { pid: 999_994, startIdentity: "Thu Jan  1 00:00:00 1970" },
      children: {},
    });
    const status = await collectStatus({
      project: ctx.project,
      paths: ctx.paths,
      includeNats: false,
      socketProbe: async () => ({ ok: false, reason: "socket-absent" }),
    });
    assert.equal(status.healthy, false);
    assert.ok(status.problems.includes("supervisor is not running"));
    assert.ok(status.problems.includes("claude daemon is not running"));
    assert.equal(status.supervisor.alive, false);
  } finally {
    ctx.cleanup();
  }
});

test("a stale binding heartbeat makes the project unhealthy even while the daemon lives", async () => {
  const ctx = await setup();
  const procs = [];
  try {
    seedAgentStore(ctx.paths, ctx.project, "claude", { heartbeatAt: NOW - 600_000 });
    const supervisor = sleeper();
    procs.push(supervisor);
    const children = {};
    for (const agent of enabledAgents(ctx.project)) {
      const proc = sleeper();
      procs.push(proc);
      children[agent.name] = proc.record(agent.name);
    }
    await writeRunState(ctx.paths, {
      projectId: ctx.project.projectId,
      phase: "ready",
      supervisor: supervisor.record("supervisor"),
      children,
    });
    const status = await collectStatus({
      project: ctx.project,
      paths: ctx.paths,
      includeNats: false,
      socketProbe: async () => ({ ok: true, reason: "connected" }),
      now: NOW,
    });
    assert.equal(status.healthy, false);
    assert.ok(status.problems.some((problem) => problem.includes("claude binding heartbeat is stale")));
  } finally {
    for (const proc of procs) {
      proc.child.kill("SIGKILL");
      await proc.exited;
    }
    ctx.cleanup();
  }
});
