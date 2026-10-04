import Foundation

// MARK: - active work (`murmur tasks|task|cancel --json`)

/// One link of a task's chain, e.g. Claude → Codex. `from`/`to` are agent names as the CLI reports them.
public struct ChainLink: Codable, Equatable, Sendable, Hashable {
    public let from: String
    public let to: String
    public let state: String?

    public init(from: String, to: String, state: String? = nil) {
        self.from = from
        self.to = to
        self.state = state
    }
}

/// Why a task waits for a provider's quota (`waiting_for_provider` / `blocked_by_provider_quota`).
/// `resetsAt`/`resetsInMs` are present only when the provider's reset is authoritative.
public struct ProviderWait: Codable, Equatable, Sendable {
    public let provider: String
    public let state: String?
    public let firstObservedAt: String?
    public let resetsAt: String?
    public let resetsInMs: Double?
    public let intendedRecipient: String?
    public let mandatory: Bool?

    public init(provider: String, state: String? = nil, firstObservedAt: String? = nil, resetsAt: String? = nil,
                resetsInMs: Double? = nil, intendedRecipient: String? = nil, mandatory: Bool? = nil) {
        self.provider = provider
        self.state = state
        self.firstObservedAt = firstObservedAt
        self.resetsAt = resetsAt
        self.resetsInMs = resetsInMs
        self.intendedRecipient = intendedRecipient
        self.mandatory = mandatory
    }
}

/// One operator task: ONE root request with every descendant handoff folded in. `workflowId` is
/// the root message id — the same id the message graph carries, never a GUI-only identifier.
public struct WorkTask: Codable, Equatable, Sendable, Identifiable {
    public var id: String { workflowId }
    public let workflowId: String
    public let status: String
    public let stalled: Bool
    public let submittedAt: String?
    public let startedAt: String?
    public let elapsedMs: Double?
    public let requestSummary: String
    public let currentAgent: String?
    public let currentStage: String?
    public let chain: [ChainLink]
    public let lastActivityAt: String?
    public let lastActivity: String?
    public let cancellable: Bool
    public let providerWait: ProviderWait?

    public init(
        workflowId: String, status: String, stalled: Bool = false, submittedAt: String? = nil,
        startedAt: String? = nil, elapsedMs: Double? = nil, requestSummary: String,
        currentAgent: String? = nil, currentStage: String? = nil, chain: [ChainLink] = [],
        lastActivityAt: String? = nil, lastActivity: String? = nil, cancellable: Bool = false,
        providerWait: ProviderWait? = nil
    ) {
        self.providerWait = providerWait
        self.workflowId = workflowId
        self.status = status
        self.stalled = stalled
        self.submittedAt = submittedAt
        self.startedAt = startedAt
        self.elapsedMs = elapsedMs
        self.requestSummary = requestSummary
        self.currentAgent = currentAgent
        self.currentStage = currentStage
        self.chain = chain
        self.lastActivityAt = lastActivityAt
        self.lastActivity = lastActivity
        self.cancellable = cancellable
    }
}

public struct WorkSummary: Codable, Equatable, Sendable {
    public let active: Int
    public let queued: Int
    public let running: Int
    public let waiting: Int
    public let cancelRequested: Int
    public let waitingForProvider: Int

    public init(active: Int, queued: Int, running: Int = 0, waiting: Int = 0, cancelRequested: Int = 0, waitingForProvider: Int = 0) {
        self.waitingForProvider = waitingForProvider
        self.active = active
        self.queued = queued
        self.running = running
        self.waiting = waiting
        self.cancelRequested = cancelRequested
    }

    private enum CodingKeys: String, CodingKey { case active, queued, running, waiting, cancelRequested, waitingForProvider }

    /// Only `active` and `queued` drive the root menu; the breakdown is optional detail.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = try c.decode(Int.self, forKey: .active)
        queued = try c.decode(Int.self, forKey: .queued)
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? 0
        waiting = try c.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        cancelRequested = try c.decodeIfPresent(Int.self, forKey: .cancelRequested) ?? 0
        waitingForProvider = try c.decodeIfPresent(Int.self, forKey: .waitingForProvider) ?? 0
    }
}

public struct WorkSnapshot: Codable, Equatable, Sendable {
    public let project: String
    public let observedAt: String?
    public let summary: WorkSummary
    public let tasks: [WorkTask]
    public let recent: [WorkTask]

    public init(project: String, observedAt: String? = nil, summary: WorkSummary, tasks: [WorkTask], recent: [WorkTask] = []) {
        self.project = project
        self.observedAt = observedAt
        self.summary = summary
        self.tasks = tasks
        self.recent = recent
    }
}

/// `murmur task <project> <id> --json`: the task plus its bounded, redacted request and result.
public struct WorkTaskDetail: Codable, Equatable, Sendable {
    public let task: WorkTask
    public let request: String
    public let result: String?

    public init(task: WorkTask, request: String, result: String?) {
        self.task = task
        self.request = request
        self.result = result
    }

    private enum CodingKeys: String, CodingKey { case request, result }

    public init(from decoder: Decoder) throws {
        task = try WorkTask(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        request = try c.decode(String.self, forKey: .request)
        result = try c.decodeIfPresent(String.self, forKey: .result)
    }

    public func encode(to encoder: Encoder) throws {
        try task.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(request, forKey: .request)
        try c.encodeIfPresent(result, forKey: .result)
    }
}

public struct TaskDetailReport: Codable, Equatable, Sendable {
    public let project: String
    public let task: WorkTaskDetail
}

/// The outcome of `murmur cancel`. `ok == false` carries a stable `reason` (unknown-workflow,
/// already-terminal, workflow-id-invalid, cancel-not-recorded).
public struct CancelResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let workflowId: String?
    public let status: String?
    public let reason: String?
    public let alreadyRequested: Bool?
    public let systemResult: String?

    public init(ok: Bool, workflowId: String? = nil, status: String? = nil, reason: String? = nil,
                alreadyRequested: Bool? = nil, systemResult: String? = nil) {
        self.ok = ok
        self.workflowId = workflowId
        self.status = status
        self.reason = reason
        self.alreadyRequested = alreadyRequested
        self.systemResult = systemResult
    }
}

// MARK: - provider usage (`murmur usage --json`)

public struct UsageWindow: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let usedPercent: Double
    public let remainingPercent: Double
    public let resetsAt: String?
    public let resetsInMs: Double?
    public let expired: Bool?
    public let windowMinutes: Double?

    public init(id: String, label: String, usedPercent: Double, remainingPercent: Double,
                resetsAt: String? = nil, resetsInMs: Double? = nil, expired: Bool? = nil, windowMinutes: Double? = nil) {
        self.id = id
        self.label = label
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.resetsInMs = resetsInMs
        self.expired = expired
        self.windowMinutes = windowMinutes
    }
}

/// The routing verdict `murmur usage --json` attaches to each provider. Only an authoritatively
/// exhausted provider is `eligible == false`; unknown, stale and degraded providers stay routable.
public struct RoutingInfo: Codable, Equatable, Sendable {
    public let eligible: Bool
    public let reason: String?
    public let source: String?
    public let resetsAt: String?
    public let pendingRefresh: Bool?
    public let apiRateLimit: Bool?
    public let waitReason: String?

    public init(eligible: Bool, reason: String? = nil, source: String? = nil, resetsAt: String? = nil,
                pendingRefresh: Bool? = nil, apiRateLimit: Bool? = nil, waitReason: String? = nil) {
        self.eligible = eligible
        self.reason = reason
        self.source = source
        self.resetsAt = resetsAt
        self.pendingRefresh = pendingRefresh
        self.apiRateLimit = apiRateLimit
        self.waitReason = waitReason
    }
}

/// What ONE provider reports. `kind` keeps account/subscription usage apart from API rate limits
/// (and anything else): only `subscription_usage` is ever presented as the account's limit.
public struct ProviderUsage: Codable, Equatable, Sendable {
    public let available: Bool
    public let reason: String?
    public let kind: String?
    public let plan: String?
    public let observedAt: String?
    public let stale: Bool?
    public let windows: [UsageWindow]?
    public let limitReached: String?
    /// `available` | `degraded` | `exhausted` | `unknown` — absent from an older CLI.
    public let availability: String?
    public let routing: RoutingInfo?

    public init(available: Bool, reason: String? = nil, kind: String? = nil, plan: String? = nil,
                observedAt: String? = nil, stale: Bool? = nil, windows: [UsageWindow]? = nil, limitReached: String? = nil,
                availability: String? = nil, routing: RoutingInfo? = nil) {
        self.availability = availability
        self.routing = routing
        self.available = available
        self.reason = reason
        self.kind = kind
        self.plan = plan
        self.observedAt = observedAt
        self.stale = stale
        self.windows = windows
        self.limitReached = limitReached
    }
}

public struct UsageReport: Codable, Equatable, Sendable {
    public let project: String
    public let observedAt: String?
    public let providers: [String: ProviderUsage]

    public init(project: String, observedAt: String? = nil, providers: [String: ProviderUsage]) {
        self.project = project
        self.observedAt = observedAt
        self.providers = providers
    }

    /// Display order: the agents Murmur orchestrates, in their usual order.
    public var orderedProviders: [(name: String, usage: ProviderUsage)] {
        ["claude", "codex", "cursor"].compactMap { name in providers[name].map { (name, $0) } }
    }
}
