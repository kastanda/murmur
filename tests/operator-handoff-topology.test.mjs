/**
 * operator-handoff-topology.test.mjs — the WORKER MESH in an operator profile.
 *
 * `tests/agent-handoff-three-agent.test.mjs` already proves the nested runtime flow
 * (Claude -> Codex -> Cursor -> Codex -> Claude) end to end against hand-wired pairing.
 * What is proven HERE is the thing that decides whether that flow is reachable at all in
 * a real project: that `murmur start` pairs Codex and Cursor in both directions, that it
 * repairs an existing profile in place without rotating a key, and that the controller
 * therefore offers the sibling as a delegation target while the cycle rule is untouched.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HANDOFF_REASONS, peerSupportsHandoffV1 } from "@murmurv2/core";
import { AgentHandoffController } from "../scripts/agent-handoff-controller.mjs";
import { readPrivateJson, writePrivateJson } from "../scripts/secure-state.mjs";
import {
  DEFAULT_TRUST_EDGES,
  agentIdFor,
  bootstrapProfile,
  peersForAgent,
} from "../scripts/operator/profile.mjs";
import { projectIdFor, projectPathsFor } from "../scripts/operator/project.mjs";

const shortTmp = () => (existsSync("/tmp") ? "/tmp" : os.tmpdir());

const setup = async () => {
  const dir = mkdtempSync(path.join(shortTmp(), "mur-mesh-"));
  const projectPath = path.join(dir, "project");
  mkdirSync(projectPath, { recursive: true });
  const projectId = projectIdFor(projectPath);
  const paths = projectPathsFor(projectId, { home: path.join(dir, ".murmur") });
  await bootstrapProfile({ projectId, projectPath, paths });
  return {
    dir,
    projectPath,
    projectId,
    paths,
    id: (role) => agentIdFor(projectId, role),
    config: (role) => readPrivateJson(paths.agentConfigFile(role)),
    raw: (role) => readFileSync(paths.agentConfigFile(role), "utf8"),
    rerun: () => bootstrapProfile({ projectId, projectPath, paths }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/**
 * A controller wired to the peers a REAL profile produced. The store and envelope builder
 * are never reached: `handoffTargets()` and `planDelegation()` are pure authorization.
 */
const controllerFor = (agentId, peers) => new AgentHandoffController({
  store: { findByCause: () => null },
  agentId,
  peers,
  buildHandoffEnvelope: async () => {
    throw new Error("must-not-build");
  },
});

// ---------------------------------------------------------------------------
// A new profile
// ---------------------------------------------------------------------------

test("a new profile pairs Codex and Cursor in BOTH directions", async () => {
  const ctx = await setup();
  try {
    const codex = await ctx.config("codex");
    const cursor = await ctx.config("cursor");

    assert.ok(codex.peers[ctx.id("cursor")], "Codex must know Cursor");
    assert.ok(cursor.peers[ctx.id("codex")], "Cursor must know Codex");
    assert.equal(codex.peers[ctx.id("cursor")].signing.publicKey, cursor.keys.signing.publicKey);
    assert.equal(cursor.peers[ctx.id("codex")].signing.publicKey, codex.keys.signing.publicKey);
    assert.equal(codex.peers[ctx.id("cursor")].subject, `msg.${ctx.id("cursor")}`);
  } finally {
    ctx.cleanup();
  }
});

test("both workers advertise protocol 1.1 and handoff-v1 to each other", async () => {
  const ctx = await setup();
  try {
    const codex = await ctx.config("codex");
    const cursor = await ctx.config("cursor");
    for (const config of [codex, cursor]) {
      assert.ok(config.protocolVersions.includes("1.1"));
      assert.ok(config.features.includes("handoff-v1"));
    }
    assert.equal(peerSupportsHandoffV1(codex.peers[ctx.id("cursor")]), true);
    assert.equal(peerSupportsHandoffV1(cursor.peers[ctx.id("codex")]), true);
  } finally {
    ctx.cleanup();
  }
});

test("root stays coordinator-only: it is paired with Claude and with no worker", async () => {
  const ctx = await setup();
  try {
    assert.deepEqual(peersForAgent("root"), ["claude"]);
    assert.deepEqual(
      DEFAULT_TRUST_EDGES.filter((edge) => edge.includes("root")).map((edge) => [...edge]),
      [["root", "claude"]],
    );
    const root = await ctx.config("root");
    assert.deepEqual(Object.keys(root.peers), [ctx.id("claude")]);
    for (const worker of ["codex", "cursor"]) {
      assert.equal((await ctx.config(worker)).peers[ctx.id("root")], undefined, worker);
    }
    // Root advertises no handoff capability at all, so it can never be delegated TO.
    assert.deepEqual(root.protocolVersions, ["1.0"]);
    assert.deepEqual(root.features, []);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Runtime targets
// ---------------------------------------------------------------------------

test("each worker's runtime sees its sibling as an allowed handoff target", async () => {
  const ctx = await setup();
  try {
    const codex = controllerFor(ctx.id("codex"), (await ctx.config("codex")).peers);
    const cursor = controllerFor(ctx.id("cursor"), (await ctx.config("cursor")).peers);

    assert.deepEqual(codex.handoffTargets(), [ctx.id("claude"), ctx.id("cursor")].sort());
    assert.deepEqual(cursor.handoffTargets(), [ctx.id("claude"), ctx.id("codex")].sort());

    // The instruction block a model actually receives names the sibling — the targets are
    // read from the configured peers, never from a hard-coded agent id.
    assert.match(codex.instructions().replaceAll("\n", " "), new RegExp(`targets available to you right now: .*${ctx.id("cursor")}`));
  } finally {
    ctx.cleanup();
  }
});

test("Claude can delegate to both workers; nobody can delegate to root", async () => {
  const ctx = await setup();
  try {
    const claude = controllerFor(ctx.id("claude"), (await ctx.config("claude")).peers);
    assert.deepEqual(claude.handoffTargets(), [ctx.id("codex"), ctx.id("cursor")].sort());
    assert.equal(claude.handoffTargets().includes(ctx.id("root")), false,
      "root is paired but advertises no handoff capability, so it is not a target");
    assert.equal(
      claude.resolveTarget(ctx.id("root")).reason,
      HANDOFF_REASONS.targetCapabilityMissing,
    );
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Loop safety is unchanged by the new edge
// ---------------------------------------------------------------------------

test("Claude -> Codex -> Cursor is allowed; closing the loop back to Claude is refused", async () => {
  const ctx = await setup();
  try {
    const claude = controllerFor(ctx.id("claude"), (await ctx.config("claude")).peers);
    const codex = controllerFor(ctx.id("codex"), (await ctx.config("codex")).peers);
    const cursor = controllerFor(ctx.id("cursor"), (await ctx.config("cursor")).peers);

    // Claude -> Codex, from a root turn with no active delegation in flight.
    const hop1 = claude.planDelegation({ to: ctx.id("codex"), parentActivePath: [] });
    assert.equal(hop1.reason, undefined);
    assert.deepEqual(hop1.ancestry, [ctx.id("claude")]);

    // Codex -> Cursor, nested inside that delegation: the CURRENT sender is appended.
    const hop2 = codex.planDelegation({ to: ctx.id("cursor"), parentActivePath: hop1.ancestry });
    assert.equal(hop2.reason, undefined);
    assert.deepEqual(hop2.ancestry, [ctx.id("claude"), ctx.id("codex")]);

    // Cursor -> Claude would re-enter an agent that is still waiting on this very chain.
    const cycle = cursor.planDelegation({ to: ctx.id("claude"), parentActivePath: hop2.ancestry });
    assert.equal(cycle.reason, HANDOFF_REASONS.cycle);
    assert.equal(cycle.detail, ctx.id("claude"));

    // And so would Cursor -> Codex from inside the same chain.
    assert.equal(
      cursor.planDelegation({ to: ctx.id("codex"), parentActivePath: hop2.ancestry }).reason,
      HANDOFF_REASONS.cycle,
    );
    // The same sibling delegation is fine once that chain is NOT active.
    assert.equal(cursor.planDelegation({ to: ctx.id("codex"), parentActivePath: [] }).reason, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("a worker still cannot delegate to itself", async () => {
  const ctx = await setup();
  try {
    const peers = (await ctx.config("codex")).peers;
    const codex = controllerFor(ctx.id("codex"), peers);
    // A real profile never lists an agent in its own peer map, so self-delegation is
    // refused at target resolution — before the self rule is even consulted.
    assert.equal(codex.planDelegation({ to: ctx.id("codex"), parentActivePath: [] }).reason,
      HANDOFF_REASONS.targetUnknown);

    // The self rule is the second net, for a profile that somehow DID self-pair.
    const selfPaired = controllerFor(ctx.id("codex"), { ...peers, [ctx.id("codex")]: peers[ctx.id("cursor")] });
    assert.equal(selfPaired.planDelegation({ to: ctx.id("codex"), parentActivePath: [] }).reason,
      HANDOFF_REASONS.self);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Reconciling a profile created before the edge existed
// ---------------------------------------------------------------------------

test("an existing profile gains the Codex<->Cursor edge in place, with no key rotated", async () => {
  const ctx = await setup();
  try {
    const codexBefore = await ctx.config("codex");
    const cursorBefore = await ctx.config("cursor");
    const rootRaw = ctx.raw("root");
    const claudeRaw = ctx.raw("claude");

    // Rewind to the pre-mesh topology: the sibling edge simply is not there.
    delete codexBefore.peers[ctx.id("cursor")];
    delete cursorBefore.peers[ctx.id("codex")];
    await writePrivateJson(ctx.paths.agentConfigFile("codex"), codexBefore);
    await writePrivateJson(ctx.paths.agentConfigFile("cursor"), cursorBefore);

    const result = await ctx.rerun();

    assert.equal(result.created, false, "the profile already existed");
    assert.deepEqual(result.createdAgents, [], "no identity is recreated");
    assert.ok(result.repairs.some((entry) => entry === `pairing:codex->cursor`));
    assert.ok(result.repairs.some((entry) => entry === `pairing:cursor->codex`));

    const codexAfter = await ctx.config("codex");
    const cursorAfter = await ctx.config("cursor");
    assert.equal(codexAfter.peers[ctx.id("cursor")].signing.publicKey, cursorAfter.keys.signing.publicKey);
    assert.equal(cursorAfter.peers[ctx.id("codex")].signing.publicKey, codexAfter.keys.signing.publicKey);

    // The identities themselves are untouched, and the agents that did not need the edge
    // are not rewritten at all.
    assert.deepEqual(codexAfter.keys, codexBefore.keys, "adding a pairing edge never rotates a key");
    assert.deepEqual(cursorAfter.keys, cursorBefore.keys);
    assert.equal(ctx.raw("root"), rootRaw);
    assert.equal(ctx.raw("claude"), claudeRaw);

    // And the repair is idempotent.
    const again = await ctx.rerun();
    assert.deepEqual(again.repairs, []);
  } finally {
    ctx.cleanup();
  }
});

test("a profile created before the activity feed gains its project descriptor in place", async () => {
  const ctx = await setup();
  try {
    const claudeBefore = await ctx.config("claude");
    assert.deepEqual(claudeBefore.project, { id: ctx.projectId, label: path.basename(ctx.projectPath) });

    delete claudeBefore.project;
    await writePrivateJson(ctx.paths.agentConfigFile("claude"), claudeBefore);
    const result = await ctx.rerun();

    assert.ok(result.repairs.includes("project:claude"));
    assert.deepEqual((await ctx.config("claude")).project, { id: ctx.projectId, label: path.basename(ctx.projectPath) });
    assert.deepEqual((await ctx.config("claude")).keys, claudeBefore.keys, "a descriptor repair rotates nothing");
  } finally {
    ctx.cleanup();
  }
});

test("project.json records the mesh, so `murmur doctor` reports the real topology", async () => {
  const ctx = await setup();
  try {
    const project = await readPrivateJson(ctx.paths.projectFile);
    const edges = project.trustEdges.map((edge) => edge.join("<->")).sort();
    assert.deepEqual(edges, ["claude<->codex", "claude<->cursor", "codex<->cursor", "root<->claude"].sort());
    assert.equal(project.coordinator, "claude", "Claude remains the default coordinator");
  } finally {
    ctx.cleanup();
  }
});
