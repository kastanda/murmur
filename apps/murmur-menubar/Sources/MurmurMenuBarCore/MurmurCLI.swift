import Foundation

/// One finished CLI invocation.
public struct CommandOutcome: Equatable, Sendable {
    public let exitCode: Int32
    public let stdout: String
    public let stderr: String

    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }
}

/// Exactly what would be executed. Kept as a value so tests can assert the argv without
/// running anything.
public struct CommandInvocation: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]

    public init(executable: String, arguments: [String]) {
        self.executable = executable
        self.arguments = arguments
    }
}

public enum MurmurCLIError: Error, Equatable, Sendable {
    case notInstalled
    case launchFailed(String)
    case timedOut(seconds: Int)
    case malformedOutput(String)
    case commandFailed(exitCode: Int32, message: String)
}

/// One bit, shared between the watchdog and the caller.
final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func fire() { lock.withLock { value = true } }
    var fired: Bool { lock.withLock { value } }
}

/// Lets exactly one of several racing callers proceed. Used to resume a continuation once.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.withLock {
            if done { return false }
            done = true
            return true
        }
    }
}

/// Runs one invocation. Injected so every test runs against a fake.
public protocol CommandRunner: Sendable {
    func run(_ invocation: CommandInvocation, timeout: TimeInterval) async throws -> CommandOutcome
}

/// The real runner.
///
/// `Process` with `executableURL` + `arguments` is an `execve`: the argument vector is
/// passed to the program directly and is never parsed by anything. There is no
/// `/bin/sh -c`, no string concatenation and no quoting to get wrong — which is what
/// makes a multi-line task containing quotes, backticks or `$(...)` ordinary data rather
/// than a command-injection question.
public struct ProcessCommandRunner: CommandRunner {
    private let searchPath: String

    public init(searchPath: String) {
        self.searchPath = searchPath
    }

    public func run(_ invocation: CommandInvocation, timeout: TimeInterval) async throws -> CommandOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: invocation.executable)
        process.arguments = invocation.arguments

        // The CLI is a Node script with a `#!/usr/bin/env node` shebang, so the CHILD has
        // to be able to find `node`. A GUI process's own PATH cannot be relied on for
        // that; see `childSearchPath`.
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = searchPath
        process.environment = environment

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            throw MurmurCLIError.launchFailed(error.localizedDescription)
        }

        // CLOSE THE PARENT'S OWN COPY of each write end, immediately after the fork.
        //
        // A `Pipe` holds both ends, and assigning it to `standardOutput` gives the child a
        // duplicate — it does not close ours. While this process still holds a writer, the
        // read end never reaches EOF, so `readToEnd()` blocks forever even though the
        // child has already exited and nothing will ever write again. That is a hang with
        // no timeout attached to it, because the wait already succeeded.
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()

        // Drain both pipes concurrently with waiting. A command that writes more than a
        // pipe buffer (a full `doctor --json`) would otherwise block on write while we
        // block on exit.
        async let outData = readToEnd(outPipe)
        async let errData = readToEnd(errPipe)

        // The watchdog terminates the child rather than just reporting elapsed time:
        // killing it is what closes its descriptors, which is what lets the reads above
        // finish. Reporting a timeout while leaving the process running would strand them.
        let timedOut = TimeoutFlag()
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard !Task.isCancelled, process.isRunning else { return }
            timedOut.fire()
            process.terminate()
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }

        await waitForExit(process)
        watchdog.cancel()

        let stdout = String(data: await outData, encoding: .utf8) ?? ""
        let stderr = String(data: await errData, encoding: .utf8) ?? ""
        if timedOut.fired { throw MurmurCLIError.timedOut(seconds: Int(timeout)) }
        return CommandOutcome(exitCode: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    private func readToEnd(_ pipe: Pipe) async -> Data {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let data = (try? pipe.fileHandleForReading.readToEnd()) ?? Data()
                continuation.resume(returning: data)
            }
        }
    }

    /// Wait for the child WITHOUT `waitUntilExit()`.
    ///
    /// `waitUntilExit()` services a run loop on the calling thread. A GCD worker thread
    /// has no run loop being serviced, so it can spin there forever on a child that has
    /// already exited and been reaped — observed in practice as a command that never
    /// returns, with no child process left to point at. `terminationHandler` is
    /// callback-driven and needs no run loop.
    private func waitForExit(_ process: Process) async {
        let once = Once()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in
                if once.claim() { continuation.resume() }
            }
            // The handler is never called for a process that terminated BEFORE it was
            // installed, so close that race explicitly.
            if !process.isRunning, once.claim() { continuation.resume() }
        }
    }
}

/// Builds the exact argv for each command, and decodes the JSON back.
///
/// This app implements NO Murmur lifecycle of its own: it starts nothing, stops nothing,
/// signals nothing and touches no database. Every operation below is the same command an
/// operator would type, so the CLI stays the single authority on what "running" means and
/// on how a task is correlated.
public struct MurmurCLI: Sendable {
    public let executable: String
    private let runner: CommandRunner

    public init(executable: String, runner: CommandRunner) {
        self.executable = executable
        self.runner = runner
    }

    // MARK: argv construction — pure, so tests can assert it without running anything

    public func statusInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["status", project, "--json"])
    }

    public func startInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["start", project])
    }

    public func stopInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["stop", project])
    }

    public func doctorInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["doctor", project, "--json"])
    }

    public func projectsInvocation() -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["projects", "--json"])
    }

    public func notifyStatusInvocation() -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["notify", "status", "--json"])
    }

    /// The task is ONE argument. It is never concatenated into a command string, so a
    /// multi-line task, or one containing quotes or shell metacharacters, is data.
    public func sendInvocation(project: String, task: String, timeoutSeconds: Int) -> CommandInvocation {
        CommandInvocation(
            executable: executable,
            arguments: ["send", project, task, "--json", "--timeout", String(timeoutSeconds)]
        )
    }

    public func claudeConfigInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["claude", project, "config", "--json"])
    }

    /// `value` is whatever `claudeConfig(project:)` already reported as a supported
    /// option (see `ClaudeCapabilities.modelMenuOptions`/`effortMenuOptions`) — the CLI
    /// re-validates it independently regardless, so a stale or hand-typed value is still
    /// refused rather than ever reaching Claude's own argv unchecked.
    public func setClaudeModelInvocation(project: String, value: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["claude", project, "model", value])
    }

    public func setClaudeEffortInvocation(project: String, value: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["claude", project, "effort", value])
    }

    public func codexConfigInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["codex", project, "config", "--json"])
    }

    /// `value` is an id the CLI itself reported in `availableModels`; the CLI re-validates it
    /// against the Codex App Server's catalog regardless. Direct argv only.
    public func setCodexModelInvocation(project: String, value: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["codex", project, "model", value])
    }

    public func setCodexEffortInvocation(project: String, value: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["codex", project, "effort", value])
    }

    public func tasksInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["tasks", project, "--json"])
    }

    public func taskInvocation(project: String, workflowId: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["task", project, workflowId, "--json"])
    }

    /// Cancels ONE workflow. The id is passed as a single argv entry (the CLI validates it again);
    /// there is no project-wide stop here.
    public func cancelInvocation(project: String, workflowId: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["cancel", project, workflowId, "--json"])
    }

    public func usageInvocation(project: String, refresh: Bool) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["usage", project, "--json"] + (refresh ? ["--refresh"] : []))
    }

    /// Read-only — there is deliberately no `setCursorModelInvocation`. See
    /// `cursor-config.mjs`'s header: Cursor's own model selection is real but ACCOUNT-
    /// GLOBAL, not project-scoped, so this app only ever displays it.
    public func cursorConfigInvocation(project: String) -> CommandInvocation {
        CommandInvocation(executable: executable, arguments: ["cursor", project, "config", "--json"])
    }

    // MARK: execution

    public func status(project: String) async throws -> ProjectStatus {
        // `status` exits 3 for an unhealthy project. That is a correct answer, not a
        // failure, so the JSON is decoded whatever the exit code.
        try await decode(ProjectStatus.self, from: statusInvocation(project: project), timeout: 20, allowNonZeroExit: true)
    }

    public func doctor(project: String) async throws -> DoctorReport {
        try await decode(DoctorReport.self, from: doctorInvocation(project: project), timeout: 60, allowNonZeroExit: true)
    }

    public func projects() async throws -> [ProjectSummary] {
        try await decode(ProjectsResponse.self, from: projectsInvocation(), timeout: 20, allowNonZeroExit: false).projects
    }

    public func notifyStatus() async throws -> NotifyStatus {
        // Exit 3 means "not configured", which this decodes rather than throws on.
        try await decode(NotifyStatus.self, from: notifyStatusInvocation(), timeout: 20, allowNonZeroExit: true)
    }

    public func claudeConfig(project: String) async throws -> ClaudeConfigReport {
        try await decode(ClaudeConfigReport.self, from: claudeConfigInvocation(project: project), timeout: 30, allowNonZeroExit: true)
    }

    public func tasks(project: String) async throws -> WorkSnapshot {
        try await decode(WorkSnapshot.self, from: tasksInvocation(project: project), timeout: 20, allowNonZeroExit: true)
    }

    public func taskDetail(project: String, workflowId: String) async throws -> WorkTaskDetail {
        try await decode(TaskDetailReport.self, from: taskInvocation(project: project, workflowId: workflowId), timeout: 20, allowNonZeroExit: false).task
    }

    /// `cancel` exits 2 (unknown) / 4 (already finished) / 1 (invalid) WITH a JSON body — each is an
    /// answer to render, so the JSON is decoded whatever the exit code.
    public func cancel(project: String, workflowId: String) async throws -> CancelResult {
        try await decode(CancelResult.self, from: cancelInvocation(project: project, workflowId: workflowId), timeout: 30, allowNonZeroExit: true)
    }

    /// May contact a provider (through its own CLI/App Server) when its cache is stale or
    /// `refresh` is set — hence the longer timeout and the slow cadence the controller uses.
    public func usage(project: String, refresh: Bool = false) async throws -> UsageReport {
        try await decode(UsageReport.self, from: usageInvocation(project: project, refresh: refresh), timeout: 60, allowNonZeroExit: true)
    }

    /// A project with no Codex identity exits 3 with no JSON on stdout — callers treat a
    /// thrown error as "no Codex rows to show".
    public func codexConfig(project: String) async throws -> CodexConfigReport {
        try await decode(CodexConfigReport.self, from: codexConfigInvocation(project: project), timeout: 30, allowNonZeroExit: true)
    }

    public func setCodexModel(project: String, value: String) async throws {
        try await runLifecycle(setCodexModelInvocation(project: project, value: value), timeout: 30)
    }

    public func setCodexEffort(project: String, value: String) async throws {
        try await runLifecycle(setCodexEffortInvocation(project: project, value: value), timeout: 30)
    }

    /// A project with no Cursor identity exits 3 with no JSON on stdout — callers treat
    /// a thrown error here as "no Cursor section to show", exactly like an absent
    /// `claudeConfig` would.
    public func cursorConfig(project: String) async throws -> CursorConfigReport {
        try await decode(CursorConfigReport.self, from: cursorConfigInvocation(project: project), timeout: 20, allowNonZeroExit: true)
    }

    /// Writes THROUGH the CLI, exactly like every other preference change in this app;
    /// never edits `claude-preferences.json` directly. A rejected value (unsupported by
    /// the installed CLI) surfaces as `MurmurCLIError.commandFailed` with the CLI's own
    /// one-line reason — see `commandClaude`'s `err(...)` calls on the JS side.
    public func setClaudeModel(project: String, value: String) async throws {
        try await runLifecycle(setClaudeModelInvocation(project: project, value: value), timeout: 20)
    }

    public func setClaudeEffort(project: String, value: String) async throws {
        try await runLifecycle(setClaudeEffortInvocation(project: project, value: value), timeout: 20)
    }

    public func send(project: String, task: String, timeoutSeconds: Int) async throws -> SendResult {
        try await decode(
            SendResult.self,
            from: sendInvocation(project: project, task: task, timeoutSeconds: timeoutSeconds),
            // Outlive the CLI's own wait, so a timeout is reported by the CLI (which knows
            // the msgId it gave up on) rather than by us killing it halfway.
            timeout: TimeInterval(timeoutSeconds + 30),
            allowNonZeroExit: true
        )
    }

    /// `start` / `stop` print a human transcript and have no `--json`; the authoritative
    /// answer is the status poll that follows, so only success/failure is taken from here.
    public func start(project: String) async throws {
        try await runLifecycle(startInvocation(project: project), timeout: 300)
    }

    public func stop(project: String) async throws {
        try await runLifecycle(stopInvocation(project: project), timeout: 180)
    }

    private func runLifecycle(_ invocation: CommandInvocation, timeout: TimeInterval) async throws {
        let outcome = try await runner.run(invocation, timeout: timeout)
        guard outcome.exitCode == 0 else {
            throw MurmurCLIError.commandFailed(exitCode: outcome.exitCode, message: firstMeaningfulLine(outcome))
        }
    }

    private func decode<T: Decodable>(
        _ type: T.Type,
        from invocation: CommandInvocation,
        timeout: TimeInterval,
        allowNonZeroExit: Bool
    ) async throws -> T {
        let outcome = try await runner.run(invocation, timeout: timeout)
        if !allowNonZeroExit, outcome.exitCode != 0 {
            throw MurmurCLIError.commandFailed(exitCode: outcome.exitCode, message: firstMeaningfulLine(outcome))
        }
        guard let data = jsonPayload(outcome.stdout) else {
            // An empty or non-JSON stdout on a non-zero exit is a real command failure;
            // report THAT rather than a confusing parse error.
            if outcome.exitCode != 0 {
                throw MurmurCLIError.commandFailed(exitCode: outcome.exitCode, message: firstMeaningfulLine(outcome))
            }
            throw MurmurCLIError.malformedOutput(String(outcome.stdout.prefix(200)))
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw MurmurCLIError.malformedOutput(String(outcome.stdout.prefix(200)))
        }
    }
}

/// The JSON object in a command's stdout.
///
/// Node prints an experimental-SQLite warning on stderr, and some commands emit a line
/// before the document, so the payload is taken from the first `{` — without ever
/// evaluating or executing what came before it.
func jsonPayload(_ stdout: String) -> Data? {
    guard let start = stdout.firstIndex(of: "{") else { return nil }
    return String(stdout[start...]).data(using: .utf8)
}

/// One short line for a human, from whatever the command said.
func firstMeaningfulLine(_ outcome: CommandOutcome) -> String {
    let candidates = (outcome.stderr + "\n" + outcome.stdout)
        .split(separator: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty && !$0.contains("ExperimentalWarning") && !$0.contains("--trace-warnings") }
    return String((candidates.first ?? "").prefix(200))
}
