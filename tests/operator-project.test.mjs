import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultProjectsRoot,
  locateProject,
  murmurHome,
  projectIdFor,
  projectPathsFor,
  resolveProject,
  socketPathFits,
} from "../scripts/operator/project.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "murmur-operator-project-"));

test("a bare project name resolves under ~/Projects/<name>", () => {
  const home = tmp();
  try {
    const projects = path.join(home, "Projects");
    mkdirSync(path.join(projects, "murmur"), { recursive: true });
    assert.equal(defaultProjectsRoot(home), projects);
    const resolved = resolveProject("murmur", { homedir: home });
    assert.equal(path.basename(resolved.projectPath), "murmur");
    assert.ok(resolved.projectPath.endsWith(path.join("Projects", "murmur")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a project name containing spaces resolves as one directory entry", () => {
  const home = tmp();
  try {
    mkdirSync(path.join(home, "Projects", "Ribambelle Operations"), { recursive: true });
    const resolved = resolveProject("Ribambelle Operations", { homedir: home });
    assert.equal(path.basename(resolved.projectPath), "Ribambelle Operations");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an absolute path is used as given and canonicalized through symlinks", () => {
  const dir = tmp();
  try {
    const real = path.join(dir, "real-project");
    const link = path.join(dir, "link-project");
    mkdirSync(real);
    symlinkSync(real, link);
    const viaReal = resolveProject(real, {});
    const viaLink = resolveProject(link, {});
    assert.equal(viaReal.projectPath, viaLink.projectPath);
    assert.equal(projectIdFor(viaReal.projectPath), projectIdFor(viaLink.projectPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`~/...` is expanded before resolution", () => {
  const home = tmp();
  try {
    mkdirSync(path.join(home, "work", "thing"), { recursive: true });
    const resolved = resolveProject("~/work/thing", { homedir: home });
    assert.equal(path.basename(resolved.projectPath), "thing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a bare name may not contain a path separator or traversal", () => {
  const home = tmp();
  try {
    mkdirSync(path.join(home, "Projects"), { recursive: true });
    for (const bad of ["../etc", "a/b", "..", ".", "x\\y"]) {
      assert.throws(() => resolveProject(bad, { homedir: home }), /project-name-must-be-plain/);
    }
    assert.throws(() => resolveProject("", { homedir: home }), /project-required/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing or non-directory project fails with an explicit error", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "file.txt"), "x");
    assert.throws(() => resolveProject(path.join(dir, "nope"), {}), /project-not-found/);
    assert.throws(() => resolveProject(path.join(dir, "file.txt"), {}), /project-not-a-directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project id is deterministic, filesystem-safe and path-distinct", () => {
  const a = projectIdFor("/Users/someone/Projects/murmur");
  const b = projectIdFor("/Users/someone/Projects/murmur");
  const c = projectIdFor("/Users/someone/other/murmur");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-z0-9-]+$/);
  assert.equal(projectIdFor("/tmp/Ribambelle Operations").startsWith("ribambelle-opera"), true);
  assert.match(projectIdFor("/tmp/...."), /^project-[0-9a-f]{12}$/);
});

test("state paths live under the Murmur home, never inside the project", () => {
  const home = "/var/tmp/murmur-home";
  const paths = projectPathsFor("demo-0123456789ab", { home });
  assert.equal(paths.root, path.join(home, "projects", "demo-0123456789ab"));
  assert.ok(paths.projectFile.startsWith(paths.root));
  assert.ok(paths.agentDir("claude").startsWith(paths.agentsDir));
  assert.ok(paths.codexSocket.startsWith(paths.runDir));
  assert.ok(paths.logFile("claude").startsWith(paths.logsDir));
  assert.notEqual(paths.lockFile, paths.bootstrapLockFile);
});

test("MURMUR_HOME overrides the state root", () => {
  assert.equal(murmurHome({ MURMUR_HOME: "/x/y" }, "/home/u"), "/x/y");
  assert.equal(murmurHome({}, "/home/u"), path.join("/home/u", ".murmur"));
});

test("two projects never collide on state paths", () => {
  const home = "/var/tmp/murmur-home";
  const one = projectPathsFor(projectIdFor("/a/alpha"), { home });
  const two = projectPathsFor(projectIdFor("/b/alpha"), { home });
  assert.notEqual(one.root, two.root);
  assert.notEqual(one.codexSocket, two.codexSocket);
  assert.notEqual(one.supervisorFile, two.supervisorFile);
  assert.notEqual(one.logFile("claude"), two.logFile("claude"));
  assert.notEqual(one.agentDir("claude"), two.agentDir("claude"));
});

test("the default socket path stays inside the AF_UNIX limit", () => {
  const paths = projectPathsFor(projectIdFor("/Users/a-fairly-long-user-name/Projects/some-long-project-name"), {
    home: path.join("/Users/a-fairly-long-user-name", ".murmur"),
  });
  assert.ok(socketPathFits(paths.codexSocket), paths.codexSocket);
  assert.equal(socketPathFits("/x".repeat(80)), false);
});

test("locateProject composes resolution, identity and paths", () => {
  const home = tmp();
  try {
    mkdirSync(path.join(home, "Projects", "demo"), { recursive: true });
    const located = locateProject(path.join(home, "Projects", "demo"), { home: path.join(home, ".murmur") });
    assert.equal(located.projectId, projectIdFor(located.projectPath));
    assert.ok(located.paths.root.includes(located.projectId));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
