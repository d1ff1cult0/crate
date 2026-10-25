import Foundation
import Observation

struct LyricLine: Codable, Hashable, Identifiable, Sendable {
    var id: Int
    /// Seconds from the start of the song; nil for unsynced lyrics.
    var start: Double?
    var text: String
}

struct Lyrics: Codable, Hashable, Sendable {
    var lines: [LyricLine]
    var synced: Bool
    var source: String
}

/// Lyrics from the server (embedded or sidecar, and octo-fiesta's LRCLIB lookup for
/// external songs), upgraded to time-synced lyrics from LRCLIB when the server only has
/// plain text. Results are kept in the library database so they also work offline.
@MainActor
@Observable
final class LyricsStore {
    @ObservationIgnored private let library: LibraryStore
    @ObservationIgnored private var memory: [String: Lyrics] = [:]
    @ObservationIgnored private var misses: Set<String> = []
    @ObservationIgnored private var inFlight: [String: Task<Lyrics?, Never>] = [:]

    init(library: LibraryStore) {
        self.library = library
    }

    func cached(_ track: Track) -> Lyrics? {
        if let hit = memory[track.id] { return hit }
        if let stored = library.db?.lyrics(songId: track.id) {
            memory[track.id] = stored
            return stored
        }
        return nil
    }

    func lyrics(for track: Track) async -> Lyrics? {
        if let hit = cached(track) { return hit }
        if misses.contains(track.id) { return nil }
        if let task = inFlight[track.id] { return await task.value }
        let client = library.client
        let task = Task<Lyrics?, Never> {
            var server: Lyrics?
            if let client, let structured = try? await client.lyrics(id: track.id) {
                server = Self.best(structured)
            }
            if let server, server.synced { return server }
            if let synced = await LRCLib.lookup(track: track), synced.synced || server == nil {
                return synced
            }
            return server
        }
        inFlight[track.id] = task
        let result = await task.value
        inFlight[track.id] = nil
        if let result {
            memory[track.id] = result
            library.db?.saveLyrics(songId: track.id, result)
        } else {
            misses.insert(track.id)
        }
        return result
    }

    /// Fetches ahead for the next song so the view switches instantly.
    func prefetch(_ track: Track?) {
        guard let track, cached(track) == nil, !misses.contains(track.id) else { return }
        Task { _ = await lyrics(for: track) }
    }

    static func best(_ list: [StructuredLyrics]) -> Lyrics? {
        guard let pick = list.first(where: \.synced) ?? list.first, !pick.lines.isEmpty else { return nil }
        let offset = pick.offsetMs / 1000
        let lines = pick.lines.enumerated().map { i, line in
            LyricLine(id: i, start: pick.synced ? line.startMs.map { max(0, Double($0) / 1000 - offset) } : nil, text: line.text)
        }
        return Lyrics(lines: lines, synced: pick.synced, source: "Navidrome")
    }
}

/// LRCLIB (lrclib.net): a free, open lyrics database with time-synced LRC lyrics.
enum LRCLib {
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.httpAdditionalHeaders = ["User-Agent": "Crate/\(AppInfo.version) (macOS music player for Navidrome)"]
        return URLSession(configuration: config)
    }()

    static func lookup(track: Track) async -> Lyrics? {
        let artist = TextKey.primaryCredit(track.artist)
        var exact = URLComponents(string: "https://lrclib.net/api/get")!
        exact.queryItems = [
            URLQueryItem(name: "track_name", value: track.title),
            URLQueryItem(name: "artist_name", value: artist),
            URLQueryItem(name: "album_name", value: track.album),
            URLQueryItem(name: "duration", value: String(track.duration)),
        ]
        if let record = await fetch(exact.url!) as? [String: Any], let lyrics = parse(record) {
            return lyrics
        }
        // No exact match (album or duration differ): search and take the closest synced hit.
        var search = URLComponents(string: "https://lrclib.net/api/search")!
        search.queryItems = [URLQueryItem(name: "track_name", value: track.title), URLQueryItem(name: "artist_name", value: artist)]
        guard let results = await fetch(search.url!) as? [[String: Any]] else { return nil }
        let candidates = results.filter { record in
            let duration = record["duration"] as? Double ?? 0
            return track.duration == 0 || abs(duration - Double(track.duration)) < 6
        }
        let ordered = candidates.sorted { a, _ in (a["syncedLyrics"] as? String)?.isEmpty == false }
        for record in ordered {
            if let lyrics = parse(record) { return lyrics }
        }
        return nil
    }

    private static func fetch(_ url: URL) async -> Any? {
        guard let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func parse(_ record: [String: Any]) -> Lyrics? {
        if record["instrumental"] as? Bool == true {
            return Lyrics(lines: [LyricLine(id: 0, start: 0, text: "♪ Instrumental")], synced: false, source: "LRCLIB")
        }
        if let synced = record["syncedLyrics"] as? String, let lines = parseLRC(synced), !lines.isEmpty {
            return Lyrics(lines: lines, synced: true, source: "LRCLIB")
        }
        if let plain = record["plainLyrics"] as? String, !plain.isEmpty {
            let lines = plain.components(separatedBy: .newlines).enumerated().map { LyricLine(id: $0, start: nil, text: $1.trimmingCharacters(in: .whitespaces)) }
            return Lyrics(lines: lines, synced: false, source: "LRCLIB")
        }
        return nil
    }

    /// Parses `[mm:ss.xx] text` lines; a line may carry several timestamps.
    static func parseLRC(_ text: String) -> [LyricLine]? {
        var entries: [(Double, String)] = []
        for raw in text.components(separatedBy: .newlines) {
            var rest = Substring(raw)
            var stamps: [Double] = []
            while rest.hasPrefix("["), let close = rest.firstIndex(of: "]") {
                let tag = rest[rest.index(after: rest.startIndex)..<close]
                let parts = tag.split(separator: ":")
                if parts.count == 2, let minutes = Double(parts[0]), let seconds = Double(parts[1]) {
                    stamps.append(minutes * 60 + seconds)
                }
                rest = rest[rest.index(after: close)...]
            }
            let lyric = rest.trimmingCharacters(in: .whitespaces)
            for stamp in stamps { entries.append((stamp, lyric)) }
        }
        guard !entries.isEmpty else { return nil }
        return entries.sorted { $0.0 < $1.0 }.enumerated().map { LyricLine(id: $0, start: $1.0, text: $1.1) }
    }
}
