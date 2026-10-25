// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Crate",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Crate",
            path: "Sources/Crate",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        // Run with scripts/test.sh (or `make test`): with only the Command Line Tools,
        // Swift Testing needs its framework path passed to every target.
        .testTarget(
            name: "CrateTests",
            dependencies: ["Crate"],
            path: "Tests/CrateTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
