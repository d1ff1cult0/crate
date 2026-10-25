import Foundation

struct RecommendedTrack: Codable, Hashable, Sendable {
    var title: String
    var artist: String
    var album: String?
    var recordingMBID: String?
    var artworkURL: URL?
    var durationMs: Int?
    /// Similarity or relevance from the source (Last.fm `match`), when there is one.
    var weight: Double?
}

struct ListenBrainzPlaylistInfo: Sendable {
    var mbid: String
    var title: String
    var date: Date?
    var sourcePatch: String
}

/// ListenBrainz: the playlists its recommendation bots make every week (Weekly Jams,
/// Weekly Exploration, Daily Jams), LB Radio for autoplay, and listen submission.
struct ListenBrainzService: Sendable {
    private let base = URL(string: "https://api.listenbrainz.org/1/")!

    private func get(_ path: String, query: [URLQueryItem] = [], token: String? = nil) async throws -> Any {
        var components = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!, timeoutInterval: 20)
        if let token, !token.isEmpty { request.setValue("Token \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw CrateError.http(http.statusCode)
        }
        return try JSONSerialization.jsonObject(with: data)
    }

    func createdFor(user: String) async throws -> [ListenBrainzPlaylistInfo] {
        let encoded = user.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? user
        let json = try await get("user/\(encoded)/playlists/createdfor", query: [URLQueryItem(name: "count", value: "50")])
        guard let root = json as? [String: Any], let list = root["playlists"] as? [[String: Any]] else { return [] }
        return list.compactMap { wrapper in
            guard let playlist = wrapper["playlist"] as? [String: Any],
                  let identifier = playlist["identifier"] as? String,
                  let title = playlist["title"] as? String else { return nil }
            let ext = (playlist["extension"] as? [String: Any])?["https://musicbrainz.org/doc/jspf#playlist"] as? [String: Any]
            let meta = (ext?["additional_metadata"] as? [String: Any])?["algorithm_metadata"] as? [String: Any]
            let patch = meta?["source_patch"] as? String ?? "other"
            return ListenBrainzPlaylistInfo(
                mbid: String(identifier.split(separator: "/").last ?? ""),
                title: title,
                date: (playlist["date"] as? String).flatMap(Format.parseDate),
                sourcePatch: patch
            )
        }
    }

    func playlist(mbid: String) async throws -> [RecommendedTrack] {
        let json = try await get("playlist/\(mbid)")
        guard let root = json as? [String: Any], let playlist = root["playlist"] as? [String: Any] else { return [] }
        return Self.tracks(fromJSPF: playlist)
    }

    /// LB Radio from a prompt such as `artist:(Daft Punk)`. Needs a user token.
    func radio(prompt: String, mode: String = "easy", token: String) async throws -> [RecommendedTrack] {
        let json = try await get("explore/lb-radio", query: [
            URLQueryItem(name: "prompt", value: prompt), URLQueryItem(name: "mode", value: mode),
        ], token: token)
        guard let root = json as? [String: Any],
              let payload = root["payload"] as? [String: Any],
              let jspf = payload["jspf"] as? [String: Any],
              let playlist = jspf["playlist"] as? [String: Any] else { return [] }
        return Self.tracks(fromJSPF: playlist)
    }

    static func tracks(fromJSPF playlist: [String: Any]) -> [RecommendedTrack] {
        let tracks = playlist["track"] as? [[String: Any]] ?? []
        return tracks.compactMap { t in
            guard let title = t["title"] as? String, let creator = t["creator"] as? String else { return nil }
            let identifiers = (t["identifier"] as? [String]) ?? ((t["identifier"] as? String).map { [$0] } ?? [])
            let mbid = identifiers.first.flatMap { $0.split(separator: "/").last.map(String.init) }
            let ext = (t["extension"] as? [String: Any])?["https://musicbrainz.org/doc/jspf#track"] as? [String: Any]
            let meta = ext?["additional_metadata"] as? [String: Any]
            var artwork: URL?
            if let release = meta?["caa_release_mbid"] as? String {
                if let caa = meta?["caa_id"] as? Int {
                    artwork = URL(string: "https://coverartarchive.org/release/\(release)/\(caa)-250.jpg")
                } else {
                    artwork = URL(string: "https://coverartarchive.org/release/\(release)/front-250")
                }
            }
            return RecommendedTrack(
                title: title, artist: creator, album: t["album"] as? String, recordingMBID: mbid,
                artworkURL: artwork, durationMs: t["duration"] as? Int
            )
        }
    }

    /// Returns the user name for a valid token.
    func validate(token: String) async -> String? {
        guard let json = try? await get("validate-token", token: token) as? [String: Any],
              json["valid"] as? Bool == true else { return nil }
        return json["user_name"] as? String
    }

    func submit(track: Track, listenedAt: Date?, token: String) async {
        var metadata: [String: Any] = [
            "artist_name": track.artist,
            "track_name": track.title,
            "additional_info": [
                "media_player": "Crate",
                "submission_client": "Crate",
                "submission_client_version": AppInfo.version,
                "duration_ms": track.duration * 1000,
            ] as [String: Any],
        ]
        if !track.album.isEmpty { metadata["release_name"] = track.album }
        var listen: [String: Any] = ["track_metadata": metadata]
        if let listenedAt { listen["listened_at"] = Int(listenedAt.timeIntervalSince1970) }
        let body: [String: Any] = ["listen_type": listenedAt == nil ? "playing_now" : "single", "payload": [listen]]
        var request = URLRequest(url: base.appendingPathComponent("submit-listens"), timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("Token \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: request)
    }
}

/// Last.fm has no recommendations endpoint any more, so Crate builds its weekly mix from
/// the user's recent top tracks and Last.fm's track similarity.
struct LastFMService: Sendable {
    private let base = URL(string: "https://ws.audioscrobbler.com/2.0/")!

    private func call(_ method: String, _ params: [String: String], key: String) async throws -> [String: Any] {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "method", value: method), URLQueryItem(name: "api_key", value: key),
            URLQueryItem(name: "format", value: "json"),
        ] + params.map { URLQueryItem(name: $0.key, value: $0.value) }
        let (data, response) = try await URLSession.shared.data(for: URLRequest(url: components.url!, timeoutInterval: 20))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw CrateError.http(http.statusCode)
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CrateError.invalidResponse }
        if let code = json["error"] as? Int {
            throw CrateError.server(code: code, message: json["message"] as? String ?? "Last.fm error")
        }
        return json
    }

    private static func tracks(_ list: Any?) -> [RecommendedTrack] {
        let items: [[String: Any]]
        if let array = list as? [[String: Any]] { items = array } else if let single = list as? [String: Any] { items = [single] } else { items = [] }
        return items.compactMap { item in
            guard let name = item["name"] as? String else { return nil }
            let artist: String
            if let a = item["artist"] as? [String: Any] {
                artist = (a["name"] as? String) ?? (a["#text"] as? String) ?? ""
            } else {
                artist = item["artist"] as? String ?? ""
            }
            guard !artist.isEmpty else { return nil }
            let match = (item["match"] as? Double) ?? (item["match"] as? String).flatMap(Double.init)
            return RecommendedTrack(title: name, artist: artist, weight: match)
        }
    }

    func topTracks(user: String, period: String, limit: Int, key: String) async throws -> [RecommendedTrack] {
        let json = try await call("user.gettoptracks", ["user": user, "period": period, "limit": String(limit)], key: key)
        return Self.tracks((json["toptracks"] as? [String: Any])?["track"])
    }

    func lovedTracks(user: String, limit: Int, key: String) async throws -> [RecommendedTrack] {
        let json = try await call("user.getlovedtracks", ["user": user, "limit": String(limit)], key: key)
        return Self.tracks((json["lovedtracks"] as? [String: Any])?["track"])
    }

    func similarTracks(artist: String, track: String, limit: Int, key: String) async throws -> [RecommendedTrack] {
        let json = try await call("track.getsimilar", ["artist": artist, "track": track, "limit": String(limit), "autocorrect": "1"], key: key)
        return Self.tracks((json["similartracks"] as? [String: Any])?["track"])
    }

    func topArtists(user: String, period: String, limit: Int, key: String) async throws -> [String] {
        let json = try await call("user.gettopartists", ["user": user, "period": period, "limit": String(limit)], key: key)
        let list = (json["topartists"] as? [String: Any])?["artist"] as? [[String: Any]] ?? []
        return list.compactMap { $0["name"] as? String }
    }

    func similarArtists(artist: String, limit: Int, key: String) async throws -> [String] {
        let json = try await call("artist.getsimilar", ["artist": artist, "limit": String(limit), "autocorrect": "1"], key: key)
        let list = (json["similarartists"] as? [String: Any])?["artist"] as? [[String: Any]] ?? []
        return list.compactMap { $0["name"] as? String }
    }

    func artistTopTracks(artist: String, limit: Int, key: String) async throws -> [RecommendedTrack] {
        let json = try await call("artist.gettoptracks", ["artist": artist, "limit": String(limit), "autocorrect": "1"], key: key)
        return Self.tracks((json["toptracks"] as? [String: Any])?["track"])
    }

    func validate(user: String, key: String) async -> Bool {
        (try? await call("user.getinfo", ["user": user], key: key)) != nil
    }
}

enum AppInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }
}
