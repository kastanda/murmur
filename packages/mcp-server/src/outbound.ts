/**
 * outbound.ts — what an MCP send may claim, and where it is allowed to go.
 *
 * Two rules, both enforced here so `murmur_send` / `murmur_request` cannot drift:
 *
 *  1. `status: "queued"` is only returned together with `durable: true`, and only AFTER the
 *     outbox row has been committed AND read back from the same store. A failed write, or a
 *     write that left no row, is an error — never a `queued`.
 *  2. The profile this MCP server writes to is explicit. It is the resolved data directory
 *     of ONE agent profile; a caller that names a different project (or a profile kind the
 *     operator forbade) is refused instead of being routed through whatever profile this
 *     long-lived process happens to hold.
 *
 * Nothing here reads or returns key material, tokens or message text.
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import type { EnvelopeV1, LocalMessageRecord } from "@murmurv2/core";

export type ProfileKind = "project" | "legacy";

export interface ProfileIdentity {
  kind: ProfileKind;
  /** `<slug>-<hash>` of the Murmur project this profile belongs to; null for a legacy profile. */
  projectId: string | null;
  /** Absolute data directory the outbox lives in. */
  dataDir: string;
}

export class OutboundError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "OutboundError";
  }
}

/** Canonical path (symlinks resolved); a path that does not exist yet falls back to its lexical form. */
export const canonicalPath = (target: string): string => {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

const PROJECT_PROFILE = /^projects[\\/]([^\\/]+)[\\/]agents[\\/][^\\/]+$/;

/**
 * A modern profile lives at `<murmur-home>/projects/<projectId>/agents/<agent>`. Anything
 * else — the repo-local `.data`, `.data-claude`, `.data-codex`, a temp dir — is a legacy
 * (project-less) profile and says so in every receipt.
 */
export const resolveProfileIdentity = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): ProfileIdentity => {
  const absolute = canonicalPath(dataDir);
  const murmurHome = canonicalPath(env.MURMUR_HOME?.trim() || path.join(homeDir, ".murmur"));
  // Exactly `<MURMUR_HOME>/projects/<id>/agents/<name>` — nothing nested or prefixed.
  const match = path.relative(murmurHome, absolute).match(PROJECT_PROFILE);
  if (match) return { kind: "project", projectId: match[1], dataDir: absolute };
  return { kind: "legacy", projectId: null, dataDir: absolute };
};

/**
 * The modern project whose directory contains `cwd`, from `$MURMUR_HOME/projects/<id>/project.json`
 * (`projectPath`). An MCP client starts its servers in the session's working directory, so a
 * LEGACY-bound server running inside a registered project is the shadowing misconfiguration
 * (`claude mcp add murmur -e DATA_DIR=<repo>/.data-claude`) that sends project work to the wrong profile.
 */
/** The main checkout a git worktree belongs to (from its `.git` file), or null when `cwd` is not in one. */
const worktreeOwner = (cwd: string): string | null => {
  let dir = cwd;
  for (;;) {
    try {
      const gitPath = path.join(dir, ".git");
      const text = readFileSync(gitPath, "utf8");
      const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const at = gitdir ? path.resolve(dir, gitdir).indexOf(marker) : -1;
      return gitdir && at > 0 ? canonicalPath(path.resolve(dir, gitdir).slice(0, at)) : null;
    } catch {
      // no `.git` file here (a directory, or nothing): keep climbing
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export const modernProjectForCwd = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null => {
  const here = canonicalPath(cwd);
  const owner = worktreeOwner(here);
  const root = path.join(canonicalPath(env.MURMUR_HOME?.trim() || path.join(homeDir, ".murmur")), "projects");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return null;
  }
  for (const id of ids) {
    try {
      const projectPath = JSON.parse(readFileSync(path.join(root, id, "project.json"), "utf8")).projectPath;
      if (typeof projectPath !== "string" || !projectPath) continue;
      const base = canonicalPath(projectPath);
      if (here === base || here.startsWith(`${base}${path.sep}`) || owner === base) return id;
    } catch {
      // not a project profile directory
    }
  }
  return null;
};

/**
 * Refuse a send that this server's profile must not carry.
 *  - `requestedProjectId` (tool argument) must equal this profile's project. A legacy
 *    profile belongs to no project, so it can never satisfy a project-scoped send.
 *  - `MURMUR_REQUIRE_PROJECT_PROFILE=1` forbids legacy-profile sends altogether.
 *  - A legacy profile running inside a registered modern project (`cwdProjectId`) is refused
 *    unless the operator opted in with `allowLegacy`.
 */
export const assertRouting = (
  profile: ProfileIdentity,
  { requestedProjectId, requireProject, cwdProjectId, allowLegacy }: {
    requestedProjectId?: string;
    requireProject?: boolean;
    cwdProjectId?: string | null;
    allowLegacy?: boolean;
  },
): void => {
  if (requireProject && profile.kind !== "project") {
    throw new OutboundError("legacy-profile-rejected", "this MCP server is bound to a legacy (project-less) profile and the operator requires a project profile");
  }
  if (profile.kind !== "project" && cwdProjectId && !allowLegacy) {
    throw new OutboundError("legacy-profile-in-project", `this MCP server is bound to a legacy profile but runs inside project ${cwdProjectId}; bind it to that project's profile (murmur claude <project> mcp-config) or set MURMUR_ALLOW_LEGACY_PROFILE=1`);
  }
  if (requestedProjectId === undefined) return;
  if (profile.kind !== "project") {
    throw new OutboundError("profile-mismatch", `a legacy profile cannot carry a send for project ${requestedProjectId}`);
  }
  if (profile.projectId !== requestedProjectId) {
    throw new OutboundError("profile-mismatch", `this MCP server is bound to project ${profile.projectId}, not ${requestedProjectId}`);
  }
};

/**
 * A project profile is only trusted if everything this server will actually use agrees with
 * the directory it was resolved from: the config's own `project.id` and `dataDir`, and the
 * message store. Otherwise the receipt could name project A while the row lands in B's outbox
 * (a mixed-up `MURMUR_STORE_PATH`, a config copied between profiles, a symlinked ancestor).
 * The store check applies to legacy profiles too; the config project/dataDir checks only to project profiles.
 */
export const assertProfileBinding = (
  profile: ProfileIdentity,
  { config, storePath }: { config: { dataDir?: string; project?: { id?: string } }; storePath: string },
): void => {
  // Every profile kind: the outbox this server writes MUST be `<dataDir>/murmur.db` — the file
  // the daemon of that profile flushes — so a receipt that names `dataDir` is true. A store
  // redirected to another profile (or to a sibling file nothing consumes) is refused.
  if (canonicalPath(storePath) !== path.join(profile.dataDir, "murmur.db")) {
    throw new OutboundError("profile-binding-invalid", "the message store is not this profile's murmur.db");
  }
  if (profile.kind !== "project") return;
  if (config.project?.id !== profile.projectId) {
    throw new OutboundError("profile-binding-invalid", "the agent config belongs to a different project than the directory it is loaded from");
  }
  if (typeof config.dataDir !== "string" || canonicalPath(config.dataDir) !== profile.dataDir) {
    throw new OutboundError("profile-binding-invalid", "the agent config's dataDir is not this profile's directory");
  }
};

export interface OutboxLike {
  enqueue(subject: string, envelope: EnvelopeV1): Promise<void>;
  getOutboxRecord(msgId: string): Promise<{ msgId: string; subject: string; status: string } | undefined>;
}

/**
 * Durable reply ownership (see `scripts/reply-ownership-store.mjs`, the daemon-side reader —
 * keep the table definition in sync). An interactive client's request is recorded as owned by
 * that client BEFORE the outbox commit, so the autonomous daemon sharing this identity can
 * never treat the correlated reply as new work, even across a restart.
 */
export interface ReplyOwnershipRecorder {
  record(msgId: string, owner: string): void;
}

const REPLY_OWNERSHIP_DDL = `
  CREATE TABLE IF NOT EXISTS reply_ownership (
    msg_id     TEXT PRIMARY KEY,
    origin     TEXT NOT NULL,
    owner      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

export const createMcpReplyOwnership = (dbPath: string): ReplyOwnershipRecorder => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout=10000;");
  db.exec(REPLY_OWNERSHIP_DDL);
  const insert = db.prepare(
    "INSERT INTO reply_ownership (msg_id, origin, owner, created_at) VALUES (?, 'mcp_client', ?, ?) ON CONFLICT(msg_id) DO NOTHING",
  );
  return { record: (msgId, owner) => { insert.run(msgId, owner, Date.now()); } };
};

export interface MessageStoreLike {
  append(record: Omit<LocalMessageRecord, "id">): Promise<unknown>;
}

export interface DurableReceipt {
  status: "queued";
  durable: true;
  msgId: string;
  /** Kept for existing callers; same as `recipientAgentId`. */
  to: string;
  projectId: string | null;
  profile: ProfileKind;
  dataDir: string;
  senderAgentId: string;
  recipientAgentId: string;
  conversationId: string;
  replyToMessageId?: string;
  subject: string;
  outboxStatus: string;
  /** Whether the sender's own local copy (`local_messages`) was written too. */
  localCopy: boolean;
}

/**
 * Commit an outbound envelope and return the only kind of receipt that may say `queued`.
 * The outbox row is the delivery-relevant durable record; it is verified by reading it back
 * before anything is claimed. The local copy is best-effort bookkeeping and is reported, not
 * hidden, when it fails (the message is still going out).
 */
export const commitOutbound = async ({
  outbox, store, profile, subject, envelope, text, transport = "nats", ownership,
}: {
  outbox: OutboxLike;
  ownership?: ReplyOwnershipRecorder;
  store: MessageStoreLike;
  profile: ProfileIdentity;
  subject: string;
  envelope: EnvelopeV1;
  text: string;
  transport?: string;
}): Promise<DurableReceipt> => {
  if (ownership) {
    // Before the message can leave: if ownership cannot be made durable the send is refused,
    // because an un-owned request would let its reply start an autonomous turn.
    try {
      ownership.record(envelope.msgId, `mcp:${envelope.senderAgentId}`);
    } catch (error) {
      throw new OutboundError("reply-ownership-unrecorded", error instanceof Error ? error.message : "ownership write failed");
    }
  }
  try {
    await outbox.enqueue(subject, envelope);
  } catch (error) {
    throw new OutboundError("outbox-write-failed", error instanceof Error ? error.message : "enqueue failed");
  }
  const row = await outbox.getOutboxRecord(envelope.msgId);
  if (!row || row.msgId !== envelope.msgId || row.subject !== subject) {
    throw new OutboundError("outbox-commit-unverified", `message ${envelope.msgId} is not present in the outbox after enqueue`);
  }
  let localCopy = true;
  try {
    await store.append({
      conversationId: envelope.conversationId,
      msgId: envelope.msgId,
      ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
      direction: "outbound",
      sender: envelope.senderAgentId,
      text,
      createdAt: envelope.createdAt,
      transport,
    } as Omit<LocalMessageRecord, "id">);
  } catch {
    localCopy = false;
  }
  const recipient = envelope.recipients[0];
  return {
    status: "queued",
    durable: true,
    msgId: envelope.msgId,
    to: recipient,
    projectId: profile.projectId,
    profile: profile.kind,
    dataDir: profile.dataDir,
    senderAgentId: envelope.senderAgentId,
    recipientAgentId: recipient,
    conversationId: envelope.conversationId,
    ...(envelope.replyToMessageId ? { replyToMessageId: envelope.replyToMessageId } : {}),
    subject,
    outboxStatus: row.status,
    localCopy,
  };
};
