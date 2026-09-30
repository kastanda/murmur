import Foundation

/// Where the `murmur` executable was found, so the UI can say something useful when it
/// was not.
public enum CLILocation: Equatable, Sendable {
    /// An absolute path the operator configured, or `MURMUR_CLI` in the environment.
    case configured(String)
    /// One of the well-known install locations below.
    case discovered(String)
    /// Nothing usable. The UI must tell the operator how to fix it rather than guess.
    case missing

    public var path: String? {
        switch self {
        case let .configured(path), let .discovered(path): return path
        case .missing: return nil
        }
    }
}

/// Finds the Murmur CLI for a GUI process.
///
/// A GUI app launched from Finder or at login does NOT inherit the shell's `PATH`: it
/// typically gets `/usr/bin:/bin:/usr/sbin:/sbin`, where `murmur` never lives. So the
/// path is resolved explicitly, in a fixed order, and nothing here assumes
/// `/usr/local/bin`.
///
/// There is deliberately NO login-shell probe (`zsh -lc 'command -v murmur'`). It is the
/// usual trick for this problem, and it would work — but it means this app executes a
/// shell, and "this app never runs a shell" is a property worth being able to state
/// without an asterisk. The known-location list below covers Homebrew (both
/// architectures), npm global prefixes, nvm, Volta and user-local installs; anything
/// else is one setting away, and an operator who needs it gets an instruction instead of
/// a silent failure.
public struct CLILocator: Sendable {
    /// Directories a Node CLI is plausibly installed into, most specific first.
    public static let knownDirectories: [String] = [
        "/opt/homebrew/bin",          // Homebrew on Apple silicon
        "/usr/local/bin",             // Homebrew on Intel, and hand-installed binaries
        "/opt/local/bin",             // MacPorts
        "\(NSHomeDirectory())/.local/bin",
        "\(NSHomeDirectory())/.volta/bin",
        "\(NSHomeDirectory())/.npm-global/bin",
        "\(NSHomeDirectory())/.yarn/bin",
        "\(NSHomeDirectory())/bin",
    ]

    /// `~/.nvm/versions/node/<version>/bin` — enumerated, because the version is unknown.
    public static func nvmDirectories(
        home: String = NSHomeDirectory(),
        contentsOf: (String) -> [String] = { path in
            (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
        }
    ) -> [String] {
        let root = "\(home)/.nvm/versions/node"
        return contentsOf(root).sorted().reversed().map { "\(root)/\($0)/bin" }
    }

    private let isExecutable: @Sendable (String) -> Bool

    public init(isExecutable: @escaping @Sendable (String) -> Bool = { path in
        FileManager.default.isExecutableFile(atPath: path)
    }) {
        self.isExecutable = isExecutable
    }

    /// Resolve the CLI.
    ///
    /// Order: an explicitly configured absolute path, then `MURMUR_CLI`, then the known
    /// locations. A configured path that no longer exists is reported as `.missing`
    /// rather than silently falling through — an operator who pointed us somewhere
    /// specific needs to hear that it broke, not be quietly redirected elsewhere.
    public func locate(
        configuredPath: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        searchDirectories: [String]? = nil
    ) -> CLILocation {
        if let configured = configuredPath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configured.isEmpty {
            return isExecutable(configured) ? .configured(configured) : .missing
        }
        if let fromEnvironment = environment["MURMUR_CLI"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !fromEnvironment.isEmpty {
            return isExecutable(fromEnvironment) ? .configured(fromEnvironment) : .missing
        }
        let directories = searchDirectories ?? (Self.knownDirectories + Self.nvmDirectories())
        for directory in directories {
            let candidate = "\(directory)/murmur"
            if isExecutable(candidate) { return .discovered(candidate) }
        }
        return .missing
    }
}

/// The `PATH` handed to the CLI child process.
///
/// The CLI is a Node script with a `#!/usr/bin/env node` shebang, so launching it needs
/// `node` to be findable BY THE CHILD. Under a GUI's minimal `PATH` it is not, and the
/// launch fails with a bare "env: node: No such file or directory" that looks nothing
/// like the actual problem.
///
/// So the child is given an explicit `PATH`: the directory the CLI itself was found in
/// (a Node CLI and its `node` almost always share a prefix), then the same known
/// locations, then the system default. This is composed from constants and one resolved
/// path — no shell, no interpolation of anything the operator typed.
public func childSearchPath(
    cliPath: String?,
    extraDirectories: [String] = CLILocator.knownDirectories + CLILocator.nvmDirectories(),
    systemPath: String = "/usr/bin:/bin:/usr/sbin:/sbin"
) -> String {
    var directories: [String] = []
    if let cliPath { directories.append((cliPath as NSString).deletingLastPathComponent) }
    directories.append(contentsOf: extraDirectories)
    directories.append(contentsOf: systemPath.split(separator: ":").map(String.init))

    var seen = Set<String>()
    return directories.filter { seen.insert($0).inserted && !$0.isEmpty }.joined(separator: ":")
}
