/**
 * operator-claude-cli.test.mjs — `murmur claude <project> config|model|effort`.
 *
 * Exercises the REAL `commandClaude` handler against a REAL bootstrapped profile (so
 * reconciliation, path resolution and the preferences file all behave exactly as they do
 * for an operator), with an INJECTED fake Claude capability discovery so the suite never
 * spawns the real `claude` binary and never depends on what happens to be installed on
 * the machine running the tests.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commandClaude } from "../scripts/operator/claude.mjs";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const CAPS_FULL = async () => ({
  available: true, modelFlagSupported: true, effortFlagSupported: true,
  supportedModels: ["sonnet", "opus"], supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
});
const CAPS_NONE = async () => ({
  available: true, modelFlagSupported: false, effortFlagSupported: false,
  supportedModels: [], supportedEfforts: [],
});

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const setup = async ({ discoverCapabilities = CAPS_FULL } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-claude-cli-"));
  const rawProjectPath = path.join(dir, "project");
  mkdirSync(rawProjectPath, { recursive: true });
  // commandClaude() resolves <project> through locateProject(), which realpaths it
  // (/tmp is a symlink to /private/tmp on macOS) — match that here so the projectId this
  // test bootstraps under is the SAME one commandClaude() will look up.
  const projectPath = realpathSync(rawProjectPath);
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  await bootstrapProfile({ projectId, projectPath, paths, discoverCapabilities });
  return { dir, projectPath, projectId, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

const run = (ctx, args, flags = {}, discoverCapabilities = CAPS_FULL, settingsPath = undefined) => {
  const out = [];
  const err = [];
  const call = commandClaude({
    args: [ctx.projectPath, ...args],
    flags,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    home: ctx.paths.home,
    discoverCapabilities,
    settingsPath,
  });
  return call.then((code) => ({ code, out, err }));
};

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

test("config --json reports selected, effective and effective, with source labelled truthfully", async () => {
  const ctx = await setup();
  try {
    const { code, out } = await run(ctx, ["config"], { json: true });
    assert.equal(code, 0);
    const report = JSON.parse(out.join("\n"));
    // This is a brand-new profile: bootstrapProfile already wrote sonnet/medium defaults.
    assert.equal(report.claude.model, "sonnet");
    assert.equal(report.claude.modelLabel, "Актуальный Sonnet");
    assert.equal(report.claude.effort, "medium");
    assert.equal(report.claude.effectiveModel, "sonnet");
    assert.equal(report.claude.source, "murmur-project");
    assert.equal(report.claude.pendingRestart, false);
  } finally {
    ctx.cleanup();
  }
});

test("a project whose installed-CLI capabilities support neither option defaults to inherit", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_NONE });
  try {
    const { out } = await run(ctx, ["config"], { json: true }, CAPS_NONE);
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.claude.model, "inherit");
    assert.equal(report.claude.effort, "inherit");
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WRITE — model
// ---------------------------------------------------------------------------

test("set sonnet", async () => {
  const ctx = await setup();
  try {
    const { code, out } = await run(ctx, ["model", "sonnet"]);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /Sonnet/);
    const written = JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8"));
    assert.equal(written.model, "sonnet");
  } finally {
    ctx.cleanup();
  }
});

test("set opus", async () => {
  const ctx = await setup();
  try {
    const { code } = await run(ctx, ["model", "opus"]);
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8"));
    assert.equal(written.model, "opus");
    // Effort is untouched by a model-only write.
    assert.equal(written.effort, "medium");
  } finally {
    ctx.cleanup();
  }
});

test("set inherit", async () => {
  const ctx = await setup();
  try {
    const { code } = await run(ctx, ["model", "inherit"]);
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8"));
    assert.equal(written.model, "inherit");
  } finally {
    ctx.cleanup();
  }
});

test("an unsupported model is rejected and nothing is written", async () => {
  const ctx = await setup();
  try {
    const before = readFileSync(ctx.paths.claudePreferencesFile, "utf8");
    const { code, err } = await run(ctx, ["model", "haiku"]); // this fake CLI offers only sonnet/opus
    assert.equal(code, 1);
    assert.match(err.join("\n"), /not supported/);
    assert.equal(readFileSync(ctx.paths.claudePreferencesFile, "utf8"), before, "the file must be byte-for-byte unchanged");
  } finally {
    ctx.cleanup();
  }
});

test("a fabricated minor-version model id is rejected", async () => {
  const ctx = await setup();
  try {
    const { code, err } = await run(ctx, ["model", "claude-sonnet-5.5"]);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /not supported/);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// WRITE — effort
// ---------------------------------------------------------------------------

for (const level of ["low", "medium", "high"]) {
  test(`set effort ${level}`, async () => {
    const ctx = await setup();
    try {
      const { code } = await run(ctx, ["effort", level]);
      assert.equal(code, 0);
      const written = JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8"));
      assert.equal(written.effort, level);
    } finally {
      ctx.cleanup();
    }
  });
}

test("an unsupported effort is rejected and nothing is written", async () => {
  const ctx = await setup();
  try {
    const before = readFileSync(ctx.paths.claudePreferencesFile, "utf8");
    const { code, err } = await run(ctx, ["effort", "extreme"]);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /not supported/);
    assert.equal(readFileSync(ctx.paths.claudePreferencesFile, "utf8"), before);
  } finally {
    ctx.cleanup();
  }
});

test("an explicit option is refused when the installed CLI does not support it at all", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_NONE });
  try {
    const { code, err } = await run(ctx, ["model", "sonnet"], {}, CAPS_NONE);
    assert.equal(code, 1);
    assert.match(err.join("\n"), /not supported/);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Survives reconciliation; other projects unchanged; never touches global config
// ---------------------------------------------------------------------------

test("config survives a normal profile reconciliation run", async () => {
  const ctx = await setup();
  try {
    await run(ctx, ["model", "opus"]);
    await run(ctx, ["effort", "high"]);
    // Re-running bootstrapProfile is exactly what `murmur start` does on an existing
    // profile — reconciliation must never touch, reset or delete this file.
    await bootstrapProfile({ projectId: ctx.projectId, projectPath: ctx.projectPath, paths: ctx.paths });
    const written = JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8"));
    assert.deepEqual(written, { version: 1, model: "opus", effort: "high" });
  } finally {
    ctx.cleanup();
  }
});

test("other project profiles are completely unaffected by one project's Claude preference", async () => {
  const ctxA = await setup();
  const ctxB = await setup();
  try {
    await run(ctxA, ["model", "opus"]);
    await run(ctxA, ["effort", "high"]);
    const bPrefs = JSON.parse(readFileSync(ctxB.paths.claudePreferencesFile, "utf8"));
    assert.deepEqual(bPrefs, { version: 1, model: "sonnet", effort: "medium" }, "project B keeps its own default, untouched by project A");
  } finally {
    ctxA.cleanup();
    ctxB.cleanup();
  }
});

test("never writes to ~/.claude/settings.json or any other global Claude Code file", async () => {
  // An injected, isolated settings path — never the real $HOME — so this proves the
  // property without mutating global process state that other concurrently-running
  // tests in this same `node --test` process could also be depending on.
  const ctx = await setup();
  const fakeHome = mkdtempSync(path.join(shortTmp(), "mur-fake-home-"));
  try {
    const fakeSettingsPath = path.join(fakeHome, ".claude", "settings.json");
    await run(ctx, ["model", "opus"], {}, CAPS_FULL, fakeSettingsPath);
    await run(ctx, ["config"], { json: true }, CAPS_FULL, fakeSettingsPath);
    assert.equal(existsSync(path.join(fakeHome, ".claude")), false, "no ~/.claude directory was ever created");
  } finally {
    ctx.cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("the preferences file and the CLI's JSON output never contain a secret field", async () => {
  const ctx = await setup();
  try {
    await run(ctx, ["model", "opus"]);
    const raw = readFileSync(ctx.paths.claudePreferencesFile, "utf8");
    assert.doesNotMatch(raw, /key|token|secret|password|credential/i);

    const { out } = await run(ctx, ["config"], { json: true });
    const serialized = out.join("\n");
    assert.doesNotMatch(serialized, /privateKey|botToken|natsToken/i);
  } finally {
    ctx.cleanup();
  }
});

test("requires a project argument and a known subcommand", async () => {
  const outFn = [];
  const errFn = [];
  const code1 = await commandClaude({ args: [], flags: {}, out: (l) => outFn.push(l), err: (l) => errFn.push(l) });
  assert.equal(code1, 1);
  assert.match(errFn.join("\n"), /requires <project>/);
});

test("the JSON carries a value->label map for every selectable option, not just the current one", async () => {
  const ctx = await setup();
  try {
    const { out } = await run(ctx, ["config"], { json: true });
    const report = JSON.parse(out.join("\n"));
    assert.deepEqual(report.capabilities.modelLabels, { sonnet: "Актуальный Sonnet", opus: "Актуальный Opus", inherit: "По настройкам Claude Code" });
    assert.equal(report.capabilities.effortLabels.medium, "Среднее");
    assert.equal(report.capabilities.effortLabels.inherit, "По настройкам Claude Code");
  } finally {
    ctx.cleanup();
  }
});

test("config --json includes canonicalModel, null until a real turn has run", async () => {
  const ctx = await setup();
  try {
    const { out } = await run(ctx, ["config"], { json: true });
    const report = JSON.parse(out.join("\n"));
    assert.equal(report.claude.canonicalModel, null);
    assert.equal(report.claude.effectiveModelLabel, "Актуальный Sonnet", "family label only: no catalog resolution and no canonical evidence yet");
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Full model catalog: aliases + pinned versions (synthetic fake catalog)
// ---------------------------------------------------------------------------

import { buildClaudeModelOptions, normalizeSdkModel } from "../scripts/claude-capabilities.mjs";

const FULL_ROWS = [
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
];
const CAPS_CATALOG = async () => {
  const { options, defaultModel } = buildClaudeModelOptions(FULL_ROWS.map(normalizeSdkModel));
  return {
    available: true, modelFlagSupported: true, effortFlagSupported: true,
    supportedModels: options.map((o) => o.id), supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    models: options, defaultModel, catalogSource: "sdk-initialize",
  };
};

test("config --json exposes the whole picker: aliases, every pinned version, inherit — with final labels", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_CATALOG });
  try {
    const { out } = await run(ctx, ["config"], { json: true }, CAPS_CATALOG, "/nonexistent/settings.json");
    const { claude } = JSON.parse(out.join("\n"));
    const byId = Object.fromEntries(claude.models.map((m) => [m.id, m]));
    assert.deepEqual(claude.models.map((m) => m.kind), [
      "alias", "alias", "alias", "pinned", "pinned", "pinned", "pinned", "pinned", "pinned", "inherit",
    ]);
    assert.equal(byId.sonnet.label, "Актуальный Sonnet");
    assert.equal(byId.sonnet.resolvesToLabel, "Sonnet 5.5");
    assert.equal(byId["claude-sonnet-5"].label, "Sonnet 5");
    assert.equal(byId["claude-sonnet-5-5"].label, "Sonnet 5.5");
    assert.notEqual(byId["claude-sonnet-5"].label, byId["claude-sonnet-5-5"].label);
    assert.equal(byId["claude-fable-5-1"].label, "Fable 5.1");
    assert.equal(byId["claude-haiku-4-5-20251001"].label, "Haiku 4.5");
    assert.equal(byId.inherit.resolvesToLabel, "Opus 5.5");
    assert.ok(claude.models.every((m) => m.selectable === true));
    // the three label surfaces agree on the same option
    assert.equal(claude.modelLabel, "Актуальный Sonnet");
    assert.equal(claude.selected.label, claude.modelLabel);
    assert.equal(claude.effective.effectiveLabel, "Sonnet 5.5");
    assert.equal(claude.effectiveModelLabel, claude.effective.effectiveLabel);
    assert.deepEqual(claude.effortOptions.map((o) => o.id), ["low", "medium", "high", "inherit"]);
  } finally {
    ctx.cleanup();
  }
});

test("pin Sonnet 5 through the CLI: stored as the pinned id, reported pinned, alias preference untouched until then", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_CATALOG });
  try {
    assert.equal(JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8")).model, "sonnet", "existing alias preference preserved");
    const { code, out } = await run(ctx, ["model", "claude-sonnet-5"], {}, CAPS_CATALOG);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /Sonnet 5 \(claude-sonnet-5\)/);
    assert.deepEqual(JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8")), { version: 1, model: "claude-sonnet-5", effort: "medium" });
    const report = JSON.parse((await run(ctx, ["config"], { json: true }, CAPS_CATALOG)).out.join("\n"));
    assert.equal(report.claude.selected.kind, "pinned");
    assert.equal(report.claude.modelLabel, "Sonnet 5");
    assert.equal(report.claude.effectiveModelLabel, "Sonnet 5");
    // ...and pinning Sonnet 5.5 is a different, distinct choice
    assert.equal((await run(ctx, ["model", "claude-sonnet-5-5"], {}, CAPS_CATALOG)).code, 0);
    assert.equal(JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8")).model, "claude-sonnet-5-5");
  } finally {
    ctx.cleanup();
  }
});

test("unknown concrete ids and arbitrary strings are rejected and nothing is written", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_CATALOG });
  try {
    const before = readFileSync(ctx.paths.claudePreferencesFile, "utf8");
    for (const bad of ["claude-sonnet-9", "claude-sonnet-5.5", "sonnet --dangerously-skip-permissions", "$(touch pwned)", "../../etc/passwd", "default"]) {
      const { code, err } = await run(ctx, ["model", bad], {}, CAPS_CATALOG);
      assert.equal(code, 1, bad);
      assert.match(err.join("\n"), /not supported/);
    }
    assert.equal(readFileSync(ctx.paths.claudePreferencesFile, "utf8"), before);
  } finally {
    ctx.cleanup();
  }
});

test("a model that does not take the current effort is refused with a hint; fixing the effort first works", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_CATALOG });
  try {
    assert.equal((await run(ctx, ["effort", "xhigh"], {}, CAPS_CATALOG)).code, 0);
    const refused = await run(ctx, ["model", "claude-opus-4-6"], {}, CAPS_CATALOG);
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), /does not support effort 'xhigh'/);
    assert.equal(JSON.parse(readFileSync(ctx.paths.claudePreferencesFile, "utf8")).model, "sonnet", "nothing written");
    assert.equal((await run(ctx, ["effort", "high"], {}, CAPS_CATALOG)).code, 0);
    assert.equal((await run(ctx, ["model", "claude-opus-4-6"], {}, CAPS_CATALOG)).code, 0);
  } finally {
    ctx.cleanup();
  }
});

test("a stored selection the catalog no longer offers is reported verbatim and unselectable, not silently converted", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_CATALOG });
  try {
    const { writeClaudePreferences } = await import("../scripts/operator/claude-config.mjs");
    await writeClaudePreferences(ctx.paths, { version: 1, model: "claude-sonnet-4-5", effort: "medium" });
    const report = JSON.parse((await run(ctx, ["config"], { json: true }, CAPS_CATALOG)).out.join("\n"));
    assert.equal(report.claude.model, "claude-sonnet-4-5");
    assert.equal(report.claude.selected.label, "claude-sonnet-4-5");
    assert.equal(report.claude.models.some((m) => m.id === "claude-sonnet-4-5"), false);
  } finally {
    ctx.cleanup();
  }
});

test("--refresh is forwarded to catalog discovery; a normal read is not a refresh", async () => {
  const ctx = await setup({ discoverCapabilities: CAPS_CATALOG });
  try {
    const seen = [];
    const spy = async (options) => { seen.push(Boolean(options?.refresh)); return CAPS_CATALOG(); };
    await run(ctx, ["config"], { json: true, refresh: true }, spy);
    await run(ctx, ["config"], { json: true }, spy);
    assert.deepEqual(seen, [true, false]);
  } finally {
    ctx.cleanup();
  }
});
