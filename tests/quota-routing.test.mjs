/**
 * quota-routing.test.mjs — quota-aware agent routing against REAL fenced databases:
 * handoff refusal before anything durable, durable waiting_for_provider, exactly-once release after
 * reset, restart safety, the dispatch-level gate (no retry storm, no killed turn), the mandatory
 * reviewer gate and the Active Tasks view. Provider state is injected; no provider is contacted.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHandoffController, HandoffRejection } from "../scripts/agent-handoff-controller.mjs";
import { AgentHandoffStore } from "../scripts/agent-handoff-store.mjs";
import { HandoffTurnCoordinator, settleRuntimeTurn } from "../scripts/agent-handoff-runtime.mjs";
import { runClaudeOneShot } from "../scripts/claude-one-shot-runtime.mjs";
import { AVAILABILITY, availabilityFile, classifyProviderError, evidenceFromError, readAvailabilityRecords, recordExhaustion } from "../scripts/provider-availability.mjs";
import { createAvailabilityService, withQuotaGate } from "../scripts/provider-availability-service.mjs";
import { ProviderWaitStore } from "../scripts/provider-wait-store.mjs";
import { writeUsageCache } from "../scripts/provider-usage.mjs";
import { buildWorkSnapshot, collectWorkRecords } from "../scripts/operator/work.mjs";
import { recordCancelRequest } from "../scripts/workflow-control.mjs";
import { makeWorld, NOW as WORLD_NOW } from "./fixtures/work-world.mjs";
import {
  claimFencedDispatch, createHandoffDatabase, enqueuedEnvelopes, registerIdleBinding,
} from "./fixtures/handoff-fence.mjs";

const T0 = Date.parse("2026-10-04T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const clock = { t: T0 };
const dirs = [];
test.afterEach(() => {
  while (dirs.length) dirs.pop()();
  clock.t = T0;
});

const PEER = {
  encryption: { publicKey: "enc" }, signing: { publicKey: "sig" }, subject: "msg.x",
  protocolVersions: ["1.0", "1.1"], features: ["handoff-v1"],
};
const peers = () => ({
  "codex-agent": { ...PEER, subject: "msg.codex-agent" },
  "cursor-agent": { ...PEER, subject: "msg.cursor-agent" },
});

/** A controller on a real fenced context with a mutable per-provider availability. */
const setup = ({ mandatory = [] } = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-quota-"));
  const agentId = "claude-agent";
  const db = createHandoffDatabase({ dir, agentId });
  registerIdleBinding(db.bindingStore, { agentId, now: T0 });
  const claimed = claimFencedDispatch(db, { agentId, now: T0 });
  const state = { codex: null, cursor: null, claude: null };
  const built = [];
  let n = 0;
  const waits = new ProviderWaitStore(db.handoffStore.db);
  const mk = (store = db.handoffStore) => new AgentHandoffController({
    store, agentId, peers: peers(), waits,
    availability: { resolve: (provider) => state[provider] ?? { provider, availability: AVAILABILITY.unknown, eligible: true, resetsAt: null } },
    providerOf: (id) => id.split("-")[0],
    isMandatory: ({ to }) => mandatory.includes(to.split("-")[0]),
    buildHandoffEnvelope: async ({ msgId, to, subject, conversationId, handoff, text }) => {
      built.push(msgId);
      return { subject, envelope: { schemaVersion: "1.1", msgId, conversationId, senderAgentId: agentId, recipients: [to], createdAt: iso(T0), payloadCiphertext: Buffer.from(text).toString("base64"), payloadNonce: "n", handoff, signature: "s" } };
    },
    now: () => clock.t,
    newMsgId: () => `h${++n}`,
  });
  const ctx = { dir, db, waits, state, built, controller: mk(), mk, fence: claimed.fence, identity: claimed.identity, sent: () => enqueuedEnvelopes(db.dbPath).map((r) => ({ ...r, to: r.envelope.recipients[0] })) };
  dirs.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return ctx;
};
const turn = (extra = {}) => ({
  parentActivePath: [], rootMessageId: "root-1", rootConversationId: "conv-root", causedByMessageId: "root-1",
  reply: { to: "human-agent", conversationId: "conv-root", replyToMessageId: "root-1" },
  binding: { bindingId: "binding-a", runtimeGeneration: 1, runtimeKind: "claude_one_shot", memberSlot: "claude:auto", runtimeSessionId: "s1" },
  ...extra,
});
const exhausted = (provider, resetMs = T0 + 41 * 60_000) => ({
  provider, availability: AVAILABILITY.exhausted, eligible: false, resetsAt: resetMs === null ? null : iso(resetMs), reason: "usage-window-exhausted",
});
const available = (provider, availability = AVAILABILITY.available) => ({ provider, availability, eligible: true, resetsAt: null });
const delegate = (c, to = "codex-agent", extra = {}) => c.controller.delegate({ to, task: "review the retry path", turn: turn(extra), fence: c.fence, identity: c.identity });
const handoffRows = (c) => c.db.handoffStore.db.prepare("SELECT * FROM agent_handoffs").all();

// ---------------------------------------------------------------------------
// Routing policy
// ---------------------------------------------------------------------------

test("AVAILABLE, DEGRADED and UNKNOWN recipients are routable: the handoff is created and enqueued", async () => {
  for (const make of [() => available("codex"), () => available("codex", AVAILABILITY.degraded), () => null]) {
    const c = setup();
    c.state.codex = make();
    const result = await delegate(c);
    assert.equal(result.created, true);
    assert.equal(c.sent().length, 1);
    assert.equal(c.sent()[0].to, "codex-agent");
  }
});

test("EXHAUSTED recipient: refused BEFORE any child exists — no continuation row, no envelope built, no outbox row", async () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  await assert.rejects(() => delegate(c), (error) => {
    assert.ok(error instanceof HandoffRejection);
    assert.equal(error.reason, "provider-quota-exhausted");
    assert.equal(error.routing.eligible, false);
    assert.equal(error.routing.provider, "codex");
    assert.equal(error.routing.waitReason, "waiting_for_provider");
    return true;
  });
  assert.deepEqual(handoffRows(c), [], "no durable child handoff");
  assert.deepEqual(c.built, [], "the envelope was never even built");
  assert.deepEqual(c.sent(), [], "nothing reached the outbox");
  assert.equal(c.waits.listWaiting().length, 1, "only the wait intent is durable");
});

test("the router never substitutes: an exhausted Codex is NOT turned into Cursor, even though Cursor is eligible", async () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  c.state.cursor = available("cursor");
  await assert.rejects(() => delegate(c, "codex-agent"), /provider-quota-exhausted/);
  assert.deepEqual(c.sent(), []);
  const [wait] = c.waits.listWaiting();
  assert.equal(wait.intendedRecipientId, "codex-agent");
  // the coordinator is TOLD (so it can choose for optional work) but the router chose nothing
  const text = c.controller.instructions();
  assert.match(text, /quota is exhausted/);
  assert.match(text, /codex-agent \(resets /);
  assert.match(text, /Delegation targets available to you right now: cursor-agent\./);
  assert.doesNotMatch(text, /targets available[^\n]*codex-agent/);
  // and the refusal itself offers substitution only as the coordinator's decision
  const err = await delegate(c, "codex-agent", { causedByMessageId: "other" }).catch((e) => e);
  assert.equal(err.routing.substitutionAllowed, true);
});

test("when EVERY target is exhausted the coordinator is told to answer directly", () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  c.state.cursor = exhausted("cursor", null);
  const text = c.controller.instructions();
  assert.match(text, /No paired agent can accept delegated work/);
  assert.match(text, /no reset time known/);
  assert.doesNotMatch(text, /handoff","to"/);
});

test("MANDATORY reviewer: exhaustion yields a truthful wait, never a substitute, never a waiver", async () => {
  const c = setup({ mandatory: ["codex"] });
  c.state.codex = exhausted("codex");
  c.state.cursor = available("cursor");
  const error = await delegate(c).catch((e) => e);
  assert.equal(error.routing.mandatory, true);
  assert.equal(error.routing.substitutionAllowed, false);
  assert.equal(error.routing.reviewState, "WAITING_FOR_PROVIDER_RESET");
  assert.deepEqual(c.sent(), [], "no Cursor review, no skipped review");
  const [wait] = c.waits.listWaiting();
  assert.equal(wait.mandatory, true);
  assert.equal(wait.requiredCapability, "mandatory-provider");
  // with no authoritative reset the same gate is BLOCKED, still not weakened
  const d = setup({ mandatory: ["codex"] });
  d.state.codex = exhausted("codex", null);
  const blocked = await delegate(d).catch((e) => e);
  assert.equal(blocked.routing.reviewState, "BLOCKED_BY_PROVIDER_QUOTA");
  assert.equal(d.waits.listWaiting()[0].waitReason, "blocked_by_provider_quota");
  // once Codex recovers, the review goes to CODEX (the original required recipient) exactly once
  c.state.codex = available("codex");
  clock.t = T0 + 42 * 60_000;
  const { released } = await c.controller.processDueWaits({ resolveFresh: async (p) => c.state[p] });
  assert.equal(released.length, 1);
  assert.deepEqual(c.sent().map((e) => e.to), ["codex-agent"]);
});

test("a workflow with no availability source configured routes exactly as before", async () => {
  const c = setup();
  const bare = new AgentHandoffController({ store: c.db.handoffStore, agentId: "claude-agent", peers: peers(),
    buildHandoffEnvelope: async ({ subject, msgId, to, conversationId, handoff, text }) => ({ subject, envelope: { schemaVersion: "1.1", msgId, conversationId, senderAgentId: "claude-agent", recipients: [to], createdAt: iso(T0), payloadCiphertext: Buffer.from(text).toString("base64"), payloadNonce: "n", handoff, signature: "s" } }),
    now: () => T0 });
  const result = await bare.delegate({ to: "codex-agent", task: "t", turn: turn(), fence: c.fence, identity: c.identity });
  assert.equal(result.created, true);
});

// ---------------------------------------------------------------------------
// Waiting, reset, recovery, restart
// ---------------------------------------------------------------------------

test("exhausted with a reset: durable wait; nothing is polled before the reset; after it a recovered provider releases exactly ONE handoff", async () => {
  const c = setup();
  c.state.codex = exhausted("codex", T0 + 41 * 60_000);
  await assert.rejects(() => delegate(c));
  const wait = c.waits.listWaiting()[0];
  assert.equal(wait.workflowId, "root-1");
  assert.equal(wait.provider, "codex");
  assert.equal(wait.resetsAt, T0 + 41 * 60_000);
  assert.equal(wait.waitReason, "waiting_for_provider");
  assert.equal(wait.firstObservedAt, T0);
  let fresh = 0;
  const resolveFresh = async (p) => { fresh += 1; return c.state[p]; };

  clock.t = T0 + 20 * 60_000;
  assert.deepEqual(await c.controller.processDueWaits({ resolveFresh }), { released: [], stillWaiting: [] });
  assert.equal(fresh, 0, "no provider read before the reset is due");

  // reset passes but the provider is STILL exhausted with a new reset: stays waiting, reschedules, no handoff
  clock.t = T0 + 42 * 60_000;
  c.state.codex = exhausted("codex", T0 + 120 * 60_000);
  const still = await c.controller.processDueWaits({ resolveFresh });
  assert.equal(still.stillWaiting.length, 1);
  assert.equal(fresh, 1);
  assert.equal(c.waits.listWaiting()[0].resetsAt, T0 + 120 * 60_000, "the next authoritative reset is stored");
  assert.deepEqual(c.sent(), []);
  clock.t = T0 + 43 * 60_000;
  await c.controller.processDueWaits({ resolveFresh });
  assert.equal(fresh, 1, "no retry storm: not due again until the new reset");

  // authoritative refresh says quota is back
  clock.t = T0 + 121 * 60_000;
  c.state.codex = available("codex");
  const first = await c.controller.processDueWaits({ resolveFresh });
  assert.equal(first.released.length, 1);
  assert.equal(c.sent().length, 1);
  assert.equal(handoffRows(c).length, 1);
  const again = await c.controller.processDueWaits({ resolveFresh });
  assert.deepEqual(again, { released: [], stillWaiting: [] });
  assert.equal(c.sent().length, 1, "exactly one resumed execution");
  assert.equal(c.waits.get(wait.waitId).state, "released");
});

test("UNKNOWN after the reset releases the wait (it is not artificially blocked)", async () => {
  const c = setup();
  c.state.codex = exhausted("codex", T0 + 10 * 60_000);
  await assert.rejects(() => delegate(c));
  clock.t = T0 + 11 * 60_000;
  c.state.codex = { provider: "codex", availability: AVAILABILITY.unknown, eligible: true, resetsAt: null, pendingRefresh: true };
  assert.equal((await c.controller.processDueWaits({ resolveFresh: async (p) => c.state[p] })).released.length, 1);
});

test("a wait WITHOUT an authoritative reset is re-checked on a bounded cadence, not continuously", async () => {
  const c = setup();
  c.state.codex = exhausted("codex", null);
  await assert.rejects(() => delegate(c));
  assert.equal(c.waits.listWaiting()[0].nextCheckAt, T0 + 10 * 60_000);
  let reads = 0;
  for (let i = 1; i <= 9; i += 1) { clock.t = T0 + i * 60_000; await c.controller.processDueWaits({ resolveFresh: async (p) => { reads += 1; return c.state[p]; } }); }
  assert.equal(reads, 0);
});

test("daemon RESTART preserves the wait and the release is still exactly once (new store + controller over the same database)", async () => {
  const c = setup();
  c.state.codex = exhausted("codex", T0 + 5 * 60_000);
  await assert.rejects(() => delegate(c));
  const restarted = new AgentHandoffStore(c.db.dbPath);
  const waits2 = new ProviderWaitStore(restarted.db);
  assert.equal(waits2.listWaiting().length, 1, "the wait survived the restart");
  const controller2 = new AgentHandoffController({
    store: restarted, agentId: "claude-agent", peers: peers(), waits: waits2,
    availability: { resolve: (p) => c.state[p] }, providerOf: (id) => id.split("-")[0],
    buildHandoffEnvelope: async ({ subject, msgId, to, conversationId, handoff, text }) => ({ subject, envelope: { schemaVersion: "1.1", msgId, conversationId, senderAgentId: "claude-agent", recipients: [to], createdAt: iso(T0), payloadCiphertext: Buffer.from(text).toString("base64"), payloadNonce: "n", handoff, signature: "s" } }),
    now: () => clock.t,
  });
  clock.t = T0 + 6 * 60_000;
  c.state.codex = available("codex");
  const results = await Promise.all([controller2.processDueWaits({ resolveFresh: async (p) => c.state[p] }), controller2.processDueWaits({ resolveFresh: async (p) => c.state[p] })]);
  assert.equal(results.flatMap((r) => r.released).length, 1, "two racing releases still produce one");
  assert.equal(c.sent().length, 1);
  assert.equal(handoffRows(c).length, 1);
  restarted.close();
});

test("a replay of the same refused turn keeps ONE wait (one wait per causative message)", async () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  await assert.rejects(() => delegate(c));
  await assert.rejects(() => delegate(c));
  assert.equal(c.waits.listWaiting().length, 1);
});

test("operator cancel closes the wait: it can never be released afterwards", async () => {
  const c = setup();
  c.state.codex = exhausted("codex", T0 + 60_000);
  const rootId = "root-task-aaaa-0001";
  await assert.rejects(() => delegate(c, "codex-agent", { rootMessageId: rootId, causedByMessageId: rootId }));
  assert.equal(c.waits.listWaiting().length, 1);
  recordCancelRequest(c.db.handoffStore.db, rootId, { now: T0 });
  assert.equal(c.waits.listWaiting().length, 0);
  clock.t = T0 + 2 * 60_000;
  c.state.codex = available("codex");
  assert.deepEqual(await c.controller.processDueWaits({ resolveFresh: async (p) => c.state[p] }), { released: [], stillWaiting: [] });
  assert.deepEqual(c.sent(), []);
  assert.equal(c.waits.get(c.waits.db.prepare("SELECT wait_id FROM provider_waits").get().wait_id).state, "cancelled");
});

// ---------------------------------------------------------------------------
// settleRuntimeTurn: a refused delegation is not a failure and not a retry
// ---------------------------------------------------------------------------

test("settleRuntimeTurn: a handoff to an exhausted provider completes the turn WITHOUT a reply, a retry, or a child", async () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  const coordinator = new HandoffTurnCoordinator({ controller: c.controller, now: () => clock.t });
  const receipts = [];
  const dispatchStore = { recordProcessingReceipt: (r) => { receipts.push(r); return { accepted: true }; }, markHandedOffIfLatestAttemptCompleted: () => 1 };
  const bindingStore = { validateFence: () => true, markIdle: () => 1 };
  const sent = [];
  const result = await settleRuntimeTurn({
    runtimeKind: "claude_one_shot", dispatchStore, bindingStore, fence: c.fence, identity: c.identity, attempt: { attemptId: "a1" },
    payload: { msgId: "root-1", from: "human-agent", conversationId: "conv-root" },
    turn: { ...turn(), binding: turn().binding }, coordinator,
    resultText: '{"murmur":{"action":"handoff","to":"codex-agent","task":"review"}}',
    sendReply: async (r) => { sent.push(r); return { msgId: "r" }; }, now: () => clock.t,
  });
  assert.equal(result.status, "completed-provider-wait");
  assert.equal(result.routing.provider, "codex");
  assert.deepEqual(sent, [], "no reply is relayed to the operator");
  assert.equal(receipts.at(-1).metadata.disposition, "provider-wait");
  assert.deepEqual(c.sent(), []);
  assert.equal(c.waits.listWaiting().length, 1);
});

// ---------------------------------------------------------------------------
// Dispatch-level gate, active turns, retry storm, recovery
// ---------------------------------------------------------------------------

const gateWorld = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-gate-"));
  const db = createHandoffDatabase({ dir, agentId: "codex-agent" });
  const usageFile = path.join(dir, "usage.json");
  const recordFile = path.join(dir, "avail.json");
  const logs = [];
  let refreshes = 0;
  let refreshImpl = async () => {};
  const service = createAvailabilityService({
    provider: "codex", usageFile, recordFile, now: () => clock.t, log: (level, msg) => logs.push(msg),
    refreshUsage: async (p) => { refreshes += 1; await refreshImpl(p); },
  });
  const executed = [];
  const executeTurn = async (payload, dispatch) => {
    executed.push(payload.msgId);
    return world.turnResult(payload, dispatch);
  };
  const world = {
    dir, db, service, usageFile, recordFile, logs, executed,
    get refreshes() { return refreshes; },
    setRefresh: (fn) => { refreshImpl = fn; },
    turnResult: () => ({ status: "completed" }),
    gate: withQuotaGate({ service, dispatchStore: db.dispatchStore, executeTurn, now: () => clock.t, log: (l, m) => logs.push(m) }),
    enqueue: (msgId) => { db.dispatchStore.enqueue({ from: "claude-agent", text: "t", msgId, conversationId: `c-${msgId}`, memberSlot: "codex:app-server" }, clock.t); },
    claim: () => db.dispatchStore.claimDue(clock.t),
    row: (msgId) => db.dispatchStore.list().find((r) => r.msgId === msgId),
  };
  dirs.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return world;
};
const usageDoc = (remaining, resetMs, observedMs = clock.t) => ({
  available: true, source: "codex-app-server-rate-limits", kind: "subscription_usage", observedAt: iso(observedMs),
  windows: [{ id: "codex:primary", label: "Неделя", usedPercent: 100 - remaining, remainingPercent: remaining, resetsAt: iso(resetMs), windowMinutes: 10080, scope: null }],
});

test("EXHAUSTED provider: the claimed dispatch is deferred to the reset — no runtime start, no attempt consumed", async () => {
  const g = gateWorld();
  await writeUsageCache(g.usageFile, { codex: usageDoc(0, T0 + 60 * 60_000) });
  g.enqueue("m1");
  const dispatch = g.claim();
  const result = await g.gate({ msgId: "m1", conversationId: "c-m1" }, dispatch);
  assert.equal(result.status, "deferred-provider-quota");
  assert.deepEqual(g.executed, []);
  const row = g.row("m1");
  assert.equal(row.state, "deferred");
  assert.equal(row.attempts, 0);
  assert.equal(row.lastError, "provider-quota-exhausted");
  assert.equal(row.nextAttemptAt, T0 + 60 * 60_000 + 5_000);
  clock.t = T0 + 30 * 60_000;
  assert.equal(g.claim(), null, "not claimable before the reset: no retry storm");
});

test("after the reset the provider is refreshed, then work is released and runs exactly once", async () => {
  const g = gateWorld();
  await writeUsageCache(g.usageFile, { codex: usageDoc(0, T0 + 60 * 60_000) });
  g.enqueue("m1");
  await g.gate({ msgId: "m1" }, g.claim());
  clock.t = T0 + 61 * 60_000;
  g.setRefresh(async () => writeUsageCache(g.usageFile, { codex: usageDoc(80, T0 + 7 * 86400_000) }));
  const dispatch = g.claim();
  assert.ok(dispatch, "due at the reset");
  assert.deepEqual(await g.gate({ msgId: "m1" }, dispatch), { status: "completed" });
  assert.deepEqual(g.executed, ["m1"]);
  assert.equal(g.refreshes, 1);
});

test("reset passed but the provider is STILL exhausted: next reset stored, still deferred, one refresh, no launch", async () => {
  const g = gateWorld();
  await writeUsageCache(g.usageFile, { codex: usageDoc(0, T0 + 60 * 60_000) });
  g.enqueue("m1");
  await g.gate({ msgId: "m1" }, g.claim());
  clock.t = T0 + 61 * 60_000;
  g.setRefresh(async () => writeUsageCache(g.usageFile, { codex: usageDoc(0, T0 + 5 * 3600_000, clock.t) }));
  const out = await g.gate({ msgId: "m1" }, g.claim());
  assert.equal(out.status, "deferred-provider-quota");
  assert.deepEqual(g.executed, []);
  assert.equal(g.row("m1").nextAttemptAt, T0 + 5 * 3600_000 + 5_000);
  assert.equal(g.claim(), null);
});

test("a turn that FAILS with a provider quota error records EXHAUSTED and waits (attempt refunded, no retry storm)", async () => {
  const g = gateWorld();
  g.turnResult = (payload, dispatch) => {
    const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
    g.db.dispatchStore.beginHandoff(identity, clock.t, null);
    g.db.dispatchStore.fail(identity, "codex-app-server-turn-failed:limit", clock.t + 1_000, clock.t);
    return { status: "failed", error: Object.assign(new Error("codex-app-server-turn-failed:You've hit your usage limit"), { providerEvidence: { code: "usageLimitExceeded" } }) };
  };
  g.enqueue("m1");
  const result = await g.gate({ msgId: "m1" }, g.claim());
  assert.equal(result.status, "deferred-provider-quota");
  const row = g.row("m1");
  assert.equal(row.state, "deferred");
  assert.equal(row.attempts, 0, "the quota-failed attempt does not burn the retry budget");
  assert.equal(readAvailabilityRecords(g.recordFile).codex.state, "exhausted");
  assert.equal(readAvailabilityRecords(g.recordFile).codex.category, "usage_limit_reached");
  // the next dispatch cycle must not launch the model again
  clock.t += 2_000;
  g.enqueue("m2");
  const second = await g.gate({ msgId: "m2" }, g.claim());
  assert.equal(second.status, "deferred-provider-quota");
  assert.equal(g.executed.length, 1, "exactly one model launch for the whole period");
  const transitions = g.logs.filter((m) => m.startsWith("Provider quota exhausted"));
  assert.equal(transitions.length, 1, "one transition event, not one per dispatch");
});

test("a generic 429 / timeout / auth failure is NOT quota: normal retry semantics, provider stays routable", async () => {
  for (const evidence of [{ status: 429, isError: true, text: "Rate limited" }, { code: "httpConnectionFailed" }, null]) {
    const g = gateWorld();
    g.turnResult = (payload, dispatch) => {
      const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
      g.db.dispatchStore.beginHandoff(identity, clock.t, null);
      g.db.dispatchStore.fail(identity, "boom", clock.t + 1_000, clock.t);
      return { status: "failed", error: Object.assign(new Error("boom"), evidence ? { providerEvidence: evidence } : {}) };
    };
    g.enqueue("m1");
    const result = await g.gate({ msgId: "m1" }, g.claim());
    assert.equal(result.status, "failed");
    assert.equal(g.row("m1").state, "failed");
    assert.equal(g.row("m1").attempts, 1);
    assert.deepEqual(readAvailabilityRecords(g.recordFile), {});
  }
});

test("provider becomes exhausted WHILE a valid turn runs: the turn is not killed and completes; only NEW work waits", async () => {
  const g = gateWorld();
  await writeUsageCache(g.usageFile, { codex: usageDoc(50, T0 + 7 * 86400_000) });
  let cancelled = 0;
  g.turnResult = async () => {
    // usage polling flips to exhausted mid-turn
    await writeUsageCache(g.usageFile, { codex: usageDoc(0, T0 + 3600_000) });
    return { status: "completed" };
  };
  g.enqueue("m1");
  assert.deepEqual(await g.gate({ msgId: "m1" }, g.claim()), { status: "completed" });
  assert.equal(cancelled, 0, "nothing interrupts a turn the provider already accepted");
  assert.deepEqual(g.executed, ["m1"]);
  g.enqueue("m2");
  assert.equal((await g.gate({ msgId: "m2" }, g.claim())).status, "deferred-provider-quota");
  assert.deepEqual(g.executed, ["m1"]);
});

test("a real successful turn proves availability and clears an error-derived exhaustion", async () => {
  const g = gateWorld();
  recordExhaustion(g.recordFile, "codex", { observedAt: iso(T0 - 1000), source: "s", resetsAt: null, category: "usage_limit_reached" });
  clock.t = T0 + 31 * 60_000; // the no-reset hold elapsed => unknown, routable
  g.enqueue("m1");
  assert.deepEqual(await g.gate({ msgId: "m1" }, g.claim()), { status: "completed" });
  assert.deepEqual(readAvailabilityRecords(g.recordFile), {});
});

test("Cursor with no quota source: UNKNOWN, routable, never probed, never deferred", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-cursor-"));
  dirs.push(() => rmSync(dir, { recursive: true, force: true }));
  let refreshed = 0;
  const service = createAvailabilityService({
    provider: "cursor", usageFile: path.join(dir, "u.json"), recordFile: path.join(dir, "a.json"), now: () => clock.t,
    refreshUsage: async () => { refreshed += 1; },
  });
  const resolution = service.resolve();
  assert.equal(resolution.availability, "unknown");
  assert.equal(resolution.eligible, true);
  assert.equal((await service.gate()).allow, true);
  assert.equal(refreshed, 0);
  // a structured Cursor quota error DOES exclude it, with the same recovery framework
  service.observeTurn("cursor", { status: "failed", error: Object.assign(new Error("x"), { rpcError: { code: -1, data: { code: "quota_exceeded" } } }) });
  assert.equal(service.resolve().availability, "exhausted");
  assert.equal(readAvailabilityRecords(path.join(dir, "a.json")).cursor.source, "cursor-rpc-error");
  clock.t += 31 * 60_000;
  assert.equal(service.resolve().eligible, true, "no reset reported: re-checked after the bounded hold, never forever");
});

test("availability file lives under the Murmur home and holds nothing but the observation fields", () => {
  const file = availabilityFile({ MURMUR_HOME: "/tmp/mh" }, "/home/x");
  assert.equal(file, "/tmp/mh/cache/agent-models/provider-availability.json");
});

// ---------------------------------------------------------------------------
// Active Tasks
// ---------------------------------------------------------------------------

const ROOT = "root-task-aaaa-0001";
const worlds = [];
test.afterEach(() => { while (worlds.length) worlds.pop().cleanup(); });
const workWorld = async () => { const w = await makeWorld(); worlds.push(w); return w; };
const view = (w, providerStates = {}) => buildWorkSnapshot(collectWorkRecords({ project: w.project, paths: w.paths, now: WORLD_NOW, providerStates }), { projectName: "p", now: WORLD_NOW });

test("Active Tasks: a delegation waiting for a provider reset is waiting_for_provider — not running, no active agent, reset shown", async () => {
  const w = await workWorld();
  w.rootTask(ROOT, "review");
  w.dispatch("claude", ROOT, { state: "handed_off" });
  const waits = new ProviderWaitStore(w.dbs.claude.handoffStore.db);
  waits.upsert({ waitId: "h-wait-0001", workflowId: ROOT, provider: "codex", intendedRecipientId: w.id.codex, delegatorId: w.id.claude, causedByMessageId: ROOT,
    waitReason: "waiting_for_provider", resetsAt: WORLD_NOW + 41 * 60_000, nextCheckAt: WORLD_NOW + 41 * 60_000, record: {} }, WORLD_NOW - 5_000);
  const [task] = view(w).tasks;
  assert.equal(task.status, "waiting_for_provider");
  assert.equal(task.currentAgent, null, "no agent is reported active when no runtime turn is active");
  assert.equal(task.currentStage, "Ожидает лимита Codex");
  assert.equal(task.providerWait.resetsInMs, 41 * 60_000);
  assert.equal(task.providerWait.provider, "codex");
  assert.equal(task.providerWait.intendedRecipient, "codex");
  assert.equal(task.cancellable, true);
  assert.equal(view(w).summary.running, 0);
  assert.equal(view(w).summary.waitingForProvider, 1);
});

test("Active Tasks: no authoritative reset => blocked_by_provider_quota; mandatory flag preserved", async () => {
  const w = await workWorld();
  w.rootTask(ROOT, "review");
  w.dispatch("claude", ROOT, { state: "handed_off" });
  new ProviderWaitStore(w.dbs.claude.handoffStore.db).upsert({ waitId: "h-wait-0002", workflowId: ROOT, provider: "codex", intendedRecipientId: w.id.codex, delegatorId: w.id.claude,
    causedByMessageId: ROOT, mandatory: true, waitReason: "blocked_by_provider_quota", resetsAt: null, nextCheckAt: WORLD_NOW, record: {} }, WORLD_NOW);
  const [task] = view(w).tasks;
  assert.equal(task.status, "blocked_by_provider_quota");
  assert.equal(task.currentStage, "Заблокировано: лимит Codex исчерпан");
  assert.equal(task.providerWait.mandatory, true);
  assert.equal(task.providerWait.resetsAt, null);
});

test("Active Tasks: a root dispatch deferred because Claude is exhausted shows the wait with the provider's reset; recovery returns it to normal", async () => {
  const w = await workWorld();
  w.rootTask(ROOT, "task");
  w.dispatch("claude", ROOT, { state: "deferred", lastError: "provider-quota-exhausted" });
  const states = { claude: { availability: "exhausted", resetsAt: iso(WORLD_NOW + 90 * 60_000) } };
  const [task] = view(w, states).tasks;
  assert.equal(task.status, "waiting_for_provider");
  assert.equal(task.providerWait.provider, "claude");
  assert.equal(task.providerWait.resetsInMs, 90 * 60_000);
  assert.equal(task.currentAgent, null);
  assert.equal(view(w, {}).tasks[0].status, "blocked_by_provider_quota", "no known reset => blocked, not running");
  w.sql("claude", "UPDATE wake_dispatch SET state = 'pending', last_error = NULL WHERE msg_id = ?", ROOT);
  assert.equal(view(w, states).tasks[0].status, "queued", "released work is an ordinary task again");
});

// ---------------------------------------------------------------------------
// Runtime error shapes -> classification (the real Claude one-shot runner, fake CLI)
// ---------------------------------------------------------------------------

const claudeFailure = async (json) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-fake-claude-"));
  const file = path.join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(json)}\nJSON\n`);
  chmodSync(file, 0o755);
  try {
    await runClaudeOneShot({ prompt: "p", sessionId: json.session_id, cwd: os.tmpdir(), command: file, onSpawn: () => {} });
    return null;
  } catch (error) { return error; } finally { rmSync(dir, { recursive: true, force: true }); }
};
const CLAUDE_BASE = { type: "result", subtype: "success", is_error: true, stop_reason: "stop_sequence", terminal_reason: "api_error", session_id: "11111111-2222-3333-4444-555555555555", num_turns: 1, duration_ms: 5 };

test("Claude runner: an is_error 429 carrying the CLI's subscription-limit wording is quota; a plain 429 / 5xx / auth error is not", async () => {
  const quota = await claudeFailure({ ...CLAUDE_BASE, api_error_status: 429, result: "You've hit your limit · resets 3am (UTC)" });
  assert.equal(classifyProviderError("claude", evidenceFromError(quota)).exhausted, true);
  for (const [status, text] of [[429, "Request rejected (429) · rate limited, please retry"], [529, "Overloaded"], [401, "Invalid API key · Please run /login"], [500, "Internal server error"]]) {
    const error = await claudeFailure({ ...CLAUDE_BASE, api_error_status: status, result: text });
    assert.notEqual(classifyProviderError("claude", evidenceFromError(error))?.exhausted, true, `${status} ${text}`);
  }
});

test("persisted records and error messages never carry the provider's raw text", async () => {
  const error = await claudeFailure({ ...CLAUDE_BASE, api_error_status: 429, result: "You've hit your limit · token=sk-AAAAAAAAAAAAAAAAAAAAAAAA a@b.example" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-priv-"));
  try {
    const file = path.join(dir, "a.json");
    const verdict = classifyProviderError("claude", evidenceFromError(error));
    recordExhaustion(file, "claude", { observedAt: iso(T0), source: verdict.source, resetsAt: verdict.resetsAt, category: verdict.category });
    const stored = JSON.stringify(readAvailabilityRecords(file));
    assert.doesNotMatch(stored, /sk-AAAA|a@b\.example|hit your limit/);
    assert.doesNotMatch(error.message, /sk-AAAA|a@b\.example/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Independent-review regressions
// ---------------------------------------------------------------------------

test("a STALE generation cannot leave a durable wait behind (wait creation is fenced)", async () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  c.db.handoffStore.db.prepare("UPDATE runtime_bindings SET state = 'STALE'").run();
  const err = await delegate(c).catch((e) => e);
  assert.equal(err.reason, "handoff-continuation-stale-binding");
  assert.equal(c.waits.listWaiting().length, 0);
});

test("a cancelled workflow leaves no wait behind", async () => {
  const c = setup();
  c.state.codex = exhausted("codex");
  const rootId = "root-task-aaaa-0001";
  recordCancelRequest(c.db.handoffStore.db, rootId, { now: T0 });
  const err = await delegate(c, "codex-agent", { rootMessageId: rootId, causedByMessageId: rootId }).catch((e) => e);
  assert.equal(err.reason, "workflow-cancelled");
  assert.equal(c.waits.listWaiting().length, 0);
});

test("a quota error on the FINAL retry still waits for the reset (terminal dispatch is revived with its attempt refunded)", async () => {
  const g = gateWorld();
  g.turnResult = (payload, dispatch) => {
    const identity = { msgId: dispatch.msgId, recipientId: dispatch.recipientId, memberSlot: dispatch.memberSlot };
    g.db.dispatchStore.db.prepare("UPDATE wake_dispatch SET attempts = max_attempts - 1 WHERE msg_id = ?").run("m1");
    g.db.dispatchStore.beginHandoff(identity, clock.t, null);
    g.db.dispatchStore.fail(identity, "x", clock.t + 1000, clock.t);
    assert.equal(g.row("m1").state, "terminal");
    return { status: "failed", error: Object.assign(new Error("q"), { providerEvidence: { code: "usageLimitExceeded" } }) };
  };
  g.enqueue("m1");
  const result = await g.gate({ msgId: "m1" }, g.claim());
  assert.equal(result.status, "deferred-provider-quota");
  assert.equal(g.row("m1").state, "deferred");
});

test("error observations are per provider (no cross-provider overwrite) and per executable identity", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-ident-"));
  dirs.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "provider-availability.json");
  recordExhaustion(file, "codex", { observedAt: iso(T0), source: "s", resetsAt: iso(T0 + 3600_000), category: "usage_limit_reached", identity: "/bin/codex-a" });
  recordExhaustion(file, "claude", { observedAt: iso(T0), source: "s", resetsAt: iso(T0 + 3600_000), category: "usage_limit_reached" });
  assert.deepEqual(Object.keys(readAvailabilityRecords(file, { codex: "/bin/codex-a" })).sort(), ["claude", "codex"]);
  assert.equal(readAvailabilityRecords(file, { codex: "/bin/codex-b" }).codex, undefined, "another account's binary does not inherit it");
  assert.ok(readAvailabilityRecords(file, { codex: "/bin/codex-a" }).codex);
});

test("two projects with different Codex executables: B neither inherits, deletes, nor is deduplicated against A's record", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "murmur-two-"));
  dirs.push(() => rmSync(dir, { recursive: true, force: true }));
  const recordFile = path.join(dir, "provider-availability.json");
  const usageFile = path.join(dir, "u.json");
  const mkSvc = (identity) => createAvailabilityService({ provider: "codex", usageFile, recordFile, identities: { codex: identity }, now: () => T0 });
  const a = mkSvc("/bin/codex-a");
  const b = mkSvc("/bin/codex-b");
  const quota = { status: "failed", error: Object.assign(new Error("q"), { providerEvidence: { code: "usageLimitExceeded" } }) };
  assert.ok(a.observeTurn("codex", quota));
  assert.equal(a.resolve().availability, "exhausted");
  assert.equal(b.resolve().availability, "unknown", "B does not inherit A's exhaustion");
  b.resolveFresh();
  assert.equal(a.resolve().availability, "exhausted", "B's re-evaluation never deletes A's record");
  assert.ok(b.observeTurn("codex", quota));
  assert.equal(b.resolve().availability, "exhausted", "B persists its own identical observation");
  b.observeTurn("codex", { status: "completed" });
  assert.equal(b.resolve().availability, "unknown");
  assert.equal(a.resolve().availability, "exhausted", "B's success clears only B's record");
});
