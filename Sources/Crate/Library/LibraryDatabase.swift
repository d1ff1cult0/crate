import Foundation

enum AlbumSort: String, CaseIterable, Identifiable, Sendable {
    case name, artist, recentlyAdded, year, mostPlayed, recentlyPlayed, random
    var id: String { rawValue }
    var label: String {
        switch self {
        case .name: "Name"
        case .artist: "Artist"
        case .recentlyAdded: "Recently added"
        case .year: "Year"
        case .mostPlayed: "Most played"
        case .recentlyPlayed: "Recently played"
        case .random: "Random"
        }
    }

    var sql: String {
        switch self {
        case .name: "sort_name COLLATE NOCASE ASC"
        case .artist: "artist COLLATE NOCASE ASC, year ASC, sort_name ASC"
        case .recentlyAdded: "created DESC"
        case .year: "year DESC, sort_name ASC"
        case .mostPlayed: "play_count DESC, sort_name ASC"
        case .recentlyPlayed: "played DESC NULLS LAST"
        case .random: "random()"
        }
    }
}

enum SongSort: String, CaseIterable, Identifiable, Sendable {
    case title, artist, album, recentlyAdded, mostPlayed, rating, duration
    var id: String { rawValue }
    var label: String {
        switch self {
        case .title: "Title"
        case .artist: "Artist"
        case .album: "Album"
        case .recentlyAdded: "Recently added"
        case .mostPlayed: "Most played"
        case .rating: "Rating"
        case .duration: "Duration"
        }
    }

    var sql: String {
        switch self {
        case .title: "title COLLATE NOCASE ASC"
        case .artist: "artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC, disc ASC, track ASC"
        case .album: "album COLLATE NOCASE ASC, disc ASC, track ASC"
        case .recentlyAdded: "created DESC"
        case .mostPlayed: "play_count DESC"
        case .rating: "rating DESC, play_count DESC"
        case .duration: "duration DESC"
        }
    }
}

struct OfflineSet: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable { case playlist, favourites, album, mix }
    var kind: Kind
    var setId: String
    var name: String
    var created: Date
    var id: String { "\(kind.rawValue):\(setId)" }
}

struct PendingAction: Sendable {
    var rowId: Int
    var externalId: String
    var action: String
    var value: String
    var created: Date
}

struct PlayRecord: Sendable {
    var songId: String
    var artist: String
    var playedAt: Date
    var listened: Double
    var skipped: Bool
    var autoplay: Bool
}

/// The on-disk library index for one account. Everything the UI shows comes from here
/// first, so launching never waits for the network.
final class LibraryDatabase: @unchecked Sendable {
    let writer: SQLiteConnection
    let reader: SQLiteConnection
    let url: URL

    static let songColumns = "id, title, artist, artist_id, album, album_id, album_artist, cover_art, duration, track, disc, year, genre, suffix, content_type, bitrate, size, starred, rating, play_count, played, created"
    static let albumColumns = "id, name, artist, artist_id, cover_art, song_count, duration, year, genre, created, starred, rating, play_count, played"

    init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("library.sqlite")
        writer = try SQLiteConnection(path: url.path, readOnly: false, label: "writer")
        try Self.migrate(writer)
        reader = try SQLiteConnection(path: url.path, readOnly: true, label: "reader")
    }

    private static func migrate(_ db: SQLiteConnection) throws {
        try db.exec("""
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS songs (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, artist_id TEXT, album TEXT, album_id TEXT,
            album_artist TEXT, cover_art TEXT, duration INTEGER, track INTEGER, disc INTEGER, year INTEGER,
            genre TEXT, suffix TEXT, content_type TEXT, bitrate INTEGER, size INTEGER,
            starred INTEGER NOT NULL DEFAULT 0, rating INTEGER NOT NULL DEFAULT 0, play_count INTEGER NOT NULL DEFAULT 0,
            played REAL, created REAL, title_key TEXT, artist_key TEXT, gen INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS songs_album ON songs(album_id, disc, track);
        CREATE INDEX IF NOT EXISTS songs_artist ON songs(artist_id);
        CREATE INDEX IF NOT EXISTS songs_genre ON songs(genre COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS songs_title_key ON songs(title_key);
        CREATE INDEX IF NOT EXISTS songs_artist_key ON songs(artist_key);
        CREATE INDEX IF NOT EXISTS songs_created ON songs(created);
        CREATE INDEX IF NOT EXISTS songs_starred ON songs(starred);
        CREATE TABLE IF NOT EXISTS albums (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT, artist_id TEXT, cover_art TEXT, song_count INTEGER,
            duration INTEGER, year INTEGER, genre TEXT, created REAL, starred INTEGER NOT NULL DEFAULT 0,
            rating INTEGER NOT NULL DEFAULT 0, play_count INTEGER NOT NULL DEFAULT 0, played REAL, sort_name TEXT,
            gen INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS albums_artist ON albums(artist_id);
        CREATE INDEX IF NOT EXISTS albums_sort ON albums(sort_name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS albums_created ON albums(created);
        CREATE INDEX IF NOT EXISTS albums_genre ON albums(genre COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS artists (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, cover_art TEXT, album_count INTEGER, starred INTEGER NOT NULL DEFAULT 0,
            sort_name TEXT, name_key TEXT, gen INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS artists_key ON artists(name_key);
        CREATE TABLE IF NOT EXISTS genres (name TEXT PRIMARY KEY, song_count INTEGER, album_count INTEGER);
        CREATE TABLE IF NOT EXISTS playlists (
            id TEXT PRIMARY KEY, name TEXT, comment TEXT, song_count INTEGER, duration INTEGER, owner TEXT,
            public INTEGER, cover_art TEXT, changed REAL, created REAL, songs_changed REAL);
        CREATE TABLE IF NOT EXISTS playlist_songs (playlist_id TEXT, position INTEGER, song_id TEXT, PRIMARY KEY (playlist_id, position));
        CREATE TABLE IF NOT EXISTS pins (playlist_id TEXT PRIMARY KEY, position INTEGER);
        CREATE TABLE IF NOT EXISTS downloads (song_id TEXT PRIMARY KEY, path TEXT, size INTEGER, created REAL);
        CREATE TABLE IF NOT EXISTS offline_sets (kind TEXT, set_id TEXT, name TEXT, created REAL, PRIMARY KEY (kind, set_id));
        CREATE TABLE IF NOT EXISTS offline_members (kind TEXT, set_id TEXT, song_id TEXT, position INTEGER, PRIMARY KEY (kind, set_id, song_id));
        CREATE TABLE IF NOT EXISTS external_tracks (id TEXT PRIMARY KEY, payload BLOB, updated REAL);
        CREATE TABLE IF NOT EXISTS ext_map (ext_id TEXT PRIMARY KEY, local_id TEXT);
        CREATE TABLE IF NOT EXISTS pending (rowid INTEGER PRIMARY KEY AUTOINCREMENT, ext_id TEXT, action TEXT, value TEXT, created REAL);
        CREATE TABLE IF NOT EXISTS plays (song_id TEXT, artist TEXT, played_at REAL, listened REAL, skipped INTEGER, autoplay INTEGER);
        CREATE INDEX IF NOT EXISTS plays_time ON plays(played_at);
        CREATE INDEX IF NOT EXISTS plays_song ON plays(song_id);
        CREATE TABLE IF NOT EXISTS mixes (id TEXT PRIMARY KEY, payload BLOB, updated REAL);
        CREATE TABLE IF NOT EXISTS lyrics (song_id TEXT PRIMARY KEY, payload BLOB, updated REAL);
        """)
    }

    // MARK: Row mapping

    static func track(_ r: SQLRow, offset o: Int32 = 0) -> Track {
        Track(
            id: r.text(o), title: r.text(o + 1), artist: r.text(o + 2), artistId: r.string(o + 3),
            album: r.text(o + 4), albumId: r.string(o + 5), albumArtist: r.string(o + 6), coverArt: r.string(o + 7),
            duration: r.int(o + 8), track: r.intOrNil(o + 9), disc: r.intOrNil(o + 10), year: r.intOrNil(o + 11),
            genre: r.string(o + 12), suffix: r.string(o + 13), contentType: r.string(o + 14), bitRate: r.intOrNil(o + 15),
            size: r.intOrNil(o + 16), starred: r.bool(o + 17), rating: r.int(o + 18), playCount: r.int(o + 19),
            played: r.date(o + 20), created: r.date(o + 21)
        )
    }

    static func album(_ r: SQLRow) -> Album {
        Album(
            id: r.text(0), name: r.text(1), artist: r.text(2), artistId: r.string(3), coverArt: r.string(4),
            songCount: r.int(5), duration: r.int(6), year: r.intOrNil(7), genre: r.string(8), created: r.date(9),
            starred: r.bool(10), rating: r.int(11), playCount: r.int(12), played: r.date(13)
        )
    }

    static func playlist(_ r: SQLRow) -> Playlist {
        Playlist(
            id: r.text(0), name: r.text(1), comment: r.string(2), songCount: r.int(3), duration: r.int(4),
            owner: r.string(5), isPublic: r.bool(6), coverArt: r.string(7), changed: r.date(8), created: r.date(9)
        )
    }

    // MARK: Meta

    func meta(_ key: String) -> String? {
        (try? reader.query("SELECT value FROM meta WHERE key = ?", [key]) { $0.string(0) })?.first ?? nil
    }

    func setMeta(_ key: String, _ value: String?) {
        if let value {
            try? writer.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value])
        } else {
            try? writer.run("DELETE FROM meta WHERE key = ?", [key])
        }
    }

    // MARK: Writes

    func upsertSongs(_ songs: [Track], generation: Int? = nil) throws {
        guard !songs.isEmpty else { return }
        try writer.transaction {
            for s in songs where !s.isExternal {
                try writer.run("""
                INSERT INTO songs (\(Self.songColumns), title_key, artist_key, gen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET title=excluded.title, artist=excluded.artist, artist_id=excluded.artist_id,
                  album=excluded.album, album_id=excluded.album_id, album_artist=excluded.album_artist, cover_art=excluded.cover_art,
                  duration=excluded.duration, track=excluded.track, disc=excluded.disc, year=excluded.year, genre=excluded.genre,
                  suffix=excluded.suffix, content_type=excluded.content_type, bitrate=excluded.bitrate, size=excluded.size,
                  starred=excluded.starred, rating=excluded.rating, play_count=excluded.play_count, played=excluded.played,
                  created=excluded.created, title_key=excluded.title_key, artist_key=excluded.artist_key,
                  gen=CASE WHEN excluded.gen > 0 THEN excluded.gen ELSE songs.gen END
                """, [
                    s.id, s.title, s.artist, s.artistId, s.album, s.albumId, s.albumArtist, s.coverArt, s.duration, s.track,
                    s.disc, s.year, s.genre, s.suffix, s.contentType, s.bitRate, s.size, s.starred, s.rating, s.playCount,
                    s.played, s.created, TextKey.title(s.title), TextKey.primaryArtist(s.artist), generation ?? 0,
                ])
            }
        }
    }

    func upsertAlbums(_ albums: [Album], generation: Int? = nil) throws {
        guard !albums.isEmpty else { return }
        try writer.transaction {
            for a in albums where !a.isExternal {
                try writer.run("""
                INSERT INTO albums (\(Self.albumColumns), sort_name, gen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, artist=excluded.artist, artist_id=excluded.artist_id,
                  cover_art=excluded.cover_art, song_count=excluded.song_count, duration=excluded.duration, year=excluded.year,
                  genre=excluded.genre, created=excluded.created, starred=excluded.starred, rating=excluded.rating,
                  play_count=excluded.play_count, played=excluded.played, sort_name=excluded.sort_name,
                  gen=CASE WHEN excluded.gen > 0 THEN excluded.gen ELSE albums.gen END
                """, [
                    a.id, a.name, a.artist, a.artistId, a.coverArt, a.songCount, a.duration, a.year, a.genre, a.created,
                    a.starred, a.rating, a.playCount, a.played, Self.sortName(a.name), generation ?? 0,
                ])
            }
        }
    }

    func upsertArtists(_ artists: [Artist], generation: Int) throws {
        try writer.transaction {
            for a in artists where !a.isExternal {
                try writer.run("""
                INSERT OR REPLACE INTO artists (id, name, cover_art, album_count, starred, sort_name, name_key, gen)
                VALUES (?,?,?,?,?,?,?,?)
                """, [a.id, a.name, a.coverArt, a.albumCount, a.starred, Self.sortName(a.name), TextKey.fold(a.name), generation])
            }
        }
    }

    func deleteStale(table: String, generation: Int) throws {
        try writer.run("DELETE FROM \(table) WHERE gen < ?", [generation])
    }

    func replaceGenres(_ genres: [Genre]) throws {
        try writer.transaction {
            try writer.run("DELETE FROM genres")
            for g in genres where !g.name.isEmpty {
                try writer.run("INSERT OR REPLACE INTO genres (name, song_count, album_count) VALUES (?,?,?)", [g.name, g.songCount, g.albumCount])
            }
        }
    }

    func replacePlaylists(_ playlists: [Playlist]) throws {
        try writer.transaction {
            let ids = Set(playlists.map(\.id))
            let existing = try writer.query("SELECT id FROM playlists") { $0.text(0) }
            for id in existing where !ids.contains(id) {
                try writer.run("DELETE FROM playlists WHERE id = ?", [id])
                try writer.run("DELETE FROM playlist_songs WHERE playlist_id = ?", [id])
                try writer.run("DELETE FROM pins WHERE playlist_id = ?", [id])
            }
            for p in playlists {
                try writer.run("""
                INSERT INTO playlists (id, name, comment, song_count, duration, owner, public, cover_art, changed, created)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, comment=excluded.comment, song_count=excluded.song_count,
                  duration=excluded.duration, owner=excluded.owner, public=excluded.public, cover_art=excluded.cover_art,
                  changed=excluded.changed, created=excluded.created
                """, [p.id, p.name, p.comment, p.songCount, p.duration, p.owner, p.isPublic, p.coverArt, p.changed, p.created])
            }
        }
    }

    func savePlaylistSongs(_ playlist: Playlist, songs: [Track]) throws {
        try upsertSongs(songs)
        try writer.transaction {
            try writer.run("DELETE FROM playlist_songs WHERE playlist_id = ?", [playlist.id])
            for (i, s) in songs.enumerated() {
                try writer.run("INSERT INTO playlist_songs (playlist_id, position, song_id) VALUES (?,?,?)", [playlist.id, i, s.id])
            }
            try writer.run("UPDATE playlists SET songs_changed = ? WHERE id = ?", [playlist.changed ?? Date(), playlist.id])
        }
    }

    func setStarredSongs(_ ids: Set<String>) throws {
        try writer.transaction {
            try writer.run("UPDATE songs SET starred = 0 WHERE starred = 1")
            for id in ids {
                try writer.run("UPDATE songs SET starred = 1 WHERE id = ?", [id])
            }
        }
    }

    func setStarred(songId: String, _ starred: Bool) {
        try? writer.run("UPDATE songs SET starred = ? WHERE id = ?", [starred, songId])
    }

    func setStarred(albumId: String, _ starred: Bool) {
        try? writer.run("UPDATE albums SET starred = ? WHERE id = ?", [starred, albumId])
    }

    func setRating(songId: String, _ rating: Int) {
        try? writer.run("UPDATE songs SET rating = ? WHERE id = ?", [rating, songId])
    }

    func recordPlay(songId: String) {
        try? writer.run("UPDATE songs SET play_count = play_count + 1, played = ? WHERE id = ?", [Date(), songId])
    }

    // MARK: Reads: songs

    func songs(albumId: String) -> [Track] {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE album_id = ? ORDER BY disc, track, title", [albumId]) { Self.track($0) }) ?? []
    }

    func songs(artistId: String, limit: Int = 500) -> [Track] {
        (try? reader.query("""
        SELECT \(Self.songColumns) FROM songs WHERE artist_id = ? OR album_id IN (SELECT id FROM albums WHERE artist_id = ?)
        ORDER BY play_count DESC, rating DESC LIMIT ?
        """, [artistId, artistId, limit]) { Self.track($0) }) ?? []
    }

    func songs(artistName: String, limit: Int = 200) -> [Track] {
        let key = TextKey.primaryArtist(artistName)
        return (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE artist_key = ? ORDER BY play_count DESC, rating DESC LIMIT ?", [key, limit]) { Self.track($0) }) ?? []
    }

    func songs(ids: [String]) -> [Track] {
        guard !ids.isEmpty else { return [] }
        var byId: [String: Track] = [:]
        for chunk in stride(from: 0, to: ids.count, by: 400) {
            let slice = Array(ids[chunk..<min(chunk + 400, ids.count)])
            let placeholders = Array(repeating: "?", count: slice.count).joined(separator: ",")
            let rows = (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE id IN (\(placeholders))", slice) { Self.track($0) }) ?? []
            for t in rows { byId[t.id] = t }
        }
        return ids.compactMap { byId[$0] }
    }

    func song(id: String) -> Track? {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE id = ?", [id]) { Self.track($0) })?.first
    }

    func songs(sort: SongSort, filter: String, limit: Int, offset: Int) -> [Track] {
        var sql = "SELECT \(Self.songColumns) FROM songs"
        var args: [SQLBindable?] = []
        if !filter.isEmpty {
            sql += " WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?"
            let like = "%\(filter)%"
            args += [like, like, like]
        }
        sql += " ORDER BY \(sort.sql) LIMIT ? OFFSET ?"
        args += [limit, offset]
        return (try? reader.query(sql, args) { Self.track($0) }) ?? []
    }

    func songs(genre: String, sort: SongSort = .artist, limit: Int, offset: Int) -> [Track] {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE genre = ? COLLATE NOCASE ORDER BY \(sort.sql) LIMIT ? OFFSET ?", [genre, limit, offset]) { Self.track($0) }) ?? []
    }

    func randomSongs(genre: String? = nil, limit: Int, minRating: Int = 0) -> [Track] {
        var sql = "SELECT \(Self.songColumns) FROM songs WHERE rating >= ? AND (rating = 0 OR rating > 1)"
        var args: [SQLBindable?] = [minRating]
        if let genre {
            sql += " AND genre = ? COLLATE NOCASE"
            args.append(genre)
        }
        sql += " ORDER BY random() LIMIT ?"
        args.append(limit)
        return (try? reader.query(sql, args) { Self.track($0) }) ?? []
    }

    func starredSongs() -> [Track] {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE starred = 1 ORDER BY artist COLLATE NOCASE, album, disc, track") { Self.track($0) }) ?? []
    }

    func songCount(filter: String = "") -> Int {
        if filter.isEmpty { return reader.scalarInt("SELECT count(*) FROM songs") }
        let like = "%\(filter)%"
        return reader.scalarInt("SELECT count(*) FROM songs WHERE title LIKE ? OR artist LIKE ? OR album LIKE ?", [like, like, like])
    }

    func songCount(genre: String) -> Int {
        reader.scalarInt("SELECT count(*) FROM songs WHERE genre = ? COLLATE NOCASE", [genre])
    }

    /// Smart lists for Home and Discover.
    func topRated(limit: Int) -> [Track] {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE rating >= 4 OR starred = 1 ORDER BY random() LIMIT ?", [limit]) { Self.track($0) }) ?? []
    }

    func forgottenFavourites(olderThan date: Date, limit: Int) -> [Track] {
        (try? reader.query("""
        SELECT \(Self.songColumns) FROM songs WHERE (rating >= 4 OR starred = 1 OR play_count >= 5)
          AND (played IS NULL OR played < ?) ORDER BY random() LIMIT ?
        """, [date, limit]) { Self.track($0) }) ?? []
    }

    func recentlyAddedSongs(limit: Int) -> [Track] {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs ORDER BY created DESC LIMIT ?", [limit]) { Self.track($0) }) ?? []
    }

    func mostPlayedSongs(limit: Int) -> [Track] {
        (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE play_count > 0 ORDER BY play_count DESC LIMIT ?", [limit]) { Self.track($0) }) ?? []
    }

    /// Never-played songs by artists you do play: the "deep cuts" mix.
    func deepCuts(limit: Int) -> [Track] {
        (try? reader.query("""
        SELECT \(Self.songColumns) FROM songs WHERE play_count = 0 AND rating != 1 AND artist_key IN (
            SELECT artist_key FROM songs WHERE play_count > 2 GROUP BY artist_key ORDER BY sum(play_count) DESC LIMIT 60)
        ORDER BY random() LIMIT ?
        """, [limit]) { Self.track($0) }) ?? []
    }

    /// Best library match for a song from another source.
    func match(title: String, artist: String) -> Track? {
        let key = TextKey.title(title)
        guard !key.isEmpty else { return nil }
        let candidates = (try? reader.query("SELECT \(Self.songColumns) FROM songs WHERE title_key = ? LIMIT 40", [key]) { Self.track($0) }) ?? []
        let matching = candidates.filter { TextKey.artistsOverlap($0.artist, artist) || ($0.albumArtist.map { TextKey.artistsOverlap($0, artist) } ?? false) }
        // Prefer the copy that's been played or rated most, then the shortest album title
        // (the original album rather than a compilation).
        return matching.max { a, b in
            (a.playCount + a.rating * 3, -a.album.count) < (b.playCount + b.rating * 3, -b.album.count)
        }
    }

    func searchSongs(_ query: String, limit: Int) -> [Track] {
        let like = "%\(query)%"
        return (try? reader.query("""
        SELECT \(Self.songColumns) FROM songs WHERE title LIKE ? OR artist LIKE ?
        ORDER BY (title LIKE ?) DESC, play_count DESC LIMIT ?
        """, [like, like, "\(query)%", limit]) { Self.track($0) }) ?? []
    }

    // MARK: Reads: albums, artists, genres

    func albums(sort: AlbumSort, filter: String = "", genre: String? = nil, limit: Int, offset: Int) -> [Album] {
        var clauses: [String] = []
        var args: [SQLBindable?] = []
        if !filter.isEmpty {
            clauses.append("(name LIKE ? OR artist LIKE ?)")
            args += ["%\(filter)%", "%\(filter)%"]
        }
        if let genre {
            clauses.append("genre = ? COLLATE NOCASE")
            args.append(genre)
        }
        var sql = "SELECT \(Self.albumColumns) FROM albums"
        if !clauses.isEmpty { sql += " WHERE " + clauses.joined(separator: " AND ") }
        sql += " ORDER BY \(sort.sql) LIMIT ? OFFSET ?"
        args += [limit, offset]
        return (try? reader.query(sql, args) { Self.album($0) }) ?? []
    }

    func albums(artistId: String) -> [Album] {
        (try? reader.query("SELECT \(Self.albumColumns) FROM albums WHERE artist_id = ? ORDER BY year DESC, sort_name", [artistId]) { Self.album($0) }) ?? []
    }

    func album(id: String) -> Album? {
        (try? reader.query("SELECT \(Self.albumColumns) FROM albums WHERE id = ?", [id]) { Self.album($0) })?.first
    }

    func albumCount(filter: String = "") -> Int {
        if filter.isEmpty { return reader.scalarInt("SELECT count(*) FROM albums") }
        return reader.scalarInt("SELECT count(*) FROM albums WHERE name LIKE ? OR artist LIKE ?", ["%\(filter)%", "%\(filter)%"])
    }

    func starredAlbums() -> [Album] {
        (try? reader.query("SELECT \(Self.albumColumns) FROM albums WHERE starred = 1 ORDER BY sort_name") { Self.album($0) }) ?? []
    }

    func searchAlbums(_ query: String, limit: Int) -> [Album] {
        let like = "%\(query)%"
        return (try? reader.query("SELECT \(Self.albumColumns) FROM albums WHERE name LIKE ? OR artist LIKE ? ORDER BY (name LIKE ?) DESC, (artist LIKE ?) DESC, play_count DESC LIMIT ?", [like, like, "\(query)%", "\(query)%", limit]) { Self.album($0) }) ?? []
    }

    func artists(filter: String = "", limit: Int, offset: Int) -> [Artist] {
        var sql = "SELECT id, name, cover_art, album_count, starred FROM artists"
        var args: [SQLBindable?] = []
        if !filter.isEmpty {
            sql += " WHERE name LIKE ?"
            args.append("%\(filter)%")
        }
        sql += " ORDER BY sort_name COLLATE NOCASE LIMIT ? OFFSET ?"
        args += [limit, offset]
        return (try? reader.query(sql, args) { r in
            Artist(id: r.text(0), name: r.text(1), coverArt: r.string(2), albumCount: r.int(3), starred: r.bool(4))
        }) ?? []
    }

    func artist(id: String) -> Artist? {
        (try? reader.query("SELECT id, name, cover_art, album_count, starred FROM artists WHERE id = ?", [id]) { r in
            Artist(id: r.text(0), name: r.text(1), coverArt: r.string(2), albumCount: r.int(3), starred: r.bool(4))
        })?.first
    }

    func artist(named name: String) -> Artist? {
        (try? reader.query("SELECT id, name, cover_art, album_count, starred FROM artists WHERE name_key = ? LIMIT 1", [TextKey.fold(name)]) { r in
            Artist(id: r.text(0), name: r.text(1), coverArt: r.string(2), albumCount: r.int(3), starred: r.bool(4))
        })?.first
    }

    func artistCount(filter: String = "") -> Int {
        if filter.isEmpty { return reader.scalarInt("SELECT count(*) FROM artists") }
        return reader.scalarInt("SELECT count(*) FROM artists WHERE name LIKE ?", ["%\(filter)%"])
    }

    /// Names starting with the query first, then a word starting with it, then the rest.
    func searchArtists(_ query: String, limit: Int) -> [Artist] {
        (try? reader.query("""
        SELECT id, name, cover_art, album_count, starred FROM artists WHERE name LIKE ?
        ORDER BY (name LIKE ?) DESC, (name LIKE ?) DESC, album_count DESC LIMIT ?
        """, ["%\(query)%", "\(query)%", "% \(query)%", limit]) { r in
            Artist(id: r.text(0), name: r.text(1), coverArt: r.string(2), albumCount: r.int(3), starred: r.bool(4))
        }) ?? []
    }

    func genres() -> [Genre] {
        (try? reader.query("SELECT name, song_count, album_count FROM genres ORDER BY song_count DESC") { r in
            Genre(name: r.text(0), songCount: r.int(1), albumCount: r.int(2))
        }) ?? []
    }

    func playlists() -> [Playlist] {
        (try? reader.query("SELECT id, name, comment, song_count, duration, owner, public, cover_art, changed, created FROM playlists") { Self.playlist($0) }) ?? []
    }

    /// Cached playlist songs, or nil if they were never fetched or the playlist changed since.
    func playlistSongs(_ playlist: Playlist, requireFresh: Bool) -> [Track]? {
        let synced = (try? reader.query("SELECT songs_changed FROM playlists WHERE id = ?", [playlist.id]) { $0.date(0) })?.first ?? nil
        guard let synced else { return nil }
        if requireFresh, let changed = playlist.changed, abs(changed.timeIntervalSince(synced)) > 1 { return nil }
        let ids = (try? reader.query("SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position", [playlist.id]) { $0.text(0) }) ?? []
        let local = songs(ids: ids)
        if local.count == ids.count { return local }
        // Some entries aren't in the songs table (yet); keep order with what we have.
        return local
    }

    // MARK: Artwork

    /// Album covers, most played and newest first, then artist images.
    func allCoverArts() -> [String] {
        let albums = (try? reader.query("SELECT cover_art FROM albums WHERE cover_art IS NOT NULL ORDER BY play_count DESC, created DESC") { $0.text(0) }) ?? []
        let artists = (try? reader.query("SELECT cover_art FROM artists WHERE cover_art IS NOT NULL ORDER BY album_count DESC") { $0.text(0) }) ?? []
        return albums + artists
    }

    func albumCoverIndex() -> [String: String] {
        let rows = (try? reader.query("SELECT id, cover_art FROM albums WHERE cover_art IS NOT NULL") { ($0.text(0), $0.text(1)) }) ?? []
        return Dictionary(rows, uniquingKeysWith: { a, _ in a })
    }

    // MARK: Pins

    func pins() -> [String] {
        (try? reader.query("SELECT playlist_id FROM pins ORDER BY position") { $0.text(0) }) ?? []
    }

    func savePins(_ ids: [String]) {
        try? writer.transaction {
            try writer.run("DELETE FROM pins")
            for (i, id) in ids.enumerated() {
                try writer.run("INSERT INTO pins (playlist_id, position) VALUES (?, ?)", [id, i])
            }
        }
    }

    // MARK: External tracks & octo-fiesta resolution

    func saveExternal(_ tracks: [Track]) {
        let encoder = JSONEncoder()
        try? writer.transaction {
            for t in tracks where t.isExternal {
                if let data = try? encoder.encode(t) {
                    try writer.run("INSERT OR REPLACE INTO external_tracks (id, payload, updated) VALUES (?,?,?)", [t.id, data, Date()])
                }
            }
        }
    }

    func externalTracks(ids: [String]) -> [String: Track] {
        guard !ids.isEmpty else { return [:] }
        let decoder = JSONDecoder()
        var result: [String: Track] = [:]
        for id in ids {
            if let data = (try? reader.query("SELECT payload FROM external_tracks WHERE id = ?", [id]) { $0.data(0) })?.first ?? nil,
               let track = try? decoder.decode(Track.self, from: data) {
                result[id] = track
            }
        }
        return result
    }

    func localId(forExternal id: String) -> String? {
        (try? reader.query("SELECT local_id FROM ext_map WHERE ext_id = ?", [id]) { $0.string(0) })?.first ?? nil
    }

    func mapExternal(_ externalId: String, to localId: String) {
        try? writer.run("INSERT OR REPLACE INTO ext_map (ext_id, local_id) VALUES (?, ?)", [externalId, localId])
    }

    func addPending(externalId: String, action: String, value: String) {
        // Only the latest rating and star state matter; every scrobble counts.
        switch action {
        case "rate":
            try? writer.run("DELETE FROM pending WHERE ext_id = ? AND action = 'rate'", [externalId])
        case "star", "unstar":
            try? writer.run("DELETE FROM pending WHERE ext_id = ? AND action IN ('star', 'unstar')", [externalId])
        default:
            break
        }
        try? writer.run("INSERT INTO pending (ext_id, action, value, created) VALUES (?,?,?,?)", [externalId, action, value, Date()])
    }

    func pendingActions() -> [PendingAction] {
        (try? reader.query("SELECT rowid, ext_id, action, value, created FROM pending ORDER BY rowid") { r in
            PendingAction(rowId: r.int(0), externalId: r.text(1), action: r.text(2), value: r.text(3), created: r.date(4) ?? Date())
        }) ?? []
    }

    func removePending(rowId: Int) {
        try? writer.run("DELETE FROM pending WHERE rowid = ?", [rowId])
    }

    func pendingCount() -> Int {
        reader.scalarInt("SELECT count(*) FROM pending")
    }

    // MARK: Plays (local listening history for autoplay)

    func addPlay(_ p: PlayRecord) {
        try? writer.run("INSERT INTO plays (song_id, artist, played_at, listened, skipped, autoplay) VALUES (?,?,?,?,?,?)",
                        [p.songId, p.artist, p.playedAt, p.listened, p.skipped, p.autoplay])
    }

    func recentPlays(since: Date) -> [PlayRecord] {
        (try? reader.query("SELECT song_id, artist, played_at, listened, skipped, autoplay FROM plays WHERE played_at > ? ORDER BY played_at DESC", [since]) { r in
            PlayRecord(songId: r.text(0), artist: r.text(1), playedAt: r.date(2) ?? Date(), listened: r.double(3), skipped: r.bool(4), autoplay: r.bool(5))
        }) ?? []
    }

    func recentlyPlayedSongIds(limit: Int) -> [String] {
        (try? reader.query("SELECT song_id FROM plays WHERE skipped = 0 GROUP BY song_id ORDER BY max(played_at) DESC LIMIT ?", [limit]) { $0.text(0) }) ?? []
    }

    func onRepeatSongIds(since: Date, limit: Int) -> [String] {
        (try? reader.query("SELECT song_id FROM plays WHERE skipped = 0 AND played_at > ? GROUP BY song_id HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT ?", [since, limit]) { $0.text(0) }) ?? []
    }

    // MARK: Mixes

    func saveMix(id: String, payload: Data) {
        try? writer.run("INSERT OR REPLACE INTO mixes (id, payload, updated) VALUES (?,?,?)", [id, payload, Date()])
    }

    func mixes() -> [Data] {
        (try? reader.query("SELECT payload FROM mixes") { $0.data(0) })?.compactMap { $0 } ?? []
    }

    func deleteMix(id: String) {
        try? writer.run("DELETE FROM mixes WHERE id = ?", [id])
    }

    // MARK: Lyrics

    func lyrics(songId: String) -> Lyrics? {
        guard let data = (try? reader.query("SELECT payload FROM lyrics WHERE song_id = ?", [songId]) { $0.data(0) })?.first ?? nil else { return nil }
        return try? JSONDecoder().decode(Lyrics.self, from: data)
    }

    func saveLyrics(songId: String, _ lyrics: Lyrics) {
        guard let data = try? JSONEncoder().encode(lyrics) else { return }
        try? writer.run("INSERT OR REPLACE INTO lyrics (song_id, payload, updated) VALUES (?,?,?)", [songId, data, Date()])
    }

    // MARK: Helpers

    static func sortName(_ name: String) -> String {
        let lower = name.lowercased()
        for article in ["the ", "a ", "an ", "de ", "het ", "le ", "la ", "les ", "el "] where lower.hasPrefix(article) {
            return String(name.dropFirst(article.count))
        }
        return name.trimmingCharacters(in: CharacterSet.alphanumerics.inverted.subtracting(.whitespaces))
    }

    var fileSize: Int64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? Int64) ?? 0
    }
}
