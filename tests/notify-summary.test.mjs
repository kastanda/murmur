/**
 * notify-summary.test.mjs — the polish slice: explicit project label, redundant-line
 * suppression, and the Russian summary for long non-Russian agent content.
 *
 * The summarizer is a FAKE everywhere here. The deterministic suite must never need a
 * model, a network or a CLI binary — and the properties worth proving (redaction happens
 * first, failure falls back, output is bounded, one render per logical event) are exactly
 * the ones a fake can prove precisely.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SUMMARY_TRIGGER_CHARS,
  buildActivityErrorNotification,
  buildActivityNotification,
  needsRussianSummary,
  normalizeForComparison,
} from "../scripts/notify-activity.mjs";
import {
  SUMMARY_MAX_CHARS,
  buildSummaryPrompt,
  createClaudeSummarizer,
  normalizeSummary,
} from "../scripts/notify-summarizer.mjs";
import { NotifyQueue } from "../scripts/notify-router.mjs";

const PROJECT_ID = "murmur-f6a3a362f2bb";
const id = (role) => `${PROJECT_ID}-${role}`;

const notification = (overrides = {}) => buildActivityNotification({
  localAgentId: id("codex"),
  senderId: id("claude"),
  msgId: "m-1",
  text: "Проверь release policy.",
  projectId: PROJECT_ID,
  projectLabel: "murmur",
  ...overrides,
});

const LONG_EN = "READ-ONLY adversarial review. Check provisioning profile requirements, Team ID, "
  + "keychain access groups and post-signing profile replacement. Confirm the release policy is "
  + "enforced for the macOS target and that notarization is reachable from CI without manual steps.";

const line = (rendered, label) => rendered.split("\n").find((entry) => entry.startsWith(`${label}:`)) ?? null;

// ---------------------------------------------------------------------------
// 1. Project label
// ---------------------------------------------------------------------------

test("a known project is labelled explicitly, on every event class", () => {
  const events = [
    notification({ localAgentId: id("claude"), senderId: id("root"), text: "Задача." }),
    notification({ handoff: { ancestry: [id("claude")] } }),
    notification({ localAgentId: id("claude"), senderId: id("codex"), replyToMessageId: "p", text: "Готово." }),
    notification({ localAgentId: id("root"), senderId: id("claude"), replyToMessageId: "p", text: "Готово." }),
    buildActivityErrorNotification({
      localAgentId: id("codex"), senderId: id("claude"), msgId: "e1", reason: "terminal",
      text: "Задача.", projectId: PROJECT_ID, projectLabel: "murmur",
    }),
  ];
  for (const event of events) {
    assert.match(event.activityText, /^📁 Проект: murmur$/m, event.activityKind);
  }
});

test("an unknown project omits the line rather than inventing a name", () => {
  const legacy = buildActivityNotification({
    localAgentId: "codex", senderId: "claude", msgId: "l1", text: "Сообщение между агентами.",
  });
  assert.doesNotMatch(legacy.activityText, /📁/);
  assert.doesNotMatch(legacy.activityText, /Проект/);
});

// ---------------------------------------------------------------------------
// 2. Redundant-line suppression
// ---------------------------------------------------------------------------

test("an identical topic and request collapse to one line", () => {
  const rendered = notification({
    handoff: { ancestry: [id("claude")] },
    text: "Ответь строго одной строкой: ГОТОВО_CODEX",
  }).activityText;
  assert.equal(line(rendered, "Тема"), null, "the topic repeated the request verbatim");
  assert.equal(line(rendered, "Просит"), "Просит: Ответь строго одной строкой: ГОТОВО_CODEX");
});

test("an identical topic and reply, and an identical topic and final, collapse too", () => {
  const reply = notification({
    localAgentId: id("codex"), senderId: id("cursor"), replyToMessageId: "p", text: "Проверено, всё сходится.",
  }).activityText;
  assert.equal(line(reply, "Тема"), null);
  assert.equal(line(reply, "Ответ"), "Ответ: Проверено, всё сходится.");

  const final = notification({
    localAgentId: id("root"), senderId: id("claude"), replyToMessageId: "p", text: "ИТОГ_РУС_ОК",
  }).activityText;
  assert.equal(line(final, "Тема"), null);
  assert.equal(line(final, "Итог"), "Итог: ИТОГ_РУС_ОК");
});

test("a topic that adds distinct context is kept", () => {
  // The reply inherits the REQUEST's topic, which says something the answer does not.
  const rendered = notification({
    localAgentId: id("claude"),
    senderId: id("codex"),
    replyToMessageId: "p",
    parentText: "Проверка provisioning profile и release policy.",
    text: "Найден один блокирующий риск.",
  }).activityText;
  assert.equal(line(rendered, "Тема"), "Тема: Проверка provisioning profile и release policy.");
  assert.equal(line(rendered, "Ответ"), "Ответ: Найден один блокирующий риск.");
});

test("when the content line OPENS with the topic, the repetition is removed, not the topic", () => {
  // A title-plus-detail message reads as a heading and a body, never as its own title twice.
  const rendered = notification({
    localAgentId: id("root"), senderId: id("claude"), replyToMessageId: "p",
    text: "Проверка завершена. SAFE TO MERGE",
  }).activityText;
  assert.equal(line(rendered, "Тема"), "Тема: Проверка завершена.");
  assert.equal(line(rendered, "Итог"), "Итог: можно мержить");

  // The split counts words with one tokenizer on both sides, so a hyphenated term is not
  // cut in half.
  const hyphenated = notification({
    handoff: { ancestry: [id("claude")] },
    text: "READ-ONLY проверка профиля.\nПроверь Team ID и release policy внимательно.",
  }).activityText;
  assert.equal(line(hyphenated, "Тема"), "Тема: READ-ONLY проверка профиля.");
  assert.equal(line(hyphenated, "Просит"), "Просит: Проверь Team ID и release policy внимательно.");

  // A shared stem is not a contained topic: `Проверка профиля` must not swallow `Проверкой…`.
  assert.equal(normalizeForComparison("Проверк"), "проверк");
  const distinct = notification({
    localAgentId: id("claude"), senderId: id("codex"), replyToMessageId: "p",
    parentText: "Проверка профиля.", text: "Проверкой занимался Codex, найден риск.",
  }).activityText;
  assert.equal(line(distinct, "Тема"), "Тема: Проверка профиля.");
  assert.equal(line(distinct, "Ответ"), "Ответ: Проверкой занимался Codex, найден риск.");
});

test("comparison ignores harmless differences and nothing else", () => {
  assert.equal(normalizeForComparison("  Готово   к   merge. "), normalizeForComparison("готово к merge"));
  assert.equal(normalizeForComparison("Проверено!"), normalizeForComparison("проверено"));
  assert.notEqual(normalizeForComparison("Проверено, один риск"), normalizeForComparison("Проверено"),
    "a line carrying extra words carries extra information and must survive");

  // Whitespace and terminal punctuation alone must still collapse the pair.
  const rendered = notification({
    handoff: { ancestry: [id("claude")] }, text: "Проверь  release   policy!",
  }).activityText;
  assert.equal(line(rendered, "Тема"), null);
});

test("an error keeps its topic, because the error line leads with the failure reason", () => {
  const rendered = buildActivityErrorNotification({
    localAgentId: id("codex"), senderId: id("claude"), msgId: "e1", reason: "terminal",
    text: "Проверь release policy.", projectId: PROJECT_ID, projectLabel: "murmur",
  }).activityText;
  assert.equal(line(rendered, "Тема"), "Тема: Проверь release policy.");
  assert.match(rendered, /^Ошибка: исчерпаны попытки доставки: /m);
});

// ---------------------------------------------------------------------------
// 3. When to summarize
// ---------------------------------------------------------------------------

test("summarization triggers only for long non-Russian content", () => {
  assert.equal(needsRussianSummary(LONG_EN), true);
  // Short technical values are exact and already readable.
  assert.equal(needsRussianSummary("CODEX_OK=ABC123"), false);
  assert.equal(needsRussianSummary("SAFE TO MERGE"), false);
  assert.equal(needsRussianSummary("PASS"), false);
  assert.equal(needsRussianSummary("READY FOR REVIEW"), false);
  // Russian content is never sent to a model, however long.
  assert.equal(needsRussianSummary("Проверка release policy завершена. ".repeat(12)), false);
  // A long line of one sentence needs more length than several sentences do.
  assert.equal(needsRussianSummary("x".repeat(SUMMARY_TRIGGER_CHARS - 1)), false);
  assert.equal(needsRussianSummary(""), false);
  assert.equal(needsRussianSummary("12345 67890 ".repeat(30)), false, "digits alone are not a language");
});

test("a prepared Russian summary replaces the English excerpt entirely", () => {
  const rendered = notification({
    handoff: { ancestry: [id("claude")] },
    text: LONG_EN,
    summary: "Проверить release-профиль, Team ID, keychain access groups и защиту от подмены профиля после подписи.",
  }).activityText;
  assert.match(rendered, /^Просит: Проверить release-профиль, Team ID, keychain access groups/m);
  assert.doesNotMatch(rendered, /в оригинале по-английски/);
  assert.doesNotMatch(rendered, /adversarial review/, "the English wall is gone, not appended to");
});

test("without a summary the deterministic marked excerpt is still used", () => {
  const rendered = notification({ handoff: { ancestry: [id("claude")] }, text: LONG_EN }).activityText;
  assert.match(rendered, /^Просит: \(в оригинале по-английски\) /m);
});

test("a Russian summary of the body replaces the excerpt and takes the topic with it", () => {
  const rendered = notification({
    handoff: { ancestry: [id("claude")] },
    text: LONG_EN,
    summary: "Проверить release-профиль, Team ID и keychain access groups.",
  }).activityText;
  // The retelling already says what the topic would have said, and an English heading
  // above it would be the original prompt leaking back in.
  assert.equal(line(rendered, "Тема"), null);
  assert.equal(line(rendered, "Просит"), "Просит: Проверить release-профиль, Team ID и keychain access groups.");
});

test("a short technical reply keeps its exact token under a Russian topic", () => {
  // The answer is already perfect; it is the ENGLISH REQUEST it answers that needs
  // retelling, so the summary becomes the topic instead of replacing the answer.
  const rendered = notification({
    localAgentId: id("claude"),
    senderId: id("codex"),
    replyToMessageId: "p",
    parentText: LONG_EN,
    text: "RELEASE_CHECK_OK",
    topicSummary: "Проверка готовности macOS release-target: профиль, Team ID, notarization.",
  }).activityText;
  assert.equal(line(rendered, "Тема"), "Тема: Проверка готовности macOS release-target: профиль, Team ID, notarization.");
  assert.equal(line(rendered, "Ответ"), "Ответ: RELEASE_CHECK_OK", "an identifier is never paraphrased");
});

test("an English topic over a Russian line is dropped when no retelling is available", () => {
  const rendered = notification({
    handoff: { ancestry: [id("claude")] },
    text: LONG_EN,
    summary: "Проверить release-профиль и Team ID.",
  }).activityText;
  assert.doesNotMatch(rendered, /adversarial review/);

  // But an English topic ABOVE an English excerpt is consistent, and is the title of it.
  const fallback = notification({ handoff: { ancestry: [id("claude")] }, text: LONG_EN }).activityText;
  assert.equal(line(fallback, "Тема"), "Тема: READ-ONLY adversarial review.");
});

// ---------------------------------------------------------------------------
// 4. The summary contract
// ---------------------------------------------------------------------------

test("the prompt carries only sanitized text and asks for plain bounded Russian", () => {
  const prompt = buildSummaryPrompt({
    text: "Deploy with token 123456789:AAFakeTokenValue0000000000000000000 and password: hunter2hunter2",
    kind: "request",
    topic: "release",
    from: "Claude",
    to: "Codex",
    project: "murmur",
  });
  assert.doesNotMatch(prompt, /AAFakeTokenValue/, "the summarizer never sees a credential");
  assert.doesNotMatch(prompt, /hunter2hunter2/);
  assert.match(prompt, /Кратко перескажи смысл сообщения по-русски/);
  assert.match(prompt, /Не добавляй фактов, которых нет в исходном тексте/);
  assert.match(prompt, /Сохраняй технические названия и идентификаторы/);
  assert.match(prompt, new RegExp(`не длиннее ${SUMMARY_MAX_CHARS} символов`));
  assert.match(prompt, /Проект: murmur/);
});

test("a model answer is stripped of decoration, bounded, and re-redacted", () => {
  assert.equal(normalizeSummary("**Краткое содержание:** Проверить Team ID и профиль."),
    "Проверить Team ID и профиль.");
  assert.equal(normalizeSummary("«Проверить Team ID.»"), "Проверить Team ID.");
  assert.equal(normalizeSummary("```\nПроверить Team ID.\n```"), "Проверить Team ID.");
  // An identifier must survive: underscores are content, not markdown emphasis.
  assert.equal(normalizeSummary("Проверить профиль. Ответить: SIGNING_CHECK_OK"),
    "Проверить профиль. Ответить: SIGNING_CHECK_OK");

  const long = normalizeSummary(`Проверить ${"очень длинный текст ".repeat(40)}`);
  assert.ok(long.length <= SUMMARY_MAX_CHARS, `got ${long.length}`);
  assert.match(long, /…$/);

  // Belt and braces: a model that echoed a credential back is still redacted.
  assert.doesNotMatch(
    normalizeSummary("Токен 123456789:AAFakeTokenValue0000000000000000000 в сообщении."),
    /AAFakeTokenValue/,
  );
});

test("an unusable answer is rejected so the deterministic fallback wins", () => {
  assert.equal(normalizeSummary(""), null);
  assert.equal(normalizeSummary("   "), null);
  assert.equal(normalizeSummary(null), null);
  assert.equal(normalizeSummary("Check the Team ID and the provisioning profile."), null,
    "an English answer has not done the one job this exists for");
});

// ---------------------------------------------------------------------------
// 5. Failure and fallback
// ---------------------------------------------------------------------------

const summarizerWith = (runner, options = {}) => createClaudeSummarizer({ runner, ...options });

test("every failure mode resolves to null instead of throwing", async () => {
  const failures = {
    timeout: () => Promise.reject(Object.assign(new Error("claude-one-shot-timeout"), { outcomeUnknown: true })),
    unavailable: () => Promise.reject(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })),
    "non-zero exit": () => Promise.reject(new Error("claude-one-shot-exit:1:")),
    "malformed result": () => Promise.resolve({ text: undefined }),
    "empty result": () => Promise.resolve({ text: "   " }),
    "english result": () => Promise.resolve({ text: "Check the provisioning profile." }),
    "thrown synchronously": () => {
      throw new Error("boom");
    },
  };
  for (const [label, runner] of Object.entries(failures)) {
    assert.equal(await summarizerWith(runner)({ text: LONG_EN }), null, label);
  }
});

test("a failed summary is never announced to the operator and never retried", async () => {
  let calls = 0;
  const runner = () => {
    calls += 1;
    return Promise.reject(new Error("claude-one-shot-timeout"));
  };
  const logged = [];
  const summarize = summarizerWith(runner, { log: (level, msg) => logged.push({ level, msg }) });

  assert.equal(await summarize({ text: LONG_EN }), null);
  assert.equal(calls, 1, "exactly one attempt: a chat message is not worth a retry storm");
  assert.ok(logged.every((entry) => entry.level === "debug"), "a recoverable fallback is not an incident");

  // And the feed still renders, with the deterministic excerpt.
  const rendered = notification({ handoff: { ancestry: [id("claude")] }, text: LONG_EN, summary: null }).activityText;
  assert.match(rendered, /^Просит: /m);
});

test("the timeout is bounded and handed to the runner, not left to the model", async () => {
  let seen = null;
  const summarize = summarizerWith((options) => {
    seen = options;
    return Promise.resolve({ text: "Проверить Team ID." });
  }, { timeoutMs: 9_000, model: "test-model", cwd: "/tmp" });

  assert.equal(await summarize({ text: LONG_EN }), "Проверить Team ID.");
  assert.equal(seen.timeoutMs, 9_000);
  assert.equal(seen.model, "test-model");
  assert.equal(seen.resume, false, "a summary never resumes an agent session");
  assert.equal(seen.permissionMode, "dontAsk");
  assert.ok(seen.sessionId, "a throwaway session id, never a runtime binding");
});

test("summarization can be switched off entirely", () => {
  assert.equal(createClaudeSummarizer({ runner: null }), null);
  assert.equal(createClaudeSummarizer(), null);
});

// ---------------------------------------------------------------------------
// 6. Dedupe: one durable render per logical event
// ---------------------------------------------------------------------------

test("the rendered payload is durable, so a transport retry re-sends it without a model call", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-summary-"));
  try {
    const queue = new NotifyQueue(path.join(dir, "murmur.db"));
    const targets = [{ type: "telegram", channel: "telegram", botToken: "t", chatId: "c" }];
    const summarized = notification({
      handoff: { ancestry: [id("claude")] },
      text: LONG_EN,
      summary: "Проверить release-профиль и Team ID.",
    });

    queue.enqueueMessage(summarized, targets);
    // A redelivery of the same envelope. Even if a model produced DIFFERENT wording, the
    // dedupe key is the logical event, so no second Telegram message can appear.
    queue.enqueueMessage(notification({
      handoff: { ancestry: [id("claude")] },
      text: LONG_EN,
      summary: "Совершенно другая формулировка того же самого.",
    }), targets);

    assert.equal(queue.pendingCount(), 1, "model variation must not produce a duplicate notification");
    const [row] = queue.claimDue(10);
    assert.match(JSON.parse(String(row.payload_json)).activityText, /Проверить release-профиль и Team ID\./,
      "the first durable render is what gets sent, on every attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
