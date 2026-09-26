/**
 * agent-handoff-controller.mjs — the single authority for explicit agent handoff.
 *
 * Responsibilities: strict terminal action parsing, action schema validation,
 * authorization/capability validation, ACTIVE ancestry validation, loop/depth guards,
 * idempotent handoff creation/reuse, derived conversation generation, continuation
 * persistence, exact reply resolution, continuation CAS close and stable reason codes.
 *
 * Transport and runtime-session specifics stay OUT of here: envelope creation/outbox
 * enqueue arrive through the injected `sendHandoff`, and per-runtime resume rules
 * arrive through the coordinator's `resumeGuard` (see agent-handoff-runtime.mjs).
 */
import { randomUUID } from "node:crypto";
import {
  HANDOFF_FEATURE_V1,
  HANDOFF_MAX_ACTIVE_DEPTH,
  HANDOFF_REASONS,
  HANDOFF_WIRE_VERSION,
  buildHandoffAncestry,
  derivedHandoffConversationId,
  peerSupportsHandoffV1,
  validateHandoffEnvelope,
  validateHandoffLineage,
} from "@murmurv2/core";

export { HANDOFF_FEATURE_V1, HANDOFF_MAX_ACTIVE_DEPTH, HANDOFF_REASONS, HANDOFF_WIRE_VERSION };

/**
 * What THIS build advertises to peers. A peer entry without these fields cannot
 * receive a handoff (fail closed), which is exactly the behaviour for peers paired
 * before handoff existed.
 */
export const localHandoffCapabilities = () => ({
  protocolVersions: ["1.0", HANDOFF_WIRE_VERSION],
  features: [HANDOFF_FEATURE_V1],
});

/** Copy only the capability fields a peer advertised (absent stays absent). */
export const peerCapabilityFields = (advertised = {}) => ({
  ...(Array.isArray(advertised.protocolVersions) ? { protocolVersions: [...advertised.protocolVersions] } : {}),
  ...(Array.isArray(advertised.features) ? { features: [...advertised.features] } : {}),
});

/** Maximum bounded-task size a model may delegate (bytes of UTF-8). */
export const HANDOFF_MAX_TASK_BYTES = 16 * 1024;

/** A deterministic, machine-readable handoff refusal. Never downgraded to a model reply. */
export class HandoffRejection extends Error {
  constructor(reason, detail = null) {
    super(detail ? `${reason}:${detail}` : reason);
    this.name = "HandoffRejection";
    this.reason = reason;
    this.detail = detail;
  }
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The RESERVED MURMUR CONTROL-FRAME GRAMMAR.
 *
 * A terminal model result has entered the reserved grammar when — and only when — its
 * trimmed text begins with an object whose FIRST key is exactly `"murmur"`:
 *
 *     ^\{ \s* "murmur" \s* :
 *
 * That is the whole boundary. It is a fixed prefix on the trimmed output: no prose
 * scanning, no keyword search, no JSON extraction from surrounding text, and no
 * heuristics. `{"murmur":` is a reserved namespace a model may not use for ordinary
 * answers, exactly as documented in the runtime instruction block.
 *
 * Once inside the reserved grammar the output MUST be a complete, exactly-shaped
 * handoff action; anything else is a terminal action error (FAIL CLOSED) and is never
 * relayed as an ordinary parent reply.
 */
const RESERVED_CONTROL_FRAME = /^\{\s*"murmur"\s*:/;

/** True when a terminal result claims the reserved Murmur control-frame namespace. */
export const entersReservedControlFrame = (text) =>
  typeof text === "string" && RESERVED_CONTROL_FRAME.test(text.trim());

/**
 * STRICT terminal action parsing. Three — and only three — outcomes:
 *
 * 1. `{ kind: "none" }`    ordinary model result. Free-form prose, and any complete
 *                          JSON object that does not carry the `murmur.action`
 *                          discriminator, stay ordinary.
 * 2. `{ kind: "handoff" }` the exact valid action frame.
 * 3. `{ kind: "invalid" }` FAIL CLOSED. The output entered the reserved control-frame
 *                          grammar (or carries `murmur.action`) but is not an exact
 *                          valid handoff action — including truncated or unparseable
 *                          reserved frames, which must NEVER fall through to an
 *                          ordinary parent reply.
 *
 * There is no heuristic prose detection, no "contains JSON somewhere", and no
 * markdown-fence extraction.
 */
export const parseHandoffAction = (text, { maxTaskBytes = HANDOFF_MAX_TASK_BYTES } = {}) => {
  if (typeof text !== "string") return { kind: "none" };
  const trimmed = text.trim();
  const reserved = RESERVED_CONTROL_FRAME.test(trimmed);
  const malformedReserved = (detail) => (reserved
    ? { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail }
    : { kind: "none" });

  // A reserved frame must be ONE complete JSON object. A truncated or unparseable one
  // fails closed instead of being relayed as prose (the fail-open this closes).
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return malformedReserved("control-frame-incomplete");
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return malformedReserved("control-frame-unparseable");
  }
  if (!isPlainObject(parsed)) return malformedReserved("control-frame-not-an-object");
  if (!("murmur" in parsed)) return malformedReserved("control-frame-missing-namespace");
  const frame = parsed.murmur;
  // Inside the reserved namespace the value must be a control object carrying `action`.
  // Outside it, a `murmur` key without `murmur.action` (e.g. a system `murmur.result`
  // frame nested in a larger object) stays an ordinary result.
  if (!isPlainObject(frame)) return malformedReserved("murmur-not-an-object");
  if (!("action" in frame)) return malformedReserved("control-frame-missing-action");
  if (frame.action !== "handoff") {
    return { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail: `unsupported-action:${String(frame.action)}` };
  }
  if (Object.keys(parsed).length !== 1) {
    return { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail: "unexpected-top-level-keys" };
  }
  const extra = Object.keys(frame).filter((key) => !["action", "to", "task"].includes(key));
  if (extra.length > 0) {
    return { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail: `unexpected-fields:${extra.sort().join(",")}` };
  }
  if (typeof frame.to !== "string" || !frame.to.trim()) {
    return { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail: "to-required" };
  }
  if (typeof frame.task !== "string" || !frame.task.trim()) {
    return { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail: "task-required" };
  }
  if (Buffer.byteLength(frame.task, "utf8") > maxTaskBytes) {
    return { kind: "invalid", reason: HANDOFF_REASONS.actionMalformed, detail: "task-too-large" };
  }
  return { kind: "handoff", to: frame.to.trim(), task: frame.task };
};

/** The exact control-frame contract handed to every autonomous runtime. */
export const buildHandoffInstructions = ({ agentId, targets = [], maxDepth = HANDOFF_MAX_ACTIVE_DEPTH, activePath = [] }) => {
  if (targets.length === 0) return "";
  return [
    "[MURMUR HANDOFF PROTOCOL]",
    `You are Murmur agent "${agentId}".`,
    "You may delegate ONE bounded piece of work to exactly one paired agent and wait for its result.",
    `Delegation targets available to you right now: ${targets.join(", ")}.`,
    ...(activePath.length > 0 ? [`Active delegation path already in flight: ${activePath.join(" -> ")}.`] : []),
    `Maximum active delegation depth: ${maxDepth}.`,
    "To delegate, your ENTIRE final answer must be exactly this JSON object and nothing else:",
    '{"murmur":{"action":"handoff","to":"<agent-id>","task":"<bounded task>"}}',
    "Rules:",
    '- `{"murmur":` at the start of your answer is a RESERVED control namespace. Use it only for',
    "  a complete, exactly-shaped handoff action. An answer that starts with it and is anything",
    "  else — truncated, extra keys, extra prose after it, a different action — is a terminal",
    "  error: it is NOT delivered to anyone as your answer. If you want to talk about a frame,",
    "  do not start your answer with it.",
    "- No prose, no markdown fence, no extra keys: a malformed handoff frame is rejected, not retried as prose.",
    "- You choose only the target agent id and the task text. Murmur owns routing, ids, lineage and signatures.",
    "- Never delegate to yourself and never to an agent already on the active delegation path.",
    "- When the delegated result comes back you will be resumed with it and may then answer normally,",
    "  or delegate one further bounded task.",
    "- Otherwise answer normally in plain text; ordinary answers are relayed as your reply.",
    "[END MURMUR HANDOFF PROTOCOL]",
  ].join("\n");
};

/** The frame a delegator's resumed turn receives carrying the exact correlated child result. */
export const composeContinuationPrompt = ({ childAgentId, task, resultText, handoffMsgId, childMessageId }) => [
  "[MURMUR HANDOFF RESULT]",
  `delegatedTo=${childAgentId}`,
  `handoffMsgId=${handoffMsgId}`,
  `resultMessageId=${childMessageId}`,
  "delegatedTask:",
  String(task || ""),
  "",
  "result:",
  String(resultText || ""),
  "",
  "[END MURMUR HANDOFF RESULT]",
  "Continue the original request using this result.",
].join("\n");

/**
 * Receiver-side admission for an ALREADY AUTHENTICATED inbound handoff envelope.
 *
 * This closes the wrong-recipient gap and every deterministic lineage/loop/depth rule
 * BEFORE any runtime executes. It is deliberately a pure function so the daemon and the
 * tests share one implementation.
 *
 * Callers MUST have verified the signature first: a structurally malformed 1.1 envelope
 * has no canonical form, cannot be authenticated, and therefore gets no correlated reply.
 */
export const admitInboundHandoff = ({
  envelope,
  localAgentId,
  maxDepth = HANDOFF_MAX_ACTIVE_DEPTH,
  hasAutonomousRuntime = false,
}) => {
  const violations = validateHandoffEnvelope(envelope, { localAgentId, maxDepth });
  if (violations.length > 0) {
    return {
      ok: false,
      reason: violations[0],
      detail: violations.length > 1 ? violations.slice(1).join(",") : null,
    };
  }
  // HANDOFF ONLY: no fallback to a legacy wake hook, a stateless inbox or an
  // interactive drain. Without an exact autonomous runtime the delegation is refused.
  if (!hasAutonomousRuntime) {
    return { ok: false, reason: HANDOFF_REASONS.runtimeUnavailable, detail: null };
  }
  return { ok: true, reason: null, detail: null };
};

/** The exact correlated system failure a receiver returns for a deterministic rejection. */
export const buildHandoffFailureText = ({ reason, detail = null, handoffMsgId }) =>
  JSON.stringify({
    murmur: {
      result: "handoff-failed",
      reason,
      ...(detail ? { detail } : {}),
      handoffMsgId,
    },
  });

export class AgentHandoffController {
  constructor({
    store,
    agentId,
    peers = {},
    maxDepth = HANDOFF_MAX_ACTIVE_DEPTH,
    maxTaskBytes = HANDOFF_MAX_TASK_BYTES,
    buildHandoffEnvelope,
    recordHandoffAudit = null,
    now = () => Date.now(),
    newMsgId = () => randomUUID(),
    log = () => {},
  }) {
    if (!store) throw new Error("agent-handoff-controller-store-required");
    if (typeof agentId !== "string" || !agentId) throw new Error("agent-handoff-controller-agent-id-required");
    if (typeof buildHandoffEnvelope !== "function") throw new Error("agent-handoff-controller-build-required");
    Object.assign(this, {
      store, agentId, peers, maxDepth, maxTaskBytes, buildHandoffEnvelope,
      recordHandoffAudit, now, newMsgId, log,
    });
  }

  /**
   * Paired peers that explicitly advertise the 1.1 wire version and `handoff-v1` AND
   * are actually usable as a target (pairing keys + a configured subject). Advertising
   * a target the controller would then refuse is itself a fail-open, so this reuses
   * exactly the same resolution the delegation path uses.
   */
  handoffTargets() {
    return Object.keys(this.peers || {})
      .filter((peerId) => peerId !== this.agentId && !this.resolveTarget(peerId).reason)
      .sort();
  }

  instructions({ activePath = [] } = {}) {
    return buildHandoffInstructions({
      agentId: this.agentId,
      targets: this.handoffTargets(),
      maxDepth: this.maxDepth,
      activePath,
    });
  }

  parse(text) {
    return parseHandoffAction(text, { maxTaskBytes: this.maxTaskBytes });
  }

  /**
   * Fail-closed target resolution. The transport subject comes ONLY from the paired
   * peer config: a model can never supply an arbitrary NATS subject.
   */
  resolveTarget(to) {
    if (typeof to !== "string" || !to.trim()) return { reason: HANDOFF_REASONS.targetUnknown };
    const peerId = to.trim();
    const peer = this.peers?.[peerId];
    if (!peer) return { reason: HANDOFF_REASONS.targetUnknown, detail: peerId };
    if (!peer.signing?.publicKey || !peer.encryption?.publicKey) {
      return { reason: HANDOFF_REASONS.targetUnpaired, detail: peerId };
    }
    if (!peerSupportsHandoffV1(peer)) {
      return { reason: HANDOFF_REASONS.targetCapabilityMissing, detail: peerId };
    }
    if (typeof peer.subject !== "string" || !peer.subject.trim()) {
      return { reason: HANDOFF_REASONS.targetSubjectMissing, detail: peerId };
    }
    return { agentId: peerId, subject: peer.subject };
  }

  /** Deterministic ACTIVE-ancestry / loop / depth validation for a NEW delegation. */
  planDelegation({ to, parentActivePath = [] }) {
    const target = this.resolveTarget(to);
    if (target.reason) return target;
    if (target.agentId === this.agentId) return { reason: HANDOFF_REASONS.self, detail: target.agentId };
    const built = buildHandoffAncestry(parentActivePath, this.agentId);
    if (built.reason) {
      const rendered = Array.isArray(parentActivePath) ? parentActivePath.join(",") : String(parentActivePath);
      return { reason: built.reason, detail: `active-path:${rendered}` };
    }
    if (built.ancestry.includes(target.agentId)) {
      return { reason: HANDOFF_REASONS.cycle, detail: target.agentId };
    }
    if (built.ancestry.length > this.maxDepth) {
      return { reason: HANDOFF_REASONS.depthExceeded, detail: String(built.ancestry.length) };
    }
    return { target, ancestry: built.ancestry };
  }

  /**
   * Durably create (or reuse) one bounded child handoff and enqueue its signed 1.1
   * envelope. Durable-first: the continuation row is written before the envelope is
   * enqueued, and a replay of the same causative message reuses the existing
   * handoff msgId instead of delegating twice.
   */
  async delegate({ to, task, turn, fence, identity = null }) {
    if (!fence?.bindingId) throw new HandoffRejection(HANDOFF_REASONS.continuationStaleBinding, "fence-required");
    const plan = this.planDelegation({ to, parentActivePath: turn.parentActivePath });
    if (plan.reason) throw new HandoffRejection(plan.reason, plan.detail);
    const { target, ancestry } = plan;

    const existing = this.store.findByCause(this.agentId, turn.causedByMessageId);
    const handoffMsgId = existing?.handoffMsgId ?? this.newMsgId();
    const handoffConversationId = existing?.handoffConversationId ?? derivedHandoffConversationId(handoffMsgId);
    const handoff = {
      rootMessageId: turn.rootMessageId,
      rootConversationId: turn.rootConversationId,
      causedByMessageId: turn.causedByMessageId,
      ancestry: existing ? existing.handoffAncestry : ancestry,
    };
    const lineageViolations = validateHandoffLineage(handoff, {
      senderAgentId: this.agentId,
      recipientAgentId: existing?.recipientId ?? target.agentId,
      maxDepth: this.maxDepth,
    });
    if (lineageViolations.length > 0) throw new HandoffRejection(lineageViolations[0], "self-check");

    if (existing && existing.recipientId !== target.agentId) {
      // The same causative turn already delegated elsewhere: one child per turn.
      throw new HandoffRejection(HANDOFF_REASONS.actionMalformed, "one-handoff-per-causative-message");
    }

    const record = {
      handoffMsgId,
      delegatorId: this.agentId,
      recipientId: target.agentId,
      causedByMessageId: turn.causedByMessageId,
      rootMessageId: turn.rootMessageId,
      rootConversationId: turn.rootConversationId,
      handoffConversationId,
      parentActiveAncestry: turn.parentActivePath,
      handoffAncestry: handoff.ancestry,
      originatingBindingId: turn.binding.bindingId,
      originatingBindingGeneration: turn.binding.runtimeGeneration,
      originatingRuntimeKind: turn.binding.runtimeKind,
      originatingMemberSlot: turn.binding.memberSlot,
      originatingRuntimeSessionId: turn.binding.runtimeSessionId ?? null,
      originatingServerGeneration: turn.binding.serverGeneration ?? null,
      originatingServerIdentity: turn.binding.serverIdentity ?? null,
      parentMessageId: turn.reply.replyToMessageId,
      parentConversationId: turn.reply.conversationId,
      parentSenderId: turn.reply.to,
      taskText: existing ? existing.taskText : task,
    };

    // Build and SIGN the envelope before opening the durable transaction: signing is
    // async and must never run inside a SQLite write lock. Nothing is persisted yet, so
    // a failure here leaves no continuation and no outbox row at all.
    // A reused row keeps its original task text and lineage, so the rebuilt envelope is
    // byte-stable: msgId, conversation and lineage all come from the persisted row.
    const outbox = await this.buildHandoffEnvelope({
      msgId: record.handoffMsgId,
      to: record.recipientId,
      subject: target.subject,
      conversationId: record.handoffConversationId,
      handoff: {
        rootMessageId: record.rootMessageId,
        rootConversationId: record.rootConversationId,
        causedByMessageId: record.causedByMessageId,
        ancestry: record.handoffAncestry,
      },
      text: record.taskText,
    });
    if (!outbox?.envelope || !outbox?.subject) throw new Error("handoff-envelope-build-invalid");

    // ONE fenced transaction: binding fence re-read + continuation + outbox row.
    // A stale generation commits nothing.
    const committed = this.store.fencedCreate({ fence, identity, record, outbox }, this.now());
    if (!committed.ok) throw new HandoffRejection(committed.reason, "fenced-create-lost");
    const continuation = committed.handoff;
    const created = committed.created;

    // Non-authoritative audit mirror, deliberately AFTER the durable commit so it can
    // never be the reason a handoff fails. It is idempotent on replay.
    if (typeof this.recordHandoffAudit === "function") {
      try {
        await this.recordHandoffAudit({ continuation, envelope: outbox.envelope });
      } catch (error) {
        this.log("error", "Handoff audit mirror failed after durable commit", {
          handoffMsgId: continuation.handoffMsgId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.log("info", created ? "Handoff created" : "Handoff reused (idempotent replay)", {
      handoffMsgId: continuation.handoffMsgId,
      to: continuation.recipientId,
      rootMessageId: continuation.rootMessageId,
      causedByMessageId: continuation.causedByMessageId,
      ancestry: continuation.handoffAncestry,
    });
    return { continuation, created, sent: { msgId: continuation.handoffMsgId } };
  }

  /** Re-enqueue handoffs whose continuation was written but whose envelope never landed. */
  async recoverPendingEnqueues() {
    const recovered = [];
    for (const row of this.store.pendingEnqueue()) {
      if (row.delegatorId !== this.agentId) continue;
      const target = this.resolveTarget(row.recipientId);
      if (target.reason) {
        this.store.markTerminal({ handoffMsgId: row.handoffMsgId, reason: target.reason }, this.now());
        this.log("error", "Pending handoff cannot be recovered", {
          handoffMsgId: row.handoffMsgId, to: row.recipientId, reason: target.reason,
        });
        continue;
      }
      const outbox = await this.buildHandoffEnvelope({
        msgId: row.handoffMsgId,
        to: row.recipientId,
        subject: target.subject,
        conversationId: row.handoffConversationId,
        handoff: {
          rootMessageId: row.rootMessageId,
          rootConversationId: row.rootConversationId,
          causedByMessageId: row.causedByMessageId,
          ancestry: row.handoffAncestry,
        },
        text: row.taskText,
      });
      // The continuation is ALREADY committed, so this claims no new authority and needs
      // no fence: it only re-inserts the idempotent outbox row that belongs to it.
      this.store.transact(() => {
        this.store.applyOutboxEnqueue(outbox, this.now());
        this.store.markEnqueued(row.handoffMsgId, this.now());
      });
      recovered.push(row.handoffMsgId);
      this.log("warn", "Recovered handoff envelope never enqueued", { handoffMsgId: row.handoffMsgId });
    }
    return recovered;
  }

  /**
   * Candidate LOOKUP only — never authority. A child result correlates by the exact
   * `replyToMessageId === handoff_msg_id`; the expected recipient identity and the
   * persisted DERIVED handoff conversation are then required by the fenced CAS in
   * {@link closeContinuation}, which is where the decision actually commits.
   *
   * A conversation id still never *finds* a continuation — only the exact msgId does.
   */
  matchChildReply(payload) {
    const replyTo = payload?.replyToMessageId;
    if (typeof replyTo !== "string" || !replyTo) return null;
    const row = this.store.get(replyTo);
    if (!row || row.delegatorId !== this.agentId) return null;
    return row;
  }

  /**
   * FENCED continuation CAS close. One-shot: a distinct second reply can never resume
   * again, a reply from the wrong sender or the wrong derived conversation closes
   * nothing, and a stale runtime generation loses the CAS atomically.
   */
  closeContinuation({ fence, identity = null, handoffMsgId, replySenderId, replyConversationId, closedByMessageId }) {
    return this.store.fencedClose({
      fence, identity, handoffMsgId, replySenderId, replyConversationId, closedByMessageId,
    }, this.now());
  }

  /** FENCED terminalization: a stale generation cannot reject someone else's continuation. */
  markContinuationTerminal({ fence, identity = null, handoffMsgId, reason }) {
    return this.store.fencedTerminate({ fence, identity, handoffMsgId, reason }, this.now());
  }
}
