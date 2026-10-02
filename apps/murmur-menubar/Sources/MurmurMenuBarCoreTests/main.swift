import Foundation
import MurmurMenuBarCore

// MARK: - CLI discovery

suite("CLI discovery")

await test("a configured path wins over everything else") {
    let locator = CLILocator(isExecutable: { $0 == "/custom/murmur" || $0 == "/opt/homebrew/bin/murmur" })
    await expectEqual(locator.locate(configuredPath: "/custom/murmur", environment: [:]), .configured("/custom/murmur"))
}

await test("a configured path that broke is reported, not silently replaced") {
    // An operator who pointed us somewhere specific must hear that it broke rather than
    // be quietly redirected to a different binary.
    let locator = CLILocator(isExecutable: { $0 == "/opt/homebrew/bin/murmur" })
    await expectEqual(locator.locate(configuredPath: "/gone/murmur", environment: [:]), .missing)
}

await test("MURMUR_CLI is honoured when nothing is configured") {
    let locator = CLILocator(isExecutable: { $0 == "/env/murmur" })
    await expectEqual(
        locator.locate(configuredPath: nil, environment: ["MURMUR_CLI": "/env/murmur"]),
        .configured("/env/murmur")
    )
}

await test("known locations are searched in order and /usr/local is not assumed") {
    let both = CLILocator(isExecutable: { ["/opt/homebrew/bin/murmur", "/usr/local/bin/murmur"].contains($0) })
    await expectEqual(both.locate(environment: [:]), .discovered("/opt/homebrew/bin/murmur"))

    let userLocal = CLILocator(isExecutable: { $0 == "\(NSHomeDirectory())/.local/bin/murmur" })
    await expectEqual(userLocal.locate(environment: [:]), .discovered("\(NSHomeDirectory())/.local/bin/murmur"))
}

await test("a missing CLI is an explicit state, never a guess") {
    let locator = CLILocator(isExecutable: { _ in false })
    await expectEqual(locator.locate(environment: [:]), .missing)
    await expectNil(CLILocation.missing.path)
}

await test("the child PATH leads with the CLI's own directory and never duplicates") {
    // The CLI is a Node script; the child must find `node`, which shares its prefix.
    let path = childSearchPath(cliPath: "/opt/homebrew/bin/murmur", extraDirectories: ["/usr/local/bin"])
    await expect(path.hasPrefix("/opt/homebrew/bin:"), path)
    await expect(path.contains("/usr/bin"), path)

    let deduped = childSearchPath(cliPath: "/usr/local/bin/murmur", extraDirectories: ["/usr/local/bin"])
    await expectEqual(deduped.components(separatedBy: "/usr/local/bin").count - 1, 1, deduped)
}

// MARK: - argv construction (no shell)

suite("argv construction")

let cli = MurmurCLI(executable: "/opt/homebrew/bin/murmur", runner: FakeRunner { _ in ok("") })

await test("every command is an argv vector, never a shell string") {
    await expectEqual(cli.statusInvocation(project: "murmur").arguments, ["status", "murmur", "--json"])
    await expectEqual(cli.startInvocation(project: "murmur").arguments, ["start", "murmur"])
    await expectEqual(cli.stopInvocation(project: "murmur").arguments, ["stop", "murmur"])
    await expectEqual(cli.doctorInvocation(project: "murmur").arguments, ["doctor", "murmur", "--json"])
    await expectEqual(cli.projectsInvocation().arguments, ["projects", "--json"])
    await expectEqual(cli.notifyStatusInvocation().arguments, ["notify", "status", "--json"])

    for invocation in [cli.statusInvocation(project: "x"), cli.startInvocation(project: "x"),
                       cli.sendInvocation(project: "x", task: "t", timeoutSeconds: 1)] {
        for shell in ["/sh", "/bash", "/zsh"] {
            await expect(!invocation.executable.hasSuffix(shell), invocation.executable)
        }
        await expect(!invocation.arguments.contains("-c"), "no `-c`: \(invocation.arguments)")
    }
}

await test("a multi-line task is ONE argument and is never quoted or escaped") {
    let task = """
    Проверь релиз.
    Запусти: `rm -rf /tmp/x` && echo "$(whoami)"; drop table outbox --
    Верни ровно: MURMUR_MENU_OK
    """
    let invocation = cli.sendInvocation(project: "murmur", task: task, timeoutSeconds: 600)

    await expectEqual(invocation.arguments, ["send", "murmur", task, "--json", "--timeout", "600"])
    // The exact string the operator typed, byte for byte: no added quotes, no escaping, no
    // splitting on newlines or spaces. Because it is an argv entry rather than part of a
    // command line, the metacharacters in it are data.
    await expectEqual(invocation.arguments[2], task)
    await expect(invocation.arguments[2].contains("\n"), "newlines survive")
    await expectEqual(invocation.arguments.filter { $0.contains("MURMUR_MENU_OK") }.count, 1)
}

await test("a project path is data even when it looks like a flag or an injection") {
    let hostile = "/Users/x/Projects/--json; rm -rf ~"
    await expectEqual(cli.statusInvocation(project: hostile).arguments, ["status", hostile, "--json"])
}

await test("the canonical path is passed so projects outside ~/Projects still resolve") {
    let summary = ProjectSummary(
        projectId: "murmur-000000000001", name: "murmur", projectPath: "/elsewhere/murmur",
        profileRoot: "/p", logsDir: "/p/logs", valid: true
    )
    await expectEqual(summary.cliArgument, "/elsewhere/murmur")

    let broken = ProjectSummary(
        projectId: "broken-1", name: "broken-1", projectPath: nil,
        profileRoot: "/p", logsDir: "/p/logs", valid: false, reason: "invalid-profile:version-unsupported"
    )
    await expectEqual(broken.cliArgument, "broken-1")
}

// MARK: - decoding

suite("status JSON decoding")

await test("status decodes everything the menu shows") {
    let cli = MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(healthyStatusJSON) })
    let status = try await cli.status(project: "murmur")
    await expect(status.healthy)
    await expectEqual(status.supervisor?.pid, 4242)
    await expectEqual(status.nats?.passed, true)
    await expectEqual(status.agents?.count, 4)
    await expectEqual(status.totals?.openContinuations, 0)
}

await test("an unhealthy exit code is an answer, not a failure") {
    // `murmur status` exits 3 for an unhealthy project. That is the correct answer.
    let runner = FakeRunner { _ in CommandOutcome(exitCode: 3, stdout: stoppedStatusJSON, stderr: "") }
    let status = try await MurmurCLI(executable: "/m", runner: runner).status(project: "murmur")
    await expect(!status.healthy)
    await expectEqual(status.problems ?? [], ["supervisor is not running"])
}

await test("Node's experimental warning on stdout does not break decoding") {
    let noisy = "(node:123) ExperimentalWarning: SQLite is an experimental feature\n" + healthyStatusJSON
    let cli = MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(noisy) })
    await expect(try await cli.status(project: "murmur").healthy)
}

await test("non-JSON output is reported as malformed, not silently ignored") {
    let cli = MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok("not json at all") })
    await expectThrows {
        try await cli.status(project: "murmur")
    } verify: { error in
        if case .malformedOutput = error as? MurmurCLIError { return true }
        return false
    }
}

await test("a failed command with no JSON reports the failure, not a parse error") {
    let runner = FakeRunner { _ in CommandOutcome(exitCode: 1, stdout: "", stderr: "murmur: project-not-found") }
    await expectThrows {
        try await MurmurCLI(executable: "/m", runner: runner).status(project: "nope")
    } verify: { error in
        guard case let .commandFailed(code, message) = error as? MurmurCLIError else { return false }
        return code == 1 && message.contains("project-not-found")
    }
}

await test("send carries the CLI's correlated reply") {
    let json = """
    {"ok":true,"waited":true,"msgId":"m1","conversationId":"c1","replyMsgId":"r1",
     "from":"murmur-000000000001-claude","text":"MURMUR_MENU_OK"}
    """
    let cli = MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(json) })
    let result = try await cli.send(project: "murmur", task: "x", timeoutSeconds: 600)
    await expect(result.ok)
    await expectEqual(result.text, "MURMUR_MENU_OK")
}

await test("the send budget outlives the CLI's own wait") {
    // Killing the CLI at exactly its own deadline would lose the msgId it gave up on.
    let runner = FakeRunner { _ in ok("""
        {"ok":false,"reason":"timeout","msgId":"m1","timeoutSeconds":600}
        """) }
    _ = try await MurmurCLI(executable: "/m", runner: runner).send(project: "p", task: "t", timeoutSeconds: 600)
    await expectEqual(runner.timeouts.first, 630)
}

// MARK: - the real process runner

suite("real process runner")

// These run a trivial system binary, not Murmur. They exist because the fake runner
// cannot exercise pipes at all, and the one bug that actually shipped here was a pipe
// bug: the parent kept its own copy of each write end open, so `readToEnd()` never saw
// EOF and the app hung forever on a command that had already exited.

await test("a real command's output comes back instead of hanging") {
    let runner = ProcessCommandRunner(searchPath: "/usr/bin:/bin")
    let outcome = try await runner.run(
        CommandInvocation(executable: "/bin/echo", arguments: ["MURMUR_PIPE_OK"]), timeout: 10
    )
    await expectEqual(outcome.exitCode, 0)
    await expectEqual(outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "MURMUR_PIPE_OK")
}

await test("output larger than one pipe buffer is read in full") {
    // A full `doctor --json` is bigger than a pipe buffer; reading it after waiting for
    // exit, rather than concurrently, would deadlock the child on write.
    let runner = ProcessCommandRunner(searchPath: "/usr/bin:/bin")
    let big = String(repeating: "x", count: 200_000)
    let outcome = try await runner.run(
        CommandInvocation(executable: "/bin/echo", arguments: [big]), timeout: 20
    )
    await expectEqual(outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines).count, big.count)
}

await test("a command that outlives its budget is terminated and reported") {
    let runner = ProcessCommandRunner(searchPath: "/usr/bin:/bin")
    let started = Date()
    await expectThrows {
        try await runner.run(CommandInvocation(executable: "/bin/sleep", arguments: ["30"]), timeout: 1)
    } verify: { error in
        if case .timedOut = error as? MurmurCLIError { return true }
        return false
    }
    // It must RETURN promptly, not wait out the child: terminating is what unblocks the
    // pipe reads.
    await expect(Date().timeIntervalSince(started) < 10, "timeout must not wait for the child")
}

await test("many short-lived commands in a row all return") {
    // The hang that shipped here was run-loop dependent and probabilistic: one command
    // in a sequence would never return, with no child process left to point at. A single
    // invocation does not reproduce it; a run of them does.
    let runner = ProcessCommandRunner(searchPath: "/usr/bin:/bin")
    let started = Date()
    for index in 0..<40 {
        let outcome = try await runner.run(
            CommandInvocation(executable: "/bin/echo", arguments: ["run-\(index)"]), timeout: 10
        )
        await expectEqual(outcome.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "run-\(index)")
    }
    await expect(Date().timeIntervalSince(started) < 60, "40 echoes must not take a minute")
}

await test("a missing executable is a launch failure, not a crash") {
    let runner = ProcessCommandRunner(searchPath: "/usr/bin:/bin")
    await expectThrows {
        try await runner.run(CommandInvocation(executable: "/nonexistent/murmur", arguments: []), timeout: 5)
    } verify: { error in
        if case .launchFailed = error as? MurmurCLIError { return true }
        return false
    }
}

// MARK: - health mapping

suite("health mapping")

await test("healthy is running") {
    let status = try JSONDecoder().decode(ProjectStatus.self, from: Data(healthyStatusJSON.utf8))
    await expectEqual(healthState(for: status), .running)
}

await test("a deliberately stopped project is not shown as a fault") {
    // A red dot for a project the operator stopped on purpose trains them to ignore red.
    let status = try JSONDecoder().decode(ProjectStatus.self, from: Data(stoppedStatusJSON.utf8))
    await expectEqual(healthState(for: status), .stopped)
}

await test("something alive but not healthy is genuinely unhealthy") {
    let degraded = ProjectStatus(
        supervisor: SupervisorStatus(pid: 9, alive: true, phase: "degraded"),
        agents: [AgentStatus(name: "claude", role: "coordinator", alive: false, pid: nil, childState: "exited", memberSlot: nil)],
        healthy: false, problems: ["claude daemon is not running"]
    )
    await expectEqual(healthState(for: degraded), .unhealthy)

    // A live agent with a dead supervisor is a fault too, not a clean stop.
    let orphan = ProjectStatus(
        supervisor: SupervisorStatus(pid: nil, alive: false, phase: "not-started"),
        agents: [AgentStatus(name: "codex", role: "worker", alive: true, pid: 7, childState: "alive", memberSlot: nil)],
        healthy: false
    )
    await expectEqual(healthState(for: orphan), .unhealthy)
}

await test("busy and unknown are distinct from both settled states") {
    await expectEqual(healthState(for: nil), .unknown)
    await expectEqual(healthState(for: nil, busy: true), .busy)
    await expectEqual(healthState(for: ProjectStatus(healthy: true), busy: true), .busy)
}

await test("every health state has a Russian label") {
    for state in [HealthState.running, .stopped, .busy, .unhealthy, .unknown] {
        let label = L.healthLabel(state)
        await expect(!label.isEmpty)
        await expect(isRussian(label), "«\(label)» must be Russian")
    }
}

// MARK: - controller behaviour

suite("controller")

await test("refresh loads projects, status and the notify state") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expectEqual(await controller.projects.map(\.name), ["murmur", "other"])
    await expectEqual(await controller.health, .running)
    await expectEqual(await controller.telegramLabel, L.telegramOn)
    await expectNil(await controller.lastError)
}

await test("switching project persists the choice and requeries the new one") {
    let preferences = MemoryPreferences()
    let runner = healthyRunner()
    let controller = await makeController(runner: runner, preferences: preferences)
    await controller.refresh()
    await expectEqual(await controller.selectedProject?.name, "murmur")

    await controller.selectProject("other-aaaaaaaaaaaa")
    await expectEqual(preferences.string(forKey: PreferenceKey.selectedProject), "other-aaaaaaaaaaaa")
    await controller.refresh()
    await expectEqual(await controller.selectedProject?.name, "other")
    // The new project is queried by ITS path, not the previous one's.
    await expect(
        runner.invocations.contains { $0.arguments == ["status", "/Users/x/Projects/other", "--json"] },
        "expected a status call for the newly selected project"
    )
}

await test("only the selected project preference is ever persisted") {
    let preferences = MemoryPreferences()
    let controller = await makeController(runner: healthyRunner(), preferences: preferences)
    await controller.refresh()
    await controller.selectProject("other-aaaaaaaaaaaa")
    _ = await controller.send(task: "секрет: не сохранять этот текст")

    // The app keeps a project choice and a CLI path. Nothing else — no status cache, no
    // task text, no credential.
    await expectEqual(Set(preferences.keys), Set([PreferenceKey.selectedProject, PreferenceKey.cliPath]))
}

await test("concurrent lifecycle commands are refused") {
    let runner = healthyRunner()
    runner.gate = { @Sendable in try? await Task.sleep(nanoseconds: 150_000_000) }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count

    await controller.stop()
    await expect(await controller.isBusy)
    // Every lifecycle affordance closes while one is in flight, so a double click cannot
    // race the first command for the project's launch guard.
    await expect(!(await controller.canStart))
    await expect(!(await controller.canStop))
    await expect(!(await controller.canSend))

    await controller.start()
    await controller.stop()
    await expectEqual(await controller.send(task: "x"), .failed(L.busy))

    let lifecycle = runner.invocations.dropFirst(before)
        .filter { ["start", "stop", "send"].contains($0.arguments.first ?? "") }
    await expectEqual(lifecycle.count, 1, "exactly one lifecycle command may reach the CLI")
    await expectEqual(lifecycle.first?.arguments.first, "stop")
    try? await Task.sleep(nanoseconds: 400_000_000)
}

await test("the icon shows busy while a command runs, never a settled state") {
    let runner = healthyRunner()
    runner.gate = { @Sendable in try? await Task.sleep(nanoseconds: 150_000_000) }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    await expectEqual(await controller.health, .running)
    await controller.start()
    await expectEqual(await controller.health, .busy)
    try? await Task.sleep(nanoseconds: 400_000_000)
}

await test("send returns the correlated reply") {
    let runner = FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "send": return ok("""
            {"ok":true,"waited":true,"msgId":"m1","conversationId":"c1","text":"MURMUR_MENU_OK"}
            """)
        default: return ok("")
        }
    }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    await expectEqual(await controller.send(task: "Ответь точно: MURMUR_MENU_OK"), .reply("MURMUR_MENU_OK"))
}

await test("a send failure becomes one Russian sentence") {
    let runner = FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "send": return CommandOutcome(exitCode: 3, stdout: """
            {"ok":false,"reason":"timeout","msgId":"m1","timeoutSeconds":600}
            """, stderr: "")
        default: return ok("")
        }
    }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    guard case let .failed(message) = await controller.send(task: "x") else {
        await expect(false, "expected a failure")
        exit(await finish())
    }
    await expect(message.contains("не ответил вовремя"), message)
    await expect(!message.contains("timeout"), "the raw reason code is not an answer for a human")
}

await test("a missing CLI disables every action and says so") {
    let controller = await makeController(runner: healthyRunner(), cliPath: nil)
    await controller.refresh()
    await expectEqual(await controller.cliLocation, .missing)
    await expect(!(await controller.canStart))
    await expect(!(await controller.canStop))
    await expect(!(await controller.canSend))
    await expectEqual(await controller.send(task: "x"), .failed(L.cliMissingTitle))
}

await test("start and stop are offered only when they would mean something") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expectEqual(await controller.health, .running)
    await expect(!(await controller.canStart), "a running project has nothing to start")
    await expect(await controller.canStop)
}

await test("the doctor report is decoded for rendering") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await controller.runDoctor()
    try? await Task.sleep(nanoseconds: 300_000_000)
    await expectEqual(await controller.doctor?.status, "PASS")
    await expectEqual(await controller.doctor?.checks.first?.name, "nats")
}

// MARK: - Claude model/effort control

suite("Claude model/effort")

await test("argv for reading and setting the Claude policy") {
    let cli = MurmurCLI(executable: "/opt/homebrew/bin/murmur", runner: FakeRunner { _ in ok("") })
    await expectEqual(cli.claudeConfigInvocation(project: "murmur").arguments, ["claude", "murmur", "config", "--json"])
    await expectEqual(cli.setClaudeModelInvocation(project: "murmur", value: "sonnet").arguments, ["claude", "murmur", "model", "sonnet"])
    await expectEqual(cli.setClaudeEffortInvocation(project: "murmur", value: "medium").arguments, ["claude", "murmur", "effort", "medium"])
    // No shell here either.
    for invocation in [cli.setClaudeModelInvocation(project: "murmur", value: "opus")] {
        await expect(!invocation.arguments.contains("-c"))
    }
}

await test("claudeConfig decodes selected, running and effective exactly as the CLI reports them") {
    let cli = MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigJSON) })
    let report = try await cli.claudeConfig(project: "murmur")
    await expectEqual(report.claude.model, "sonnet")
    await expectEqual(report.claude.modelLabel, "Актуальный Sonnet")
    await expectEqual(report.claude.effort, "medium")
    await expectEqual(report.claude.pendingRestart, false)
    await expectEqual(report.claude.selected?.kind, "alias")
    await expectEqual(report.claude.effective?.effectiveLabel, "Sonnet 5.5")
    await expectEqual(report.claude.canonicalModel, "claude-sonnet-5-5")
    await expectEqual(report.claude.models.count, 10)
    await expectEqual(report.claude.effortOptions.map(\.id), ["low", "medium", "high", "inherit"])
}

await test("refresh loads the Claude config alongside status") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expectEqual(await controller.claudeConfig?.claude.model, "sonnet")
    await expectEqual(await controller.claudeConfig?.claude.modelLabel, "Актуальный Sonnet")
}

await test("switching project clears the previous project's Claude config immediately") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expect(await controller.claudeConfig != nil)
    await controller.selectProject("other-aaaaaaaaaaaa")
    await expectNil(await controller.claudeConfig, "the old project's Claude policy must not be shown for the new selection even briefly")
}

await test("selecting Sonnet invokes exactly the Sonnet argv and refreshes") {
    let runner = healthyRunner()
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setClaudeModel("sonnet")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let calls = runner.invocations.dropFirst(before)
    await expect(calls.contains { $0.arguments == ["claude", "/Users/x/Projects/murmur", "model", "sonnet"] })
}

await test("selecting Opus invokes exactly the Opus argv") {
    let runner = healthyRunner()
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setClaudeModel("opus")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let calls = runner.invocations.dropFirst(before)
    await expect(calls.contains { $0.arguments == ["claude", "/Users/x/Projects/murmur", "model", "opus"] })
}

await test("selecting 'По настройкам Claude Code' sends the inherit sentinel") {
    let runner = healthyRunner()
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setClaudeModel("inherit")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let calls = runner.invocations.dropFirst(before)
    await expect(calls.contains { $0.arguments == ["claude", "/Users/x/Projects/murmur", "model", "inherit"] })
}

await test("selecting an effort level invokes exactly that argv") {
    let runner = healthyRunner()
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setClaudeEffort("high")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let calls = runner.invocations.dropFirst(before)
    await expect(calls.contains { $0.arguments == ["claude", "/Users/x/Projects/murmur", "effort", "high"] })
}

await test("a CLI that supports neither flag offers only inherit, and no picker is built from it") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigUnsupportedJSON) })
        .claudeConfig(project: "murmur")
    await expectEqual(report.claude.models.map(\.id), ["inherit"])
    await expectEqual(report.claude.effortOptions.map(\.id), ["inherit"])
    await expectEqual(report.capabilities.modelSupported, false)
}

await test("a rejected model value surfaces as a Russian error, not a silent no-op") {
    let runner = FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "claude":
            if invocation.arguments.dropFirst(2).first == "model" {
                return CommandOutcome(exitCode: 1, stdout: "",
                    stderr: "murmur: 'haiku' is not supported by the installed Claude CLI.")
            }
            return ok(claudeConfigJSON)
        default: return ok("")
        }
    }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    await controller.setClaudeModel("haiku")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let message = await controller.lastError
    await expect(message != nil)
    await expect(message?.range(of: "[А-Яа-я]", options: .regularExpression) != nil, message ?? "nil")
}

await test("pending-restart wording is shown only when the CLI reports one, and is truthful") {
    let runner = FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "claude": return ok(claudeConfigPendingRestartJSON)
        default: return ok("")
        }
    }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let config = await controller.claudeConfig
    await expectEqual(config?.claude.pendingRestart, true)
    // Sonnet 5 is SELECTED (pinned) but the moving alias, currently Sonnet 5.5, is what is
    // actually running — the UI must tell those apart, never claim Sonnet 5 is already active.
    await expectEqual(config?.claude.model, "claude-sonnet-5")
    await expectEqual(config?.claude.effectiveModel, "sonnet")
    await expectEqual(config?.claude.effectiveModelLabel, "Sonnet 5.5")
    if let claude = config?.claude {
        await expectEqual(ModelMenu.claudePendingLines(claude), [
            "Выбрано: Sonnet 5 · Высокое",
            "Сейчас: Sonnet 5.5 · Среднее",
            "Применится после перезапуска Murmur.",
        ])
    }
}

await test("no pending-restart banner when selected already matches what is running") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expectEqual(await controller.claudeConfig?.claude.pendingRestart, false)
}

await test("setting a Claude model is refused while another lifecycle command is in flight") {
    let runner = healthyRunner()
    runner.gate = { @Sendable in try? await Task.sleep(nanoseconds: 150_000_000) }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count

    await controller.start()
    // Give the spawned `start` task a chance to actually reach the runner (and its gate)
    // before asserting on invocation counts — see the companion test below for why.
    try? await Task.sleep(nanoseconds: 20_000_000)
    await expect(await controller.isBusy)
    await controller.setClaudeModel("opus")
    await controller.setClaudeEffort("high")

    let lifecycle = runner.invocations.dropFirst(before)
        .filter { ["start", "claude"].contains($0.arguments.first ?? "") }
    await expectEqual(lifecycle.count, 1, "the model/effort writes must not reach the CLI while start is in flight")
    await expectEqual(lifecycle.first?.arguments.first, "start")
    try? await Task.sleep(nanoseconds: 400_000_000)
}

await test("starting Murmur is refused while a Claude model change is in flight") {
    let runner = healthyRunner()
    runner.gate = { @Sendable in try? await Task.sleep(nanoseconds: 150_000_000) }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count

    await controller.setClaudeModel("opus")
    // Give the spawned command task a chance to actually reach the runner (and its gate)
    // before asserting on invocation counts — `isBusy` flips synchronously inside
    // `perform()`, but the runner call itself happens inside the task it spawns.
    try? await Task.sleep(nanoseconds: 20_000_000)
    await expect(await controller.isBusy)
    await controller.start()

    let lifecycle = runner.invocations.dropFirst(before)
        .filter { ["start", "claude"].contains($0.arguments.first ?? "") }
    await expectEqual(lifecycle.count, 1, "start must not reach the CLI while a model change is in flight")
    try? await Task.sleep(nanoseconds: 400_000_000)
}

await test("the Claude section of the menu is entirely Russian, including every option label and heading") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigJSON) })
        .claudeConfig(project: "murmur")
    await expect(isRussian(report.claude.modelLabel))
    await expect(isRussian(report.claude.effortLabel))
    for row in ModelMenu.claudeRows(options: report.claude.models, selectedId: report.claude.model) {
        switch row {
        case let .heading(title): await expect(isRussian(title), "«\(title)» must be Russian")
        case let .option(_, title, _, _): await expect(isRussian(title), "«\(title)» must be Russian (model names are proper nouns)")
        case .divider: break
        }
    }
    for option in report.claude.effortOptions {
        await expect(isRussian(option.label), "«\(option.label)» must be Russian")
    }
    await expect(isRussian(ModelMenu.claudeSummary(report.claude)))
    await expect(isRussian(L.claudeModelMenu))
    await expect(isRussian(L.claudeEffortMenu))
    await expect(isRussian(L.claudePendingRestart))
    await expect(isRussian(L.modelAliasesSection))
    await expect(isRussian(L.modelPinnedSection))
}

await test("every discovered Claude option renders: aliases, then fixed versions, then inherit") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigJSON) })
        .claudeConfig(project: "murmur")
    let rows = ModelMenu.claudeRows(options: report.claude.models, selectedId: report.claude.model)
    let optionIds = rows.compactMap { row -> String? in if case let .option(id, _, _, _) = row { return id } else { return nil } }
    await expectEqual(optionIds, report.claude.models.map(\.id), "no discovered option is dropped and none is invented")
    await expectEqual(rows.first, .heading("Актуальные"))
    await expect(rows.contains(.heading("Фиксированные версии")))
    await expect(rows.contains(.divider))
    // order: aliases before pinned before inherit
    let kinds = report.claude.models.map(\.kind)
    await expectEqual(kinds, ["alias", "alias", "alias", "pinned", "pinned", "pinned", "pinned", "pinned", "pinned", "inherit"])
}

await test("a moving alias is labelled «Актуальный …» with what it resolves to; a pinned version is just its version") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigJSON) })
        .claudeConfig(project: "murmur")
    let byId = Dictionary(uniqueKeysWithValues: report.claude.models.map { ($0.id, $0) })
    await expectEqual(ModelMenu.title(for: byId["sonnet"]!), "Актуальный Sonnet — сейчас Sonnet 5.5")
    await expectEqual(ModelMenu.title(for: byId["claude-sonnet-5"]!), "Sonnet 5")
    await expectEqual(ModelMenu.title(for: byId["claude-sonnet-5-5"]!), "Sonnet 5.5")
    await expectEqual(ModelMenu.title(for: byId["inherit"]!), "По настройкам Claude Code — сейчас Opus 5.5")
    await expect(ModelMenu.title(for: byId["claude-sonnet-5"]!) != ModelMenu.title(for: byId["claude-sonnet-5-5"]!),
                 "Sonnet 5 and Sonnet 5.5 are two distinct choices")
    await expect(ModelMenu.title(for: byId["sonnet"]!).hasPrefix("Актуальный"), "an alias is never presented as a version")
}

await test("the checkmark follows the SELECTED option, exactly one row, alias or pinned") {
    func checked(_ json: String) async throws -> [String] {
        let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(json) }).claudeConfig(project: "murmur")
        return ModelMenu.claudeRows(options: report.claude.models, selectedId: report.claude.model).compactMap { row in
            if case let .option(id, _, true, _) = row { return id } else { return nil }
        }
    }
    await expectEqual(try await checked(claudeConfigJSON), ["sonnet"])
    await expectEqual(try await checked(claudeConfigPinnedJSON), ["claude-sonnet-5"])
    await expectEqual(try await checked(claudeConfigInheritJSON), ["inherit"])
    // pending restart: the SELECTION (pinned Sonnet 5) is checked even though the alias is what runs
    await expectEqual(try await checked(claudeConfigPendingRestartJSON), ["claude-sonnet-5"])
    await expectEqual(ModelMenu.rowText(title: "Sonnet 5", checked: true), "✓ Sonnet 5")
    await expectEqual(ModelMenu.rowText(title: "Sonnet 5", checked: false), "  Sonnet 5")
}

await test("the main Claude line follows the EFFECTIVE model; selection and effective never share a label by accident") {
    let alias = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigJSON) }).claudeConfig(project: "murmur")
    await expectEqual(ModelMenu.claudeSummary(alias.claude), "Claude: Sonnet 5.5 · Среднее")
    let pinned = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigPinnedJSON) }).claudeConfig(project: "murmur")
    await expectEqual(ModelMenu.claudeSummary(pinned.claude), "Claude: Sonnet 5 · Среднее")
    let pending = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigPendingRestartJSON) }).claudeConfig(project: "murmur")
    await expectEqual(ModelMenu.claudeSummary(pending.claude), "Claude: Sonnet 5.5 · Среднее", "the daemon still runs the alias")
    let inherit = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(claudeConfigInheritJSON) }).claudeConfig(project: "murmur")
    await expectEqual(ModelMenu.claudeSummary(inherit.claude), "Claude: Sonnet 5.5 · По настройкам Claude Code")
    // the SAME resolver output feeds the summary and the pending text
    await expectEqual(pending.claude.effective?.effectiveLabel, pending.claude.effectiveModelLabel)
    await expectEqual(ModelMenu.claudePendingLines(alias.claude), [], "no pending text without a pending restart")
}

await test("an option the CLI marks unselectable renders disabled and stays out of the way") {
    let options = [
        ModelOption(id: "sonnet", kind: "alias", label: "Актуальный Sonnet", resolvesToLabel: "Sonnet 5.5"),
        ModelOption(id: "claude-old", kind: "pinned", label: "Old 1", selectable: false, disabledReason: "no-longer-offered"),
        ModelOption(id: "inherit", kind: "inherit", label: "По настройкам Claude Code"),
    ]
    let rows = ModelMenu.claudeRows(options: options, selectedId: "sonnet")
    await expect(rows.contains(.option(id: "claude-old", title: "Old 1", checked: false, enabled: false)))
    await expect(rows.contains(.option(id: "sonnet", title: "Актуальный Sonnet — сейчас Sonnet 5.5", checked: true, enabled: true)))
}

await test("only sections that actually have options are rendered") {
    let onlyInherit = ModelMenu.claudeRows(options: [ModelOption(id: "inherit", kind: "inherit", label: "По настройкам Claude Code")], selectedId: "inherit")
    await expectEqual(onlyInherit, [.option(id: "inherit", title: "По настройкам Claude Code", checked: true, enabled: true)])
    await expectEqual(ModelMenu.claudeRows(options: [], selectedId: "inherit"), [])
}

await test("selecting a pinned version sends exactly its id as one argv entry, never a shell string") {
    let runner = healthyRunner()
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setClaudeModel("claude-sonnet-5")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let calls = runner.invocations.dropFirst(before)
    await expect(calls.contains { $0.arguments == ["claude", "/Users/x/Projects/murmur", "model", "claude-sonnet-5"] })
    for call in calls { await expect(!call.arguments.contains("-c") && !call.arguments.contains("sh")) }
}

// MARK: - Codex model/reasoning (project-scoped, shown only when the CLI says controllable)

suite("Codex model/effort")

await test("argv for reading and setting the Codex policy is direct argv") {
    let cli = MurmurCLI(executable: "/opt/homebrew/bin/murmur", runner: FakeRunner { _ in ok("") })
    await expectEqual(cli.codexConfigInvocation(project: "murmur").arguments, ["codex", "murmur", "config", "--json"])
    await expectEqual(cli.setCodexModelInvocation(project: "murmur", value: "model-b").arguments, ["codex", "murmur", "model", "model-b"])
    await expectEqual(cli.setCodexEffortInvocation(project: "murmur", value: "low").arguments, ["codex", "murmur", "effort", "low"])
    await expect(!cli.setCodexModelInvocation(project: "murmur", value: "x").arguments.contains("-c"))
}

await test("codexConfig decodes selected, effective, catalog and transition flags exactly as the CLI reports them") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigPendingNextTurnJSON) }).codexConfig(project: "murmur")
    await expectEqual(report.codex.controllable, true)
    await expectEqual(report.codex.selectedModel, "model-b")
    await expectEqual(report.codex.effectiveModelLabel, "Model A")
    await expectEqual(report.codex.availableModels.map(\.id), ["model-a", "model-b", "inherit"])
    await expectEqual(report.codex.pendingNextTurn, true)
    await expectEqual(report.codex.requiresNewThread, false)
    await expectEqual(report.codex.pendingRestart, false)
}

await test("the Codex summary follows the EFFECTIVE model and reasoning; transitions are the technically true ones") {
    let plain = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigJSON) }).codexConfig(project: "murmur")
    await expectEqual(ModelMenu.codexSummary(plain.codex), "Codex: Model A · Высокое")
    await expectEqual(ModelMenu.codexPendingLines(plain.codex), [])
    let next = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigPendingNextTurnJSON) }).codexConfig(project: "murmur")
    await expectEqual(ModelMenu.codexSummary(next.codex), "Codex: Model A · Высокое")
    await expectEqual(ModelMenu.codexPendingLines(next.codex), [
        "Выбрано: Model B · Низкое", "Сейчас: Model A · Высокое", "Применится со следующего запроса к Codex.",
    ])
    // An explicit choice nothing has run under yet: no fake "now", just the true transition.
    let neverRun = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigSelectedNeverRunJSON) }).codexConfig(project: "murmur")
    await expectEqual(neverRun.codex.effectiveModelLabel, nil)
    await expectEqual(ModelMenu.codexPendingLines(neverRun.codex), ["Применится со следующего запроса к Codex."])
    let newThread = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigNewThreadJSON) }).codexConfig(project: "murmur")
    await expectEqual(ModelMenu.codexPendingLines(newThread.codex).last, "Применится к новой сессии Codex.")
    await expect(!ModelMenu.codexPendingLines(newThread.codex).joined().contains("перезапуска"), "Codex never needs a Murmur restart")
}

await test("Codex rows: every catalog model, checkmark on the SELECTED one, inherit last") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigPendingNextTurnJSON) }).codexConfig(project: "murmur")
    let rows = ModelMenu.codexRows(options: report.codex.availableModels, selectedId: report.codex.selectedModel)
    await expectEqual(rows, [
        .option(id: "model-a", title: "Model A", checked: false, enabled: true),
        .option(id: "model-b", title: "Model B", checked: true, enabled: true),
        .divider,
        .option(id: "inherit", title: "По настройкам Codex — сейчас Model A", checked: false, enabled: true),
    ])
    let effort = ModelMenu.effortRows(options: report.codex.effortOptions, selectedId: report.codex.reasoningEffort)
    await expectEqual(effort.compactMap { row -> String? in if case let .option(id, _, true, _) = row { return id } else { return nil } }, ["low"])
}

await test("a Codex whose catalog is unreadable shows the effective model only — no controls data, no fake selector") {
    let report = try await MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(codexConfigUncontrollableJSON) }).codexConfig(project: "murmur")
    await expectEqual(report.codex.controllable, false)
    await expectEqual(report.codex.availableModels, [])
    await expectEqual(ModelMenu.codexSummary(report.codex), "Codex: по настройкам Codex")
    await expectEqual(ModelMenu.codexPendingLines(report.codex), [])
    await expect(isRussian(L.codexModelUnavailable))
}

await test("refresh loads the Codex config alongside status; switching project clears it immediately") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expectEqual(await controller.codexConfig?.codex.effectiveModelLabel, "Model A")
    await controller.selectProject("other-aaaaaaaaaaaa")
    await expectNil(await controller.codexConfig, "the old project's Codex info must not be shown for the new selection even briefly")
}

await test("a project without a Codex identity simply omits the Codex rows") {
    let runner = FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "codex": return CommandOutcome(exitCode: 3, stdout: "", stderr: "murmur: this project has no Codex identity.")
        default: return ok("")
        }
    }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    await expectNil(await controller.codexConfig)
}

await test("selecting a Codex model or effort invokes exactly that argv and refreshes") {
    let runner = healthyRunner()
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setCodexModel("model-b")
    try? await Task.sleep(nanoseconds: 200_000_000)
    await controller.setCodexEffort("low")
    try? await Task.sleep(nanoseconds: 200_000_000)
    let calls = runner.invocations.dropFirst(before)
    await expect(calls.contains { $0.arguments == ["codex", "/Users/x/Projects/murmur", "model", "model-b"] })
    await expect(calls.contains { $0.arguments == ["codex", "/Users/x/Projects/murmur", "effort", "low"] })
}

await test("a Codex model change is refused while another lifecycle command is in flight, and vice versa") {
    let runner = healthyRunner()
    runner.gate = { @Sendable in try? await Task.sleep(nanoseconds: 150_000_000) }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    let before = runner.invocations.count
    await controller.setCodexModel("model-b")
    try? await Task.sleep(nanoseconds: 20_000_000)
    await expect(await controller.isBusy)
    await controller.start()
    await controller.setCodexEffort("low")
    await controller.setClaudeModel("opus")
    let lifecycle = runner.invocations.dropFirst(before).filter { ["start", "claude", "codex"].contains($0.arguments.first ?? "") }
    await expectEqual(lifecycle.count, 1, "only the first command may reach the CLI while one is in flight")
    try? await Task.sleep(nanoseconds: 400_000_000)
}

await test("the app never edits a model preference file itself — every write is a CLI argv") {
    // This test file lives in Sources/MurmurMenuBarCoreTests; scan the app's own sources.
    let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let enumerator = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)
    var offenders: [String] = []
    while let url = enumerator?.nextObject() as? URL {
        guard url.pathExtension == "swift", !url.path.contains("MurmurMenuBarCoreTests") else { continue }
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        for needle in ["claude-preferences", "codex-preferences", "cli-config.json", "acp-config.json", "settings.json", "config.toml"] where text.contains(needle) {
            // doc comments may NAME a file; code must not open one — flag only non-comment lines
            for line in text.split(separator: "\n") where line.contains(needle) && !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                offenders.append("\(url.lastPathComponent): \(line)")
            }
        }
    }
    await expect(offenders.isEmpty, offenders.joined(separator: "\n"))
}

// MARK: - Cursor model (read-only, non-controllable)

await test("argv for reading the Cursor policy is read-only") {
    // There is deliberately no `setCursorModelInvocation`/`setCursorModel` on `MurmurCLI`
    // to call here — that absence is enforced at COMPILE time (adding one would be a
    // reviewable diff to this file and to `MurmurCLI.swift`), not something a runtime
    // reflection check could meaningfully assert. This test proves the one argv that does
    // exist is exactly the read-only query, with no shell and no model value in it at all.
    let cli = MurmurCLI(executable: "/opt/homebrew/bin/murmur", runner: FakeRunner { _ in ok("") })
    let invocation = cli.cursorConfigInvocation(project: "murmur")
    await expectEqual(invocation.arguments, ["cursor", "murmur", "config", "--json"])
    await expect(!invocation.arguments.contains("-c"))
}

await test("cursorConfig decodes the real non-controllable shape exactly as the CLI reports it") {
    let cli = MurmurCLI(executable: "/m", runner: FakeRunner { _ in ok(cursorConfigJSON) })
    let report = try await cli.cursorConfig(project: "murmur")
    await expectEqual(report.cursor.controllable, false)
    await expectEqual(report.cursor.selectedModel, nil)
    await expectEqual(report.cursor.effectiveModel, "claude-opus-5")
    await expectEqual(report.cursor.effectiveModelLabel, "Claude Opus 5 300K High")
    await expectEqual(report.cursor.source, "cursor-global")
    await expectEqual(report.cursor.supportedModels, [])
}

await test("refresh loads the Cursor config alongside status, read-only") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expectEqual(await controller.cursorConfig?.cursor.effectiveModelLabel, "Claude Opus 5 300K High")
    await expectEqual(await controller.cursorConfig?.cursor.controllable, false)
}

await test("switching project clears the previous project's Cursor config immediately") {
    let controller = await makeController(runner: healthyRunner())
    await controller.refresh()
    await expect(await controller.cursorConfig != nil)
    await controller.selectProject("other-aaaaaaaaaaaa")
    await expectNil(await controller.cursorConfig, "the old project's Cursor info must not be shown for the new selection even briefly")
}

await test("the 'Auto' default state is shown exactly as Cursor reports it, never translated into a Claude-style label") {
    let runner = FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "claude": return ok(claudeConfigJSON)
        case "cursor": return ok(cursorConfigAutoJSON)
        default: return ok("")
        }
    }
    let controller = await makeController(runner: runner)
    await controller.refresh()
    await expectEqual(await controller.cursorConfig?.cursor.effectiveModelLabel, "Auto")
}

await test("the Cursor line and its explanatory note are Russian, and the note says Murmur does not control it") {
    await expect(isRussian(L.cursorByCursorSettings))
    await expect(isRussian(L.cursorNotControlledByMurmur))
    await expect(L.cursorNotControlledByMurmur.lowercased().contains("не управляет"), "must explicitly say Murmur does not control Cursor's model")
}

// MARK: - error rendering and secret hygiene

suite("rendering and secrets")

await test("failures render as Russian sentences, without stack traces") {
    let cases: [MurmurCLIError] = [
        .notInstalled,
        .launchFailed("The file “murmur” doesn’t exist."),
        .timedOut(seconds: 30),
        .malformedOutput("<html>"),
        .commandFailed(exitCode: 3, message: "murmur: refusing to start"),
    ]
    for error in cases {
        let rendered = describeFailure(error)
        await expect(!rendered.isEmpty)
        await expect(!rendered.contains("MurmurCLIError"), rendered)
        await expect(!rendered.contains("    at "), "no stack frames: \(rendered)")
        await expect(rendered.count < 260, "too long: \(rendered.count)")
        await expect(rendered.range(of: "[А-Яа-я]", options: .regularExpression) != nil, rendered)
    }
}

await test("every send failure is Russian and never a raw reason code") {
    let reasons = ["timeout", "coordinator-unavailable", "no-profile", "root-disabled",
                   "no-root-coordinator-pair", "task-required", "something-new"]
    for reason in reasons {
        let result = SendResult(ok: false, reason: reason, detail: nil, msgId: nil,
                                replyMsgId: nil, text: nil, timeoutSeconds: 600)
        let rendered = describeSendFailure(result)
        await expect(rendered.range(of: "[А-Яа-я]", options: .regularExpression) != nil, rendered)
        await expect(!rendered.contains(reason), "«\(rendered)» leaks the raw code")
    }
}

await test("no decoded model has a field that could hold a secret") {
    // The app asks the CLI rather than reading project.json, precisely so a token never
    // enters this process. The notify summary reports presence and mode only.
    let notify = try JSONDecoder().decode(NotifyStatus.self, from: Data(notifyJSON.utf8))
    await expect(notify.isConfigured)
    await expectEqual(notify.mode, "activity")

    let forbidden = ["token", "chatid", "secret", "password", "key", "credential"]
    for model in [Mirror(reflecting: notify), Mirror(reflecting: try JSONDecoder().decode(ProjectStatus.self, from: Data(healthyStatusJSON.utf8)))] {
        for child in model.children {
            let label = (child.label ?? "").lowercased()
            await expect(!forbidden.contains { label.contains($0) }, "field `\(label)` could hold a secret")
        }
    }

    // And the credential-adjacent fields are simply not part of the decoded shape.
    let raw = try JSONSerialization.jsonObject(with: Data(notifyJSON.utf8)) as? [String: Any]
    await expectNil(raw?["botToken"])
    await expectNil(raw?["chatId"])
}

await test("Telegram is reported as presence only") {
    for (state, expected) in [("configured", L.telegramOn), ("absent", L.telegramOff), ("invalid", L.telegramInvalid)] {
        let controller = await makeController(runner: FakeRunner { invocation in
            switch invocation.arguments.first {
            case "projects": return ok(projectsJSON)
            case "status": return ok(healthyStatusJSON)
            case "notify": return ok("{\"path\":\"/p\",\"state\":\"\(state)\",\"mode\":\"activity\"}")
            default: return ok("")
            }
        })
        await controller.refresh()
        await expectEqual(await controller.telegramLabel, expected)
        await expect(isRussian(expected), expected)
    }
}

await test("agent labels keep Murmur identifiers and translate only the surrounding words") {
    await expectEqual(L.agentLabel("claude"), "Claude")
    await expectEqual(L.agentLabel("codex"), "Codex")
    await expectEqual(L.agentLabel("cursor"), "Cursor")
    await expect(L.agentLabel("root").contains("Пользователь"))
    await expectEqual(L.agentLabel("codex-app-server"), "codex-app-server")
    await expectEqual(L.agentState(alive: true, childState: nil), "работает")
    await expectEqual(L.agentState(alive: false, childState: "not-started"), "не запущен")
}

await test("every menu string is Russian") {
    let menuStrings = [L.project, L.status, L.actions, L.projects, L.start, L.stop, L.sendTask,
                       L.check, L.openLogs, L.refresh, L.quit, L.details, L.running, L.stopped,
                       L.unhealthy, L.busy, L.unknown, L.starting, L.stopping, L.checking,
                       L.sending, L.telegramOn, L.telegramOff, L.noProjects, L.noProjectSelected,
                       L.send, L.cancel, L.result, L.close, L.copy, L.launchAtLogin]
    for value in menuStrings {
        await expect(isRussian(value), "«\(value)» must be Russian")
    }
    // The product name and the agent names are proper nouns and stay as they are.
    await expectEqual(L.appName, "Murmur")
    await expectEqual(L.nats, "NATS")
    await expectEqual(L.telegram, "Telegram")
}

exit(await finish())
