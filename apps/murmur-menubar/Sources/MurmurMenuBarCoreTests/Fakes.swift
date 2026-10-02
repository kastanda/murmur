import Foundation
import MurmurMenuBarCore

// Every test runs against a FAKE CLI. Nothing starts Murmur, spawns a process, touches a
// database or needs a network — the properties worth proving (argv shape, no shell,
// decoding, health mapping, the concurrency guard, secret hygiene) are all decidable
// without any of that.

/// Records what would have been executed and replays canned output.
final class FakeRunner: CommandRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _invocations: [CommandInvocation] = []
    private var _timeouts: [TimeInterval] = []
    private let respond: @Sendable (CommandInvocation) -> CommandOutcome
    /// Held open so a test can observe two commands overlapping.
    var gate: (@Sendable () async -> Void)?

    init(respond: @escaping @Sendable (CommandInvocation) -> CommandOutcome) {
        self.respond = respond
    }

    var invocations: [CommandInvocation] { lock.withLock { _invocations } }
    var timeouts: [TimeInterval] { lock.withLock { _timeouts } }

    func run(_ invocation: CommandInvocation, timeout: TimeInterval) async throws -> CommandOutcome {
        lock.withLock { _invocations.append(invocation); _timeouts.append(timeout) }
        await gate?()
        return respond(invocation)
    }
}

final class MemoryPreferences: PreferenceStore, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: String] = [:]
    func string(forKey key: String) -> String? { lock.withLock { storage[key] } }
    func set(_ value: String?, forKey key: String) { lock.withLock { storage[key] = value } }
    var keys: [String] { lock.withLock { Array(storage.keys) } }
}

func ok(_ stdout: String) -> CommandOutcome { CommandOutcome(exitCode: 0, stdout: stdout, stderr: "") }

let projectsJSON = """
{"projects":[
  {"projectId":"murmur-000000000001","name":"murmur","projectPath":"/Users/x/Projects/murmur",
   "profileRoot":"/Users/x/.murmur/projects/murmur-000000000001",
   "logsDir":"/Users/x/.murmur/projects/murmur-000000000001/logs","valid":true},
  {"projectId":"other-aaaaaaaaaaaa","name":"other","projectPath":"/Users/x/Projects/other",
   "profileRoot":"/Users/x/.murmur/projects/other-aaaaaaaaaaaa",
   "logsDir":"/Users/x/.murmur/projects/other-aaaaaaaaaaaa/logs","valid":true}]}
"""

let healthyStatusJSON = """
{"projectId":"murmur-000000000001","projectPath":"/Users/x/Projects/murmur",
 "supervisor":{"pid":4242,"alive":true,"phase":"ready"},
 "nats":{"name":"nats","status":"PASS","detail":"reachable at 127.0.0.1:4222"},
 "agents":[{"name":"root","role":"operator","alive":true,"pid":1,"childState":"alive","memberSlot":null},
           {"name":"claude","role":"coordinator","alive":true,"pid":2,"childState":"alive","memberSlot":"claude:auto"},
           {"name":"codex","role":"worker","alive":true,"pid":3,"childState":"alive","memberSlot":"codex:app-server"},
           {"name":"cursor","role":"worker","alive":true,"pid":4,"childState":"alive","memberSlot":"cursor:acp"}],
 "totals":{"openContinuations":0,"activeDispatch":0,"pendingDispatch":0},
 "healthy":true,"problems":[]}
"""

let stoppedStatusJSON = """
{"projectId":"murmur-000000000001","projectPath":"/Users/x/Projects/murmur",
 "supervisor":{"pid":null,"alive":false,"phase":"not-started"},
 "nats":{"name":"nats","status":"PASS","detail":"reachable"},
 "agents":[{"name":"claude","role":"coordinator","alive":false,"pid":null,"childState":"not-started","memberSlot":"claude:auto"}],
 "totals":{"openContinuations":0,"activeDispatch":0,"pendingDispatch":0},
 "healthy":false,"problems":["supervisor is not running"]}
"""

let notifyJSON = """
{"path":"/Users/x/.murmur/notifications.json","state":"configured","telegram":"configured",
 "channels":["telegram:telegram"],"mode":"activity"}
"""

let doctorJSON = """
{"status":"PASS","checks":[{"name":"nats","status":"PASS","detail":"reachable"},
                           {"name":"telegram-notify","status":"PASS","detail":"configured (global: telegram:telegram)"}]}
"""

/// Sonnet/Medium, explicitly selected and already matching what is running — the default
/// shape most tests want, matching this project's OWN actual configured policy.
let claudeConfigJSON = """
{"project":"murmur",
 "capabilities":{"available":true,"modelSupported":true,"effortSupported":true,
   "supportedModels":["sonnet","opus"],"supportedEfforts":["low","medium","high","xhigh","max"],
   "modelLabels":{"sonnet":"Sonnet","opus":"Opus","inherit":"По настройкам Claude Code"},
   "effortLabels":{"low":"Низкое","medium":"Среднее","high":"Высокое","xhigh":"Повышенное","max":"Максимальное","inherit":"По настройкам Claude Code"}},
 "claude":{"model":"sonnet","modelLabel":"Sonnet","effort":"medium","effortLabel":"Среднее",
   "runningModel":"sonnet","runningEffort":"medium",
   "effectiveModel":"sonnet","effectiveModelLabel":"Sonnet",
   "effectiveEffort":"medium","effectiveEffortLabel":"Среднее",
   "source":"murmur-project","effortSource":"murmur-project","pendingRestart":false,"configState":"configured"}}
"""

/// The operator just picked Opus/High while a Sonnet/Medium daemon is still running.
let claudeConfigPendingRestartJSON = """
{"project":"murmur",
 "capabilities":{"available":true,"modelSupported":true,"effortSupported":true,
   "supportedModels":["sonnet","opus"],"supportedEfforts":["low","medium","high","xhigh","max"],
   "modelLabels":{"sonnet":"Sonnet","opus":"Opus","inherit":"По настройкам Claude Code"},
   "effortLabels":{"low":"Низкое","medium":"Среднее","high":"Высокое","xhigh":"Повышенное","max":"Максимальное","inherit":"По настройкам Claude Code"}},
 "claude":{"model":"opus","modelLabel":"Opus","effort":"high","effortLabel":"Высокое",
   "runningModel":"sonnet","runningEffort":"medium",
   "effectiveModel":"sonnet","effectiveModelLabel":"Sonnet",
   "effectiveEffort":"medium","effectiveEffortLabel":"Среднее",
   "source":"murmur-project","effortSource":"murmur-project","pendingRestart":true,"configState":"configured"}}
"""

/// Nothing ever configured for this project: pure inherit, Claude Code's own default shown.
let claudeConfigInheritJSON = """
{"project":"murmur",
 "capabilities":{"available":true,"modelSupported":true,"effortSupported":true,
   "supportedModels":["sonnet","opus"],"supportedEfforts":["low","medium","high","xhigh","max"],
   "modelLabels":{"sonnet":"Sonnet","opus":"Opus","inherit":"По настройкам Claude Code"},
   "effortLabels":{"low":"Низкое","medium":"Среднее","high":"Высокое","xhigh":"Повышенное","max":"Максимальное","inherit":"По настройкам Claude Code"}},
 "claude":{"model":"inherit","modelLabel":"По настройкам Claude Code","effort":"inherit","effortLabel":"По настройкам Claude Code",
   "runningModel":null,"runningEffort":null,
   "effectiveModel":"sonnet","effectiveModelLabel":"Sonnet",
   "effectiveEffort":null,"effectiveEffortLabel":null,
   "source":"claude-code","effortSource":"claude-code","pendingRestart":false,"configState":"absent"}}
"""

/// The installed CLI supports neither flag at all.
let claudeConfigUnsupportedJSON = """
{"project":"murmur",
 "capabilities":{"available":true,"modelSupported":false,"effortSupported":false,
   "supportedModels":[],"supportedEfforts":[],
   "modelLabels":{"inherit":"По настройкам Claude Code"},"effortLabels":{"inherit":"По настройкам Claude Code"}},
 "claude":{"model":"inherit","modelLabel":"По настройкам Claude Code","effort":"inherit","effortLabel":"По настройкам Claude Code",
   "runningModel":null,"runningEffort":null,
   "effectiveModel":null,"effectiveModelLabel":null,
   "effectiveEffort":null,"effectiveEffortLabel":null,
   "source":"claude-code","effortSource":"claude-code","pendingRestart":false,"configState":"absent"}}
"""

/// Read-only, non-controllable, exactly as the real `cursor-config.mjs` reports it.
let cursorConfigJSON = """
{"project":"murmur",
 "cursor":{"controllable":false,"reason":"cursor-model-selection-is-account-global",
   "selectedModel":null,"selectedModelLabel":null,
   "effectiveModel":"claude-opus-5","effectiveModelLabel":"Claude Opus 5 300K High",
   "source":"cursor-global","supportedModels":[],"requiresRestart":false,"requiresNewSession":false}}
"""

/// Nothing Cursor has ever picked: the "default"/"Auto" state Cursor itself uses.
let cursorConfigAutoJSON = """
{"project":"murmur",
 "cursor":{"controllable":false,"reason":"cursor-model-selection-is-account-global",
   "selectedModel":null,"selectedModelLabel":null,
   "effectiveModel":"default","effectiveModelLabel":"Auto",
   "source":"cursor-global","supportedModels":[],"requiresRestart":false,"requiresNewSession":false}}
"""

/// The default fake: a healthy project, two projects, Telegram configured.
func healthyRunner() -> FakeRunner {
    FakeRunner { invocation in
        switch invocation.arguments.first {
        case "projects": return ok(projectsJSON)
        case "status": return ok(healthyStatusJSON)
        case "notify": return ok(notifyJSON)
        case "doctor": return ok(doctorJSON)
        case "claude": return ok(claudeConfigJSON)
        case "cursor": return ok(cursorConfigJSON)
        default: return ok("")
        }
    }
}

@MainActor
func makeController(
    runner: FakeRunner,
    preferences: PreferenceStore = MemoryPreferences(),
    cliPath: String? = "/opt/homebrew/bin/murmur"
) -> MurmurController {
    let locator = CLILocator(isExecutable: { path in cliPath != nil && path == cliPath })
    if let cliPath { preferences.set(cliPath, forKey: PreferenceKey.cliPath) }
    return MurmurController(
        locator: locator,
        preferences: preferences,
        pollInterval: 3600,
        makeCLI: { path in MurmurCLI(executable: path, runner: runner) }
    )
}
