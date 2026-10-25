import CryptoKit
import Foundation

struct ServerAccount: Codable, Hashable, Sendable {
    var url: URL
    var username: String

    /// Stable, filesystem-safe key for per-account caches.
    var key: String {
        let host = (url.host ?? "server") + (url.port.map { "-\($0)" } ?? "") + url.path.replacingOccurrences(of: "/", with: "-")
        let raw = "\(username)@\(host)"
        return raw.map { $0.isLetter || $0.isNumber || $0 == "@" || $0 == "-" || $0 == "." ? $0 : "_" }.reduce(into: "") { $0.append($1) }
    }

    var displayHost: String { url.host ?? url.absoluteString }
}

enum CrateError: LocalizedError, Sendable {
    case server(code: Int, message: String)
    case http(Int)
    case invalidResponse
    case offline
    case notConnected

    var errorDescription: String? {
        switch self {
        case let .server(code, message):
            switch code {
            case 40: return "Wrong username or password."
            case 41: return "This server doesn't accept token authentication."
            case 70: return message.isEmpty ? "Not found on the server." : message
            default: return message.isEmpty ? "The server returned an error (\(code))." : message
            }
        case let .http(status): return "The server answered with HTTP \(status)."
        case .invalidResponse: return "The server sent a response Crate couldn't read."
        case .offline: return "You're offline."
        case .notConnected: return "Not connected to a server."
        }
    }

    var isAuthError: Bool {
        if case let .server(code, _) = self { return code == 40 || code == 41 || code == 44 }
        return false
    }
}

extension Error {
    /// Network-level failures that mean "the server can't be reached", not "the request was bad".
    var isConnectivityError: Bool {
        if let urlError = self as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost,
                 .timedOut, .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed, .secureConnectionFailed:
                return true
            default:
                return false
            }
        }
        if let crate = self as? CrateError, case .offline = crate { return true }
        return false
    }
}

/// Subsonic/OpenSubsonic API client. Works against Navidrome directly or through octo-fiesta.
final class SubsonicClient: Sendable {
    let account: ServerAccount
    private let password: String
    private let session: URLSession
    /// octo-fiesta answers external requests only once the provider download is complete,
    /// so anything that may touch an external track gets a generous timeout.
    private let patientSession: URLSession
    private let salt: String
    private let token: String

    static let apiVersion = "1.16.1"
    static let clientName = "Crate"

    init(account: ServerAccount, password: String) {
        self.account = account
        self.password = password
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 120
        config.httpMaximumConnectionsPerHost = 8
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        session = URLSession(configuration: config)
        let patient = URLSessionConfiguration.default
        patient.timeoutIntervalForRequest = 300
        patient.timeoutIntervalForResource = 900
        patient.urlCache = nil
        patientSession = URLSession(configuration: patient)
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        salt = String((0..<12).map { _ in alphabet.randomElement()! })
        token = Insecure.MD5.hash(data: Data((password + salt).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: URLs

    private var restBase: URL {
        var base = account.url
        if base.path.hasSuffix("/rest") == false {
            base.appendPathComponent("rest")
        }
        return base
    }

    func url(_ endpoint: String, _ params: [(String, String)] = []) -> URL {
        var components = URLComponents(url: restBase.appendingPathComponent(endpoint), resolvingAgainstBaseURL: false)!
        var items = [
            URLQueryItem(name: "u", value: account.username),
            URLQueryItem(name: "t", value: token),
            URLQueryItem(name: "s", value: salt),
            URLQueryItem(name: "v", value: Self.apiVersion),
            URLQueryItem(name: "c", value: Self.clientName),
            URLQueryItem(name: "f", value: "json"),
        ]
        items += params.map { URLQueryItem(name: $0.0, value: $0.1) }
        components.queryItems = items
        // `+` is legal in queries but Subsonic servers decode it as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url!
    }

    func streamURL(id: String, format: String? = nil, maxBitRate: Int? = nil) -> URL {
        var params: [(String, String)] = [("id", id)]
        if let format { params.append(("format", format)) }
        if let maxBitRate, maxBitRate > 0 { params.append(("maxBitRate", String(maxBitRate))) }
        if format != nil || maxBitRate != nil { params.append(("estimateContentLength", "true")) }
        return url("stream", params)
    }

    func downloadURL(id: String) -> URL {
        url("download", [("id", id)])
    }

    func coverArtURL(id: String, size: Int) -> URL {
        url("getCoverArt", [("id", id), ("size", String(size))])
    }

    // MARK: Requests

    private func request<T: Decodable>(_ endpoint: String, _ params: [(String, String)] = [], key: String, as type: T.Type, patient: Bool = false) async throws -> T? {
        let (data, response) = try await (patient ? patientSession : session).data(from: url(endpoint, params))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw CrateError.http(http.statusCode)
        }
        let payload: SubsonicPayload<T>
        do {
            payload = try Self.decodePayload(T.self, key: key, from: data)
        } catch {
            throw CrateError.invalidResponse
        }
        if payload.status != "ok" {
            throw CrateError.server(code: payload.error?.code ?? 0, message: payload.error?.message ?? "")
        }
        return payload.value
    }

    static func decodePayload<T: Decodable>(_ type: T.Type, key: String, from data: Data) throws -> SubsonicPayload<T> {
        let decoder = JSONDecoder()
        decoder.userInfo[SubsonicPayload<T>.keyInfo] = key
        return try decoder.decode(SubsonicPayload<T>.self, from: data)
    }

    static func decodePayload<T: Decodable>(_ type: T.Type, key: String, from json: String) throws -> SubsonicPayload<T> {
        try decodePayload(type, key: key, from: Data(json.utf8))
    }

    private func call(_ endpoint: String, _ params: [(String, String)] = [], patient: Bool = false) async throws {
        _ = try await request(endpoint, params, key: "", as: Empty.self, patient: patient)
    }

    // MARK: System

    func ping() async throws {
        try await call("ping")
    }

    func scanStatus() async throws -> ScanStatus? {
        try await request("getScanStatus", key: "scanStatus", as: WireScanStatus.self)?.status
    }

    // MARK: Browsing

    /// `type`: newest, recent, frequent, random, alphabeticalByName, alphabeticalByArtist, starred, highest, byGenre, byYear
    func albumList(type: String, size: Int = 50, offset: Int = 0, extra: [(String, String)] = []) async throws -> [Album] {
        try await request("getAlbumList2", [("type", type), ("size", String(size)), ("offset", String(offset))] + extra,
                          key: "albumList2", as: WireAlbumList.self)?.albums ?? []
    }

    func album(id: String) async throws -> (Album, [Track]) {
        guard let wire = try await request("getAlbum", [("id", id)], key: "album", as: WireAlbum.self) else {
            throw CrateError.invalidResponse
        }
        return (wire.album, wire.songs)
    }

    func artists() async throws -> [Artist] {
        try await request("getArtists", key: "artists", as: WireArtists.self)?.artists ?? []
    }

    func artist(id: String) async throws -> (Artist, [Album]) {
        guard let wire = try await request("getArtist", [("id", id)], key: "artist", as: WireArtist.self) else {
            throw CrateError.invalidResponse
        }
        return (wire.artist, wire.albums)
    }

    func artistInfo(id: String, count: Int = 12) async throws -> WireArtistInfo? {
        try await request("getArtistInfo2", [("id", id), ("count", String(count))], key: "artistInfo2", as: WireArtistInfo.self)
    }

    func topSongs(artist: String, count: Int = 10) async throws -> [Track] {
        try await request("getTopSongs", [("artist", artist), ("count", String(count))], key: "topSongs", as: WireSongList.self)?.songs ?? []
    }

    func similarSongs(id: String, count: Int = 30) async throws -> [Track] {
        try await request("getSimilarSongs2", [("id", id), ("count", String(count))], key: "similarSongs2", as: WireSongList.self)?.songs ?? []
    }

    func song(id: String) async throws -> Track? {
        try await request("getSong", [("id", id)], key: "song", as: WireSingleSong.self)?.track
    }

    /// OpenSubsonic songLyrics; octo-fiesta answers it for external songs too.
    func lyrics(id: String) async throws -> [StructuredLyrics] {
        try await request("getLyricsBySongId", [("id", id)], key: "lyricsList", as: WireLyricsList.self)?.lyrics ?? []
    }

    func genres() async throws -> [Genre] {
        try await request("getGenres", key: "genres", as: WireGenres.self)?.genres ?? []
    }

    func songsByGenre(_ genre: String, count: Int = 100, offset: Int = 0) async throws -> [Track] {
        try await request("getSongsByGenre", [("genre", genre), ("count", String(count)), ("offset", String(offset))],
                          key: "songsByGenre", as: WireSongList.self)?.songs ?? []
    }

    func randomSongs(size: Int = 50, genre: String? = nil) async throws -> [Track] {
        var params = [("size", String(size))]
        if let genre { params.append(("genre", genre)) }
        return try await request("getRandomSongs", params, key: "randomSongs", as: WireSongList.self)?.songs ?? []
    }

    func search(_ query: String, songs: Int = 30, albums: Int = 12, artists: Int = 8,
                songOffset: Int = 0, albumOffset: Int = 0, artistOffset: Int = 0) async throws -> SearchResults {
        try await request("search3", [
            ("query", query),
            ("songCount", String(songs)), ("songOffset", String(songOffset)),
            ("albumCount", String(albums)), ("albumOffset", String(albumOffset)),
            ("artistCount", String(artists)), ("artistOffset", String(artistOffset)),
        ], key: "searchResult3", as: WireSearch.self)?.results ?? SearchResults()
    }

    func starred() async throws -> SearchResults {
        try await request("getStarred2", key: "starred2", as: WireSearch.self)?.results ?? SearchResults()
    }

    // MARK: Playlists

    func playlists() async throws -> [Playlist] {
        try await request("getPlaylists", key: "playlists", as: WirePlaylists.self)?.playlists ?? []
    }

    func playlist(id: String) async throws -> (Playlist, [Track]) {
        guard let wire = try await request("getPlaylist", [("id", id)], key: "playlist", as: WirePlaylist.self) else {
            throw CrateError.invalidResponse
        }
        return (wire.playlist, wire.songs)
    }

    @discardableResult
    func createPlaylist(name: String, songIds: [String]) async throws -> Playlist? {
        let params = [("name", name)] + songIds.map { ("songId", $0) }
        return try await request("createPlaylist", params, key: "playlist", as: WirePlaylist.self, patient: true)?.playlist
    }

    func updatePlaylist(id: String, name: String? = nil, comment: String? = nil, add: [String] = [], removeIndexes: [Int] = []) async throws {
        var params = [("playlistId", id)]
        if let name { params.append(("name", name)) }
        if let comment { params.append(("comment", comment)) }
        params += add.map { ("songIdToAdd", $0) }
        params += removeIndexes.map { ("songIndexToRemove", String($0)) }
        // Adding an external song makes octo-fiesta download it and wait for a scan first.
        try await call("updatePlaylist", params, patient: add.contains(where: OctoID.isExternal))
    }

    func deletePlaylist(id: String) async throws {
        try await call("deletePlaylist", [("id", id)])
    }

    // MARK: Annotation

    func star(songId: String? = nil, albumId: String? = nil, artistId: String? = nil) async throws {
        var params: [(String, String)] = []
        if let songId { params.append(("id", songId)) }
        if let albumId { params.append(("albumId", albumId)) }
        if let artistId { params.append(("artistId", artistId)) }
        try await call("star", params)
    }

    func unstar(songId: String? = nil, albumId: String? = nil, artistId: String? = nil) async throws {
        var params: [(String, String)] = []
        if let songId { params.append(("id", songId)) }
        if let albumId { params.append(("albumId", albumId)) }
        if let artistId { params.append(("artistId", artistId)) }
        try await call("unstar", params)
    }

    func setRating(id: String, rating: Int) async throws {
        try await call("setRating", [("id", id), ("rating", String(rating))])
    }

    func scrobble(id: String, time: Date? = nil, submission: Bool) async throws {
        var params = [("id", id), ("submission", submission ? "true" : "false")]
        if let time { params.append(("time", String(Int64(time.timeIntervalSince1970 * 1000)))) }
        try await call("scrobble", params)
    }

    // MARK: Files

    /// Fetches an audio file to `destination`. Used for downloads and for octo-fiesta
    /// tracks, where streaming directly would hit the player's timeout.
    func fetchFile(from url: URL, to destination: URL, progress: (@Sendable (Double) -> Void)? = nil) async throws -> (URL, String?) {
        let delegate = DownloadProgressDelegate(progress: progress)
        let (tempURL, response) = try await patientSession.download(from: url, delegate: delegate)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: tempURL)
            throw CrateError.http(http.statusCode)
        }
        let mime = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")
        if let mime, mime.contains("json") || mime.contains("xml") {
            // A Subsonic error document instead of audio.
            let data = (try? Data(contentsOf: tempURL)) ?? Data()
            try? FileManager.default.removeItem(at: tempURL)
            if let body = try? JSONDecoder().decode(SubsonicPayload<Empty>.self, from: data), let error = body.error {
                throw CrateError.server(code: error.code, message: error.message ?? "")
            }
            throw CrateError.invalidResponse
        }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: tempURL, to: destination)
        return (destination, mime)
    }
}

private final class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let progress: (@Sendable (Double) -> Void)?
    init(progress: (@Sendable (Double) -> Void)?) { self.progress = progress }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        progress?(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
}

/// File extension for an audio MIME type, so AVFoundation picks the right decoder.
enum AudioFileType {
    static func fileExtension(mime: String?, fallback: String?) -> String {
        let mime = mime?.lowercased() ?? ""
        if mime.contains("flac") { return "flac" }
        if mime.contains("mpeg") || mime.contains("mp3") { return "mp3" }
        if mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac") { return "m4a" }
        if mime.contains("ogg") || mime.contains("opus") { return mime.contains("opus") ? "opus" : "ogg" }
        if mime.contains("wav") { return "wav" }
        if mime.contains("aiff") { return "aiff" }
        if let fallback, !fallback.isEmpty, fallback.lowercased() != "remote" { return fallback.lowercased() }
        return "mp3"
    }
}
