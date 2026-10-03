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
import { CODEX_APP_SERVER_MEMBER_SLOT, CodexAppServerRuntimeAdapter, identityDigest } from "../scripts/agent-runtime-adapter.mjs";
import { createCodexAppServerInjector } from "../scripts/codex-app-server-wake.mjs";
import { RuntimeBindingStore } from "../scripts/runtime-binding-store.mjs";
import { RuntimeTurnStore } from "../scripts/runtime-turn-store.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import { WakeMonitor } from "../scripts/wake-monitor.mjs";

const MSG = "handoff-msg-0001";
const SLOT = CODEX_APP_SERVER_MEMBER_SLOT;
const srcFor = (msg = MSG, recipient = "codex-agent") => `murmur:v1:${identityDigest({ msgId: msg, recipientId: recipient, memberSlot: SLOT })}`;
const cidFor = (msg = MSG, recipient = "codex-agent") => `murmur-turn:v1:${identityDigest({ msgId: msg, recipientId: recipient, memberSlot: SLOT })}`;
const contexts = [];
test.afterEach(async () => {
  while (contexts.length) { const c = contexts.pop(); await c.teardown(); rmSync(c.dir, { recursive: true, force: true }); }
});

/**
 * A recording App Server that behaves like the real one where it matters for recovery: a thread
 * with NO turn is only in memory (listed by `thread/loaded/list`, readable, adoptable — but gone
 * after a server restart); a thread with a turn persists; the turn's user message carries the
 * `clientUserMessageId` we supplied; `threadSource` is returned on `thread/read`.
 */
const makeServer = ({ script = [] } = {}) => {
  const calls = [];
  const state = { threads: 0, turns: 0 };
  const threads = new Map();           // id -> { threadSource, turns: [{ id, clientId }] }
  const queue = [...script];
  const missing = (id) => new Error(`codex-app-server-error:no rollout found for thread id ${id}`);
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") {
        state.threads += 1;
        const id = `thread-${state.threads}`;
        threads.set(id, { threadSource: params.threadSource ?? null, turns: [] });
        return { thread: { id } };
      }
      if (method === "thread/loaded/list") {
        const all = [...threads.keys()];
        const start = Number(params?.cursor ?? 0);
        const limit = params?.limit ?? all.length;
        const next = start + limit;
        return { data: all.slice(start, next), nextCursor: next < all.length ? String(next) : null };
      }
      if (method === "thread/read") {
        if (state.failReads > 0) { state.failReads -= 1; throw new Error("codex-app-server-connect-failed:/fake:ECONNRESET"); }
        const t = threads.get(params.threadId);
        if (!t) throw missing(params.threadId);
        const busy = state.busyReads > 0 && t.turns.length > 0;
        if (busy) state.busyReads -= 1;
        return { thread: { id: params.threadId, threadSource: t.threadSource, status: { type: busy || state.alwaysBusy ? "active" : "idle" } } };
      }
      if (method === "thread/turns/list") {
        const t = threads.get(params.threadId);
        if (!t) throw missing(params.threadId);
        // a turn that was just accepted is not visible yet (the real server's transient state)
        if (t.turns.length > 0 && (state.hideTurnCalls > 0 || state.alwaysBusy)) {
          if (state.hideTurnCalls > 0) state.hideTurnCalls -= 1;
          throw new Error(`codex-app-server-error:thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
        }
        // mirrors the real App Server: unavailable before the first user message
        if (t.turns.length === 0) throw new Error(`codex-app-server-error:thread ${params.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
        const all = [...t.turns].reverse().map((turn) => ({ id: turn.id, items: [{ type: "userMessage", clientId: turn.clientId }] }));
        const start = Number(params?.cursor ?? 0);
        const limit = params?.limit ?? all.length;
        return { data: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null };
      }
      return {};
    }
    async startTurnAndWaitForFinal(params, options) {
      const attach = Boolean(options.attach);
      calls.push({ method: attach ? "attach" : "turn/start", params, attach: options.attach, clientUserMessageId: params.clientUserMessageId });
      const thread = threads.get(attach ? options.attach.threadId : params.threadId);
      if (!thread) throw new Error("codex-app-server-error:thread not found: " + params.threadId);
      let turnId;
      if (attach) turnId = options.attach.turnId;
      else {
        if (state.crashBeforeTurn) { state.crashBeforeTurn = false; throw new Error("PROCESS-DIED-after-thread-accepted"); }
        state.turns += 1; turnId = `turn-${state.turns}`;
        thread.turns.push({ id: turnId, clientId: params.clientUserMessageId ?? null });   // the server accepted it
        if (state.crashAfterTurn) { state.crashAfterTurn = false; throw new Error("PROCESS-DIED-after-turn-accepted"); }
      }
      options.onTurnId?.({ turnId, threadId: params.threadId, abort: () => {} });
      const outcome = queue.shift() ?? "complete";
      if (outcome === "timeout") throw new Error(`codex-app-server-turn-completion-timeout:/fake:${turnId}`);
      if (outcome === "thread-missing") throw new Error("codex-app-server-error:thread not found: " + params.threadId);
      return { finalText: "the substantive result", turnId, source: "app-server-events" };
    }
  }
  return {
    FakeClient, calls, state, threads,
    /** The App Server process restarted: in-memory (turnless) threads vanish, persisted ones survive. */
    restart() { for (const [id, t] of threads) if (t.turns.length === 0) threads.delete(id); },
    /** The App Server was replaced by a fresh one with no history at all. */
    wipe() { threads.clear(); },
  };
};

const makeAdapter = ({ server, dir, dbPath, identity = () => "server-1", recipientId = "codex-agent", quiescenceMs = 0 } = {}) => {
  const baseDir = dir ?? mkdtempSync(path.join(os.tmpdir(), "murmur-once-"));
  const db = dbPath ?? path.join(baseDir, "murmur.db");
  const dispatchStore = new WakeDispatchStore(db, { recipientId, maxAttempts: 5 });
  const bindingStore = new RuntimeBindingStore(db);
  const socketPath = path.join(baseDir, "app-server.sock");
  writeFileSync(socketPath, "");
  const replies = [];
  const adapter = new CodexAppServerRuntimeAdapter({
    bindingStore, dispatchStore, agentId: recipientId, projectId: "project", peer: { socketPath, reconcilePollMs: 2, reconcileQuiescenceMs: quiescenceMs },
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

test("the App Server was REPLACED with a fresh one (no history): the recorded turn is provably gone, the retry abandons it and starts fresh", async () => {
  const server = makeServer({ script: ["timeout", "complete"] });
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  await claimAndRun(ctx);
  server.wipe();
  assert.equal((await claimAndRun(ctx)).status, "failed", "reconciliation proves the old thread is gone");
  assert.equal((await claimAndRun(ctx)).status, "completed");
  assert.equal(server.state.threads, 2);
  assert.equal([...server.threads.values()].reduce((n, t) => n + t.turns.length, 0), 1, "the first turn died with the old server: exactly one turn exists on the CURRENT server");
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
// CRASH CONSISTENCY — the process dies between "the server accepted it" and "we recorded it"
// ---------------------------------------------------------------------------

/** Lose the durable write that would have followed the server call: the process died first. */
const loseWrite = (ctx, method) => { ctx.adapter.turnStore[method] = () => {}; };
/** "Restart the daemon": a brand-new adapter (and stores) on the SAME durable database. */
const restartDaemon = (first, server, generation = 2) => {
  const next = makeAdapter({ server, dir: first.dir, dbPath: first.db });
  next.adapter.start({ bindingId: `b${generation}`, runtimeGeneration: generation, leaseTtlMs: 5_000 });
  return next;
};
const turnStarts = (server) => server.calls.filter((c) => c.method === "turn/start");

test("CRASH after the THREAD was accepted but before it was persisted: the restart ADOPTS that thread — no second thread, one turn, one result", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordSeeded");           // the process died before this write
  server.state.crashBeforeTurn = true;         // ...and never got as far as the turn
  assert.equal((await claimAndRun(first)).status, "failed");
  assert.equal(server.state.threads, 1, "the server created exactly one thread");
  const turns = new RuntimeTurnStore(first.dispatchStore.db);
  const id = { msgId: MSG, recipientId: "codex-agent", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
  assert.equal(turns.get(id).threadId, null, "the thread id was never durably recorded (only the planned intent)");
  assert.equal(turns.get(id).state, "planned");
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.threads, 1, "NO second thread: the first was found by the threadSource we supplied");
  assert.equal(server.state.turns, 1, "one turn accepted by the server");
  assert.equal(second.replies.length, 1, "one final result");
  assert.equal(turnStarts(server).at(-1).params.threadId, "thread-1", "the turn ran on the ADOPTED thread");
  assert.equal(server.calls.find((c) => c.method === "thread/start").params.threadSource, srcFor(), "identity supplied BEFORE execution, namespaced by recipient+slot");
});

test("CRASH after the TURN was accepted but before it was persisted: the restart ATTACHES to it — no second thread, no second turn, one result", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordLaunched");          // died before recording the turn id
  server.state.crashAfterTurn = true;          // the server accepted the turn
  assert.equal((await claimAndRun(first)).status, "failed");
  assert.equal(server.state.turns, 1);
  const turns = new RuntimeTurnStore(first.dispatchStore.db);
  const id = { msgId: MSG, recipientId: "codex-agent", memberSlot: CODEX_APP_SERVER_MEMBER_SLOT };
  assert.equal(turns.get(id).turnId, null, "the turn id was never durably recorded");
  assert.equal(turns.get(id).state, "seeded");
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.threads, 1, "no second thread");
  assert.equal(server.state.turns, 1, "no second turn: the accepted turn was found by its clientUserMessageId");
  const attach = server.calls.find((c) => c.method === "attach");
  assert.deepEqual([attach.attach.threadId, attach.attach.turnId], ["thread-1", "turn-1"]);
  assert.equal(turnStarts(server)[0].clientUserMessageId, cidFor(), "identity supplied BEFORE execution, namespaced by recipient+slot");
  assert.equal(second.replies.length, 1);
});

test("CRASH at BOTH boundaries in a row (thread lost, then turn lost): still exactly one thread, one turn, one result", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordSeeded"); loseWrite(first, "recordLaunched");
  server.state.crashAfterTurn = true;
  assert.equal((await claimAndRun(first)).status, "failed");
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.threads, 1);
  assert.equal(server.state.turns, 1);
  assert.equal(second.replies.length, 1);
});

test("CRASH after the thread was accepted AND the App Server restarted too: the turnless thread is gone (nothing ever ran in it), so a fresh one is correct", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordSeeded");
  server.state.crashBeforeTurn = true;
  await claimAndRun(first);
  server.restart();                            // in-memory turnless thread vanishes
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.turns, 1, "still exactly one turn for the msgId");
  assert.equal(second.replies.length, 1);
});

test("CRASH after the turn was accepted AND the App Server restarted: the persisted thread still yields the turn by its client id", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordLaunched");
  server.state.crashAfterTurn = true;
  await claimAndRun(first);
  server.restart();                            // the threaded turn persisted; only memory is lost
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.threads, 1);
  assert.equal(server.state.turns, 1);
  assert.equal(second.replies.length, 1);
});

test("a first attempt does no discovery at all (extra server calls only on a retry); the intent is recorded BEFORE the server is called", async () => {
  const server = makeServer();
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  const order = [];
  const store = ctx.adapter.turnStore;
  const planned = store.recordPlanned.bind(store);
  store.recordPlanned = (...args) => { order.push("planned"); return planned(...args); };
  const baseRequest = server.FakeClient.prototype.request;
  server.FakeClient.prototype.request = async function spy(method, params) { order.push(method); return baseRequest.call(this, method, params); };
  deliver(ctx);
  await claimAndRun(ctx);
  assert.equal(order[0], "planned", "intent first");
  assert.ok(!order.includes("thread/loaded/list") && !order.includes("thread/turns/list"), "no reconciliation on the happy path");
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

// ---------------------------------------------------------------------------
// Review-driven hardening of the reconcile step
// ---------------------------------------------------------------------------

test("RACE: a just-accepted turn is transiently invisible (not materialized, thread busy): the retry WAITS for it and attaches — no second turn", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordLaunched");
  server.state.crashAfterTurn = true;
  await claimAndRun(first);
  server.state.hideTurnCalls = 3;      // the turn is not listable for the first three looks...
  server.state.busyReads = 3;          // ...while the thread reports an active turn
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.turns, 1, "never a second turn while the first one is still materialising");
  assert.equal(server.state.threads, 1);
  assert.equal(second.replies.length, 1);
});

test("a turn that keeps the thread busy but never becomes listable is UNKNOWN state: the attempt fails rather than start another turn", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordLaunched");
  server.state.crashAfterTurn = true;
  await claimAndRun(first);
  server.state.alwaysBusy = true;
  const second = restartDaemon(first, server);
  const result = await claimAndRun(second);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /reconcile-state-unknown/);
  assert.equal(server.state.turns, 1, "no second turn was started on an ambiguous server state");
});

test("DISCOVERY is complete: the lost thread is found among hundreds of loaded threads (every page, no order assumed)", async () => {
  const server = makeServer();
  for (let i = 0; i < 250; i += 1) server.threads.set(`filler-${i}`, { threadSource: `murmur:other-${i}:x:y`, turns: [{ id: `t${i}`, clientId: null }] });
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordSeeded");
  server.state.crashBeforeTurn = true;
  await claimAndRun(first);
  // our thread was created LAST, so it sits on the final page of a paginated list
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.threads, 1, "found on a late page: no second thread was seeded");
  assert.ok(server.calls.filter((c) => c.method === "thread/loaded/list").length >= 3, "every page was read");
});

test("NAMESPACE: the same msgId for ANOTHER recipient on one App Server never adopts this one's thread or turn", async () => {
  const server = makeServer();
  const a = makeAdapter({ server, recipientId: "codex-agent" });
  a.adapter.start({ bindingId: "ba", leaseTtlMs: 5_000 });
  deliver(a);
  loseWrite(a, "recordSeeded");
  server.state.crashBeforeTurn = true;
  await claimAndRun(a);                       // codex-agent's thread exists, unrecorded
  const b = makeAdapter({ server, recipientId: "codex-agent-2" });
  b.adapter.start({ bindingId: "bb", leaseTtlMs: 5_000 });
  deliver(b);
  b.adapter.turnStore.get({ msgId: MSG, recipientId: "codex-agent-2", memberSlot: SLOT });
  assert.equal((await claimAndRun(b)).status, "completed");
  assert.equal(server.state.threads, 2, "the other recipient got its OWN thread");
  const threadsBySource = [...server.threads.values()].map((t) => t.threadSource).sort();
  assert.deepEqual(threadsBySource, [srcFor(MSG, "codex-agent"), srcFor(MSG, "codex-agent-2")].sort());
});

test("a result DROPPED by a lost fence does not retire the record: the newer generation still reconciles instead of starting a second turn", async () => {
  const server = makeServer();
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  // the binding is replaced while the turn runs -> settlement returns late-result-dropped
  const inner = ctx.adapter.injector;
  ctx.adapter.injector = async (payload, peer, processing) => {
    const result = await inner(payload, peer, processing);
    ctx.bindingStore.replace("b1", { bindingId: "b-replacement", state: "BOUND_IDLE" });
    return result;
  };
  deliver(ctx);
  const result = await claimAndRun(ctx);
  assert.equal(result.status, "late-result-dropped");
  const turns = new RuntimeTurnStore(ctx.dispatchStore.db);
  assert.equal(turns.get({ msgId: MSG, recipientId: "codex-agent", memberSlot: SLOT }).state, "launched", "NOT finished");
});

test("a TRANSIENT thread/read failure during discovery is an incomplete search: the attempt fails, no second thread is seeded", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordSeeded");
  server.state.crashBeforeTurn = true;
  await claimAndRun(first);
  server.state.failReads = 1;                      // the read of the lost thread fails transiently
  const second = restartDaemon(first, server);
  const failed = await claimAndRun(second);
  assert.equal(failed.status, "failed");
  assert.match(failed.error.message, /reconcile-state-unknown:thread-read-failed/);
  assert.equal(server.state.threads, 1, "nothing was seeded on an incomplete search");
  assert.equal((await claimAndRun(second)).status, "completed", "the next attempt finds and adopts it");
  assert.equal(server.state.threads, 1);
  assert.equal(server.state.turns, 1);
});

test("QUIESCENCE: a request still in flight when the process died and processed LATE is attached, not duplicated (no 'no turn' conclusion inside the quiescence window)", async () => {
  const server = makeServer();
  const first = makeAdapter({ server, quiescenceMs: 400 });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordLaunched");
  server.state.crashAfterTurn = true;               // the server has (or will have) the turn
  await claimAndRun(first);
  server.state.hideTurnCalls = 8;                   // ...but it shows up late: invisible + idle for a while
  const second = restartDaemon(first, server);
  second.adapter.peer.reconcileQuiescenceMs = 400;
  const result = await claimAndRun(second);
  assert.equal(result.status, "completed");
  assert.equal(server.state.turns, 1, "a late-materialising turn was waited for, never duplicated");
  assert.equal(server.calls.filter((c) => c.method === "attach").length, 1);
});

test("TURN SEARCH is complete: our turn is found on the last page of a long thread history", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  loseWrite(first, "recordLaunched");
  server.state.crashAfterTurn = true;
  await claimAndRun(first);
  const thread = server.threads.get("thread-1");
  const ours = thread.turns[0];
  thread.turns = [ours, ...Array.from({ length: 130 }, (_, i) => ({ id: `later-${i}`, clientId: `other-${i}` }))];   // ours is now the OLDEST of 131
  const second = restartDaemon(first, server);
  assert.equal((await claimAndRun(second)).status, "completed");
  assert.equal(server.state.turns, 1, "found past the first page of 50: no duplicate turn");
});

test("identity digest is collision-free by construction: concatenation-ambiguous identities differ", () => {
  const a = identityDigest({ msgId: "a:b", recipientId: "c", memberSlot: "s" });
  const b = identityDigest({ msgId: "a", recipientId: "b:c", memberSlot: "s" });
  const c = identityDigest({ msgId: "a", recipientId: "b", memberSlot: "c:s" });
  assert.equal(new Set([a, b, c]).size, 3);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("QUIESCENCE ANCHOR: the launch stamp is written BEFORE each thread/start and turn/start (so a request in flight is always measured from when it was SENT)", async () => {
  const server = makeServer();
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  const store = ctx.adapter.turnStore;
  const id = { msgId: MSG, recipientId: "codex-agent", memberSlot: SLOT };
  const stamps = [];
  const baseRequest = server.FakeClient.prototype.request;
  server.FakeClient.prototype.request = async function spy(method, params) {
    if (method === "thread/start") stamps.push(["thread/start", store.get(id).updatedAt]);
    return baseRequest.call(this, method, params);
  };
  const baseStart = server.FakeClient.prototype.startTurnAndWaitForFinal;
  server.FakeClient.prototype.startTurnAndWaitForFinal = async function spyTurn(params, options) {
    if (!options.attach) stamps.push(["turn/start", store.get(id).updatedAt]);
    return baseStart.call(this, params, options);
  };
  // an ANCIENT planned row from an earlier attempt: only the pre-send stamp can refresh it
  store.recordPlanned(id, { runtimeKind: "codex_app_server" }, 1);
  assert.equal(store.get(id).updatedAt, 1);
  const before = Date.now();
  await claimAndRun(ctx);
  assert.deepEqual(stamps.map(([name]) => name), ["thread/start", "turn/start"]);
  for (const [name, stampedAt] of stamps) assert.ok(stampedAt >= before, `${name}: the stamp was refreshed before the server call`);
});

test("the launch stamp MUST succeed: if it cannot be written the request is NOT sent at all (the attempt fails and the retry reconciles)", async () => {
  const server = makeServer();
  const ctx = makeAdapter({ server });
  ctx.adapter.start({ bindingId: "b", leaseTtlMs: 5_000 });
  deliver(ctx);
  ctx.adapter.turnStore.touch = () => { throw new Error("database is locked"); };
  const result = await claimAndRun(ctx);
  assert.equal(result.status, "failed");
  assert.equal(server.calls.filter((c) => c.method === "thread/start").length, 0, "nothing reached the server");
  assert.equal(server.state.threads, 0);
  ctx.adapter.turnStore.touch = () => 0;      // "no such record" is also a failure, not a silent skip
  const second = await claimAndRun(ctx);
  assert.equal(second.status, "failed");
  assert.match(second.error.message, /launch-stamp-failed/);
  assert.equal(server.state.threads, 0);
});

test("the quiescence window starts only AFTER the client's send bound: an absent turn is not concluded 'absent' sooner (the request may still be in flight)", async () => {
  const server = makeServer();
  const first = makeAdapter({ server });
  first.adapter.start({ bindingId: "b1", leaseTtlMs: 5_000 });
  deliver(first);
  server.state.crashBeforeTurn = true;             // the turn/start never reached the server
  await claimAndRun(first);
  server.FakeClient.prototype.timeoutMs = 300;     // the client's send bound is 300 ms
  const second = restartDaemon(first, server);
  const started = Date.now();
  const result = await claimAndRun(second);
  assert.equal(result.status, "completed");
  assert.ok(Date.now() - started >= 280, "a new turn was not started before the send bound elapsed");
  assert.equal(server.state.turns, 1);
  assert.equal(server.state.threads, 1);
  delete server.FakeClient.prototype.timeoutMs;
});
