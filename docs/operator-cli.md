# Murmur local operator CLI

`murmur` turns a directory on your machine into a running Murmur multi-agent project:
one operator/root identity plus autonomous Claude, Codex and Cursor runtimes, paired,
configured and supervised — without hand-rolling identities, editing peer configs, or
keeping five terminals open.

```bash
murmur start  <project>
murmur status <project>
murmur stop   <project>
murmur doctor <project>
murmur notify status          # notifications are configured once per user, not per project
```

## Installation

From a clone of this repository:

```bash
npm install
npm run build          # the daemons import the built @murmurv2/* workspaces
npm link               # puts `murmur` on your PATH
murmur --help
```

`npm link` installs the `bin.murmur` entry from `package.json`. If you prefer not to
link globally, `node bin/murmur.mjs <command>` is equivalent — but you never need to
call `node scripts/...` for normal operation.

Requirements: Node 22+ (the daemons use `node:sqlite`), a reachable NATS server, and the
agent CLIs you intend to run (`claude`, `codex`, `agent`).

## Project resolution

| Argument | Resolves to |
|---|---|
| `murmur start murmur` | `~/Projects/murmur` |
| `murmur start "Ribambelle Operations"` | `~/Projects/Ribambelle Operations` |
| `murmur start /srv/work/thing` | that exact path |
| `murmur start ~/work/thing` | `$HOME/work/thing` |

The path is canonicalized with `realpath`, so a symlink and its target are the *same*
project. A bare name must be a single directory entry: `../x`, `a/b` and `..` are
rejected — pass an absolute path instead. A project directory that does not exist fails
immediately with `project-not-found:<path>`.

## Profile and state location

**Nothing is written into your project repository.** All state lives under a user-level
Murmur home:

```
~/.murmur/projects/<project-id>/
├── project.json              # topology, trust edges, NATS endpoint, App Server command
├── agents/
│   ├── root/                 # DATA_DIR for the operator identity
│   │   ├── agent-config.json # identity + peers (mode 0600)
│   │   └── murmur.db         # outbox, inbox, dispatch ledger, bindings, continuations
│   ├── claude/ codex/ cursor/
├── run/
│   ├── supervisor.json       # supervisor + owned child PIDs and start identities
│   ├── supervisor.lock       # exclusive project lock (carries its acquisition's lockId)
│   ├── launch.guard          # exclusion held by `murmur start` until the supervisor owns the lock
│   └── codex.sock            # this project's Codex App Server socket
└── logs/
    ├── supervisor.log claude.log codex.log cursor.log root.log codex-app-server.log
```

`<project-id>` is `<slug>-<sha256(canonical path)[0:12]>` — deterministic from the
canonical path, filesystem-safe, and distinct for two projects that share a basename.

Set `MURMUR_HOME` to relocate the state root (useful if your home directory is long
enough to push the Codex socket past the 104-byte `AF_UNIX` limit — `doctor` checks
this explicitly).

Private keys live only in `agents/*/agent-config.json`, written `0600` inside `0700`
directories through the repository's existing `secure-state` helpers. They are never
printed by any command, never written to a log, and never placed in a Git repository.

### The profile is operator-controlled, but not trusted for paths or execution

`project.json` is yours to edit, and it is validated on every load. It cannot redirect
where Murmur writes or what it executes:

- **agent names** must be one of the fixed roles `root`, `claude`, `codex`, `cursor`.
  A separator, a `..` segment, a control character or an empty name is refused, and log
  paths and supervised child names are derived from the validated role, never from raw
  profile text;
- **`dataDir`** must resolve to `<profile>/agents/<role>`. A `..` escape, an absolute
  path elsewhere, or a symlinked agent directory pointing outside the profile is
  refused;
- **containment is anchored to the canonical profile root**, and the descent from it is
  walked one component at a time. That is what catches an *ancestor* symlink: if
  `<profile>/agents`, `<profile>/logs` or `<profile>/run` has been replaced by a link to
  an external directory, comparing the target against that already-escaped parent would
  agree with itself and pass — so every managed component is required not to be a
  symlink, and the fully resolved path must still sit under the canonical root;
- **run state, logs and the Codex socket** are derived from the project id, not from
  persisted text, and that containment is asserted on load;
- **`codexAppServer.command` / `.args`** are validated as a plain string and a string
  array and are only ever used as `executable + argv` with no shell; the executable goes
  through the discovery chain above.

Anything that fails these checks stops the command with `invalid-profile:<reason>`
rather than being silently rewritten.

## Default topology

```
        operator/root
              │
              ▼
        Claude  (coordinator, claude:auto)
         ╱            ╲
    Codex              Cursor
 (codex:app-server)   (cursor:acp)
```

Trust edges are exactly `root ↔ claude`, `claude ↔ codex`, `claude ↔ cursor`. Codex and
Cursor are deliberately **not** paired with each other: sibling delegation goes through
the coordinator. Claude, Codex and Cursor advertise protocol `1.1` + `handoff-v1`; the
operator/root identity advertises only `1.0`, so a coordinator can never "delegate" work
back into the human operator slot.

Agent identities are namespaced per project (`<project-id>-claude`), so their NATS
subjects are unique and one broker can serve any number of projects.

## `murmur start`

```bash
murmur start murmur
murmur start murmur --foreground     # run the supervisor attached, for debugging
murmur start murmur --timeout 180    # seconds to wait for readiness (default 120)
```

In order, `start`:

1. resolves and canonicalizes the project;
2. **ensures the profile** (see [Profile repair](#profile-repair)) — creating it on the
   first run, and on every later run validating it and repairing only the safely
   derivable pieces that are missing;
3. refuses a duplicate start when a live supervisor, a lock owner, a launch in flight or a
   recorded child cannot be *disproven*;
4. runs the full preflight (see `doctor`) and **refuses before launching anything** if a
   fatal check fails;
5. takes the **launch guard** — durable cross-process exclusion, acquired *before* any
   process exists (see [The launch guard](#the-launch-guard));
6. launches a detached project supervisor and **keeps its spawn handle** until that
   supervisor's identity is established (see [The ownership barrier](#the-ownership-barrier));
7. starts the Codex App Server, waits until its socket accepts a connection, then starts
   one Murmur daemon per enabled agent;
8. waits for each daemon's `Daemon ready`;
9. verifies the supervisor it started owns both the authoritative lock and the published
   run state, releases the launch guard, releases the spawn handle;
10. prints a compact summary and returns control to your shell.

```
Project:  /Users/you/Projects/murmur
Profile:  ~/.murmur/projects/murmur-f6a3a362f2bb
NATS:     OK
Root:     READY
Claude:   READY
Codex:    READY
Cursor:   READY
Handoff:  READY

Murmur started.
```

The supervisor is detached with its own stdio redirected into `logs/supervisor.log`, so
it survives closing the terminal. There is no dependency on tmux and no reliance on
shell job control.

If any step fails, the supervisor rolls back every process it already started, records
`phase: "failed"` with the reason, and `start` exits non-zero. It never leaves half a
project running.

### The launch guard

The project lock is acquired by the supervisor, which means it cannot protect the interval
*before* that supervisor runs. Without something covering it, two `murmur start`
invocations could both pass the duplicate check and both spawn a supervisor, with the
loser of the lock race only finding out after it had already created a process.

`run/launch.guard` closes that interval:

- it is created atomically (`O_EXCL`) by the CLI **before** the supervisor is spawned;
- it carries a random `launchId` plus the launcher's own PID and start identity;
- a second `start` **fails closed** while it is `held` or `unknown`;
- it records the **launch lifecycle** durably (see below), so a later reader never has to
  guess what a missing supervisor record means;
- it is removed only by the launcher that created it, only after the verified supervisor
  owns the authoritative lock and the published run state;
- **if a launch fails and its cleanup cannot be proven, the guard deliberately remains.**
  `doctor`, `status` and `stop` report it; `murmur stop` clears it only once the durable
  state proves nothing possibly-live was left behind.

#### Launch lifecycle, and what may be reclaimed

| Guard phase | Meaning | Auto-reclaimable when the launcher is gone? |
|---|---|---|
| `launching` | guard taken, no spawn intended yet | **yes** |
| `supervisor-spawn-intent` | a spawn is *about to happen*; whether a process exists is unknowable | **no** |
| `supervisor-spawned` | a process exists, identity not yet proven | **no** |
| `supervisor-verified` | exact PID + start identity captured | only once *that* process is proven gone |
| `cleanup-unverified` | spawned, never identified, exit never observed | **never** |
| `supervisor-exited` | its exit was observed through the trusted handle | **yes** |
| `spawn-failed` | Node proved no process was created | **yes** |

**The durable transition happens before the irreversible side effect.** Creating an OS process
cannot be made atomic with a disk write, so the guard records `supervisor-spawn-intent` — with
`unsafeToReclaim` — *before* `spawn()` is called, and the CLI refuses to spawn at all if that
write does not persist. From that boundary on, safety is monotonic: only positive later
evidence (no process created / process exited / verified process proven gone) can restore
automatic reclamation. The absence of a PID or of a verified record never can.

Reclaimability is therefore decided by evidence, in order:

1. Node proved the spawn created no process → safe
2. the creator observed the process exit → safe
3. a verified identity exists → safe only once that exact process is proven gone
4. a spawn was intended or performed and none of the above happened → **never** (manual recovery)
5. the guard states no spawn was ever intended → safe
6. anything else → **never**

#### Crash points, and what each one leaves behind

| The launcher is SIGKILLed… | Durable guard says | Outcome |
|---|---|---|
| before the intent write | `launching` | ordinary stale reclamation; a later start proceeds |
| after intent, before `spawn()` | `supervisor-spawn-intent` | locked — conservative false positive, manual recovery |
| after `spawn()`, before the PID record | `supervisor-spawn-intent` | locked — a process may exist; manual recovery |
| after the PID record, before verification | `supervisor-spawned` | locked — manual recovery |
| after authority transfer | guard released; lock + run state own the project | ordinary supervisor semantics |

Row two is a deliberate false lock: nothing on disk can prove that the spawn never happened, and
a manual unlock is recoverable while two overlapping supervisors are not.

Authority therefore transfers in a strict order — guard acquired → supervisor spawned →
supervisor identity established → supervisor takes the lock and publishes run state →
launcher verifies both name that exact process → guard released → spawn handle released.
At no point in that sequence does the project appear unowned to another `start`.

### The ownership barrier

A detached supervisor is only safe to walk away from once it is *identified*. So after
spawning it the CLI does **not** unref or discard the handle. It first runs the same
bounded ownership-establishment contract every other child goes through, and the handle —
trusted spawn-time evidence — is retained throughout.

If ownership cannot be established the start **fails**, and because the parent still holds
that handle it terminates the supervisor **through it**: SIGTERM, wait for the actual
`exit` event, SIGKILL, wait again. Only once the exit is observed is the launch guard
released. A naked, unverified PID is never signalled — that could hit an unrelated process
that inherited the PID.

#### When no exit can be observed: the cleanup hold

If TERM **and** KILL through the trusted handle still produce no observable exit, there is no
durable way to ever find that process again. So the command does not pretend otherwise, and it
does not let go:

- it marks the guard `cleanup-unverified` / `unsafeToReclaim` **first**, so the durable state
  is already fail-closed;
- it prints `CLEANUP INCOMPLETE`, the PID, and "Project launch remains locked. Do not start
  another Murmur instance.";
- it **does not `unref()` the handle and does not return.** It stays alive holding the only
  trusted handle on that process and re-attempts termination on a bounded period
  (`MURMUR_CLEANUP_HOLD_POLL_MS`, default 5s) until the exit is actually observed.

A pathological command that keeps running is the honest outcome here; returning the shell would
mean claiming a cleanup that never happened.

If the exit is eventually observed, the hold finishes the job properly: it records
`supervisor-exited`, reaps whatever the launch recorded, clears the launch artifacts, releases
its exact guard instance and returns a truthful failure. A new `start` is then allowed.

An ordinary spawn failure is not this case: when Node proves no process was created (a
synchronous throw, or a `ChildProcess` with no pid) the guard records `spawn-failed` /
`noProcessProven` and is released, so a failed `spawn` never leaves a lock behind. That proof
always comes from live Node evidence — never from "no PID was persisted".

If the **launcher itself** is SIGKILLed during the hold, the trusted handle is lost — that is
unavoidable. What must not also be lost is the exclusion: the guard on disk is already
`cleanup-unverified`, so no automatic path will ever reclaim it. `start`, `stop`, `status` and
`doctor` all report **MANUAL RECOVERY REQUIRED**, naming the PID, and refuse to act. There is
deliberately no force-recovery command: an operator stops that process and removes the guard.

### A start that times out cleans up after itself

`--timeout` bounds how long the CLI waits for readiness. Reaching that deadline is a
**failed start**, and a failed start never leaves a running project behind:

1. the CLI identifies the supervisor **it just spawned** by PID *and* start identity;
2. it asks exactly that process to shut down — through the retained spawn handle where it
   still holds one, which observes the real exit, and otherwise by exact identity — which
   triggers the supervisor's own ordered stop of its children;
3. it then reaps any child still recorded in run state under the same identity rule;
4. it verifies nothing from this invocation survived, clears the lock, run state and
   socket, releases the launch guard, and only then returns.

A pre-existing supervisor is never touched, and nothing is ever matched by process name.
The supervisor keeps its own startup rollback; this is an outer safety net, not a
replacement for it.

Because readiness can land in the same instant the deadline expires, the CLI re-reads
the run state once before tearing anything down. The outcome is therefore always one of
**a truthful success** or **a fully cleaned failed start** — never "failed" alongside a
project that is still running.

If cleanup itself cannot finish, the CLI says so explicitly, lists the surviving PIDs,
and exits 3 (unhealthy) instead of claiming a clean failure.

## Profile repair

`murmur start` **ensures and reconciles** the profile; it does not merely create one
when `project.json` is missing. Every start:

- loads and validates the existing profile;
- checks that each expected role has an identity, that every required pairing edge is
  present in both directions, and that the generated runtime fields are correct;
- repairs only what is **safely derivable**: a missing agent directory, a missing
  identity for one role, a missing or stale pairing edge, a missing generated runtime
  field, an out-of-date capability advertisement;
- **never rotates an existing identity**, and never overwrites operator-tuned runtime
  settings such as `turnTimeoutMs`, `model` or `permissionMode`;
- rewrites only the `agent-config.json` files it actually had to change, so untouched
  identities stay byte-for-byte identical.

Repairs are printed, for example:

```
Repaired missing profile pieces: identity:cursor, pairing:claude->cursor
(existing identities were reused; no key was rotated)
```

Stored state that is **contradictory or unsafe** rather than merely incomplete is not
rewritten. It fails closed with a stable `invalid-profile:<reason>`, for example an
`agentId` that does not match the project, two enabled autonomous runtimes on one
identity, or an agent config whose keypair is half-present.

## `murmur status`

```bash
murmur status murmur
murmur status murmur --json
```

Reports the supervisor PID and phase, project path, NATS reachability, Codex App Server
PID and socket state, and for every agent: daemon PID, child state, runtime binding
state, heartbeat freshness and member slot — plus open handoff continuations and
active/pending dispatch counts. It never dumps databases or message content.

**Exit code 3 when the project runtime is unhealthy** (including "not running"), so it
composes in scripts.

## `murmur stop`

```bash
murmur stop murmur
```

Stops **only** the processes this project's supervisor started, in reverse dependency
order: Murmur daemons first (so they retire their runtime bindings cleanly), then the
Codex App Server the supervisor owns. Each process gets `SIGTERM`, a bounded wait, then
`SIGKILL` — and only after re-reading its start identity, so a reused PID is never
signalled.

`stop` is idempotent. If the supervisor process itself is gone, `stop` reaps the child
PIDs recorded in `run/supervisor.json` under the same identity rule, then reclaims the
stale lock, run state and socket. A launch guard left behind by a failed start is cleared
too — but only as a reclamation: the durable launch state must prove that nothing
possibly-live was left behind. An unresolved launch (`cleanup-unverified`) is reported as
**MANUAL RECOVERY REQUIRED** and `stop` exits 3 rather than implying the project is startable —
"no run state" is not the same as "nothing is locked".

A process whose liveness cannot be measured (for example if `ps` times out under heavy
load) is never assumed dead: nothing is signalled on an unverified identity, `stop`
reports **STOP INCOMPLETE** and exits 3 rather than claiming a clean stop it cannot
prove, and every piece of ownership evidence — run state, PIDs, start identities, the
lock and the Codex socket — is retained so the next `murmur stop` can retry.

`stop` **never** deletes identities, the profile, the Murmur databases or history.

What `stop` will not touch: your NATS server, Claude/Cursor/Codex processes it did not
start, and App Servers belonging to other projects. Nothing is ever matched by process
name — there is no `pkill` anywhere in this CLI.

## `murmur doctor`

```bash
murmur doctor murmur
murmur doctor murmur --json
```

The same diagnostics `start` uses as preflight, rendered as a compact PASS/FAIL/WARN
report and containing no secrets:

| Check | Meaning |
|---|---|
| `project-path` | the project directory exists and is a directory |
| `state-location` | the profile is not inside the project repository |
| `profile` | `project.json` exists, parses, and belongs to this canonical path |
| `identity:<agent>` | agent config readable, id/subject/keys/data dir consistent |
| `pairing:<a><->b>` | both sides hold each other's current public keys |
| `handoff-v1:<a>-><b>` | the peer advertises protocol 1.1 + `handoff-v1` |
| `runtime:<agent>` | exactly one enabled runtime, correct cwd, profile-owned socket |
| `codex-socket-path` | the socket path fits the 104-byte `AF_UNIX` limit |
| `codex-socket` | stale socket (warn) vs. a foreign App Server listening (fatal) |
| `supervisor`, `supervisor-lock`, `launch-guard`, `orphaned-children` | running, stale, retained, or clean |
| `nats` | the configured endpoint is reachable |
| `claude-binary` / `claude-auth` | Claude Code installed and signed in |
| `codex-binary` | a Codex executable was found, and **which source** it came from |
| `cursor-binary` / `cursor-auth` | Cursor Agent installed and signed in |

`doctor` is **read-only**: it creates nothing and repairs nothing. On a project with no
profile yet it still checks your host prerequisites, which is exactly what you need
before the first `start`.

The three statuses mean different things:

| Status | Meaning |
|---|---|
| `PASS` | the dependency or profile piece is working |
| `WARN` | nonfatal, safely derivable state that `murmur start` repairs (a missing identity, a missing pairing edge, a stale socket file, stale run state) |
| `FAIL` | a required dependency is missing, or the profile is contradictory/unsafe — `start` refuses rather than guessing |

Exit code 2 when any check fails.

## Codex executable discovery

Codex is not looked up on `PATH` alone. One canonical discovery chain is shared by
profile generation, `doctor` and the supervisor, in this order:

1. **an explicit override** — `codexAppServer.command` in `project.json`, when it
   resolves to a real executable (an absolute path, or a binary name on `PATH`);
2. **`codex` on `PATH`**;
3. **on macOS, the Codex CLI bundled with the ChatGPT desktop app**, at
   `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.

The bundled path is a fallback, never the only supported installation — a `codex` on
`PATH` always wins over it. If no candidate resolves, `doctor` and `start` fail with an
explicit error listing what was tried.

`doctor` reports which source was selected:

```
  PASS  codex-binary  /Applications/ChatGPT.app/.../MacOS/codex (ChatGPT app bundle)
```

A configured override that does not resolve does not abort discovery; it is reported as
a `codex-binary-override` warning so an ignored override is visible rather than silent.

### The socket is an endpoint, not a managed file

The real Codex App Server does **not** create a socket at the pathname it is given. It
materialises that pathname as a **symlink to its own socket**:

```
~/.murmur/projects/<project-id>/run/codex.sock
  -> /private/tmp/codex-daemon-501/38ab65b0025d5c21883c7bf1312df319…
```

That is the App Server's runtime property, so `run/codex.sock` is the one path in the profile
whose **leaf** may legitimately be a symlink. Two shapes are accepted:

| Leaf | Verdict |
|---|---|
| a Unix socket directly at the configured path | healthy |
| a symlink whose target **is** a Unix socket | healthy (`socket=listening (alias)`) |
| a symlink whose target is missing | unhealthy (`socket-alias-broken`) |
| a symlink whose target is a file or directory | **FAIL** (`socket-alias-not-a-socket`) |
| any managed **ancestor** (`run`, `logs`, `agents`, an agent dir) replaced by a symlink | **invalid profile** |

Ancestor containment is not relaxed anywhere: the chain from the canonical profile root down to
`run` is still walked component by component and any symlink in it refuses the whole profile.
Only the final endpoint leaf has alias semantics, and whether the alias points at a live socket
is a *runtime health* question (`status`, `doctor`) — never a containment verdict.

The alias **target is runtime-owned**. Murmur inspects it to answer "is this a socket?" and does
nothing else with it: it is never treated as part of the managed tree, never written to, and
never deleted. Cleanup only ever unlinks Murmur's own configured path, which for an alias removes
the link and leaves the App Server's socket alone. A dangling alias is removed as stale on the
same rule (`lstat`, not `existsSync`, so a broken link is not mistaken for "no socket present").

A pre-existing alias is **not** trusted just because it resolves to a live socket: the
foreign-listener protection is unchanged, so a start over a socket nobody's Murmur supervisor
owns is still refused, and `doctor` still reports it as not ours.

### App Server endpoint

The App Server is always launched as `executable + argv`, never through a shell, and the
`--listen` endpoint uses the canonical three-slash form for an absolute socket path:

```
<resolved-codex> app-server --listen unix:///Users/you/.murmur/projects/<id>/run/codex.sock
```

`unix:/<path>` (two slashes) is not the form the Codex CLI accepts. A profile that still
carries an older `unix:{socket}` template is normalized to the canonical endpoint rather
than obeyed. In `codexAppServer.args`, `{endpoint}` expands to the canonical endpoint and
`{socket}` to the raw absolute path.

## Authentication troubleshooting

Authentication is verified in the foreground, before the supervisor exists. Murmur never
attempts an interactive browser login from a detached process.

| Symptom | Fix |
|---|---|
| `FAIL claude-auth  not authenticated` | `claude auth login` |
| `FAIL cursor-auth  not authenticated` | `agent login` |
| `FAIL claude-binary` | install Claude Code and make `claude` reachable on `PATH` |
| `FAIL cursor-binary` | install the Cursor Agent CLI (`agent`) |
| `FAIL codex-binary` | install Codex or the ChatGPT desktop app, set `codexAppServer.command`, or disable the codex agent (below) |

`start` exits before launching anything when one of these fails, so you never end up
with a partially started project.

## NATS requirement

Murmur v1 of this CLI **uses** a NATS server; it never starts, stops or reconfigures one.

- If the configured endpoint is reachable, it is used.
- If not, `doctor` and `start` report it as a fatal check and `start` refuses.

The endpoint (and optional token) live in `project.json` as `natsUrl` / `natsToken`; the
token is never printed. A local server is enough:

```bash
nats-server            # or: docker compose -f deploy/docker-compose.messaging.yml up -d
```

Automatic NATS ownership is deliberately left for a later improvement.

## Multiple projects

Two projects are fully independent: separate profile directories, identities, NATS
subjects, SQLite databases, PID/lock files, logs and Codex sockets. A single NATS server
can be shared because subjects and identities are unique per project.

There is no cross-project orchestration: each `murmur` command acts on exactly one
project.

## Restart

```bash
murmur stop  murmur
murmur start murmur
```

A restart reuses the same persistent profile: identities and pairing are preserved, the
durable Murmur databases (history, outbox, dispatch ledger, handoff continuations)
survive, and no profile or identity is recreated. Every process is fresh, including a
new Codex App Server process and socket generation.

**Restart limitations.** Murmur promises no more model-session continuity than the
runtimes themselves already guarantee:

- Claude resumes its recorded session with `--resume`, which survives a restart.
- Codex thread affinity is scoped to one App Server generation. A restart creates a new
  socket identity, so previous thread mappings are invalidated and the next turn seeds a
  fresh thread.
- Cursor ACP sessions live only as long as the owned `agent acp` child; a restart starts
  a new session.

An open handoff continuation whose originating runtime session cannot be genuinely
resumed is terminated with an explicit reason rather than silently resumed against an
unrelated session. See [`agent-handoff.md`](agent-handoff.md).

## Sending a root task

```bash
murmur send murmur "Summarise docs/agent-handoff.md in five bullet points"
murmur send murmur "..." --no-wait
murmur send murmur "..." --timeout 900
```

`send` submits one operator/root → coordinator request and waits for the **exact
correlated** reply. It adds no new message semantics: the envelope is built, signed,
encrypted and enqueued by the existing `scripts/murmur-shell-send.mjs` against the root
identity, the root daemon flushes the outbox as usual, and the reply is read from the
root identity's durable local inbox.

### Strict correlation

A message is accepted as the final result only when **all three** match:

- `replyToMessageId` is exactly the msgId of the request that was sent;
- the sender is exactly the expected coordinator agent id;
- the conversation is exactly the root conversation the request was sent on.

There is no latest-reply fallback, no time window and no conversation-only match. A
reply from another agent, or from the coordinator on a derived handoff conversation, is
not a candidate at all — it is ignored, and a later exact reply still satisfies the
command. On timeout, any ignored candidates are listed so the mismatch is visible.

### Health gate

`send` fails **before anything is enqueued** unless the whole target path is usable. It
uses the same health data `murmur status` renders, so the two cannot disagree:

- the project supervisor is running;
- the root daemon is running (it is what flushes the outbox);
- the Claude coordinator daemon is running;
- it holds an autonomous runtime binding on its exact member slot (`claude:auto`);
- the binding's heartbeat is fresh;
- the binding is `BOUND_IDLE`.

A coordinator that is `OFFLINE`, `STALE`, missing a binding, on the wrong member slot,
or whose daemon is dead blocks the send with no outbox row and no local message written.
A coordinator that is mid-turn (`CLAIMED`, `WAKING`, `RUNNING`) is reported distinctly as
**busy** rather than as dead — wait for the current task and send again.

## Agent model control (`murmur claude` / `murmur codex`)

```bash
murmur claude murmur config [--json] [--refresh]   # selected / running / effective + the full picker
murmur claude murmur model <id|inherit>            # alias ("sonnet") or pinned ("claude-sonnet-5")
murmur claude murmur effort <low|medium|high|xhigh|max|inherit>
murmur codex  murmur config [--json] [--refresh]
murmur codex  murmur model <id|inherit>
murmur codex  murmur effort <level|inherit>
```

Per-project preferences live beside the profile (`claude-preferences.json`,
`codex-preferences.json`); the CLI is the only writer, the menu bar app goes through it. Models
come from the installed tools' own catalogs (see [agent-model-discovery.md](agent-model-discovery.md));
an id the catalog does not offer — or any free string — is refused. Claude applies a new
choice when Murmur restarts; Codex applies an explicit choice from the next turn (and a return to
`inherit` on a new Codex session). Cursor has no selector (account-global — see
[cursor-model-discovery.md](cursor-model-discovery.md)). None of these commands writes any global
agent configuration. The recipient's project policy picks its model: a sender cannot.

## Active work, cancellation and usage

```bash
murmur tasks  <project> [--json]               # active + queued root tasks (+ a few recent)
murmur task   <project> <workflow-id> [--json] # one task: request, chain, stage, result
murmur cancel <project> <workflow-id> [--json] # cancel ONE workflow (never the project)
murmur usage  <project> [--json] [--refresh]   # provider subscription usage windows
```

See [active-work.md](active-work.md) (what a task is, states, exactly what cancellation stops) and
[usage-observability.md](usage-observability.md) (provider sources, quota vs rate limit vs context,
freshness and cadence).

## Logs

```bash
murmur logs murmur                      # supervisor, last 200 lines
murmur logs murmur claude -n 500
murmur logs murmur codex-app-server --follow
```

Per-project logs live in `~/.murmur/projects/<project-id>/logs/`, one file per
supervised process plus the supervisor itself. Rotation is a single generation at 8 MB
(`<name>.log` → `<name>.log.1`) applied when a log is opened; older material is not kept,
so delete `logs/*.log.1` manually if you want to reclaim space.

## Process and ownership model

One supervisor per project owns:

- the external Codex App Server it launched, and
- one Murmur daemon per enabled agent identity.

The Codex **Murmur daemon** still treats the App Server as external and unowned: it
connects to the socket, and never spawns, kills or unlinks it. The supervisor owning the
App Server process is a separate, higher layer; the proven runtime invariant is
unchanged.

Every supervised process is recorded with its exact PID **and** its kernel start time.
A signal is only ever delivered after that identity is re-read and still matches, which
is what makes PID reuse safe. The identity is read with a pinned locale and timezone so
two Murmur processes on the same host always compute the same value, and it is captured
with bounded retry immediately after the spawn — a child whose identity cannot be
established is reported as an unverified start, never as a successful one.

### Three ownership facts, never two

Every decision about an owned process distinguishes:

| State | Meaning |
|---|---|
| `ours` | measured alive, and still the exact process Murmur started |
| `gone` | **positively** measured absent — no such PID, or the PID now belongs to something else |
| `unknown` | ownership could not be measured right now, so the process may still be ours and alive |

`unknown` is never converted into `gone`. In particular a record whose start identity
was never captured means "ownership cannot yet be proven", **not** "the process is
absent". This matters because `ps` can time out under load, and a cleanup that read
that as "already dead" would skip the kill and leak a live detached process.

Consequences, all of them fail-closed:

- an `unknown` process is **never signalled** (ownership is unproven, so the PID might
  belong to someone else) and **never reported as stopped**;
- a lock whose owner is `unknown` is **never reclaimed**, and a start is refused;
- a stop is CLEAN only when every owned process is proven `not-running`, `terminated`
  or `killed`. Anything else is **STOP INCOMPLETE**: the run state, the PID/start-identity
  records, the lock and the socket are all preserved as the evidence a retry needs, the
  phase is recorded as `stop-incomplete`, and the command exits 3;
- a `murmur start` is refused while any recorded supervisor, lock owner, launch guard owner
  or child is not proven gone — so a failed cleanup can never be overlapped by a new run;
- the supervisor itself releases its lock only once its children are proven settled; if it
  must give up with cleanup incomplete it keeps the lock (see **Degraded hold** below).

### Trusted spawn handles

The one piece of evidence that outranks a `ps` measurement is the `ChildProcess` handle the
creator got back from its own `spawn`: while it has not exited, the process provably exists,
and its `exit` event is a first-hand observation of the OS reaping it. That evidence is
strictly scoped — it is only usable by the creator, only while it still holds the handle,
and "we once spawned PID X" is never equivalent once the handle is gone.

So a child whose ownership cannot be measured is not left as a durable null-identity record
to be puzzled over later. Its creator resolves the ambiguity **before** giving up authority,
through the handle it still holds: SIGTERM → wait for the real `exit` → SIGKILL → wait
again. An exit observed that way is recorded as positive evidence of absence, which is why
such a record settles cleanly even though its identity was never captured.

Everything durable still uses exact process identity. The handle is never a substitute for
it — only a stronger authority available to the creator, in-process, while it lasts.

### Degraded hold

If a child is still unsettled *and* the supervisor still holds its trusted handle, exiting
would destroy the last thing that could force or observe that process's exit. The supervisor
therefore does the opposite of exiting. It:

- stays alive, holding every retained spawn handle;
- keeps the authoritative project lock, so no new start can overlap it;
- keeps `phase: "stop-incomplete"` with the residual evidence in run state;
- keeps retrying termination through those handles, and finishes the shutdown properly
  (releasing its lock instance) if a retry finally observes every exit.

`murmur status` and `murmur doctor` show this state, and `murmur start` stays refused. If
the supervisor is itself SIGKILLed or crashes at exactly this point, the residual process
can no longer be proven to be ours: that is an unavoidable external-crash case requiring
manual recovery, and Murmur says so rather than pretending it can rediscover ownership.
What it never does is *voluntarily* create that condition.

### Lock and guard release is instance-scoped

A PID names a process slot, not an acquisition. If owner A holds the lock, exits, and the OS
hands its PID to owner B — which acquires a replacement lock — then a late cleanup path
belonging to A that compared only the PID would unlink B's live lock.

Every successful acquisition therefore mints a random instance token (`lockId` for
`supervisor.lock`, `launchId` for `launch.guard`) and is released **only** when the file on
disk still matches that exact token, PID and start identity. A `startIdentity` of `null` is
never authority to release anything.

Release and reclamation are deliberately different operations:

| Operation | Requires |
|---|---|
| release | the caller's exact acquisition instance (token + PID + start identity) |
| reclaim | **positive evidence** that the stored owner is gone (`stale`) |

`held` and `unknown` are never reclaimed. Post-stop cleanup, which by definition does not
hold a dead supervisor's token, may only *reclaim* — and only once every owned process is
proven gone.

Running `murmur stop <project>` again retries the cleanup against the preserved
evidence, and completes normally once the processes can be measured.

If the supervisor dies without stopping its children, they keep running; `murmur status`
reports it, and `murmur stop` reaps exactly those recorded PIDs.

## Notifications (`murmur notify`)

Operator notifications are a **Murmur-user setting, not per-project state**. The
credential lives in exactly one file, outside every repository:

```
$MURMUR_HOME/notifications.json      # default ~/.murmur/notifications.json, mode 0600
```

```json
{
  "version": 1,
  "telegram": { "botToken": "...", "chatId": "...", "topicId": "optional" },
  "webhook":  { "url": "https://...", "headers": { "x-token": "..." } }
}
```

`telegram` and `webhook` are the same shapes the pre-CLI `notify` block used, so the
existing `notify-router.mjs` transport consumes them unchanged. Nothing about the
Telegram bridge is redesigned.

```bash
murmur notify status                      # "Telegram: configured" / "not configured"
murmur notify migrate                     # one-time import from a legacy .data-* config
murmur notify migrate --from .data-cursor  # choose a source when several disagree
murmur notify test                         # send ONE explicit test notification
```

`status` and `--json` report **presence and shape only** — never a bot token, chat id,
topic id or webhook URL. A transport error is redacted before it is printed, because the
Telegram endpoint embeds the token in its path. `start` never sends a test notification.

### One credential, never N copies

A project profile stores a **policy**, never a credential:

```json
"notifications": { "source": "global", "scope": "all" }
```

That field is derivable from the agent's role, so `murmur start` repairs it in place on
an existing profile — no identity is regenerated, no key rotated, no database or history
touched. Once the global config exists, **every** `murmur start <project>` has
notifications available; there is no per-project `notify init`.

### Notification policy

`scope` decides which events reach the operator, and exists so that one task does not
produce one message per agent:

| Scope | Meaning | Default for |
|---|---|---|
| `all` | every inbound message, plus runtime-failure alerts | `root` (operator) |
| `errors` | runtime-failure alerts only (WakeMonitor fallback) | `claude`, `codex`, `cursor` |
| `off` | nothing | — |

Root only ever receives the coordinator's **final correlated reply**, so `all` at root is
exactly one notification per completed operator task. Internal `claude → codex`,
`claude → cursor` and worker → coordinator hops are deliberately silent. A runtime that
never picked up its work still alerts from the identity where it failed, whatever its
scope, because that is what the operator has to act on.

Resolution order for one daemon, so nothing that already worked changes:

1. an inline `notify` block in the agent config (the pre-CLI `.data-*` layout) — used
   as-is, with the historical all-inbound behaviour;
2. the global config, with this identity's `scope`;
3. the `MURMUR_TELEGRAM_BOT_TOKEN` / `MURMUR_TELEGRAM_CHAT_ID` environment fallback.

### Migration from a legacy config

`murmur notify migrate` reads `notify.telegram` out of `.data`, `.data-claude`,
`.data-codex` and `.data-cursor` under the current directory and writes the global config
atomically at 0600. It is deliberately conservative:

- legacy files are **read-only inputs** — never modified, moved or deleted;
- identical Claude/Cursor configs **deduplicate** into one migration;
- materially different configs **fail closed**, reporting only a short fingerprint and
  the directory names, so the operator chooses with `--from`;
- a malformed legacy notifier aborts the migration rather than being skipped;
- it is **idempotent**: a second run changes nothing, and an existing global config is
  never overwritten.

### Notifications never gate the bus

`doctor` reports notifications as a **non-blocking** check:

```
  PASS  telegram-notify  configured (global: telegram:telegram)
  WARN  telegram-notify  not configured
  WARN  telegram-notify  configured but invalid (...)
  PASS  notify-policy    root=all claude=errors codex=errors cursor=errors
```

None of these is ever `fatal`. An absent or malformed notification config is a WARN for
the notification subsystem and never prevents the multi-agent runtime from starting.

## Running without one of the agents

`project.json` lists every agent with an `enabled` flag. Set it to `false` (for example
on `codex`, if Codex is not installed) and `doctor`, `start`, `status` and `stop` all
honour it: no daemon, no App Server, no checks for that agent. `root` and `claude` are
required. Pairing is left in place, so re-enabling an agent needs no new identity.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | usage or project-resolution error |
| 2 | preflight/doctor failure — nothing was started |
| 3 | unhealthy, not running, a refused duplicate start, a refused send, or a failed start whose cleanup could not finish |
| 4 | the supervisor failed to reach ready, and everything this invocation started was cleaned up |
