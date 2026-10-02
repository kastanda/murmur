import Foundation

// Decoded from the CLI's `--json` output. Every field here is one the CLI already
// redacts: `natsTokenConfigured` is a boolean, the notify summary reports presence and
// mode, and no profile secret is part of any of these shapes. Nothing in this file has a
// field that could hold a token, a key or a chat id — that is deliberate, and it is why
// the app asks the CLI instead of reading `project.json` itself.

// MARK: - projects

public struct ProjectSummary: Codable, Equatable, Identifiable, Sendable {
    public let projectId: String
    /// The project's own directory name — never the hashed profile directory.
    public let name: String
    public let projectPath: String?
    public let profileRoot: String
    public let logsDir: String
    public let valid: Bool
    public let reason: String?

    public var id: String { projectId }

    /// What `murmur <command> <project>` should be given. The canonical path is passed
    /// rather than the bare name so a project outside `~/Projects` still resolves.
    public var cliArgument: String { projectPath ?? projectId }

    public init(
        projectId: String, name: String, projectPath: String?, profileRoot: String,
        logsDir: String, valid: Bool, reason: String? = nil
    ) {
        self.projectId = projectId
        self.name = name
        self.projectPath = projectPath
        self.profileRoot = profileRoot
        self.logsDir = logsDir
        self.valid = valid
        self.reason = reason
    }
}

public struct ProjectsResponse: Codable, Equatable, Sendable {
    public let projects: [ProjectSummary]

    public init(projects: [ProjectSummary]) { self.projects = projects }
}

// MARK: - status

public struct SupervisorStatus: Codable, Equatable, Sendable {
    public let pid: Int?
    public let alive: Bool
    public let phase: String?

    public init(pid: Int?, alive: Bool, phase: String?) {
        self.pid = pid
        self.alive = alive
        self.phase = phase
    }
}

public struct CheckStatus: Codable, Equatable, Sendable {
    public let name: String?
    public let status: String
    public let detail: String?

    public var passed: Bool { status == "PASS" }

    public init(name: String?, status: String, detail: String?) {
        self.name = name
        self.status = status
        self.detail = detail
    }
}

public struct AgentStatus: Codable, Equatable, Identifiable, Sendable {
    public let name: String
    public let role: String?
    public let alive: Bool
    public let pid: Int?
    public let childState: String?
    public let memberSlot: String?

    public var id: String { name }

    public init(name: String, role: String?, alive: Bool, pid: Int?, childState: String?, memberSlot: String?) {
        self.name = name
        self.role = role
        self.alive = alive
        self.pid = pid
        self.childState = childState
        self.memberSlot = memberSlot
    }
}

public struct StatusTotals: Codable, Equatable, Sendable {
    public let openContinuations: Int
    public let activeDispatch: Int
    public let pendingDispatch: Int

    public init(openContinuations: Int, activeDispatch: Int, pendingDispatch: Int) {
        self.openContinuations = openContinuations
        self.activeDispatch = activeDispatch
        self.pendingDispatch = pendingDispatch
    }
}

public struct ProjectStatus: Codable, Equatable, Sendable {
    public let projectId: String?
    public let projectPath: String?
    public let supervisor: SupervisorStatus?
    public let nats: CheckStatus?
    public let agents: [AgentStatus]?
    public let totals: StatusTotals?
    public let healthy: Bool
    public let problems: [String]?

    public init(
        projectId: String? = nil, projectPath: String? = nil, supervisor: SupervisorStatus? = nil,
        nats: CheckStatus? = nil, agents: [AgentStatus]? = nil, totals: StatusTotals? = nil,
        healthy: Bool, problems: [String]? = nil
    ) {
        self.projectId = projectId
        self.projectPath = projectPath
        self.supervisor = supervisor
        self.nats = nats
        self.agents = agents
        self.totals = totals
        self.healthy = healthy
        self.problems = problems
    }
}

// MARK: - doctor

public struct DoctorReport: Codable, Equatable, Sendable {
    public let status: String
    public let checks: [CheckStatus]

    public init(status: String, checks: [CheckStatus]) {
        self.status = status
        self.checks = checks
    }
}

// MARK: - notify

public struct NotifyStatus: Codable, Equatable, Sendable {
    /// "configured" | "absent" | "invalid". Never the credential itself.
    public let state: String
    public let telegram: String?
    public let mode: String?

    public var isConfigured: Bool { state == "configured" }

    public init(state: String, telegram: String?, mode: String?) {
        self.state = state
        self.telegram = telegram
        self.mode = mode
    }
}

// MARK: - send

public struct SendResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let reason: String?
    public let detail: String?
    public let msgId: String?
    public let replyMsgId: String?
    /// The coordinator's exact correlated reply. Correlation is the CLI's job, not ours.
    public let text: String?
    public let timeoutSeconds: Int?

    public init(
        ok: Bool, reason: String?, detail: String?, msgId: String?,
        replyMsgId: String?, text: String?, timeoutSeconds: Int?
    ) {
        self.ok = ok
        self.reason = reason
        self.detail = detail
        self.msgId = msgId
        self.replyMsgId = replyMsgId
        self.text = text
        self.timeoutSeconds = timeoutSeconds
    }
}

// MARK: - claude model/effort

/// What the INSTALLED Claude CLI actually supports, discovered locally (no network —
/// see the JS-side `claude-capabilities.mjs`). `modelLabels`/`effortLabels` is a
/// value -> Russian-label map for EVERY selectable option (including `"inherit"`), so
/// this app never maintains its own copy of a label and can never drift from the one
/// place those labels are decided.
public struct ClaudeCapabilities: Codable, Equatable, Sendable {
    public let available: Bool
    public let modelSupported: Bool
    public let effortSupported: Bool
    public let supportedModels: [String]
    public let supportedEfforts: [String]
    public let modelLabels: [String: String]
    public let effortLabels: [String: String]

    public init(
        available: Bool, modelSupported: Bool, effortSupported: Bool,
        supportedModels: [String], supportedEfforts: [String],
        modelLabels: [String: String], effortLabels: [String: String]
    ) {
        self.available = available
        self.modelSupported = modelSupported
        self.effortSupported = effortSupported
        self.supportedModels = supportedModels
        self.supportedEfforts = supportedEfforts
        self.modelLabels = modelLabels
        self.effortLabels = effortLabels
    }

    /// The menu offers only a FIXED, simple subset (section 12: "keep the menu simple"),
    /// intersected with what the installed CLI actually supports, so an option is never
    /// shown that would just be rejected. `"inherit"` is appended last and unconditionally.
    public var modelMenuOptions: [String] { supportedModels + ["inherit"] }
    public var effortMenuOptions: [String] {
        ["low", "medium", "high"].filter(supportedEfforts.contains) + ["inherit"]
    }
}

/// The project's Claude model/effort preference: what was SELECTED, what is actually
/// RUNNING right now (nil when nothing is), and the resulting EFFECTIVE value — see
/// `operator/claude-config.mjs`'s `resolveClaudeConfig` for why these three can differ
/// and which one is truth at any moment.
public struct ClaudePreference: Codable, Equatable, Sendable {
    public let model: String
    public let modelLabel: String
    public let effort: String
    public let effortLabel: String
    public let runningModel: String?
    public let runningEffort: String?
    public let effectiveModel: String?
    public let effectiveModelLabel: String?
    public let effectiveEffort: String?
    public let effectiveEffortLabel: String?
    public let source: String
    public let effortSource: String
    public let pendingRestart: Bool
    public let configState: String
    public let configReason: String?

    public init(
        model: String, modelLabel: String, effort: String, effortLabel: String,
        runningModel: String?, runningEffort: String?,
        effectiveModel: String?, effectiveModelLabel: String?,
        effectiveEffort: String?, effectiveEffortLabel: String?,
        source: String, effortSource: String, pendingRestart: Bool,
        configState: String, configReason: String? = nil
    ) {
        self.model = model
        self.modelLabel = modelLabel
        self.effort = effort
        self.effortLabel = effortLabel
        self.runningModel = runningModel
        self.runningEffort = runningEffort
        self.effectiveModel = effectiveModel
        self.effectiveModelLabel = effectiveModelLabel
        self.effectiveEffort = effectiveEffort
        self.effectiveEffortLabel = effectiveEffortLabel
        self.source = source
        self.effortSource = effortSource
        self.pendingRestart = pendingRestart
        self.configState = configState
        self.configReason = configReason
    }
}

public struct ClaudeConfigReport: Codable, Equatable, Sendable {
    public let project: String
    public let capabilities: ClaudeCapabilities
    public let claude: ClaudePreference

    public init(project: String, capabilities: ClaudeCapabilities, claude: ClaudePreference) {
        self.project = project
        self.capabilities = capabilities
        self.claude = claude
    }
}

// MARK: - health

/// What the menu bar icon says at a glance.
public enum HealthState: Equatable, Sendable {
    case running
    case stopped
    case busy
    case unhealthy
    case unknown
}

/// Map a status document to the icon state.
///
/// `healthy: true` is the CLI's own verdict and is taken as-is. The interesting case is
/// `healthy: false`, which covers BOTH "deliberately stopped" and "started but broken" —
/// showing a red dot for a project the operator stopped on purpose would train them to
/// ignore red. So a project with no supervisor and no live agent is `stopped`; one with
/// something alive but not healthy is genuinely `unhealthy`.
public func healthState(for status: ProjectStatus?, busy: Bool = false) -> HealthState {
    if busy { return .busy }
    guard let status else { return .unknown }
    if status.healthy { return .running }
    let supervisorAlive = status.supervisor?.alive ?? false
    let anyAgentAlive = (status.agents ?? []).contains { $0.alive }
    return supervisorAlive || anyAgentAlive ? .unhealthy : .stopped
}
