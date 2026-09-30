// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MurmurMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "MurmurMenuBar", targets: ["MurmurMenuBar"]),
        .executable(name: "MurmurMenuBarCoreTests", targets: ["MurmurMenuBarCoreTests"]),
    ],
    targets: [
        // Everything decidable without a screen lives here: CLI discovery, argv
        // construction, JSON decoding, health mapping and the Russian strings. The
        // executable target holds only SwiftUI views, so the logic stays testable
        // without a running Murmur, a window server or a model.
        .target(name: "MurmurMenuBarCore"),
        .executableTarget(name: "MurmurMenuBar", dependencies: ["MurmurMenuBarCore"]),

        // The tests are an EXECUTABLE, not an XCTest bundle, because XCTest ships with
        // Xcode and this machine has only the Command Line Tools. A test suite that can
        // only run on a machine with Xcode installed is a test suite that does not run in
        // CI, so the harness is ~60 lines and `swift run MurmurMenuBarCoreTests` works
        // anywhere the package builds.
        .executableTarget(name: "MurmurMenuBarCoreTests", dependencies: ["MurmurMenuBarCore"]),
    ]
)
