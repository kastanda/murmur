/**
 * channel-servers.mjs — `murmur channels [--json] [--cleanup]`: what MCP channel servers
 * (`scripts/murmur-mcp-channel-server.mjs`) are running on this host, who owns them, and which
 * ones are PROVABLY stale.
 *
 * Lifecycle facts this module is built on (see docs/channel-lifecycle.md):
 *  - a channel server is session-scoped: the MCP client (a Codex App Server thread, a CLI
 *    session) starts one per MCP session and owns its stdio pipes. It exits on stdin EOF or
 *    when its owner disappears. So ONE PER LIVE SESSION is expected; many under one long-lived
 *    parent is "the parent has kept many sessions loaded", which is the parent's retention —
 *    not something this host can prove wrong from outside.
 *  - age is NOT evidence. A server that has been up for days under a living parent may own a
 *    live thread. Only an ownership break is positive evidence of staleness:
 *      orphaned — reparented to launchd (ppid 1), or its parent pid no longer exists.
 *  - `crowded-parent` and `legacy-shared-profile` are diagnostics, never cleanup targets.
 *
 * `--cleanup` signals ONLY `orphaned` processes, one pid at a time, after re-reading the
 * process's start time and command immediately before signalling (so a recycled pid is never
 * touched). It never signals anything else and never uses a pattern kill.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfileIdentity } from "../../packages/mcp-server/dist/src/outbound.js";

export const CHANNEL_SERVER_SCRIPT = "murmur-mcp-channel-server.mjs";
export const CROWDED_PARENT_THRESHOLD = 8;

export const CHANNEL_STATE = Object.freeze({
  live: "live",
  orphaned: "orphaned",
});

const PS_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };
const ps = (args, { timeoutMs = 10_000 } = {}) => execFileSync("/bin/ps", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: PS_ENV, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
});

/** `[[dd-]hh:]mm:ss` -> seconds, or null. */
export const parseEtime = (value) => {
  const match = String(value).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, d = "0", h = "0", m, s] = match;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s);
};

/** What KIND of process owns a server. Describes, never judges. */
export const classifyParent = (command) => {
  const text = String(command || "");
  if (!text) return "unknown";
  if (/codex.*app-server/.test(text)) return "codex-app-server";
  if (/(^|[\\/ ])codex( |$)/.test(text)) return "codex-cli";
  if (/(^|[\\/ ])claude( |$)|claude-code/.test(text)) return "claude";
  if (/Cursor|cursor-agent|[\\/ ]agent( |$)/.test(text)) return "cursor";
  if (/launchd/.test(text)) return "launchd";
  return "other";
};

const canonical = (file) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/** The one script this install runs as a channel server. Others, even same-named, are not ours. */
export const approvedChannelServerScript = () => canonical(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", CHANNEL_SERVER_SCRIPT));

/**
 * `node <approved absolute script>` and nothing else. A same-named script elsewhere (a copy in
 * /tmp, a different checkout), a relative path, or any line that merely mentions the name is NOT
 * a channel server of this install and is never classified, so it can never be cleaned up. A
 * script path that cannot be proven equal to the approved one fails closed.
 */
export const isChannelServerCommand = (command, { approved = approvedChannelServerScript() } = {}) => {
  const argv = String(command).trim().split(/\s+/);
  // Exactly `node <script>`: extra arguments are never part of this install's launch, and a
  // command line with arguments could carry secrets, so it is neither classified nor echoed.
  if (argv.length !== 2 || !/(^|\/)node$/.test(argv[0]) || path.basename(argv[1]) !== CHANNEL_SERVER_SCRIPT) return false;
  if (!approved || !path.isAbsolute(argv[1])) return false;
  const script = canonical(argv[1]);
  return script !== null && script === approved;
};

/** One `ps -axo pid=,ppid=,etime=,lstart=,command=` row. lstart is a fixed 24-char field. */
export const parsePsRow = (line) => {
  const match = String(line).match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/);
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), etime: match[3], startedAt: match[4], command: match[5] };
};

const readTable = (psImpl) => {
  const rows = new Map();
  for (const line of String(psImpl(["-axo", "pid=,ppid=,etime=,lstart=,command="])).split("\n")) {
    const row = parsePsRow(line);
    if (row) rows.set(row.pid, row);
  }
  return rows;
};

/** `DATA_DIR` of a process, read from its own environment; no other variable is ever kept. */
const readDataDir = (pid, psImpl) => {
  try {
    const match = String(psImpl(["eww", "-p", String(pid)])).match(/(?:^|\s)DATA_DIR=(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

/**
 * Snapshot every channel server with its ownership. Pure given `psImpl`.
 * @returns {{ servers: object[], parents: object[], total: number, orphaned: number }}
 */
export const listChannelServers = ({ psImpl = ps, env = process.env, crowdedThreshold = CROWDED_PARENT_THRESHOLD, approved = approvedChannelServerScript() } = {}) => {
  const table = readTable(psImpl);
  const servers = [];
  for (const row of table.values()) {
    if (!isChannelServerCommand(row.command, { approved })) continue;
    const parent = table.get(row.ppid) || null;
    const dataDir = readDataDir(row.pid, psImpl);
    const profile = dataDir ? resolveProfileIdentity(dataDir, env) : null;
    const ownerGone = row.ppid <= 1 || !parent;
    const server = {
      pid: row.pid,
      ppid: row.ppid,
      ageSeconds: parseEtime(row.etime),
      startedAt: row.startedAt,
      parentKind: ownerGone ? (row.ppid === 1 ? "launchd" : "gone") : classifyParent(parent.command),
      parentPid: row.ppid,
      profileKind: profile?.kind ?? "unknown",
      projectId: profile?.projectId ?? null,
      dataDirName: dataDir ? path.basename(dataDir) : null,
      state: ownerGone ? CHANNEL_STATE.orphaned : CHANNEL_STATE.live,
      evidence: ownerGone
        ? (row.ppid === 1 ? "reparented to launchd: its owner exited" : `parent pid ${row.ppid} no longer exists`)
        : "owner process is alive",
    };
    // Needed to re-verify identity before a signal; deliberately NOT enumerable, so it can never
    // reach `--json` output.
    Object.defineProperty(server, "command", { value: row.command, enumerable: false });
    servers.push(server);
  }
  servers.sort((a, b) => a.pid - b.pid);

  const byParent = new Map();
  for (const server of servers) {
    const entry = byParent.get(server.parentPid) || { parentPid: server.parentPid, parentKind: server.parentKind, count: 0, oldestSeconds: 0 };
    entry.count += 1;
    entry.oldestSeconds = Math.max(entry.oldestSeconds, server.ageSeconds ?? 0);
    byParent.set(server.parentPid, entry);
  }
  const parents = [...byParent.values()]
    .map((entry) => ({ ...entry, crowded: entry.count > crowdedThreshold }))
    .sort((a, b) => b.count - a.count);
  const legacy = servers.filter((server) => server.profileKind === "legacy").length;
  return {
    total: servers.length,
    orphaned: servers.filter((server) => server.state === CHANNEL_STATE.orphaned).length,
    legacySharedProfile: legacy,
    servers,
    parents,
  };
};

/** One-line doctor verdict. Orphans WARN; accumulation is reported but is not "stale". */
export const summarizeChannelServers = (snapshot) => {
  if (snapshot.total === 0) return { status: "PASS", detail: "no channel servers running" };
  const crowded = snapshot.parents.filter((parent) => parent.crowded);
  const notes = [`${snapshot.total} channel server(s) under ${snapshot.parents.length} owner(s)`];
  if (snapshot.orphaned > 0) notes.push(`${snapshot.orphaned} orphaned (owner gone; \`murmur channels --cleanup\` can stop exactly these)`);
  for (const parent of crowded) {
    notes.push(`${parent.count} under one ${parent.parentKind} (pid ${parent.parentPid}) — that owner is keeping many sessions loaded; not proven stale`);
  }
  if (snapshot.legacySharedProfile > 0) notes.push(`${snapshot.legacySharedProfile} on a legacy shared profile`);
  return { status: snapshot.orphaned > 0 || crowded.length > 0 ? "WARN" : "PASS", detail: notes.join("; ") };
};

/**
 * Stop exactly the orphaned servers, re-verified one by one. Anything not provably orphaned
 * is reported as skipped. `psImpl`/`kill` are injectable.
 */
export const cleanupOrphanedChannelServers = ({ snapshot, psImpl = ps, kill = process.kill.bind(process), approved = approvedChannelServerScript() } = {}) => {
  const results = [];
  for (const server of snapshot.servers) {
    if (server.state !== CHANNEL_STATE.orphaned) {
      results.push({ pid: server.pid, outcome: "skipped-not-orphaned" });
      continue;
    }
    // Re-measure now: same pid, still a channel server, still the same process, still ownerless.
    const table = readTable(psImpl);
    const fresh = table.get(server.pid);
    if (!fresh) {
      results.push({ pid: server.pid, outcome: "already-gone" });
      continue;
    }
    // Same pid, same start time (ps resolves to one second — the kernel start time Murmur's
    // other process tooling also relies on), same FULL command line, same approved script, and
    // still ownerless. Anything that cannot be proven is skipped, never signalled.
    const sameProcess = fresh.startedAt === server.startedAt && fresh.command === server.command
      && isChannelServerCommand(fresh.command, { approved });
    const stillOwnerless = fresh.ppid <= 1 || !table.get(fresh.ppid);
    if (!sameProcess || !stillOwnerless) {
      results.push({ pid: server.pid, outcome: "skipped-identity-changed" });
      continue;
    }
    // Narrow the check-to-signal window to one more single-pid read. Without a pidfd the gap
    // cannot be closed completely; it is microseconds, the target must be an ownerless approved
    // channel server both times, and the signal is SIGTERM (a clean shutdown request).
    const finalTable = readTable(psImpl);
    const last = finalTable.get(server.pid);
    const ownerless = last && (last.ppid <= 1 || !finalTable.get(last.ppid));
    if (!last || !ownerless || last.startedAt !== server.startedAt || last.command !== server.command) {
      results.push({ pid: server.pid, outcome: "skipped-identity-changed" });
      continue;
    }
    try {
      kill(server.pid, "SIGTERM");
      results.push({ pid: server.pid, outcome: "terminated" });
    } catch (error) {
      results.push({ pid: server.pid, outcome: error?.code === "ESRCH" ? "already-gone" : "signal-failed" });
    }
  }
  return results;
};

export const CHANNELS_USAGE = `murmur channels — MCP channel-server processes on this host

Usage:
  murmur channels [--json]
  murmur channels --cleanup [--json]

Lists every murmur-mcp-channel-server with its owning process, age, profile kind and state.
A server is "orphaned" only when its owner is gone (reparented to launchd or its parent pid no
longer exists). Age alone proves nothing. --cleanup stops exactly the orphaned servers, after
re-verifying each one; it never signals a live server and never pattern-kills.
`;

const age = (seconds) => {
  if (seconds === null || seconds === undefined) return "?";
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m`;
};

export const commandChannels = async ({ flags = {}, out, err, psImpl = ps, kill } = {}) => {
  let snapshot;
  try {
    snapshot = listChannelServers({ psImpl });
  } catch (error) {
    err(`murmur channels: cannot read the process table (${error?.code || error?.message})`);
    return 3;
  }
  const cleanup = flags.cleanup === true ? cleanupOrphanedChannelServers({ snapshot, psImpl, ...(kill ? { kill } : {}) }) : null;
  if (flags.json) {
    out(JSON.stringify({ ...snapshot, summary: summarizeChannelServers(snapshot), ...(cleanup ? { cleanup } : {}) }, null, 2));
    return 0;
  }
  const summary = summarizeChannelServers(snapshot);
  out(`Channel servers: ${summary.status} — ${summary.detail}`);
  for (const parent of snapshot.parents) {
    out(`  owner ${parent.parentKind} pid ${parent.parentPid}: ${parent.count} server(s), oldest ${age(parent.oldestSeconds)}${parent.crowded ? "  [crowded]" : ""}`);
  }
  for (const server of snapshot.servers.filter((s) => s.state === CHANNEL_STATE.orphaned)) {
    out(`  ORPHANED pid ${server.pid} (${age(server.ageSeconds)}): ${server.evidence}`);
  }
  if (cleanup) {
    const stopped = cleanup.filter((row) => row.outcome === "terminated").length;
    out(`Cleanup: ${stopped} orphaned server(s) stopped; ${cleanup.length - stopped} not touched.`);
  }
  return 0;
};
