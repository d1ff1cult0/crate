import Foundation
import Observation

/// Brings octo-fiesta tracks to a local file before they play.
///
/// octo-fiesta answers `stream` for an external song only after it has downloaded the
/// whole file from the provider, which takes seconds to minutes. Players that stream it
/// directly time out and report an error (what Feishin does). Crate fetches the file with
/// a patient timeout instead, plays it locally (so seeking works too) and prefetches the
/// external songs coming up in the queue.
@MainActor
@Observable
final class RemoteFetcher {
    /// External songs being fetched right now. Only start and end are published: octo-fiesta
    /// sends the file in one burst at the end, and per-chunk progress updates would make
    /// every visible row redraw hundreds of times a second.
    private(set) var active: Set<String> = []
    private(set) var failed: Set<String> = []

    @ObservationIgnored private var tasks: [String: Task<URL, Error>] = [:]
    @ObservationIgnored private var files: [String: URL] = [:]
    @ObservationIgnored private var client: SubsonicClient?
    @ObservationIgnored private var directory: URL?
    @ObservationIgnored private let maxCacheBytes: Int64 = 3 * 1024 * 1024 * 1024

    func configure(client: SubsonicClient?) {
        self.client = client
        files = [:]
        guard let client else {
            directory = nil
            return
        }
        let dir = AppPaths.remote(client.account.key)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        directory = dir
        let contents = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for file in contents where file.pathExtension != "part" {
            files[file.deletingPathExtension().lastPathComponent] = file
        }
    }

    private static func safeName(_ id: String) -> String {
        String(id.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" })
    }

    /// The fetched file, from the in-memory index (cheap enough for views to call per row).
    func cachedFile(for id: String) -> URL? {
        files[Self.safeName(id)]
    }

    /// The fetched file if it's still on disk; used right before playback.
    func validFile(for id: String) -> URL? {
        guard let file = cachedFile(for: id) else { return nil }
        if FileManager.default.fileExists(atPath: file.path) { return file }
        files[Self.safeName(id)] = nil
        return nil
    }

    func isFetching(_ id: String) -> Bool { active.contains(id) }

    func fetch(_ track: Track) async throws -> URL {
        if let file = validFile(for: track.id) {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return file
        }
        if let task = tasks[track.id] { return try await task.value }
        guard let client, let directory else { throw CrateError.notConnected }

        let name = Self.safeName(track.id)
        let partial = directory.appendingPathComponent(name + ".part")
        let source = client.streamURL(id: track.id)
        let id = track.id
        failed.remove(id)
        active.insert(id)
        let task = Task<URL, Error> {
            let (file, mime) = try await client.fetchFile(from: source, to: partial)
            let final = directory.appendingPathComponent(name + "." + AudioFileType.fileExtension(mime: mime, fallback: track.suffix))
            try? FileManager.default.removeItem(at: final)
            try FileManager.default.moveItem(at: file, to: final)
            return final
        }
        tasks[id] = task
        defer {
            tasks[id] = nil
            active.remove(id)
        }
        do {
            let url = try await task.value
            files[name] = url
            trimIfNeeded()
            return url
        } catch {
            failed.insert(id)
            throw error
        }
    }

    /// Starts fetching upcoming external songs (two at a time) so they play without a wait.
    func prefetch(_ tracks: [Track]) {
        let pending = tracks.filter { $0.isExternal && cachedFile(for: $0.id) == nil && tasks[$0.id] == nil && !failed.contains($0.id) }
        let slots = max(0, 2 - tasks.count)
        for track in pending.prefix(slots) {
            Task { _ = try? await fetch(track) }
        }
    }

    private func trimIfNeeded() {
        guard let directory else { return }
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let contents = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        var entries = contents.compactMap { url -> (URL, Int64, Date)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, Int64(values.fileSize ?? 0), values.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(Int64(0)) { $0 + $1.1 }
        guard total > maxCacheBytes else { return }
        entries.sort { $0.2 < $1.2 }
        for (url, size, _) in entries where total > maxCacheBytes {
            try? FileManager.default.removeItem(at: url)
            files[url.deletingPathExtension().lastPathComponent] = nil
            total -= size
        }
    }

    var diskUsage: Int64 {
        guard let directory else { return 0 }
        return ImageCache.directorySize(directory)
    }

    func clear() {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        files = [:]
    }
}
