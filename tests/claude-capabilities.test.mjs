/**
 * claude-capabilities.test.mjs — local, zero-network discovery of what the installed
 * Claude CLI's `--model`/`--effort` flags actually support.
 *
 * `parseClaudeHelp` is tested against REAL captured `--help` text (so a future CLI
 * wording change is caught immediately) and against malformed/absent text (so a missing
 * flag degrades to "not supported" rather than throwing). `discoverClaudeCapabilities` is
 * tested once against the ACTUAL installed CLI (this environment has one) to prove the
 * two layers agree, and separately with an injected fake `run` so the rest of the suite
 * never depends on a real binary being present.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildClaudeModelOptions,
  canonicalModelLabel,
  discoverClaudeCapabilities,
  extractCanonicalModel,
  findClaudeExecutable,
  normalizeSdkModel,
  parseClaudeHelp,
  probeClaudeModelCatalog,
} from "../scripts/claude-capabilities.mjs";
import { isSelectableModelId } from "../scripts/agent-models.mjs";

// A trimmed but VERBATIM excerpt of `claude --help` (2.1.274) covering exactly the two
// option lines this module parses, reproduced faithfully rather than invented.
const REAL_HELP_EXCERPT = `
Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;

test("parses the real --model section: the documented aliases only, never a full id like claude-fable-5", () => {
  // These aliases are only the FALLBACK catalog; the real one comes from the CLI's own
  // model list (see the buildClaudeModelOptions tests below).
  const caps = parseClaudeHelp(REAL_HELP_EXCERPT);
  assert.equal(caps.modelFlagSupported, true);
  assert.deepEqual(caps.supportedModels, ["fable", "opus", "sonnet"]);
});

test("parses the real --effort section verbatim, not a hardcoded guess", () => {
  const caps = parseClaudeHelp(REAL_HELP_EXCERPT);
  assert.equal(caps.effortFlagSupported, true);
  assert.deepEqual(caps.supportedEfforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("a model name appearing elsewhere in the help text is not mistaken for a --model alias", () => {
  const text = `${REAL_HELP_EXCERPT}\n  --agents <json>   e.g. '{"sonnet-helper": {...}}'\n`;
  const caps = parseClaudeHelp(text);
  assert.deepEqual(caps.supportedModels, ["fable", "opus", "sonnet"], "the unrelated mention must not add a model");
});

test("a CLI with no --model/--effort flags at all reports both unsupported, not a crash", () => {
  const caps = parseClaudeHelp("Options:\n  --help   Display help\n");
  assert.equal(caps.modelFlagSupported, false);
  assert.equal(caps.effortFlagSupported, false);
  assert.deepEqual(caps.supportedModels, []);
  assert.deepEqual(caps.supportedEfforts, []);
});

test("empty, null or garbage help text degrades to unsupported rather than throwing", () => {
  for (const input of ["", null, undefined, "\x00\x01 not help text at all"]) {
    assert.doesNotThrow(() => parseClaudeHelp(input));
    const caps = parseClaudeHelp(input);
    assert.equal(caps.modelFlagSupported, false);
    assert.equal(caps.effortFlagSupported, false);
  }
});

test("a --model flag present with zero quoted aliases is reported unsupported", () => {
  // A future CLI that stops documenting any alias must make Murmur say "not supported"
  // rather than keep offering a name it can no longer confirm.
  const caps = parseClaudeHelp("--model <model>   Provide a model name\n");
  assert.equal(caps.modelFlagSupported, false);
  assert.deepEqual(caps.supportedModels, []);
});

test("findClaudeExecutable never uses a shell and returns null rather than guessing", () => {
  assert.equal(findClaudeExecutable("claude", { PATH: "/nonexistent-dir-xyz" }), null);
  assert.equal(findClaudeExecutable("/nonexistent/path/to/claude"), null);
});

test("discoverClaudeCapabilities with an injected fake --help never spawns a real process", async () => {
  let invoked = null;
  const caps = await discoverClaudeCapabilities({
    env: { PATH: "/usr/bin:/bin" }, // whatever claude happens to resolve to on this box
    run: async (binary, args) => {
      invoked = { binary, args };
      return { stdout: REAL_HELP_EXCERPT };
    },
  });
  // Only proceeds if a `claude`-named binary exists somewhere on the given PATH; if this
  // environment's /usr/bin:/bin has none, `binary` discovery itself returns null and
  // `run` is never called — assert the shape matches whichever branch actually executed.
  if (invoked) {
    assert.deepEqual(invoked.args, ["--help"]);
    assert.equal(caps.supportedModels.length, 3, "help-only fallback: no catalog probe was injected");
    assert.equal(caps.catalogSource, "help");
  } else {
    assert.equal(caps.available, false);
  }
});

test("a failing or timing-out --help call reports unavailable, not an exception", async () => {
  const caps = await discoverClaudeCapabilities({
    command: process.execPath, // node itself is executable and resolvable, so binary discovery succeeds
    run: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(caps.available, false);
  assert.deepEqual(caps.supportedModels, []);
});

test("a missing claude binary is reported as unavailable, never guessed at", async () => {
  const caps = await discoverClaudeCapabilities({ env: { PATH: "/nonexistent-dir-xyz" } });
  assert.deepEqual(caps, {
    available: false, modelFlagSupported: false, effortFlagSupported: false,
    supportedModels: [], supportedEfforts: [], models: [], defaultModel: null, catalogSource: "none", binary: null,
  });
});

test("the ACTUAL installed Claude CLI on this machine is discovered and matches live reality", async () => {
  // This is the one test in the suite that touches the real binary — it exists
  // specifically to prove the parsing logic agrees with what is really installed here,
  // the same empirical check performed manually before this module was written.
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-caps-"));
  try {
    const caps = await discoverClaudeCapabilities({ cacheFile: path.join(dir, "claude.json") });
    if (!caps.available) return; // no claude installed in this environment; nothing to assert
    assert.ok(caps.models.length > 0, "the installed CLI's own model catalog was read");
    assert.ok(caps.models.some((o) => o.kind === "alias"), "at least one moving alias is exposed");
    assert.ok(caps.supportedModels.every((id) => isSelectableModelId(id, caps.models)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Canonical model id -> human label (Part A: exact Claude model version display)
// ---------------------------------------------------------------------------

test("canonical claude-sonnet-5 renders as Sonnet 5", () => {
  assert.equal(canonicalModelLabel("claude-sonnet-5"), "Sonnet 5");
});

test("canonical claude-opus-5 renders as Opus 5", () => {
  assert.equal(canonicalModelLabel("claude-opus-5"), "Opus 5");
});

test("a future-shaped synthetic canonical id renders its version precisely, without claiming it exists today", () => {
  // This is a PARSER test only: it proves the parsing RULE handles a two-part version
  // correctly. It does not assert, imply or cache that "claude-sonnet-5-5" is a real,
  // currently available model — the installed CLI's own discovery is what decides that.
  assert.equal(canonicalModelLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(canonicalModelLabel("claude-opus-5-5"), "Opus 5.5");
});

test("an unknown or malformed canonical id renders no fabricated label", () => {
  for (const bogus of ["not-a-model-id", "claude-sonnet", "claude-", "", null, undefined, 42]) {
    assert.equal(canonicalModelLabel(bogus), null, JSON.stringify(bogus));
  }
});

test("a dated snapshot id's release stamp is dropped, never rendered as a version segment", () => {
  // claude-haiku-4-5-20251001: the 8-digit stamp is a release date, not "4.5.20251001".
  assert.equal(canonicalModelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(canonicalModelLabel("claude-haiku-4-5-2025"), null, "a non-date third segment stays unparsed");
});

test("alias only (no canonical evidence yet) is exactly the bare tier label", () => {
  // This documents the FALLBACK path end-to-end: `modelLabel` (from claude-config.mjs) is
  // what a caller actually renders when `canonicalModelLabel` has nothing to offer.
  assert.equal(canonicalModelLabel("sonnet"), null, "an alias is not a canonical id and must not be parsed as one");
  assert.equal(canonicalModelLabel("opus"), null);
});

// ---------------------------------------------------------------------------
// Extracting the canonical id from a real completed turn's modelUsage
// ---------------------------------------------------------------------------

test("extracts the model matching the configured alias, ignoring an unrelated helper entry", () => {
  const modelUsage = {
    "claude-haiku-4-5-20251001": { outputTokens: 13 },
    "claude-sonnet-5": { outputTokens: 212 },
  };
  assert.equal(extractCanonicalModel(modelUsage, "sonnet"), "claude-sonnet-5");
  assert.equal(extractCanonicalModel(modelUsage, "opus"), null, "no opus entry exists in this turn");
});

test("extracts opus just as precisely", () => {
  const modelUsage = { "claude-opus-5": { outputTokens: 44 }, "claude-haiku-4-5-20251001": { outputTokens: 3 } };
  assert.equal(extractCanonicalModel(modelUsage, "opus"), "claude-opus-5");
});

test("a short main turn next to a larger helper call is still attributed by NAME, not by size", () => {
  // The whole point of matching by alias substring rather than "pick the biggest entry":
  // a trivial one-word answer from the configured model must not be misattributed to a
  // larger auxiliary call.
  const modelUsage = { "claude-haiku-4-5-20251001": { outputTokens: 500 }, "claude-sonnet-5": { outputTokens: 2 } };
  assert.equal(extractCanonicalModel(modelUsage, "sonnet"), "claude-sonnet-5");
});

test("no modelUsage, no alias, or no match all resolve to null rather than guessing", () => {
  assert.equal(extractCanonicalModel(null, "sonnet"), null);
  assert.equal(extractCanonicalModel({}, "sonnet"), null);
  assert.equal(extractCanonicalModel({ "claude-opus-5": {} }, "sonnet"), null);
  assert.equal(extractCanonicalModel({ "claude-sonnet-5": {} }, undefined), null);
  assert.equal(extractCanonicalModel({ "claude-sonnet-5": {} }, ""), null);
});

// ---------------------------------------------------------------------------
// Model catalog (SDK `initialize` -> picker options)
//
// The ids below are SYNTHETIC where marked: they prove the parser's rules and are not a
// claim that those models exist.
// ---------------------------------------------------------------------------

const row = (value, resolvedModel, displayName, efforts = ["low", "medium", "high"]) =>
  normalizeSdkModel({ value, resolvedModel, displayName, supportsEffort: true, supportedEffortLevels: efforts });

const CATALOG = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  row("opus", "claude-opus-5-5", "Opus 5.5"),
  row("claude-fable-5-1", "claude-fable-5-1", "Fable 5.1"),
  row("sonnet", "claude-sonnet-5-5", "Sonnet 5.5"),
  normalizeSdkModel({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }),
  row("claude-sonnet-5", "claude-sonnet-5", "Sonnet 5"),
  row("claude-opus-5", "claude-opus-5", "Opus 5"),
].map((entry) => (entry.value ? entry : null)).filter(Boolean);

test("an alias (value != resolvedModel) stays an ALIAS and is labelled 'Актуальный <Family>'", () => {
  const { options } = buildClaudeModelOptions(CATALOG);
  const sonnet = options.find((o) => o.id === "sonnet");
  assert.equal(sonnet.kind, "alias");
  assert.equal(sonnet.label, "Актуальный Sonnet");
  assert.equal(sonnet.canonicalId, "claude-sonnet-5-5");
  assert.equal(sonnet.resolvesToLabel, "Sonnet 5.5");
});

test("Sonnet 5 and Sonnet 5.5 coexist as two separate PINNED options next to the alias", () => {
  const { options } = buildClaudeModelOptions(CATALOG);
  const pinned = options.filter((o) => o.kind === "pinned" && o.family === "sonnet");
  assert.deepEqual(pinned.map((o) => [o.id, o.label]), [["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-sonnet-5", "Sonnet 5"]]);
  assert.notEqual(options.find((o) => o.id === "sonnet").label, "Sonnet 5.5", "the alias is never labelled as a pinned version");
});

test("Fable and Haiku appear when the catalog lists them; the 'default' entry is not an option", () => {
  const { options, defaultModel } = buildClaudeModelOptions(CATALOG);
  assert.ok(options.some((o) => o.id === "claude-fable-5-1" && o.kind === "pinned" && o.label === "Fable 5.1"));
  assert.ok(options.some((o) => o.id === "haiku" && o.kind === "alias"));
  assert.ok(options.some((o) => o.id === "claude-haiku-4-5-20251001" && o.kind === "pinned" && o.label === "Haiku 4.5"));
  assert.equal(options.some((o) => o.id === "default"), false);
  assert.deepEqual(defaultModel, { canonicalId: "claude-opus-5-5", label: "Opus 5.5" });
});

test("a model the catalog does not list is not selectable, and neither is an arbitrary string", () => {
  const { options } = buildClaudeModelOptions(CATALOG);
  for (const bad of ["claude-sonnet-9", "claude-sonnet-5.5", "sonnet; rm -rf /", "--model", "", "SONNET", "../x", null, undefined, 5]) {
    assert.equal(isSelectableModelId(bad, options), false, String(bad));
  }
  assert.equal(isSelectableModelId("inherit", options), true);
  assert.equal(isSelectableModelId("claude-sonnet-5", options), true);
});

test("a synthetic FUTURE alias target is parsed by rule only (parser proof, not a claim it exists)", () => {
  const { options } = buildClaudeModelOptions([row("sonnet", "claude-sonnet-9-1", "Sonnet 9.1")]);
  assert.equal(options.find((o) => o.id === "sonnet").resolvesToLabel, "Sonnet 9.1");
  assert.ok(options.some((o) => o.id === "claude-sonnet-9-1" && o.kind === "pinned"));
});

test("an unlabelled entry falls back to the id-derived label, never an invented one", () => {
  const { options } = buildClaudeModelOptions([normalizeSdkModel({ value: "claude-opus-5", resolvedModel: "claude-opus-5" })]);
  assert.equal(options[0].label, "Opus 5");
  const odd = buildClaudeModelOptions([normalizeSdkModel({ value: "mystery", resolvedModel: "mystery-model-1" })]).options;
  assert.equal(odd.find((o) => o.id === "mystery").label, "Актуальный Mystery");
  assert.equal(odd.find((o) => o.id === "mystery").version, null, "no version is guessed from a non-matching id");
});

test("normalizeSdkModel drops malformed rows", () => {
  assert.equal(normalizeSdkModel(null), null);
  assert.equal(normalizeSdkModel({ value: "x" }), null);
  assert.equal(normalizeSdkModel({ resolvedModel: "x" }), null);
});

test("pinned selections are matched EXACTLY in modelUsage: Sonnet 5 never matches Sonnet 5.5", () => {
  const usage = { "claude-sonnet-5-5": { outputTokens: 20 }, "claude-haiku-4-5-20251001": { outputTokens: 3 } };
  assert.equal(extractCanonicalModel(usage, "claude-sonnet-5"), null);
  assert.equal(extractCanonicalModel(usage, "claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(extractCanonicalModel({ "claude-sonnet-5": {}, "claude-sonnet-5-5": {} }, "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(extractCanonicalModel(usage, "sonnet"), "claude-sonnet-5-5", "an alias still matches by family");
});

test("discovery builds the catalog from an injected probe, caches it, and survives probe failure via the stale cache", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mur-caps-"));
  try {
    const cacheFile = path.join(dir, "claude.json");
    let probes = 0;
    const base = { command: process.execPath, run: async () => ({ stdout: REAL_HELP_EXCERPT }), cacheFile };
    const first = await discoverClaudeCapabilities({ ...base, probe: async () => { probes += 1; return CATALOG; } });
    assert.equal(first.catalogSource, "sdk-initialize");
    assert.ok(first.supportedModels.includes("claude-sonnet-5") && first.supportedModels.includes("sonnet"));
    assert.equal(first.modelFlagSupported, true);
    const second = await discoverClaudeCapabilities({ ...base, probe: async () => { probes += 1; return []; } });
    assert.equal(second.catalogSource, "cache");
    assert.equal(probes, 1, "a fresh cache means no second probe");
    const failing = await discoverClaudeCapabilities({
      ...base, refresh: true, now: Date.now() + 7 * 3600_000, probe: async () => { throw new Error("offline"); },
    });
    assert.equal(failing.catalogSource, "stale-cache", "a failed probe falls back to the last known catalog");
    const noCache = await discoverClaudeCapabilities({ ...base, cacheFile: path.join(dir, "other.json"), probe: async () => { throw new Error("offline"); } });
    assert.equal(noCache.catalogSource, "help", "with no cache the documented aliases are the only evidence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the probe sends only the initialize control request and returns public rows (never the account block)", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const written = [];
  const spawnImpl = (binary, args) => {
    assert.equal(binary, "/fake/claude");
    assert.ok(args.includes("stream-json") && args.includes("--no-session-persistence"));
    assert.equal(args.some((a) => /^[^-]/.test(a) && a.includes(" ")), false, "no prompt text in argv");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => {
      written.push(String(chunk));
      const request = JSON.parse(String(chunk));
      child.stdout.write(`${JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: request.request_id, response: {
          account: { email: "someone@example.invalid" },
          models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportedEffortLevels: ["low"] }],
        } },
      })}\n`);
    });
    return child;
  };
  const rows = await probeClaudeModelCatalog({ binary: "/fake/claude", spawnImpl, timeoutMs: 2000 });
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).request.subtype, "initialize");
  assert.deepEqual(rows.map((r) => r.value), ["sonnet"]);
  assert.doesNotMatch(JSON.stringify(rows), /example\.invalid|email|account/);
});
