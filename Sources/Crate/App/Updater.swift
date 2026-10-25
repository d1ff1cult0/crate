import AppKit
import Foundation
import Observation

/// Updates from GitHub Releases: checks the latest release, downloads its `.zip`, swaps
/// the app bundle in place and relaunches. Library cache, downloads, settings and secrets
/// live outside the bundle, so nothing has to be set up again.
@MainActor
@Observable
final class Updater {
    enum Phase: Equatable {
        case idle, checking, upToDate, available, downloading, installing
        case failed(String)
    }

    struct Release: Equatable {
        var version: String
        var notes: String
        var archive: URL
        var page: URL
    }

    static let repository = "d1ff1cult0/crate"

    private(set) var phase: Phase = .idle
    private(set) var latest: Release?
    private(set) var lastCheck: Date?

    /// Not for the dev build, and not when running outside an app bundle (`swift run`).
    var isSupported: Bool { !AppPaths.isDev && Bundle.main.bundleURL.pathExtension == "app" }
    var currentVersion: String { AppInfo.version }

    var isUpdateAvailable: Bool {
        if case .available = phase { return true }
        return false
    }

    func check(userInitiated: Bool = false) async {
        guard isSupported, phase != .downloading, phase != .installing else { return }
        phase = .checking
        defer { lastCheck = Date() }
        do {
            var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.repository)/releases/latest")!, timeoutInterval: 20)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("Crate/\(currentVersion)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = json["tag_name"] as? String else {
                throw CrateError.invalidResponse
            }
            let assets = json["assets"] as? [[String: Any]] ?? []
            let zip = assets.first { ($0["name"] as? String)?.hasSuffix(".zip") == true }
            guard let archive = (zip?["browser_download_url"] as? String).flatMap(URL.init(string:)) else {
                throw CrateError.invalidResponse
            }
            let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            let release = Release(version: version, notes: json["body"] as? String ?? "", archive: archive,
                                  page: (json["html_url"] as? String).flatMap(URL.init(string:)) ?? archive)
            if Self.isVersion(version, newerThan: currentVersion) {
                latest = release
                phase = .available
            } else {
                latest = nil
                phase = userInitiated ? .upToDate : .idle
            }
        } catch {
            phase = userInitiated ? .failed("Couldn't check for updates. \(error.localizedDescription)") : .idle
        }
    }

    func install() async {
        guard isSupported, let latest else { return }
        phase = .downloading
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("crate-update-\(UUID().uuidString)", isDirectory: true)
        do {
            try fm.createDirectory(at: work, withIntermediateDirectories: true)
            let (downloaded, response) = try await URLSession.shared.download(from: latest.archive)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw CrateError.invalidResponse }
            let zip = work.appendingPathComponent("Crate.zip")
            try fm.moveItem(at: downloaded, to: zip)
            try await Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, work.path])
            guard let newApp = try fm.contentsOfDirectory(at: work, includingPropertiesForKeys: nil).first(where: { $0.pathExtension == "app" }),
                  Bundle(url: newApp)?.bundleIdentifier == AppPaths.bundleID else {
                throw CrateError.invalidResponse
            }
            phase = .installing
            let target = Bundle.main.bundleURL
            let backup = target.deletingLastPathComponent().appendingPathComponent(".Crate-previous-\(UUID().uuidString).app")
            try fm.moveItem(at: target, to: backup)
            do {
                try fm.moveItem(at: newApp, to: target)
            } catch {
                try? fm.moveItem(at: backup, to: target)
                throw error
            }
            try? fm.removeItem(at: backup)
            try? fm.removeItem(at: work)
            relaunch(target)
        } catch {
            try? fm.removeItem(at: work)
            phase = .failed("The update couldn't be installed. \(error.localizedDescription) You can download it from GitHub instead.")
        }
    }

    /// Opens the new copy once this process has quit.
    private func relaunch(_ app: URL) {
        let script = "while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"$0\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, app.path]
        try? process.run()
        NSApp.terminate(nil)
    }

    private static func run(_ tool: String, _ arguments: [String]) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tool)
            process.arguments = arguments
            process.terminationHandler = { finished in
                if finished.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: CrateError.invalidResponse)
                }
            }
            do { try process.run() } catch { continuation.resume(throwing: error) }
        }
    }

    /// Compares dotted versions numerically ("1.10.0" > "1.9.2").
    nonisolated static func isVersion(_ candidate: String, newerThan current: String) -> Bool {
        let a = candidate.split(separator: ".").map { Int($0) ?? 0 }
        let b = current.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}
