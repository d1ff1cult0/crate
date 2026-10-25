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
    /// External song id → fetch progress (0…1; octo-fiesta often reports nothing until done).
    private(set) var active: [String: Double] = [:]
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
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Crate/Remote/\(client.account.key)", isDirectory: true)
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

    func cachedFile(for id: String) -> URL? {
        guard let file = files[Self.safeName(id)] else { return nil }
        if FileManager.default.fileExists(atPath: file.path) { return file }
        files[Self.safeName(id)] = nil
        return nil
    }

    func isFetching(_ id: String) -> Bool { active[id] != nil }

    func fetch(_ track: Track) async throws -> URL {
        if let file = cachedFile(for: track.id) {
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
        active[id] = 0
        let task = Task<URL, Error> {
            let (file, mime) = try await client.fetchFile(from: source, to: partial) { fraction in
                Task { @MainActor [weak self] in
                    if self?.active[id] != nil { self?.active[id] = fraction }
                }
            }
            let final = directory.appendingPathComponent(name + "." + AudioFileType.fileExtension(mime: mime, fallback: track.suffix))
            try? FileManager.default.removeItem(at: final)
            try FileManager.default.moveItem(at: file, to: final)
            return final
        }
        tasks[id] = task
        defer {
            tasks[id] = nil
            active[id] = nil
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
