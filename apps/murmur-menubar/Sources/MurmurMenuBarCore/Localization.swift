import Foundation

/// Every string a human sees. Russian, in one place, so nothing English reaches the UI by
/// accident and a wording change never needs a hunt through view code.
public enum L {
    public static let appName = "Murmur"
    public static let project = "Проект"
    public static let status = "Состояние"
    public static let actions = "Действия"
    public static let projects = "Проекты"

    public static let start = "Запустить"
    public static let stop = "Остановить"
    public static let sendTask = "Отправить задачу…"
    public static let check = "Проверить"
    public static let openLogs = "Открыть логи"
    public static let refresh = "Обновить"
    public static let quit = "Выйти"
    public static let details = "Подробнее…"
    public static let launchAtLogin = "Запускать Murmur Menu Bar при входе"

    public static let running = "работает"
    public static let stopped = "остановлен"
    public static let unhealthy = "есть проблемы"
    public static let busy = "выполняется…"
    public static let unknown = "неизвестно"

    public static let starting = "запускается…"
    public static let stopping = "останавливается…"
    public static let checking = "проверка…"
    public static let sending = "отправка…"
    public static let settingClaudeModel = "применяется…"
    public static let settingClaudeEffort = "применяется…"

    public static let supervisor = "Супервизор"
    public static let nats = "NATS"
    public static let openContinuations = "Открытых продолжений"
    public static let dispatches = "Диспетчеризация"
    public static let claude = "Claude"
    public static let claudeModelMenu = "Модель Claude"
    public static let claudeEffortMenu = "Усилие"
    public static let claudeCurrently = "Сейчас"
    public static let claudeEffective = "Фактически"
    public static let claudeSelected = "Модель / усилие"
    public static let claudePendingRestart = "Применится после перезапуска Murmur."
    public static let claudeEffortUnsupported = "Усилие: управляется Claude Code"
    public static let claudeModelUnsupported = "Модель: управляется Claude Code"
    public static let cursor = "Cursor"
    public static let cursorByCursorSettings = "по настройкам Cursor"
    public static let cursorNotControlledByMurmur = "Murmur не управляет выбором модели Cursor"
    public static let telegram = "Telegram"
    public static let telegramOn = "включён"
    public static let telegramOff = "не настроен"
    public static let telegramInvalid = "настроен неверно"

    public static let noProjects = "Нет проектов Murmur"
    public static let noProjectSelected = "Проект не выбран"
    public static let taskPlaceholder = "Что нужно сделать?"
    public static let send = "Отправить"
    public static let cancel = "Отмена"
    public static let result = "Результат"
    public static let close = "Закрыть"
    public static let copy = "Скопировать"

    public static let cliMissingTitle = "Murmur CLI не найден"
    public static let cliMissingHint = """
    Приложение не нашло исполняемый файл `murmur`. Установите его (`npm link` в репозитории \
    Murmur или через Homebrew) либо укажите полный путь в переменной окружения MURMUR_CLI.
    """

    public static func healthLabel(_ state: HealthState) -> String {
        switch state {
        case .running: return running
        case .stopped: return stopped
        case .unhealthy: return unhealthy
        case .busy: return busy
        case .unknown: return unknown
        }
    }

    /// The agent's own role name is a Murmur identifier and stays as it is; only the
    /// surrounding words are translated.
    public static func agentLabel(_ name: String) -> String {
        switch name {
        case "root": return "Пользователь (root)"
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "cursor": return "Cursor"
        default: return name
        }
    }

    public static func agentState(alive: Bool, childState: String?) -> String {
        if alive { return "работает" }
        switch childState {
        case "not-started", nil: return "не запущен"
        case "exited": return "завершился"
        default: return childState ?? "неизвестно"
        }
    }
}

/// Turn a failure into one short Russian sentence.
///
/// A stack trace, a Node warning or an exit code is not an answer to "what do I do now",
/// and pasting raw CLI internals into a menu is how an operator learns to ignore errors.
/// The underlying detail is preserved for the details view, truncated, and never
/// interpreted — the CLI already refuses to print a secret, and this never adds one.
public func describeFailure(_ error: Error) -> String {
    guard let cliError = error as? MurmurCLIError else {
        return "Не удалось выполнить команду."
    }
    switch cliError {
    case .notInstalled:
        return L.cliMissingTitle
    case let .launchFailed(detail):
        return "Не удалось запустить Murmur CLI: \(shorten(detail))"
    case let .timedOut(seconds):
        return "Команда не ответила за \(seconds) с."
    case .malformedOutput:
        return "Murmur CLI вернул неожиданный ответ."
    case let .commandFailed(exitCode, message):
        let text = shorten(message)
        return text.isEmpty
            ? "Команда завершилась с ошибкой (код \(exitCode))."
            : "Ошибка Murmur: \(text)"
    }
}

/// Why a `send` did not produce a result, in Russian.
public func describeSendFailure(_ result: SendResult) -> String {
    switch result.reason {
    case "timeout":
        let seconds = result.timeoutSeconds.map { " (\($0) с)" } ?? ""
        return "Координатор не ответил вовремя\(seconds)."
    case "coordinator-unavailable":
        return "Координатор недоступен: \(shorten(result.detail ?? "проект не запущен"))"
    case "no-profile":
        return "Для этого проекта нет профиля. Сначала запустите Murmur."
    case "root-disabled":
        return "Identity root отключена в профиле проекта."
    case "no-root-coordinator-pair":
        return "В профиле проекта нет пары root/координатор."
    case "task-required":
        return "Задача пустая."
    default:
        return "Не удалось отправить задачу."
    }
}

private func shorten(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return String(trimmed.prefix(160))
}
