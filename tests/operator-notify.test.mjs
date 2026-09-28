/**
 * operator-notify.test.mjs — `murmur notify` (status / migrate / test), the legacy
 * migration rules, and how a project profile picks up the global config.
 *
 * NO NETWORK: `notify test` is exercised with a FAKE transport. The only credentials here
 * are obvious fixtures, and several assertions exist purely to prove that no command ever
 * prints one.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPrivateJson, writePrivateJson } from "../scripts/secure-state.mjs";
import {
  NOTIFY_CONFIG_BASENAME,
  SCOPE_ALL,
  SCOPE_ERRORS,
  loadNotifyConfig,
  planNotifiesErrors,
  planNotifiesInbound,
  resolveNotifyPlan,
} from "../scripts/notify-config.mjs";
import { NotifyQueue } from "../scripts/notify-router.mjs";
import {
  collectLegacySources,
  commandNotify,
  fingerprintTelegram,
  migrateNotifyConfig,
  planLegacyMigration,
  readLegacyNotify,
  redactTransportError,
  sendNotifyTest,
} from "../scripts/operator/notify.mjs";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";
import { PASS, WARN, checkNotifications, hasFatal } from "../scripts/operator/doctor.mjs";

const FIXTURE_TOKEN = "222222:test-fixture-not-a-real-bot-token";
const FIXTURE_CHAT = "other-fixture-chat-id-not-real";
const OTHER_TOKEN = "333333:different-fixture-token";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const setup = () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-not-"));
  const cwd = path.join(dir, "repo");
  mkdirSync(cwd, { recursive: true });
  return {
    dir,
    cwd,
    home: path.join(dir, ".murmur"),
    configPath: path.join(dir, ".murmur", NOTIFY_CONFIG_BASENAME),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** Write a legacy `<cwd>/<name>/agent-config.json` with a `notify.telegram` block. */
const legacyConfig = async (cwd, name, telegram) => {
  const dataDir = path.join(cwd, name);
  await writePrivateJson(path.join(dataDir, "agent-config.json"), {
    agentId: name.replace(/^\.data-?/, "") || "agent",
    natsUrl: "nats://127.0.0.1:4222",
    keys: { encryption: { publicKey: "pub", privateKey: "priv" } },
    notify: { telegram },
  });
  return dataDir;
};

/** Capture CLI output so assertions can prove a secret never reaches a stream. */
const capture = () => {
  const lines = { out: [], err: [] };
  return {
    lines,
    out: (line = "") => lines.out.push(line),
    err: (line = "") => lines.err.push(line),
    text: () => [...lines.out, ...lines.err].join("\n"),
  };
};

const noSecrets = (text) => {
  assert.ok(!text.includes(FIXTURE_TOKEN), "output must never contain the bot token");
  assert.ok(!text.includes(OTHER_TOKEN), "output must never contain the bot token");
  assert.ok(!text.includes(FIXTURE_CHAT), "output must never contain the chat id");
};

// ---------------------------------------------------------------------------
// reading legacy state
// ---------------------------------------------------------------------------
test("a legacy config without a notify block is simply absent", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(path.join(ctx.cwd, ".data-codex", "agent-config.json"), { agentId: "codex" });
    const result = await readLegacyNotify(path.join(ctx.cwd, ".data-codex"));
    assert.equal(result.state, "absent");
    const missing = await readLegacyNotify(path.join(ctx.cwd, ".data-nope"));
    assert.equal(missing.state, "absent");
  } finally {
    ctx.cleanup();
  }
});

test("a malformed legacy notify block is invalid, and the reason carries no values", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN });
    const result = await readLegacyNotify(path.join(ctx.cwd, ".data-claude"));
    assert.equal(result.state, "invalid");
    assert.match(result.reason, /telegram-chat-id/);
    noSecrets(result.reason);
  } finally {
    ctx.cleanup();
  }
});

test("the fingerprint identifies a notifier without revealing it", async () => {
  const same = fingerprintTelegram({ botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
  assert.equal(same, fingerprintTelegram({ botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT }));
  assert.notEqual(same, fingerprintTelegram({ botToken: OTHER_TOKEN, chatId: FIXTURE_CHAT }));
  assert.notEqual(same, fingerprintTelegram({ botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT, topicId: "9" }));
  noSecrets(same);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------
test("migrating the legacy Claude config writes the global config with 0600/0700", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    const result = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.path, ctx.configPath);

    assert.equal(statSync(ctx.configPath).mode & 0o777, 0o600);
    assert.equal(statSync(ctx.home).mode & 0o777, 0o700);
    const written = await readPrivateJson(ctx.configPath);
    assert.deepEqual(written, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
  } finally {
    ctx.cleanup();
  }
});

test("identical Claude and Cursor legacy configs deduplicate into one migration", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    await legacyConfig(ctx.cwd, ".data-cursor", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    const sources = await collectLegacySources({ cwd: ctx.cwd });
    const plan = planLegacyMigration(sources);
    assert.equal(plan.action, "write");
    assert.equal(plan.from.length, 2);

    const result = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(result.changed, true);
    assert.deepEqual(result.from.map((dir) => path.basename(dir)), [".data-claude", ".data-cursor"]);
  } finally {
    ctx.cleanup();
  }
});

test("materially different legacy configs fail closed and name only the directories", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    await legacyConfig(ctx.cwd, ".data-cursor", { botToken: OTHER_TOKEN, chatId: FIXTURE_CHAT });
    const result = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "legacy-config-conflict");
    assert.equal(result.groups.length, 2);
    assert.equal(existsSync(ctx.configPath), false, "a conflict must never write a config");
    noSecrets(JSON.stringify(result.groups.map((group) => ({ f: group.fingerprint, from: group.from }))));
  } finally {
    ctx.cleanup();
  }
});

test("--from lets the operator resolve a conflict explicitly", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    await legacyConfig(ctx.cwd, ".data-cursor", { botToken: OTHER_TOKEN, chatId: FIXTURE_CHAT });
    const result = await migrateNotifyConfig({
      cwd: ctx.cwd,
      dirs: [".data-cursor"],
      home: ctx.home,
      env: {},
    });
    assert.equal(result.changed, true);
    const written = await readPrivateJson(ctx.configPath);
    assert.equal(written.telegram.botToken, OTHER_TOKEN);
  } finally {
    ctx.cleanup();
  }
});

test("a malformed legacy config aborts the migration instead of skipping it", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    await legacyConfig(ctx.cwd, ".data-cursor", { botToken: FIXTURE_TOKEN });
    const result = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "legacy-config-invalid");
    assert.equal(existsSync(ctx.configPath), false);
  } finally {
    ctx.cleanup();
  }
});

test("migration is idempotent: a second run changes nothing and still succeeds", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    const before = await readPrivateJson(ctx.configPath);

    const again = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(again.reason, "already-migrated");
    assert.deepEqual(await readPrivateJson(ctx.configPath), before);
  } finally {
    ctx.cleanup();
  }
});

test("an existing global config is never overwritten by a different legacy config", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: OTHER_TOKEN, chatId: FIXTURE_CHAT } });
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    const result = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "already-configured");
    assert.equal((await readPrivateJson(ctx.configPath)).telegram.botToken, OTHER_TOKEN);
  } finally {
    ctx.cleanup();
  }
});

test("migration never modifies or removes the legacy files", async () => {
  const ctx = setup();
  try {
    const dataDir = await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    const legacyFile = path.join(dataDir, "agent-config.json");
    const before = statSync(legacyFile);
    await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    const after = statSync(legacyFile);
    assert.equal(existsSync(legacyFile), true);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.ok((await readPrivateJson(legacyFile)).notify.telegram.botToken, "the legacy notifier is left intact");
  } finally {
    ctx.cleanup();
  }
});

test("with nothing to migrate the command reports it and writes no file", async () => {
  const ctx = setup();
  try {
    const result = await migrateNotifyConfig({ cwd: ctx.cwd, home: ctx.home, env: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-legacy-config");
    assert.equal(existsSync(ctx.configPath), false);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------
test("notify status says configured / not configured and nothing else", async () => {
  const ctx = setup();
  try {
    const before = capture();
    assert.equal(await commandNotify({ args: ["status"], flags: {}, out: before.out, err: before.err, env: {}, home: ctx.home, cwd: ctx.cwd }), 3);
    assert.match(before.text(), /Telegram:\s+not configured/);

    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT, topicId: "11" } });
    const after = capture();
    assert.equal(await commandNotify({ args: ["status"], flags: {}, out: after.out, err: after.err, env: {}, home: ctx.home, cwd: ctx.cwd }), 0);
    assert.match(after.text(), /Telegram:\s+configured/);
    noSecrets(after.text());
    assert.ok(!after.text().includes("11"), "the topic id is not printed either");
  } finally {
    ctx.cleanup();
  }
});

test("notify status --json stays redacted too", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const io = capture();
    await commandNotify({ args: ["status"], flags: { json: true }, out: io.out, err: io.err, env: {}, home: ctx.home, cwd: ctx.cwd });
    const parsed = JSON.parse(io.lines.out.join("\n"));
    assert.equal(parsed.state, "configured");
    assert.equal(parsed.telegram, "configured");
    noSecrets(io.text());
  } finally {
    ctx.cleanup();
  }
});

test("notify migrate prints a conflict without printing what conflicts", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    await legacyConfig(ctx.cwd, ".data-cursor", { botToken: OTHER_TOKEN, chatId: FIXTURE_CHAT });
    const io = capture();
    const code = await commandNotify({ args: ["migrate"], flags: {}, out: io.out, err: io.err, env: {}, home: ctx.home, cwd: ctx.cwd });
    assert.equal(code, 1);
    assert.match(io.text(), /disagree/);
    assert.match(io.text(), /--from/);
    noSecrets(io.text());
  } finally {
    ctx.cleanup();
  }
});

test("notify migrate --from succeeds and reports only directory names", async () => {
  const ctx = setup();
  try {
    await legacyConfig(ctx.cwd, ".data-claude", { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT });
    const io = capture();
    const code = await commandNotify({
      args: ["migrate"],
      flags: { from: ".data-claude" },
      out: io.out,
      err: io.err,
      env: {},
      home: ctx.home,
      cwd: ctx.cwd,
    });
    assert.equal(code, 0);
    assert.match(io.text(), /\.data-claude/);
    noSecrets(io.text());
    assert.equal((await loadNotifyConfig({ home: ctx.home, env: {} })).state, "configured");
  } finally {
    ctx.cleanup();
  }
});

test("an unknown notify subcommand is a usage error", async () => {
  const ctx = setup();
  try {
    const io = capture();
    assert.equal(await commandNotify({ args: ["explode"], flags: {}, out: io.out, err: io.err, env: {}, home: ctx.home, cwd: ctx.cwd }), 1);
    assert.match(io.text(), /unknown notify subcommand/);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// notify test — fake transport only
// ---------------------------------------------------------------------------
test("notify test dispatches exactly one message per target through the transport", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const sent = [];
    const result = await sendNotifyTest({
      env: {},
      home: ctx.home,
      dispatch: async (target, payload) => sent.push({ target, payload }),
    });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.type, "telegram");
    assert.match(sent[0].payload.text, /Murmur notification test/);
  } finally {
    ctx.cleanup();
  }
});

test("notify test refuses politely when nothing is configured", async () => {
  const ctx = setup();
  try {
    const result = await sendNotifyTest({ env: {}, home: ctx.home, dispatch: async () => { throw new Error("must not dispatch"); } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "absent");
  } finally {
    ctx.cleanup();
  }
});

test("a transport error is redacted before it can be printed", () => {
  const leaky = new Error(`telegram-http-401:https://api.telegram.org/bot${FIXTURE_TOKEN}/sendMessage failed`);
  const redacted = redactTransportError(leaky);
  assert.ok(!redacted.includes(FIXTURE_TOKEN));
  assert.match(redacted, /telegram-http-401/);
  assert.equal(redactTransportError(new Error(`/bot${FIXTURE_TOKEN}/sendMessage`)), "/bot<redacted>/sendMessage");
});

test("a failing transport surfaces the failure without the credential", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const io = capture();
    const result = await sendNotifyTest({
      env: {},
      home: ctx.home,
      dispatch: async () => {
        throw new Error(`telegram-http-401:https://api.telegram.org/bot${FIXTURE_TOKEN}/sendMessage`);
      },
    });
    assert.equal(result.ok, false);
    for (const entry of result.results) io.out(`  FAILED ${entry.target}: ${entry.error}`);
    noSecrets(io.text());
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// project profiles: existing and future
// ---------------------------------------------------------------------------
const bootstrap = async (ctx) => {
  const projectPath = path.join(ctx.dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: ctx.home });
  const result = await bootstrapProfile({ projectId, projectPath, paths });
  return { projectPath, projectId, paths, result };
};

test("a NEW project profile gets the notification policy automatically, and no credential", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const { paths } = await bootstrap(ctx);

    const expected = { root: SCOPE_ALL, claude: SCOPE_ERRORS, codex: SCOPE_ERRORS, cursor: SCOPE_ERRORS };
    for (const [role, scope] of Object.entries(expected)) {
      const config = await readPrivateJson(paths.agentConfigFile(role));
      assert.deepEqual(config.notifications, { source: "global", scope }, `${role} policy`);
      // The whole point: the profile holds a POLICY, never a credential.
      const serialized = JSON.stringify(config);
      assert.ok(!serialized.includes(FIXTURE_TOKEN), `${role} must not hold the bot token`);
      assert.ok(!serialized.includes(FIXTURE_CHAT), `${role} must not hold the chat id`);
      assert.equal(config.notify, undefined, `${role} must not gain an inline notify block`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("an EXISTING profile created before global notifications is repaired in place", async () => {
  const ctx = setup();
  try {
    const { projectPath, projectId, paths } = await bootstrap(ctx);

    // Simulate the pre-slice profile: identities and keys exist, the policy does not.
    const keysBefore = {};
    for (const role of ["root", "claude", "codex", "cursor"]) {
      const config = await readPrivateJson(paths.agentConfigFile(role));
      keysBefore[role] = config.keys.signing.privateKey;
      delete config.notifications;
      await writePrivateJson(paths.agentConfigFile(role), config);
    }

    const repair = await bootstrapProfile({ projectId, projectPath, paths });
    assert.equal(repair.created, false);
    assert.equal(repair.repaired, true);
    assert.deepEqual(
      repair.repairs.filter((entry) => entry.startsWith("notifications:")).sort(),
      ["notifications:claude", "notifications:codex", "notifications:cursor", "notifications:root"],
    );
    for (const role of ["root", "claude", "codex", "cursor"]) {
      const config = await readPrivateJson(paths.agentConfigFile(role));
      assert.equal(config.notifications.source, "global");
      // No identity was regenerated and no key rotated.
      assert.equal(config.keys.signing.privateKey, keysBefore[role]);
    }
  } finally {
    ctx.cleanup();
  }
});

test("an operator's own scope choice survives repair", async () => {
  const ctx = setup();
  try {
    const { projectPath, projectId, paths } = await bootstrap(ctx);
    const config = await readPrivateJson(paths.agentConfigFile("root"));
    config.notifications = { source: "global", scope: "off" };
    await writePrivateJson(paths.agentConfigFile("root"), config);

    const repair = await bootstrapProfile({ projectId, projectPath, paths });
    assert.equal(repair.repairs.some((entry) => entry === "notifications:root"), false);
    assert.deepEqual((await readPrivateJson(paths.agentConfigFile("root"))).notifications, { source: "global", scope: "off" });
  } finally {
    ctx.cleanup();
  }
});

test("bootstrapping a profile never creates a notification config inside the project", async () => {
  const ctx = setup();
  try {
    const { projectPath } = await bootstrap(ctx);
    assert.equal(existsSync(path.join(projectPath, NOTIFY_CONFIG_BASENAME)), false);
    assert.equal(existsSync(path.join(projectPath, ".murmur")), false);
    assert.equal(existsSync(path.join(projectPath, ".data")), false);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
test("doctor reports telegram-notify as a non-blocking WARN when unconfigured", async () => {
  const ctx = setup();
  try {
    const results = await checkNotifications({ env: {}, home: ctx.home });
    const notify = results.find((entry) => entry.name === "telegram-notify");
    assert.equal(notify.status, WARN);
    assert.equal(notify.fatal, false, "an absent notifier must never block a start");
    assert.match(notify.detail, /not configured/);
  } finally {
    ctx.cleanup();
  }
});

test("doctor reports PASS plus the per-identity policy once configured", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const { paths } = await bootstrap(ctx);
    const project = await readPrivateJson(paths.projectFile);
    const results = await checkNotifications({ project, paths, env: {}, home: ctx.home });

    const notify = results.find((entry) => entry.name === "telegram-notify");
    assert.equal(notify.status, PASS);
    assert.match(notify.detail, /configured \(global/);

    const policy = results.find((entry) => entry.name === "notify-policy");
    assert.equal(policy.status, PASS);
    assert.match(policy.detail, /root=all/);
    assert.match(policy.detail, /claude=errors/);
    noSecrets(JSON.stringify(results));
  } finally {
    ctx.cleanup();
  }
});

test("doctor treats a malformed notification config as WARN, never fatal", async () => {
  const ctx = setup();
  try {
    mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
    writeFileSync(ctx.configPath, "{ broken", { mode: 0o600 });
    chmodSync(ctx.configPath, 0o600);
    const results = await checkNotifications({ env: {}, home: ctx.home });
    const notify = results.find((entry) => entry.name === "telegram-notify");
    assert.equal(notify.status, WARN);
    assert.equal(notify.fatal, false);
    assert.match(notify.detail, /invalid/);
  } finally {
    ctx.cleanup();
  }
});

test("doctor flags a missing per-identity policy as repairable, not fatal", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const { paths } = await bootstrap(ctx);
    const project = await readPrivateJson(paths.projectFile);
    const rootConfig = await readPrivateJson(paths.agentConfigFile("root"));
    delete rootConfig.notifications;
    await writePrivateJson(paths.agentConfigFile("root"), rootConfig);

    const results = await checkNotifications({ project, paths, env: {}, home: ctx.home });
    const entry = results.find((item) => item.name === "notify-policy:root");
    assert.equal(entry.status, WARN);
    assert.equal(entry.fatal, false);
    assert.equal(entry.repairable, true);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// the anti-spam invariant, against the REAL notify queue
// ---------------------------------------------------------------------------
test("one operator task enqueues exactly ONE notification across the whole topology", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const { paths } = await bootstrap(ctx);

    // One plan and one queue per daemon, exactly as each daemon builds its own.
    const daemons = new Map();
    for (const role of ["root", "claude", "codex", "cursor"]) {
      const config = await readPrivateJson(paths.agentConfigFile(role));
      daemons.set(role, {
        plan: await resolveNotifyPlan({ config, env: {}, home: ctx.home }),
        queue: new NotifyQueue(path.join(ctx.dir, `${role}.db`)),
      });
    }

    // The real chain a single `murmur send` produces: the operator task fans out through
    // the coordinator to both workers, their results come back, and the coordinator
    // answers root. Each arrow is an INBOUND message at the receiving daemon.
    const chain = [
      { at: "claude", from: "root", msgId: "m1" },
      { at: "codex", from: "claude", msgId: "m2" },
      { at: "cursor", from: "claude", msgId: "m3" },
      { at: "claude", from: "codex", msgId: "m4" },
      { at: "claude", from: "cursor", msgId: "m5" },
      { at: "root", from: "claude", msgId: "m6" },
    ];
    for (const hop of chain) {
      const daemon = daemons.get(hop.at);
      if (!planNotifiesInbound(daemon.plan)) continue;
      daemon.queue.enqueueMessage({ msgId: hop.msgId, from: hop.from, text: "work" }, daemon.plan.targets);
    }

    const perDaemon = [...daemons].map(([role, daemon]) => [role, daemon.queue.pendingCount()]);
    assert.deepEqual(Object.fromEntries(perDaemon), { root: 1, claude: 0, codex: 0, cursor: 0 });
    assert.equal(perDaemon.reduce((total, [, count]) => total + count, 0), 1,
      "four daemons processing one chain must not produce four Telegram messages");
  } finally {
    ctx.cleanup();
  }
});

test("a runtime failure at a worker still reaches the operator", async () => {
  const ctx = setup();
  try {
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const { paths } = await bootstrap(ctx);
    const config = await readPrivateJson(paths.agentConfigFile("codex"));
    const plan = await resolveNotifyPlan({ config, env: {}, home: ctx.home });

    assert.equal(planNotifiesInbound(plan), false, "ordinary handoffs stay quiet");
    assert.equal(planNotifiesErrors(plan), true, "a wake failure is not quiet");

    const queue = new NotifyQueue(path.join(ctx.dir, "codex-errors.db"));
    if (planNotifiesErrors(plan)) {
      queue.enqueueMessage({ msgId: "m9", from: "claude", text: "[WakeMonitor exhausted] work" }, plan.targets);
    }
    assert.equal(queue.pendingCount(), 1);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// notifications never gate the bus
// ---------------------------------------------------------------------------
test("no notification state is ever fatal, so a start is never blocked by Telegram", async () => {
  const ctx = setup();
  try {
    // absent
    assert.equal(hasFatal(await checkNotifications({ env: {}, home: ctx.home })), false);
    // invalid
    mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
    writeFileSync(ctx.configPath, "}{", { mode: 0o600 });
    chmodSync(ctx.configPath, 0o600);
    assert.equal(hasFatal(await checkNotifications({ env: {}, home: ctx.home })), false);
    // configured, but with every identity opted out
    await writePrivateJson(ctx.configPath, { version: 1, telegram: { botToken: FIXTURE_TOKEN, chatId: FIXTURE_CHAT } });
    const { paths } = await bootstrap(ctx);
    const project = await readPrivateJson(paths.projectFile);
    for (const role of ["root", "claude", "codex", "cursor"]) {
      const config = await readPrivateJson(paths.agentConfigFile(role));
      config.notifications = { source: "none", scope: "off" };
      await writePrivateJson(paths.agentConfigFile(role), config);
    }
    const results = await checkNotifications({ project, paths, env: {}, home: ctx.home });
    assert.equal(hasFatal(results), false);
    assert.equal(results.find((entry) => entry.name === "notify-policy").status, WARN);
  } finally {
    ctx.cleanup();
  }
});
