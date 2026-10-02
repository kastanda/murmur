/**
 * agent-handoff-runtime.mjs — the ONE place where handoff semantics meet the
 * autonomous runtimes.
 *
 * `HandoffTurnCoordinator` turns an inbound dispatch into a turn context (ordinary
 * inbound, inbound handoff task, or a continuation resume of a delegator) and
 * `settleRuntimeTurn` turns a terminal model result into exactly one durable
 * outcome: an ordinary correlated reply, a durably created child handoff with the
 * parent reply SUPPRESSED, or a fail-closed error.
 *
 * Claude, Codex and Cursor call the same two functions; the only runtime-specific
 * input is a small `resumeGuard` that answers "can I genuinely resume this exact
 * originating session right now?".
 */
import { HANDOFF_REASONS } from "@murmurv2/core";
import { HandoffRejection, composeContinuationPrompt } from "./agent-handoff-controller.mjs";
import { OUTPUT_KINDS, RuntimeOutputError, classifyRuntimeOutput } from "./runtime-output.mjs";
import {
  IGNORED_DUE_TO_CANCELLED_WORKFLOW, WORKFLOW_CANCELLED_REASON, isWorkflowCancelRequested,
} from "./workflow-control.mjs";

export { HandoffRejection };

/** Prompt frame for a bounded delegated task arriving as an inbound handoff. */
export const buildHandoffTaskPrompt = ({ handoff, payload }) => [
  "[MURMUR HANDOFF TASK]",
  `delegatedBy=${payload.from}`,
  `handoffMsgId=${payload.msgId}`,
  `rootMessageId=${handoff.rootMessageId}`,
  `activeDelegationPath=${handoff.ancestry.join(" -> ")}`,
  "This is one bounded delegated task. Your reply is returned to the delegator as the",
  "exact correlated result of this handoff.",
  "",
  "task:",
  String(payload.text || ""),
  "[END MURMUR HANDOFF TASK]",
].join("\n");

const joinPrompt = (...parts) => parts.filter((part) => typeof part === "string" && part.length > 0).join("\n\n");

export class HandoffTurnCoordinator {
  constructor({ controller, log = () => {}, now = () => Date.now() }) {
    if (!controller) throw new Error("handoff-coordinator-controller-required");
    Object.assign(this, { controller, log, now });
  }

  get agentId() { return this.controller.agentId; }

  classifyTerminal(resultText) { return this.controller.parse(resultText); }

  delegate(options) { return this.controller.delegate(options); }

  /**
   * Has the operator cancelled the root workflow this message belongs to? Reads the durable
   * intent from the SAME database the handoff store and dispatch queue live in.
   */
  isWorkflowCancelled(rootMessageId) {
    return isWorkflowCancelRequested(this.controller.store.db, rootMessageId);
  }

  /**
   * Is the workflow of an ALREADY-RECORDED inbound message cancelled? Used by durable reply
   * recovery (after a restart) so a stored result can never resurrect a cancelled workflow.
   * The root is derived exactly as `prepareTurn` does: the dispatch's own lineage, else the
   * continuation its `replyToMessageId` closes, else the message itself.
   */
  isInboundMessageWorkflowCancelled(inboundMessageId) {
    const db = this.controller.store.db;
    let payload = null;
    try {
      const row = db.prepare("SELECT payload_json AS json FROM wake_dispatch WHERE msg_id = ? LIMIT 1").get(inboundMessageId);
      payload = row?.json ? JSON.parse(row.json) : null;
    } catch {
      payload = null;
    }
    const candidate = payload?.replyToMessageId ? this.controller.store.get(payload.replyToMessageId) : null;
    return this.isWorkflowCancelled(this.rootOf(payload ?? { msgId: inboundMessageId }, candidate));
  }

  /** The root workflow a payload belongs to: continuation's root, inbound handoff's root, else itself. */
  rootOf(payload, candidate = null) {
    return candidate?.rootMessageId ?? payload?.handoff?.rootMessageId ?? payload?.msgId ?? null;
  }

  /**
   * Build the turn context for one claimed dispatch.
   *
   * A dispatch whose `replyToMessageId` is the exact msgId of one of OUR open handoffs
   * is a continuation: ownership is verified, the continuation is closed exactly once,
   * and the saved parent ACTIVE path is restored. Everything else is an ordinary turn
   * (a root request, an ordinary reply, or an inbound bounded handoff task).
   */
  prepareTurn({ payload, binding, runtimeKind, memberSlot, serverGeneration = null, serverIdentity = null,
    resumeGuard = null, fence = null, identity = null }) {
    const bindingContext = {
      bindingId: binding?.bindingId ?? null,
      runtimeGeneration: binding?.runtimeGeneration ?? null,
      runtimeKind,
      memberSlot,
      runtimeSessionId: binding?.runtimeSessionId ?? null,
      serverGeneration,
      serverIdentity,
    };

    const candidate = this.controller.matchChildReply(payload);

    // CANCELLATION GATE. Before any prompt is built or model started: a message of a
    // cancelled workflow — a queued root task, an inbound child task, or a late child
    // reply — is refused with a stable audit disposition. It stays in message history;
    // it never wakes, resumes or continues the workflow.
    const rootForGate = this.rootOf(payload, candidate);
    if (this.isWorkflowCancelled(rootForGate)) {
      if (candidate && candidate.state === "open") {
        this.controller.markContinuationTerminal({
          fence, identity, handoffMsgId: candidate.handoffMsgId, reason: WORKFLOW_CANCELLED_REASON,
        });
      }
      return {
        kind: candidate ? "continuation" : "ordinary",
        cancelledWorkflow: true,
        rejection: { reason: IGNORED_DUE_TO_CANCELLED_WORKFLOW, detail: rootForGate },
        continuation: candidate,
        binding: bindingContext,
        isHandoffInbound: false,
        resumeSessionId: null,
        parentActivePath: [],
        rootMessageId: rootForGate,
        rootConversationId: payload?.handoff?.rootConversationId ?? payload?.conversationId ?? null,
        causedByMessageId: payload.msgId,
        reply: { to: payload.from, conversationId: payload.conversationId, replyToMessageId: payload.msgId },
        promptText: null,
      };
    }
    if (candidate) {
      return this.prepareContinuation({ payload, candidate, bindingContext, runtimeKind, memberSlot,
        serverGeneration, serverIdentity, resumeGuard, fence, identity });
    }

    const inboundHandoff = payload?.handoff ?? null;
    const parentActivePath = inboundHandoff ? [...inboundHandoff.ancestry] : [];
    const instructions = this.controller.instructions({ activePath: parentActivePath });
    return {
      kind: "ordinary",
      isHandoffInbound: Boolean(inboundHandoff),
      rejection: null,
      continuation: null,
      resumeSessionId: null,
      binding: bindingContext,
      parentActivePath,
      rootMessageId: inboundHandoff ? inboundHandoff.rootMessageId : payload.msgId,
      rootConversationId: inboundHandoff ? inboundHandoff.rootConversationId : payload.conversationId,
      causedByMessageId: payload.msgId,
      reply: { to: payload.from, conversationId: payload.conversationId, replyToMessageId: payload.msgId },
      promptText: joinPrompt(
        instructions,
        inboundHandoff ? buildHandoffTaskPrompt({ handoff: inboundHandoff, payload }) : payload.text,
      ),
    };
  }

  prepareContinuation({ payload, candidate, bindingContext, runtimeKind, memberSlot, serverGeneration,
    serverIdentity, resumeGuard, fence, identity }) {
    const reject = (reason, detail = null, { markTerminal = true } = {}) => {
      // Terminalization is an authoritative mutation, so it goes through the SAME fenced
      // primitive: a stale generation cannot terminalize a continuation a replacement
      // runtime now owns.
      if (markTerminal) {
        const terminated = this.controller.markContinuationTerminal({
          fence, identity, handoffMsgId: candidate.handoffMsgId, reason,
        });
        if (terminated.ok !== true) {
          this.log("warn", "Stale generation could not terminalize continuation", {
            handoffMsgId: candidate.handoffMsgId, reason, refused: terminated.reason,
          });
        }
      }
      this.log("error", "Handoff continuation cannot be resumed", {
        handoffMsgId: candidate.handoffMsgId, childMessageId: payload.msgId, reason, detail,
      });
      return {
        kind: "continuation",
        rejection: { reason, detail },
        continuation: candidate,
        binding: bindingContext,
        isHandoffInbound: false,
        resumeSessionId: null,
        parentActivePath: candidate.parentActiveAncestry,
        rootMessageId: candidate.rootMessageId,
        rootConversationId: candidate.rootConversationId,
        causedByMessageId: payload.msgId,
        reply: {
          to: candidate.parentSenderId,
          conversationId: candidate.parentConversationId,
          replyToMessageId: candidate.parentMessageId,
        },
        promptText: null,
      };
    };

    // Exact correlation: only the expected delegation target may close this handoff.
    if (candidate.recipientId !== payload.from) {
      return reject(HANDOFF_REASONS.continuationSenderMismatch, payload.from, { markTerminal: false });
    }
    // SESSION ISOLATION: the result must arrive in the persisted DERIVED handoff
    // conversation. A reply with the exact msgId and the expected sender but a different
    // conversation must not close, resume, mutate or answer anything — the continuation
    // stays OPEN for the real result. (The root conversation is never used here.)
    if (candidate.handoffConversationId !== payload.conversationId) {
      return reject(HANDOFF_REASONS.continuationConversationMismatch, payload.conversationId, { markTerminal: false });
    }
    // The resuming runtime must be the same kind/slot that originated the delegation.
    if (candidate.originatingRuntimeKind !== runtimeKind || candidate.originatingMemberSlot !== memberSlot) {
      return reject(HANDOFF_REASONS.continuationRuntimeMismatch, `${candidate.originatingRuntimeKind}/${candidate.originatingMemberSlot}`);
    }
    if (candidate.state === "terminal") {
      return reject(HANDOFF_REASONS.continuationTerminal, candidate.terminalReason, { markTerminal: false });
    }
    // Runtime-specific: can this exact originating session genuinely be resumed?
    if (typeof resumeGuard === "function") {
      const verdict = resumeGuard({ continuation: candidate, binding: bindingContext, serverGeneration, serverIdentity }) || {};
      if (verdict.ok !== true) {
        return reject(verdict.reason || HANDOFF_REASONS.continuationSessionUnavailable, verdict.detail ?? null);
      }
    }

    // FENCED CAS: the binding fence re-read, the exact-correlation checks and the
    // open -> closed transition all commit in ONE transaction, so a generation that lost
    // its fence between the dispatch assignment and here cannot consume the one-shot.
    const closed = this.controller.closeContinuation({
      fence,
      identity,
      handoffMsgId: candidate.handoffMsgId,
      replySenderId: payload.from,
      replyConversationId: payload.conversationId,
      closedByMessageId: payload.msgId,
    });
    if (closed.ok === false) {
      return reject(closed.reason || HANDOFF_REASONS.continuationStaleBinding, "fenced-close-lost", { markTerminal: false });
    }
    if (!closed.closed && !closed.replay) {
      // A DISTINCT second reply must never resume the runtime again.
      this.log("warn", "Handoff continuation close refused", {
        handoffMsgId: candidate.handoffMsgId, childMessageId: payload.msgId, reason: closed.reason,
      });
      return reject(closed.reason || HANDOFF_REASONS.continuationAlreadyClosed, payload.msgId, { markTerminal: false });
    }
    const continuation = closed.handoff;
    this.log("info", closed.replay ? "Handoff continuation resumed (same-message replay)" : "Handoff continuation closed once", {
      handoffMsgId: continuation.handoffMsgId,
      childMessageId: payload.msgId,
      restoredActivePath: continuation.parentActiveAncestry,
    });
    const instructions = this.controller.instructions({ activePath: continuation.parentActiveAncestry });
    return {
      kind: "continuation",
      rejection: null,
      continuation,
      replay: closed.replay === true,
      isHandoffInbound: false,
      resumeSessionId: continuation.originatingRuntimeSessionId,
      binding: bindingContext,
      // The completed child branch is NOT part of the restored ACTIVE path, so a sibling
      // delegation afterwards is not a cycle.
      parentActivePath: continuation.parentActiveAncestry,
      rootMessageId: continuation.rootMessageId,
      rootConversationId: continuation.rootConversationId,
      causedByMessageId: payload.msgId,
      reply: {
        to: continuation.parentSenderId,
        conversationId: continuation.parentConversationId,
        replyToMessageId: continuation.parentMessageId,
      },
      promptText: joinPrompt(instructions, composeContinuationPrompt({
        childAgentId: continuation.recipientId,
        task: continuation.taskText,
        resultText: payload.text,
        handoffMsgId: continuation.handoffMsgId,
        childMessageId: payload.msgId,
      })),
    };
  }

  /**
   * Fail closed on a turn that cannot safely run: the dispatch is retired (no silent
   * retry into an unrelated model session) and the binding returns to idle.
   */
  failClosedTurn({ turn, dispatch, dispatchStore, bindingStore, fence, identity }) {
    const reason = turn.rejection.reason;
    bindingStore.releaseAssignment(fence, identity, {
      state: "terminal",
      reason,
      nextAttemptAt: this.now(),
    }, this.now());
    this.log(turn.cancelledWorkflow ? "warn" : "error", turn.cancelledWorkflow
      ? "Message of a cancelled workflow ignored" : "Handoff turn rejected before model execution", {
      msgId: dispatch?.msgId ?? identity.msgId,
      memberSlot: identity.memberSlot,
      reason,
      detail: turn.rejection.detail ?? null,
    });
    return { status: "rejected", reason, detail: turn.rejection.detail ?? null };
  }
}

/**
 * Durable terminal settlement shared by every autonomous runtime.
 *
 * Without a coordinator this is byte-for-byte the pre-handoff behaviour: record the
 * completed receipt, send the correlated reply, return to idle.
 */
export const settleRuntimeTurn = async ({
  runtimeKind, dispatchStore, bindingStore, fence, identity, attempt,
  payload, turn = null, coordinator = null, resultText, sessionId = null,
  extraMetadata = {}, runtimeSession = {}, sendReply, log = () => {}, now = () => Date.now(),
}) => {
  const target = turn?.reply ?? {
    to: payload.from,
    conversationId: payload.conversationId,
    replyToMessageId: payload.msgId,
  };

  // A workflow cancelled while this turn ran: the result is kept in the receipt for audit
  // but is neither delivered nor allowed to delegate (no resurrection, no fake reply).
  if (coordinator && turn && coordinator.isWorkflowCancelled(turn.rootMessageId)) {
    dispatchStore.recordProcessingReceipt({
      ...attempt,
      status: "completed",
      sessionId,
      metadata: { ...extraMetadata, disposition: IGNORED_DUE_TO_CANCELLED_WORKFLOW, resultText },
    }, now());
    dispatchStore.markHandedOffIfLatestAttemptCompleted(identity, attempt.attemptId, now());
    log("warn", "Turn result suppressed: workflow cancelled by the operator", { msgId: payload.msgId });
    if (!bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
    if (bindingStore.markIdle(fence, now()) !== 1) return { status: "late-result-dropped" };
    return { status: "completed-cancelled-workflow", attemptId: attempt.attemptId, reply: null };
  }

  // NOTHING non-substantive may become a result. An empty output, or a delegation/tool intent that
  // is not the exact control frame (e.g. fenced), is a runtime FAILURE: it is never relayed to the
  // delegator or the root as an answer, and the dispatch retry budget then ends in a clear reason.
  const verdict = classifyRuntimeOutput({ text: resultText });
  if (verdict.kind === OUTPUT_KINDS.empty || verdict.kind === OUTPUT_KINDS.toolIntentOnly) {
    throw new RuntimeOutputError(runtimeKind, verdict.kind, verdict.reason, { msgId: payload?.msgId ? String(payload.msgId).slice(0, 12) : null });
  }

  const action = coordinator && turn ? coordinator.classifyTerminal(resultText) : { kind: "none" };
  if (action.kind === "invalid") {
    // A frame that clearly claims `murmur.action` is NEVER downgraded into an ordinary reply.
    throw new HandoffRejection(action.reason, action.detail);
  }

  if (action.kind === "handoff") {
    // A stale runtime generation may not create a handoff. The authoritative check is
    // NOT this pre-check — it is the fenced transaction inside `delegate`, which commits
    // the fence re-read, the continuation row and the outbound outbox row together. This
    // early return only avoids pointless work.
    if (!bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
    let delegated;
    try {
      delegated = await coordinator.delegate({
        to: action.to,
        task: action.task,
        turn: { ...turn, binding: { ...turn.binding, ...runtimeSession } },
        fence,
        identity,
      });
    } catch (error) {
      // Losing the fence inside the transaction is not a model failure: nothing was
      // created and a live generation owns the work now.
      if (error instanceof HandoffRejection && error.reason === WORKFLOW_CANCELLED_REASON) {
        // The intent landed between the check above and the fenced create: nothing was created.
        log("warn", "Handoff creation refused: workflow cancelled by the operator", { msgId: payload.msgId });
        dispatchStore.recordProcessingReceipt({
          ...attempt, status: "completed", sessionId,
          metadata: { ...extraMetadata, disposition: IGNORED_DUE_TO_CANCELLED_WORKFLOW, resultText },
        }, now());
        dispatchStore.markHandedOffIfLatestAttemptCompleted(identity, attempt.attemptId, now());
        if (!bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
        if (bindingStore.markIdle(fence, now()) !== 1) return { status: "late-result-dropped" };
        return { status: "completed-cancelled-workflow", attemptId: attempt.attemptId, reply: null };
      }
      if (error instanceof HandoffRejection && error.reason === HANDOFF_REASONS.continuationStaleBinding) {
        log("warn", "Handoff creation refused: runtime generation is stale", {
          msgId: payload.msgId, detail: error.detail ?? null,
        });
        return { status: "late-result-dropped" };
      }
      throw error;
    }
    const { continuation, created } = delegated;
    // NOTE: the completed receipt deliberately carries NO reply correlation, so durable
    // reply recovery can never manufacture a parent reply for a delegated turn.
    const receipt = dispatchStore.recordProcessingReceipt({
      ...attempt,
      status: "completed",
      sessionId,
      metadata: {
        ...extraMetadata,
        disposition: "handoff",
        resultText,
        handoffMsgId: continuation.handoffMsgId,
        handoffRecipient: continuation.recipientId,
      },
    }, now());
    if (!receipt.accepted) throw new Error(`${runtimeKind}-completion-rejected:${receipt.reason}`);
    dispatchStore.markHandedOffIfLatestAttemptCompleted(identity, attempt.attemptId, now());
    log("info", "Parent reply suppressed: bounded work delegated", {
      msgId: payload.msgId,
      handoffMsgId: continuation.handoffMsgId,
      to: continuation.recipientId,
      reused: created === false,
    });
    if (!bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
    if (bindingStore.markIdle(fence, now()) !== 1) return { status: "late-result-dropped" };
    return {
      status: "completed-handoff",
      attemptId: attempt.attemptId,
      handoffMsgId: continuation.handoffMsgId,
      handoffCreated: created,
      reply: null,
    };
  }

  const receipt = dispatchStore.recordProcessingReceipt({
    ...attempt,
    status: "completed",
    sessionId,
    metadata: {
      ...extraMetadata,
      resultText,
      conversationId: target.conversationId,
      recipient: target.to,
      replyToMessageId: target.replyToMessageId,
    },
  }, now());
  if (!receipt.accepted) throw new Error(`${runtimeKind}-completion-rejected:${receipt.reason}`);
  dispatchStore.markHandedOffIfLatestAttemptCompleted(identity, attempt.attemptId, now());
  let reply = null;
  // Re-check immediately before the reply is enqueued: a cancel that committed after the check
  // at the top of this function (but before this point) still wins and the reply is withheld.
  const cancelledBeforeSend = Boolean(coordinator && turn && coordinator.isWorkflowCancelled(turn.rootMessageId));
  if (cancelledBeforeSend) log("warn", "Reply withheld: workflow cancelled by the operator", { msgId: payload.msgId });
  if (!cancelledBeforeSend && bindingStore.validateFence(fence, identity)) {
    try {
      reply = await sendReply({
        msgId: attempt.attemptId,
        to: target.to,
        conversationId: target.conversationId,
        replyToMessageId: target.replyToMessageId,
        text: resultText,
      });
      dispatchStore.recordProcessingReceipt({ ...attempt, status: "completed", sessionId, resultMessageId: reply.msgId }, now());
    } catch (error) {
      log("error", `${runtimeKind} reply enqueue failed after durable completion`, {
        msgId: payload.msgId,
        attemptId: attempt.attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!bindingStore.validateFence(fence, identity)) return { status: "late-result-dropped" };
  if (bindingStore.markIdle(fence, now()) !== 1) return { status: "late-result-dropped" };
  if (cancelledBeforeSend) return { status: "completed-cancelled-workflow", attemptId: attempt.attemptId, reply: null };
  return { status: reply ? "completed" : "completed-reply-pending", attemptId: attempt.attemptId, reply };
};
