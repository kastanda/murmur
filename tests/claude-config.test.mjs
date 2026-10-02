/**
 * claude-config.test.mjs — per-project Claude model/effort preference: storage,
 * validation, and the selected/running/effective resolution that keeps the CLI, its
 * `--json` output and the menu bar from ever disagreeing about what is actually running.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INHERIT,
  defaultClaudePreferencesFor,
  effortLabel,
  isSupportedEffort,
  isSupportedModel,
  loadClaudePreferences,
  modelLabel,
  readCachedCanonicalModel,
  readClaudeCodeDefaultModel,
  resolveClaudeConfig,
  validateClaudePreferences,
  writeClaudePreferences,
} from "../scripts/operator/claude-config.mjs";

const CAPS_FULL = Object.freeze({
  modelFlagSupported: true, effortFlagSupported: true,
  supportedModels: ["sonnet", "opus"], supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
});
const CAPS_NO_EFFORT = Object.freeze({ ...CAPS_FULL, effortFlagSupported: false, supportedEfforts: [] });
const CAPS_NONE = Object.freeze({ modelFlagSupported: false, effortFlagSupported: false, supportedModels: [], supportedEfforts: [] });

const tmpPaths = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-claude-config-"));
  return { dir, claudePreferencesFile: path.join(dir, "claude-preferences.json") };
};

// ---------------------------------------------------------------------------
// Allowlist validation
// ---------------------------------------------------------------------------

test("sonnet/opus are supported exactly when the installed CLI's own help documents them", () => {
  assert.equal(isSupportedModel("sonnet", CAPS_FULL), true);
  assert.equal(isSupportedModel("opus", CAPS_FULL), true);
  assert.equal(isSupportedModel("sonnet", CAPS_NONE), false);
  assert.equal(isSupportedModel("haiku", CAPS_FULL), false, "not one of the two models this feature offers");
});

test("inherit is always accepted, independent of discovered capabilities", () => {
  assert.equal(isSupportedModel(INHERIT, CAPS_NONE), true);
  assert.equal(isSupportedEffort(INHERIT, CAPS_NONE), true);
});

test("an invalid model is rejected by the allowlist check", () => {
  assert.equal(isSupportedModel("claude-sonnet-5.5", CAPS_FULL), false, "a fabricated minor version is never accepted");
  assert.equal(isSupportedModel("", CAPS_FULL), false);
  assert.equal(isSupportedModel(null, CAPS_FULL), false);
});

test("an invalid effort is rejected by the allowlist check", () => {
  assert.equal(isSupportedEffort("extreme", CAPS_FULL), false);
  assert.equal(isSupportedEffort("medium", CAPS_NO_EFFORT), false, "the installed CLI does not support --effort at all");
});

// ---------------------------------------------------------------------------
// Storage: read / write / validate
// ---------------------------------------------------------------------------

test("preferences round-trip through disk exactly", async () => {
  const paths = tmpPaths();
  try {
    await writeClaudePreferences(paths, { version: 1, model: "sonnet", effort: "medium" });
    const loaded = await loadClaudePreferences(paths);
    assert.deepEqual(loaded, { state: "configured", preferences: { version: 1, model: "sonnet", effort: "medium" } });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("an absent file is the ordinary 'absent' state, not an error", async () => {
  const paths = tmpPaths();
  try {
    assert.deepEqual(await loadClaudePreferences(paths), { state: "absent" });
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a malformed file is reported invalid and fails validation closed", async () => {
  const paths = tmpPaths();
  try {
    writeFileSync(paths.claudePreferencesFile, JSON.stringify({ version: 1, model: "sonnet" })); // missing effort
    const loaded = await loadClaudePreferences(paths);
    assert.equal(loaded.state, "invalid");
    assert.match(loaded.reason, /effort-missing/);

    assert.throws(() => validateClaudePreferences(null), /not-an-object/);
    assert.throws(() => validateClaudePreferences({ version: 2, model: "x", effort: "y" }), /version-unsupported/);
    assert.throws(() => validateClaudePreferences({ version: 1, model: "", effort: "y" }), /model-missing/);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the preferences file is written 0600, like every other Murmur preference", async () => {
  const paths = tmpPaths();
  try {
    await writeClaudePreferences(paths, { version: 1, model: "opus", effort: "high" });
    const mode = statSync(paths.claudePreferencesFile).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("writing is guarded by the same allowlist shape validation (structural, not CLI support)", async () => {
  const paths = tmpPaths();
  try {
    await assert.rejects(() => writeClaudePreferences(paths, { version: 1, model: "sonnet" }), /effort-missing/);
    assert.equal(existsSync(paths.claudePreferencesFile), false, "a rejected write leaves no file behind");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Defaults for a brand-new project
// ---------------------------------------------------------------------------

test("default preferences are sonnet/medium when the installed CLI supports both", () => {
  assert.deepEqual(defaultClaudePreferencesFor(CAPS_FULL), { version: 1, model: "sonnet", effort: "medium" });
});

test("default preferences fall back to inherit for whichever option is unsupported", () => {
  assert.deepEqual(defaultClaudePreferencesFor(CAPS_NO_EFFORT), { version: 1, model: "sonnet", effort: INHERIT });
  assert.deepEqual(defaultClaudePreferencesFor(CAPS_NONE), { version: 1, model: INHERIT, effort: INHERIT });
});

// ---------------------------------------------------------------------------
// Reading Claude Code's own default — read-only, local, never written
// ---------------------------------------------------------------------------

test("Claude Code's own model default is read for display only", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-claude-settings-"));
  try {
    const settingsPath = path.join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model: "sonnet", theme: "dark" }));
    assert.equal(await readClaudeCodeDefaultModel({ claudeSettingsPath: settingsPath }), "sonnet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing or unreadable Claude Code settings file resolves to unknown, never guessed", async () => {
  assert.equal(await readClaudeCodeDefaultModel({ claudeSettingsPath: "/nonexistent/settings.json" }), null);
});

// ---------------------------------------------------------------------------
// resolveClaudeConfig — selected vs running vs effective, the truth the UI is built on
// ---------------------------------------------------------------------------

const withPrefs = async (preferences) => {
  const paths = tmpPaths();
  if (preferences) await writeClaudePreferences(paths, preferences);
  return paths;
};

test("not running, explicit selection: effective equals selected immediately, no pending restart", async () => {
  const paths = await withPrefs({ version: 1, model: "sonnet", effort: "medium" });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => null,
    });
    assert.equal(resolved.model.selected, "sonnet");
    assert.equal(resolved.model.effective, "sonnet");
    assert.equal(resolved.model.source, "murmur-project");
    assert.equal(resolved.model.pendingRestart, false);
    assert.equal(resolved.effort.effective, "medium");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("no preference at all: inherits, and the effective model is read from Claude Code's own settings", async () => {
  const paths = await withPrefs(null);
  const settingsDir = mkdtempSync(path.join(os.tmpdir(), "mur-cc-settings-"));
  const settingsPath = path.join(settingsDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ model: "sonnet" }));
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: settingsPath,
      readLiveClaudeBinding: () => null,
    });
    assert.equal(resolved.model.selected, INHERIT);
    assert.equal(resolved.model.source, "claude-code");
    assert.equal(resolved.model.effective, "sonnet");
    assert.equal(resolved.model.effectiveLabel, "Sonnet");
    // Effort has no local non-network inherited source; never fabricated.
    assert.equal(resolved.effort.effective, null);
    assert.equal(resolved.effort.effectiveLabel, null);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

test("running daemon still on the old model: effective reflects what is ACTUALLY running, pendingRestart true", async () => {
  // The operator just switched the preference to opus, but the daemon that is still
  // alive was started under sonnet. Telling the operator opus is active would be exactly
  // the lie the task forbids.
  const paths = await withPrefs({ version: 1, model: "opus", effort: "high" });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => ({ bindings: [{ live: true, metadata: { model: "sonnet", effort: "medium" } }] }),
    });
    assert.equal(resolved.model.selected, "opus");
    assert.equal(resolved.model.running, "sonnet");
    assert.equal(resolved.model.effective, "sonnet", "truth is what is running, not what was just selected");
    assert.equal(resolved.model.pendingRestart, true);
    assert.equal(resolved.effort.pendingRestart, true);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("running daemon matches the current selection: no pending restart", async () => {
  const paths = await withPrefs({ version: 1, model: "sonnet", effort: "medium" });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => ({ bindings: [{ live: true, metadata: { model: "sonnet", effort: "medium" } }] }),
    });
    assert.equal(resolved.model.pendingRestart, false);
    assert.equal(resolved.effort.pendingRestart, false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("reverting to inherit while an explicit override is still running is ALSO a pending restart", async () => {
  // The inverse of the usual case: nothing says the divergence must go "inherit -> explicit".
  const paths = await withPrefs({ version: 1, model: INHERIT, effort: INHERIT });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => ({ bindings: [{ live: true, metadata: { model: "opus", effort: "high" } }] }),
    });
    assert.equal(resolved.model.selected, INHERIT);
    assert.equal(resolved.model.running, "opus");
    assert.equal(resolved.model.effective, "opus", "the running process is still using opus");
    assert.equal(resolved.model.pendingRestart, true);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("running with nothing explicit ever configured on either side: no pending restart, inherited label shown", async () => {
  const paths = await withPrefs(null);
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => ({ bindings: [{ live: true, metadata: { model: INHERIT, effort: INHERIT } }] }),
    });
    assert.equal(resolved.model.pendingRestart, false);
    assert.equal(resolved.model.source, "claude-code");
    assert.equal(resolved.model.runningLabel, "По настройкам Claude Code");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("an invalid preferences file never crashes resolution; it is surfaced as configState", async () => {
  const paths = tmpPaths();
  try {
    writeFileSync(paths.claudePreferencesFile, "{not json");
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => null,
    });
    assert.equal(resolved.configState, "invalid");
    // Falls back to behaving as inherit rather than crashing or guessing a value.
    assert.equal(resolved.model.selected, INHERIT);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test("model labels never fabricate a minor version", () => {
  assert.equal(modelLabel("sonnet"), "Sonnet");
  assert.equal(modelLabel("opus"), "Opus");
  assert.equal(modelLabel(INHERIT), "По настройкам Claude Code");
  assert.doesNotMatch(modelLabel("sonnet"), /5\.5|[0-9]/, "no invented version number");
});

test("effort labels are Russian and bounded to the known set", () => {
  assert.equal(effortLabel("low"), "Низкое");
  assert.equal(effortLabel("medium"), "Среднее");
  assert.equal(effortLabel("high"), "Высокое");
  assert.equal(effortLabel(INHERIT), "По настройкам Claude Code");
});

// ---------------------------------------------------------------------------
// Canonical model id display (Part A: exact Claude model version display)
// ---------------------------------------------------------------------------

const withCache = async (cache) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-canonical-"));
  const file = path.join(dir, "claude-runtime-cache.json");
  if (cache) writeFileSync(file, JSON.stringify(cache));
  return { dir, file };
};

test("a cached canonical model correlated to the current alias is returned", async () => {
  const { dir, file } = await withCache({ version: 1, selectedAlias: "sonnet", canonicalModel: "claude-sonnet-5", observedAt: "2026-01-01T00:00:00.000Z" });
  try {
    assert.equal(await readCachedCanonicalModel({ claudeRuntimeCacheFile: file, effectiveAlias: "sonnet" }), "claude-sonnet-5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cached canonical model for a DIFFERENT alias than what is effective now is not returned", async () => {
  // The operator switched from sonnet to opus; the cache still says sonnet's canonical id
  // and must not be shown as if it described opus.
  const { dir, file } = await withCache({ version: 1, selectedAlias: "sonnet", canonicalModel: "claude-sonnet-5", observedAt: "2026-01-01T00:00:00.000Z" });
  try {
    assert.equal(await readCachedCanonicalModel({ claudeRuntimeCacheFile: file, effectiveAlias: "opus" }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an absent, malformed or unversioned cache resolves to null, never a guess", async () => {
  assert.equal(await readCachedCanonicalModel({ claudeRuntimeCacheFile: undefined, effectiveAlias: "sonnet" }), null);
  assert.equal(await readCachedCanonicalModel({ claudeRuntimeCacheFile: "/nonexistent/cache.json", effectiveAlias: "sonnet" }), null);

  const { dir, file } = await withCache({ version: 2, selectedAlias: "sonnet", canonicalModel: "claude-sonnet-5" });
  try {
    assert.equal(await readCachedCanonicalModel({ claudeRuntimeCacheFile: file, effectiveAlias: "sonnet" }), null, "unsupported cache version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveClaudeConfig upgrades BOTH the selected and effective labels to the canonical version when the cache correlates", async () => {
  // Selected and effective are the SAME alias here (nothing is running yet, so
  // effective falls back to selected) — both must show the precise "Sonnet 5",
  // since both genuinely refer to the alias the cache was observed under.
  const paths = tmpPaths();
  await writeClaudePreferences(paths, { version: 1, model: "sonnet", effort: "medium" });
  const { dir, file } = await withCache({ version: 1, selectedAlias: "sonnet", canonicalModel: "claude-sonnet-5", observedAt: "2026-01-01T00:00:00.000Z" });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => null, claudeRuntimeCacheFile: file,
    });
    assert.equal(resolved.model.canonicalModel, "claude-sonnet-5");
    assert.equal(resolved.model.effectiveLabel, "Sonnet 5", "the UI-facing label is upgraded, not merely the raw field");
    assert.equal(resolved.model.selectedLabel, "Sonnet 5", "the selected alias is also known precisely — it must not stay bare");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveClaudeConfig upgrades selected and running labels INDEPENDENTLY when they name different aliases", async () => {
  // The operator just selected opus while sonnet is still the one actually running
  // (pending restart). The cache has evidence for BOTH aliases, from two different
  // real turns observed in the past. Each label must be upgraded against its OWN
  // alias, not against whichever one happens to be "effective".
  const paths = tmpPaths();
  await writeClaudePreferences(paths, { version: 1, model: "opus", effort: "high" });
  const { dir, file } = await withCache({ version: 1, selectedAlias: "opus", canonicalModel: "claude-opus-5", observedAt: "2026-01-01T00:00:00.000Z" });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => ({ bindings: [{ live: true, metadata: { model: "sonnet", effort: "medium" } }] }),
      claudeRuntimeCacheFile: file,
    });
    assert.equal(resolved.model.pendingRestart, true);
    assert.equal(resolved.model.selectedLabel, "Opus 5", "the new selection's own cached version");
    // The cache only has evidence for opus, not sonnet — the running alias stays bare.
    assert.equal(resolved.model.runningLabel, "Sonnet");
    assert.equal(resolved.model.effectiveLabel, "Sonnet", "effective mirrors what is actually running");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveClaudeConfig falls back to the bare alias label with no cache evidence yet", async () => {
  const paths = tmpPaths();
  await writeClaudePreferences(paths, { version: 1, model: "sonnet", effort: "medium" });
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => null, claudeRuntimeCacheFile: undefined,
    });
    assert.equal(resolved.model.canonicalModel, null);
    assert.equal(resolved.model.effectiveLabel, "Sonnet");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("switching alias away from a cached one falls back to the bare label for the NEW alias", async () => {
  const paths = tmpPaths();
  await writeClaudePreferences(paths, { version: 1, model: "opus", effort: "medium" }); // operator just switched to opus
  const { dir, file } = await withCache({ version: 1, selectedAlias: "sonnet", canonicalModel: "claude-sonnet-5", observedAt: "2026-01-01T00:00:00.000Z" }); // stale: still sonnet's
  try {
    const resolved = await resolveClaudeConfig({
      paths, capabilities: CAPS_FULL, claudeSettingsPath: "/nonexistent",
      readLiveClaudeBinding: () => null, claudeRuntimeCacheFile: file,
    });
    assert.equal(resolved.model.canonicalModel, null, "the cache belongs to the previous alias");
    assert.equal(resolved.model.effectiveLabel, "Opus", "bare label for opus, never sonnet's stale canonical version");
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
