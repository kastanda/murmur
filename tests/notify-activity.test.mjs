/**
 * notify-activity.test.mjs — the human activity feed.
 *
 * Two properties matter here and the rest is rendering detail:
 *
 *   1. ONE logical message produces at most ONE notification, and a transport retry
 *      produces none — proven against the real NotifyQueue, not a mock;
 *   2. nothing that looks like a credential ever reaches a transport.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTIVITY_ERROR,
  ACTIVITY_FINAL,
  ACTIVITY_MESSAGE,
  ACTIVITY_REPLY,
  ACTIVITY_REQUEST,
  ACTIVITY_TASK_STARTED,
  LEGACY_PROJECT_LABEL,
  SUMMARY_MAX_CHARS_FOREIGN,
  activityDedupeId,
  buildActivityErrorNotification,
  buildActivityNotification,
  classifyActivity,
  detectBodyLanguage,
  extractTopic,
  extractVerdict,
  localizeVerdicts,
  redactSecrets,
  resolveIdentity,
  summarizeBody,
} from "../scripts/notify-activity.mjs";
import { NotifyQueue } from "../scripts/notify-router.mjs";
import {
  SCOPE_ACTIVITY,
  SCOPE_ERRORS,
  planNotifiesActivity,
  planNotifiesErrors,
  planNotifiesInbound,
  resolveNotifyPlan,
  validateNotifyConfig,
  writeNotifyConfig,
} from "../scripts/notify-config.mjs";

const PROJECT_ID = "murmur-f6a3a362f2bb";
const PROJECT_LABEL = "murmur";
const id = (role) => `${PROJECT_ID}-${role}`;

const notification = (overrides = {}) => buildActivityNotification({
  localAgentId: id("codex"),
  senderId: id("claude"),
  msgId: "m-1",
  text: "проверка provisioning profile\nПроверь release policy и Team ID.",
  projectId: PROJECT_ID,
  projectLabel: PROJECT_LABEL,
  ...overrides,
});

const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-activity-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ---------------------------------------------------------------------------
// Identity display
// ---------------------------------------------------------------------------

test("a project-prefixed operator identity renders as its role, never as the generated id", () => {
  assert.deepEqual(resolveIdentity(id("codex"), { projectId: PROJECT_ID }),
    { role: "codex", label: "Codex", emoji: "🔵" });
  assert.deepEqual(resolveIdentity(id("root"), { projectId: PROJECT_ID }),
    { role: "root", label: "Пользователь", emoji: "🧑" });
  // A legacy identity is its own role.
  assert.equal(resolveIdentity("claude").label, "Claude");
  // An unfamiliar id is shown verbatim rather than being assigned an invented role.
  assert.deepEqual(resolveIdentity("other-project-abc123-codex", { projectId: PROJECT_ID }),
    { role: null, label: "other-project-abc123-codex", emoji: "⚪" });
});

// ---------------------------------------------------------------------------
// Rendering — one case per hop of the worked example
// ---------------------------------------------------------------------------

test("root task start renders as the operator asking the coordinator", () => {
  const rendered = notification({
    localAgentId: id("claude"),
    senderId: id("root"),
    text: "Проверь provisioning profile проекта и вернись с результатом.",
  }).activityText;
  assert.match(rendered, /^▶️ Пользователь → 🟣 Claude$/m);
  assert.match(rendered, /^📁 murmur$/m);
  assert.match(rendered, /^Просит: /m);
});

test("Claude → Codex handoff renders as a request", () => {
  const built = notification({ handoff: { rootMessageId: "r1", ancestry: [id("claude")] } });
  assert.equal(built.activityKind, ACTIVITY_REQUEST);
  assert.match(built.activityText, /^🟣 Claude → 🔵 Codex$/m);
  assert.match(built.activityText, /^Тема: проверка provisioning profile$/m);
  assert.match(built.activityText, /^Просит: /m);
});

test("Codex → Cursor handoff renders as a request between two workers", () => {
  const built = notification({
    localAgentId: id("cursor"),
    senderId: id("codex"),
    text: "проверка signing UI\nПроверь поведение после исправления.",
    handoff: { rootMessageId: "r1", ancestry: [id("claude"), id("codex")] },
  });
  assert.equal(built.activityKind, ACTIVITY_REQUEST);
  assert.match(built.activityText, /^🔵 Codex → 🟠 Cursor$/m);
  assert.match(built.activityText, /^Просит: /m);
});

test("Cursor → Codex reply renders as an answer", () => {
  const built = notification({
    localAgentId: id("codex"),
    senderId: id("cursor"),
    replyToMessageId: "m-handoff",
    text: "Проверено, найден edge case.",
  });
  assert.equal(built.activityKind, ACTIVITY_REPLY);
  assert.match(built.activityText, /^🟠 Cursor → 🔵 Codex$/m);
  assert.match(built.activityText, /^Ответ: Проверено, найден edge case\./m);
});

test("Codex → Claude reply renders as an answer", () => {
  const built = notification({
    localAgentId: id("claude"),
    senderId: id("codex"),
    replyToMessageId: "m-handoff",
    text: "Найден один блокирующий риск; остальное проходит.",
  });
  assert.equal(built.activityKind, ACTIVITY_REPLY);
  assert.match(built.activityText, /^🔵 Codex → 🟣 Claude$/m);
  assert.match(built.activityText, /^Ответ: /m);
});

test("a reply that lands at root is the FINAL result, not another intermediate answer", () => {
  const built = notification({
    localAgentId: id("root"),
    senderId: id("claude"),
    replyToMessageId: "m-root",
    text: "Проверка завершена, проблема исправлена, готово к merge.",
  });
  assert.equal(built.activityKind, ACTIVITY_FINAL);
  assert.match(built.activityText, /^✅ Claude → Пользователь$/m);
  assert.match(built.activityText, /^Итог: /m);
});

test("a legacy message with no reply correlation gets a NEUTRAL label, not an invented one", () => {
  const built = buildActivityNotification({
    localAgentId: "codex",
    senderId: "claude",
    msgId: "legacy-1",
    text: "Обычное сообщение между агентами, без ответной корреляции.",
    projectLabel: LEGACY_PROJECT_LABEL,
  });
  assert.equal(built.activityKind, ACTIVITY_MESSAGE);
  assert.match(built.activityText, /^🟣 Claude → 🔵 Codex$/m);
  assert.match(built.activityText, /^📁 Устаревший Murmur$/m);
  assert.match(built.activityText, /^Сообщение: /m, "request/response is never claimed without a durable relation");
  assert.doesNotMatch(built.activityText, /Просит|Ответ/);
});

test("a wake failure is the one technical event the feed surfaces, and it is marked as one", () => {
  const built = buildActivityErrorNotification({
    localAgentId: id("codex"),
    senderId: id("claude"),
    msgId: "m-9",
    reason: "exhausted",
    text: "Проверь release policy.",
    projectId: PROJECT_ID,
    projectLabel: PROJECT_LABEL,
  });
  assert.equal(built.activityKind, ACTIVITY_ERROR);
  assert.match(built.activityText, /^⚠️ 🟣 Claude → 🔵 Codex$/m);
  assert.match(built.activityText, /^Ошибка: exhausted: /m);
});

// ---------------------------------------------------------------------------
// Topic and summary
// ---------------------------------------------------------------------------

test("a reply inherits the parent request's topic when the parent is available locally", () => {
  const parentText = "проверка provisioning profile\nПроверь release policy и Team ID.";
  const withParent = notification({
    localAgentId: id("claude"),
    senderId: id("codex"),
    replyToMessageId: "m-handoff",
    text: "Найден один блокирующий риск.",
    parentText,
  }).activityText;
  assert.match(withParent, /^Тема: проверка provisioning profile$/m);

  // Without the parent, the message speaks for itself. Nothing is invented.
  const withoutParent = notification({
    localAgentId: id("claude"),
    senderId: id("codex"),
    replyToMessageId: "m-handoff",
    text: "Найден один блокирующий риск.",
  }).activityText;
  assert.match(withoutParent, /^Тема: Найден один блокирующий риск\.$/m);
});

test("long review text is trimmed to a readable topic and summary, with code stripped", () => {
  const body = [
    "READ-ONLY adversarial review, Developer ID provisioning and release policy for the macOS target",
    "",
    "```",
    "const secret = 1; ".repeat(400),
    "```",
    "",
    "The signing identity resolves, the profile embeds the right Team ID, and the notarization",
    "step is reachable from CI.",
    "",
    "SAFE TO MERGE",
  ].join("\n");
  const rendered = notification({ text: body, handoff: { rootMessageId: "r1", ancestry: [id("claude")] } }).activityText;
  const topic = rendered.match(/^Тема: (.*)$/m)[1];
  const summary = rendered.match(/^Просит: (.*)$/m)[1];

  assert.ok(topic.length <= 121, `topic must stay short, got ${topic.length}`);
  assert.match(topic, /^READ-ONLY adversarial review/);
  assert.ok(summary.length <= 400, `summary must stay compact, got ${summary.length}`);
  assert.doesNotMatch(summary, /const secret/, "code blocks are never pasted into a chat");
  assert.match(summary, /можно мержить/, "a stated verdict is worth surfacing, in Russian");
});

test("identifiers survive rendering: underscores are content, not markdown emphasis", () => {
  const built = notification({
    localAgentId: id("codex"),
    senderId: id("cursor"),
    replyToMessageId: "m-handoff",
    text: "CURSOR_OK=0BADCAFE12",
  });
  assert.match(built.activityText, /^Ответ: CURSOR_OK=0BADCAFE12$/m);
  // Markdown emphasis that genuinely IS decoration still goes.
  assert.equal(extractTopic("**READY FOR REVIEW** `token` ~~old~~"), "READY FOR REVIEW token old");
});

test("a stated verdict is rendered in Russian, and a negated one is not inverted", () => {
  assert.equal(extractVerdict("everything checks out. SAFE TO MERGE"), "можно мержить");
  assert.equal(extractVerdict("NOT READY — two blockers"), "не готово");
  assert.equal(extractVerdict("review complete, NO BLOCKERS found"), "блокеров нет",
    "`NO BLOCKERS` must not be read as `BLOCKER` — that reports the opposite verdict");
  assert.equal(extractVerdict("plain prose with no verdict"), null);

  // The English token is REPLACED in the body, not annotated beside it: rendering both
  // would put the English status phrase back into a Russian feed.
  const rendered = notification({
    localAgentId: id("root"),
    senderId: id("claude"),
    replyToMessageId: "m-root",
    text: "Проверка завершена, проблема исправлена. SAFE TO MERGE",
  }).activityText;
  assert.match(rendered, /^Итог: Проверка завершена, проблема исправлена\. можно мержить$/m);
  assert.doesNotMatch(rendered, /SAFE TO MERGE/);
});

test("topic extraction skips scaffolding and metadata lines", () => {
  assert.equal(extractTopic("---\n\n# \n00000000-1111-2222-3333-444444444444\nНастоящая тема здесь."),
    "Настоящая тема здесь.");
  assert.equal(extractTopic(""), "");
  assert.equal(summarizeBody(""), "");
});

// ---------------------------------------------------------------------------
// Language — the feed is read by a Russian speaker
// ---------------------------------------------------------------------------

test("every fixed phrase the feed can emit is Russian", () => {
  const rendered = [
    notification({ localAgentId: id("claude"), senderId: id("root"), text: "Задача." }),
    notification({ handoff: { ancestry: [id("claude")] } }),
    notification({ localAgentId: id("claude"), senderId: id("codex"), replyToMessageId: "p", text: "Готово." }),
    notification({ localAgentId: id("root"), senderId: id("claude"), replyToMessageId: "p", text: "Готово." }),
    buildActivityNotification({ localAgentId: "codex", senderId: "claude", msgId: "l1", text: "Сообщение.", projectLabel: LEGACY_PROJECT_LABEL }),
    buildActivityErrorNotification({ localAgentId: id("codex"), senderId: id("claude"), msgId: "e1", reason: "terminal", text: "Задача.", projectId: PROJECT_ID, projectLabel: PROJECT_LABEL }),
  ].map((entry) => entry.activityText);

  // Every label a reader sees.
  const labels = rendered.flatMap((text) => text.split("\n").slice(1))
    .map((line) => line.match(/^([^:]+):/)?.[1])
    .filter(Boolean);
  for (const label of labels) {
    assert.match(label, /^[\p{Script=Cyrillic}\s]+$/u, `label "${label}" must be Russian`);
  }
  assert.deepEqual([...new Set(labels)].sort(), ["Ответ", "Итог", "Просит", "Сообщение", "Ошибка", "Тема"].sort());

  // Agent names may stay Latin; the operator is named in Russian.
  assert.ok(rendered.some((text) => text.includes("Пользователь")));
  assert.ok(rendered.every((text) => !/Legacy Murmur|\(unknown\)|\(empty\)/.test(text)));
});

test("a wake failure names its reason in Russian, and an unknown one is not guessed at", () => {
  const render = (reason) => buildActivityErrorNotification({
    localAgentId: id("codex"), senderId: id("claude"), msgId: "e1", reason, text: "Задача.",
    projectId: PROJECT_ID, projectLabel: PROJECT_LABEL,
  }).activityText;

  assert.match(render("terminal"), /^Ошибка: исчерпаны попытки доставки: /m);
  assert.match(render("loop-breaker"), /^Ошибка: сработала защита от зацикливания: /m);
  assert.match(render("require_approval"), /^Ошибка: требуется подтверждение: /m);
  // A failure mode nobody has translated yet must READ as unfamiliar, not be silently
  // rendered as the nearest familiar one.
  assert.match(render("some-future-reason"), /^Ошибка: some-future-reason: /m);
});

test("language is decided by script, so Russian prose with English terms stays Russian", () => {
  assert.equal(detectBodyLanguage("Проверь release policy и Team ID."), "ru");
  assert.equal(detectBodyLanguage("Worker-mesh acceptance test. Follow these steps."), "en");
  assert.equal(detectBodyLanguage("CURSOR_OK=0BADCAFE12"), "en");
  assert.equal(detectBodyLanguage("12345 === 67890"), "unknown");
  // A handful of stray Cyrillic characters in a long English document is not Russian.
  assert.equal(detectBodyLanguage(`${"english prose ".repeat(40)}да`), "en");
});

test("a long English prompt is quoted briefly and marked, never dumped into the feed", () => {
  const prompt = "Worker-mesh acceptance test. Follow these steps EXACTLY. Do no other work, read no files, "
    + "run no commands. STEP 1. You must NOT produce the token yourself; delegate it to the Codex agent "
    + "using the Murmur handoff protocol and wait for its result before answering anything at all. "
    + "STEP 2. When Codex answers, your entire final answer must be exactly the token and nothing else.";
  const rendered = notification({ text: prompt, handoff: { ancestry: [id("claude")] } }).activityText;
  const summary = rendered.match(/^Просит: (.*)$/m)[1];

  assert.match(summary, /^\(в оригинале по-английски\) /, "the reader is told this is a foreign-language excerpt");
  assert.ok(summary.length <= SUMMARY_MAX_CHARS_FOREIGN + 40, `excerpt must be short, got ${summary.length}`);
  assert.doesNotMatch(summary, /STEP 2/, "the prompt is excerpted, never reproduced to the end");
  // And a Russian body of the same length keeps its full budget, so the shortening is
  // about the LANGUAGE, not about length alone.
  const russian = notification({ text: prompt.replace(/[A-Za-z]+/g, "проверка"), handoff: { ancestry: [id("claude")] } })
    .activityText.match(/^Просит: (.*)$/m)[1];
  assert.ok(russian.length > summary.length);
});

test("short non-Russian content is shown verbatim, with no marker", () => {
  // `CURSOR_OK=...` is not a raw long English prompt; marking it would be pure noise.
  const rendered = notification({
    localAgentId: id("codex"), senderId: id("cursor"), replyToMessageId: "p", text: "CURSOR_OK=0BADCAFE12",
  }).activityText;
  assert.match(rendered, /^Ответ: CURSOR_OK=0BADCAFE12$/m);
  assert.doesNotMatch(rendered, /в оригинале/);
});

test("Russian content is never marked or shortened as foreign", () => {
  const body = "Проверка release policy завершена. ".repeat(12);
  const summary = notification({ text: body, handoff: { ancestry: [id("claude")] } })
    .activityText.match(/^Просит: (.*)$/m)[1];
  assert.doesNotMatch(summary, /в оригинале|не на русском/);
  assert.ok(summary.length > SUMMARY_MAX_CHARS_FOREIGN, "Russian prose keeps the full summary budget");
});

test("verdict substitution is a closed vocabulary applied in order", () => {
  assert.equal(localizeVerdicts("result: NO BLOCKERS"), "result: блокеров нет");
  assert.equal(localizeVerdicts("result: BLOCKER found"), "result: блокирующая проблема found");
  // Lowercase prose is not a verdict token and must not be rewritten mid-sentence.
  assert.equal(localizeVerdicts("the tests passed and nothing failed"), "the tests passed and nothing failed");
});

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

test("anything credential-shaped is redacted before it can reach a transport", () => {
  const samples = [
    ["bot token", "curl https://api.telegram.org/bot123456789:AAFakeTokenValue0000000000000000000/sendMessage"],
    ["bare token", "token 987654321:BBFakeTokenValue1111111111111111111 leaked"],
    ["bearer", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["api key assignment", 'api_key = "fake-value-should-not-appear"'],
    ["password", "password: hunter2hunter2"],
    ["openai style", "sk-abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["url userinfo", "https://admin:s3cretpass@internal.example.com/deploy"],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretbytes\n-----END OPENSSH PRIVATE KEY-----"],
  ];
  for (const [label, sample] of samples) {
    const redacted = redactSecrets(sample);
    assert.match(redacted, /redacted/, `${label}: expected a redaction marker`);
  }
  assert.doesNotMatch(redactSecrets(samples[0][1]), /AAFakeTokenValue/);
  assert.doesNotMatch(redactSecrets(samples[7][1]), /s3cretpass/);
  assert.doesNotMatch(redactSecrets(samples[8][1]), /AAAAsecretbytes/);
  // Ordinary prose is untouched.
  assert.equal(redactSecrets("Проверь release policy и Team ID."), "Проверь release policy и Team ID.");
});

test("redaction applies to the rendered feed text, not only to the raw payload", () => {
  const built = notification({ text: "Готово. Токен: 123456789:AAFakeTokenValue0000000000000000000" });
  assert.doesNotMatch(built.activityText, /AAFakeTokenValue/);
  assert.doesNotMatch(built.text, /AAFakeTokenValue/);
});

// ---------------------------------------------------------------------------
// Exactly-once
// ---------------------------------------------------------------------------

test("dedupe identity is logical msgId + event class, so classes never collide", () => {
  assert.equal(activityDedupeId({ kind: ACTIVITY_REQUEST, msgId: "m-1" }), "activity:request:m-1");
  assert.notEqual(
    activityDedupeId({ kind: ACTIVITY_REQUEST, msgId: "m-1" }),
    activityDedupeId({ kind: ACTIVITY_ERROR, msgId: "m-1" }),
    "a wake failure for a delivered request is a different event, not a duplicate",
  );
});

test("transport retry of the same logical message enqueues exactly one notification", () => {
  const ctx = tmp();
  try {
    const queue = new NotifyQueue(path.join(ctx.dir, "murmur.db"));
    const targets = [{ type: "telegram", channel: "telegram", botToken: "t", chatId: "c" }];
    const built = notification({ handoff: { rootMessageId: "r1", ancestry: [id("claude")] } });

    // Three deliveries of the SAME envelope: the original, a NATS redelivery, and an
    // inbound-backfill replay after a restart. All carry the same msgId.
    queue.enqueueMessage(built, targets);
    queue.enqueueMessage(built, targets);
    queue.enqueueMessage(notification({ handoff: { rootMessageId: "r1", ancestry: [id("claude")] } }), targets);
    assert.equal(queue.pendingCount(), 1, "a retried transport must not produce a second Telegram message");

    // A distinct logical message on the same conversation still gets its own entry.
    queue.enqueueMessage(notification({ msgId: "m-2" }), targets);
    assert.equal(queue.pendingCount(), 2);

    // And a wake failure for the FIRST message is a different class, so it is not swallowed.
    queue.enqueueMessage(buildActivityErrorNotification({
      localAgentId: id("codex"), senderId: id("claude"), msgId: "m-1", reason: "exhausted", text: "x",
    }), targets);
    assert.equal(queue.pendingCount(), 3);
  } finally {
    ctx.cleanup();
  }
});

test("the rendered activity text is what a Telegram target actually sends", async () => {
  const ctx = tmp();
  try {
    const queue = new NotifyQueue(path.join(ctx.dir, "murmur.db"));
    const target = { type: "telegram", channel: "telegram", botToken: "t", chatId: "c" };
    queue.enqueueMessage(notification({ handoff: { rootMessageId: "r1", ancestry: [id("claude")] } }), [target]);
    const [row] = queue.claimDue(10);
    const payload = JSON.parse(String(row.payload_json));
    assert.match(payload.activityText, /^🟣 Claude → 🔵 Codex$/m);
    assert.doesNotMatch(payload.activityText, /📨 \[/, "the raw telemetry shape is not used in activity mode");
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Classification has no other outcomes
// ---------------------------------------------------------------------------

test("classification uses only relations Murmur durably persists", () => {
  const base = { localAgentId: id("codex"), senderId: id("claude"), projectId: PROJECT_ID };
  assert.equal(classifyActivity({ ...base, handoff: { ancestry: [] } }).kind, ACTIVITY_REQUEST);
  assert.equal(classifyActivity({ ...base, replyToMessageId: "x" }).kind, ACTIVITY_REPLY);
  assert.equal(classifyActivity({ ...base, senderId: id("root") }).kind, ACTIVITY_TASK_STARTED);
  assert.equal(classifyActivity(base).kind, ACTIVITY_MESSAGE);
  // A handoff outranks a reply correlation: a delegation IS a request, whatever else it carries.
  assert.equal(classifyActivity({ ...base, handoff: { ancestry: [] }, replyToMessageId: "x" }).kind, ACTIVITY_REQUEST);
});

test("an incomplete message produces no notification at all", () => {
  assert.equal(buildActivityNotification({ localAgentId: id("codex"), senderId: id("claude"), msgId: null, text: "x" }), null);
  assert.equal(buildActivityNotification({ localAgentId: id("codex"), senderId: null, msgId: "m", text: "x" }), null);
});

// ---------------------------------------------------------------------------
// Mode / scope plumbing
// ---------------------------------------------------------------------------

const writeGlobal = async (home, mode) =>
  writeNotifyConfig({ version: 1, ...(mode ? { mode } : {}), telegram: { botToken: "fake-token", chatId: "1" } }, { home });

test("activity mode and errors mode select different behaviour for the same identity", async () => {
  const ctx = tmp();
  try {
    const config = { notifications: { source: "global", scope: SCOPE_ERRORS } };

    await writeGlobal(ctx.dir, "activity");
    const activity = await resolveNotifyPlan({ config, env: {}, home: ctx.dir });
    assert.equal(activity.scope, SCOPE_ACTIVITY);
    assert.equal(planNotifiesActivity(activity), true);
    assert.equal(planNotifiesInbound(activity), false, "activity mode must not also forward raw message text");
    assert.equal(planNotifiesErrors(activity), true, "runtime failures still reach the operator");

    await writeGlobal(ctx.dir, "errors");
    const errors = await resolveNotifyPlan({ config, env: {}, home: ctx.dir });
    assert.equal(planNotifiesActivity(errors), false);
    assert.equal(planNotifiesInbound(errors), false);
    assert.equal(planNotifiesErrors(errors), true);
  } finally {
    ctx.cleanup();
  }
});

test("a legacy inline notifier is reached by the global mode without holding a policy of its own", async () => {
  const ctx = tmp();
  try {
    await writeGlobal(ctx.dir, "activity");
    // Exactly the shape of a pre-CLI `.data-claude/agent-config.json`.
    const legacy = { notify: { telegram: { botToken: "legacy-fake", chatId: "9" } } };
    const plan = await resolveNotifyPlan({ config: legacy, env: {}, home: ctx.dir });
    assert.equal(plan.source, "inline", "the legacy identity keeps using its own credential");
    assert.equal(plan.scope, SCOPE_ACTIVITY);
    assert.equal(planNotifiesActivity(plan), true);
  } finally {
    ctx.cleanup();
  }
});

test("an explicit opt-out outranks the global mode", async () => {
  const ctx = tmp();
  try {
    await writeGlobal(ctx.dir, "activity");
    for (const notifications of [{ source: "global", scope: "off" }, { source: "none", scope: SCOPE_ACTIVITY }]) {
      const plan = await resolveNotifyPlan({ config: { notifications }, env: {}, home: ctx.dir });
      assert.equal(planNotifiesActivity(plan), false, JSON.stringify(notifications));
      assert.equal(planNotifiesErrors(plan), false, JSON.stringify(notifications));
    }
  } finally {
    ctx.cleanup();
  }
});

test("no mode configured keeps the pre-mode behaviour byte-for-byte", async () => {
  const ctx = tmp();
  try {
    await writeGlobal(ctx.dir, null);
    const root = await resolveNotifyPlan({ config: { notifications: { source: "global", scope: "all" } }, env: {}, home: ctx.dir });
    assert.equal(root.scope, "all");
    assert.equal(planNotifiesInbound(root), true);
    assert.equal(planNotifiesActivity(root), false);

    const worker = await resolveNotifyPlan({ config: { notifications: { source: "global", scope: SCOPE_ERRORS } }, env: {}, home: ctx.dir });
    assert.equal(worker.scope, SCOPE_ERRORS);
    assert.equal(planNotifiesInbound(worker), false);
  } finally {
    ctx.cleanup();
  }
});

test("an unrecognised mode fails closed instead of silently notifying more than asked", () => {
  assert.throws(
    () => validateNotifyConfig({ version: 1, mode: "everything", telegram: { botToken: "t", chatId: "1" } }),
    /mode-unsupported/,
  );
});
