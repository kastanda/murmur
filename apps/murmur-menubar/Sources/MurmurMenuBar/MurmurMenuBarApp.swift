import SwiftUI
import MurmurMenuBarCore

/// The menu bar app.
///
/// `MenuBarExtra` with `LSUIElement` in the bundle's Info.plist means there is no Dock
/// icon and no window until one is asked for — a status item is the whole surface.
@main
struct MurmurMenuBarApp: App {
    @StateObject private var controller = MurmurController()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(controller: controller)
        } label: {
            // The icon carries the state as a SHAPE, not only a colour: a coloured dot
            // alone is unreadable for a red/green-blind operator and invisible in a
            // monochrome menu bar. The colour is a second channel on top of the symbol,
            // and the menu always spells the state out in words as well.
            Image(systemName: symbolName(controller.health))
                .foregroundStyle(tint(controller.health))
                .accessibilityLabel("\(L.appName): \(L.healthLabel(controller.health))")
        }
        .menuBarExtraStyle(.menu)

        // Opened on demand from the menu. Nothing appears at launch, so the app stays a
        // status item until the operator asks for more.
        Window(L.status, id: WindowID.status) { StatusWindow(controller: controller) }
            .defaultSize(width: 440, height: 380)
        Window(L.check, id: WindowID.doctor) { DoctorWindow(controller: controller) }
            .defaultSize(width: 640, height: 440)
        Window(L.sendTask, id: WindowID.send) { SendTaskWindow(controller: controller) }
            .defaultSize(width: 540, height: 440)
        // One window per task, keyed by its workflow id (the root message id).
        WindowGroup(L.taskDetail, id: WindowID.task, for: String.self) { $workflowId in
            TaskDetailWindow(controller: controller, workflowId: workflowId ?? "")
        }
        .defaultSize(width: 520, height: 520)
    }

    private func symbolName(_ state: HealthState) -> String {
        switch state {
        case .running: return "waveform.circle.fill"
        case .stopped: return "waveform.circle"
        case .busy: return "waveform.circle.fill"
        case .unhealthy: return "exclamationmark.triangle.fill"
        case .unknown: return "questionmark.circle"
        }
    }

    private func tint(_ state: HealthState) -> Color {
        switch state {
        case .running: return .green
        case .stopped: return .secondary
        case .busy: return .yellow
        case .unhealthy: return .red
        case .unknown: return .secondary
        }
    }
}
