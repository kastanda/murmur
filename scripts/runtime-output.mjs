/**
 * runtime-output.mjs — what a runtime's terminal output IS, before anything may treat it as a result.
 *
 * A model process that exits 0 has not necessarily produced an answer. Observed live: `claude -p`
 * exiting 0 with `is_error: true` and an API error sentence as its "result"; with an empty
 * result; or ending on a tool-use turn whose only content is an intent. None of those may ever
 * be delivered as a final root reply, and none may satisfy a review gate.
 *
 *   text              substantive prose — the only kind that can be a final result
 *   handoff           an exact terminal `{"murmur": …}` control frame (the controller validates it)
 *   tool-intent-only  an intent that is not a result: the runtime stopped on tool use, or the whole
 *                     output is a fenced/wrapped delegation frame rather than the exact frame
 *   empty             no usable text at all (empty or whitespace-only)
 *   error             the runtime itself reported failure while exiting normally
 *
 * Pure and deterministic: no model call, no heuristics beyond the shapes above.
 */
import { redactSecrets } from "./notify-activity.mjs";

export const OUTPUT_KINDS = Object.freeze({
  text: "text",
  handoff: "handoff",
  toolIntentOnly: "tool-intent-only",
  empty: "empty",
  error: "error",
});

export const OUTPUT_REASONS = Object.freeze({
  empty: "empty-output",
  toolIntentOnly: "tool-intent-only",
  runtimeError: "runtime-reported-error",
});

const CONTROL_FRAME_PREFIX = /^\{\s*"murmur"\s*:/;
const FENCE = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/;
const TOOL_MARKUP = /^\s*<(?:function_calls|invoke|tool_use|antml:function_calls)\b[\s\S]*>\s*$/i;

/**
 * @param {{ text?: unknown, stopReason?: string|null, isError?: boolean }} output
 * @returns {{ kind: string, reason: string|null }}
 */
export const classifyRuntimeOutput = ({ text, stopReason = null, isError = false } = {}) => {
  if (isError === true) return { kind: OUTPUT_KINDS.error, reason: OUTPUT_REASONS.runtimeError };
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) return { kind: OUTPUT_KINDS.empty, reason: OUTPUT_REASONS.empty };
  // The runtime stopped because it wanted to call a tool: whatever text precedes that is not the answer.
  if (stopReason === "tool_use") return { kind: OUTPUT_KINDS.toolIntentOnly, reason: OUTPUT_REASONS.toolIntentOnly };
  if (CONTROL_FRAME_PREFIX.test(body)) return { kind: OUTPUT_KINDS.handoff, reason: null };
  // A delegation frame wrapped in a code fence (or any tool-call markup) is an INTENT, never a result.
  const fenced = body.match(FENCE);
  if (fenced && CONTROL_FRAME_PREFIX.test(fenced[1].trim())) return { kind: OUTPUT_KINDS.toolIntentOnly, reason: OUTPUT_REASONS.toolIntentOnly };
  if (TOOL_MARKUP.test(body)) return { kind: OUTPUT_KINDS.toolIntentOnly, reason: OUTPUT_REASONS.toolIntentOnly };
  return { kind: OUTPUT_KINDS.text, reason: null };
};

/** Only substantive prose can be a final result. */
export const isSubstantiveResult = (output) => classifyRuntimeOutput(output).kind === OUTPUT_KINDS.text;

/**
 * Can this `murmur send --json` outcome count as a review RESPONSE having been obtained? It does
 * NOT decide the verdict: a substantive "BLOCKED …" is a real review that satisfies this gate while
 * the caller must still see a SAFE verdict before proceeding. Only a correlated
 * reply (waited, ok) whose text is substantive. Queued/delivered/ACKed (`waited: false`),
 * a timeout, a cancellation, an empty reply or a tool intent never count.
 */
export const satisfiesReviewGate = (sendResult) => {
  if (!sendResult || sendResult.ok !== true || sendResult.waited !== true) return false;
  return isSubstantiveResult({ text: sendResult.text });
};

/** Bounded, redacted diagnostics for a runtime failure — never raw output, never secrets. */
export const safeDiagnostics = (fields = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string"
      ? redactSecrets(value).replace(/\s+/g, " ").slice(0, 200)
      : (typeof value === "number" || typeof value === "boolean" ? value : String(value).slice(0, 80));
  }
  return out;
};

export class RuntimeOutputError extends Error {
  constructor(prefix, kind, reason, diagnostics = {}) {
    const compact = Object.entries(diagnostics).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(",");
    super(`${prefix}-${reason}${compact ? `:${compact}` : ""}`.slice(0, 300));
    this.name = "RuntimeOutputError";
    this.kind = kind;
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}
