// The node port of wake-drain-claude.sh (Windows / no sqlite3 CLI). Mirrors the shell
// suite, plus the cases the port itself introduced: a lock, a session key, and faults
// that must be reported instead of swallowed.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const script = path.resolve("scripts/wake-drain-claude.mjs");

function withDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-wake-node-"));
  const dbPath = path.join(dir, "murmur.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_messages (
      msg_id TEXT PRIMARY KEY,
      created_at TEXT,
      sender TEXT,
      conversation_id TEXT,
      direction TEXT,
      text TEXT
    );
  `);
  return { db, dbPath, dir, cursorPath: path.join(dir, "cursor"), lockPath: path.join(dir, "lock") };
}

function insertMessage(db, {
  msgId,
  conversationId = "codex:task:test",
  direction = "inbound",
  sender = "agent-jarvis",
  text = "hello",
}) {
  db.prepare(`
    INSERT INTO local_messages (msg_id, created_at, sender, conversation_id, direction, text)
    VALUES (?, '2026-08-28T00:00:00.000Z', ?, ?, ?, ?)
  `).run(msgId, sender, conversationId, direction, text);
}

function drain(ctx, extraEnv = {}) {
  return spawnSync(process.execPath, ["--no-warnings", script, "--once"], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function startPoller(ctx, extraEnv = {}) {
  const child = spawn(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "1",
      MURMUR_WAKE_POLL_MS: "10",
      ...extraEnv,
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stderr }));
  });
  return { child, result };
}

async function waitForPath(filePath, exists = true) {
  const deadline = Date.now() + 2000;
  while (fs.existsSync(filePath) !== exists) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath} exists=${exists}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("node drain seeds the cursor to the tip on first run and stays silent", () => {
  const ctx = withDb();
  insertMessage(ctx.db, { msgId: "old-1", text: "history one" });
  insertMessage(ctx.db, { msgId: "old-2", text: "history two" });

  const result = drain(ctx);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "2");
});

test("node drain emits new inbound rows and advances the cursor", () => {
  const ctx = withDb();
  drain(ctx); // seed

  insertMessage(ctx.db, {
    msgId: "in-1",
    conversationId: "dm:cursor:claude",
    text: "first\nline",
  });
  insertMessage(ctx.db, { msgId: "out-1", direction: "outbound", text: "ignore me" });
  insertMessage(ctx.db, { msgId: "in-2", sender: "agent-peer", text: "second" });

  const result = drain(ctx);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Murmur wake: 2 new inbound message\(s\):/);
  assert.match(result.stderr, /rowid=1 \[agent-jarvis\] msgId=in-1 conversationId=dm:cursor:claude first line/);
  assert.match(result.stderr, /rowid=3 \[agent-peer\] msgId=in-2 conversationId=codex:task:test second/);
  assert.match(result.stderr, /Reply via murmur_send using the same conversationId\./);
  assert.doesNotMatch(result.stderr, /ignore me/);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "3");
});

test("node drain preserves each exact conversation id in a multi-message wake", () => {
  const ctx = withDb();
  drain(ctx);
  insertMessage(ctx.db, { msgId: "in-a", conversationId: "dm:cursor:claude", text: "first" });
  insertMessage(ctx.db, { msgId: "in-b", conversationId: "channel:review:17", text: "second" });

  const result = drain(ctx);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /msgId=in-a conversationId=dm:cursor:claude first/);
  assert.match(result.stderr, /msgId=in-b conversationId=channel:review:17 second/);
});

test("node drain polling mode keeps inbound selection and wake behavior", () => {
  const ctx = withDb();
  fs.writeFileSync(ctx.cursorPath, "0\n");
  insertMessage(ctx.db, { msgId: "out-1", direction: "outbound", text: "ignore me" });
  insertMessage(ctx.db, { msgId: "in-1", conversationId: "dm:cursor:claude", text: "wake me" });

  const result = spawnSync(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "1",
      MURMUR_WAKE_POLL_MS: "10",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /msgId=in-1 conversationId=dm:cursor:claude wake me/);
  assert.doesNotMatch(result.stderr, /ignore me/);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "2");
  assert.equal(fs.existsSync(ctx.lockPath), false, "poll lock must be released after wake");
});

test("node drain re-arms immediately for three sequential polling wakes", async () => {
  const ctx = withDb();
  ctx.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  fs.writeFileSync(ctx.cursorPath, "0\n");

  for (let index = 1; index <= 3; index += 1) {
    const poller = startPoller(ctx);
    await waitForPath(ctx.lockPath);
    insertMessage(ctx.db, {
      msgId: `in-${index}`,
      conversationId: "dm:cursor:claude",
      text: `wake ${index}`,
    });

    const result = await poller.result;
    assert.equal(result.status, 2, `poller ${index} must wake`);
    assert.match(result.stderr, new RegExp(`msgId=in-${index} conversationId=dm:cursor:claude wake ${index}`));
    assert.equal(fs.existsSync(ctx.lockPath), false, `poller ${index} must release its lock`);
  }
});

test("node drain reclaims a fresh lock left by a killed poller", async () => {
  const ctx = withDb();
  fs.writeFileSync(ctx.cursorPath, "0\n");
  const crashedPoller = startPoller(ctx, { MURMUR_WAKE_MAX_SECONDS: "3600" });
  await waitForPath(ctx.lockPath);
  assert.equal(fs.readFileSync(ctx.lockPath, "utf8").trim(), String(crashedPoller.child.pid));
  crashedPoller.child.kill("SIGKILL");
  const crashResult = await crashedPoller.result;
  assert.equal(crashResult.signal, "SIGKILL");
  assert.equal(fs.existsSync(ctx.lockPath), true, "abnormal exit must leave the reproduction lock");

  insertMessage(ctx.db, { msgId: "in-1", conversationId: "dm:cursor:claude", text: "after crash" });

  const result = spawnSync(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "3600",
      MURMUR_WAKE_POLL_MS: "10",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /msgId=in-1 conversationId=dm:cursor:claude after crash/);
  assert.equal(fs.existsSync(ctx.lockPath), false);
});

test("node drain does not displace a fresh lock owned by a live pid", () => {
  const ctx = withDb();
  fs.writeFileSync(ctx.cursorPath, "0\n");
  fs.writeFileSync(ctx.lockPath, `${process.pid}\n`);
  insertMessage(ctx.db, { msgId: "in-1", text: "must wait" });

  const completed = spawnSync(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "1",
      MURMUR_WAKE_POLL_MS: "10",
    },
    encoding: "utf8",
  });
  assert.equal(completed.status, 0);
  assert.equal(completed.stderr, "");
  assert.equal(fs.readFileSync(ctx.lockPath, "utf8").trim(), String(process.pid));
  fs.rmSync(ctx.lockPath, { force: true });
});

test("node drain reclaims an old lock even when its pid is currently live", () => {
  const ctx = withDb();
  fs.writeFileSync(ctx.cursorPath, "0\n");
  fs.writeFileSync(ctx.lockPath, `${process.pid}\n`);
  fs.utimesSync(ctx.lockPath, new Date(0), new Date(0));
  insertMessage(ctx.db, { msgId: "in-1", conversationId: "dm:cursor:claude", text: "pid reused" });

  const result = spawnSync(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "1",
      MURMUR_WAKE_POLL_MS: "10",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /msgId=in-1 conversationId=dm:cursor:claude pid reused/);
  assert.equal(fs.existsSync(ctx.lockPath), false);
});

test("node drain reclaims an old legacy lock without a pid", () => {
  const ctx = withDb();
  fs.writeFileSync(ctx.cursorPath, "0\n");
  fs.writeFileSync(ctx.lockPath, "legacy-lock\n");
  fs.utimesSync(ctx.lockPath, new Date(0), new Date(0));
  insertMessage(ctx.db, { msgId: "in-1", conversationId: "dm:cursor:claude", text: "legacy recovery" });

  const result = spawnSync(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "1",
      MURMUR_WAKE_POLL_MS: "10",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /msgId=in-1 conversationId=dm:cursor:claude legacy recovery/);
  assert.equal(fs.existsSync(ctx.lockPath), false);
});

test("node drain release does not unlink a replacement owner's lock", async () => {
  const ctx = withDb();
  ctx.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  fs.writeFileSync(ctx.cursorPath, "0\n");
  const poller = startPoller(ctx);
  await waitForPath(ctx.lockPath);
  fs.writeFileSync(ctx.lockPath, `${process.pid}\n`);
  insertMessage(ctx.db, { msgId: "in-1", conversationId: "dm:cursor:claude", text: "replacement owner" });

  const result = await poller.result;

  assert.equal(result.status, 2);
  assert.match(result.stderr, /msgId=in-1 conversationId=dm:cursor:claude replacement owner/);
  assert.equal(fs.readFileSync(ctx.lockPath, "utf8").trim(), String(process.pid));
  fs.rmSync(ctx.lockPath, { force: true });
});

test("node drain creates its lock with one exclusive write", () => {
  const source = fs.readFileSync(script, "utf8");

  assert.match(source, /writeFileSync\(LOCK, `\$\{process\.pid\}\\n`, \{ flag: "wx" \}\)/);
  assert.doesNotMatch(source, /openSync\(LOCK, "wx"\)/);
  assert.doesNotMatch(source, /writeSync\(fd, `\$\{process\.pid\}\\n`\)/);
});

test("node drain keeps polling locks isolated per session key", async () => {
  const ctx = withDb();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-node-lock-home-"));
  fs.writeFileSync(ctx.cursorPath, "0\n");
  const lockA = path.join(home, ".murmur-wake-lock-aaaaaaaa");
  const lockB = path.join(home, ".murmur-wake-lock-bbbbbbbb");
  const commonEnv = {
    HOME: home,
    USERPROFILE: home,
    MURMUR_WAKE_LOCK: "",
    MURMUR_WAKE_MAX_SECONDS: "0.1",
    MURMUR_WAKE_POLL_MS: "5",
  };

  const pollerA = startPoller(ctx, { ...commonEnv, MURMUR_WAKE_SESSION_KEY: "aaaaaaaa-1111" });
  const pollerB = startPoller(ctx, { ...commonEnv, MURMUR_WAKE_SESSION_KEY: "bbbbbbbb-2222" });
  await Promise.all([waitForPath(lockA), waitForPath(lockB)]);
  const [resultA, resultB] = await Promise.all([pollerA.result, pollerB.result]);

  assert.equal(resultA.status, 0);
  assert.equal(resultB.status, 0);
  assert.equal(fs.existsSync(lockA), false);
  assert.equal(fs.existsSync(lockB), false);
});

test("node drain polling timeout remains silent and releases its lock", () => {
  const ctx = withDb();
  fs.writeFileSync(ctx.cursorPath, "0\n");

  const result = spawnSync(process.execPath, ["--no-warnings", script], {
    env: {
      ...process.env,
      MURMUR_DB: ctx.dbPath,
      MURMUR_WAKE_CURSOR: ctx.cursorPath,
      MURMUR_WAKE_LOCK: ctx.lockPath,
      MURMUR_WAKE_MAX_SECONDS: "0.05",
      MURMUR_WAKE_POLL_MS: "5",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(ctx.lockPath), false);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "0");
});

test("node drain dedups: the same message does not wake twice", () => {
  const ctx = withDb();
  drain(ctx);
  insertMessage(ctx.db, { msgId: "in-1", text: "first" });

  assert.equal(drain(ctx).status, 2);
  const second = drain(ctx);

  assert.equal(second.status, 0);
  assert.equal(second.stderr, "");
});

// The cursor must land on the last row that was REPORTED. Advancing it to the table's
// tip instead skips anything inserted between the SELECT and the tip query — that row
// then never wakes anyone.
test("node drain never advances the cursor past a row it did not report", () => {
  const ctx = withDb();
  drain(ctx);
  insertMessage(ctx.db, { msgId: "in-1", text: "reported" });

  const result = drain(ctx);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /reported/);
  assert.equal(fs.readFileSync(ctx.cursorPath, "utf8").trim(), "1", "cursor = last reported rowid");
});

test("node drain keeps a separate cursor per session key", () => {
  const ctx = withDb();
  const homeA = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-node-home-a-"));
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), "murmur-node-home-b-"));

  const drainAs = (home, sessionKey) =>
    spawnSync(process.execPath, ["--no-warnings", script, "--once"], {
      env: {
        ...process.env,
        MURMUR_DB: ctx.dbPath,
        MURMUR_WAKE_CURSOR: "",
        MURMUR_WAKE_LOCK: "",
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CODE_SESSION_ID: sessionKey,
      },
      encoding: "utf8",
    });

  assert.equal(drainAs(homeA, "aaaaaaaa-1111").status, 0);
  assert.equal(drainAs(homeB, "bbbbbbbb-2222").status, 0);

  insertMessage(ctx.db, { msgId: "in-1", text: "one message, two sessions" });

  assert.equal(drainAs(homeA, "aaaaaaaa-1111").status, 2, "session A must wake");
  assert.equal(drainAs(homeB, "bbbbbbbb-2222").status, 2, "session B must wake on the same message");

  assert.ok(fs.existsSync(path.join(homeA, ".murmur-wake-cursor-aaaaaaaa")));
  assert.ok(fs.existsSync(path.join(homeB, ".murmur-wake-cursor-bbbbbbbb")));
});

// A hook that dies without a word is the failure this script was written to fix, so a
// fault reports the reason. It still exits 0: a non-zero exit would wake the session
// with a false alarm.
test("node drain reports a missing store instead of exiting silently", () => {
  const ctx = withDb();
  const result = drain(ctx, { MURMUR_DB: path.join(ctx.dir, "nope.db") });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /murmur wake: store not readable/);
  assert.match(result.stderr, /nope\.db/);
});

test("node drain reports an unreadable store instead of exiting silently", () => {
  const ctx = withDb();
  drain(ctx); // seed, so the run gets past the baseline branch
  fs.writeFileSync(ctx.dbPath, "this is not a sqlite database");

  const result = drain(ctx);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /murmur wake: drain failed/);
});
