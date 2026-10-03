/**
 * review-gate.mjs — the RELEASE POLICY layer on top of Murmur's generic runtime gate.
 *
 * Two layers, deliberately separate:
 *
 *   transport/runtime  (`satisfiesReviewGate` in runtime-output.mjs)
 *       Only says "a substantive, correlated review RESPONSE exists": waited, ok, non-empty prose.
 *       It never reads a verdict — a substantive "BLOCKED …" is a real review.
 *
 *   release policy     (this file)
 *       Decides whether that response lets a release/production step proceed. It requires the
 *       reviewer's DECLARED verdict — the first non-empty line, consisting of ONLY `SAFE`, `BLOCKED` or
 *       `UNSAFE` (optionally prefixed `VERDICT:` and decorated with markdown) — to be SAFE. It does not search the transport for words and it
 *       never infers a verdict from prose: a response with no declared verdict fails closed.
 *       A SAFE verdict that also lists BLOCKER findings is contradictory and fails closed.
 */
import { classifyRuntimeOutput, OUTPUT_KINDS, satisfiesReviewGate } from "./runtime-output.mjs";

export const REVIEW_VERDICTS = Object.freeze({ safe: "SAFE", blocked: "BLOCKED", unsafe: "UNSAFE", missing: "MISSING" });

export const RELEASE_GATE_REASONS = Object.freeze({
  ok: "ok",
  noSubstantiveResponse: "no-substantive-response",
  verdictBlocked: "verdict-blocked",
  verdictMissing: "verdict-missing",
  contradictory: "verdict-contradictory",
});

// The verdict line is the verdict and NOTHING else: "SAFE, but UNSAFE", "SAFE — critical defect",
// "SAFE-ish" are not a declared verdict (and carry no hidden qualifier past the gate).
const VERDICT_LINE = /^[\s*_>#-]*(?:verdict\s*[:=-]\s*)?[*_]*(SAFE|BLOCKED|UNSAFE)[*_.]*\s*$/i;
const NOT_SAFE_LINE = /^[\s*_>#-]*(?:verdict\s*[:=-]\s*)?[*_]*NOT[\s_-]+SAFE[*_.]*\s*$/i;
// ANY mention of a BLOCKER (not "NON-BLOCKER") below the verdict line, in any decoration — "1. BLOCKER",
// "[BLOCKER]", "Finding: BLOCKER —" — contradicts a SAFE verdict. Only an explicit "no blockers" PHRASE is
// removed first, so a line that also reports a blocker is still caught.
// A hyphen/underscore prefix is NOT an excuse ("RELEASE-BLOCKER", "P0-BLOCKER", "release_blocker"), nor is
// markdown ("BLOCK**ER**"), BLOCKING, or the Russian БЛОКЕР / БЛОКИРУЮЩИЙ. The line is normalised first.
const BLOCKER_WORD = /(?<![A-Za-z])(?:BLOCKERS?|BLOCKING)(?![A-Za-z])|БЛОКЕР|БЛОКИРУ/i;
const NO_BLOCKERS = /(?:\b(?:no|zero|0|without|not any)\s+(?:genuine\s+|real\s+|remaining\s+)?(?:blockers?|blocking(?:\s+issues?)?)\b|(?:нет|без)\s+блокер\p{L}*)/iu;
const normalise = (line) => line.replace(/[\u200b-\u200f\u2060\ufeff]/g, "").replace(/[*`]/g, "").replace(/_/g, " ");

/** The reviewer's DECLARED verdict: the first non-empty line, nothing else is consulted. */
export const declaredVerdict = (text) => {
  const first = String(text ?? "").split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return REVIEW_VERDICTS.missing;
  if (NOT_SAFE_LINE.test(first)) return REVIEW_VERDICTS.unsafe;
  const match = first.match(VERDICT_LINE);
  return match ? match[1].toUpperCase() : REVIEW_VERDICTS.missing;
};

/** Does the text list findings that are themselves marked BLOCKER (a contradiction with SAFE)? */
const listsBlockers = (text) => String(text ?? "").split(/\r?\n/).slice(1)
  .map(normalise)
  .some((line) => BLOCKER_WORD.test(line.replace(/NON[-\s]?(?:BLOCKERS?|BLOCKING)/gi, "").replace(new RegExp(NO_BLOCKERS.source, "giu"), "")));

/**
 * @param sendResult the `murmur send --json` outcome of a REQUIRED independent review
 * @returns {{ passed: boolean, reason: string, verdict: string|null }}
 */
export const evaluateReleaseGate = (sendResult) => {
  if (!satisfiesReviewGate(sendResult)) {
    return { passed: false, reason: RELEASE_GATE_REASONS.noSubstantiveResponse, verdict: null };
  }
  const verdict = declaredVerdict(sendResult.text);
  if (verdict === REVIEW_VERDICTS.blocked || verdict === REVIEW_VERDICTS.unsafe) {
    return { passed: false, reason: RELEASE_GATE_REASONS.verdictBlocked, verdict };
  }
  if (verdict !== REVIEW_VERDICTS.safe) return { passed: false, reason: RELEASE_GATE_REASONS.verdictMissing, verdict };
  if (listsBlockers(sendResult.text)) return { passed: false, reason: RELEASE_GATE_REASONS.contradictory, verdict };
  if (classifyRuntimeOutput({ text: sendResult.text }).kind !== OUTPUT_KINDS.text) {
    return { passed: false, reason: RELEASE_GATE_REASONS.noSubstantiveResponse, verdict };
  }
  return { passed: true, reason: RELEASE_GATE_REASONS.ok, verdict };
};

/**
 * The production entry: judge a `murmur send --json` outcome of a REQUIRED review. This is what
 * `murmur send --release-gate` runs, so a substantive BLOCKED reply can never satisfy a release step
 * through the CLI.
 */
export const applyReleaseGate = (sendResult) => {
  const gate = evaluateReleaseGate(sendResult);
  return gate.passed
    ? { ...sendResult, releaseGate: gate }
    : { ...sendResult, ok: false, reason: "release-gate-failed", releaseGate: gate };
};
