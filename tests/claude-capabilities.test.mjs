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
import test from "node:test";
import {
  canonicalModelLabel,
  discoverClaudeCapabilities,
  extractCanonicalModel,
  findClaudeExecutable,
  parseClaudeHelp,
} from "../scripts/claude-capabilities.mjs";

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

test("parses the real --model section: only sonnet/opus of the documented aliases, never fable", () => {
  const caps = parseClaudeHelp(REAL_HELP_EXCERPT);
  assert.equal(caps.modelFlagSupported, true);
  assert.deepEqual(caps.supportedModels, ["sonnet", "opus"]);
});

test("parses the real --effort section verbatim, not a hardcoded guess", () => {
  const caps = parseClaudeHelp(REAL_HELP_EXCERPT);
  assert.equal(caps.effortFlagSupported, true);
  assert.deepEqual(caps.supportedEfforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("a model name appearing elsewhere in the help text is not mistaken for a --model alias", () => {
  const text = `${REAL_HELP_EXCERPT}\n  --agents <json>   e.g. '{"sonnet-helper": {...}}'\n`;
  const caps = parseClaudeHelp(text);
  assert.deepEqual(caps.supportedModels, ["sonnet", "opus"], "the unrelated mention must not add a third model");
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

test("a --model flag present with zero recognised aliases is reported unsupported", () => {
  // A future CLI renaming its aliases away from sonnet/opus must make Murmur say
  // "not supported" rather than silently keep offering a name the CLI no longer accepts.
  const caps = parseClaudeHelp("--model <model>   Provide an alias (e.g. 'haiku', 'titan')\n");
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
    assert.equal(caps.supportedModels.length, 2);
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
    supportedModels: [], supportedEfforts: [], binary: null,
  });
});

test("the ACTUAL installed Claude CLI on this machine is discovered and matches live reality", async () => {
  // This is the one test in the suite that touches the real binary — it exists
  // specifically to prove the parsing logic agrees with what is really installed here,
  // the same empirical check performed manually before this module was written.
  const caps = await discoverClaudeCapabilities();
  if (!caps.available) return; // no claude installed in this environment; nothing to assert
  assert.ok(caps.supportedModels.includes("sonnet") || caps.supportedModels.includes("opus"),
    "the installed CLI's own --help no longer mentions either alias Murmur offers");
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

test("a dated snapshot id is never mistaken for a dotted version number", () => {
  // claude-haiku-4-5-20251001 has THREE numeric segments; real Anthropic ids are at most
  // major.minor, so this must stay unparsed rather than rendering "Haiku 4.5.20251001".
  assert.equal(canonicalModelLabel("claude-haiku-4-5-20251001"), null);
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
