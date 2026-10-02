import AppKit
import SwiftUI
import MurmurMenuBarCore

/// The menu itself. Deliberately compact: a menu bar item a person opens twenty times a
/// day should answer "is it up?" in one glance, with everything else one click away.
struct MenuContent: View {
    @ObservedObject var controller: MurmurController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            header
            Divider()
            actions
            Divider()
            projectsSection
            Divider()
            Button(L.refresh) { Task { await controller.refresh() } }
            Button(L.quit) { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .task {
            controller.startPolling()
        }
    }

    // MARK: header

    @ViewBuilder private var header: some View {
        if controller.cliLocation.path == nil {
            Text(L.cliMissingTitle)
            Button(L.details) { openWindow(id: WindowID.status) }
        } else {
            Text("\(L.project): \(controller.selectedProject?.name ?? L.noProjectSelected)")
            Text("\(L.status): \(statusLine)")
            if let error = controller.lastError {
                Text(error)
            }
            Button(L.details) { openWindow(id: WindowID.status) }
        }
    }

    /// The one-line summary. While a lifecycle command runs it says which one, because
    /// "выполняется…" on its own does not tell an operator whether their click landed.
    private var statusLine: String {
        switch controller.operation {
        case .starting: return L.starting
        case .stopping: return L.stopping
        case .checking: return L.checking
        case .sending: return L.sending
        case .settingClaudeModel: return L.settingClaudeModel
        case .settingClaudeEffort: return L.settingClaudeEffort
        case nil: return L.healthLabel(controller.health)
        }
    }

    // MARK: actions

    @ViewBuilder private var actions: some View {
        Button("▶ \(L.start)") { controller.start() }
            .disabled(!controller.canStart)
        Button("■ \(L.stop)") { controller.stop() }
            .disabled(!controller.canStop)
        Button("✉ \(L.sendTask)") { openWindow(id: WindowID.send) }
            .disabled(!controller.canSend)
        Button("✓ \(L.check)") {
            controller.runDoctor()
            openWindow(id: WindowID.doctor)
        }
        .disabled(controller.isBusy || controller.selectedProject == nil)
        logsMenu
        claudeSection
        Text("\(L.telegram): \(controller.telegramLabel)")
    }

    // MARK: Claude model/effort

    /// A compact summary line plus two submenus — never taller than the rest of the menu.
    /// Each submenu offers only what `ClaudeCapabilities` says the installed CLI actually
    /// supports (see `modelMenuOptions`/`effortMenuOptions`); an option this build cannot
    /// honour is never shown rather than being shown and then rejected.
    @ViewBuilder private var claudeSection: some View {
        if let config = controller.claudeConfig {
            Text("\(L.claude): \(config.claude.modelLabel) · \(config.claude.effortLabel)")
            if config.claude.pendingRestart {
                Text("\(L.claudeCurrently): \(config.claude.effectiveModelLabel ?? L.unknown)")
                Text(L.claudePendingRestart)
            }
            if config.capabilities.modelSupported {
                Menu(L.claudeModelMenu) {
                    ForEach(config.capabilities.modelMenuOptions, id: \.self) { value in
                        Button(menuLabel(value, in: config.capabilities.modelLabels, selected: value == config.claude.model)) {
                            controller.setClaudeModel(value)
                        }
                    }
                }
                .disabled(controller.isBusy)
            } else {
                Text(L.claudeModelUnsupported)
            }
            if config.capabilities.effortSupported {
                Menu(L.claudeEffortMenu) {
                    ForEach(config.capabilities.effortMenuOptions, id: \.self) { value in
                        Button(menuLabel(value, in: config.capabilities.effortLabels, selected: value == config.claude.effort)) {
                            controller.setClaudeEffort(value)
                        }
                    }
                }
                .disabled(controller.isBusy)
            } else {
                Text(L.claudeEffortUnsupported)
            }
        }
    }

    /// `✓ Sonnet` for the selected option, `  Sonnet` otherwise — the task's own example
    /// glyph, consistent with how the project picker marks its current selection.
    private func menuLabel(_ value: String, in labels: [String: String], selected: Bool) -> String {
        let label = labels[value] ?? value
        return selected ? "✓ \(label)" : "  \(label)"
    }

    /// Finder for the directory, plus a per-agent shortcut. Opening a log in the system's
    /// default viewer is a one-liner; building a log viewer is a project, and Console.app
    /// is already better at it.
    @ViewBuilder private var logsMenu: some View {
        if let logsDir = controller.selectedProject?.logsDir {
            Menu("📋 \(L.openLogs)") {
                Button("Finder") { NSWorkspace.shared.open(URL(fileURLWithPath: logsDir)) }
                Divider()
                ForEach(["supervisor", "root", "claude", "codex", "cursor", "codex-app-server"], id: \.self) { name in
                    Button(L.agentLabel(name)) {
                        NSWorkspace.shared.open(URL(fileURLWithPath: "\(logsDir)/\(name).log"))
                    }
                }
            }
        }
    }

    // MARK: projects

    @ViewBuilder private var projectsSection: some View {
        if controller.projects.isEmpty {
            Text(L.noProjects)
        } else {
            Menu(L.projects) {
                ForEach(controller.projects) { project in
                    Button {
                        controller.selectProject(project.projectId)
                    } label: {
                        // The project's own directory name, never the hashed profile id.
                        Text(project.projectId == controller.selectedProject?.projectId
                             ? "● \(project.name)"
                             : "  \(project.name)")
                    }
                    .disabled(!project.valid)
                }
            }
        }
    }
}

enum WindowID {
    static let status = "murmur-status"
    static let send = "murmur-send"
    static let doctor = "murmur-doctor"
}
