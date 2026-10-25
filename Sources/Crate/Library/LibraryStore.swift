import Foundation
import Observation

/// Owns the library cache for the signed-in account: what's shown comes from SQLite
/// immediately, and a background sync keeps it current. Also the single place where
/// ratings, favourites and playlist edits happen, including the octo-fiesta dance for
/// external songs (queue the action until the song exists locally, then replay it).
@MainActor
@Observable
final class LibraryStore {
    enum SyncPhase: Equatable {
        case idle
        case syncing(String, Double?)
        case failed(String)
    }

    private(set) var db: LibraryDatabase?
    private(set) var client: SubsonicClient?

    var playlists: [Playlist] = []
    var genres: [Genre] = []
    var pinnedIDs: [String] = []
    var homeLists: [String: [Album]] = [:]
    var syncPhase: SyncPhase = .idle
    var lastSync: Date?
    var lastFullSync: Date?
    var songCount = 0
    var albumCount = 0
    var artistCount = 0
    var pendingCount = 0
    /// Bumped whenever cached library content changes in bulk, so views re-query.
    var revision = 0

    // Optimistic overrides so every visible row reflects a change at once.
    var ratingOverrides: [String: Int] = [:]
    var starOverrides: [String: Bool] = [:]

    @ObservationIgnored var onConnectivityError: (() -> Void)?
    @ObservationIgnored var onSyncFinished: (() -> Void)?
    /// Album id → album cover id. Songs carry per-file cover ids (`mf-…`); showing the
    /// album's cover instead lets every row share the album artwork already cached.
    @ObservationIgnored private var albumCovers: [String: String] = [:]
    @ObservationIgnored var onNotice: ((String) -> Void)?
    @ObservationIgnored private var syncTask: Task<Void, Never>?
    @ObservationIgnored private var externalAlbumCache: [String: (Album, [Track])] = [:]
    @ObservationIgnored private var noticedExternalRating = false

    var isSyncing: Bool {
        if case .syncing = syncPhase { return true }
        return false
    }

    // MARK: Lifecycle

    func attach(client: SubsonicClient) {
        self.client = client
        let dir = AppPaths.account(client.account.key)
        do {
            db = try LibraryDatabase(directory: dir)
        } catch {
            db = nil
            syncPhase = .failed("Couldn't open the library cache: \(error)")
        }
        loadCached()
    }

    func detach() {
        syncTask?.cancel()
        client = nil
        db = nil
        playlists = []
        genres = []
        pinnedIDs = []
        homeLists = [:]
        ratingOverrides = [:]
        starOverrides = [:]
        syncPhase = .idle
    }

    private func loadCached() {
        guard let db else { return }
        playlists = sortPlaylists(db.playlists())
        genres = db.genres()
        pinnedIDs = db.pins()
        lastSync = db.meta("lastSync").flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
        lastFullSync = db.meta("lastFullSync").flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
        for key in ["recent", "newest", "frequent", "starredAlbums"] {
            if let raw = db.meta("home.\(key)") {
                homeLists[key] = albums(ids: raw.components(separatedBy: ","))
            }
        }
        refreshCounts()
        albumCovers = db.albumCoverIndex()
    }

    func cover(for track: Track) -> String? {
        if let albumId = track.albumId, let cover = albumCovers[albumId] { return cover }
        return track.coverArt
    }

    private func refreshCounts() {
        guard let db else { return }
        songCount = db.songCount()
        albumCount = db.albumCount()
        artistCount = db.artistCount()
        pendingCount = db.pendingCount()
    }

    private func sortPlaylists(_ list: [Playlist]) -> [Playlist] {
        list.sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }

    func albums(ids: [String]) -> [Album] {
        guard let db else { return [] }
        return ids.compactMap { db.album(id: $0) }
    }

    /// Runs `body` against the database off the main thread. Writes can wait behind a
    /// long sync transaction, and the UI must never wait with them.
    nonisolated func background<T: Sendable>(_ db: LibraryDatabase, _ body: @escaping @Sendable (LibraryDatabase) throws -> T) async throws -> T {
        try await Task.detached(priority: .utility) { try body(db) }.value
    }

    // MARK: Sync

    func startSync(full: Bool = false) {
        guard !isSyncing else { return }
        syncTask = Task { await sync(full: full) }
    }

    func sync(full forceFull: Bool = false) async {
        guard let client, let db, !isSyncing else { return }
        syncPhase = .syncing("Checking for changes…", nil)
        do {
            async let playlistsTask = client.playlists()
            async let genresTask = client.genres()
            async let starredTask = client.starred()
            async let scanTask = client.scanStatus()
            let (newPlaylists, newGenres, starred, scan) = try await (playlistsTask, genresTask, starredTask, scanTask)

            try await background(db) { db in
                try db.replacePlaylists(newPlaylists)
                try db.replaceGenres(newGenres)
            }
            playlists = sortPlaylists(newPlaylists)
            genres = newGenres.sorted { $0.songCount > $1.songCount }
            pinnedIDs = pinnedIDs.filter { id in newPlaylists.contains { $0.id == id } }

            let staleFull = lastFullSync.map { Date().timeIntervalSince($0) > 3 * 86400 } ?? true
            let scanChanged = scan?.lastScan != db.meta("lastScan")
            if forceFull || staleFull || db.songCount() == 0 {
                try await fullSync(client: client, db: db, expectedSongs: scan?.count)
            } else if scanChanged {
                try await incrementalSync(client: client, db: db)
            }

            let starredIds = Set(starred.songs.map(\.id))
            try await background(db) { db in
                try db.upsertSongs(starred.songs)
                try db.setStarredSongs(starredIds)
                try db.upsertAlbums(starred.albums)
            }
            starOverrides = starOverrides.filter { OctoID.isExternal($0.key) }

            try await refreshHomeLists(client: client, db: db)

            db.setMeta("lastScan", scan?.lastScan)
            let now = Date()
            db.setMeta("lastSync", String(now.timeIntervalSince1970))
            lastSync = now
            refreshCounts()
            albumCovers = db.albumCoverIndex()
            revision += 1
            syncPhase = .idle
            onSyncFinished?()
            await processPending()
        } catch is CancellationError {
            syncPhase = .idle
        } catch {
            if error.isConnectivityError {
                onConnectivityError?()
                syncPhase = .idle
            } else {
                syncPhase = .failed(error.localizedDescription)
            }
        }
    }

    private func fullSync(client: SubsonicClient, db: LibraryDatabase, expectedSongs: Int?) async throws {
        let generation = Int(Date().timeIntervalSince1970)

        syncPhase = .syncing("Indexing albums…", 0)
        var offset = 0
        while true {
            let page = try await client.albumList(type: "alphabeticalByName", size: 500, offset: offset)
            try await background(db) { try $0.upsertAlbums(page, generation: generation) }
            offset += page.count
            syncPhase = .syncing("Indexing albums… \(offset.formatted())", 0.05)
            if page.count < 500 { break }
        }

        syncPhase = .syncing("Indexing artists…", 0.08)
        let artists = try await client.artists()
        try await background(db) { try $0.upsertArtists(artists, generation: generation) }

        // Songs: search3 with an empty query pages through the whole library. Four pages
        // in flight keeps a 76k-song library to well under a minute.
        let pageSize = 500
        let total = max(expectedSongs ?? 0, 1)
        var fetched = 0
        var nextOffset = 0
        var finished = false
        try await withThrowingTaskGroup(of: [Track].self) { group in
            func enqueue() {
                guard !finished else { return }
                let current = nextOffset
                nextOffset += pageSize
                group.addTask {
                    try await client.search("", songs: pageSize, albums: 0, artists: 0, songOffset: current).songs
                }
            }
            for _ in 0..<4 { enqueue() }
            while let page = try await group.next() {
                try Task.checkCancellation()
                if page.count < pageSize { finished = true }
                try await background(db) { try $0.upsertSongs(page, generation: generation) }
                fetched += page.count
                syncPhase = .syncing("Indexing songs… \(fetched.formatted()) of \(total.formatted())", 0.1 + 0.9 * min(Double(fetched) / Double(total), 1))
                if fetched >= 2000, songCount == 0 {
                    refreshCounts()
                    revision += 1
                }
                enqueue()
            }
        }

        try await background(db) { db in
            try db.deleteStale(table: "songs", generation: generation)
            try db.deleteStale(table: "albums", generation: generation)
            try db.deleteStale(table: "artists", generation: generation)
        }
        let now = Date()
        db.setMeta("lastFullSync", String(now.timeIntervalSince1970))
        lastFullSync = now
    }

    /// After a scan (octo-fiesta triggers one for every track it fetches), pick up the
    /// albums added since the last sync instead of re-indexing everything.
    private func incrementalSync(client: SubsonicClient, db: LibraryDatabase) async throws {
        let since = (lastSync ?? .distantPast).addingTimeInterval(-6 * 3600)
        syncPhase = .syncing("Picking up new music…", nil)
        var fresh: [Album] = []
        var offset = 0
        pages: while offset < 2000 {
            let page = try await client.albumList(type: "newest", size: 100, offset: offset)
            for album in page {
                guard let created = album.created, created >= since else { break pages }
                fresh.append(album)
            }
            if page.count < 100 { break }
            offset += 100
        }
        for album in fresh {
            let (full, songs) = try await client.album(id: album.id)
            try await background(db) { db in
                try db.upsertAlbums([full])
                try db.upsertSongs(songs)
            }
        }
        if !fresh.isEmpty {
            let artists = try await client.artists()
            let generation = Int(Date().timeIntervalSince1970)
            try await background(db) { try $0.upsertArtists(artists, generation: generation) }
        }
    }

    private func refreshHomeLists(client: SubsonicClient, db: LibraryDatabase) async throws {
        async let recent = client.albumList(type: "recent", size: 24)
        async let newest = client.albumList(type: "newest", size: 24)
        async let frequent = client.albumList(type: "frequent", size: 24)
        let lists = try await ["recent": recent, "newest": newest, "frequent": frequent]
        for (key, albums) in lists {
            try await background(db) { try $0.upsertAlbums(albums) }
            db.setMeta("home.\(key)", albums.map(\.id).joined(separator: ","))
            homeLists[key] = albums
        }
    }

    // MARK: Details (cache first, then network)

    func cachedAlbum(_ id: String) -> (Album, [Track])? {
        if let external = externalAlbumCache[id] { return external }
        guard let db, let album = db.album(id: id) else { return nil }
        let songs = db.songs(albumId: id)
        return songs.isEmpty ? nil : (album, songs)
    }

    func fetchAlbum(_ id: String) async throws -> (Album, [Track]) {
        guard let client else { throw CrateError.notConnected }
        let result = try await client.album(id: id)
        if OctoID.isExternal(id) || OctoID.isExternalPlaylist(id) {
            externalAlbumCache[id] = result
            db?.saveExternal(result.1)
        } else if let db {
            let (album, songs) = result
            try? await background(db) { db in
                try db.upsertAlbums([album])
                try db.upsertSongs(songs)
            }
        }
        return result
    }

    func cachedPlaylistSongs(_ playlist: Playlist) -> [Track]? {
        db?.playlistSongs(playlist, requireFresh: false)
    }

    func fetchPlaylist(_ id: String) async throws -> (Playlist, [Track]) {
        guard let client else { throw CrateError.notConnected }
        let (playlist, songs) = try await client.playlist(id: id)
        if let db {
            try? await background(db) { try $0.savePlaylistSongs(playlist, songs: songs) }
        }
        if let index = playlists.firstIndex(where: { $0.id == id }) {
            playlists[index] = playlist
        }
        return (playlist, songs)
    }

    /// Cached songs when there are any, otherwise fetched.
    func songs(of playlist: Playlist) async -> [Track] {
        if let cached = cachedPlaylistSongs(playlist), !cached.isEmpty { return cached }
        return (try? await fetchPlaylist(playlist.id).1) ?? []
    }

    func songs(ofAlbum id: String) async -> [Track] {
        if let cached = cachedAlbum(id) { return cached.1 }
        return (try? await fetchAlbum(id).1) ?? []
    }

    func playlist(id: String) -> Playlist? {
        playlists.first { $0.id == id }
    }

    // MARK: Pins

    func isPinned(_ playlistId: String) -> Bool { pinnedIDs.contains(playlistId) }

    func togglePin(_ playlistId: String) {
        if let index = pinnedIDs.firstIndex(of: playlistId) {
            pinnedIDs.remove(at: index)
        } else {
            pinnedIDs.append(playlistId)
        }
        db?.savePins(pinnedIDs)
    }

    func movePin(_ id: String, before target: String?) {
        guard let from = pinnedIDs.firstIndex(of: id) else { return }
        pinnedIDs.remove(at: from)
        if let target, let to = pinnedIDs.firstIndex(of: target) {
            pinnedIDs.insert(id, at: to)
        } else {
            pinnedIDs.append(id)
        }
        db?.savePins(pinnedIDs)
    }

    var pinnedPlaylists: [Playlist] {
        pinnedIDs.compactMap { id in playlists.first { $0.id == id } }
    }

    // MARK: Ratings & favourites

    func rating(of track: Track) -> Int { ratingOverrides[track.id] ?? track.rating }

    func isStarred(_ track: Track) -> Bool { starOverrides[track.id] ?? track.starred }

    func isStarred(album: Album) -> Bool { starOverrides[album.id] ?? album.starred }

    func setRating(_ track: Track, _ rating: Int) {
        let rating = max(0, min(5, rating))
        ratingOverrides[track.id] = rating
        guard let client else { return }
        if !track.isExternal {
            db?.setRating(songId: track.id, rating)
            Task {
                do { try await client.setRating(id: track.id, rating: rating) } catch { report(error, "Couldn't save the rating") }
            }
            return
        }
        Task {
            if let local = await resolveLocal(track.id) {
                ratingOverrides[local] = rating
                db?.setRating(songId: local, rating)
                try? await client.setRating(id: local, rating: rating)
            } else {
                db?.addPending(externalId: track.id, action: "rate", value: String(rating))
                pendingCount = db?.pendingCount() ?? 0
                if !noticedExternalRating {
                    noticedExternalRating = true
                    onNotice?("Rating saved. It's applied once octo-fiesta has added the song to your library.")
                }
            }
        }
    }

    func toggleStar(_ track: Track) {
        let starred = !isStarred(track)
        starOverrides[track.id] = starred
        guard let client else { return }
        if !track.isExternal {
            db?.setStarred(songId: track.id, starred)
            Task {
                do {
                    if starred { try await client.star(songId: track.id) } else { try await client.unstar(songId: track.id) }
                } catch {
                    starOverrides[track.id] = !starred
                    report(error, "Couldn't update favourites")
                }
            }
            return
        }
        db?.saveExternal([track])
        Task {
            if let local = await resolveLocal(track.id) {
                starOverrides[local] = starred
                db?.setStarred(songId: local, starred)
                if starred { try? await client.star(songId: local) } else { try? await client.unstar(songId: local) }
                return
            }
            if starred {
                // octo-fiesta answers a star on an external song by downloading it for
                // good; the actual favourite is set on the local copy once it exists.
                try? await client.star(songId: track.id)
                db?.addPending(externalId: track.id, action: "star", value: "1")
                onNotice?("Added to favourites. octo-fiesta is adding “\(track.title)” to your library.")
            } else {
                db?.addPending(externalId: track.id, action: "unstar", value: "1")
            }
            pendingCount = db?.pendingCount() ?? 0
        }
    }

    func toggleStar(album: Album) {
        let starred = !isStarred(album: album)
        starOverrides[album.id] = starred
        guard let client else { return }
        db?.setStarred(albumId: album.id, starred)
        Task {
            do {
                if album.isExternalPlaylist {
                    // Starring a provider playlist makes octo-fiesta download all of it.
                    if starred {
                        try await client.star(songId: album.id)
                        onNotice?("octo-fiesta is downloading “\(album.name)” into your library.")
                    }
                } else if starred {
                    try await client.star(albumId: album.id)
                    if album.isExternal { onNotice?("octo-fiesta is adding “\(album.name)” to your library.") }
                } else {
                    try await client.unstar(albumId: album.id)
                }
            } catch {
                starOverrides[album.id] = !starred
                report(error, "Couldn't update favourites")
            }
        }
    }

    /// Favourited external songs that aren't in the library yet (shown with Favourites).
    func pendingFavourites() -> [Track] {
        guard let db else { return [] }
        let ids = db.pendingActions().filter { $0.action == "star" }.map(\.externalId)
        let tracks = db.externalTracks(ids: ids)
        return ids.compactMap { tracks[$0] }
    }

    // MARK: Playlists

    func createPlaylist(name: String, tracks: [Track]) async -> Playlist? {
        guard let client else { return nil }
        let local = tracks.filter { !$0.isExternal }.map(\.id)
        let external = tracks.filter(\.isExternal)
        do {
            guard let playlist = try await client.createPlaylist(name: name, songIds: local) else { return nil }
            await refreshPlaylists()
            if !external.isEmpty {
                await add(external, to: playlist.id)
            }
            return playlists.first { $0.id == playlist.id } ?? playlist
        } catch {
            report(error, "Couldn't create the playlist")
            return nil
        }
    }

    func add(_ tracks: [Track], to playlistId: String) async {
        guard let client else { return }
        let local = tracks.filter { !$0.isExternal }.map(\.id)
        let external = tracks.filter(\.isExternal)
        let name = playlist(id: playlistId)?.displayName ?? "playlist"
        do {
            if !local.isEmpty {
                try await client.updatePlaylist(id: playlistId, add: local)
                onNotice?(tracks.count == 1 ? "Added to \(name)." : "Added \(local.count) songs to \(name).")
            }
        } catch {
            report(error, "Couldn't add to \(name)")
        }
        guard !external.isEmpty else {
            await refreshPlaylists()
            return
        }
        db?.saveExternal(external)
        onNotice?(external.count == 1
            ? "Adding “\(external[0].title)” to \(name). octo-fiesta fetches it first, which can take a minute."
            : "Adding \(external.count) songs to \(name). octo-fiesta fetches them first.")
        for track in external {
            if let local = await resolveLocal(track.id) {
                try? await client.updatePlaylist(id: playlistId, add: [local])
                continue
            }
            do {
                try await client.updatePlaylist(id: playlistId, add: [track.id])
            } catch {
                // Retry once the song shows up in the library.
                db?.addPending(externalId: track.id, action: "playlist", value: playlistId)
            }
        }
        pendingCount = db?.pendingCount() ?? 0
        await refreshPlaylists()
    }

    func remove(indexes: [Int], from playlistId: String) async {
        guard let client else { return }
        do {
            try await client.updatePlaylist(id: playlistId, removeIndexes: indexes)
            await refreshPlaylists()
        } catch {
            report(error, "Couldn't update the playlist")
        }
    }

    func rename(playlistId: String, to name: String) async {
        guard let client else { return }
        do {
            try await client.updatePlaylist(id: playlistId, name: name)
            await refreshPlaylists()
        } catch {
            report(error, "Couldn't rename the playlist")
        }
    }

    func delete(playlistId: String) async {
        guard let client else { return }
        do {
            try await client.deletePlaylist(id: playlistId)
            pinnedIDs.removeAll { $0 == playlistId }
            db?.savePins(pinnedIDs)
            await refreshPlaylists()
        } catch {
            report(error, "Couldn't delete the playlist")
        }
    }

    func refreshPlaylists() async {
        guard let client, let db else { return }
        if let fresh = try? await client.playlists() {
            try? await background(db) { try $0.replacePlaylists(fresh) }
            playlists = sortPlaylists(fresh)
        }
    }

    // MARK: Scrobbling

    func scrobble(_ track: Track, at time: Date, submission: Bool) {
        guard let client else { return }
        if submission, !track.isExternal {
            db?.recordPlay(songId: track.id)
        }
        Task {
            if !track.isExternal {
                try? await client.scrobble(id: track.id, time: submission ? time : nil, submission: submission)
                return
            }
            // octo-fiesta silently drops scrobbles for songs that aren't local yet.
            if let local = await resolveLocal(track.id) {
                try? await client.scrobble(id: local, time: submission ? time : nil, submission: submission)
            } else if submission {
                db?.saveExternal([track])
                db?.addPending(externalId: track.id, action: "scrobble", value: String(time.timeIntervalSince1970))
                pendingCount = db?.pendingCount() ?? 0
            }
        }
    }

    // MARK: octo-fiesta resolution

    /// The library id of an external song once octo-fiesta has added it (getSong on an
    /// external id answers with the local song when a mapping exists).
    func resolveLocal(_ externalId: String) async -> String? {
        guard OctoID.isExternal(externalId) else { return externalId }
        if let mapped = db?.localId(forExternal: externalId) { return mapped }
        guard let client, let song = try? await client.song(id: externalId), !song.isExternal else { return nil }
        db?.mapExternal(externalId, to: song.id)
        if let db { try? await background(db) { try $0.upsertSongs([song]) } }
        return song.id
    }

    func processPending() async {
        guard let client, let db else { return }
        let actions = db.pendingActions()
        guard !actions.isEmpty else { return }
        let grouped = Dictionary(grouping: actions, by: \.externalId)
        for (externalId, list) in grouped {
            guard let local = await resolveLocal(externalId) else {
                // Give up on songs that never made it into the library after a month.
                for action in list where Date().timeIntervalSince(action.created) > 30 * 86400 {
                    db.removePending(rowId: action.rowId)
                }
                continue
            }
            for action in list {
                do {
                    switch action.action {
                    case "rate":
                        let rating = Int(action.value) ?? 0
                        try await client.setRating(id: local, rating: rating)
                        db.setRating(songId: local, rating)
                        ratingOverrides[local] = rating
                    case "star":
                        try await client.star(songId: local)
                        db.setStarred(songId: local, true)
                        starOverrides[local] = true
                    case "unstar":
                        try await client.unstar(songId: local)
                        db.setStarred(songId: local, false)
                        starOverrides[local] = false
                    case "scrobble":
                        let time = Double(action.value).map(Date.init(timeIntervalSince1970:)) ?? action.created
                        try await client.scrobble(id: local, time: time, submission: true)
                    case "playlist":
                        try await client.updatePlaylist(id: action.value, add: [local])
                    default:
                        break
                    }
                    db.removePending(rowId: action.rowId)
                } catch {
                    if error.isConnectivityError { return }
                    db.removePending(rowId: action.rowId)
                }
            }
        }
        pendingCount = db.pendingCount()
    }

    // MARK: Errors

    private func report(_ error: Error, _ message: String) {
        if error.isConnectivityError {
            onConnectivityError?()
            onNotice?("\(message): you're offline.")
        } else {
            onNotice?("\(message). \(error.localizedDescription)")
        }
    }
}
