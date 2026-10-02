/**
 * runtime-exactly-once.test.mjs — one logical msgId, one execution.
 *
 * Reproduces the observed defect: a Codex handoff that outlived the 180 s wait was retried and
 * seeded a NEW App Server thread each time (three different thread ids for one msgId). The fake
 * App Server client below records every protocol call, so "no second thread / no second turn"
 * is asserted on what actually reached the server. Message ids are synthetic.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CODEX_APP_SERVER_MEMBER_SLOT, CodexAppServerRuntimeAdapter } from "../scripts/agent-runtime-adapter.mjs";
import { createCodexAppServerInjector } from "../scripts/codex-app-server-wake.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { RuntimeTurnStore } from "../scripts/runtime-turn-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";

const MSG = "handoff-msg-0001";
const contexts = [];
test.afterEach(async () => {
  while (contexts.length) { const c = contexts.pop(); await c.teardown(); rmSync(c.dir, { recursive: true, force: true }); }
});

/** A recording App Server. `script` decides how each turn wait ends. */
const makeServer = ({ script = [] } = {}) => {
  const calls = [];
  const state = { threads: 0, turns: 0 };
  const queue = [...script];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") { state.threads += 1; return { thread: { id: `thread-${state.threads}` } }; }
      return {};
    }
    async startTurnAndWaitForFinal(params, options) {
      const attach = Boolean(options.attach);
      calls.push({ method: attach ? "attach" : "turn/start", params, attach: options.attach });
      let turnId;
      if (attach) turnId = options.attach.turnId;
      else { state.turns += 1; turnId = `turn-${state.turns}`; }
      options.onTurnId?.({ turnId, threadId: params.threadId, abort: () => {} });
      const outcome = queue.shift() ?? "complete";
      if (outcome === "timeout") throw new Error(`codex-app-server-turn-completion-timeout:/fake:${turnId}`);
      if (outcome === "thread-missing") throw new Error("codex-app-server-error:thread not found: " + params.threadId);
      return { finalText: "the substantive result", turnId, source: "app-server-events" };
    }
  }
  return { FakeClient, calls, state };
};

const makeAdapter = ({ server, dir, dbPath, identity = () => "server-1" } = {}) => {
  const baseDir = dir ?? mkdtempSync(path.join(os.tmpdir(), "murmur-once-"));
  const db = dbPath ?? path.join(baseDir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(db, { recipientId: "codex-agent", maxAttempts: 5 });
  const bindingStore = new RuntimeBindingStore(db);
  const socketPath = path.join(baseDir, "app-server.sock");
  writeFileSync(socketPath, "");
  const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({
    bindingStore, dispatchStore, agentId: "codex-agent", projectId: "project", peer: { socketPath },
    retryDelayMs: 0, readServerIdentity: identity,
    injector: createCodexAppServerInjector({ Client: server.FakeClient }),
    sendReply: async (reply) => { replies.push(reply); return { msgId: reply.msgId }; },
  });
  const ctx = {
    dir: baseDir, db, dispatchStore, bindingStore, adapter, replies, socketPath,
    teardown: async () => { await adapter.shutdown(); bindingStore.close(); dispatchStore.close(); },
  };
  contexts.push(ctx);
  return ctx;
};

const deliver = (ctx, msgId = MSG, extra = {}) => {
  const payload = { msgId, from: "claude-agent", conversationId: `handoff:${msgId}`, text: "review this", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT, ...extra };
  ctx.dispatchStore.enqueue(payload);
  return payload;
};
const claimAndRun = async (ctx) => {
  const dispatch = ctx.dispatchStore.claimDue(Date.now() + 60_000);
  if (!dispatch) return null;
  return ctx.adapter.executeTurn(dispatch.payload, dispatch);
};

test("REGRESSION: same msgId, wait times out, dispatch retried -> ONE thread, ONE turn; the retry ATTACHES to the launched turn", async () => {
  const server = makeServer({ script: ["timeout", "complete"] });
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  const first = await claimAndRun(ctx);
  assert.equal(first.status, "failed", "the first wait timed out");
  const second = await claimAndRun(ctx);
  assert.equal(second.status, "completed");
  assert.equal(server.state.threads, 1, "exactly one App Server thread for this msgId");
  assert.equal(server.calls.filter((c) => c.method === "turn/start").length, 1, "exactly one turn/start");
  const attach = server.calls.find((c) => c.method === "attach");
  assert.deepEqual([attach.attach.threadId, attach.attach.turnId], ["thread-1", "turn-1"]);
  assert.equal(ctx.replies.length, 1, "one final reply");
  assert.equal(new RuntimeTurnStore(ctx.dispatchStore.db).get({ msgId: MSG, recipientId: "codex-agent", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT }).state, "finished");
});

test("several timeouts in a row still never create a second thread (the observed three-thread pattern)", async () => {
  const server = makeServer({ script: ["timeout", "timeout", "timeout", "complete"] });
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  for (let i = 0; i < 4; i += 1) await claimAndRun(ctx);
  assert.equal(server.state.threads, 1);
  assert.equal(server.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(server.calls.filter((c) => c.method === "attach").length, 3);
  assert.equal(ctx.replies.length, 1);
});

test("RESTART in flight: a NEW adapter instance on the same database attaches instead of re-executing", async () => {
  const server = makeServer({ script: ["timeout", "complete"] });
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  await claimAndRun(first);
  // "daemon restart": a fresh adapter/stores on the SAME durable database, same App Server
  const second = makeAdapter({ server, dir: first.dir, dbPath: first.db });
  second.adapter.start({ bindingId: "b2", runtimeGeneration: 2, leaseTtlMs: 5_000 });
  const result = await claimAndRun(second);
  assert.equal(result.status, "completed");
  assert.equal(server.state.threads, 1);
  assert.equal(server.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(server.calls.filter((c) => c.method === "attach").length, 1);
});

test("a retry after a failure BEFORE the turn launched reuses the seeded thread (no thread per attempt)", async () => {
  const server = makeServer();
  let failTurnStart = true;
  const baseStart = server.FakeClient.prototype.startTurnAndWaitForFinal;
  server.FakeClient.prototype.startTurnAndWaitForFinal = async function patched(params, options) {
    if (failTurnStart) { failTurnStart = false; throw new Error("codex-app-server-connect-failed:/fake:ECONNRESET"); }
    return baseStart.call(this, params, options);
  };
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  assert.equal((await claimAndRun(ctx)).status, "failed");
  assert.equal((await claimAndRun(ctx)).status, "completed");
  assert.equal(server.state.threads, 1, "the thread seeded by the failed attempt is reused");
});

test("DUPLICATE DELIVERY of a completed msgId neither runs a turn nor creates a thread", async () => {
  const server = makeServer();
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  assert.equal((await claimAndRun(ctx)).status, "completed");
  for (let i = 0; i < 3; i += 1) deliver(ctx);          // the sender re-published it three more times
  assert.equal(await claimAndRun(ctx), null, "nothing is claimable");
  assert.equal(server.state.threads, 1);
  assert.equal(server.state.turns, 1);
  assert.equal(ctx.replies.length, 1);
});

test("DUPLICATE DELIVERY while the first is still queued/in flight is ONE dispatch row", async () => {
  const server = makeServer();
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  for (let i = 0; i < 4; i += 1) deliver(ctx);
  assert.equal(ctx.dispatchStore.db.prepare("SELECT COUNT(*) AS n FROM wake_dispatch WHERE msg_id = ?").get(MSG).n, 1);
  assert.equal((await claimAndRun(ctx)).status, "completed");
  assert.equal(await claimAndRun(ctx), null);
  assert.equal(server.state.turns, 1);
});

test("the ONE exception: the App Server itself was replaced, so the old turn is gone and a fresh one is started (and logged)", async () => {
  const server = makeServer({ script: ["timeout", "complete"] });
  let identity = "server-1";
  const ctx = makeAdapter({ server, identity: () => identity });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  await claimAndRun(ctx);
  identity = "server-2";
  assert.equal((await claimAndRun(ctx)).status, "completed");
  assert.equal(server.state.threads, 2);
  assert.equal(server.calls.filter((c) => c.method === "attach").length, 0, "never attach to a turn of a dead server");
});

test("an attach to a thread the server no longer has is abandoned, and the next retry starts fresh", async () => {
  const server = makeServer({ script: ["timeout", "thread-missing", "complete"] });
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  await claimAndRun(ctx);
  assert.equal((await claimAndRun(ctx)).status, "failed");
  assert.equal((await claimAndRun(ctx)).status, "completed");
  assert.equal(server.state.threads, 2, "only after the old one was proven gone");
});

// ---------------------------------------------------------------------------
// The receive handler must only durably ACCEPT; the model turn runs from the dispatch queue
// ---------------------------------------------------------------------------

const message = (msgId, cursor) => ({ msgId, from: "peer", conversationId: `c-${msgId}`, text: "x", cursor, ts: new Date(1_000 + cursor).toISOString() });

test("backgroundDrain: onInbound returns while the turn is still running (so the ACK is not held for minutes)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-bg-"));
  const dispatchStore = new WakeDispatchStore(path.join(dir, "murmur.db"), { recipientId: "agent", maxAttempts: 3 });
  contexts.push({ dir, teardown: async () => dispatchStore.close() });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const executed = [];
  const monitor = new WakeMonitor({
    dispatchStore, backgroundDrain: true, now: () => Date.now(),
    runtimeDispatcher: async (payload, dispatch) => { executed.push(payload.msgId); await gate; dispatchStore.markHandedOff?.(dispatch, Date.now()); },
    hook: async () => {},
  });
  const t0 = Date.now();
  await monitor.onInbound({ ...message("long-turn-01", 1), memberSlot: "agent:slot" });
  assert.ok(Date.now() - t0 < 500, "the receive handler did not wait for the turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(executed, ["long-turn-01"], "the turn started in the background");
  // a second message that arrives MID-TURN is accepted at once and processed by the same loop afterwards
  await monitor.onInbound({ ...message("second-msg-02", 2), memberSlot: "agent:slot" });
  assert.deepEqual(executed, ["long-turn-01"]);
  release();
  for (let i = 0; i < 50 && executed.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(executed, ["long-turn-01", "second-msg-02"]);
});

test("without backgroundDrain the legacy contract holds: onInbound resolves after processing", async () => {
  const calls = [];
  const monitor = new WakeMonitor({ hook: async (payload) => { await new Promise((r) => setTimeout(r, 30)); calls.push(payload.msgId); }, now: () => 1000 });
  await monitor.onInbound(message("legacy-001", 1));
  assert.deepEqual(calls, ["legacy-001"]);
});

test("Codex: an empty final result is an explicit failure and is never relayed as an answer", async () => {
  const server = makeServer();
  const baseStart = server.FakeClient.prototype.startTurnAndWaitForFinal;
  server.FakeClient.prototype.startTurnAndWaitForFinal = async function empty(params, options) {
    const result = await baseStart.call(this, params, options);
    return { ...result, finalText: "   " };
  };
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  const result = await claimAndRun(ctx);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /empty-output/);
  assert.deepEqual(ctx.replies, []);
});

test("an output that settlement REJECTS leaves the turn record 'launched': the retry attaches, it does not start another turn", async () => {
  const server = makeServer({ script: ["complete", "complete"] });
  const baseStart = server.FakeClient.prototype.startTurnAndWaitForFinal;
  let calls = 0;
  server.FakeClient.prototype.startTurnAndWaitForFinal = async function emptyThenOk(params, options) {
    const result = await baseStart.call(this, params, options);
    calls += 1;
    return calls === 1 ? { ...result, finalText: "" } : result;   // the first result is empty, the re-read one is real
  };
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  assert.equal((await claimAndRun(ctx)).status, "failed");
  const turns = new RuntimeTurnStore(ctx.dispatchStore.db);
  assert.equal(turns.get({ msgId: MSG, recipientId: "codex-agent", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT }).state, "launched");
  assert.equal((await claimAndRun(ctx)).status, "completed");
  assert.equal(server.state.threads, 1);
  assert.equal(server.calls.filter((c) => c.method === "turn/start").length, 1, "never a second turn for the same msgId");
  assert.equal(server.calls.filter((c) => c.method === "attach").length, 1);
});
