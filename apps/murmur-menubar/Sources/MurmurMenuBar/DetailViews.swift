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
                    if let cursor = controller.cursorConfig?.cursor {
                        // Read-only, same as `cursorSection` in the main menu — no
                        // selected/effective split to show, since Murmur has no
                        // selection of its own for an account-global setting.
                        row(L.cursor, cursor.effectiveModelLabel ?? L.cursorByCursorSettings)
                    }
                }
                if controller.claudeConfig?.claude.pendingRestart == true {
                    Text(L.claudePendingRestart).font(.callout).foregroundStyle(.orange)
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
    }

    private func submit() {
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
