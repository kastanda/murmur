import Foundation

/// Everything the active-work and limits UI SHOWS, as pure functions of the CLI's JSON — so the
/// menu, the detail window and the tests can never tell different stories. No model id or
/// quota number is derived here: percentages and reset instants come from the provider via
/// the Murmur CLI; this only formats them.
public enum WorkMenu {
    // MARK: status

    public static func statusLabel(_ status: String, stalled: Bool = false) -> String {
        switch status {
        case "queued": return L.taskQueued
        case "running": return L.taskRunning
        case "waiting": return stalled ? L.taskWaitingStalled : L.taskWaiting
        case "waiting_for_provider": return L.taskWaitingProvider
        case "blocked_by_provider_quota": return L.taskBlockedProvider
        case "cancel_requested": return L.taskCancelRequested
        case "cancelled": return L.taskCancelled
        case "completed": return L.taskCompleted
        case "failed": return L.taskFailed
        default: return L.unknown
        }
    }

    // MARK: durations

    /// `42с`, `2м 14с`, `1ч 07м` — computed at render time from a durable timestamp; never persisted.
    public static func elapsed(_ ms: Double?) -> String {
        guard let ms, ms.isFinite, ms >= 0 else { return "—" }
        let seconds = Int(ms / 1000)
        if seconds < 60 { return "\(seconds)с" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)м \(String(format: "%02d", seconds % 60))с" }
        return "\(minutes / 60)ч \(String(format: "%02d", minutes % 60))м"
    }

    /// Elapsed since `submittedAt` on THIS clock (so it keeps ticking between polls), falling back
    /// to the CLI's own `elapsedMs` for a finished task or an unparsable timestamp.
    public static func elapsed(for task: WorkTask, now: Date = Date()) -> String {
        let finished = ["completed", "failed", "cancelled"].contains(task.status)
        if !finished, let submitted = parseISO(task.submittedAt) { return elapsed(now.timeIntervalSince(submitted) * 1000) }
        return elapsed(task.elapsedMs)
    }

    public static func parseISO(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return fractional.date(from: value) ?? plain.date(from: value)
    }

    // MARK: agents / chain

    public static func agent(_ name: String) -> String {
        name == "root" ? L.userRole : L.agentLabel(name)
    }

    /// `Claude → Codex` for the chain's hops (the user hop is shown as «Пользователь»).
    public static func chainText(_ chain: [ChainLink]) -> String {
        chain.map { "\(agent($0.from)) → \(agent($0.to))" }.joined(separator: "\n")
    }

    /// The compact single-line chain used in the submenu: the agents in order, once each.
    public static func chainLine(_ chain: [ChainLink]) -> String {
        var names: [String] = []
        for link in chain {
            if names.isEmpty { names.append(agent(link.from)) }
            names.append(agent(link.to))
        }
        // `Пользователь → Claude → Codex` collapses to the working agents.
        return names.filter { $0 != L.userRole }.joined(separator: " → ")
    }

    // MARK: root-menu summary

    public static func activeSummary(_ summary: WorkSummary) -> String {
        summary.active == 0 ? "\(L.activeTasks): \(L.none)" : "\(L.activeTasks): \(summary.active)"
    }

    public static func queuedSummary(_ summary: WorkSummary) -> String? {
        summary.queued > 0 ? "\(L.queuedTasks): \(summary.queued)" : nil
    }

    // MARK: task rows (submenu)

    public struct TaskRow: Equatable, Sendable {
        public let workflowId: String
        public let title: String
        public let detailLine: String
        public let chainLine: String?
    }

    /// `Исправить provisioning` / `Codex · Review · 2м 14с` / `Claude → Codex`. A queued task reads
    /// `В очереди · 12с`; a cancel in flight reads `Отмена запрошена`.
    public static func row(_ task: WorkTask, now: Date = Date()) -> TaskRow {
        let time = elapsed(for: task, now: now)
        let line: String
        switch task.status {
        case "queued": line = "\(L.taskQueued) · \(time)"
        case "cancel_requested": line = "\(L.taskCancelRequested) · \(time)"
        case "waiting_for_provider", "blocked_by_provider_quota":
            // Nothing is executing: no agent is named as active. The CLI's stage already reads
            // «Ожидает лимита Codex» / «Заблокировано: лимит Codex исчерпан»; the reset follows.
            let stage = task.currentStage ?? statusLabel(task.status)
            let mandatory = task.providerWait?.mandatory == true ? L.mandatoryReviewWaiting : nil
            var parts = [mandatory.map { "\($0) \(agent(task.providerWait?.provider ?? ""))" } ?? stage]
            if let reset = providerWaitReset(task.providerWait, now: now) { parts.append(reset) }
            parts.append(time)
            line = parts.joined(separator: " · ")
        default:
            let parts = [task.currentAgent.map(agent), task.currentStage, time].compactMap { $0 }
            line = parts.joined(separator: " · ")
        }
        let chain = chainLine(task.chain)
        return TaskRow(workflowId: task.workflowId, title: task.requestSummary, detailLine: line,
                       chainLine: task.chain.count > 1 ? chain : nil)
    }

    /// `Сброс через 41м` for a wait whose provider reset is authoritative; `nil` otherwise.
    public static func providerWaitReset(_ wait: ProviderWait?, now: Date = Date()) -> String? {
        guard let wait else { return nil }
        if let resets = parseISO(wait.resetsAt) {
            let seconds = resets.timeIntervalSince(now)
            if seconds <= 0 { return nil }
            let minutes = Int(seconds / 60)
            let text = minutes >= 60 ? "\(minutes / 60)ч \(String(format: "%02d", minutes % 60))м" : "\(max(minutes, 1))м"
            return "\(L.reset) через \(text)"
        }
        return nil
    }

    // MARK: usage

    public enum UsageLevel: Equatable, Sendable { case green, yellow, red }

    /// Colour is secondary and exists only for a MEANINGFUL remaining percentage: >25 green,
    /// 10–25 yellow, <10 red. The text is always rendered as well.
    public static func level(remaining: Double) -> UsageLevel {
        remaining > 25 ? .green : (remaining >= 10 ? .yellow : .red)
    }

    public static func dot(_ level: UsageLevel) -> String {
        switch level {
        case .green: return "🟢"
        case .yellow: return "🟡"
        case .red: return "🔴"
        }
    }

    /// `Сброс через 2ч 18м` within a day, else an absolute local date `Сброс 7 октября, 21:00`.
    /// `nil` when the provider gave no reset (it is then simply omitted — never invented).
    public static func resetText(_ window: UsageWindow, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        guard let resets = parseISO(window.resetsAt) else { return nil }
        let seconds = resets.timeIntervalSince(now)
        if seconds <= 0 { return nil }
        if seconds < 24 * 3600 {
            let minutes = Int(seconds / 60)
            let text = minutes >= 60 ? "\(minutes / 60)ч \(String(format: "%02d", minutes % 60))м" : "\(max(minutes, 1))м"
            return "\(L.resetsIn) \(text)"
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.timeZone = timeZone
        formatter.dateFormat = "d MMMM, HH:mm"
        return "\(L.reset) \(formatter.string(from: resets))"
    }

    public static func remainingText(_ window: UsageWindow) -> String {
        let value = window.remainingPercent.rounded()
        return "\(Int(value))% \(L.remainingSuffix)"
    }

    /// One provider's lines for the limits submenu/window. Only subscription usage is presented
    /// as the account limit; anything else is labelled for what it is. Stale data is said to be
    /// stale and drops the colour; an unavailable provider says so — never a number.
    public static func usageLines(name: String, usage: ProviderUsage, now: Date = Date(), timeZone: TimeZone = .current) -> [String] {
        let title = agent(name)
        // An authoritatively exhausted provider: text first, colour only as an accent. The router never
        // substitutes another agent; the coordinator's own exhaustion makes NEW tasks wait for the reset.
        if usage.availability == "exhausted" || usage.routing?.eligible == false {
            let resets = usage.routing?.resetsAt ?? usage.windows?.compactMap { $0.resetsAt }.max()
            return [
                title,
                "🔴 \(L.usageExhausted)",
                name == "claude" ? L.usageCoordinatorWaits : L.usageExcluded,
                resumeText(resetsAt: resets, now: now, timeZone: timeZone) ?? L.usageResetUnknown,
            ]
        }
        guard usage.available, let windows = usage.windows, !windows.isEmpty else {
            return [title, L.usageUnavailable]
        }
        var lines = [title]
        if usage.kind != "subscription_usage" {
            lines.append(usage.kind == "api_rate_limit" ? L.usageApiRateLimit : L.usageKindUnknown)
        }
        let stale = usage.stale == true
        if stale { lines.append(L.usageStale) }
        for window in windows {
            let expired = window.expired == true
            // With routing availability, red is reserved for EXHAUSTED: a low-but-routable window is yellow.
            var shade = level(remaining: window.remainingPercent)
            if usage.availability != nil, shade == .red, window.remainingPercent > 0 { shade = .yellow }
            let dot = (stale || expired || usage.kind != "subscription_usage") ? "" : "\(dot(shade)) "
            if expired {
                lines.append("\(window.label): \(L.usageStale)")
                continue
            }
            lines.append("\(window.label): \(dot)\(remainingText(window))")
            if let reset = resetText(window, now: now, timeZone: timeZone) { lines.append("  \(reset)") }
        }
        // Degraded = low but still routable: a warning, never an exclusion.
        if usage.availability == "degraded", !stale { lines.append(L.lowLimitTitle) }
        return lines
    }

    /// `Возобновление после 03:00` (today/tomorrow within a day) or `… после 7 октября, 03:00`.
    public static func resumeText(resetsAt: String?, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        guard let resets = parseISO(resetsAt), resets.timeIntervalSince(now) > 0 else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.timeZone = timeZone
        formatter.dateFormat = resets.timeIntervalSince(now) < 24 * 3600 ? "HH:mm" : "d MMMM, HH:mm"
        return "\(L.usageResumesAfter) \(formatter.string(from: resets))"
    }

    /// Shown instead of sending when the coordinator (Claude) is authoritatively exhausted. The task is
    /// NOT queued and nothing is rerouted to another agent: the operator re-sends after the reset.
    public static func providerUnavailableMessage(provider: String, resetsAt: String?, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        let who = agent(provider)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.timeZone = timeZone
        if let resets = parseISO(resetsAt), resets.timeIntervalSince(now) > 0 {
            formatter.dateFormat = resets.timeIntervalSince(now) < 24 * 3600 ? "HH:mm" : "d MMMM, HH:mm"
            return "\(who) недоступен до \(formatter.string(from: resets)).\nЗадача не отправлена и не передана другому агенту — повторите после сброса."
        }
        return "\(who) недоступен: лимит исчерпан, время сброса неизвестно.\nЗадача не отправлена и не передана другому агенту."
    }

    /// The pre-send block for the coordinator, from the last usage report (nil = nothing known to block on).
    public static func sendBlock(_ report: UsageReport?, coordinator: String = "claude", now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        guard let usage = report?.providers[coordinator], usage.availability == "exhausted" || usage.routing?.eligible == false else { return nil }
        // A reset that has already passed means the report is out of date: let the CLI re-evaluate.
        if let resets = parseISO(usage.routing?.resetsAt), resets <= now { return nil }
        return providerUnavailableMessage(provider: coordinator, resetsAt: usage.routing?.resetsAt, now: now, timeZone: timeZone)
    }

    /// Providers that were exhausted in `previous` and are routable again in `current` (automatic recovery).
    public static func recoveredProviders(previous: UsageReport?, current: UsageReport?) -> [String] {
        guard let previous, let current else { return [] }
        return ["claude", "codex", "cursor"].filter { name in
            let was = previous.providers[name]
            let now = current.providers[name]
            return (was?.availability == "exhausted" || was?.routing?.eligible == false)
                && now != nil && now?.availability != "exhausted" && now?.routing?.eligible != false
        }.map { "\(agent($0)) \(L.providerRecovered)" }
    }

    /// Passive pre-send warnings: a fresh SUBSCRIPTION window under 10%. Never blocks, never
    /// switches a model — the operator may always send anyway.
    public static func lowLimitWarnings(_ report: UsageReport?) -> [String] {
        guard let report else { return [] }
        var lines: [String] = []
        for (name, usage) in report.orderedProviders {
            guard usage.available, usage.kind == "subscription_usage", usage.stale != true,
                  usage.availability != "exhausted" else { continue }
            for window in usage.windows ?? [] where window.expired != true && window.remainingPercent < 10 {
                lines.append("\(agent(name)): \(L.lowLimitPrefix) \(Int(window.remainingPercent.rounded()))% \(L.lowLimitSuffix)")
            }
        }
        return lines
    }
}
