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

// MARK: - model options (shared by Claude and Codex)

/// One entry of an agent's model picker, exactly as `murmur <agent> <project> config --json`
/// reports it. The CLI decides `label`, `resolvesToLabel`, `kind` and `selectable` — this app
/// never parses a model id or derives a version, it only renders.
///
/// `kind`: `alias` (a moving "latest in tier" name — "Актуальный Sonnet"), `pinned` (one
/// concrete version), `catalog` (a concrete id from the agent's own catalog), `inherit`.
public struct ModelOption: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let resolvesToLabel: String?
    public let canonicalId: String?
    public let selectable: Bool
    public let disabledReason: String?

    public init(
        id: String, kind: String, label: String, resolvesToLabel: String? = nil,
        canonicalId: String? = nil, selectable: Bool = true, disabledReason: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.resolvesToLabel = resolvesToLabel
        self.canonicalId = canonicalId
        self.selectable = selectable
        self.disabledReason = disabledReason
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, label, resolvesToLabel, canonicalId, selectable, disabledReason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        label = try c.decode(String.self, forKey: .label)
        resolvesToLabel = try c.decodeIfPresent(String.self, forKey: .resolvesToLabel)
        canonicalId = try c.decodeIfPresent(String.self, forKey: .canonicalId)
        selectable = try c.decodeIfPresent(Bool.self, forKey: .selectable) ?? true
        disabledReason = try c.decodeIfPresent(String.self, forKey: .disabledReason)
    }
}

/// An effort/reasoning choice the CLI says the menu may offer.
public struct EffortOption: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// A resolved model selection (selected / running / effective) from the CLI's single label
/// resolver. `label` names the SELECTION ("Актуальный Sonnet", "Sonnet 5"); `effectiveLabel`
/// names the concrete model it runs as ("Sonnet 5.5").
public struct ModelView: Codable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let label: String
    public let canonicalId: String?
    public let resolvesToLabel: String?
    public let effectiveLabel: String?

    public init(
        id: String, kind: String, label: String, canonicalId: String? = nil,
        resolvesToLabel: String? = nil, effectiveLabel: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.canonicalId = canonicalId
        self.resolvesToLabel = resolvesToLabel
        self.effectiveLabel = effectiveLabel
    }
}

// MARK: - claude model/effort

/// What the INSTALLED Claude CLI actually supports, discovered locally (see the JS-side
/// `claude-capabilities.mjs`). Kept for compatibility and diagnostics; the picker itself is
/// `ClaudePreference.models`.
public struct ClaudeCapabilities: Codable, Equatable, Sendable {
    public let available: Bool
    public let modelSupported: Bool
    public let effortSupported: Bool
    public let supportedModels: [String]
    public let supportedEfforts: [String]
    public let modelLabels: [String: String]
    public let effortLabels: [String: String]
    public let catalogSource: String?

    public init(
        available: Bool, modelSupported: Bool, effortSupported: Bool,
        supportedModels: [String], supportedEfforts: [String],
        modelLabels: [String: String], effortLabels: [String: String], catalogSource: String? = nil
    ) {
        self.available = available
        self.modelSupported = modelSupported
        self.effortSupported = effortSupported
        self.supportedModels = supportedModels
        self.supportedEfforts = supportedEfforts
        self.modelLabels = modelLabels
        self.effortLabels = effortLabels
        self.catalogSource = catalogSource
    }
}

/// The project's Claude model/effort preference: what was SELECTED, what is actually
/// RUNNING right now (nil when nothing is), and the resulting EFFECTIVE value — see
/// `operator/claude-config.mjs`'s `resolveClaudeConfig`. All labels come from the CLI.
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
    /// The canonical model id the effective selection runs as (e.g. "claude-sonnet-5-5").
    public let canonicalModel: String?
    public let selected: ModelView?
    public let running: ModelView?
    public let effective: ModelView?
    /// The complete picker, ordered: aliases, pinned versions, inherit.
    public let models: [ModelOption]
    public let effortOptions: [EffortOption]

    public init(
        model: String, modelLabel: String, effort: String, effortLabel: String,
        runningModel: String?, runningEffort: String?,
        effectiveModel: String?, effectiveModelLabel: String?,
        effectiveEffort: String?, effectiveEffortLabel: String?,
        source: String, effortSource: String, pendingRestart: Bool,
        configState: String, configReason: String? = nil, canonicalModel: String? = nil,
        selected: ModelView? = nil, running: ModelView? = nil, effective: ModelView? = nil,
        models: [ModelOption] = [], effortOptions: [EffortOption] = []
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
        self.canonicalModel = canonicalModel
        self.selected = selected
        self.running = running
        self.effective = effective
        self.models = models
        self.effortOptions = effortOptions
    }

    private enum CodingKeys: String, CodingKey {
        case model, modelLabel, effort, effortLabel, runningModel, runningEffort
        case effectiveModel, effectiveModelLabel, effectiveEffort, effectiveEffortLabel
        case source, effortSource, pendingRestart, configState, configReason, canonicalModel
        case selected, running, effective, models, effortOptions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try c.decode(String.self, forKey: .model)
        modelLabel = try c.decode(String.self, forKey: .modelLabel)
        effort = try c.decode(String.self, forKey: .effort)
        effortLabel = try c.decode(String.self, forKey: .effortLabel)
        runningModel = try c.decodeIfPresent(String.self, forKey: .runningModel)
        runningEffort = try c.decodeIfPresent(String.self, forKey: .runningEffort)
        effectiveModel = try c.decodeIfPresent(String.self, forKey: .effectiveModel)
        effectiveModelLabel = try c.decodeIfPresent(String.self, forKey: .effectiveModelLabel)
        effectiveEffort = try c.decodeIfPresent(String.self, forKey: .effectiveEffort)
        effectiveEffortLabel = try c.decodeIfPresent(String.self, forKey: .effectiveEffortLabel)
        source = try c.decode(String.self, forKey: .source)
        effortSource = try c.decode(String.self, forKey: .effortSource)
        pendingRestart = try c.decode(Bool.self, forKey: .pendingRestart)
        configState = try c.decode(String.self, forKey: .configState)
        configReason = try c.decodeIfPresent(String.self, forKey: .configReason)
        canonicalModel = try c.decodeIfPresent(String.self, forKey: .canonicalModel)
        selected = try c.decodeIfPresent(ModelView.self, forKey: .selected)
        running = try c.decodeIfPresent(ModelView.self, forKey: .running)
        effective = try c.decodeIfPresent(ModelView.self, forKey: .effective)
        models = try c.decodeIfPresent([ModelOption].self, forKey: .models) ?? []
        effortOptions = try c.decodeIfPresent([EffortOption].self, forKey: .effortOptions) ?? []
    }
}

// MARK: - codex model/effort (project-scoped; see `operator/codex-config.mjs`)

/// The project's Codex model/reasoning preference. `controllable` must be checked before a
/// client builds any selector: when the App Server's catalog cannot be read there is
/// nothing truthful to select, and only the (possibly unknown) effective model is shown.
public struct CodexPreference: Codable, Equatable, Sendable {
    public let controllable: Bool
    public let reason: String?
    public let selectedModel: String
    public let selectedModelLabel: String
    public let reasoningEffort: String
    public let reasoningEffortLabel: String
    public let effectiveModel: String?
    public let effectiveModelLabel: String?
    public let effectiveReasoningEffort: String?
    public let effectiveReasoningEffortLabel: String?
    public let availableModels: [ModelOption]
    public let effortOptions: [EffortOption]
    public let source: String
    public let pendingRestart: Bool
    public let pendingNextTurn: Bool
    public let requiresNewThread: Bool
    public let configState: String

    public init(
        controllable: Bool, reason: String? = nil,
        selectedModel: String, selectedModelLabel: String,
        reasoningEffort: String, reasoningEffortLabel: String,
        effectiveModel: String? = nil, effectiveModelLabel: String? = nil,
        effectiveReasoningEffort: String? = nil, effectiveReasoningEffortLabel: String? = nil,
        availableModels: [ModelOption] = [], effortOptions: [EffortOption] = [],
        source: String = "codex-config", pendingRestart: Bool = false,
        pendingNextTurn: Bool = false, requiresNewThread: Bool = false, configState: String = "absent"
    ) {
        self.controllable = controllable
        self.reason = reason
        self.selectedModel = selectedModel
        self.selectedModelLabel = selectedModelLabel
        self.reasoningEffort = reasoningEffort
        self.reasoningEffortLabel = reasoningEffortLabel
        self.effectiveModel = effectiveModel
        self.effectiveModelLabel = effectiveModelLabel
        self.effectiveReasoningEffort = effectiveReasoningEffort
        self.effectiveReasoningEffortLabel = effectiveReasoningEffortLabel
        self.availableModels = availableModels
        self.effortOptions = effortOptions
        self.source = source
        self.pendingRestart = pendingRestart
        self.pendingNextTurn = pendingNextTurn
        self.requiresNewThread = requiresNewThread
        self.configState = configState
    }
}

public struct CodexConfigReport: Codable, Equatable, Sendable {
    public let project: String
    public let codex: CodexPreference

    public init(project: String, codex: CodexPreference) {
        self.project = project
        self.codex = codex
    }
}

// MARK: - cursor model (read-only, non-controllable — see `operator/cursor-config.mjs`)

/// The truthful, read-only picture of Cursor's model: Murmur has no selection of its own
/// (`selectedModel`/`supportedModels` are honestly empty — see the JS module header for
/// why there is deliberately no writer), and `effectiveModel`/`effectiveModelLabel` are
/// read straight from Cursor's own global config. `controllable` must be checked before
/// a client ever considers building a selector; it is always `false` in this slice.
public struct CursorModelInfo: Codable, Equatable, Sendable {
    public let controllable: Bool
    public let reason: String?
    public let selectedModel: String?
    public let selectedModelLabel: String?
    public let effectiveModel: String?
    public let effectiveModelLabel: String?
    public let source: String?
    public let supportedModels: [String]
    public let requiresRestart: Bool
    public let requiresNewSession: Bool

    public init(
        controllable: Bool, reason: String?, selectedModel: String?, selectedModelLabel: String?,
        effectiveModel: String?, effectiveModelLabel: String?, source: String?,
        supportedModels: [String], requiresRestart: Bool, requiresNewSession: Bool
    ) {
        self.controllable = controllable
        self.reason = reason
        self.selectedModel = selectedModel
        self.selectedModelLabel = selectedModelLabel
        self.effectiveModel = effectiveModel
        self.effectiveModelLabel = effectiveModelLabel
        self.source = source
        self.supportedModels = supportedModels
        self.requiresRestart = requiresRestart
        self.requiresNewSession = requiresNewSession
    }
}

public struct CursorConfigReport: Codable, Equatable, Sendable {
    public let project: String
    public let cursor: CursorModelInfo

    public init(project: String, cursor: CursorModelInfo) {
        self.project = project
        self.cursor = cursor
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
