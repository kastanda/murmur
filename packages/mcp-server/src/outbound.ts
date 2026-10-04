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
import { realpathSync } from "node:fs";
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

const PROJECT_PROFILE = /[\\/]projects[\\/]([^\\/]+)[\\/]agents[\\/][^\\/]+$/;

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
  const match = absolute.match(PROJECT_PROFILE);
  const inHome = absolute.startsWith(`${murmurHome}${path.sep}`);
  if (match && inHome) return { kind: "project", projectId: match[1], dataDir: absolute };
  return { kind: "legacy", projectId: null, dataDir: absolute };
};

/**
 * Refuse a send that this server's profile must not carry.
 *  - `requestedProjectId` (tool argument) must equal this profile's project. A legacy
 *    profile belongs to no project, so it can never satisfy a project-scoped send.
 *  - `MURMUR_REQUIRE_PROJECT_PROFILE=1` forbids legacy-profile sends altogether.
 */
export const assertRouting = (
  profile: ProfileIdentity,
  { requestedProjectId, requireProject }: { requestedProjectId?: string; requireProject?: boolean },
): void => {
  if (requireProject && profile.kind !== "project") {
    throw new OutboundError("legacy-profile-rejected", "this MCP server is bound to a legacy (project-less) profile and the operator requires a project profile");
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
 * Legacy profiles carry no project claim, so only the project case is checked.
 */
export const assertProfileBinding = (
  profile: ProfileIdentity,
  { config, storePath }: { config: { dataDir?: string; project?: { id?: string } }; storePath: string },
): void => {
  if (profile.kind !== "project") return;
  if (config.project?.id !== profile.projectId) {
    throw new OutboundError("profile-binding-invalid", "the agent config belongs to a different project than the directory it is loaded from");
  }
  if (typeof config.dataDir !== "string" || canonicalPath(config.dataDir) !== profile.dataDir) {
    throw new OutboundError("profile-binding-invalid", "the agent config's dataDir is not this profile's directory");
  }
  if (path.dirname(canonicalPath(storePath)) !== profile.dataDir) {
    throw new OutboundError("profile-binding-invalid", "the message store is outside this profile's directory");
  }
};

export interface OutboxLike {
  enqueue(subject: string, envelope: EnvelopeV1): Promise<void>;
  getOutboxRecord(msgId: string): Promise<{ msgId: string; subject: string; status: string } | undefined>;
}

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
  outbox, store, profile, subject, envelope, text, transport = "nats",
}: {
  outbox: OutboxLike;
  store: MessageStoreLike;
  profile: ProfileIdentity;
  subject: string;
  envelope: EnvelopeV1;
  text: string;
  transport?: string;
}): Promise<DurableReceipt> => {
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
