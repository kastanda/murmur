import Foundation

/// What the model submenus and the summary rows show, built ONCE here from the CLI's JSON so
/// the main menu line, the submenus, the details window and the pending text are all driven
/// by the same labels. Nothing in this file parses a model id or guesses a version: every
/// label is a string the Murmur CLI already decided.

/// One row of a model submenu.
public enum ModelMenuRow: Equatable, Sendable {
    /// A non-clickable section title ("Актуальные", "Фиксированные версии").
    case heading(String)
    case divider
    /// A selectable option; `checked` follows the SELECTED preference, never the effective one.
    case option(id: String, title: String, checked: Bool, enabled: Bool)
}

public enum ModelMenu {
    /// "Актуальный Sonnet — сейчас Sonnet 5.5": an alias (or inherit) with what it currently
    /// resolves to, when the CLI knows. A pinned/catalog option is just its own label.
    public static func title(for option: ModelOption) -> String {
        switch option.kind {
        case "alias", "inherit":
            if let resolved = option.resolvesToLabel, !resolved.isEmpty, resolved != option.label {
                return "\(option.label) — \(L.modelNow) \(resolved)"
            }
            return option.label
        default:
            return option.label
        }
    }

    /// Claude's picker: moving aliases, then fixed versions, then "по настройкам Claude Code".
    /// Only sections that actually have options are rendered.
    public static func claudeRows(options: [ModelOption], selectedId: String) -> [ModelMenuRow] {
        let aliases = options.filter { $0.kind == "alias" }
        let pinned = options.filter { $0.kind == "pinned" }
        let inherit = options.filter { $0.kind == "inherit" }
        func rows(_ list: [ModelOption]) -> [ModelMenuRow] {
            list.map { .option(id: $0.id, title: title(for: $0), checked: $0.id == selectedId, enabled: $0.selectable) }
        }
        var result: [ModelMenuRow] = []
        if !aliases.isEmpty { result.append(.heading(L.modelAliasesSection)); result += rows(aliases) }
        if !pinned.isEmpty { result.append(.heading(L.modelPinnedSection)); result += rows(pinned) }
        if !inherit.isEmpty {
            if !result.isEmpty { result.append(.divider) }
            result += rows(inherit)
        }
        return result
    }

    /// Codex's picker: the App Server's own models, then "по настройкам Codex".
    public static func codexRows(options: [ModelOption], selectedId: String) -> [ModelMenuRow] {
        let models = options.filter { $0.kind != "inherit" }
        let inherit = options.filter { $0.kind == "inherit" }
        func rows(_ list: [ModelOption]) -> [ModelMenuRow] {
            list.map { .option(id: $0.id, title: title(for: $0), checked: $0.id == selectedId, enabled: $0.selectable) }
        }
        var result = rows(models)
        if !inherit.isEmpty {
            if !result.isEmpty { result.append(.divider) }
            result += rows(inherit)
        }
        return result
    }

    public static func effortRows(options: [EffortOption], selectedId: String) -> [ModelMenuRow] {
        options.map { .option(id: $0.id, title: $0.label, checked: $0.id == selectedId, enabled: true) }
    }

    /// "✓ title" for the selected option, two spaces otherwise — the project picker's glyph.
    public static func rowText(title: String, checked: Bool) -> String {
        checked ? "✓ \(title)" : "  \(title)"
    }

    // MARK: summary lines

    /// `Claude: Sonnet 5.5 · Среднее` — the EFFECTIVE model (the concrete version it runs as),
    /// never the selection's own name.
    public static func claudeSummary(_ claude: ClaudePreference) -> String {
        let model = claude.effectiveModelLabel ?? claude.modelLabel
        let effort = claude.effectiveEffortLabel ?? claude.effortLabel
        return "\(L.claude): \(model) · \(effort)"
    }

    /// Only when a restart is genuinely pending: what was chosen vs what is running.
    public static func claudePendingLines(_ claude: ClaudePreference) -> [String] {
        guard claude.pendingRestart else { return [] }
        let running = claude.effectiveModelLabel ?? L.unknown
        let runningEffort = claude.effectiveEffortLabel ?? L.unknown
        return [
            "\(L.modelSelected): \(claude.modelLabel) · \(claude.effortLabel)",
            "\(L.modelNow.capitalizedFirst): \(running) · \(runningEffort)",
            L.claudePendingRestart,
        ]
    }

    /// `Codex: GPT-5.5 · Высокое`. With no readable catalog there is no selection to show:
    /// the effective model if known, else "по настройкам Codex".
    public static func codexSummary(_ codex: CodexPreference) -> String {
        if !codex.controllable {
            return "\(L.codex): \(codex.effectiveModelLabel ?? L.codexByCodexSettings)"
        }
        let model = codex.effectiveModelLabel ?? codex.selectedModelLabel
        let effort = codex.effectiveReasoningEffortLabel ?? codex.reasoningEffortLabel
        return "\(L.codex): \(model) · \(effort)"
    }

    /// Only technically true transitions: a new thread for "back to inherit", the next turn
    /// for an explicit change. Codex never needs a Murmur restart.
    public static func codexPendingLines(_ codex: CodexPreference) -> [String] {
        guard codex.controllable else { return [] }
        if codex.requiresNewThread {
            return [
                "\(L.modelSelected): \(codex.selectedModelLabel) · \(codex.reasoningEffortLabel)",
                "\(L.modelNow.capitalizedFirst): \(codex.effectiveModelLabel ?? L.unknown) · \(codex.effectiveReasoningEffortLabel ?? L.unknown)",
                L.codexPendingNewSession,
            ]
        }
        if codex.pendingNextTurn {
            // Nothing has run under the selection yet: there is no "now" to contrast with.
            if codex.effectiveModelLabel == nil { return [L.codexPendingNextTurn] }
            return [
                "\(L.modelSelected): \(codex.selectedModelLabel) · \(codex.reasoningEffortLabel)",
                "\(L.modelNow.capitalizedFirst): \(codex.effectiveModelLabel ?? L.unknown) · \(codex.effectiveReasoningEffortLabel ?? L.unknown)",
                L.codexPendingNextTurn,
            ]
        }
        return []
    }
}

extension String {
    /// "сейчас" -> "Сейчас" (Cyrillic-safe; no locale dependence).
    var capitalizedFirst: String {
        guard let first = first else { return self }
        return first.uppercased() + dropFirst()
    }
}
