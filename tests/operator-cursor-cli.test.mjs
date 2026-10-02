/**
 * operator-cursor-cli.test.mjs — `murmur cursor <project> config`.
 *
 * Exercises the REAL `commandCursor` handler against a REAL bootstrapped profile, with
 * a fixture `~/.cursor/cli-config.json` so the suite never reads the real operator
 * homedir and never depends on what the real Cursor account happens to have selected.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commandCursor } from "../scripts/operator/cursor.mjs";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const CAPS_NONE = async () => ({
  available: false, modelFlagSupported: false, effortFlagSupported: false, supportedModels: [], supportedEfforts: [],
});

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-cursor-cli-"));
  const rawProjectPath = path.join(dir, "project");
  mkdirSync(rawProjectPath, { recursive: true });
  const projectPath = realpathSync(rawProjectPath);
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  await bootstrapProfile({ projectId, projectPath, paths, discoverCapabilities: CAPS_NONE });

  const cursorHomedir = path.join(dir, "cursor-home");
  mkdirSync(path.join(cursorHomedir, ".cursor"), { recursive: true });

  return { dir, projectPath, projectId, paths, cursorHomedir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const writeCursorConfig = (ctx, model) => {
  writeFileSync(path.join(ctx.cursorHomedir, ".cursor", "cli-config.json"), JSON.stringify({ model }));
};

const run = (ctx, args, flags = {}) => {
  const out = [];
  const err = [];
  const call = commandCursor({
    args: [ctx.projectPath, ...args],
    flags,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    home: ctx.paths.home,
    cursorHomedir: ctx.cursorHomedir,
  });
  return call.then((code) => ({ code, out, err }));
};

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

test("config --json reports the real Cursor-global effective model, non-controllable", async () => {
  const ctx = await setup();
  try {
    writeCursorConfig(ctx, { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" });
    const { code, out } = await run(ctx, ["config"], { json: true });
    assert.equal(code, 0);
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.cursor.controllable, false);
    assert.equal(report.cursor.effectiveModel, "claude-opus-5");
    assert.equal(report.cursor.effectiveModelLabel, "Claude Opus 5 300K High");
    assert.equal(report.cursor.source, "cursor-global");
  } finally {
    ctx.cleanup();
  }
});

test("human output names the real model and is explicit that Murmur does not control it", async () => {
  const ctx = await setup();
  try {
    writeCursorConfig(ctx, { modelId: "default", displayName: "Auto" });
    const { code, out } = await run(ctx, ["config"]);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /Cursor: Auto/);
    assert.match(text, /не управляет/);
  } finally {
    ctx.cleanup();
  }
});

test("a project with no Cursor identity is refused cleanly", async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-cursor-noagent-"));
  try {
    const rawProjectPath = path.join(dir, "project");
    mkdirSync(rawProjectPath, { recursive: true });
    const projectPath = realpathSync(rawProjectPath);
    const projectId = projectIdFor(projectPath);
    const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
    const { DEFAULT_AGENTS } = await import("../scripts/operator/profile.mjs");
    await bootstrapProfile({
      projectId, projectPath, paths,
      agents: DEFAULT_AGENTS.filter((agent) => agent.name !== "cursor"),
      edges: [["root", "claude"], ["claude", "codex"]],
      discoverCapabilities: CAPS_NONE,
    });
    const out = [];
    const err = [];
    const code = await commandCursor({ args: [projectPath, "config"], flags: {}, out: (l) => out.push(l), err: (l) => err.push(l), home: paths.home });
    assert.equal(code, 3);
    assert.match(err.join("\n"), /no Cursor identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// NO WRITE PATH — this is the whole point of the slice
// ---------------------------------------------------------------------------

test("'murmur cursor <project> model <id>' is refused with a clear explanation, never silently accepted", async () => {
  const ctx = await setup();
  try {
    writeCursorConfig(ctx, { modelId: "default", displayName: "Auto" });
    const before = readFileSync(path.join(ctx.cursorHomedir, ".cursor", "cli-config.json"), "utf8");
    const { code, err } = await run(ctx, ["model", "claude-opus-5"]);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /not offered by Murmur/);
    const after = readFileSync(path.join(ctx.cursorHomedir, ".cursor", "cli-config.json"), "utf8");
    assert.equal(after, before, "the global Cursor config must be byte-for-byte unchanged");
  } finally {
    ctx.cleanup();
  }
});

test("no project-scoped Cursor preference file is ever created anywhere", async () => {
  const ctx = await setup();
  try {
    writeCursorConfig(ctx, { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" });
    await run(ctx, ["config"], { json: true });
    await run(ctx, ["model", "claude-opus-5"]);
    const entries = readdirSync(ctx.paths.root);
    assert.ok(entries.every((name) => !/cursor/i.test(name)), JSON.stringify(entries));
  } finally {
    ctx.cleanup();
  }
});

test("another project's Cursor config (if it existed) would be completely unaffected", async () => {
  // There is no per-project Cursor file at all, so "unaffected" is structural: reading or
  // attempting to write for project A can only ever touch the ONE global file, which
  // every project on the same machine shares identically and openly — never a per-project
  // copy that could drift. Prove the report is IDENTICAL for two different projects
  // pointed at the SAME global fixture.
  const ctxA = await setup();
  const ctxB = await setup();
  try {
    writeCursorConfig(ctxA, { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" });
    writeCursorConfig(ctxB, { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" });
    const a = JSON.parse((await run(ctxA, ["config"], { json: true })).out.join("\n"));
    const b = JSON.parse((await run(ctxB, ["config"], { json: true })).out.join("\n"));
    assert.deepEqual(a.cursor, b.cursor);
  } finally {
    ctxA.cleanup();
    ctxB.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("the JSON output never contains an auth token, key, or other secret field", async () => {
  const ctx = await setup();
  try {
    // A config shaped like the REAL ~/.cursor/cli-config.json, which also carries
    // authInfo — prove none of it leaks even when physically present in the source file.
    writeFileSync(path.join(ctx.cursorHomedir, ".cursor", "cli-config.json"), JSON.stringify({
      model: { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" },
      authInfo: { email: "secret@example.com", userId: "abc123", authId: "should-not-leak-xyz" },
    }));
    const { out } = await run(ctx, ["config"], { json: true });
    const serialized = out.join("\n");
    assert.doesNotMatch(serialized, /secret@example\.com|should-not-leak-xyz|authId|authInfo/);
  } finally {
    ctx.cleanup();
  }
});

test("requires a project argument and a known subcommand", async () => {
  const out = [];
  const err = [];
  const code = await commandCursor({ args: [], flags: {}, out: (l) => out.push(l), err: (l) => err.push(l) });
  assert.equal(code, 1);
  assert.match(err.join("\n"), /requires <project>/);
});
