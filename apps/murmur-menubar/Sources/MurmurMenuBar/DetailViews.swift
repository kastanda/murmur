import AppKit
import SwiftUI
import MurmurMenuBarCore

/// The detailed status the main menu deliberately leaves out.
struct StatusWindow: View {
    @ObservedObject var controller: MurmurController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if controller.cliLocation.path == nil {
                Text(L.cliMissingTitle).font(.headline)
                Text(L.cliMissingHint).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("\(L.project): \(controller.selectedProject?.name ?? L.noProjectSelected)")
                    .font(.headline)
                if let path = controller.selectedProject?.projectPath {
                    Text(path).font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    row(L.status, L.healthLabel(controller.health))
                    row(L.supervisor, supervisorLine)
                    row(L.nats, controller.status?.nats?.passed == true ? "OK" : (controller.status?.nats?.detail ?? L.unknown))
                    ForEach(controller.status?.agents ?? []) { agent in
                        row(L.agentLabel(agent.name), L.agentState(alive: agent.alive, childState: agent.childState))
                    }
                    row(L.openContinuations, "\(controller.status?.totals?.openContinuations ?? 0)")
                    row(L.dispatches, "активных \(controller.status?.totals?.activeDispatch ?? 0), в очереди \(controller.status?.totals?.pendingDispatch ?? 0)")
                    row(L.telegram, controller.telegramLabel)
                    if let claude = controller.claudeConfig?.claude {
                        row(L.claudeSelected, "\(claude.modelLabel) · \(claude.effortLabel)")
                        row(L.claudeEffective, "\(claude.effectiveModelLabel ?? L.unknown) · \(claude.effectiveEffortLabel ?? L.unknown)")
                    }
                    if let codex = controller.codexConfig?.codex {
                        if codex.controllable {
                            row("\(L.codex): \(L.modelSelected.lowercased())", "\(codex.selectedModelLabel) · \(codex.reasoningEffortLabel)")
                        }
                        row("\(L.codex): \(L.claudeEffective.lowercased())", "\(codex.effectiveModelLabel ?? L.unknown) · \(codex.effectiveReasoningEffortLabel ?? L.unknown)")
                    }
                    if let cursor = controller.cursorConfig?.cursor {
                        // Read-only, same as `cursorSection` in the main menu — no
                        // selected/effective split to show, since Murmur has no
                        // selection of its own for an account-global setting.
                        row(L.cursor, cursor.effectiveModelLabel ?? L.cursorByCursorSettings)
                    }
                }
                if let claude = controller.claudeConfig?.claude, claude.pendingRestart {
                    ForEach(ModelMenu.claudePendingLines(claude), id: \.self) { Text($0).font(.callout).foregroundStyle(.orange) }
                }
                if let codex = controller.codexConfig?.codex {
                    ForEach(ModelMenu.codexPendingLines(codex), id: \.self) { Text($0).font(.callout).foregroundStyle(.orange) }
                }
                if let problems = controller.status?.problems, !problems.isEmpty {
                    Divider()
                    ForEach(problems, id: \.self) { Text($0).font(.callout).foregroundStyle(.red) }
                }
            }
            Spacer()
            HStack {
                Button(L.refresh) { Task { await controller.refresh() } }
                Spacer()
            }
        }
        .padding(20)
        .frame(minWidth: 420, minHeight: 360)
    }

    private var supervisorLine: String {
        guard let supervisor = controller.status?.supervisor else { return L.unknown }
        guard supervisor.alive else { return "не запущен" }
        return supervisor.pid.map { "работает (pid \($0))" } ?? "работает"
    }

    @ViewBuilder private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
        }
    }
}

/// `murmur doctor <project> --json`, rendered.
struct DoctorWindow: View {
    @ObservedObject var controller: MurmurController

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(L.check): \(controller.selectedProject?.name ?? "")").font(.headline)
            if controller.operation == .checking {
                ProgressView(L.checking)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(controller.doctor?.checks ?? [], id: \.name) { check in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(mark(check.status)).foregroundStyle(colour(check.status))
                            Text(check.name ?? "—").frame(width: 190, alignment: .leading)
                            Text(check.detail ?? "").font(.callout).foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Button(L.check) { controller.runDoctor() }.disabled(controller.isBusy)
                Spacer()
            }
        }
        .padding(20)
        .frame(minWidth: 620, minHeight: 420)
    }

    private func mark(_ status: String) -> String {
        switch status {
        case "PASS": return "✓"
        case "WARN": return "!"
        default: return "✕"
        }
    }

    private func colour(_ status: String) -> Color {
        switch status {
        case "PASS": return .green
        case "WARN": return .orange
        default: return .red
        }
    }
}

/// Submit one root task and show the coordinator's correlated reply.
struct SendTaskWindow: View {
    @ObservedObject var controller: MurmurController
    @State private var task = ""
    @State private var result: String?
    @State private var failure: String?
    @State private var sending = false
    @State private var lowLimitConfirm = false
    @State private var providerBlock: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(L.project): \(controller.selectedProject?.name ?? L.noProjectSelected)").font(.headline)

            // Multi-line on purpose: a real task is a paragraph, and it reaches the CLI as
            // ONE argv entry — never a command string — so newlines and quotes are data.
            TextEditor(text: $task)
                .font(.body)
                .frame(minHeight: 120)
                .overlay(alignment: .topLeading) {
                    if task.isEmpty {
                        Text(L.taskPlaceholder).foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
                .border(.separator)
                .disabled(sending)

            HStack {
                Button(L.send) { submit() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(sending || task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !controller.canSend)
                if sending { ProgressView().controlSize(.small); Text(L.sending).foregroundStyle(.secondary) }
                Spacer()
            }

            if let failure {
                Text(failure).foregroundStyle(.red).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let result {
                Divider()
                Text(L.result).font(.headline)
                ScrollView {
                    Text(result).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                Button(L.copy) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(result, forType: .string)
                }
            }
            Spacer()
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 420)
        .alert(L.usageExhausted, isPresented: Binding(get: { providerBlock != nil }, set: { if !$0 { providerBlock = nil } })) {
            Button(L.close, role: .cancel) {}
        } message: {
            Text(providerBlock ?? "")
        }
        .confirmationDialog(L.lowLimitTitle, isPresented: $lowLimitConfirm, titleVisibility: .visible) {
            Button(L.sendAnyway) { performSend() }
            Button(L.cancel, role: .cancel) {}
        } message: {
            Text(controller.lowLimitWarnings.joined(separator: "\n"))
        }
    }

    /// A low provider limit is a PASSIVE warning: sending is never blocked, only confirmed.
    private func submit() {
        // An authoritatively exhausted coordinator cannot take a new task: say so instead of sending.
        if let block = controller.sendBlock { providerBlock = block; return }
        if !controller.lowLimitWarnings.isEmpty { lowLimitConfirm = true } else { performSend() }
    }

    private func performSend() {
        let text = task
        sending = true
        result = nil
        failure = nil
        Task {
            switch await controller.send(task: text) {
            case let .reply(text): result = text
            case let .failed(message): failure = message
            }
            sending = false
        }
    }
}


/// One task, in words. No protocol metadata by default: status, who is working, the stage, the
/// bounded request, the chain, the last activity, and — when finished — the correlated result.
struct TaskDetailWindow: View {
    @ObservedObject var controller: MurmurController
    let workflowId: String
    @State private var detail: WorkTaskDetail?
    @State private var confirmCancel = false
    @State private var notice: String?

    private static let logAgents: Set<String> = ["claude", "codex", "cursor", "root"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let task = detail?.task {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                    row(L.taskStatus, controller.cancellingTasks.contains(workflowId)
                        ? L.taskCancelling : WorkMenu.statusLabel(task.status, stalled: task.stalled))
                    row(L.project, controller.selectedProject?.name ?? L.unknown)
                    row(L.taskSubmitted, WorkMenu.parseISO(task.submittedAt)
                        .map { $0.formatted(date: .abbreviated, time: .standard) } ?? L.unknown)
                    row(L.taskElapsed, WorkMenu.elapsed(for: task))
                    if let agent = task.currentAgent { row(L.taskCurrentAgent, WorkMenu.agent(agent)) }
                    if let stage = task.currentStage { row(L.taskCurrentStage, stage) }
                }
                Divider()
                Text(L.taskRequest).font(.headline)
                Text(detail?.request ?? "").textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !task.chain.isEmpty {
                    Text(L.taskChain).font(.headline)
                    Text(WorkMenu.chainText(task.chain)).textSelection(.enabled)
                }
                if let last = task.lastActivity {
                    Text(L.taskLastActivity).font(.headline)
                    Text(last)
                }
                if let result = detail?.result {
                    Divider()
                    Text(L.taskResult).font(.headline)
                    ScrollView { Text(result).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 160)
                }
                if let notice { Text(notice).foregroundStyle(.orange) }
                HStack {
                    Button(L.taskOpenLogs) { openLogs(agent: task.currentAgent) }
                    Spacer()
                    Button(L.taskCancel, role: .destructive) { confirmCancel = true }
                        .disabled(!task.cancellable || controller.cancellingTasks.contains(workflowId))
                }
            } else {
                ProgressView()
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(minWidth: 480, minHeight: 360)
        // Cancelling stops ONLY this task — the dialog says so, and the button is not "Остановить".
        .confirmationDialog(L.cancelConfirmTitle, isPresented: $confirmCancel, titleVisibility: .visible) {
            Button(L.taskCancel, role: .destructive) { cancel() }
            Button(L.cancelConfirmKeep, role: .cancel) {}
        } message: {
            Text(L.cancelConfirmMessage)
        }
        .task(id: workflowId) {
            while !Task.isCancelled {
                detail = await controller.taskDetail(workflowId) ?? detail
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    private func cancel() {
        Task {
            switch await controller.cancelTask(workflowId) {
            case let .accepted(status): notice = status == "cancelled" ? L.cancelledBySystem : L.taskCancelRequested
            case .alreadyFinished: notice = L.cancelAlreadyFinished
            case .unknown: notice = L.cancelUnknown
            case let .failed(message): notice = message
            }
            detail = await controller.taskDetail(workflowId) ?? detail
        }
    }

    private func openLogs(agent: String?) {
        guard let logsDir = controller.selectedProject?.logsDir else { return }
        if let agent, Self.logAgents.contains(agent) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "\(logsDir)/\(agent).log"))
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: logsDir))
        }
    }

    @ViewBuilder private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
        }
    }
}
