import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { WebSocketServer } from "ws";
import { ChannelRosterStore } from "../packages/core/dist/src/index.js";
import { WakeMonitor, normalizeWakeConfig } from "../scripts/wake-monitor.mjs";
import { WakeDispatchStore } from "../scripts/wake-dispatch-store.mjs";
import {
  buildCodexTurnText,
  buildThreadStartParams,
  buildTurnStartRequest,
  CodexAppServerClient,
  createChannelThreadStartBindingResolver,
  createCodexAppServerDaemonInjector,
  createCodexAppServerInjector,
  readFinalAnswerFromSessionLog,
} from "../scripts/codex-app-server-wake.mjs";

const payload = {
  from: "agent-jarvis",
  text: "hello codex",
  msgId: "msg-codex-1",
  conversationId: "codex:task:test",
  cursor: 1,
};

test("normalizeWakeConfig accepts Codex app-server peer settings", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          threadId: "thread-1",
        },
      },
    },
  });

  assert.deepEqual(config.peers["agent-jarvis"], {
    mode: "codex_app_server",
    socketPath: "/tmp/codex.sock",
    threadId: "thread-1",
  });
});

test("normalizeWakeConfig preserves Codex reply relay peer settings", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          threadId: "thread-1",
          cwd: "/vault",
          murmurRoot: "/srv/mur-mur-v2",
          dataDir: "/srv/mur-mur-v2/.data-codex",
          storePath: "/srv/mur-mur-v2/.data-codex/murmur.db",
          relayFinalToMurmur: true,
          replyTimeoutMs: "180000",
        },
      },
    },
  });

  assert.deepEqual(config.peers["agent-jarvis"], {
    mode: "codex_app_server",
    socketPath: "/tmp/codex.sock",
    threadId: "thread-1",
    cwd: "/vault",
    murmurRoot: "/srv/mur-mur-v2",
    dataDir: "/srv/mur-mur-v2/.data-codex",
    storePath: "/srv/mur-mur-v2/.data-codex/murmur.db",
    relayFinalToMurmur: true,
    replyTimeoutMs: 180000,
  });
});

test("normalizeWakeConfig preserves the explicit resume opt-out", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          threadId: "thread-1",
          resume: false,
        },
      },
    },
  });

  assert.equal(config.peers["agent-jarvis"].resume, false);
});

test("normalizeWakeConfig preserves per-peer baseInstructions", () => {
  const config = normalizeWakeConfig({
    wake: {
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          baseInstructions: "You are the critic on this channel.",
        },
      },
    },
  });

  assert.equal(config.peers["agent-jarvis"].baseInstructions, "You are the critic on this channel.");
});

test("buildThreadStartParams carries peer cwd and model into thread/start", () => {
  const params = buildThreadStartParams(null, { cwd: "/work/project", model: "gpt-5.6-sol" });

  assert.equal(params.cwd, "/work/project");
  assert.equal(params.model, "gpt-5.6-sol");
});

test("Codex app-server injector keeps the seeded thread path and skips resume", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "fresh-thread", path: "/tmp/rollout-fresh.jsonl" } };
      }
      return {};
    }

    async startTurnAndWaitForFinal(params, options) {
      calls.push({ method: "turn/start:wait", params, options });
      return { finalText: "", turnId: "turn-1" };
    }
  }

  const peer = {
    mode: "codex_app_server",
    socketPath: "/tmp/codex.sock",
    cwd: "/work/project",
    relayFinalToMurmur: true,
    murmurRoot: "/work/murmur",
    dataDir: "/work/.data",
    storePath: "/work/.data/murmur.db",
  };
  const injector = createCodexAppServerInjector({ Client: FakeClient });

  await injector(payload, peer);

  // A thread created right here has no rollout file yet: resuming it can only fail.
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start:wait"]);
  assert.equal(calls[0].params.cwd, "/work/project");
  assert.equal(calls[1].options.sessionPath, "/tmp/rollout-fresh.jsonl");
});

test("buildTurnStartRequest builds Codex turn/start params", () => {
  const request = buildTurnStartRequest({
    id: 7,
    threadId: "thread-1",
    text: buildCodexTurnText(payload),
    metadata: { murmur_msg_id: payload.msgId },
  });

  assert.equal(request.id, 7);
  assert.equal(request.method, "turn/start");
  assert.equal(request.params.threadId, "thread-1");
  assert.equal(request.params.responsesapiClientMetadata.murmur_msg_id, payload.msgId);
  assert.match(request.params.input[0].text, /msgId=msg-codex-1/);
});

test("Codex local reply instruction correlates the response to the inbound msgId", () => {
  const text = buildCodexTurnText(payload, {
    murmurRoot: "/work/murmur",
    dataDir: "/work/.data",
    storePath: "/work/.data/murmur.db",
  });
  assert.match(text, /--reply-to 'msg-codex-1'/);
  assert.match(text, /--conv 'codex:task:test'/);
});

test("Codex local reply instruction quotes a msgId containing a shell quote", () => {
  const text = buildCodexTurnText({ ...payload, msgId: "msg-'quoted" }, {
    murmurRoot: "/work/murmur",
    dataDir: "/work/.data",
    storePath: "/work/.data/murmur.db",
  });
  assert.match(text, /--reply-to 'msg-'\\''quoted'/);
});

test("Codex local reply instruction refuses an uncorrelated reply without msgId", () => {
  const text = buildCodexTurnText({ ...payload, msgId: "   " }, {
    murmurRoot: "/work/murmur",
    dataDir: "/work/.data",
    storePath: "/work/.data/murmur.db",
  });
  assert.doesNotMatch(text, /--reply-to/);
  assert.match(text, /cannot send a correlated reply/);
});

test("buildThreadStartParams applies optional channel personality binding", () => {
  const params = buildThreadStartParams({
    model: "gpt-5",
    personality: "codex-writer",
    baseInstructions: "Write concise engineering notes.",
    metadata: { murmur_channel_id: "chan-1" },
  });

  assert.equal(params.model, "gpt-5");
  assert.equal(params.personality, "codex-writer");
  assert.equal(params.baseInstructions, "Write concise engineering notes.");
  assert.equal(params.modelProvider, null);
  assert.equal(params.ephemeral, false);
});

test("buildThreadStartParams preserves legacy nulled defaults without binding", () => {
  const params = buildThreadStartParams();

  assert.equal(params.model, null);
  assert.equal(params.personality, null);
  assert.equal(params.baseInstructions, null);
  assert.equal(params.modelProvider, null);
  assert.equal(params.ephemeral, false);
});

test("Codex app-server client initializes before turn/start over WS-over-UDS", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const received = [];
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      received.push(request);
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, result: { protocolVersion: "0.1.0" } }));
      }
      if (request.method === "turn/start") {
        socket.send(JSON.stringify({ id: request.id, result: { turn: { id: "turn-1" } } }));
      }
    });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  const client = new CodexAppServerClient({ socketPath });
  const result = await client.request("turn/start", {
    threadId: "thread-1",
    input: [{ type: "text", text: buildCodexTurnText(payload), text_elements: [] }],
  });

  wsServer.close();
  httpServer.close();

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  assert.equal(received[0].method, "initialize");
  assert.equal(received[0].params.clientInfo.name, "murmur-codex-app-server-wake");
  assert.equal(received[1].method, "initialized");
  assert.equal(received[2].method, "turn/start");
  assert.equal(received[2].params.threadId, "thread-1");
  assert.match(received[2].params.input[0].text, /msgId=msg-codex-1/);
  assert.match(received[2].params.input[0].text, /hello codex/);
});

test("Codex app-server client fails loud on initialize errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString("utf8"));
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ id: request.id, error: { message: "denied" } }));
      }
    });
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  const client = new CodexAppServerClient({ socketPath });
  await assert.rejects(
    () => client.request("turn/start", { threadId: "thread-1", input: [] }),
    /codex-app-server-initialize-error:denied/,
  );

  wsServer.close();
  httpServer.close();
});

test("Codex app-server client reports close before response", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-wake-"));
  const socketPath = path.join(dir, "codex.sock");
  const httpServer = http.createServer();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.close();
  });
  httpServer.listen(socketPath);
  await once(httpServer, "listening");

  const client = new CodexAppServerClient({ socketPath });
  await assert.rejects(
    () => client.request("turn/start", { threadId: "thread-1", input: [] }),
    /codex-app-server-closed-before-response:.*:before-initialize/,
  );

  wsServer.close();
  httpServer.close();
});

test("readFinalAnswerFromSessionLog reads task_complete by turn id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-session-log-"));
  const sessionPath = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(sessionPath, [
    JSON.stringify({
      timestamp: "2026-07-07T18:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-target",
        last_agent_message: "WAKE_OK",
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-07T18:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-other",
        last_agent_message: "WRONG",
      },
    }),
  ].join("\n"));

  assert.equal(readFinalAnswerFromSessionLog(sessionPath, "turn-target"), "WAKE_OK");
});

const protocolWebSocket = (turnStatus = "completed", { emitStarted = true } = {}) => class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit("open"));
  }

  send(raw) {
    const request = JSON.parse(raw);
    const emit = (message) => this.emit("message", Buffer.from(JSON.stringify(message)));
    if (request.method === "initialize") {
      queueMicrotask(() => emit({ id: request.id, result: { protocolVersion: "0.1.0" } }));
    } else if (request.method === "turn/start") {
      queueMicrotask(() => {
        emit({ id: request.id, result: { turn: { id: "turn-protocol" } } });
        if (emitStarted) emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-protocol", status: "inProgress" } } });
        emit({ method: "item/completed", params: { turnId: "turn-protocol", item: { type: "agentMessage", phase: "final_answer", text: "final" } } });
        emit({ method: "turn/completed", params: { turn: { id: "turn-protocol", status: turnStatus, ...(turnStatus === "completed" ? {} : { error: { message: "model failed" } }) } } });
      });
    }
  }

  close() {}
};

test("Codex protocol fixture exposes observed turn/started and terminal completion callbacks", async () => {
  const started = [];
  const client = new CodexAppServerClient({ socketPath: "/fake/codex.sock", WebSocketImpl: protocolWebSocket() });
  const result = await client.startTurnAndWaitForFinal({ threadId: "thread-1", input: [] }, {
    onStarted: ({ turnId }) => started.push(turnId),
  });
  assert.deepEqual(started, ["turn-protocol"]);
  assert.equal(result.turnId, "turn-protocol");
  assert.equal(result.finalText, "final");
  assert.equal(result.source, "app-server-events");
});

test("Codex protocol reports missing start without synthesizing it", async () => {
  const diagnostics = [];
  const client = new CodexAppServerClient({ socketPath: "/fake/codex.sock",
    WebSocketImpl: protocolWebSocket("completed", { emitStarted: false }),
    diagnosticObserver: (event) => diagnostics.push(event) });
  const started = [];
  const result = await client.startTurnAndWaitForFinal({ threadId: "thread-1", input: [] }, {
    onStarted: (event) => started.push(event),
  });
  assert.equal(result.source, "app-server-events");
  assert.equal(started.length, 0);
  assert.ok(diagnostics.some((event) => event.method === "turn/started"
    && event.source === "missing-start-diagnostic"
    && event.reason === "terminal-completed-without-observed-start"));
});

test("Codex protocol fails closed when durable started receipt is rejected", async () => {
  const diagnostics = [];
  const client = new CodexAppServerClient({ socketPath: "/fake/codex.sock",
    WebSocketImpl: protocolWebSocket(), diagnosticObserver: (event) => diagnostics.push(event) });
  await assert.rejects(() => client.startTurnAndWaitForFinal({ threadId: "thread-1", input: [] }, {
    onStarted: () => ({ accepted: false, reason: "stale-runtime-fence" }),
  }), /codex-processing-started-receipt-rejected:stale-runtime-fence/);
  assert.ok(diagnostics.some((event) => event.source === "processing-started-rejected"
    && event.method === "turn\/started" && event.threadId === "thread-1"
    && event.turnId === "turn-protocol" && event.reason === "stale-runtime-fence"));
});

test("Codex protocol fixture treats a failed terminal turn as processing failure", async () => {
  const client = new CodexAppServerClient({ socketPath: "/fake/codex.sock", WebSocketImpl: protocolWebSocket("failed") });
  await assert.rejects(
    () => client.startTurnAndWaitForFinal({ threadId: "thread-1", input: [] }),
    /codex-app-server-turn-failed:model failed/,
  );
});

test("WakeMonitor gates Codex app-server wake before injector", async () => {
  const injected = [];
  let now = 1000;
  const monitor = new WakeMonitor({
    peers: {
      "agent-jarvis": {
        mode: "codex_app_server",
        socketPath: "/tmp/codex.sock",
        threadId: "thread-1",
      },
    },
    dedup: { cooldownMs: 300000 },
    loopBreaker: { maxWakes: 1, windowMs: 60000 },
    auditHook: async (item) => item.msgId === "msg-deny" ? "deny" : "allow",
    injector: async (item, peer) => injected.push({ msgId: item.msgId, mode: peer.mode, threadId: peer.threadId }),
    now: () => now,
  });

  await monitor.onInbound(payload);
  now += 1000;
  await monitor.onInbound({ ...payload, cursor: 2 });
  now += 61000;
  await monitor.onInbound({ ...payload, msgId: "msg-deny", cursor: 3 });

  assert.deepEqual(injected, [{ msgId: "msg-codex-1", mode: "codex_app_server", threadId: "thread-1" }]);
});

test("Codex app-server injector re-seeds stale app-server threads", async () => {
  const calls = [];
  const logs = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "turn/start" && params.threadId === "stale-thread") {
        throw new Error("codex-app-server-error:thread not found: stale-thread");
      }
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock", threadId: "stale-thread" };
  const injector = createCodexAppServerInjector({
    Client: FakeClient,
    log: (level, message, data) => logs.push({ level, message, data }),
  });

  const result = await injector(payload, peer);

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  assert.equal(peer.threadId, "fresh-thread");
  assert.deepEqual(calls.map((call) => call.method), ["turn/start", "thread/start", "turn/start"]);
  assert.equal(calls[0].params.threadId, "stale-thread");
  assert.equal(calls[2].params.threadId, "fresh-thread");
  assert.equal(logs[0].message, "Codex app-server wake thread re-seeded");
});

test("Codex app-server injector seeds missing app-server threads", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const peer = { mode: "codex_app_server", socketPath: "/tmp/codex.sock" };
  const injector = createCodexAppServerInjector({ Client: FakeClient });

  const result = await injector(payload, peer);

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  assert.equal(peer.threadId, "fresh-thread");
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start"]);
  assert.equal(calls[1].params.threadId, "fresh-thread");
});

test("Codex app-server injector seeds thread with resolved channel member binding", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-roster-"));
  const roster = new ChannelRosterStore(path.join(dir, "channel-roster.db"));
  roster.createChannel({
    channelId: "chan:codex:writer",
    conversationId: payload.conversationId,
    type: "dm",
    members: [{
      memberId: "codex-writer",
      memberSlot: "agent-codex-volt:writer",
      agentId: "agent-codex-volt",
      personaId: "codex-writer",
      model: "gpt-5",
      baseInstructionsHash: "sha256:writer-v1",
    }],
  });
  const injector = createCodexAppServerInjector({
    Client: FakeClient,
    resolveThreadStartBinding: createChannelThreadStartBindingResolver({
      rosterStore: roster,
      agentId: "agent-codex-volt",
      baseInstructionsResolver: () => "Write concise engineering notes.",
    }),
  });

  const result = await injector(payload, { mode: "codex_app_server", socketPath: "/tmp/codex.sock" });

  assert.deepEqual(result, { turn: { id: "turn-1" } });
  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.model, "gpt-5");
  assert.equal(calls[0].params.personality, "codex-writer");
  assert.equal(calls[0].params.baseInstructions, "Write concise engineering notes.");
  assert.equal(calls[1].method, "turn/start");
  assert.equal(calls[1].params.responsesapiClientMetadata.murmur_channel_id, "chan:codex:writer");
  assert.equal(calls[1].params.responsesapiClientMetadata.murmur_member_id, "codex-writer");
  assert.equal(calls[1].params.responsesapiClientMetadata.murmur_base_instructions_hash, "sha256:writer-v1");
});

test("channel thread-start binding resolver returns null without member or agent identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-roster-no-id-"));
  const roster = new ChannelRosterStore(path.join(dir, "channel-roster.db"));
  roster.createChannel({
    channelId: "chan:codex:no-id",
    conversationId: payload.conversationId,
    type: "dm",
    members: [{ memberId: "codex-writer", agentId: "agent-codex-volt" }],
  });
  const resolveBinding = createChannelThreadStartBindingResolver({ rosterStore: roster });

  const binding = await resolveBinding(payload, {});

  assert.equal(binding, null);
  roster.close();
});

test("Codex app-server injector ignores remote payload thread-start binding", async () => {
  const calls = [];
  class FakeClient {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "fresh-thread" } };
      return { turn: { id: "turn-1" } };
    }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient });

  await injector({
    ...payload,
    threadStartBinding: {
      model: "remote-controlled-model",
      personality: "remote-controlled-persona",
      baseInstructions: "remote instructions",
    },
  }, { mode: "codex_app_server", socketPath: "/tmp/codex.sock" });

  assert.equal(calls[0].method, "thread/start");
  assert.equal(calls[0].params.model, null);
  assert.equal(calls[0].params.personality, null);
  assert.equal(calls[0].params.baseInstructions, null);
});

test("Codex app-server injector fails loud without socket", async () => {
  const injector = createCodexAppServerInjector();

  await assert.rejects(() => injector(payload, { mode: "codex_app_server", threadId: "thread-1" }), /socket-missing/);
});

test("Codex app-server processing receipts follow turn/started then final completion", async () => {
  const events = [];
  let metadata = null;
  class FakeClient {
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-receipt", path: null } };
      return {};
    }

    async startTurnAndWaitForFinal(params, options) {
      metadata = params.responsesapiClientMetadata;
      options.onStarted({ turnId: "turn-receipt" });
      return { turnId: "turn-receipt", finalText: "done", source: "app-server-events" };
    }
  }
  const injector = createCodexAppServerInjector({ Client: FakeClient });
  await injector(payload, { socketPath: "/tmp/codex.sock", resume: false }, {
    attemptId: "attempt-codex-1",
    started: ({ sessionId }) => events.push(["started", sessionId]),
    completed: ({ sessionId }) => events.push(["completed", sessionId]),
  });
  assert.deepEqual(events, [["started", "turn-receipt"], ["completed", "turn-receipt"]]);
  assert.equal(metadata.murmur_processing_attempt_id, "attempt-codex-1");
});

test("daemon Codex wrappers forward one processing attempt through started and completed", async () => {
  const observed = [];
  class FakeClient {
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread-daemon-wrapper", path: null } };
      return {};
    }

    async startTurnAndWaitForFinal(params, options) {
      const attemptId = params.responsesapiClientMetadata.murmur_processing_attempt_id;
      observed.push({ event: "turn/started", attemptId });
      options.onStarted({ turnId: "turn-daemon-wrapper" });
      observed.push({ event: "turn/completed", attemptId });
      return { turnId: "turn-daemon-wrapper", finalText: "done", source: "app-server-events" };
    }
  }
  const daemonInjector = createCodexAppServerDaemonInjector(
    createCodexAppServerInjector({ Client: FakeClient }),
  );

  for (const wrapperPath of ["primary", "proxy"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `murmur-codex-${wrapperPath}-`));
    const store = new WakeDispatchStore(path.join(dir, "murmur.db"));
    const item = { ...payload, msgId: `${payload.msgId}-${wrapperPath}` };
    const monitor = new WakeMonitor({
      dispatchStore: store,
      peers: {
        "agent-jarvis": {
          mode: "codex_app_server",
          socketPath: "/tmp/codex.sock",
          resume: false,
        },
      },
      injector: daemonInjector,
      now: () => 1000,
    });
    try {
      await monitor.onInbound(item);
      const dispatch = store.get(item.msgId);
      const attempt = store.latestProcessingAttempt(dispatch);
      const pathEvents = observed.slice(-2);
      assert.equal(attempt.status, "completed");
      assert.equal(attempt.sessionId, "turn-daemon-wrapper");
      assert.equal(dispatch.state, "handed_off");
      assert.equal(dispatch.attempts, 1);
      assert.deepEqual(pathEvents.map((event) => event.event), ["turn/started", "turn/completed"]);
      assert.equal(pathEvents[0].attemptId, attempt.attemptId);
      assert.equal(pathEvents[1].attemptId, attempt.attemptId);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("daemon Codex wrapper preserves legacy calls without processing context", async () => {
  let receivedProcessing = "not-called";
  const daemonInjector = createCodexAppServerDaemonInjector(async (_payload, _peer, processing) => {
    receivedProcessing = processing;
    return { turn: { id: "legacy-turn" } };
  });
  const result = await daemonInjector(payload, { mode: "codex_app_server" });
  assert.deepEqual(result, { turn: { id: "legacy-turn" } });
  assert.equal(receivedProcessing, null);
});

test("Codex app-server runtime failure records a failed processing attempt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-codex-receipt-"));
  const store = new WakeDispatchStore(path.join(dir, "murmur.db"));
  class FakeClient {
    async request() { return {}; }
    async startTurnAndWaitForFinal(_params, options) {
      options.onStarted({ turnId: "turn-failed" });
      throw new Error("codex-turn-failed");
    }
  }
  const monitor = new WakeMonitor({
    dispatchStore: store,
    peers: { "agent-jarvis": { mode: "codex_app_server", socketPath: "/tmp/codex.sock", threadId: "thread-1", resume: false } },
    injector: createCodexAppServerInjector({ Client: FakeClient }),
    now: () => 1000,
  });
  try {
    await monitor.onInbound(payload);
    const dispatch = store.get(payload.msgId);
    const attempt = store.latestProcessingAttempt(dispatch);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.sessionId, "turn-failed");
    assert.equal(attempt.lastError, "codex-turn-failed");
    assert.equal(dispatch.state, "failed");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
