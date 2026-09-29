/**
 * notify.mjs — operator surface for the GLOBAL notification config.
 *
 *   murmur notify status
 *   murmur notify mode <activity|errors|default>
 *   murmur notify migrate [--from <data-dir>]
 *   murmur notify test
 *
 * The credential lives in exactly one place ($MURMUR_HOME/notifications.json, see
 * `scripts/notify-config.mjs`). Nothing here prints a bot token, a chat id, a topic id or
 * a webhook URL — `describeNotifyConfig()` is the only formatted view, and the migration
 * compares legacy sources by SHA-256 FINGERPRINT so a conflict can be reported without
 * ever rendering the values that conflict.
 *
 * Legacy files are treated as READ-ONLY inputs. Migration never modifies, moves or
 * deletes a legacy `agent-config.json`.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { readPrivateJson } from "../secure-state.mjs";
import {
  NOTIFY_CONFIG_VERSION,
  NOTIFY_MODES,
  describeNotifyConfig,
  isNotifyMode,
  loadNotifyConfig,
  notifyConfigPath,
  validateNotifyConfig,
  writeNotifyConfig,
} from "../notify-config.mjs";
import { dispatchNotification } from "../notify-router.mjs";
import { redactSecrets } from "../notify-activity.mjs";

/**
 * Where a pre-CLI Murmur kept its per-agent state. `DATA_DIR` defaulted to `.data`, and
 * the one-daemon-per-agent layout used a `.data-<role>` suffix.
 */
export const LEGACY_DATA_DIRS = Object.freeze([".data", ".data-claude", ".data-codex", ".data-cursor"]);

/** Stable identity of a notifier section, safe to print. Never reversible to a secret. */
export const fingerprintTelegram = (telegram) =>
  createHash("sha256")
    .update(JSON.stringify([telegram.botToken, telegram.chatId, telegram.topicId ?? null]), "utf8")
    .digest("hex")
    .slice(0, 12);

/**
 * Read one legacy agent config and extract its `notify` block.
 *
 *   { state: "absent" }            — no file, or no notifier in it
 *   { state: "found", notify }     — a valid notifier section
 *   { state: "invalid", reason }   — present but malformed; migration fails closed
 */
export const readLegacyNotify = async (dataDir) => {
  const file = path.join(dataDir, "agent-config.json");
  let raw;
  try {
    raw = await readPrivateJson(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { state: "absent", dataDir, file };
    return { state: "invalid", dataDir, file, reason: error?.message || "unreadable" };
  }
  const notify = raw?.notify;
  if (!notify || typeof notify !== "object") return { state: "absent", dataDir, file };
  const candidate = {
    version: NOTIFY_CONFIG_VERSION,
    ...(notify.telegram ? { telegram: notify.telegram } : {}),
    ...(notify.webhook ? { webhook: notify.webhook } : {}),
  };
  if (!candidate.telegram && !candidate.webhook) return { state: "absent", dataDir, file };
  try {
    return { state: "found", dataDir, file, notify: validateNotifyConfig(candidate) };
  } catch (error) {
    return { state: "invalid", dataDir, file, reason: error?.message || "invalid" };
  }
};

/** Read every candidate legacy source, in a deterministic order. */
export const collectLegacySources = async ({ cwd = process.cwd(), dirs = LEGACY_DATA_DIRS } = {}) => {
  const results = [];
  for (const dir of dirs) {
    const resolved = path.isAbsolute(dir) ? dir : path.join(cwd, dir);
    results.push(await readLegacyNotify(resolved));
  }
  return results;
};

/**
 * Decide what a migration would do, without writing anything.
 *
 *   { action: "none" }                    — nothing to migrate
 *   { action: "invalid-source", sources } — a legacy notifier is malformed: fail closed
 *   { action: "conflict", groups }        — two legacy sources disagree: the operator chooses
 *   { action: "write", config, from }     — one agreed notifier to install
 */
export const planLegacyMigration = (sources) => {
  const invalid = sources.filter((entry) => entry.state === "invalid");
  if (invalid.length > 0) return { action: "invalid-source", sources: invalid };

  const found = sources.filter((entry) => entry.state === "found");
  if (found.length === 0) return { action: "none" };

  // Group by fingerprint: identical Claude/Cursor configs collapse to one migration.
  const groups = new Map();
  for (const entry of found) {
    const fingerprint = entry.notify.telegram
      ? fingerprintTelegram(entry.notify.telegram)
      : createHash("sha256").update(JSON.stringify(entry.notify.webhook), "utf8").digest("hex").slice(0, 12);
    const group = groups.get(fingerprint) || { fingerprint, from: [], config: entry.notify };
    group.from.push(entry.dataDir);
    groups.set(fingerprint, group);
  }
  if (groups.size > 1) return { action: "conflict", groups: [...groups.values()] };

  const [group] = [...groups.values()];
  return { action: "write", config: group.config, from: group.from, fingerprint: group.fingerprint };
};

/**
 * Migrate a legacy notifier into the global config.
 *
 * IDEMPOTENT: a global config that already matches is a no-op success; one that differs
 * is never overwritten — that is the operator's decision, not a migration's.
 */
export const migrateNotifyConfig = async ({
  cwd = process.cwd(),
  dirs = LEGACY_DATA_DIRS,
  env = process.env,
  home = undefined,
  configPath = undefined,
} = {}) => {
  const file = configPath ?? notifyConfigPath(env, home);
  const existing = await loadNotifyConfig({ env, home, configPath: file });
  const sources = await collectLegacySources({ cwd, dirs });
  const plan = planLegacyMigration(sources);

  if (existing.state === "invalid") {
    return { ok: false, reason: "global-config-invalid", path: file, detail: existing.reason };
  }
  if (existing.state === "configured") {
    if (plan.action === "write" && JSON.stringify(existing.config) === JSON.stringify(plan.config)) {
      return { ok: true, changed: false, reason: "already-migrated", path: file, from: plan.from };
    }
    return { ok: true, changed: false, reason: "already-configured", path: file };
  }
  if (plan.action === "invalid-source") {
    return { ok: false, reason: "legacy-config-invalid", path: file, sources: plan.sources };
  }
  if (plan.action === "conflict") {
    return { ok: false, reason: "legacy-config-conflict", path: file, groups: plan.groups };
  }
  if (plan.action === "none") {
    return { ok: false, reason: "no-legacy-config", path: file, searched: sources.map((entry) => entry.dataDir) };
  }

  await writeNotifyConfig(plan.config, { env, home, configPath: file });
  return { ok: true, changed: true, reason: "migrated", path: file, from: plan.from };
};

/**
 * Send ONE explicit test notification through every configured target.
 *
 * Only ever invoked by `murmur notify test`; `murmur start` never sends one.
 */
export const sendNotifyTest = async ({
  env = process.env,
  home = undefined,
  configPath = undefined,
  dispatch = dispatchNotification,
  now = () => new Date().toISOString(),
} = {}) => {
  const loaded = await loadNotifyConfig({ env, home, configPath });
  if (loaded.state !== "configured") return { ok: false, reason: loaded.state, path: loaded.path };
  const payload = {
    msgId: `notify-test-${now()}`,
    from: "murmur",
    text: `Murmur notification test (${now()}). If you can read this, operator notifications work.`,
  };
  const results = [];
  for (const target of loaded.targets) {
    const label = `${target.type}:${target.channel}`;
    try {
      await dispatch(target, payload);
      results.push({ target: label, ok: true });
    } catch (error) {
      // A transport error can echo a request URL, which contains the bot token.
      results.push({ target: label, ok: false, error: redactTransportError(error) });
    }
  }
  return { ok: results.every((entry) => entry.ok), reason: "sent", results };
};

/**
 * Transport errors are the one place a token could leak into operator output: the
 * Telegram endpoint embeds it in the path. Strip anything URL-shaped, and anything after
 * `/bot`, before the message is ever printed.
 */
export const redactTransportError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message)
    .replace(/https?:\/\/\S+/g, "<url-redacted>")
    .replace(/\/bot[^/\s]+/g, "/bot<redacted>")
    .slice(0, 200);
};

/**
 * Set (or clear) the machine-wide notification MODE.
 *
 * Rewrites ONLY the `mode` field: the credential is read back and written through the
 * same validated shape, so this never reformats, re-derives or re-prints a token. Passing
 * `default` removes the field and restores the per-role behaviour.
 */
export const setNotifyMode = async ({ mode, env = process.env, home = undefined, configPath = undefined } = {}) => {
  const file = configPath ?? notifyConfigPath(env, home);
  if (mode !== "default" && !isNotifyMode(mode)) return { ok: false, reason: "mode-unsupported", path: file, mode };
  const loaded = await loadNotifyConfig({ env, home, configPath: file });
  if (loaded.state !== "configured") return { ok: false, reason: loaded.state, path: file };
  const { mode: previous, ...rest } = loaded.config;
  const next = mode === "default" ? rest : { ...rest, mode };
  if ((previous ?? "default") === mode) return { ok: true, changed: false, path: file, mode, previous: previous ?? "default" };
  await writeNotifyConfig(next, { env, home, configPath: file });
  return { ok: true, changed: true, path: file, mode, previous: previous ?? "default" };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const NOTIFY_USAGE = `murmur notify — global (user-level) notification configuration

Usage:
  murmur notify status
  murmur notify mode <activity|errors|default>
  murmur notify migrate [--from <legacy-data-dir>]
  murmur notify test

Modes:
  activity   human activity feed — who asked whom, the topic, the answer, the result
  errors     runtime failures only
  default    per-role behaviour (all at root, errors at a worker)

The configuration lives in $MURMUR_HOME/notifications.json (0600, default
~/.murmur/notifications.json) and is shared by every Murmur project. No token is ever
copied into a project profile, an agent config or a repository.
`;

/**
 * `murmur notify <subcommand>`.
 *
 * Exit codes: 0 ok · 1 usage/failure · 3 not configured (so scripts can branch on it).
 */
export const commandNotify = async ({ args, flags, out, err, env = process.env, home = undefined, cwd = process.cwd() }) => {
  const subcommand = args[0];
  const configPath = notifyConfigPath(env, home);

  if (!subcommand || subcommand === "help") {
    out(NOTIFY_USAGE);
    return subcommand ? 0 : 1;
  }

  if (subcommand === "status") {
    const loaded = await loadNotifyConfig({ env, home, configPath });
    const summary = describeNotifyConfig(loaded);
    if (flags.json) {
      out(JSON.stringify({ path: configPath, ...summary }, null, 2));
    } else {
      out(`Config:    ${configPath}`);
      out(`Telegram:  ${summary.telegram}`);
      out(`Mode:      ${summary.mode}`);
      if (summary.channels.length > 0) out(`Channels:  ${summary.channels.join(", ")}`);
      if (summary.state === "invalid") out(`State:     invalid (${summary.reason})`);
      if (summary.state === "absent") out("Run `murmur notify migrate` (or write the config by hand) to configure notifications.");
    }
    if (summary.state === "configured") return 0;
    return summary.state === "invalid" ? 1 : 3;
  }

  if (subcommand === "mode") {
    const mode = args[1];
    if (!mode) {
      err(`murmur: notify mode requires one of: ${[...NOTIFY_MODES, "default"].join(", ")}`);
      return 1;
    }
    const result = await setNotifyMode({ mode, env, home, configPath });
    if (result.reason === "absent") {
      err("murmur: notifications are not configured. Run `murmur notify migrate` first.");
      return 3;
    }
    if (result.reason === "invalid") {
      err(`murmur: the notification config is invalid: ${configPath}`);
      return 1;
    }
    if (!result.ok) {
      err(`murmur: unsupported notify mode '${mode}' — expected ${[...NOTIFY_MODES, "default"].join(", ")}`);
      return 1;
    }
    out(result.changed ? `Notification mode: ${result.previous} -> ${result.mode}` : `Notification mode is already ${result.mode}`);
    if (result.mode === "activity") {
      out("Running daemons pick this up on their next policy reload; a daemon started");
      out("before this change reads it at its next restart.");
    }
    return 0;
  }

  if (subcommand === "migrate") {
    const dirs = flags.from ? [flags.from] : undefined;
    const result = await migrateNotifyConfig({ cwd, dirs, env, home, configPath });
    if (result.ok && result.changed) {
      out(`Migrated notification config from ${result.from.map((dir) => path.basename(dir)).join(", ")}`);
      out(`Wrote ${result.path} (0600). The legacy files were not modified.`);
      out("Every `murmur start <project>` now uses it — no per-project setup.");
      return 0;
    }
    if (result.ok) {
      out(`Notifications are already configured: ${result.path}`);
      out("Nothing to migrate. Remove that file first if you want to re-import a legacy config.");
      return 0;
    }
    if (result.reason === "no-legacy-config") {
      err("murmur: no legacy notification config found.");
      err(`Searched: ${result.searched.map((dir) => path.basename(dir)).join(", ")} under ${cwd}`);
      err("Pass --from <legacy-data-dir>, or write the config by hand.");
      return 1;
    }
    if (result.reason === "legacy-config-conflict") {
      err("murmur: legacy notification configs disagree — refusing to pick one for you.");
      for (const group of result.groups) {
        err(`  variant ${group.fingerprint}: ${group.from.map((dir) => path.basename(dir)).join(", ")}`);
      }
      err("Re-run with --from <legacy-data-dir> to choose the one you want.");
      return 1;
    }
    if (result.reason === "legacy-config-invalid") {
      err("murmur: a legacy notification config is malformed — refusing to migrate it.");
      for (const source of result.sources) err(`  ${path.basename(source.dataDir)}: ${source.reason}`);
      return 1;
    }
    err(`murmur: cannot migrate — ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    return 1;
  }

  if (subcommand === "test") {
    const result = await sendNotifyTest({ env, home, configPath });
    if (result.reason === "absent") {
      err("murmur: notifications are not configured. Run `murmur notify migrate`.");
      return 3;
    }
    if (result.reason === "invalid") {
      err(`murmur: the notification config is invalid: ${configPath}`);
      return 1;
    }
    for (const entry of result.results) {
      out(entry.ok ? `  sent     ${entry.target}` : `  FAILED   ${entry.target}: ${entry.error}`);
    }
    return result.ok ? 0 : 1;
  }

  err(`murmur: unknown notify subcommand '${subcommand}'`);
  err(NOTIFY_USAGE);
  return 1;
};
