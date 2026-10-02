/**
 * claude-capabilities.mjs — what the INSTALLED Claude CLI actually supports, discovered
 * locally.
 *
 * Why this exists
 * ----------------
 * Murmur must let an operator choose a Claude model/effort level, but it must never
 * invent a flag or a model identifier the installed CLI does not actually accept — a
 * fabricated `--model claude-sonnet-5.5` would either be silently misinterpreted or
 * rejected with a confusing API error (`is_error: true`, exit code 0 — see below) deep
 * inside a turn that already consumed tokens.
 *
 * The CLI's own `--help` output is the one place this information lives without a
 * network round trip: `--model <model>` documents its accepted ALIASES inline ("Provide
 * an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')"), and `--effort
 * <level>` documents its accepted LEVELS inline ("(low, medium, high, xhigh, max)").
 * Parsing that text is the authoritative, zero-network, zero-cost discovery mechanism —
 * and if a future CLI renames its flags or aliases, the regexes below simply stop
 * matching and every caller treats the feature as unsupported rather than guessing.
 *
 * What was verified empirically against the installed CLI before this file was written
 * (claude 2.1.274): `--model sonnet` resolves to `claude-sonnet-5`, `--model opus`
 * resolves to `claude-opus-5` (confirmed via the `modelUsage[...].canonicalModel` field
 * of one real `--output-format json` turn each); an unknown `--model` value does NOT
 * fail the process (exit 0) but returns `is_error: true` with `api_error_status: 404` in
 * the JSON body; an unknown `--effort` value is silently ignored with a stderr warning
 * and the default effort is used. Both failure modes are exactly why Murmur validates
 * against a locally discovered allowlist before ever building argv, rather than trusting
 * the CLI to reject a bad value.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** PATH lookup without a shell — mirrors `operator/doctor.mjs`'s `findExecutable`. */
export const findClaudeExecutable = (command = "claude", env = process.env) => {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

/**
 * The two model ALIASES Murmur ever offers. Not "every alias the CLI happens to
 * document" (its `--help` text also shows `fable` as an example, a different tier this
 * feature does not expose) — exactly the two the menu asks for, each individually
 * confirmed present in the installed CLI's own `--model` description before being
 * treated as supported.
 */
const CANDIDATE_MODELS = Object.freeze(["sonnet", "opus"]);

/**
 * Parse `--help` text for what `--model`/`--effort` actually document.
 *
 * Pure and synchronous so it is trivially unit-testable against captured real and
 * malformed help text, independent of the installed CLI being present at all.
 */
export const parseClaudeHelp = (helpText) => {
  const text = String(helpText ?? "");
  const modelFlagPresent = /--model\s*<model>/.test(text);
  const effortFlagPresent = /--effort\s*<level>/.test(text);

  // Only the exact quoted aliases MENTIONED NEXT TO the --model flag's own description
  // count as discovered — a model name appearing anywhere else in a multi-page --help
  // dump (e.g. in `--agents` JSON example prose) must not be mistaken for a supported
  // alias.
  const modelSection = text.match(/--model\s*<model>[\s\S]{0,400}?(?=\n\s*(?:-{1,2}\S|\n)|$)/)?.[0] || "";
  const quotedInModelSection = new Set([...modelSection.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]));
  const supportedModels = modelFlagPresent
    ? CANDIDATE_MODELS.filter((alias) => quotedInModelSection.has(alias))
    : [];

  // The effort section states its full valid set as one literal parenthesised list —
  // take it verbatim rather than guessing a fixed set ourselves, so a future CLI that
  // adds or removes a level is reflected without a Murmur code change.
  const effortSection = text.match(/--effort\s*<level>[\s\S]{0,400}?\(([a-z, ]+)\)/)?.[1] || "";
  const supportedEfforts = effortFlagPresent
    ? effortSection.split(",").map((level) => level.trim()).filter(Boolean)
    : [];

  return {
    modelFlagSupported: modelFlagPresent && supportedModels.length > 0,
    effortFlagSupported: effortFlagPresent && supportedEfforts.length > 0,
    supportedModels,
    supportedEfforts,
  };
};

const EMPTY_CAPABILITIES = Object.freeze({
  available: false,
  modelFlagSupported: false,
  effortFlagSupported: false,
  supportedModels: [],
  supportedEfforts: [],
});

/**
 * The CANONICAL model id actually used for a completed turn, e.g. `claude-sonnet-5` —
 * distinct from the ALIAS Murmur configured (`sonnet`) and from the human LABEL
 * ("Sonnet 5"). Extracted from the real `modelUsage` object a completed
 * `--output-format json` turn already returns (see `claude-one-shot-runtime.mjs`) —
 * never from a dedicated probe turn, so establishing it costs nothing beyond work
 * Murmur was already doing.
 *
 * `modelUsage` can carry more than one entry (a tiny Haiku helper call alongside the
 * main answering model is routinely observed), so the entry is chosen by matching the
 * CONFIGURED alias as a case-insensitive substring of the key — "sonnet" only ever
 * matches a key containing "sonnet" — rather than by picking the largest entry, which
 * would silently misattribute the helper call's model on a very short main turn.
 */
export const extractCanonicalModel = (modelUsage, alias) => {
  if (!modelUsage || typeof modelUsage !== "object" || typeof alias !== "string" || !alias) return null;
  const needle = alias.toLowerCase();
  const matches = Object.keys(modelUsage).filter((key) => key.toLowerCase().includes(needle));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // More than one match (unlikely for "sonnet"/"opus", but not impossible): the entry
  // with the most output tokens is the one that actually produced the answer.
  return matches.reduce((best, key) => {
    const tokens = (entry) => Number(modelUsage[entry]?.outputTokens) || 0;
    return tokens(key) > tokens(best) ? key : best;
  });
};

/**
 * Parse a canonical model id into a truthful human label — "Sonnet 5", "Opus 5", and
 * (only if the installed CLI ever actually reports one) "Sonnet 5.5" for a hypothetical
 * `claude-sonnet-5-5`. This NEVER invents a version: an id that does not match the
 * expected `claude-<tier>-<version-parts>` shape returns `null`, and every caller falls
 * back to the bare alias label ("Sonnet") rather than guessing.
 */
export const canonicalModelLabel = (canonicalId) => {
  if (typeof canonicalId !== "string") return null;
  // Exactly one or two numeric version segments — "5" or "5-5" (→ "5.5") — never more.
  // An unbounded segment count would also match a dated snapshot id like
  // `claude-haiku-4-5-20251001` and render a nonsensical "Haiku 4.5.20251001"; real
  // Anthropic version identifiers are at most major.minor, so this stays a precise parse
  // rather than a loose one that happens to work for today's two known ids.
  const match = canonicalId.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i);
  if (!match) return null;
  const [, tier, major, minor] = match;
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
  return `${tierLabel} ${minor ? `${major}.${minor}` : major}`;
};

/**
 * Discover what the installed `claude` CLI supports, right now, with zero network
 * access: one local `--help` invocation (argv only — `execFile`, never a shell), parsed
 * with {@link parseClaudeHelp}.
 *
 * Returns a value object rather than throwing: "the CLI is missing" or "a future CLI
 * dropped `--effort`" are both ORDINARY states every caller (doctor, the config
 * resolver, the menu bar) must render as "not supported", never crash on.
 */
export const discoverClaudeCapabilities = async ({
  command = "claude",
  env = process.env,
  timeoutMs = 10_000,
  // Injectable so tests exercise the real parsing logic against FAKE `--help` text,
  // without spawning the actual installed CLI — mirrors `operator/doctor.mjs`'s own
  // `run` injection for `checkClaude`/`checkCursor`.
  run = (binary, args) => execFileAsync(binary, args, { timeout: timeoutMs, encoding: "utf8" }),
} = {}) => {
  const binary = findClaudeExecutable(command, env);
  if (!binary) return { ...EMPTY_CAPABILITIES, binary: null };
  try {
    const { stdout } = await run(binary, ["--help"]);
    return { ...parseClaudeHelp(stdout), available: true, binary };
  } catch {
    return { ...EMPTY_CAPABILITIES, binary };
  }
};
