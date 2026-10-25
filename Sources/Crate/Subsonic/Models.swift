import Foundation

// MARK: - Domain models

struct Track: Identifiable, Hashable, Sendable, Codable {
    var id: String
    var title: String
    var artist: String
    var artistId: String?
    var album: String
    var albumId: String?
    var albumArtist: String?
    var coverArt: String?
    var duration: Int
    var track: Int?
    var disc: Int?
    var year: Int?
    var genre: String?
    var suffix: String?
    var contentType: String?
    var bitRate: Int?
    var size: Int?
    var starred: Bool
    var rating: Int
    var playCount: Int
    var played: Date?
    var created: Date?
    /// Artwork for tracks that don't come from the server (e.g. ListenBrainz recommendations).
    var artworkURL: URL?

    var isExternal: Bool { OctoID.isExternal(id) }
    var provider: String? { OctoID.providerName(id) }

    var durationText: String { Format.duration(duration) }
}

struct Album: Identifiable, Hashable, Sendable, Codable {
    var id: String
    var name: String
    var artist: String
    var artistId: String?
    var coverArt: String?
    var songCount: Int
    var duration: Int
    var year: Int?
    var genre: String?
    var created: Date?
    var starred: Bool
    var rating: Int
    var playCount: Int
    var played: Date?

    var isExternal: Bool { OctoID.isExternal(id) || OctoID.isExternalPlaylist(id) }
    var isExternalPlaylist: Bool { OctoID.isExternalPlaylist(id) }
}

struct Artist: Identifiable, Hashable, Sendable, Codable {
    var id: String
    var name: String
    var coverArt: String?
    var albumCount: Int
    var starred: Bool

    var isExternal: Bool { OctoID.isExternal(id) }
}

struct Playlist: Identifiable, Hashable, Sendable, Codable {
    var id: String
    var name: String
    var comment: String?
    var songCount: Int
    var duration: Int
    var owner: String?
    var isPublic: Bool
    var coverArt: String?
    var changed: Date?
    var created: Date?

    /// Navidrome keeps leading spaces from imported M3U names (" Alternative").
    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Untitled playlist" : trimmed
    }
}

struct Genre: Identifiable, Hashable, Sendable, Codable {
    var id: String { name }
    var name: String
    var songCount: Int
    var albumCount: Int
}

struct SearchResults: Sendable {
    var artists: [Artist] = []
    var albums: [Album] = []
    var songs: [Track] = []
    var isEmpty: Bool { artists.isEmpty && albums.isEmpty && songs.isEmpty }
}

struct ScanStatus: Sendable {
    var scanning: Bool
    var count: Int?
    var lastScan: String?
}

// MARK: - Wire models

/// Decodes `{"subsonic-response": {"status": ..., "<key>": T}}` without a struct per endpoint.
struct SubsonicPayload<T: Decodable>: Decodable {
    let status: String
    let error: SubsonicErrorBody?
    let value: T?

    static var keyInfo: CodingUserInfoKey { CodingUserInfoKey(rawValue: "payloadKey")! }

    init(from decoder: Decoder) throws {
        let outer = try decoder.container(keyedBy: AnyKey.self)
        let inner = try outer.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("subsonic-response"))
        status = (try? inner.decode(String.self, forKey: AnyKey("status"))) ?? "failed"
        error = try? inner.decodeIfPresent(SubsonicErrorBody.self, forKey: AnyKey("error"))
        let key = decoder.userInfo[Self.keyInfo] as? String ?? ""
        if key.isEmpty {
            value = nil
        } else {
            value = try inner.decodeIfPresent(T.self, forKey: AnyKey(key))
        }
    }
}

struct SubsonicErrorBody: Decodable, Sendable {
    let code: Int
    let message: String?
}

struct Empty: Decodable {}

struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

extension KeyedDecodingContainer where Key == AnyKey {
    func string(_ key: String) -> String? {
        let k = AnyKey(key)
        if let s = try? decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? decodeIfPresent(Double.self, forKey: k) { return String(d) }
        return nil
    }

    func int(_ key: String) -> Int? {
        let k = AnyKey(key)
        if let i = try? decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? decodeIfPresent(Double.self, forKey: k) { return Int(d) }
        if let s = try? decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        let k = AnyKey(key)
        if let b = try? decodeIfPresent(Bool.self, forKey: k) { return b }
        if let s = try? decodeIfPresent(String.self, forKey: k) { return s == "true" }
        return nil
    }

    func date(_ key: String) -> Date? {
        string(key).flatMap(Format.parseDate)
    }

    func list<T: Decodable>(_ key: String, _ type: T.Type) -> [T] {
        (try? decodeIfPresent([T].self, forKey: AnyKey(key))) ?? []
    }
}

struct WireSong: Decodable {
    let track: Track

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "song without id"))
        }
        var artist = c.string("displayArtist") ?? c.string("artist") ?? ""
        if artist.isEmpty { artist = c.string("artist") ?? "Unknown artist" }
        let starred = c.string("starred")
        track = Track(
            id: id,
            title: c.string("title") ?? c.string("name") ?? "Untitled",
            artist: artist,
            artistId: c.string("artistId"),
            album: c.string("album") ?? "",
            albumId: c.string("albumId") ?? c.string("parent"),
            albumArtist: c.string("displayAlbumArtist"),
            coverArt: c.string("coverArt"),
            duration: c.int("duration") ?? 0,
            track: c.int("track"),
            disc: c.int("discNumber"),
            year: c.int("year"),
            genre: c.string("genre"),
            suffix: c.string("suffix"),
            contentType: c.string("contentType"),
            bitRate: c.int("bitRate"),
            size: c.int("size"),
            starred: starred != nil && starred != "",
            rating: c.int("userRating") ?? 0,
            playCount: c.int("playCount") ?? 0,
            played: c.date("played"),
            created: c.date("created")
        )
    }
}

struct WireAlbum: Decodable {
    let album: Album
    let songs: [Track]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "album without id"))
        }
        let starred = c.string("starred")
        album = Album(
            id: id,
            name: c.string("name") ?? c.string("title") ?? c.string("album") ?? "Untitled",
            artist: c.string("displayArtist") ?? c.string("artist") ?? "Unknown artist",
            artistId: c.string("artistId"),
            coverArt: c.string("coverArt"),
            songCount: c.int("songCount") ?? 0,
            duration: c.int("duration") ?? 0,
            year: c.int("year"),
            genre: c.string("genre"),
            created: c.date("created"),
            starred: starred != nil && starred != "",
            rating: c.int("userRating") ?? 0,
            playCount: c.int("playCount") ?? 0,
            played: c.date("played")
        )
        songs = c.list("song", LossyWire<WireSong>.self).compactMap { $0.value?.track }
    }
}

struct WireArtist: Decodable {
    let artist: Artist
    let albums: [Album]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "artist without id"))
        }
        let starred = c.string("starred")
        artist = Artist(
            id: id,
            name: c.string("name") ?? "Unknown artist",
            coverArt: c.string("coverArt"),
            albumCount: c.int("albumCount") ?? 0,
            starred: starred != nil && starred != ""
        )
        albums = c.list("album", LossyWire<WireAlbum>.self).compactMap { $0.value?.album }
    }
}

struct WirePlaylist: Decodable {
    let playlist: Playlist
    let songs: [Track]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "playlist without id"))
        }
        playlist = Playlist(
            id: id,
            name: c.string("name") ?? "Untitled playlist",
            comment: c.string("comment"),
            songCount: c.int("songCount") ?? 0,
            duration: c.int("duration") ?? 0,
            owner: c.string("owner"),
            isPublic: c.bool("public") ?? false,
            coverArt: c.string("coverArt"),
            changed: c.date("changed"),
            created: c.date("created")
        )
        songs = c.list("entry", LossyWire<WireSong>.self).compactMap { $0.value?.track }
    }
}

/// One malformed element must not fail a whole list.
struct LossyWire<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

struct WireAlbumList: Decodable {
    let albums: [Album]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        albums = c.list("album", LossyWire<WireAlbum>.self).compactMap { $0.value?.album }
    }
}

struct WireSongList: Decodable {
    let songs: [Track]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        songs = c.list("song", LossyWire<WireSong>.self).compactMap { $0.value?.track }
    }
}

struct WirePlaylists: Decodable {
    let playlists: [Playlist]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        playlists = c.list("playlist", LossyWire<WirePlaylist>.self).compactMap { $0.value?.playlist }
    }
}

struct WireGenres: Decodable {
    let genres: [Genre]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        genres = c.list("genre", LossyWire<WireGenre>.self).compactMap { $0.value?.genre }
    }
}

struct WireGenre: Decodable {
    let genre: Genre
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        genre = Genre(name: c.string("value") ?? "", songCount: c.int("songCount") ?? 0, albumCount: c.int("albumCount") ?? 0)
    }
}

struct WireArtists: Decodable {
    let artists: [Artist]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let indexes = c.list("index", WireIndex.self)
        artists = indexes.flatMap(\.artists)
    }
}

struct WireIndex: Decodable {
    let artists: [Artist]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        artists = c.list("artist", LossyWire<WireArtist>.self).compactMap { $0.value?.artist }
    }
}

struct WireSearch: Decodable {
    let results: SearchResults
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        results = SearchResults(
            artists: c.list("artist", LossyWire<WireArtist>.self).compactMap { $0.value?.artist },
            albums: c.list("album", LossyWire<WireAlbum>.self).compactMap { $0.value?.album },
            songs: c.list("song", LossyWire<WireSong>.self).compactMap { $0.value?.track }
        )
    }
}

struct WireArtistInfo: Decodable {
    let biography: String?
    let similar: [Artist]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        biography = c.string("biography")
        similar = c.list("similarArtist", LossyWire<WireArtist>.self).compactMap { $0.value?.artist }
    }
}

struct WireScanStatus: Decodable {
    let status: ScanStatus
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        status = ScanStatus(scanning: c.bool("scanning") ?? false, count: c.int("count"), lastScan: c.string("lastScan"))
    }
}

struct StructuredLyrics: Sendable {
    struct Line: Sendable {
        var startMs: Int?
        var text: String
    }
    var synced: Bool
    var offsetMs: Double
    var lines: [Line]
}

/// OpenSubsonic `getLyricsBySongId` → `lyricsList.structuredLyrics`.
struct WireLyricsList: Decodable {
    let lyrics: [StructuredLyrics]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        lyrics = c.list("structuredLyrics", LossyWire<WireStructuredLyrics>.self).compactMap { $0.value?.lyrics }
    }
}

struct WireStructuredLyrics: Decodable {
    let lyrics: StructuredLyrics
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let lines = c.list("line", LossyWire<WireLyricLine>.self).compactMap { $0.value?.line }
        lyrics = StructuredLyrics(synced: c.bool("synced") ?? false, offsetMs: Double(c.int("offset") ?? 0), lines: lines)
    }
}

struct WireLyricLine: Decodable {
    let line: StructuredLyrics.Line
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        line = StructuredLyrics.Line(startMs: c.int("start"), text: c.string("value") ?? "")
    }
}

struct WireSingleSong: Decodable {
    let track: Track
    init(from decoder: Decoder) throws {
        track = try WireSong(from: decoder).track
    }
}
