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

/// The complete Claude picker as `murmur claude <project> config --json` reports it: moving
/// aliases, pinned versions, inherit — each already carrying its final label. (A fixture:
/// it proves rendering, not that those models exist on any machine.)
let claudeModelsJSON = """
[{"id":"opus","kind":"alias","label":"Актуальный Opus","resolvesToLabel":"Opus 5.5","canonicalId":"claude-opus-5-5","selectable":true},
 {"id":"sonnet","kind":"alias","label":"Актуальный Sonnet","resolvesToLabel":"Sonnet 5.5","canonicalId":"claude-sonnet-5-5","selectable":true},
 {"id":"haiku","kind":"alias","label":"Актуальный Haiku","resolvesToLabel":"Haiku 4.5","canonicalId":"claude-haiku-4-5-20251001","selectable":true},
 {"id":"claude-fable-5-1","kind":"pinned","label":"Fable 5.1","canonicalId":"claude-fable-5-1","selectable":true},
 {"id":"claude-opus-5-5","kind":"pinned","label":"Opus 5.5","canonicalId":"claude-opus-5-5","selectable":true},
 {"id":"claude-opus-5","kind":"pinned","label":"Opus 5","canonicalId":"claude-opus-5","selectable":true},
 {"id":"claude-sonnet-5-5","kind":"pinned","label":"Sonnet 5.5","canonicalId":"claude-sonnet-5-5","selectable":true},
 {"id":"claude-sonnet-5","kind":"pinned","label":"Sonnet 5","canonicalId":"claude-sonnet-5","selectable":true},
 {"id":"claude-haiku-4-5-20251001","kind":"pinned","label":"Haiku 4.5","canonicalId":"claude-haiku-4-5-20251001","selectable":true},
 {"id":"inherit","kind":"inherit","label":"По настройкам Claude Code","resolvesToLabel":"Opus 5.5","selectable":true}]
"""

let claudeEffortOptionsJSON = """
[{"id":"low","label":"Низкое"},{"id":"medium","label":"Среднее"},{"id":"high","label":"Высокое"},{"id":"inherit","label":"По настройкам Claude Code"}]
"""

let claudeCapabilitiesFullJSON = """
{"available":true,"modelSupported":true,"effortSupported":true,
 "supportedModels":["opus","sonnet","haiku","claude-sonnet-5","claude-sonnet-5-5"],"supportedEfforts":["low","medium","high","xhigh","max"],
 "modelLabels":{"sonnet":"Актуальный Sonnet","opus":"Актуальный Opus","inherit":"По настройкам Claude Code"},
 "effortLabels":{"low":"Низкое","medium":"Среднее","high":"Высокое","xhigh":"Повышенное","max":"Максимальное","inherit":"По настройкам Claude Code"},
 "catalogSource":"sdk-initialize"}
"""

/// The alias "Актуальный Sonnet" selected and running; it currently resolves to Sonnet 5.5.
let claudeConfigJSON = """
{"project":"murmur",
 "capabilities":\(claudeCapabilitiesFullJSON),
 "claude":{"model":"sonnet","modelLabel":"Актуальный Sonnet","effort":"medium","effortLabel":"Среднее",
   "runningModel":"sonnet","runningEffort":"medium",
   "effectiveModel":"sonnet","effectiveModelLabel":"Sonnet 5.5","canonicalModel":"claude-sonnet-5-5",
   "effectiveEffort":"medium","effectiveEffortLabel":"Среднее",
   "source":"murmur-project","effortSource":"murmur-project","pendingRestart":false,"configState":"configured",
   "selected":{"id":"sonnet","kind":"alias","label":"Актуальный Sonnet","canonicalId":"claude-sonnet-5-5","resolvesToLabel":"Sonnet 5.5","effectiveLabel":"Sonnet 5.5"},
   "running":{"id":"sonnet","kind":"alias","label":"Актуальный Sonnet","canonicalId":"claude-sonnet-5-5","resolvesToLabel":"Sonnet 5.5","effectiveLabel":"Sonnet 5.5"},
   "effective":{"id":"sonnet","kind":"alias","label":"Актуальный Sonnet","canonicalId":"claude-sonnet-5-5","resolvesToLabel":"Sonnet 5.5","effectiveLabel":"Sonnet 5.5"},
   "models":\(claudeModelsJSON),
   "effortOptions":\(claudeEffortOptionsJSON)}}
"""

/// The operator pinned Sonnet 5 while the daemon still runs the moving alias (now Sonnet 5.5).
let claudeConfigPendingRestartJSON = """
{"project":"murmur",
 "capabilities":\(claudeCapabilitiesFullJSON),
 "claude":{"model":"claude-sonnet-5","modelLabel":"Sonnet 5","effort":"high","effortLabel":"Высокое",
   "runningModel":"sonnet","runningEffort":"medium",
   "effectiveModel":"sonnet","effectiveModelLabel":"Sonnet 5.5","canonicalModel":"claude-sonnet-5-5",
   "effectiveEffort":"medium","effectiveEffortLabel":"Среднее",
   "source":"murmur-project","effortSource":"murmur-project","pendingRestart":true,"configState":"configured",
   "selected":{"id":"claude-sonnet-5","kind":"pinned","label":"Sonnet 5","canonicalId":"claude-sonnet-5","effectiveLabel":"Sonnet 5"},
   "running":{"id":"sonnet","kind":"alias","label":"Актуальный Sonnet","canonicalId":"claude-sonnet-5-5","resolvesToLabel":"Sonnet 5.5","effectiveLabel":"Sonnet 5.5"},
   "effective":{"id":"sonnet","kind":"alias","label":"Актуальный Sonnet","canonicalId":"claude-sonnet-5-5","resolvesToLabel":"Sonnet 5.5","effectiveLabel":"Sonnet 5.5"},
   "models":\(claudeModelsJSON),
   "effortOptions":\(claudeEffortOptionsJSON)}}
"""

/// The pinned Sonnet 5 selected AND running (the live-acceptance end state).
let claudeConfigPinnedJSON = """
{"project":"murmur",
 "capabilities":\(claudeCapabilitiesFullJSON),
 "claude":{"model":"claude-sonnet-5","modelLabel":"Sonnet 5","effort":"medium","effortLabel":"Среднее",
   "runningModel":"claude-sonnet-5","runningEffort":"medium",
   "effectiveModel":"claude-sonnet-5","effectiveModelLabel":"Sonnet 5","canonicalModel":"claude-sonnet-5",
   "effectiveEffort":"medium","effectiveEffortLabel":"Среднее",
   "source":"murmur-project","effortSource":"murmur-project","pendingRestart":false,"configState":"configured",
   "selected":{"id":"claude-sonnet-5","kind":"pinned","label":"Sonnet 5","canonicalId":"claude-sonnet-5","effectiveLabel":"Sonnet 5"},
   "running":{"id":"claude-sonnet-5","kind":"pinned","label":"Sonnet 5","canonicalId":"claude-sonnet-5","effectiveLabel":"Sonnet 5"},
   "effective":{"id":"claude-sonnet-5","kind":"pinned","label":"Sonnet 5","canonicalId":"claude-sonnet-5","effectiveLabel":"Sonnet 5"},
   "models":\(claudeModelsJSON),
   "effortOptions":\(claudeEffortOptionsJSON)}}
"""

/// Nothing ever configured for this project: pure inherit, Claude Code's own default shown.
let claudeConfigInheritJSON = """
{"project":"murmur",
 "capabilities":\(claudeCapabilitiesFullJSON),
 "claude":{"model":"inherit","modelLabel":"По настройкам Claude Code","effort":"inherit","effortLabel":"По настройкам Claude Code",
   "runningModel":null,"runningEffort":null,
   "effectiveModel":"sonnet","effectiveModelLabel":"Sonnet 5.5","canonicalModel":"claude-sonnet-5-5",
   "effectiveEffort":null,"effectiveEffortLabel":null,
   "source":"claude-code","effortSource":"claude-code","pendingRestart":false,"configState":"absent",
   "models":\(claudeModelsJSON),
   "effortOptions":\(claudeEffortOptionsJSON)}}
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
   "source":"claude-code","effortSource":"claude-code","pendingRestart":false,"configState":"absent",
   "models":[{"id":"inherit","kind":"inherit","label":"По настройкам Claude Code","selectable":true}],
   "effortOptions":[{"id":"inherit","label":"По настройкам Claude Code"}]}}
"""

/// A controllable Codex: the App Server's own catalog (synthetic names), nothing running yet
/// under an explicit choice — inherit resolves to the model Codex itself would use.
let codexConfigJSON = """
{"project":"murmur",
 "codex":{"controllable":true,"reason":null,
   "selectedModel":"inherit","selectedModelLabel":"По настройкам Codex",
   "reasoningEffort":"inherit","reasoningEffortLabel":"По настройкам Codex",
   "effectiveModel":"model-a","effectiveModelLabel":"Model A",
   "effectiveReasoningEffort":"high","effectiveReasoningEffortLabel":"Высокое",
   "availableModels":[{"id":"model-a","kind":"catalog","label":"Model A","selectable":true},
                      {"id":"model-b","kind":"catalog","label":"Model B","selectable":true},
                      {"id":"inherit","kind":"inherit","label":"По настройкам Codex","resolvesToLabel":"Model A","selectable":true}],
   "effortOptions":[{"id":"low","label":"Низкое"},{"id":"medium","label":"Среднее"},{"id":"high","label":"Высокое"},{"id":"inherit","label":"По настройкам Codex"}],
   "source":"codex-config","pendingRestart":false,"pendingNextTurn":false,"requiresNewThread":false,"configState":"absent"}}
"""

/// Model B selected while Model A last ran: applies from the next Codex turn.
let codexConfigPendingNextTurnJSON = """
{"project":"murmur",
 "codex":{"controllable":true,"reason":null,
   "selectedModel":"model-b","selectedModelLabel":"Model B",
   "reasoningEffort":"low","reasoningEffortLabel":"Низкое",
   "effectiveModel":"model-a","effectiveModelLabel":"Model A",
   "effectiveReasoningEffort":"high","effectiveReasoningEffortLabel":"Высокое",
   "availableModels":[{"id":"model-a","kind":"catalog","label":"Model A","selectable":true},
                      {"id":"model-b","kind":"catalog","label":"Model B","selectable":true},
                      {"id":"inherit","kind":"inherit","label":"По настройкам Codex","resolvesToLabel":"Model A","selectable":true}],
   "effortOptions":[{"id":"low","label":"Низкое"},{"id":"medium","label":"Среднее"},{"id":"high","label":"Высокое"},{"id":"inherit","label":"По настройкам Codex"}],
   "source":"murmur-project","pendingRestart":false,"pendingNextTurn":true,"requiresNewThread":false,"configState":"configured"}}
"""

/// Model B selected, nothing has run under it yet: effective is unknown, not assumed.
let codexConfigSelectedNeverRunJSON = """
{"project":"murmur",
 "codex":{"controllable":true,"reason":null,
   "selectedModel":"model-b","selectedModelLabel":"Model B",
   "reasoningEffort":"low","reasoningEffortLabel":"Низкое",
   "effectiveModel":null,"effectiveModelLabel":null,
   "effectiveReasoningEffort":null,"effectiveReasoningEffortLabel":null,
   "availableModels":[{"id":"model-a","kind":"catalog","label":"Model A","selectable":true},
                      {"id":"model-b","kind":"catalog","label":"Model B","selectable":true},
                      {"id":"inherit","kind":"inherit","label":"По настройкам Codex","selectable":true}],
   "effortOptions":[{"id":"low","label":"Низкое"},{"id":"inherit","label":"По настройкам Codex"}],
   "source":"murmur-project","pendingRestart":false,"pendingNextTurn":true,"requiresNewThread":false,"configState":"configured"}}
"""

/// Back to inherit while the thread holds an explicit model: needs a NEW Codex session.
let codexConfigNewThreadJSON = """
{"project":"murmur",
 "codex":{"controllable":true,"reason":null,
   "selectedModel":"inherit","selectedModelLabel":"По настройкам Codex",
   "reasoningEffort":"inherit","reasoningEffortLabel":"По настройкам Codex",
   "effectiveModel":"model-b","effectiveModelLabel":"Model B",
   "effectiveReasoningEffort":"low","effectiveReasoningEffortLabel":"Низкое",
   "availableModels":[{"id":"model-a","kind":"catalog","label":"Model A","selectable":true},
                      {"id":"inherit","kind":"inherit","label":"По настройкам Codex","selectable":true}],
   "effortOptions":[{"id":"inherit","label":"По настройкам Codex"}],
   "source":"codex-config","pendingRestart":false,"pendingNextTurn":false,"requiresNewThread":true,"configState":"configured"}}
"""

/// The App Server's catalog could not be read: read-only, no selector data at all.
let codexConfigUncontrollableJSON = """
{"project":"murmur",
 "codex":{"controllable":false,"reason":"codex-model-catalog-unavailable",
   "selectedModel":"inherit","selectedModelLabel":"По настройкам Codex",
   "reasoningEffort":"inherit","reasoningEffortLabel":"По настройкам Codex",
   "effectiveModel":null,"effectiveModelLabel":null,
   "effectiveReasoningEffort":null,"effectiveReasoningEffortLabel":null,
   "availableModels":[],"effortOptions":[],
   "source":"codex-config","pendingRestart":false,"pendingNextTurn":false,"requiresNewThread":false,"configState":"absent"}}
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
        case "codex": return ok(codexConfigJSON)
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
