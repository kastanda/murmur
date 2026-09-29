/**
 * notify-config.mjs — the GLOBAL (user-level) Murmur notification configuration.
 *
 * Why this exists
 * ---------------
 * Notification credentials are a MURMUR-USER setting, not a per-project bootstrap
 * secret. Before the operator CLI existed, the only place a notifier could live was a
 * repository-local legacy `agent-config.json` under `notify.telegram`, so every new
 * isolated project profile silently had no notifier at all.
 *
 * The fix is one file, outside every repository:
 *
 *   $MURMUR_HOME/notifications.json     (default ~/.murmur/notifications.json)
 *
 * It is read by `murmur-daemon.mjs` at startup and by the operator CLI. The bot token is
 * stored EXACTLY ONCE for the whole machine — no project profile, no agent config and no
 * repository ever receives a copy of it.
 *
 * Shape (v1)
 * ----------
 *   { "version": 1, "mode": "activity" | "errors" (optional),
 *                   "telegram": { "botToken", "chatId", "topicId"? },
 *                   "webhook": { "url", "headers"? } | [ ... ] }
 *
 * `telegram` / `webhook` are deliberately the SAME shape the legacy `notify` block
 * already used, so `normalizeNotifyTargets()` from `notify-router.mjs` consumes it
 * unchanged. Nothing about the Telegram transport is redesigned here.
 *
 * Security
 * --------
 * Reads and writes go exclusively through `secure-state.mjs`: 0600 file, 0700 parent,
 * owner check, `O_NOFOLLOW`, atomic temp-file + rename + fsync. Nothing in this module
 * ever returns, logs or formats a token or chat id — `describeNotifyConfig()` is the
 * only thing callers are meant to print.
 */
import path from "node:path";
import { readPrivateJson, writePrivateJson } from "./secure-state.mjs";
import { normalizeNotifyTargets } from "./notify-router.mjs";
import { murmurHome } from "./operator/project.mjs";

export const NOTIFY_CONFIG_VERSION = 1;
export const NOTIFY_CONFIG_BASENAME = "notifications.json";

/**
 * Notification SCOPE — the per-identity policy that keeps one operator task from
 * producing one Telegram message per agent in the topology.
 *
 *   all      — every inbound message, raw, plus runtime-failure notifications. The
 *              operator/root identity only ever receives the coordinator's FINAL
 *              correlated reply, so at root this is one notification per completed task.
 *   activity — the HUMAN feed: one rendered event per logical message (who asked whom,
 *              the topic, the answer, the final result), produced from the recipient's
 *              durable inbound message so a hop is never notified twice. Runtime failures
 *              are still forwarded. See `notify-activity.mjs`.
 *   errors   — runtime-failure notifications only (WakeMonitor fallback). Internal
 *              coordinator -> worker handoffs and worker -> coordinator results are NOT
 *              notified, because the operator already gets the final result from root.
 *   off      — nothing.
 */
export const SCOPE_ALL = "all";
export const SCOPE_ACTIVITY = "activity";
export const SCOPE_ERRORS = "errors";
export const SCOPE_OFF = "off";
export const NOTIFY_SCOPES = Object.freeze([SCOPE_ALL, SCOPE_ACTIVITY, SCOPE_ERRORS, SCOPE_OFF]);

/**
 * The GLOBAL notification MODE — one machine-wide switch, in the one file that already
 * holds the credential.
 *
 *   activity — every identity renders the human activity feed (see notify-activity.mjs):
 *              who asked whom, the topic, the answer, the final result. This is a policy,
 *              not a per-project setting, because the feed only reads as a conversation
 *              when every agent in the topology follows the same rule.
 *   errors   — every identity notifies runtime failures only.
 *   (absent) — exactly the historical behaviour: each identity uses its own role default
 *              (`all` at root, `errors` at a worker).
 *
 * An identity that opted OUT (`scope: "off"` or `source: "none"`) is never dragged back
 * in by the mode: a deliberate silence outranks a global default.
 */
export const MODE_ACTIVITY = SCOPE_ACTIVITY;
export const MODE_ERRORS = SCOPE_ERRORS;
export const NOTIFY_MODES = Object.freeze([MODE_ACTIVITY, MODE_ERRORS]);
export const isNotifyMode = (value) => NOTIFY_MODES.includes(value);

/** Legacy inline `notify` blocks predate scopes and must keep behaving exactly as before. */
export const LEGACY_INLINE_SCOPE = SCOPE_ALL;

/** The default scope for an operator-managed identity, by role. */
export const defaultScopeForRole = (role) => (role === "operator" ? SCOPE_ALL : SCOPE_ERRORS);

export const isNotifyScope = (value) => NOTIFY_SCOPES.includes(value);

/** Absolute path of the global notification config. Derived only from MURMUR_HOME. */
export const notifyConfigPath = (env = process.env, home = undefined) =>
  path.join(home ?? murmurHome(env), NOTIFY_CONFIG_BASENAME);

export class NotifyConfigError extends Error {
  constructor(reason, detail = null) {
    super(`invalid-notify-config:${reason}${detail ? `:${detail}` : ""}`);
    this.name = "NotifyConfigError";
    this.reason = reason;
    this.detail = detail;
  }
}

const refuse = (reason, detail) => {
  throw new NotifyConfigError(reason, detail);
};

const assertSecret = (value, reason) => {
  if (typeof value !== "string" || !value.trim()) refuse(reason, "empty");
  // Never echoed anywhere; a control character would only ever be a mangled paste.
  if (/[\u0000-\u001f\u007f]/.test(value)) refuse(reason, "control-character");
  return value.trim();
};

const normalizeTelegramSection = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) refuse("telegram-malformed");
  const botToken = assertSecret(value.botToken, "telegram-bot-token");
  const chatId = assertSecret(value.chatId, "telegram-chat-id");
  const topicId = value.topicId === undefined || value.topicId === null || value.topicId === ""
    ? undefined
    : assertSecret(String(value.topicId), "telegram-topic-id");
  return { botToken, chatId, ...(topicId ? { topicId } : {}) };
};

const normalizeWebhookEntry = (value, index) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("webhook-malformed", String(index));
  const url = assertSecret(value.url, `webhook-url-${index}`);
  if (!/^https?:\/\//.test(url)) refuse("webhook-url-not-http", String(index));
  const headers = value.headers;
  if (headers !== undefined && (headers === null || typeof headers !== "object" || Array.isArray(headers))) {
    refuse("webhook-headers-malformed", String(index));
  }
  return {
    url,
    ...(value.channel ? { channel: assertSecret(String(value.channel), `webhook-channel-${index}`) } : {}),
    ...(headers ? { headers } : {}),
  };
};

const normalizeWebhookSection = (value) => {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return undefined;
  return list.map((entry, index) => normalizeWebhookEntry(entry, index));
};

/**
 * Validate and canonicalize a parsed global notification config.
 *
 * Fails closed on anything malformed: a half-written or hand-edited config must be an
 * explicit diagnostic, never a silently disabled notifier.
 */
export const validateNotifyConfig = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("not-an-object");
  if (raw.version !== NOTIFY_CONFIG_VERSION) refuse("version-unsupported", String(raw.version));
  const telegram = normalizeTelegramSection(raw.telegram);
  const webhook = normalizeWebhookSection(raw.webhook);
  if (!telegram && !webhook) refuse("no-notifier-configured");
  // `mode` is a NON-SECRET policy field. Absent keeps the pre-mode behaviour exactly; an
  // unrecognised value fails closed rather than silently falling back to a default that
  // notifies more than the operator asked for.
  if (raw.mode !== undefined && raw.mode !== null && !isNotifyMode(raw.mode)) {
    refuse("mode-unsupported", String(raw.mode));
  }
  const mode = isNotifyMode(raw.mode) ? raw.mode : undefined;
  return {
    version: NOTIFY_CONFIG_VERSION,
    ...(mode ? { mode } : {}),
    ...(telegram ? { telegram } : {}),
    ...(webhook ? { webhook } : {}),
  };
};

/**
 * Load the global config.
 *
 * Returns a discriminated result instead of throwing, because "no notifier configured"
 * is an ORDINARY state that must never stop a daemon or a `murmur start`:
 *
 *   { state: "absent" }                      — no file (or no MURMUR_HOME yet)
 *   { state: "configured", config, targets } — valid
 *   { state: "invalid", reason }             — present but malformed/unreadable
 */
export const loadNotifyConfig = async ({ env = process.env, home = undefined, configPath = undefined } = {}) => {
  const file = configPath ?? notifyConfigPath(env, home);
  let raw;
  try {
    raw = await readPrivateJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", path: file };
    return { state: "invalid", path: file, reason: error?.message || "unreadable" };
  }
  let config;
  try {
    config = validateNotifyConfig(raw);
  } catch (error) {
    return { state: "invalid", path: file, reason: error?.message || "invalid" };
  }
  return { state: "configured", path: file, config, targets: normalizeNotifyTargets(config) };
};

/** Write the global config atomically with 0600/0700 permissions. */
export const writeNotifyConfig = async (config, { env = process.env, home = undefined, configPath = undefined } = {}) => {
  const file = configPath ?? notifyConfigPath(env, home);
  await writePrivateJson(file, validateNotifyConfig(config));
  return file;
};

/**
 * The ONLY printable view of a notification config. Reports presence and shape; never a
 * token, a chat id, a topic id or a webhook URL.
 */
export const describeNotifyConfig = (result) => {
  if (result.state === "absent") return { state: "absent", telegram: "not configured", channels: [], mode: "default" };
  if (result.state === "invalid") return { state: "invalid", telegram: "invalid", channels: [], mode: "unknown", reason: result.reason };
  const channels = (result.targets || []).map((target) => `${target.type}:${target.channel}`);
  return {
    state: "configured",
    telegram: result.config.telegram ? "configured" : "not configured",
    channels,
    mode: result.config.mode ?? "default",
  };
};

// ---------------------------------------------------------------------------
// Effective targets for one daemon identity
// ---------------------------------------------------------------------------

/**
 * Resolve what THIS identity notifies, from its agent config plus the global config.
 *
 * Precedence, deliberately ordered so nothing that works today changes:
 *
 *   1. inline `notify` targets in the agent config (the pre-CLI `.data-*` layout) —
 *      scope `all`, exactly the historical behaviour;
 *   2. the global config, when the identity is not opted out
 *      (`notifications.source === "none"`), with the identity's own scope;
 *   3. the `MURMUR_TELEGRAM_*` environment fallback (unchanged).
 *
 * `scope` is a NON-SECRET derivable field in the agent config, so a project profile
 * never holds a credential — only a policy.
 */
export const resolveNotifyPlan = async ({
  config,
  env = process.env,
  home = undefined,
  configPath = undefined,
  loadGlobal = loadNotifyConfig,
} = {}) => {
  // The global config is read FIRST, even on the inline path. A legacy `.data-*` identity
  // carries its own credential but no policy, and the machine-wide mode has to reach it
  // too — otherwise the activity feed would show the operator project and silently omit
  // every legacy hop happening on the same bus.
  const global = await loadGlobal({ env, home, configPath });
  const mode = global.state === "configured" && isNotifyMode(global.config.mode) ? global.config.mode : null;

  const inline = normalizeNotifyTargets(config?.notify);
  if (inline.length > 0) {
    return { source: "inline", scope: mode ?? LEGACY_INLINE_SCOPE, targets: inline, global, mode };
  }

  const declared = config?.notifications && typeof config.notifications === "object" ? config.notifications : {};
  const declaredScope = isNotifyScope(declared.scope) ? declared.scope : SCOPE_ALL;
  if (declared.source === "none" || declaredScope === SCOPE_OFF) {
    return { source: "none", scope: SCOPE_OFF, targets: [], global: null, mode };
  }
  // A configured mode outranks the per-role default; an explicit opt-out never loses.
  const scope = mode ?? declaredScope;

  if (global.state === "configured" && global.targets.length > 0) {
    return { source: "global", scope, targets: global.targets, global, mode };
  }

  const botToken = env.MURMUR_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const chatId = env.MURMUR_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
  const topicId = env.MURMUR_TELEGRAM_TOPIC_ID || env.TELEGRAM_TOPIC_ID;
  if (botToken && chatId) {
    return {
      source: "env",
      scope,
      targets: [{ type: "telegram", channel: "telegram", botToken, chatId, ...(topicId ? { topicId } : {}) }],
      global,
      mode,
    };
  }

  return { source: global.state === "invalid" ? "invalid" : "none", scope, targets: [], global, mode };
};

/** Raw inbound message text (the historical `all` scope). Never true in activity mode. */
export const planNotifiesInbound = (plan) => plan.targets.length > 0 && plan.scope === SCOPE_ALL;

/** The human activity feed: one rendered event per logical message. */
export const planNotifiesActivity = (plan) => plan.targets.length > 0 && plan.scope === SCOPE_ACTIVITY;

/** Runtime failures reach every scope except an explicit opt-out. */
export const planNotifiesErrors = (plan) => plan.targets.length > 0 && plan.scope !== SCOPE_OFF;
