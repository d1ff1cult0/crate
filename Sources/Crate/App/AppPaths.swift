import Foundation

/// Where Crate keeps its data. The development variant ("Crate Dev", bundle id
/// `com.jplessers.crate.dev`, built with `VARIANT=dev scripts/build-app.sh`) gets its own
/// folders, preferences, secrets and URL scheme, so testing never touches the installed app.
enum AppPaths {
    static let bundleID = Bundle.main.bundleIdentifier ?? "com.jplessers.crate"
    static let isDev = bundleID.hasSuffix(".dev")
    static let folderName = isDev ? "Crate Dev" : "Crate"
    static let urlScheme = isDev ? "crate-dev" : "crate"

    /// ~/Library/Application Support/Crate
    static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(folderName, isDirectory: true)
    }

    /// ~/Library/Caches/Crate
    static var caches: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(folderName, isDirectory: true)
    }

    static func account(_ key: String) -> URL { support.appendingPathComponent("Accounts/\(key)", isDirectory: true) }
    static func offline(_ key: String) -> URL { support.appendingPathComponent("Offline/\(key)", isDirectory: true) }
    static var artworkRoot: URL { caches.appendingPathComponent("Artwork", isDirectory: true) }
    static func artwork(_ key: String) -> URL { artworkRoot.appendingPathComponent(key, isDirectory: true) }
    static func remote(_ key: String) -> URL { caches.appendingPathComponent("Remote/\(key)", isDirectory: true) }
    static var secrets: URL { support.appendingPathComponent("secrets.bin") }
}
