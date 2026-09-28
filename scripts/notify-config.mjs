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
 *   { "version": 1, "telegram": { "botToken", "chatId", "topicId"? },
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
 *   all    — every inbound message plus runtime-failure notifications. The operator/root
 *            identity only ever receives the coordinator's FINAL correlated reply, so at
 *            root this is exactly one notification per completed task.
 *   errors — runtime-failure notifications only (WakeMonitor fallback). Internal
 *            coordinator -> worker handoffs and worker -> coordinator results are NOT
 *            notified, because the operator already gets the final result from root.
 *   off    — nothing.
 */
export const SCOPE_ALL = "all";
export const SCOPE_ERRORS = "errors";
export const SCOPE_OFF = "off";
export const NOTIFY_SCOPES = Object.freeze([SCOPE_ALL, SCOPE_ERRORS, SCOPE_OFF]);

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
  return {
    version: NOTIFY_CONFIG_VERSION,
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
  if (result.state === "absent") return { state: "absent", telegram: "not configured", channels: [] };
  if (result.state === "invalid") return { state: "invalid", telegram: "invalid", channels: [], reason: result.reason };
  const channels = (result.targets || []).map((target) => `${target.type}:${target.channel}`);
  return {
    state: "configured",
    telegram: result.config.telegram ? "configured" : "not configured",
    channels,
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
  const inline = normalizeNotifyTargets(config?.notify);
  if (inline.length > 0) {
    return { source: "inline", scope: LEGACY_INLINE_SCOPE, targets: inline, global: null };
  }

  const declared = config?.notifications && typeof config.notifications === "object" ? config.notifications : {};
  const scope = isNotifyScope(declared.scope) ? declared.scope : SCOPE_ALL;
  if (declared.source === "none" || scope === SCOPE_OFF) {
    return { source: "none", scope: SCOPE_OFF, targets: [], global: null };
  }

  const global = await loadGlobal({ env, home, configPath });
  if (global.state === "configured" && global.targets.length > 0) {
    return { source: "global", scope, targets: global.targets, global };
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
    };
  }

  return { source: global.state === "invalid" ? "invalid" : "none", scope, targets: [], global };
};

/** Does this plan notify ordinary inbound messages, or only runtime failures? */
export const planNotifiesInbound = (plan) => plan.targets.length > 0 && plan.scope === SCOPE_ALL;
export const planNotifiesErrors = (plan) => plan.targets.length > 0 && plan.scope !== SCOPE_OFF;
