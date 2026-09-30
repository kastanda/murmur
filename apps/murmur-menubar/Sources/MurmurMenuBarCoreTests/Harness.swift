import Foundation

/// A minimal assertion harness.
///
/// See Package.swift for why this is not XCTest. It reports every failure (rather than
/// stopping at the first), prints the file and line, and exits non-zero so a build script
/// or CI can gate on it.
actor Results {
    private(set) var passed = 0
    private(set) var failures: [String] = []

    func pass() { passed += 1 }
    func fail(_ message: String) { failures.append(message) }
    func summary() -> (passed: Int, failures: [String]) { (passed, failures) }
}

let results = Results()
private var currentTest = ""

func suite(_ name: String) {
    print("\n— \(name)")
}

func test(_ name: String, _ body: () async throws -> Void) async {
    currentTest = name
    do {
        try await body()
        print("  ok   \(name)")
    } catch {
        await results.fail("\(name): threw \(error)")
        print("  FAIL \(name): threw \(error)")
    }
}

func expect(_ condition: Bool, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) async {
    if condition {
        await results.pass()
    } else {
        let detail = message().isEmpty ? "" : " — \(message())"
        let entry = "\(currentTest)\(detail) (\(URL(fileURLWithPath: "\(file)").lastPathComponent):\(line))"
        await results.fail(entry)
        print("  FAIL \(entry)")
    }
}

func expectEqual<T: Equatable>(
    _ actual: T, _ expected: T, _ message: @autoclosure () -> String = "",
    file: StaticString = #file, line: UInt = #line
) async {
    if actual == expected {
        await results.pass()
    } else {
        let detail = message().isEmpty ? "" : " — \(message())"
        let entry = "\(currentTest)\(detail): expected \(expected), got \(actual) (\(URL(fileURLWithPath: "\(file)").lastPathComponent):\(line))"
        await results.fail(entry)
        print("  FAIL \(entry)")
    }
}

func expectNil<T>(_ value: T?, _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line) async {
    await expect(value == nil, message(), file: file, line: line)
}

func expectThrows<T>(
    _ message: @autoclosure () -> String = "", file: StaticString = #file, line: UInt = #line,
    _ body: () async throws -> T, verify: (Error) -> Bool = { _ in true }
) async {
    do {
        _ = try await body()
        await expect(false, "expected a thrown error — \(message())", file: file, line: line)
    } catch {
        await expect(verify(error), "wrong error: \(error) — \(message())", file: file, line: line)
    }
}

/// Proper nouns that stay in Latin script inside a Russian sentence: the product itself,
/// the agents, and the technologies they are named after.
let properNouns = ["Murmur", "Menu Bar", "Claude", "Codex", "Cursor", "Telegram", "NATS"]

/// Is this string Russian once the proper nouns are removed?
///
/// A blanket "no Latin letters" rule would reject «Нет проектов Murmur», which is a
/// perfectly Russian sentence containing a product name — and the point of the check is to
/// catch untranslated UI, not to ban the word Murmur from the UI.
func isRussian(_ value: String) -> Bool {
    var remainder = value
    for noun in properNouns { remainder = remainder.replacingOccurrences(of: noun, with: "") }
    return remainder.range(of: "[A-Za-z]", options: .regularExpression) == nil
}

/// Print the tally and return the process exit code.
func finish() async -> Int32 {
    let (passed, failures) = await results.summary()
    print("\n\(passed) assertions passed, \(failures.count) failed")
    for failure in failures { print("  FAIL \(failure)") }
    return failures.isEmpty ? 0 : 1
}
