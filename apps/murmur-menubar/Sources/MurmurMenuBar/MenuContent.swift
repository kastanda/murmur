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
            // Active work, compact: the count of ROOT tasks (a Claude→Codex→Cursor chain is one),
            // and queued work only when there is some. The list itself lives in the submenu.
            if let work = controller.workSnapshot {
                Text(WorkMenu.activeSummary(work.summary))
                if let queued = WorkMenu.queuedSummary(work.summary) { Text(queued) }
            }
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
        case .settingCodexModel: return L.settingCodexModel
        case .settingCodexEffort: return L.settingCodexEffort
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
        codexSection
        cursorSection
        Text("\(L.telegram): \(controller.telegramLabel)")
        limitsMenu
        activeTasksMenu
    }

    // MARK: active tasks (compact submenu; clicking a task opens its detail window)

    @ViewBuilder private var activeTasksMenu: some View {
        if let work = controller.workSnapshot {
            Menu(L.activeTasks) {
                if work.tasks.isEmpty { Text(L.noActiveTasks) }
                ForEach(work.tasks) { task in
                    let row = WorkMenu.row(task)
                    Button(row.title) { openWindow(id: WindowID.task, value: task.workflowId) }
                    Text("   \(row.detailLine)")
                    if let chain = row.chainLine { Text("   \(chain)") }
                    Divider()
                }
                if !work.recent.isEmpty {
                    Text(L.recentTasks)
                    ForEach(work.recent) { task in
                        Button("\(WorkMenu.statusLabel(task.status, stalled: task.stalled)) · \(task.requestSummary)") {
                            openWindow(id: WindowID.task, value: task.workflowId)
                        }
                    }
                }
            }
        }
    }

    // MARK: provider limits (subscription usage only; slow cadence, manual refresh)

    @ViewBuilder private var limitsMenu: some View {
        Menu(L.limits) {
            if let report = controller.usageReport {
                ForEach(report.orderedProviders, id: \.name) { entry in
                    ForEach(Array(WorkMenu.usageLines(name: entry.name, usage: entry.usage).enumerated()), id: \.offset) { _, line in
                        Text(line)
                    }
                    Divider()
                }
            } else {
                Text(L.usageUnavailable)
            }
            Button(L.refreshLimits) { controller.refreshLimits() }
                .disabled(controller.usageRefreshing)
        }
    }

    // MARK: Claude model/effort

    /// A summary line (the EFFECTIVE concrete model) plus two submenus. Every title, section
    /// and checkmark comes from `ModelMenu`, built from the CLI's JSON — this view parses no
    /// model id. The checkmark follows the SELECTED option; the summary follows the running one.
    @ViewBuilder private var claudeSection: some View {
        if let config = controller.claudeConfig {
            Text(ModelMenu.claudeSummary(config.claude))
            ForEach(ModelMenu.claudePendingLines(config.claude), id: \.self) { Text($0) }
            if config.capabilities.modelSupported && !config.claude.models.isEmpty {
                Menu(L.claudeModelMenu) {
                    modelRows(ModelMenu.claudeRows(options: config.claude.models, selectedId: config.claude.model)) {
                        controller.setClaudeModel($0)
                    }
                }
                .disabled(controller.isBusy)
            } else {
                Text(L.claudeModelUnsupported)
            }
            if config.capabilities.effortSupported && !config.claude.effortOptions.isEmpty {
                Menu(L.claudeEffortMenu) {
                    modelRows(ModelMenu.effortRows(options: config.claude.effortOptions, selectedId: config.claude.effort)) {
                        controller.setClaudeEffort($0)
                    }
                }
                .disabled(controller.isBusy)
            } else {
                Text(L.claudeEffortUnsupported)
            }
        }
    }

    // MARK: Codex model/reasoning (project-scoped — see `operator/codex-config.mjs`)

    /// Selectors appear ONLY when the Murmur CLI reports Codex as controllable (the App Server's
    /// own catalog was read). Otherwise just the effective model and one explanatory line — no
    /// disabled fake controls.
    @ViewBuilder private var codexSection: some View {
        if let config = controller.codexConfig {
            Text(ModelMenu.codexSummary(config.codex))
            ForEach(ModelMenu.codexPendingLines(config.codex), id: \.self) { Text($0) }
            if config.codex.controllable {
                Menu(L.codexModelMenu) {
                    modelRows(ModelMenu.codexRows(options: config.codex.availableModels, selectedId: config.codex.selectedModel)) {
                        controller.setCodexModel($0)
                    }
                }
                .disabled(controller.isBusy)
                if !config.codex.effortOptions.isEmpty {
                    Menu(L.codexEffortMenu) {
                        modelRows(ModelMenu.effortRows(options: config.codex.effortOptions, selectedId: config.codex.reasoningEffort)) {
                            controller.setCodexEffort($0)
                        }
                    }
                    .disabled(controller.isBusy)
                }
            } else {
                Text(L.codexModelUnavailable)
            }
        }
    }

    /// Render `ModelMenuRow`s: headings are disabled items, options are buttons.
    @ViewBuilder private func modelRows(_ rows: [ModelMenuRow], onSelect: @escaping (String) -> Void) -> some View {
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
            switch row {
            case let .heading(title):
                Text(title)
            case .divider:
                Divider()
            case let .option(id, title, checked, enabled):
                Button(ModelMenu.rowText(title: title, checked: checked)) { onSelect(id) }
                    .disabled(!enabled)
            }
        }
    }

    // MARK: Cursor model (read-only — see `cursor-config.mjs`'s header)

    /// Cursor's own model selection is real but ACCOUNT-GLOBAL, not scoped to this
    /// project or to Murmur — so, unlike `claudeSection`, this is a single line with no
    /// submenu and no button. Building a selector here would silently reach into the
    /// operator's personal Cursor settings with no way to undo that scoping; truthful
    /// display beats a fake control that looks symmetric with Claude's.
    @ViewBuilder private var cursorSection: some View {
        if let config = controller.cursorConfig {
            Text("\(L.cursor): \(config.cursor.effectiveModelLabel ?? L.cursorByCursorSettings)")
            Text(L.cursorNotControlledByMurmur)
        }
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
    static let task = "murmur-task"
    static let status = "murmur-status"
    static let send = "murmur-send"
    static let doctor = "murmur-doctor"
}
