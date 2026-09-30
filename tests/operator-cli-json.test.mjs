/**
 * operator-cli-json.test.mjs — the machine-readable surfaces a GUI depends on.
 *
 * These exist so the menu bar app never has to scrape a human transcript. The properties
 * that matter are therefore about CONTRACT, not formatting: the shapes stay decodable,
 * they carry no credential, and an operator-facing wording change cannot silently break
 * a client.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePrivateJson } from "../scripts/secure-state.mjs";
import { listProfiles } from "../scripts/operator/cli.mjs";
import { bootstrapProfile } from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const setup = async ({ projects = ["alpha"] } = {}) => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-clijson-"));
  const home = path.join(dir, ".murmur");
  const created = [];
  for (const name of projects) {
    const projectPath = path.join(dir, name);
    mkdirSync(projectPath, { recursive: true });
    const projectId = projectIdFor(projectPath);
    const paths = projectPathsFor(projectId, { home });
    await bootstrapProfile({ projectId, projectPath, paths });
    created.push({ name, projectPath, projectId, paths });
  }
  return { dir, home, created, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

test("listProfiles reports the human project name, never the hashed profile directory", async () => {
  const ctx = await setup({ projects: ["alpha", "beta"] });
  try {
    const profiles = await listProfiles({ home: ctx.home });
    assert.deepEqual(profiles.map((entry) => entry.name).sort(), ["alpha", "beta"]);
    for (const profile of profiles) {
      assert.equal(profile.valid, true);
      // The id is still there for addressing, but the NAME a human reads is the project's
      // own directory — a picker full of `alpha-9f2c1d...` entries is unusable.
      assert.match(profile.projectId, /^(alpha|beta)-[0-9a-f]{12}$/);
      assert.notEqual(profile.name, profile.projectId);
      assert.ok(profile.projectPath.endsWith(`/${profile.name}`));
      assert.ok(profile.logsDir.startsWith(profile.profileRoot));
    }
  } finally {
    ctx.cleanup();
  }
});

test("listProfiles never exposes a credential", async () => {
  const ctx = await setup();
  try {
    // A profile WITH a NATS token is the case that matters: the raw project.json holds it,
    // and a GUI reading that file itself would load it into a process that has no business
    // with it. The redacted summary reports only that one is configured.
    const [project] = ctx.created;
    const raw = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(project.paths.projectFile, "utf8")),
    );
    raw.natsToken = "super-secret-token-value";
    await writePrivateJson(project.paths.projectFile, raw);

    const profiles = await listProfiles({ home: ctx.home });
    const serialized = JSON.stringify(profiles);
    assert.doesNotMatch(serialized, /super-secret-token-value/);
    assert.equal(profiles[0].profile.natsTokenConfigured, true);
    assert.equal(profiles[0].profile.natsToken, undefined);
    // No private key material either, from any identity.
    assert.doesNotMatch(serialized, /privateKey/);
  } finally {
    ctx.cleanup();
  }
});

test("an unreadable profile is reported, not silently dropped from the list", async () => {
  const ctx = await setup({ projects: ["alpha"] });
  try {
    // A project that vanished from a picker is worse than one shown as broken: the
    // operator would conclude it was deleted.
    const broken = path.join(ctx.home, "projects", "broken-000000000000");
    mkdirSync(broken, { recursive: true });
    await writePrivateJson(path.join(broken, "project.json"), { version: 99 });

    const profiles = await listProfiles({ home: ctx.home });
    assert.equal(profiles.length, 2);
    const invalid = profiles.find((entry) => entry.projectId === "broken-000000000000");
    assert.equal(invalid.valid, false);
    assert.match(invalid.reason, /version-unsupported/);
    assert.equal(invalid.projectPath, null);
  } finally {
    ctx.cleanup();
  }
});

test("no Murmur home at all is an empty list, not a crash", async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-clijson-empty-"));
  try {
    assert.deepEqual(await listProfiles({ home: path.join(dir, "nothing-here") }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file sitting among the profile directories is skipped", async () => {
  const ctx = await setup();
  try {
    await writePrivateJson(path.join(ctx.home, "projects", ".DS_Store.json"), {});
    const profiles = await listProfiles({ home: ctx.home });
    assert.equal(profiles.length, 1, "only directories are profiles");
  } finally {
    ctx.cleanup();
  }
});
