/**
 * notify-summarizer.mjs — a tiny Russian retelling of one agent message, for the feed.
 *
 * Why a model at all
 * ------------------
 * Everything else in the activity feed is deterministic, and stays that way: labels,
 * verdicts, failure reasons and topic extraction are fixed vocabulary and fixed rules.
 * But the agents deliberate in English, and no fixed rule turns a paragraph of English
 * review prose into a Russian sentence. Without one, a Russian reader gets a truncated
 * English excerpt — readable to the machine, not to them.
 *
 * What this is NOT
 * ----------------
 * Not a new provider, not a new dependency, not a new credential. It reuses the `claude`
 * CLI the project is already configured and authenticated with, invoked exactly the way
 * `claude-one-shot-runtime.mjs` already invokes it, with tools disabled — so it is one
 * bounded text call, not an agent runtime, not a Murmur task, and not a handoff.
 *
 * The contract it lives under
 * ---------------------------
 * A notification is OBSERVABILITY. It may never delay, fail or alter the work itself:
 *
 *   - the caller passes ALREADY-REDACTED text (see the security note below);
 *   - every failure mode — timeout, missing binary, non-zero exit, malformed or empty
 *     output, output that is not actually Russian — returns `null`, never throws, and the
 *     caller falls back to the deterministic excerpt;
 *   - there is exactly ONE attempt. A retry storm for a chat message is not worth a
 *     process spawn, and the fallback is already acceptable;
 *   - the result is bounded and normalized before anyone renders it.
 *
 * SECURITY: this module must only ever be handed text that `redactSecrets()` has already
 * processed. It is the one place in the feed where message content leaves the machine's
 * own process tree, so redaction happens BEFORE the call, never after. The prompt builder
 * re-applies redaction as a belt-and-braces second pass rather than trusting its caller.
 */
import { randomUUID } from "node:crypto";
import { redactSecrets } from "./notify-activity.mjs";

/** Hard ceiling on what a summary may occupy in a phone notification. */
export const SUMMARY_MAX_CHARS = 300;

/**
 * One bounded attempt. Past this the deterministic excerpt is simply better than waiting.
 *
 * Measured on this workload: ~9s idle, ~13s with the agent daemons busy, and over 15s
 * while a task is actually running — which is exactly when summaries are wanted. The
 * budget is set above that observed spread rather than at it. It costs nothing on the
 * critical path: the caller does not await this before dispatching work, so a slow
 * summary delays only the notification.
 */
export const SUMMARY_TIMEOUT_MS = 20_000;

/**
 * A small, fast model is the right tool: the job is one short retelling, and a slow model
 * would spend the whole latency budget before producing anything.
 */
export const SUMMARY_MODEL = "claude-haiku-4-5-20251001";

/** What the feed calls each event, so the model knows what it is retelling. */
const KIND_HINTS = Object.freeze({
  "task-started": "пользователь ставит задачу агенту",
  request: "агент делегирует часть работы другому агенту",
  reply: "агент возвращает результат тому, кто его попросил",
  final: "агент возвращает итоговый результат пользователю",
  message: "сообщение между агентами",
  error: "сбой при обработке сообщения",
});

/**
 * The instruction. Deliberately narrow: retell, do not analyse, do not add, do not
 * decorate. The constraints that matter are the ones that keep the output HONEST —
 * inventing a fact in an observability feed is worse than showing English.
 */
export const buildSummaryPrompt = ({ text, kind = "message", topic = null, from = null, to = null, project = null }) => {
  const safeText = redactSecrets(String(text ?? ""));
  const context = [
    project ? `Проект: ${project}.` : null,
    from && to ? `Отправитель: ${from}. Получатель: ${to}.` : null,
    KIND_HINTS[kind] ? `Тип события: ${KIND_HINTS[kind]}.` : null,
    topic ? `Тема: ${topic}` : null,
  ].filter(Boolean).join(" ");

  return [
    "Кратко перескажи смысл сообщения по-русски для владельца проекта.",
    "Не добавляй фактов, которых нет в исходном тексте.",
    "Сохраняй технические названия и идентификаторы как есть (Team ID, provisioning profile, API, Codex, Cursor и подобные).",
    "Не пиши вводных фраз, заголовков, markdown и рассуждений.",
    `Ответ — только связный русский текст, не длиннее ${SUMMARY_MAX_CHARS} символов.`,
    "",
    ...(context ? [context, ""] : []),
    "Исходное сообщение:",
    safeText,
  ].join("\n");
};

/**
 * A wrapper, a fence or a "Вот краткое содержание:" preamble is decoration, not content.
 *
 * `\p{L}` rather than `\w`: `\w` is ASCII-only even under `/u`, so a Cyrillic stem never
 * matched and every preamble survived into the feed. `итог` is deliberately NOT on this
 * list — "Итоги проверки:" is a real sentence a reviewer writes, not a preamble.
 */
const PREAMBLE = /^(?:вот\s+)?(?:крат\p{L}*|резюме|сводка|перевод|содержание|summary)[^:\n]{0,40}:\s*/iu;

/**
 * Bring a model's answer to something safe to paste into a chat.
 *
 * Returns `null` for anything that is not a usable Russian sentence, so a confused or
 * empty response falls back instead of rendering as noise.
 */
export const normalizeSummary = (raw, { maxChars = SUMMARY_MAX_CHARS } = {}) => {
  // A model that wrapped its WHOLE answer in a fence has still answered: unwrap it rather
  // than stripping it, which deleted the summary and silently fell back to English.
  const unfenced = String(raw ?? "").trim().replace(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i, "$1");
  let value = unfenced
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```/g, " ")
    // `_` is NOT stripped: markdown emphasis is rare in a one-line summary, but an
    // underscore inside an identifier is common and load-bearing. Treating it as emphasis
    // turned `SIGNING_CHECK_OK` into `SIGNINGCHECKOK` — mangling the exact token the
    // summary exists to preserve.
    .replace(/[*`~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(PREAMBLE, "")
    .replace(/^["«']+|["»']+$/g, "")
    .trim();
  if (!value) return null;

  // A model that answered in English has not done the one job this exists for.
  const cyrillic = (value.match(/[Ѐ-ӿ]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  if (cyrillic < 3 || cyrillic / (cyrillic + latin) < 0.2) return null;

  if (value.length > maxChars) {
    const cut = value.slice(0, maxChars - 1);
    const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("."));
    value = `${(boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  }
  return redactSecrets(value);
};

/**
 * Build the summarizer the daemon uses, or `null` when summarization is switched off.
 *
 * The returned function NEVER throws and NEVER retries. It resolves to a normalized
 * Russian string, or to `null` meaning "use the deterministic excerpt".
 */
export const createClaudeSummarizer = ({
  runner,
  model = SUMMARY_MODEL,
  timeoutMs = SUMMARY_TIMEOUT_MS,
  cwd = process.cwd(),
  maxChars = SUMMARY_MAX_CHARS,
  log = () => {},
} = {}) => {
  if (typeof runner !== "function") return null;
  return async (input) => {
    const startedAt = Date.now();
    try {
      const result = await runner({
        prompt: buildSummaryPrompt(input),
        sessionId: randomUUID(),
        resume: false,
        cwd,
        permissionMode: "dontAsk",
        model,
        timeoutMs,
        // A summary session is throwaway: nothing resumes it and nothing reads it back.
        terminateGraceMs: 2_000,
      });
      const summary = normalizeSummary(result?.text, { maxChars });
      if (!summary) {
        // `debug` on purpose: an unusable summary is an ordinary, recoverable outcome, and
        // the operator already sees the fallback text in Telegram.
        log("debug", "Activity summary unusable; falling back to the deterministic excerpt", {
          msgId: input?.msgId, elapsedMs: Date.now() - startedAt,
        });
      }
      return summary;
    } catch (error) {
      log("debug", "Activity summary unavailable; falling back to the deterministic excerpt", {
        msgId: input?.msgId,
        elapsedMs: Date.now() - startedAt,
        // The message can carry a spawn path or a CLI error; redact it like any other text.
        reason: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
      return null;
    }
  };
};
