/**
 * review-gate.test.mjs — the release POLICY layer: only a substantive, correlated, declared-SAFE
 * review may pass; everything else fails closed. (The transport layer is tested in
 * runtime-output.test.mjs and never reads a verdict.)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_VERDICTS, declaredVerdict, evaluateReleaseGate } from "../scripts/review-gate.mjs";
import { satisfiesReviewGate } from "../scripts/runtime-output.mjs";

const reply = (text) => ({ ok: true, waited: true, substantive: true, text });
const FRAME = JSON.stringify({ murmur: { action: "handoff", to: "codex-agent", task: "t" } });

test("a substantive SAFE verdict passes the release gate", () => {
  for (const text of ["SAFE\n\nNo blockers. Retry budget is enforced (queue.mjs:42).", "SAFE.\nnothing found", "VERDICT: SAFE\nreasoning…", "**SAFE**\nchecked the diff", "safe\nok"]) {
    const result = evaluateReleaseGate(reply(text));
    assert.equal(result.passed, true, text);
    assert.equal(result.reason, "ok");
    assert.equal(result.verdict, "SAFE");
  }
});

test("a substantive BLOCKED / UNSAFE / NOT SAFE verdict FAILS the release gate (the generic gate still holds)", () => {
  for (const text of ["BLOCKED\n\n1. BLOCKER — queue.mjs:42 drops the retry budget.", "UNSAFE\nsecrets in the diff", "VERDICT: BLOCKED\n…", "NOT SAFE\nsee findings", "BLOCKED\nBLOCKER: x"]) {
    const response = reply(text);
    assert.equal(satisfiesReviewGate(response), true, "it IS a substantive review response…");
    const result = evaluateReleaseGate(response);
    assert.equal(result.passed, false, text);
    assert.match(result.reason, /^verdict-(blocked|missing)$/, text);
  }
  assert.equal(evaluateReleaseGate(reply("BLOCKED\nfoo")).reason, "verdict-blocked");
  assert.equal(evaluateReleaseGate(reply("UNSAFE")).reason, "verdict-blocked");
});

test("a response with NO declared verdict fails closed — nothing is inferred from prose", () => {
  for (const text of ["The change looks fine to me, nothing stands out.", "I think this is safe.", "No blockers were found, although I did not check the tests.", "Reviewed. Looks safe.", "SAFE: nothing found"]) {
    const result = evaluateReleaseGate(reply(text));
    assert.equal(result.passed, false, text);
    assert.equal(result.reason, "verdict-missing");
  }
});

test("SAFE that also lists BLOCKER findings is contradictory and fails closed; 'NO BLOCKERS' is fine", () => {
  assert.equal(evaluateReleaseGate(reply("SAFE\n\n1. BLOCKER — the retry budget is not enforced")).reason, "verdict-contradictory");
  assert.equal(evaluateReleaseGate(reply("SAFE\nBLOCKER: x")).passed, false);
  assert.equal(evaluateReleaseGate(reply("SAFE\n\nNO BLOCKERS. NON-BLOCKER: naming.")).passed, true);
});

test("empty / whitespace replies FAIL", () => {
  for (const text of ["", "   ", "\n\n"]) assert.equal(evaluateReleaseGate(reply(text)).reason, "no-substantive-response");
});

test("tool-intent-only replies FAIL (bare or fenced frame, even though they are 'text' to a transport)", () => {
  for (const text of [FRAME, "```json\n" + FRAME + "\n```"]) assert.equal(evaluateReleaseGate(reply(text)).passed, false, text);
});

test("transport-only and ACK-only successes FAIL", () => {
  assert.equal(evaluateReleaseGate({ ok: true, waited: false, msgId: "m" }).reason, "no-substantive-response", "queued/delivered, not waited");
  assert.equal(evaluateReleaseGate({ ok: true, waited: false, acked: true }).passed, false, "an ACK");
  assert.equal(evaluateReleaseGate({ ok: true, waited: true }).passed, false, "a 'success' with no review text");
  assert.equal(evaluateReleaseGate({ ok: true, waited: true, text: "SAFE", notification: "sent" }).passed, true, "…but a real SAFE reply with a notification beside it is judged on its text alone");
  assert.equal(evaluateReleaseGate({ ok: false, reason: "timeout" }).passed, false);
  assert.equal(evaluateReleaseGate({ ok: false, reason: "cancelled" }).passed, false);
  assert.equal(evaluateReleaseGate({ ok: false, reason: "non-substantive-reply", kind: "empty" }).passed, false);
  assert.equal(evaluateReleaseGate(null).passed, false);
  assert.equal(evaluateReleaseGate(undefined).passed, false);
});

test("the verdict is the DECLARED first line only: a SAFE buried later in a BLOCKED review does not pass", () => {
  assert.equal(declaredVerdict("BLOCKED\n\nEarlier drafts said SAFE\nSAFE"), REVIEW_VERDICTS.blocked);
  assert.equal(declaredVerdict("\n\n  SAFE"), REVIEW_VERDICTS.safe);
  assert.equal(declaredVerdict("Summary first.\nSAFE"), REVIEW_VERDICTS.missing);
  assert.equal(declaredVerdict(""), REVIEW_VERDICTS.missing);
});

test("bypass attempts: decorated BLOCKER findings below a SAFE line, and look-alike verdict words, fail closed", () => {
  const blocked = [
    "SAFE\n1. [BLOCKER] — the retry budget is not enforced",
    "SAFE\nFinding: BLOCKER — secrets in the diff",
    "SAFE\n- **BLOCKER**: queue.mjs:42",
    "SAFE\n(1) blocker: lowercase",
    "SAFE\nBLOCKERS: queue.mjs:42, retry.mjs:9",
  ];
  for (const text of blocked) assert.equal(evaluateReleaseGate(reply(text)).passed, false, text);
  for (const text of ["SAFE-ish, probably fine", "SAFER than before", "SAFE_TO_TRY maybe", "UNSAFE-ish"]) {
    assert.notEqual(evaluateReleaseGate(reply(text)).reason, "ok", text);
  }
  // still allowed: explicit absence and NON-BLOCKER notes
  for (const text of ["SAFE\nNo blockers found.", "SAFE\nNON-BLOCKER — naming nit (a.mjs:3)", "SAFE\nzero blockers; NON-BLOCKERS: a, b", "SAFE\nNO BLOCKERS."]) {
    assert.equal(evaluateReleaseGate(reply(text)).passed, true, text);
  }
});

test("the verdict line is the verdict ONLY: a qualified or contradicted SAFE on line one fails closed", () => {
  for (const text of ["SAFE, but UNSAFE", "SAFE — critical defect", "SAFE — BLOCKER: duplicate execution", "SAFE: with caveats\nok", "SAFE-ish"]) {
    const result = evaluateReleaseGate(reply(text));
    assert.equal(result.passed, false, text);
    assert.equal(result.reason, "verdict-missing", text);
  }
});

test("a line that reports a blocker is not excused by also saying 'no blockers elsewhere'", () => {
  assert.equal(evaluateReleaseGate(reply("SAFE\nBLOCKER: duplicate; no blockers elsewhere")).passed, false);
  assert.equal(evaluateReleaseGate(reply("SAFE\nno blockers elsewhere")).passed, true);
});

test("PRODUCTION WIRING: applyReleaseGate (what `murmur send --release-gate` runs) turns a substantive BLOCKED reply into a failure", async () => {
  const { applyReleaseGate } = await import("../scripts/review-gate.mjs");
  const blocked = applyReleaseGate(reply("BLOCKED\n1. BLOCKER — x"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "release-gate-failed");
  assert.equal(blocked.releaseGate.verdict, "BLOCKED");
  assert.equal(satisfiesReviewGate(reply("BLOCKED\n1. BLOCKER — x")), true, "…the generic gate alone WOULD have let it through");
  assert.equal(applyReleaseGate(reply("SAFE\nok")).ok, true);
  assert.equal(applyReleaseGate({ ok: true, waited: false }).ok, false);
  // and the CLI really uses it
  const { readFileSync } = await import("node:fs");
  const cli = readFileSync(new URL("../scripts/operator/cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /applyReleaseGate\(/);
  assert.match(cli, /--release-gate/);
});

test("hyphen/underscore-prefixed blocker findings below a SAFE line are still blockers; NON-BLOCKER variants are not", () => {
  for (const text of ["SAFE\nRELEASE-BLOCKER: duplicate execution", "SAFE\nP0-BLOCKER — secrets", "SAFE\nrelease_blocker: x", "SAFE\n1. P1-BLOCKER: y"]) {
    assert.equal(evaluateReleaseGate(reply(text)).passed, false, text);
  }
  for (const text of ["SAFE\nNON-BLOCKER: naming", "SAFE\nnon blocker: style", "SAFE\nNON_BLOCKERS: a"]) {
    assert.equal(evaluateReleaseGate(reply(text)).passed, true, text);
  }
});

test("`murmur send --release-gate --no-wait` is refused up front: a gate cannot be satisfied by an enqueue that does not wait", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-rg-"));
  mkdirSync(path.join(dir, "proj"));
  try {
    const run = spawnSync(process.execPath, [new URL("../bin/murmur.mjs", import.meta.url).pathname, "send", path.join(dir, "proj"), "review this", "--release-gate", "--no-wait", "--json"], {
      env: { ...process.env, MURMUR_HOME: path.join(dir, "home") }, encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.equal(JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))).reason, "release-gate-requires-wait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalised blocker detection: markdown-split, BLOCKING and Russian findings below SAFE fail; explicit absence passes", () => {
  for (const text of ["SAFE\nBLOCK**ER**: lost data", "SAFE\nBLOCKING: duplicate execution", "SAFE\nБЛОКЕР: потеря данных", "SAFE\nблокирующая проблема: x", "SAFE\n`BLOCKER` — y", "SAFE\nBLOCK​ER: z"]) {
    assert.equal(evaluateReleaseGate(reply(text)).passed, false, text);
  }
  for (const text of ["SAFE\nNo blocking issues.", "SAFE\nНет блокеров.", "SAFE\n**NO BLOCKERS**", "SAFE\nnon-blocking: naming"]) {
    assert.equal(evaluateReleaseGate(reply(text)).passed, true, text);
  }
});
