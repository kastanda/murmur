import assert from "node:assert/strict";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import test from "node:test";
import {
  CODEX_SOURCES,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  MACOS_CHATGPT_CODEX_PATH,
  codexAppServerCommand,
  discoverCodexExecutable,
  normalizeUnixEndpointArg,
  resolveOnPath,
  unixEndpoint,
} from "../scripts/operator/codex.mjs";

const OVERRIDE = "/opt/custom/bin/codex";
const ON_PATH = "/usr/local/bin/codex";
const fake = (...present) => (candidate) => present.includes(candidate);

test("discovery prefers an explicit override, then PATH, then the ChatGPT bundle", () => {
  const env = { PATH: "/usr/local/bin" };

  const override = discoverCodexExecutable({
    override: OVERRIDE, env, platform: "darwin", isExecutable: fake(OVERRIDE, ON_PATH, MACOS_CHATGPT_CODEX_PATH),
  });
  assert.equal(override.path, OVERRIDE);
  assert.equal(override.source, CODEX_SOURCES.override);

  const onPath = discoverCodexExecutable({
    env, platform: "darwin", isExecutable: fake(ON_PATH, MACOS_CHATGPT_CODEX_PATH),
  });
  assert.equal(onPath.path, ON_PATH);
  assert.equal(onPath.source, CODEX_SOURCES.path);

  const bundled = discoverCodexExecutable({
    env, platform: "darwin", isExecutable: fake(MACOS_CHATGPT_CODEX_PATH),
  });
  assert.equal(bundled.path, MACOS_CHATGPT_CODEX_PATH);
  assert.equal(bundled.source, CODEX_SOURCES.chatgptBundle);
});

test("an override that is not executable falls through and is reported, not silently honoured", () => {
  const result = discoverCodexExecutable({
    override: "/opt/typo/codex",
    env: { PATH: "/usr/local/bin" },
    platform: "darwin",
    isExecutable: fake(ON_PATH),
  });
  assert.equal(result.path, ON_PATH);
  assert.equal(result.source, CODEX_SOURCES.path);
  assert.equal(result.overrideIgnored, "/opt/typo/codex");
});

test("no Codex anywhere reports no executable, and the bundle is macOS-only", () => {
  const none = discoverCodexExecutable({ env: { PATH: "/nowhere" }, platform: "darwin", isExecutable: () => false });
  assert.equal(none.path, null);
  assert.equal(none.source, null);
  assert.deepEqual(none.attempted.map((entry) => entry.source), [CODEX_SOURCES.path, CODEX_SOURCES.chatgptBundle]);

  const linux = discoverCodexExecutable({ env: { PATH: "/nowhere" }, platform: "linux", isExecutable: fake(MACOS_CHATGPT_CODEX_PATH) });
  assert.equal(linux.path, null);
  assert.deepEqual(linux.attempted.map((entry) => entry.source), [CODEX_SOURCES.path]);
});

test("PATH resolution never goes through a shell", () => {
  const env = { PATH: "/usr/local/bin" };
  assert.equal(resolveOnPath("codex", env, fake(ON_PATH)), ON_PATH);
  assert.equal(resolveOnPath("codex; rm -rf /", env, fake(ON_PATH)), null);
  assert.equal(resolveOnPath("", env, fake(ON_PATH)), null);
  assert.equal(resolveOnPath("/abs/codex", env, fake("/abs/codex")), "/abs/codex");
});

test("the canonical endpoint for an absolute socket path has three slashes", () => {
  assert.equal(unixEndpoint("/Users/x/.murmur/projects/p/run/codex.sock"), "unix:///Users/x/.murmur/projects/p/run/codex.sock");
  assert.equal(unixEndpoint("/private/tmp/p/run/codex.sock"), "unix:///private/tmp/p/run/codex.sock");
  assert.throws(() => unixEndpoint(""), /codex-socket-path-required/);
});

test("a two-slash unix: argument is normalized to the canonical form", () => {
  assert.equal(normalizeUnixEndpointArg("unix:/a/b"), "unix:///a/b");
  assert.equal(normalizeUnixEndpointArg("unix://a/b"), "unix:///a/b");
  assert.equal(normalizeUnixEndpointArg("unix:///a/b"), "unix:///a/b");
  assert.equal(normalizeUnixEndpointArg("--listen"), "--listen");
});

test("the exact App Server argv is <resolved-codex> app-server --listen unix:///<socket>", () => {
  const socket = "/private/tmp/mur/run/codex.sock";
  const built = codexAppServerCommand({}, socket, {
    env: { PATH: "/usr/local/bin" },
    platform: "darwin",
    isExecutable: fake(ON_PATH),
  });
  assert.deepEqual([built.command, ...built.args], [
    ON_PATH,
    "app-server",
    "--listen",
    "unix:///private/tmp/mur/run/codex.sock",
  ]);
  assert.equal(built.endpoint, "unix:///private/tmp/mur/run/codex.sock");
  assert.deepEqual([...DEFAULT_CODEX_APP_SERVER_ARGS], ["app-server", "--listen", "{endpoint}"]);
});

test("the argv carries no executable when discovery found nothing", () => {
  const built = codexAppServerCommand({}, "/run/x.sock", { env: { PATH: "" }, platform: "linux", isExecutable: () => false });
  assert.equal(built.command, null);
});

// Evidence check against THIS machine: when `codex` is absent from PATH, the ChatGPT
// desktop bundle must be discovered. Skipped where that app is not installed.
const bundleUsable = (() => {
  try {
    return statSync(MACOS_CHATGPT_CODEX_PATH).isFile() && (accessSync(MACOS_CHATGPT_CODEX_PATH, constants.X_OK) ?? true);
  } catch {
    return false;
  }
})();

test("the real ChatGPT-bundled Codex CLI is discovered when PATH has no codex", {
  skip: !(process.platform === "darwin" && existsSync(MACOS_CHATGPT_CODEX_PATH) && bundleUsable)
    ? "ChatGPT-bundled Codex CLI not installed"
    : false,
}, () => {
  const result = discoverCodexExecutable({ env: { PATH: "/nonexistent-path-for-this-test" }, platform: "darwin" });
  assert.equal(result.source, CODEX_SOURCES.chatgptBundle);
  assert.equal(result.path, MACOS_CHATGPT_CODEX_PATH);

  const built = codexAppServerCommand({}, "/private/tmp/mur/run/codex.sock", { env: { PATH: "/nonexistent-path-for-this-test" } });
  assert.deepEqual(built.args, ["app-server", "--listen", "unix:///private/tmp/mur/run/codex.sock"]);
  assert.equal(built.command, MACOS_CHATGPT_CODEX_PATH);
});
