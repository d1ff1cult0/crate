import Foundation
import Observation

/// Offline copies of playlists, favourites, albums and mixes. A collection made available
/// offline stays in sync: songs added to it are downloaded on the next sync, and files no
/// collection needs any more are removed.
@MainActor
@Observable
final class DownloadManager {
    enum ItemState: Equatable {
        case none, queued, downloading(Double), done, failed
    }

    private(set) var sets: [OfflineSet] = []
    private(set) var downloaded: [String: URL] = [:]
    private(set) var progress: [String: Double] = [:]
    private(set) var queue: [Track] = []
    private(set) var failures: Set<String> = []
    private(set) var totalBytes: Int64 = 0
    private(set) var isRefreshing = false

    @ObservationIgnored private var library: LibraryStore?
    @ObservationIgnored private var settings: SettingsStore?
    @ObservationIgnored private var directory: URL?
    @ObservationIgnored private var workers = 0
    @ObservationIgnored private let maxWorkers = 3
    @ObservationIgnored var onNotice: ((String) -> Void)?

    func configure(library: LibraryStore, settings: SettingsStore) {
        self.library = library
        self.settings = settings
    }

    func attach(account: ServerAccount) {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Crate/Offline/\(account.key)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        directory = dir
        reload()
    }

    func detach() {
        directory = nil
        sets = []
        downloaded = [:]
        queue = []
        progress = [:]
    }

    private var db: LibraryDatabase? { library?.db }

    private func reload() {
        guard let db, let directory else { return }
        var files: [String: URL] = [:]
        var bytes: Int64 = 0
        let rows = (try? db.reader.query("SELECT song_id, path, size FROM downloads") { ($0.text(0), $0.text(1), Int64($0.int(2))) }) ?? []
        for (id, path, size) in rows {
            let url = directory.appendingPathComponent(path)
            if FileManager.default.fileExists(atPath: url.path) {
                files[id] = url
                bytes += size
            } else {
                try? db.writer.run("DELETE FROM downloads WHERE song_id = ?", [id])
            }
        }
        downloaded = files
        totalBytes = bytes
        sets = (try? db.reader.query("SELECT kind, set_id, name, created FROM offline_sets ORDER BY created") { r in
            OfflineSet(kind: OfflineSet.Kind(rawValue: r.text(0)) ?? .playlist, setId: r.text(1), name: r.text(2), created: r.date(3) ?? Date())
        }) ?? []
    }

    // MARK: Queries

    func localURL(for trackId: String) -> URL? {
        if let url = downloaded[trackId] { return url }
        if OctoID.isExternal(trackId), let local = db?.localId(forExternal: trackId) {
            return downloaded[local]
        }
        return nil
    }

    func isAvailableOffline(_ track: Track) -> Bool {
        localURL(for: track.id) != nil
    }

    func state(for trackId: String) -> ItemState {
        if downloaded[trackId] != nil { return .done }
        if let p = progress[trackId] { return .downloading(p) }
        if queue.contains(where: { $0.id == trackId }) { return .queued }
        if failures.contains(trackId) { return .failed }
        return .none
    }

    func isOffline(_ kind: OfflineSet.Kind, _ id: String) -> Bool {
        sets.contains { $0.kind == kind && $0.setId == id }
    }

    func members(of set: OfflineSet) -> [String] {
        (try? db?.reader.query("SELECT song_id FROM offline_members WHERE kind = ? AND set_id = ? ORDER BY position", [set.kind.rawValue, set.setId]) { $0.text(0) }) ?? []
    }

    func memberTracks(of set: OfflineSet) -> [Track] {
        guard let db else { return [] }
        let ids = members(of: set)
        let local = Dictionary(db.songs(ids: ids).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let external = db.externalTracks(ids: ids.filter(OctoID.isExternal))
        return ids.compactMap { local[$0] ?? external[$0] }
    }

    func progress(of set: OfflineSet) -> (done: Int, total: Int) {
        let ids = members(of: set)
        return (ids.filter { downloaded[$0] != nil }.count, ids.count)
    }

    // MARK: Collections

    func makeOffline(_ kind: OfflineSet.Kind, id: String, name: String, tracks: [Track]) {
        guard let db else { return }
        try? db.writer.run("INSERT OR REPLACE INTO offline_sets (kind, set_id, name, created) VALUES (?,?,?,?)", [kind.rawValue, id, name, Date()])
        setMembers(kind, id: id, tracks: tracks)
        reload()
        onNotice?("Downloading “\(name)” for offline listening.")
    }

    func removeOffline(_ kind: OfflineSet.Kind, id: String) {
        guard let db else { return }
        try? db.writer.run("DELETE FROM offline_sets WHERE kind = ? AND set_id = ?", [kind.rawValue, id])
        try? db.writer.run("DELETE FROM offline_members WHERE kind = ? AND set_id = ?", [kind.rawValue, id])
        removeOrphans()
        reload()
    }

    func toggleOffline(_ kind: OfflineSet.Kind, id: String, name: String, tracks: [Track]) {
        if isOffline(kind, id) {
            removeOffline(kind, id: id)
        } else {
            makeOffline(kind, id: id, name: name, tracks: tracks)
        }
    }

    /// Individually downloaded songs live in a "songs" collection.
    func download(_ tracks: [Track]) {
        guard let db else { return }
        let existing = members(of: OfflineSet(kind: .album, setId: "songs", name: "Songs", created: Date()))
        let all = existing + tracks.map(\.id).filter { !existing.contains($0) }
        try? db.writer.run("INSERT OR IGNORE INTO offline_sets (kind, set_id, name, created) VALUES (?,?,?,?)", ["album", "songs", "Downloaded songs", Date()])
        let byId = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let known = Dictionary(db.songs(ids: existing).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        setMembers(.album, id: "songs", tracks: all.compactMap { byId[$0] ?? known[$0] })
        reload()
    }

    func removeDownload(_ trackId: String) {
        guard let db else { return }
        try? db.writer.run("DELETE FROM offline_members WHERE song_id = ?", [trackId])
        deleteFile(trackId)
        reload()
    }

    func removeAll() {
        guard let db, let directory else { return }
        try? db.writer.exec("DELETE FROM offline_sets; DELETE FROM offline_members; DELETE FROM downloads;")
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        queue = []
        reload()
    }

    private func setMembers(_ kind: OfflineSet.Kind, id: String, tracks: [Track]) {
        guard let db else { return }
        db.saveExternal(tracks.filter(\.isExternal))
        try? db.upsertSongs(tracks.filter { !$0.isExternal })
        try? db.writer.transaction {
            try db.writer.run("DELETE FROM offline_members WHERE kind = ? AND set_id = ?", [kind.rawValue, id])
            for (i, t) in tracks.enumerated() {
                try db.writer.run("INSERT OR IGNORE INTO offline_members (kind, set_id, song_id, position) VALUES (?,?,?,?)", [kind.rawValue, id, t.id, i])
            }
        }
        enqueue(tracks)
        removeOrphans()
    }

    /// Re-reads every offline collection from the server and downloads what's new.
    func refreshAll() async {
        guard let library, !isRefreshing, library.client != nil else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        for set in sets {
            switch set.kind {
            case .playlist:
                if let (_, songs) = try? await library.fetchPlaylist(set.setId) {
                    setMembers(.playlist, id: set.setId, tracks: songs)
                }
            case .favourites:
                if let starred = try? await library.client?.starred() {
                    setMembers(.favourites, id: set.setId, tracks: starred.songs + library.pendingFavourites())
                }
            case .album:
                if set.setId != "songs", let (_, songs) = try? await library.fetchAlbum(set.setId) {
                    setMembers(.album, id: set.setId, tracks: songs)
                } else {
                    enqueue(memberTracks(of: set))
                }
            case .mix:
                enqueue(memberTracks(of: set))
            }
        }
        reload()
    }

    // MARK: Workers

    private func enqueue(_ tracks: [Track]) {
        for track in tracks where downloaded[track.id] == nil && progress[track.id] == nil && !queue.contains(where: { $0.id == track.id }) {
            if let local = localURL(for: track.id), local.isFileURL { continue }
            queue.append(track)
        }
        pump()
    }

    private func pump() {
        while workers < maxWorkers, !queue.isEmpty {
            let track = queue.removeFirst()
            workers += 1
            progress[track.id] = 0
            Task {
                await download(track)
                workers -= 1
                progress[track.id] = nil
                pump()
            }
        }
    }

    private func download(_ track: Track) async {
        guard let client = library?.client, let directory, let db else { return }
        let quality = settings?.downloadQuality ?? .original
        let source: URL
        if track.isExternal {
            source = client.streamURL(id: track.id)
        } else if quality == .original {
            source = client.downloadURL(id: track.id)
        } else {
            source = client.streamURL(id: track.id, format: "mp3", maxBitRate: quality.rawValue)
        }
        let safe = String(track.id.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" })
        let partial = directory.appendingPathComponent(safe + ".part")
        let id = track.id
        do {
            let (file, mime) = try await client.fetchFile(from: source, to: partial) { fraction in
                Task { @MainActor [weak self] in
                    if self?.progress[id] != nil { self?.progress[id] = fraction }
                }
            }
            let ext = quality == .original || track.isExternal ? AudioFileType.fileExtension(mime: mime, fallback: track.suffix) : "mp3"
            let name = safe + "." + ext
            let final = directory.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: final)
            try FileManager.default.moveItem(at: file, to: final)
            let size = Int64((try? final.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            try? db.writer.run("INSERT OR REPLACE INTO downloads (song_id, path, size, created) VALUES (?,?,?,?)", [id, name, size, Date()])
            downloaded[id] = final
            totalBytes += size
            failures.remove(id)
        } catch {
            failures.insert(id)
            if error.isConnectivityError { queue.removeAll() }
        }
    }

    private func removeOrphans() {
        guard let db else { return }
        let needed = Set((try? db.reader.query("SELECT DISTINCT song_id FROM offline_members") { $0.text(0) }) ?? [])
        for id in downloaded.keys where !needed.contains(id) {
            deleteFile(id)
        }
        queue.removeAll { !needed.contains($0.id) }
    }

    private func deleteFile(_ id: String) {
        guard let db else { return }
        if let url = downloaded[id] {
            let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            try? FileManager.default.removeItem(at: url)
            totalBytes -= size
        }
        downloaded[id] = nil
        try? db.writer.run("DELETE FROM downloads WHERE song_id = ?", [id])
    }
}
