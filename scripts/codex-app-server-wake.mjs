import WebSocket from "ws";
import { classifyProfile } from "./legacy-profile-guard.mjs";
import { buildChannelThreadStartBinding } from "@murmurv2/core";
import { execFile } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10000;
const INITIALIZE_TIMEOUT_MS = 10000;
const DEFAULT_TURN_COMPLETION_TIMEOUT_MS = 180000;
const SESSION_LOG_POLL_INTERVAL_MS = 1000;
const SESSION_LOG_TAIL_BYTES = 8 * 1024 * 1024;

const shellQuote = (value) => `'${String(value ?? "").replace(/'/g, "'\\''")}'`;

const buildReplyHint = (payload, peer = {}) => {
  if (peer?.relayFinalToMurmur === true) {
    return [
      "",
      "[MURMUR REPLY RELAY]",
      "If this Murmur message asks for a reply, put only the reply body in your final answer.",
      "Do not call tools to send Murmur yourself; the local daemon will relay your final answer back through Murmur.",
    ];
  }

  const murmurRoot = peer?.murmurRoot;
  const dataDir = peer?.dataDir;
  const storePath = peer?.storePath;
  if (!murmurRoot || !dataDir || !storePath || !payload?.from) return [];

  const replyToMessageId = typeof payload?.msgId === "string" ? payload.msgId.trim() : "";
  if (!replyToMessageId) {
    return [
      "",
      "[LOCAL REPLY PATH UNAVAILABLE]",
      "This inbound message has no msgId, so Murmur cannot send a correlated reply.",
      "Do not send an uncorrelated reply; report the missing message ID instead.",
    ];
  }

  const conv = payload.conversationId || "";
  const command = [
    `cd ${shellQuote(murmurRoot)}`,
    `DATA_DIR=${shellQuote(dataDir)}`,
    // A reply stays in the profile that received the request; a legacy one needs the explicit opt-in.
    ...(classifyProfile(dataDir).kind === "legacy" ? ["MURMUR_ALLOW_LEGACY_PROFILE=1"] : []),
    `MURMUR_STORE_PATH=${shellQuote(storePath)}`,
    "node scripts/murmur-shell-send.mjs",
    `--to ${shellQuote(payload.from)}`,
    `--conv ${shellQuote(conv)}`,
    `--reply-to ${shellQuote(replyToMessageId)}`,
    "--text '<your one-line reply>'",
  ].join(" ");

  return [
    "",
    "[LOCAL REPLY PATH]",
    "If this Murmur message asks for a reply, use the local command below.",
    "Do not SSH back into this Mac and do not use the default .data directory.",
    command,
  ];
};

export const buildCodexTurnText = (payload, peer = {}) => {
  const lines = [
    "[MURMUR WAKE]",
    `from=${payload.from || "unknown"}`,
    `conversationId=${payload.conversationId || ""}`,
    `msgId=${payload.msgId || ""}`,
    ...buildReplyHint(payload, peer),
    "",
    payload.text || "",
  ];
  return lines.join("\n");
};

export const buildTurnStartRequest = ({ id = 1, threadId, text, metadata = {} }) => ({
  id,
  method: "turn/start",
  params: {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    responsesapiClientMetadata: metadata,
  },
});

const readSessionLogTail = (sessionPath) => {
  const { size } = statSync(sessionPath);
  const length = Math.min(size, SESSION_LOG_TAIL_BYTES);
  if (length <= 0) return "";
  const fd = openSync(sessionPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

export const readFinalAnswerFromSessionLog = (sessionPath, turnId) => {
  if (!sessionPath || !turnId) return "";
  let data = "";
  try {
    data = readSessionLogTail(sessionPath);
  } catch {
    return "";
  }

  const lines = data.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes(turnId)) continue;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry?.payload || {};
    if (entry.type === "event_msg" && payload.type === "task_complete" && payload.turn_id === turnId) {
      return typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
    }

    const metadataTurnId = payload?.internal_chat_message_metadata_passthrough?.turn_id;
    if (
      payload.type === "message"
      && payload.role === "assistant"
      && payload.phase === "final_answer"
      && metadataTurnId === turnId
      && Array.isArray(payload.content)
    ) {
      return payload.content.map((part) => part?.text || "").join("\n").trim();
    }
  }
  return "";
};

export const buildThreadStartParams = (binding = null, peer = null) => ({
  // An explicit PROJECT model policy (set by the runtime adapter) outranks a channel
  // persona's model; the recipient project, not the roster or a sender, chooses.
  model: peer?.projectModelPolicy === true ? (peer.model ?? null) : (binding?.model ?? peer?.model ?? null),
  modelProvider: null,
  // A seeded thread must inherit the peer's working directory, otherwise Codex starts
  // in `/` with no project instructions, wrong workspace roots and wrong permissions.
  cwd: peer?.cwd ?? null,
  runtimeWorkspaceRoots: null,
  approvalPolicy: null,
  approvalsReviewer: null,
  sandbox: null,
  permissions: null,
  // Per-thread reasoning effort. `config` overrides apply to THIS thread only and never
  // write ~/.codex/config.toml (verified against the installed App Server).
  config: peer?.effort ? { model_reasoning_effort: peer.effort } : null,
  serviceName: null,
  baseInstructions: binding?.baseInstructions ?? null,
  developerInstructions: null,
  personality: binding?.personality ?? null,
  ephemeral: false,
  sessionStartSource: null,
  // Deterministic, client-supplied identity (set by the runtime adapter from the msgId): the
  // server returns it on the Thread, so a thread created just before a crash can be found again.
  threadSource: peer?.intent?.threadSource ?? null,
  environments: null,
  dynamicTools: null,
  selectedCapabilityRoots: null,
  mockExperimentalField: null,
});

const buildInitializeRequest = (id) => ({
  id,
  method: "initialize",
  params: {
    clientInfo: {
      name: "murmur-codex-app-server-wake",
      title: "Murmur Codex App-Server Wake",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [
        "command/exec/outputDelta",
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/fileChange/outputDelta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/textDelta",
      ],
    },
  },
});

export class CodexAppServerClient {
  constructor({ socketPath, timeoutMs = DEFAULT_TIMEOUT_MS, WebSocketImpl = WebSocket, diagnosticObserver = null } = {}) {
    if (!socketPath) throw new Error("codex-app-server-socket-missing");
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.diagnosticObserver = typeof diagnosticObserver === "function" ? diagnosticObserver : null;
    this.nextId = 1;
  }

  observe(message, details = {}) {
    if (!this.diagnosticObserver) return;
    const params = message?.params || {};
    try {
      this.diagnosticObserver({
        method: details.method || message?.method || null,
        threadId: params.threadId || params.thread?.id || details.threadId || null,
        turnId: params.turnId || params.turn?.id || details.turnId || null,
        turnStatus: params.turn?.status || details.turnStatus || null,
        timestamp: new Date().toISOString(),
        transport: "ws-unix",
        source: details.source || "app-server-notification",
        ...(details.reason ? { reason: details.reason } : {}),
      });
    } catch {
      // Diagnostics must never change protocol behavior.
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const request = { id, method, params };
    return this.send(request, id);
  }

  send(request, expectedId = request.id) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let initialized = false;
      const initId = `init-${this.nextId++}`;
      const url = `ws+unix://${this.socketPath}:/`;
      const socket = new this.WebSocketImpl(url, {
        perMessageDeflate: false,
        handshakeTimeout: Math.min(this.timeoutMs, INITIALIZE_TIMEOUT_MS),
      });
      const timer = setTimeout(() => {
        finish(new Error(`codex-app-server-timeout:${this.socketPath}`));
      }, this.timeoutMs);

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore close races; the request already has a terminal result.
        }
        if (err) reject(err);
        else resolve(result);
      };

      const sendJson = (message) => socket.send(JSON.stringify(message));

      socket.on("open", () => sendJson(buildInitializeRequest(initId)));
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }

        if (message.id === initId) {
          if (message.error) {
            finish(new Error(`codex-app-server-initialize-error:${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          initialized = true;
          sendJson({ method: "initialized" });
          sendJson(request);
          return;
        }

        if (message.id !== expectedId) return;
        if (message.error) {
          finish(new Error(`codex-app-server-error:${message.error.message || JSON.stringify(message.error)}`));
        } else {
          finish(null, message.result);
        }
      });
      socket.on("error", (err) => {
        finish(new Error(`codex-app-server-connect-failed:${this.socketPath}:${err.message}`));
      });
      socket.on("close", () => {
        if (!settled) finish(new Error(`codex-app-server-closed-before-response:${this.socketPath}:${initialized ? "after-initialize" : "before-initialize"}`));
      });
    });
  }

  startTurnAndWaitForFinal(params, {
    completionTimeoutMs = DEFAULT_TURN_COMPLETION_TIMEOUT_MS,
    sessionPath = null,
    onStarted = null,
    onTurnId = null,
    // ATTACH to a turn this message already launched (exactly-once): instead of `turn/start`,
    // `thread/resume` the recorded thread and wait for the recorded turn's terminal result.
    attach = null,
  } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let initialized = false;
      let turnId = null;
      let startResult = null;
      let finalText = "";
      let startedObserved = false;
      let logPath = sessionPath;
      // The thread's EFFECTIVE model/effort as the server itself reports it
      // (`thread/settings/updated`, emitted when a turn's overrides are applied).
      let effectiveSettings = null;
      const requestId = this.nextId++;
      const initId = `init-${this.nextId++}`;
      const url = `ws+unix://${this.socketPath}:/`;
      const socket = new this.WebSocketImpl(url, {
        perMessageDeflate: false,
        handshakeTimeout: Math.min(this.timeoutMs, INITIALIZE_TIMEOUT_MS),
      });
      const timer = setTimeout(() => {
        finish(new Error(`codex-app-server-turn-completion-timeout:${this.socketPath}:${turnId || "unknown"}`));
      }, completionTimeoutMs);
      const sessionLogTimer = setInterval(() => {
        if (settled || !logPath || !turnId) return;
        const text = readFinalAnswerFromSessionLog(logPath, turnId);
        if (!text) return;
        finalText = finalText || text;
        if (!startedObserved) this.observe(null, { method: "turn/started", turnId,
          source: "missing-start-diagnostic", reason: "session-log-completed-without-observed-start" });
        this.observe(null, { method: "turn/completion-source", turnId,
          turnStatus: "completed", source: "session-log" });
        finish(null, { ...startResult, finalText, turnId, source: "session-log", effectiveSettings });
      }, SESSION_LOG_POLL_INTERVAL_MS);

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(sessionLogTimer);
        try {
          socket.close();
        } catch {
          // Ignore close races; the request already has a terminal result.
        }
        if (err) reject(err);
        else resolve(result);
      };

      const sendJson = (message) => socket.send(JSON.stringify(message));
      const declineServerRequest = (message) => {
        if (message.id === undefined || typeof message.method !== "string") return false;
        if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
          sendJson({ jsonrpc: "2.0", id: message.id, result: { decision: "decline" } });
          return true;
        }
        if (message.method === "item/permissions/requestApproval") {
          sendJson({ jsonrpc: "2.0", id: message.id, result: { permissions: { id: ":workspace", extends: null }, scope: "turn" } });
          return true;
        }
        return false;
      };

      socket.on("open", () => {
        sendJson({
          ...buildInitializeRequest(initId),
          params: {
            ...buildInitializeRequest(initId).params,
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: [
                "command/exec/outputDelta",
                "item/plan/delta",
                "item/fileChange/outputDelta",
                "item/reasoning/summaryTextDelta",
                "item/reasoning/textDelta",
              ],
            },
          },
        });
      });

      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }

        if (typeof message.method === "string") this.observe(message);

        if (message.id === initId) {
          if (message.error) {
            finish(new Error(`codex-app-server-initialize-error:${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          initialized = true;
          sendJson({ method: "initialized" });
          if (attach) sendJson({ id: requestId, method: "thread/resume", params: { threadId: attach.threadId, cwd: params?.cwd ?? null } });
          else sendJson({ id: requestId, method: "turn/start", params });
          return;
        }

        if (declineServerRequest(message)) return;

        if (message.id === requestId) {
          if (message.error) {
            finish(new Error(`codex-app-server-error:${message.error.message || JSON.stringify(message.error)}`));
            return;
          }
          startResult = message.result;
          if (attach) {
            // `thread/resume` answered: wait for the RECORDED turn; its rollout (if any) is where a
            // result that completed before we attached can be read back.
            turnId = attach.turnId;
            logPath = message.result?.thread?.path || logPath;
            startResult = { turn: { id: turnId } };
          } else {
            turnId = message.result?.turn?.id || turnId;
          }
          if (turnId) {
            try {
              onTurnId?.({
                turnId,
                threadId: params?.threadId ?? null,
                // Ends THIS wait now. Used after the server accepted a scoped `turn/interrupt`:
                // the interrupted turn's `turn/completed` is not reliably delivered on this
                // connection, and waiting out the completion timeout would hold the runtime.
                abort: (reason = "operator-cancel") => finish(new Error(`codex-app-server-turn-interrupted:${reason}`)),
              });
            } catch { /* recording only */ }
          }
          return;
        }

        if (message.method === "thread/settings/updated" && message.params?.threadId === params?.threadId) {
          const settings = message.params.threadSettings;
          if (typeof settings?.model === "string") {
            effectiveSettings = {
              model: settings.model,
              effort: typeof settings.effort === "string" ? settings.effort : null,
            };
          }
          return;
        }

        if (message.method === "turn/started" && message.params?.turn?.id) {
          turnId = turnId || message.params.turn.id;
          try {
            const callbackResult = onStarted?.({ turnId, threadId: message.params.threadId || null });
            if (callbackResult?.accepted === false) {
              this.observe(message, { source: "processing-started-rejected", reason: callbackResult.reason || "rejected" });
              finish(new Error(`codex-processing-started-receipt-rejected:${callbackResult.reason || "rejected"}`));
              return;
            }
            startedObserved = true;
          } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            finish(new Error(`codex-processing-started-receipt-failed:${e.message}`));
          }
          return;
        }

        if (message.method === "item/completed" && message.params?.turnId) {
          turnId = turnId || message.params.turnId;
          if (message.params.turnId !== turnId) return;
          const item = message.params.item;
          if (item?.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
            finalText = item.text;
          }
          return;
        }

        if (message.method === "turn/completed" && message.params?.turn?.id) {
          turnId = turnId || message.params.turn.id;
          if (message.params.turn.id !== turnId) return;
          const status = message.params.turn.status;
          if (status && status !== "completed") {
            const detail = message.params.turn.error?.message || status;
            const failure = new Error(`codex-app-server-turn-${status}:${detail}`);
            // Structured App Server error info (e.g. "usageLimitExceeded"); in-memory classification input only.
            const info = message.params.turn.error?.codexErrorInfo;
            const code = typeof info === "string" ? info : (info && typeof info === "object" ? Object.keys(info)[0] : null);
            if (code) failure.providerEvidence = { code };
            finish(failure);
            return;
          }
          if (!startedObserved) this.observe(message, { method: "turn/started", source: "missing-start-diagnostic",
            reason: "terminal-completed-without-observed-start" });
          this.observe(message, { source: "app-server-events", turnId });
          finish(null, { ...startResult, finalText, turnId, source: "app-server-events", effectiveSettings });
        }
      });
      socket.on("error", (err) => {
        finish(new Error(`codex-app-server-connect-failed:${this.socketPath}:${err.message}`));
      });
      socket.on("close", () => {
        if (!settled) finish(new Error(`codex-app-server-closed-before-response:${this.socketPath}:${initialized ? "after-initialize" : "before-initialize"}`));
      });
    });
  }
}

const sendRelayReply = (peer = {}, payload = {}, finalText = "") => new Promise((resolve, reject) => {
  const text = String(finalText || "").trim();
  if (!peer.relayFinalToMurmur || !text) {
    resolve(null);
    return;
  }
  if (!peer.murmurRoot || !peer.dataDir || !peer.storePath || !payload.from || !payload.conversationId) {
    reject(new Error("murmur-reply-relay-config-missing"));
    return;
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "murmur-reply-relay."));
  const replyFile = path.join(workdir, "reply.txt");
  writeFileSync(replyFile, text, { mode: 0o600 });
  const script = path.join(peer.murmurRoot, "scripts", "murmur-shell-send.mjs");
  execFile(
    process.execPath,
    [script, "--to", payload.from, "--conv", payload.conversationId, "--reply-to", payload.msgId, "--text-file", replyFile],
    {
      cwd: peer.murmurRoot,
      env: {
        ...process.env,
        DATA_DIR: peer.dataDir,
        MURMUR_STORE_PATH: peer.storePath,
        MURMUR_ALLOW_LEGACY_PROFILE: "1",
      },
      timeout: 30000,
    },
    (err, stdout, stderr) => {
      rmSync(workdir, { recursive: true, force: true });
      if (err) {
        const detail = [stderr, stdout, err.message].filter(Boolean).join("\n").slice(0, 1200);
        reject(new Error(detail || "murmur-reply-relay-failed"));
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(String(stdout || "").trim());
      } catch {
        parsed = { stdout: String(stdout || "").trim() };
      }
      resolve(parsed);
    },
  );
});

const pickSingleOpenChannel = (channels) => {
  const open = (channels || []).filter((channel) => !channel.closedAt);
  return open.length === 1 ? open[0] : null;
};

export const createChannelThreadStartBindingResolver = ({ rosterStore, agentId, baseInstructionsResolver = null, log = () => {} } = {}) => {
  if (!rosterStore) return null;
  return async (payload, peer = {}) => {
    const channelId = payload?.channelId || peer.channelId || pickSingleOpenChannel(rosterStore.listChannelsForConversation(payload?.conversationId || ""))?.channelId;
    if (!channelId) return null;

    const memberId = payload?.addresseeMemberId || peer.memberId;
    const effectiveAgentId = agentId || peer.agentId;
    const member = memberId
      ? rosterStore.getChannelMember(channelId, memberId)
      : effectiveAgentId
        ? rosterStore.findActiveChannelMemberForAgent(channelId, effectiveAgentId)
        : null;
    if (!member || member.leftAt) return null;

    const baseInstructions = typeof baseInstructionsResolver === "function"
      ? await baseInstructionsResolver(member, payload, peer)
      : peer.baseInstructions ?? null;
    const binding = buildChannelThreadStartBinding({ member, baseInstructions });
    log("info", "Codex app-server channel binding resolved", {
      msgId: payload?.msgId,
      channelId: member.channelId,
      memberId: member.memberId,
      agentId: member.agentId,
      personaId: member.personaId ?? null,
      model: member.model ?? null,
      hasBaseInstructions: !!baseInstructions,
    });
    return binding;
  };
};

export const createCodexAppServerDaemonInjector = (codexInjector) => {
  if (typeof codexInjector !== "function") throw new Error("codex-app-server-injector-required");
  return async (payload, peer, processing = null) => {
    if (peer?.mode !== "codex_app_server") {
      throw new Error(`wake-native-mode-unsupported:${peer?.mode}`);
    }
    return codexInjector(payload, peer, processing);
  };
};

export const createCodexAppServerInjector = ({ Client = CodexAppServerClient, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, resolveThreadStartBinding = null } = {}) => {
  return async (payload, peer, processing = null) => {
    const socketPath = peer?.socketPath || peer?.target;
    if (!socketPath) throw new Error(`codex-app-server-socket-missing:${payload.from}`);

    const diagnosticObserver = peer?.protocolDiagnostics === true
      ? (diagnostic) => log("info", "Codex app-server protocol diagnostic", diagnostic)
      : null;
    const client = new Client({ socketPath, timeoutMs, diagnosticObserver });
    const text = buildCodexTurnText(payload, peer);
    const threadStartBinding = peer?.threadStartBinding ?? (resolveThreadStartBinding ? await resolveThreadStartBinding(payload, peer) : null);
    const bindingMetadata = threadStartBinding?.metadata ?? {};
    const shouldResumeThread = peer?.resume === true || (peer?.resume !== false && peer?.relayFinalToMurmur === true);
    let threadPath = null;
    let threadStartEffective = null;
    const resumeThread = async (threadId) => {
      if (!threadId || peer?.resume === false) return;
      try {
        const resumed = await client.request("thread/resume", {
          threadId,
          cwd: peer?.cwd ?? null,
          model: peer?.model ?? null,
        });
        threadPath = resumed?.thread?.path || threadPath;
        if (typeof resumed?.model === "string") {
          threadStartEffective = { model: resumed.model, effort: typeof resumed.reasoningEffort === "string" ? resumed.reasoningEffort : null };
        }
        log("info", "Codex app-server wake thread resumed", { msgId: payload.msgId, threadId, socketPath });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        log("warn", "Codex app-server wake thread resume failed", { msgId: payload.msgId, threadId, socketPath, error: e.message });
      }
    };
    const turnParams = (threadId) => ({
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(peer?.model ? { model: peer.model } : {}),
      ...(peer?.effort ? { effort: peer.effort } : {}),
      // Deterministic per message; the server stores it as the user message's `clientId`, so a turn
      // accepted just before a crash can be found again (and a duplicate is recognisable).
      ...(peer?.intent?.clientUserMessageId ? { clientUserMessageId: peer.intent.clientUserMessageId } : {}),
      responsesapiClientMetadata: {
        murmur_msg_id: payload.msgId || "",
        murmur_conversation_id: payload.conversationId || "",
        murmur_from: payload.from || "",
        ...(processing?.attemptId ? { murmur_processing_attempt_id: processing.attemptId } : {}),
        ...bindingMetadata,
      },
    });
    const startTurn = async (threadId) => {
      processing?.observeLaunch?.();   // durable stamp BEFORE the server can see the turn/start
      if (!processing && peer?.relayFinalToMurmur !== true && peer?.returnFinalToCaller !== true) {
        return client.request("turn/start", turnParams(threadId));
      }
      // The wait's completion fallback is the thread's rollout file. A thread this attempt did not
      // seed itself (adopted after a crash, or reused on a retry) has no path yet: ask the server.
      if (!threadPath) {
        try { threadPath = (await client.request("thread/read", { threadId, includeTurns: false }))?.thread?.path || null; } catch { /* best effort */ }
      }
      const result = await client.startTurnAndWaitForFinal(turnParams(threadId), {
        completionTimeoutMs: Number(peer?.replyTimeoutMs) || DEFAULT_TURN_COMPLETION_TIMEOUT_MS,
        sessionPath: threadPath,
        ...(typeof processing?.started === "function"
          ? { onStarted: ({ turnId }) => processing.started({ sessionId: turnId }) }
          : {}),
        // The turn id comes from the `turn/start` RESPONSE (the `turn/started` notification is not
        // reliably observed on this connection). It only RECORDS the exact ids for a scoped
        // `turn/interrupt`; it is not a processing-started receipt.
        ...(typeof processing?.observeTurn === "function"
          ? { onTurnId: ({ turnId, threadId: acceptedThreadId, abort }) => processing.observeTurn({ sessionId: turnId, threadId: acceptedThreadId ?? threadId, abort }) }
          : {}),
      });
      diagnosticObserver?.({ method: "turn/completion-source", threadId, turnId: result?.turnId ?? null,
        turnStatus: "completed", timestamp: new Date().toISOString(), transport: "ws-unix",
        source: result?.source || "unknown" });
      processing?.completed({ sessionId: result?.turnId ?? null });
      if (peer?.relayFinalToMurmur === true) {
        let relay = null;
        let relayFailed = false;
        try {
          relay = await sendRelayReply(peer, payload, result?.finalText || "");
        } catch (err) {
          relayFailed = true;
          const e = err instanceof Error ? err : new Error(String(err));
          log("error", "Codex app-server processing completed but reply relay failed", {
            msgId: payload.msgId,
            threadId,
            turnId: result?.turnId,
            error: e.message,
          });
        }
        log(relayFailed ? "warn" : "info", relayFailed
          ? "Codex app-server wake final reply not relayed"
          : "Codex app-server wake final relayed", {
          msgId: payload.msgId,
          threadId,
          socketPath,
          turnId: result?.turnId,
          source: result?.source ?? null,
          replyMsgId: relay?.msgId ?? null,
          finalTextLen: String(result?.finalText || "").length,
        });
        if (relay?.msgId) processing?.completed({ sessionId: result?.turnId ?? null, resultMessageId: relay.msgId });
      }
      return result;
    };

    // A thread seeded in this call has no rollout file until its first turn, so
    // `thread/resume` can only fail on it — and that failure is what used to leave
    // `threadPath` null and silently disable the session-log completion fallback.
    const seedThread = async (reason) => {
      processing?.observeLaunch?.();   // durable stamp BEFORE the server can see the request
      const started = await client.request("thread/start", buildThreadStartParams(threadStartBinding, peer));
      const seededId = started?.thread?.id;
      if (!seededId) throw new Error(`codex-app-server-thread-start-missing:${payload.from}`);
      threadPath = started?.thread?.path || threadPath;
      // Record the thread BEFORE any turn: a retry of this message reuses it instead of seeding another.
      try { processing?.observeSeed?.({ threadId: seededId }); } catch { /* recording only */ }
      if (typeof started?.model === "string") {
        threadStartEffective = { model: started.model, effort: typeof started.reasoningEffort === "string" ? started.reasoningEffort : null };
      }
      peer.threadId = seededId;
      log("info", `Codex app-server wake thread ${reason}`, { msgId: payload.msgId, threadId: seededId, socketPath, threadPath });
      return seededId;
    };

    // CRASH RECONCILIATION. On a retry, before ANY server mutation, ask the server whether the
    // previous attempt already created this message's thread or launched its turn — even if this
    // process died before it could record that. Both identities were supplied by us up front:
    //   thread: `thread/loaded/list` + `thread/read` -> `threadSource === intent.threadSource`
    //   turn:   `thread/turns/list` -> a user message whose `clientId === intent.clientUserMessageId`
    const intent = peer?.intent ?? null;
    const gone = (error) => /no rollout found|thread not found/i.test(error instanceof Error ? error.message : String(error));
    const asList = (result) => (Array.isArray(result) ? result : (result?.data ?? result?.turns ?? result?.threads ?? []));
    const unknown = (why) => new Error(`codex-app-server-reconcile-state-unknown:${why}`);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const discoverThreadBySource = async () => {
      // EVERY loaded thread, every page: order is not assumed and nothing is silently skipped — if the
      // search cannot be completed the attempt FAILS (and is retried) rather than seeding a second thread.
      const ids = [];
      let cursor = null;
      for (let page = 0; page < 200; page += 1) {
        const listed = await client.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        ids.push(...asList(listed));
        cursor = listed?.nextCursor ?? null;
        if (!cursor) break;
        if (page === 199) throw unknown("loaded-thread-list-incomplete");
      }
      for (let i = 0; i < ids.length; i += 8) {
        const batch = ids.slice(i, i + 8);
        const reads = await Promise.all(batch.map((id) => client.request("thread/read", { threadId: id, includeTurns: false })
          .then((read) => ({ id, read }))
          // Only a DEFINITIVE "this thread is gone" may be skipped. Any other failure means we could not
          // look at a thread that might be ours, so the search is incomplete: fail, never guess "no match".
          .catch((error) => { if (gone(error)) return { id, read: null }; throw unknown(`thread-read-failed:${String(error?.message ?? error).slice(0, 60)}`); })));
        const match = reads.find(({ read }) => read?.thread?.threadSource === intent.threadSource);
        if (match) return { id: match.id, path: match.read.thread.path || null };
      }
      return null;
    };
    const threadStatus = async (threadId) => {
      try { return (await client.request("thread/read", { threadId, includeTurns: false }))?.thread?.status?.type ?? null; } catch { return null; }
    };
    // Every page of the thread's turns (newest first); `null` => not present on ANY page.
    const scanTurns = async (threadId) => {
      let cursor = null;
      for (let page = 0; page < 200; page += 1) {
        const listed = await client.request("thread/turns/list", { threadId, itemsView: "full", limit: 50, sortDirection: "desc", ...(cursor ? { cursor } : {}) });
        for (const turn of asList(listed)) {
          if ((turn?.items ?? []).some((item) => item?.type === "userMessage" && item?.clientId === intent.clientUserMessageId)) return turn.id;
        }
        cursor = listed?.nextCursor ?? null;
        if (!cursor) return null;
      }
      throw unknown("turn-list-incomplete");
    };
    const findTurnByClientId = async (threadId) => {
      const pollMs = intent.pollMs ?? 500;
      // The launch stamp is written BEFORE the connection is opened; the request can reach the server up
      // to one client timeout later. The quiescence window therefore starts counting only after that
      // bound, so a request still in flight when the process died has been processed before "no turn".
      const sendBoundMs = Number(client?.timeoutMs) || 0;
      const quiescenceMs = (intent.quiescenceMs ?? 15_000) + sendBoundMs;
      const recordedAt = intent.recordedAt ?? 0;
      const startedAt = Date.now();
      const deadline = startedAt + Math.max(20_000, quiescenceMs + 5_000);
      let idleLooks = 0;
      while (Date.now() < deadline) {
        let found = null;
        let unmaterialized = false;
        try {
          found = await scanTurns(threadId);
        } catch (error) {
          // Real App Server: a thread with no user message yet is "not materialized". That is the proof
          // that no turn exists — but ALSO what a turn that was just accepted looks like for a moment.
          if (!/not materialized/i.test(error instanceof Error ? error.message : String(error))) throw error;
          unmaterialized = true;
        }
        if (found) return found;
        const status = await threadStatus(threadId);
        if (status === "idle") {
          idleLooks += 1;
          // "No turn" is concluded only when the thread has stayed idle and the turn absent over several
          // looks AND long enough after the last durable write that a request still in flight when the
          // process died would have been processed. Anything less is an unknown state, not an answer.
          if (idleLooks >= (unmaterialized ? 6 : 2) && Date.now() - recordedAt >= quiescenceMs) return null;
        } else {
          idleLooks = 0;   // a turn is in flight (or the state is unknown): keep waiting, never duplicate it
        }
        await sleep(pollMs);
      }
      // Could not prove either way: do NOT start another turn — fail this attempt, reconcile again next time.
      throw unknown("turn-in-flight-not-listable");
    };
    if (intent?.retry && !peer.attachTurn) {
      // The thread this message's turn runs on: the recorded one, else the conversation/continuation
      // thread it was routed to (a turn launched there must also be found again), else — if this
      // message seeded its own thread — look it up by the identity we gave it.
      let knownThread = intent.threadId ?? peer.threadId ?? null;
      if (!knownThread) {
        const found = await discoverThreadBySource();
        knownThread = found?.id ?? null;
        if (found?.path) threadPath = found.path;
        if (knownThread) {
          try { processing?.observeSeed?.({ threadId: knownThread }); } catch { /* recording only */ }
          log("info", "Codex app-server wake adopted the thread a previous attempt created but never recorded", { msgId: payload.msgId, threadId: knownThread });
        }
      }
      if (knownThread) {
        let turnId = null;
        try {
          turnId = await findTurnByClientId(knownThread);
        } catch (error) {
          // A thread the server cannot find: if no turn was ever recorded, nothing ran in it — seed fresh.
          if (!gone(error) || intent.turnId) throw error;
          knownThread = null;
        }
        if (turnId) {
          peer.attachTurn = { threadId: knownThread, turnId };
          log("info", "Codex app-server wake found the turn a previous attempt launched but never recorded", { msgId: payload.msgId, threadId: knownThread, turnId });
        } else if (knownThread) {
          peer.threadId = knownThread;
        }
      }
    }

    // EXACTLY-ONCE: this message already launched a turn on a live server -> attach to it. No
    // thread/start, no thread/resume-for-continuation, no second turn/start.
    if (peer?.attachTurn?.threadId && peer?.attachTurn?.turnId) {
      const attached = await client.startTurnAndWaitForFinal(turnParams(peer.attachTurn.threadId), {
        completionTimeoutMs: Number(peer?.replyTimeoutMs) || DEFAULT_TURN_COMPLETION_TIMEOUT_MS,
        sessionPath: null,
        attach: { threadId: peer.attachTurn.threadId, turnId: peer.attachTurn.turnId },
        ...(typeof processing?.observeTurn === "function"
          ? { onTurnId: ({ turnId, threadId: acceptedThreadId, abort }) => processing.observeTurn({ sessionId: turnId, threadId: acceptedThreadId ?? peer.attachTurn.threadId, abort }) }
          : {}),
      });
      log("info", "Codex app-server wake attached to the turn this message already launched", {
        msgId: payload.msgId, threadId: peer.attachTurn.threadId, turnId: attached?.turnId ?? peer.attachTurn.turnId,
      });
      processing?.completed({ sessionId: attached?.turnId ?? null });
      peer.threadId = peer.attachTurn.threadId;
      return attached;
    }

    let threadId = peer?.threadId;
    let seededHere = false;
    if (!threadId) {
      threadId = await seedThread("seeded");
      seededHere = true;
    }

    let result;
    try {
      if (shouldResumeThread && !seededHere) await resumeThread(threadId);
      result = await startTurn(threadId);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!e.message.startsWith("codex-app-server-error:thread not found:")) throw e;
      threadId = await seedThread("re-seeded");
      result = await startTurn(threadId);
    }
    log("info", "Codex app-server wake completed", { msgId: payload.msgId, threadId, socketPath });
    // The effective model/effort for display: the server's own settings notification if it
    // arrived, else the thread start/resume response — never a guess from what was asked.
    const effective = result?.effectiveSettings ?? threadStartEffective ?? null;
    return effective && result && typeof result === "object"
      ? { ...result, effective, effectiveSource: result.effectiveSettings ? "thread-settings" : "thread-start" }
      : result;
  };
};
