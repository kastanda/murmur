# Murmur Menu Bar

A native macOS menu bar app for Murmur. It is a **front end for the `murmur` CLI** and
nothing else: it starts nothing itself, signals no process, and never touches a database.

```
🟢  Murmur
    Проект: murmur
    Состояние: работает
    ──────────────
    ▶ Запустить      ■ Остановить
    ✉ Отправить задачу…
    ✓ Проверить      📋 Открыть логи
    Telegram: включён
    ──────────────
    Проекты ▸        Обновить        Выйти
```

The interface is Russian. Agent and product names (Claude, Codex, Cursor, NATS, Telegram)
are proper nouns and stay as they are.

## Build and install

```bash
npm run menubar:test      # deterministic tests, no Murmur and no network needed
npm run menubar:build     # assembles .build/bundle/Murmur.app
npm run menubar:install   # copies it to ~/Applications/Murmur.app
open ~/Applications/Murmur.app
```

Requires the Swift toolchain (Command Line Tools are enough — no Xcode project, nothing to
click). The install is **user-local**, so it never needs `sudo` and never writes into a
system directory. The bundle is ad-hoc signed for local use; it is not notarized and is
not meant for distribution.

`LSUIElement` is set, so there is no Dock icon and no window until you open one.

## How it talks to Murmur

Every action is the command you would type yourself:

| Menu                | Command                                  |
| ------------------- | ---------------------------------------- |
| status polling (5s) | `murmur status <project> --json`         |
| Запустить           | `murmur start <project>`                 |
| Остановить          | `murmur stop <project>`                  |
| Отправить задачу…   | `murmur send <project> "<task>" --json`  |
| Проверить           | `murmur doctor <project> --json`         |
| project list        | `murmur projects --json`                 |
| Telegram line       | `murmur notify status --json`            |

The CLI therefore remains the single authority on what "running" means, on the launch
guard, and on how a task is correlated to its reply. The app renders answers; it does not
compute them.

## Security properties

These are the reasons the code is shaped the way it is, and each has a test.

- **No shell, ever.** Commands run through `Process` with `executableURL` + `arguments`,
  which is an `execve`. There is no `/bin/sh -c`, no string building and no quoting. A
  multi-line task containing `` `backticks` ``, `$(...)` or `;` is passed as one argv entry
  and is therefore data, not a command.
- **No secrets enter the process.** The app asks the CLI for `murmur projects --json`
  rather than reading `project.json` itself, because that file holds a NATS token when one
  is configured. Telegram is reported as presence and mode only — the bot token and chat id
  are never read, requested or rendered.
- **No process management.** No signals, no `pkill`, no PID matching. Stopping is
  `murmur stop`, which stops only what it owns.
- **Only a preference is persisted** — the selected project, plus an optional CLI path.
  No status cache, no task text, no credential.

## Finding the CLI

A GUI app launched from Finder does not inherit your shell's `PATH`; it usually gets
`/usr/bin:/bin:/usr/sbin:/sbin`, where `murmur` never lives. The path is resolved
explicitly:

1. a path you configured (or `MURMUR_CLI` in the environment);
2. known install locations — Homebrew on both architectures, MacPorts, `~/.local/bin`,
   Volta, nvm, `~/.npm-global/bin`, `~/bin`;
3. otherwise the menu says so and tells you how to fix it.

There is deliberately **no login-shell probe** (`zsh -lc 'command -v murmur'`). It is the
usual trick for this problem and it works — but it means the app executes a shell, and
"this app never runs a shell" is a property worth being able to state without an asterisk.

The child process is given an explicit `PATH` that leads with the CLI's own directory,
because the CLI is a Node script with a `#!/usr/bin/env node` shebang and the child has to
be able to find `node` — and then `claude`, `codex` and `agent`.

## Layout

```
Sources/MurmurMenuBarCore/   CLI discovery, argv, decoding, health mapping, Russian strings
Sources/MurmurMenuBar/       SwiftUI only: MenuBarExtra and three windows
Sources/MurmurMenuBarCoreTests/  the deterministic suite
```

Everything decidable without a screen lives in `MurmurMenuBarCore`, so it can be tested
without a running Murmur, a window server or a model.

The tests are an **executable**, not an XCTest bundle, because XCTest ships with Xcode and
a suite that only runs on a machine with Xcode installed is a suite that does not run in
CI. `swift run MurmurMenuBarCoreTests` works anywhere the package builds.
