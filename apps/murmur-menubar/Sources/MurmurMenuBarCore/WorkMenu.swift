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
        default:
            let parts = [task.currentAgent.map(agent), task.currentStage, time].compactMap { $0 }
            line = parts.joined(separator: " · ")
        }
        let chain = chainLine(task.chain)
        return TaskRow(workflowId: task.workflowId, title: task.requestSummary, detailLine: line,
                       chainLine: task.chain.count > 1 ? chain : nil)
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
            let dot = (stale || expired || usage.kind != "subscription_usage") ? "" : "\(dot(level(remaining: window.remainingPercent))) "
            if expired {
                lines.append("\(window.label): \(L.usageStale)")
                continue
            }
            lines.append("\(window.label): \(dot)\(remainingText(window))")
            if let reset = resetText(window, now: now, timeZone: timeZone) { lines.append("  \(reset)") }
        }
        return lines
    }

    /// Passive pre-send warnings: a fresh SUBSCRIPTION window under 10%. Never blocks, never
    /// switches a model — the operator may always send anyway.
    public static func lowLimitWarnings(_ report: UsageReport?) -> [String] {
        guard let report else { return [] }
        var lines: [String] = []
        for (name, usage) in report.orderedProviders {
            guard usage.available, usage.kind == "subscription_usage", usage.stale != true else { continue }
            for window in usage.windows ?? [] where window.expired != true && window.remainingPercent < 10 {
                lines.append("\(agent(name)): \(L.lowLimitPrefix) \(Int(window.remainingPercent.rounded()))% \(L.lowLimitSuffix)")
            }
        }
        return lines
    }
}
