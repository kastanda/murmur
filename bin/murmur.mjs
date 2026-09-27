#!/usr/bin/env node
/** `murmur` — local operator CLI entry point. */

// `node:sqlite` is still flagged experimental, so every command would otherwise open
// with a two-line Node warning. Only that one warning is suppressed; everything else
// still reaches the operator.
const defaultWarning = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  for (const listener of defaultWarning) listener(warning);
});

const { run } = await import("../scripts/operator/cli.mjs");
process.exitCode = await run();
