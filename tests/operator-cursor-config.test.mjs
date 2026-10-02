/**
 * operator-cursor-config.test.mjs — Cursor model VISIBILITY (read-only).
 *
 * Why there is no "set model" test here: the installed Cursor ACP server's model
 * selection is real and functional, but it was proven by live local probing to mutate
 * the OPERATOR'S OWN global Cursor configuration, not anything scoped to a Murmur
 * project (see `cursor-config.mjs`'s header). Per this project's own policy, an
 * "inherently global" mechanism gets displayed, never silently used — so there is no
 * writer to test, by design, and these tests prove exactly that: no selector, no global
 * mutation, a truthful read-only report.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CURSOR_NOT_CONTROLLABLE_REASON,
  CURSOR_SOURCE,
  cursorCliConfigPath,
  readCursorGlobalModel,
  resolveCursorModelInfo,
} from "../scripts/operator/cursor-config.mjs";

const fakeHome = (cliConfig) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-cursor-home-"));
  if (cliConfig !== undefined) {
    const cursorDir = path.join(dir, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(path.join(cursorDir, "cli-config.json"), JSON.stringify(cliConfig));
  }
  return dir;
};

// ---------------------------------------------------------------------------
// path helper
// ---------------------------------------------------------------------------

test("cursorCliConfigPath points at ~/.cursor/cli-config.json", () => {
  assert.equal(cursorCliConfigPath("/Users/x"), "/Users/x/.cursor/cli-config.json");
});

// ---------------------------------------------------------------------------
// readCursorGlobalModel — read-only, never guessed at
// ---------------------------------------------------------------------------

test("reads the real {modelId, displayName} shape Cursor's own config uses", async () => {
  const home = fakeHome({ model: { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" } });
  try {
    assert.deepEqual(
      await readCursorGlobalModel({ cursorCliConfigPath: cursorCliConfigPath(home) }),
      { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the default/Auto state is read exactly as Cursor itself represents it", async () => {
  const home = fakeHome({ model: { modelId: "default", displayName: "Auto" } });
  try {
    assert.deepEqual(
      await readCursorGlobalModel({ cursorCliConfigPath: cursorCliConfigPath(home) }),
      { modelId: "default", displayName: "Auto" },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing config file resolves to null, never a guess", async () => {
  const home = fakeHome(undefined);
  try {
    assert.equal(await readCursorGlobalModel({ cursorCliConfigPath: cursorCliConfigPath(home) }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed or incomplete config file resolves to null rather than a half-filled guess", async () => {
  for (const malformed of [{}, { model: {} }, { model: { displayName: "Auto" } }, { model: null }]) {
    const home = fakeHome(malformed);
    try {
      assert.equal(await readCursorGlobalModel({ cursorCliConfigPath: cursorCliConfigPath(home) }), null, JSON.stringify(malformed));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("a missing displayName still reports the modelId, never fabricating a human label", async () => {
  const home = fakeHome({ model: { modelId: "claude-sonnet-5" } });
  try {
    assert.deepEqual(
      await readCursorGlobalModel({ cursorCliConfigPath: cursorCliConfigPath(home) }),
      { modelId: "claude-sonnet-5", displayName: null },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveCursorModelInfo — the full truthful, non-controllable report
// ---------------------------------------------------------------------------

test("reports controllable:false with the exact documented reason — no fake selector surface", async () => {
  const home = fakeHome({ model: { modelId: "claude-opus-5", displayName: "Claude Opus 5 300K High" } });
  try {
    const info = await resolveCursorModelInfo({ cursorCliConfigPath: cursorCliConfigPath(home) });
    assert.equal(info.controllable, false);
    assert.equal(info.reason, CURSOR_NOT_CONTROLLABLE_REASON);
    assert.equal(info.selectedModel, null, "Murmur has no selection of its own to report");
    assert.equal(info.selectedModelLabel, null);
    assert.equal(info.effectiveModel, "claude-opus-5");
    assert.equal(info.effectiveModelLabel, "Claude Opus 5 300K High");
    assert.equal(info.source, CURSOR_SOURCE);
    assert.deepEqual(info.supportedModels, [], "Murmur offers no selectable list");
    assert.equal(info.requiresRestart, false);
    assert.equal(info.requiresNewSession, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("falls back to the bare modelId as the label when Cursor reports no displayName", async () => {
  const home = fakeHome({ model: { modelId: "claude-sonnet-5" } });
  try {
    const info = await resolveCursorModelInfo({ cursorCliConfigPath: cursorCliConfigPath(home) });
    assert.equal(info.effectiveModel, "claude-sonnet-5");
    assert.equal(info.effectiveModelLabel, "claude-sonnet-5");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable global config reports an unknown effective model, never a guess", async () => {
  const home = fakeHome(undefined);
  try {
    const info = await resolveCursorModelInfo({ cursorCliConfigPath: cursorCliConfigPath(home) });
    assert.equal(info.effectiveModel, null);
    assert.equal(info.effectiveModelLabel, null);
    assert.equal(info.controllable, false, "still truthfully reported as non-controllable even with nothing to show");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// This module must never contain a write path
// ---------------------------------------------------------------------------

test("the module exports no write/set function at all", async () => {
  const mod = await import("../scripts/operator/cursor-config.mjs");
  const exportNames = Object.keys(mod);
  assert.ok(exportNames.every((name) => !/write|set|mutate/i.test(name)), JSON.stringify(exportNames));
});
