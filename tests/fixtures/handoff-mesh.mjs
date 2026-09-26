/**
 * Deterministic in-process three-agent mesh for explicit handoff.
 *
 * Every layer that matters for handoff is the REAL implementation: the handoff store,
 * the handoff controller, the turn coordinator, the runtime adapters, the wake dispatch
 * ledger, the runtime binding/fencing store and the receiver-side admission gate. Only
 * two things are stubbed — the NATS transport (an in-memory FIFO that still routes
 * strictly by the paired peer subject) and the three model processes (scripted
 * responses). Nothing here re-implements handoff semantics.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  HANDOFF_WIRE_VERSION,
  SQLiteDedupeOutboxStore,
  isEnvelopeV11,
  isSupportedEnvelope,
} from "../../packages/core/dist/src/index.js";
import { AgentHandoffController, admitInboundHandoff } from "../../scripts/agent-handoff-controller.mjs";
import { HandoffTurnCoordinator } from "../../scripts/agent-handoff-runtime.mjs";
import { AgentHandoffStore } from "../../scripts/agent-handoff-store.mjs";
import {
  CODEX_APP_SERVER_MEMBER_SLOT,
  ClaudeOneShotRuntimeAdapter,
  CodexAppServerRuntimeAdapter,
  CursorAcpRuntimeAdapter,
} from "../../scripts/agent-runtime-adapter.mjs";
import { AgentRuntimeRegistry } from "../../scripts/agent-runtime-registry.mjs";
import { CLAUDE_AUTO_MEMBER_SLOT, ClaudeOneShotRuntime } from "../../scripts/claude-one-shot-runtime.mjs";
import { CURSOR_ACP_MEMBER_SLOT, CursorAcpRuntime } from "../../scripts/cursor-acp-runtime.mjs";
import { RuntimeBindingStore } from "../../scripts/runtime-binding-store.mjs";
import { WakeDispatchStore } from "../../scripts/wake-dispatch-store.mjs";
import { WakeMonitor } from "../../scripts/wake-monitor.mjs";

const HANDOFF_CAPABLE = { protocolVersions: ["1.0", HANDOFF_WIRE_VERSION], features: ["handoff-v1"] };

class MeshCursorClient {
  constructor(agent) { this.agent = agent; this.sessions = new Set(); this.running = false; this.nextSession = 1; }
  async start() { this.running = true; return { pid: 9001, processStartIdentity: "9001:mesh" }; }
  health() { return { healthy: this.running, pid: 9001, sessionIds: [...this.sessions] }; }
  async createSession() { const id = `cursor-session-${this.nextSession++}`; this.sessions.add(id); return id; }
  async loadSession(id) { this.sessions.add(id); return id; }
  async executeTurn({ sessionId, prompt, onSubmitted, onUpdate }) {
    onSubmitted();
    onUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "" } });
    const text = this.agent.respond({ prompt, sessionId });
    return { text, sessionId, stopReason: "end_turn" };
  }
  async cancel() { return true; }
  async shutdown() { this.running = false; return true; }
}

export class MeshAgent {
  constructor({ mesh, agentId, kind, dir, respond, maxDepth = 4 }) {
    this.mesh = mesh;
    this.agentId = agentId;
    this.kind = kind;
    this.responder = respond;
    this.turns = [];
    this.modelSessions = [];
    this.dir = path.join(dir, agentId);
    mkdirSync(this.dir, { recursive: true });
    this.dbPath = path.join(this.dir, "murmur.db");
    this.dispatchStore = new WakeDispatchStore(this.dbPath, { recipientId: agentId, maxAttempts: 3 });
    // The real shared outbox: the fenced transaction writes the outbound handoff row here.
    this.outboxStore = new SQLiteDedupeOutboxStore(this.dbPath);
    this.bindingStore = new RuntimeBindingStore(this.dbPath);
    this.handoffStore = new AgentHandoffStore(this.dbPath);
    this.controller = new AgentHandoffController({
      store: this.handoffStore,
      agentId,
      peers: {},
      maxDepth,
      // Build + "sign" only. No durable write: the controller commits the envelope into
      // the outbox inside its fenced transaction.
      buildHandoffEnvelope: (request) => this.mesh.buildHandoff(this, request),
      // Publication happens strictly AFTER the durable commit, which is exactly what the
      // real outbox flush does.
      recordHandoffAudit: ({ continuation, envelope }) => this.mesh.publishHandoff(this, continuation, envelope),
      log: (level, msg, data) => this.mesh.record({ agentId, level, msg, ...data }),
    });
    this.coordinator = new HandoffTurnCoordinator({
      controller: this.controller,
      log: (level, msg, data) => this.mesh.record({ agentId, level, msg, ...data }),
    });
    this.runtime = this.buildRuntime();
    this.registry = new AgentRuntimeRegistry([this.runtime]);
    this.memberSlot = this.runtime.memberSlot;
    this.monitor = new WakeMonitor({
      dispatchStore: this.dispatchStore,
      runtimeDispatcher: (payload, dispatch) => this.registry.executeTurn(payload, dispatch),
      onHandoffRejected: (payload, failure) => this.mesh.sendFailure(this, payload, failure),
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
      loopBreaker: { maxWakes: 50, windowMs: 60_000 },
      log: () => {},
    });
  }

  respond({ prompt, sessionId }) {
    this.turns.push(prompt);
    this.modelSessions.push(sessionId);
    return this.responder({ prompt, turnIndex: this.turns.length - 1, agent: this });
  }

  buildRuntime() {
    const common = {
      bindingStore: this.bindingStore,
      dispatchStore: this.dispatchStore,
      agentId: this.agentId,
      projectId: `${this.agentId}-project`,
      sendReply: (reply) => this.mesh.sendReply(this, reply),
      handoff: this.coordinator,
      retryDelayMs: 1,
      heartbeatIntervalMs: 50,
      log: () => {},
    };
    if (this.kind === "claude") {
      return new ClaudeOneShotRuntimeAdapter(new ClaudeOneShotRuntime({
        ...common,
        cwd: this.dir,
        runner: async ({ prompt, sessionId, resume, onSpawn }) => {
          this.resumes ??= [];
          this.resumes.push({ sessionId, resume });
          onSpawn({ pid: 7001 + this.resumes.length, processStartIdentity: `7001:${this.resumes.length}` });
          const text = this.respond({ prompt, sessionId });
          return { text, sessionId };
        },
      }));
    }
    if (this.kind === "cursor") {
      this.cursorClient = new MeshCursorClient(this);
      return new CursorAcpRuntimeAdapter(new CursorAcpRuntime({ ...common, cwd: this.dir, client: this.cursorClient }));
    }
    const socketPath = path.join(this.dir, "app-server.sock");
    writeFileSync(socketPath, "");
    this.codexThreads = [];
    let nextThread = 1;
    return new CodexAppServerRuntimeAdapter({
      ...common,
      peer: { socketPath, mode: "codex_app_server" },
      readServerIdentity: () => this.mesh.codexServerIdentity,
      injector: async (payload, runtimePeer, processing) => {
        const threadId = runtimePeer.threadId || `codex-thread-${nextThread++}`;
        runtimePeer.threadId = threadId;
        this.codexThreads.push(threadId);
        const finalText = this.respond({ prompt: payload.text, sessionId: threadId });
        processing.completed({ sessionId: `turn-${this.turns.length}` });
        return { threadId, turnId: `turn-${this.turns.length}`, finalText };
      },
    });
  }

  async start(options = {}) {
    await this.runtime.start({ bindingId: `${this.agentId}-binding`, runtimeGeneration: 1, leaseTtlMs: 60_000, ...options });
    return this;
  }

  pairWith(other) {
    this.controller.peers[other.agentId] = {
      encryption: { publicKey: `enc-${other.agentId}` },
      signing: { publicKey: `sig-${other.agentId}` },
      subject: `msg.${other.agentId}`,
      ...HANDOFF_CAPABLE,
    };
    return this;
  }

  pairOrdinaryOnly(other) {
    this.controller.peers[other.agentId] = {
      encryption: { publicKey: `enc-${other.agentId}` },
      signing: { publicKey: `sig-${other.agentId}` },
      subject: `msg.${other.agentId}`,
    };
    return this;
  }

  /** The receiver side of the daemon: admission gate, then the durable wake ledger. */
  async receive(message) {
    if (message.kind === "handoff") {
      const envelope = message.envelope;
      assert.equal(isSupportedEnvelope(envelope), true, "mesh delivered an unsupported envelope");
      assert.equal(isEnvelopeV11(envelope), true, "a handoff must be a structurally valid 1.1 envelope");
      const admission = admitInboundHandoff({
        envelope,
        localAgentId: this.agentId,
        maxDepth: this.controller.maxDepth,
        hasAutonomousRuntime: true,
      });
      if (!admission.ok) {
        this.dispatchStore.rejectInbound(this.payloadFor(message), admission.reason);
        await this.mesh.sendFailure(this, this.payloadFor(message), admission);
        return;
      }
    }
    await this.monitor.onInbound(this.payloadFor(message));
  }

  payloadFor(message) {
    return {
      from: message.from,
      text: message.text,
      msgId: message.msgId,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.handoff ? { handoff: message.handoff } : {}),
      conversationId: message.conversationId,
      memberSlot: this.memberSlot,
      ts: new Date(this.mesh.clock++).toISOString(),
      cursor: this.mesh.clock,
    };
  }

  openContinuations() { return this.handoffStore.listOpen(); }

  close() {
    this.runtime.shutdown();
    this.handoffStore.close();
    this.bindingStore.close();
    this.dispatchStore.close();
    try { this.outboxStore.db?.close?.(); } catch { /* already closed */ }
  }
}

export class HandoffMesh {
  constructor({ dir }) {
    this.dir = dir;
    this.agents = new Map();
    this.queue = [];
    this.wire = [];
    this.built = [];
    this.logs = [];
    this.clock = 1;
    this.nextMsgId = 1;
    this.codexServerIdentity = "codex-app-server-identity-1";
  }

  record(entry) { this.logs.push(entry); }

  agent(spec) {
    const agent = new MeshAgent({ ...spec, mesh: this, dir: this.dir });
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  subjectFor(agentId) { return `msg.${agentId}`; }

  routeBySubject(subject) {
    for (const agentId of this.agents.keys()) {
      if (this.subjectFor(agentId) === subject) return this.agents.get(agentId);
    }
    throw new Error(`mesh-unroutable-subject:${subject}`);
  }

  /** Build (and pretend to sign) the outbound envelope. No durable write, no publication. */
  async buildHandoff(sender, { msgId, to, subject, conversationId, handoff, text }) {
    // Routing is by the paired peer SUBJECT, never by a model-supplied address.
    const target = this.routeBySubject(subject);
    assert.equal(target.agentId, to, "subject and recipient must agree");
    const envelope = {
      schemaVersion: HANDOFF_WIRE_VERSION,
      msgId,
      conversationId,
      senderAgentId: sender.agentId,
      recipients: [to],
      createdAt: new Date(this.clock++).toISOString(),
      payloadCiphertext: Buffer.from(text, "utf8").toString("base64"),
      payloadNonce: "mesh-nonce",
      handoff,
      signature: "mesh-signature",
    };
    this.built.push({ from: sender.agentId, to, msgId, conversationId, handoff, text, envelope });
    return { subject, envelope };
  }

  /** Publish AFTER the durable commit, mirroring the real outbox flush. */
  async publishHandoff(sender, continuation, envelope) {
    const message = {
      kind: "handoff",
      from: sender.agentId,
      to: continuation.recipientId,
      msgId: continuation.handoffMsgId,
      conversationId: continuation.handoffConversationId,
      handoff: envelope.handoff,
      text: continuation.taskText,
      envelope,
    };
    this.wire.push(message);
    this.queue.push(message);
    return { msgId: message.msgId };
  }

  async sendReply(sender, { msgId, to, conversationId, replyToMessageId, text }) {
    assert.ok(replyToMessageId, "a mesh reply must be exactly correlated");
    const message = { kind: "reply", from: sender.agentId, to, msgId, conversationId, replyToMessageId, text };
    this.wire.push(message);
    if (this.agents.has(to)) this.queue.push(message);
    return { msgId };
  }

  async sendFailure(sender, payload, failure) {
    return this.sendReply(sender, {
      msgId: `handoff-failed-${payload.msgId}`,
      to: payload.from,
      conversationId: payload.conversationId,
      replyToMessageId: payload.msgId,
      text: JSON.stringify({ murmur: { result: "handoff-failed", reason: failure.reason, handoffMsgId: payload.msgId } }),
    });
  }

  /** Deliver the root request and then run the mesh to quiescence. */
  async run({ to, from = "human-agent", text, msgId = "root-1", conversationId = "conv-root" }) {
    this.queue.push({ kind: "ordinary", from, to, msgId, conversationId, text });
    let steps = 0;
    while (this.queue.length > 0) {
      if (++steps > 100) throw new Error("mesh-did-not-settle");
      const message = this.queue.shift();
      await this.agents.get(message.to).receive(message);
    }
    return this.wire;
  }

  of(kind) { return this.wire.filter((message) => message.kind === kind); }
  handoffs() { return this.of("handoff"); }
  replies() { return this.of("reply"); }

  close() { for (const agent of this.agents.values()) agent.close(); }
}

export const MEMBER_SLOTS = {
  claude: CLAUDE_AUTO_MEMBER_SLOT,
  codex: CODEX_APP_SERVER_MEMBER_SLOT,
  cursor: CURSOR_ACP_MEMBER_SLOT,
};

export const handoffAction = (to, task) => JSON.stringify({ murmur: { action: "handoff", to, task } });
