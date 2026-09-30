import Foundation

/// Persisted preference. The ONLY thing this app stores is which project was last
/// selected, plus an optional CLI path — no credential, no project data, no cached status.
public protocol PreferenceStore: AnyObject, Sendable {
    func string(forKey key: String) -> String?
    func set(_ value: String?, forKey key: String)
}

public final class UserDefaultsPreferenceStore: PreferenceStore, @unchecked Sendable {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public func string(forKey key: String) -> String? { defaults.string(forKey: key) }
    public func set(_ value: String?, forKey key: String) { defaults.set(value, forKey: key) }
}

public enum PreferenceKey {
    public static let selectedProject = "murmur.selectedProjectId"
    public static let cliPath = "murmur.cliPath"
}

/// The result of submitting one task: either the coordinator's exact correlated reply, or
/// one Russian sentence explaining why there is none.
public enum SendOutcome: Equatable, Sendable {
    case reply(String)
    case failed(String)
}

/// A lifecycle command in flight. Used to disable the buttons that must not overlap.
public enum LifecycleOperation: String, Equatable, Sendable {
    case starting
    case stopping
    case checking
    case sending
}

/// Everything the views render.
@MainActor
public final class MurmurController: ObservableObject {
    @Published public private(set) var projects: [ProjectSummary] = []
    @Published public private(set) var selectedProjectId: String?
    @Published public private(set) var status: ProjectStatus?
    @Published public private(set) var notify: NotifyStatus?
    @Published public private(set) var doctor: DoctorReport?
    @Published public private(set) var operation: LifecycleOperation?
    @Published public private(set) var lastError: String?
    @Published public private(set) var cliLocation: CLILocation = .missing

    private let locator: CLILocator
    private let preferences: PreferenceStore
    private let makeCLI: (String) -> MurmurCLI
    private var pollTask: Task<Void, Never>?

    /// How often status is refreshed. Five seconds is responsive enough for a start to
    /// feel immediate, and light enough that an idle menu bar app is not a background
    /// process spawning a Node CLI several times a second.
    public let pollInterval: TimeInterval

    public init(
        locator: CLILocator = CLILocator(),
        preferences: PreferenceStore = UserDefaultsPreferenceStore(),
        pollInterval: TimeInterval = 5,
        makeCLI: ((String) -> MurmurCLI)? = nil
    ) {
        self.locator = locator
        self.preferences = preferences
        self.pollInterval = pollInterval
        self.makeCLI = makeCLI ?? { path in
            MurmurCLI(executable: path, runner: ProcessCommandRunner(searchPath: childSearchPath(cliPath: path)))
        }
        self.selectedProjectId = preferences.string(forKey: PreferenceKey.selectedProject)
        self.cliLocation = locator.locate(configuredPath: preferences.string(forKey: PreferenceKey.cliPath))
    }

    // MARK: derived state

    public var selectedProject: ProjectSummary? {
        projects.first { $0.projectId == selectedProjectId } ?? projects.first
    }

    public var health: HealthState {
        healthState(for: status, busy: operation != nil)
    }

    /// One lifecycle command at a time. A second click while a start is in flight would
    /// race the first for the project's launch guard and produce a confusing refusal from
    /// the CLI, so the UI simply does not allow it.
    public var isBusy: Bool { operation != nil }

    public var canStart: Bool {
        !isBusy && selectedProject != nil && cliLocation.path != nil && health != .running
    }

    public var canStop: Bool {
        !isBusy && selectedProject != nil && cliLocation.path != nil && health != .stopped
    }

    public var canSend: Bool {
        !isBusy && selectedProject != nil && cliLocation.path != nil
    }

    public var telegramLabel: String {
        guard let notify else { return L.unknown }
        switch notify.state {
        case "configured": return L.telegramOn
        case "invalid": return L.telegramInvalid
        default: return L.telegramOff
        }
    }

    // MARK: lifecycle

    public func start() { perform(.starting) { cli, project in try await cli.start(project: project) } }

    public func stop() { perform(.stopping) { cli, project in try await cli.stop(project: project) } }

    public func runDoctor() {
        perform(.checking) { [weak self] cli, project in
            let report = try await cli.doctor(project: project)
            await MainActor.run { self?.doctor = report }
        }
    }

    /// Submit one root task and wait for the CLI's correlated reply.
    ///
    /// Correlation is NOT reimplemented here: the CLI enqueues the task, waits for the
    /// exact `replyToMessageId` from the expected coordinator on the expected
    /// conversation, and hands back the result. This only renders it.
    public func send(task: String, timeoutSeconds: Int = 600) async -> SendOutcome {
        guard let cli = currentCLI(), let project = selectedProject?.cliArgument else {
            return .failed(L.cliMissingTitle)
        }
        guard !isBusy else { return .failed(L.busy) }
        operation = .sending
        defer { operation = nil }
        do {
            let result = try await cli.send(project: project, task: task, timeoutSeconds: timeoutSeconds)
            await refresh()
            if result.ok, let text = result.text { return .reply(text) }
            return .failed(describeSendFailure(result))
        } catch {
            return .failed(describeFailure(error))
        }
    }

    public func selectProject(_ projectId: String) {
        guard projectId != selectedProjectId else { return }
        selectedProjectId = projectId
        preferences.set(projectId, forKey: PreferenceKey.selectedProject)
        // The previous project's status says nothing about this one.
        status = nil
        doctor = nil
        Task { await refresh() }
    }

    // MARK: polling

    public func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                guard let interval = self?.pollInterval else { return }
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Re-read everything the menu shows. Never runs a lifecycle command.
    public func refresh() async {
        cliLocation = locator.locate(configuredPath: preferences.string(forKey: PreferenceKey.cliPath))
        guard let cli = currentCLI() else { return }

        if let loaded = try? await cli.projects() {
            projects = loaded
            if selectedProjectId == nil || !loaded.contains(where: { $0.projectId == selectedProjectId }) {
                selectedProjectId = loaded.first?.projectId
            }
        }
        notify = try? await cli.notifyStatus()

        guard let project = selectedProject?.cliArgument else {
            status = nil
            return
        }
        do {
            status = try await cli.status(project: project)
            // A refresh that succeeded clears a stale failure banner; one that failed
            // leaves the previous status visible rather than blanking the menu.
            if operation == nil { lastError = nil }
        } catch {
            lastError = describeFailure(error)
        }
    }

    // MARK: internals

    private func currentCLI() -> MurmurCLI? {
        guard let path = cliLocation.path else { return nil }
        return makeCLI(path)
    }

    private func perform(
        _ kind: LifecycleOperation,
        _ body: @escaping (MurmurCLI, String) async throws -> Void
    ) {
        guard !isBusy else { return }
        guard let cli = currentCLI(), let project = selectedProject?.cliArgument else {
            lastError = L.cliMissingTitle
            return
        }
        operation = kind
        lastError = nil
        Task { [weak self] in
            do {
                try await body(cli, project)
            } catch {
                await MainActor.run { self?.lastError = describeFailure(error) }
            }
            await MainActor.run { self?.operation = nil }
            await self?.refresh()
        }
    }
}
