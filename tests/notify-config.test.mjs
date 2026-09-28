/**
 * notify-config.test.mjs — the GLOBAL notification config and the per-identity policy
 * that decides which events actually reach the operator.
 *
 * NO NETWORK: the Telegram transport is never called here. Where a dispatch is needed it
 * is a fake, and the only credentials used are obvious fixtures.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePrivateJson } from "../scripts/secure-state.mjs";
import {
  LEGACY_INLINE_SCOPE,
  NOTIFY_CONFIG_BASENAME,
  SCOPE_ALL,
  SCOPE_ERRORS,
  SCOPE_OFF,
  defaultScopeForRole,
  describeNotifyConfig,
  isNotifyScope,
  loadNotifyConfig,
  notifyConfigPath,
  planNotifiesErrors,
  planNotifiesInbound,
  resolveNotifyPlan,
  validateNotifyConfig,
  writeNotifyConfig,
} from "../scripts/notify-config.mjs";

const FIXTURE_TOKEN = "111111:test-fixture-not-a-real-bot-token";
const FIXTURE_CHAT = "fixture-chat-id-not-real";

const telegramFixture = (overrides = {}) => ({
  version: 1,
  telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT, ...overrides },
});

const tmpHome = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-notify-"));
  return { home: path.join(dir, ".murmur"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------
test("the config path comes only from MURMUR_HOME", () => {
  assert.equal(
    notifyConfigPath({ MURMUR_HOME: "/tmp/murmur-home-x" }),
    path.join("/tmp/murmur-home-x", NOTIFY_CONFIG_BASENAME),
  );
  // A project id can never influence the notification path: the path takes no project.
  assert.equal(notifyConfigPath({}, "/explicit/home"), path.join("/explicit/home", NOTIFY_CONFIG_BASENAME));
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
test("a valid telegram config is canonicalized", () => {
  const config = validateNotifyConfig({ version: 1, telegram: { botToken: ` ${FIXTURE_TOKEN} `, chatId: FIXTURE_CHAT, topicId: 42 } });
  assert.deepEqual(config, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT, topicId: "42" } });
});

test("malformed configs fail closed with a stable reason and no value echo", () => {
  const cases = [
    [null, /not-an-object/],
    [{ version: 2, telegram: { botToken: "a", chatId: "b" } }, /version-unsupported/],
    [{ version: 1 }, /no-notifier-configured/],
    [{ version: 1, telegram: {} }, /telegram-bot-token:empty/],
    [{ version: 1, telegram: { botToken: FIXTURE_TOKEN } }, /telegram-chat-id:empty/],
    [{ version: 1, telegram: { botToken: "tok\nen", chatId: FIXTURE_CHAT } }, /telegram-bot-token:control-character/],
    [{ version: 1, telegram: [] }, /telegram-malformed/],
    [{ version: 1, webhook: { url: "ftp://example.invalid" } }, /webhook-url-not-http/],
    [{ version: 1, webhook: { url: "https://example.invalid", headers: [] } }, /webhook-headers-malformed/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => validateNotifyConfig(input), pattern);
    try {
      validateNotifyConfig(input);
    } catch (error) {
      assert.ok(!error.message.includes(FIXTURE_TOKEN), "a failure must never echo the token");
      assert.ok(!error.message.includes(FIXTURE_CHAT), "a failure must never echo the chat id");
    }
  }
});

// ---------------------------------------------------------------------------
// load / write / permissions
// ---------------------------------------------------------------------------
test("an absent global config is an ordinary state, not an error", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const loaded = await loadNotifyConfig({ home });
    assert.equal(loaded.state, "absent");
    assert.deepEqual(describeNotifyConfig(loaded), { state: "absent", telegram: "not configured", channels: [] });
  } finally {
    cleanup();
  }
});

test("writing the global config uses 0600 on the file and 0700 on its parent", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const file = await writeNotifyConfig(telegramFixture(), { home });
    assert.equal(file, path.join(home, NOTIFY_CONFIG_BASENAME));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);

    const loaded = await loadNotifyConfig({ home });
    assert.equal(loaded.state, "configured");
    assert.deepEqual(loaded.targets.map((t) => `${t.type}:${t.channel}`), ["telegram:telegram"]);
  } finally {
    cleanup();
  }
});

test("a malformed global config on disk reports invalid instead of throwing", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig(telegramFixture(), { home });
    const file = path.join(home, NOTIFY_CONFIG_BASENAME);
    writeFileSync(file, "{ not json", { mode: 0o600 });
    const loaded = await loadNotifyConfig({ home });
    assert.equal(loaded.state, "invalid");
    const summary = describeNotifyConfig(loaded);
    assert.equal(summary.telegram, "invalid");
  } finally {
    cleanup();
  }
});

test("the printable summary never contains the token, chat id or a webhook URL", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig({
      version: 1,
      telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT, topicId: "7" },
      webhook: { url: "https://hooks.example.invalid/secret-path" },
    }, { home });
    const loaded = await loadNotifyConfig({ home });
    const rendered = JSON.stringify(describeNotifyConfig(loaded));
    assert.ok(!rendered.includes(FIXTURE_TOKEN));
    assert.ok(!rendered.includes(FIXTURE_CHAT));
    assert.ok(!rendered.includes("secret-path"));
    assert.match(rendered, /"telegram":"configured"/);
    assert.match(rendered, /telegram:telegram/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// scopes and the notification policy
// ---------------------------------------------------------------------------
test("scope defaults are role-derived: operator notifies results, workers only errors", () => {
  assert.equal(defaultScopeForRole("operator"), SCOPE_ALL);
  assert.equal(defaultScopeForRole("coordinator"), SCOPE_ERRORS);
  assert.equal(defaultScopeForRole("worker"), SCOPE_ERRORS);
  assert.ok(isNotifyScope(SCOPE_OFF) && !isNotifyScope("loud"));
});

test("an identity with the global config and scope all notifies inbound and errors", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig(telegramFixture(), { home });
    const plan = await resolveNotifyPlan({
      config: { notifications: { source: "global", scope: SCOPE_ALL } },
      env: {},
      home,
    });
    assert.equal(plan.source, "global");
    assert.equal(plan.targets.length, 1);
    assert.ok(planNotifiesInbound(plan));
    assert.ok(planNotifiesErrors(plan));
  } finally {
    cleanup();
  }
});

test("scope errors suppresses inbound handoff notifications but keeps failure alerts", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig(telegramFixture(), { home });
    const plan = await resolveNotifyPlan({
      config: { notifications: { source: "global", scope: SCOPE_ERRORS } },
      env: {},
      home,
    });
    assert.equal(plan.source, "global");
    assert.equal(planNotifiesInbound(plan), false, "internal handoffs must not be notified");
    assert.equal(planNotifiesErrors(plan), true, "runtime failures must still reach the operator");
  } finally {
    cleanup();
  }
});

test("a three-worker topology produces exactly one inbound notifier: the operator identity", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig(telegramFixture(), { home });
    const roles = [
      ["root", "operator"],
      ["claude", "coordinator"],
      ["codex", "worker"],
      ["cursor", "worker"],
    ];
    const plans = [];
    for (const [, role] of roles) {
      plans.push(await resolveNotifyPlan({
        config: { notifications: { source: "global", scope: defaultScopeForRole(role) } },
        env: {},
        home,
      }));
    }
    // This is the anti-spam invariant: one operator task cannot fan out into four messages.
    assert.equal(plans.filter(planNotifiesInbound).length, 1);
    assert.equal(plans.filter(planNotifiesErrors).length, 4);
  } finally {
    cleanup();
  }
});

test("scope off and source none opt an identity out entirely", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig(telegramFixture(), { home });
    for (const notifications of [{ source: "global", scope: SCOPE_OFF }, { source: "none", scope: SCOPE_ALL }]) {
      const plan = await resolveNotifyPlan({ config: { notifications }, env: {}, home });
      assert.equal(plan.targets.length, 0);
      assert.equal(planNotifiesInbound(plan), false);
      assert.equal(planNotifiesErrors(plan), false);
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// precedence and backward compatibility
// ---------------------------------------------------------------------------
test("a legacy inline notify block still wins and keeps its historical all-inbound scope", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writeNotifyConfig(telegramFixture(), { home });
    const plan = await resolveNotifyPlan({
      config: { notify: { telegram: { botToken: "legacy:fixture", chatId: "-100999" } } },
      env: {},
      home,
    });
    assert.equal(plan.source, "inline");
    assert.equal(plan.scope, LEGACY_INLINE_SCOPE);
    assert.equal(plan.targets[0].botToken, "legacy:fixture");
    assert.ok(planNotifiesInbound(plan));
  } finally {
    cleanup();
  }
});

test("the MURMUR_TELEGRAM_* env fallback only applies when no global config exists", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const env = { MURMUR_TELEGRAM_BOT_TOKEN: "env:fixture", MURMUR_TELEGRAM_CHAT_ID: "-100888" };
    const fallback = await resolveNotifyPlan({ config: {}, env, home });
    assert.equal(fallback.source, "env");
    assert.equal(fallback.targets[0].botToken, "env:fixture");

    await writeNotifyConfig(telegramFixture(), { home });
    const global = await resolveNotifyPlan({ config: {}, env, home });
    assert.equal(global.source, "global");
    assert.equal(global.targets[0].botToken, FIXTURE_TOKEN);
  } finally {
    cleanup();
  }
});

test("no notifier anywhere is a quiet, non-throwing plan — a daemon must still start", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const plan = await resolveNotifyPlan({ config: { notifications: { source: "global", scope: SCOPE_ALL } }, env: {}, home });
    assert.equal(plan.source, "none");
    assert.deepEqual(plan.targets, []);
    assert.equal(planNotifiesInbound(plan), false);
  } finally {
    cleanup();
  }
});

test("an invalid global config degrades to no notifications rather than failing a start", async () => {
  const { home, cleanup } = tmpHome();
  try {
    await writePrivateJson(path.join(home, NOTIFY_CONFIG_BASENAME), { version: 99 });
    const plan = await resolveNotifyPlan({ config: { notifications: { source: "global", scope: SCOPE_ALL } }, env: {}, home });
    assert.equal(plan.source, "invalid");
    assert.deepEqual(plan.targets, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// repository hygiene
// ---------------------------------------------------------------------------
test("the global config is written outside any repository and never beside the code", async () => {
  const { home, cleanup } = tmpHome();
  try {
    const file = await writeNotifyConfig(telegramFixture(), { home });
    const repoRoot = path.resolve(import.meta.dirname, "..");
    assert.ok(!path.resolve(file).startsWith(`${repoRoot}${path.sep}`));
    assert.ok(!existsSync(path.join(repoRoot, NOTIFY_CONFIG_BASENAME)));
    // And the bytes on disk really are the config, not a copy left in the project.
    assert.match(readFileSync(file, "utf8"), /"version": 1/);
  } finally {
    cleanup();
  }
});
