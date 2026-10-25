import Foundation
import Observation

struct MixEntry: Identifiable, Codable, Hashable, Sendable {
    enum State: String, Codable, Sendable { case pending, library, external, missing }
    var id: String
    var title: String
    var artist: String
    var album: String?
    var artworkURL: URL?
    var track: Track?
    var state: State
}

struct Mix: Identifiable, Codable, Hashable, Sendable {
    enum Source: String, Codable, Sendable { case listenBrainz, lastFM, library }
    var id: String
    var source: Source
    var title: String
    var subtitle: String
    var detail: String
    var symbol: String
    var hue: String
    var created: Date
    /// The upstream identity (ListenBrainz playlist MBID, ISO week) to know when to rebuild.
    var version: String
    var entries: [MixEntry]

    var playable: [Track] { entries.compactMap(\.track) }
    var resolvedCount: Int { entries.filter { $0.state == .library || $0.state == .external }.count }
    var pendingCount: Int { entries.filter { $0.state == .pending }.count }
    var tagHue: TagHue { TagHue(rawValue: hue) ?? .blue }
}

/// Weekly and daily mixes: ListenBrainz's recommendation playlists, a Last.fm weekly mix
/// built from track similarity, and mixes from the library itself. Recommended songs are
/// matched to the library first and to octo-fiesta otherwise, so a mix plays in full
/// even when most of it isn't in the library yet.
@MainActor
@Observable
final class MixStore {
    private(set) var mixes: [Mix] = []
    private(set) var refreshing: Set<Mix.Source> = []
    private(set) var errors: [Mix.Source: String] = [:]
    private(set) var resolving: Set<String> = []

    @ObservationIgnored private let library: LibraryStore
    @ObservationIgnored private let settings: SettingsStore
    @ObservationIgnored private let resolver: TrackResolver
    @ObservationIgnored private let listenBrainz = ListenBrainzService()
    @ObservationIgnored private let lastFM = LastFMService()
    @ObservationIgnored private var lastRefresh: Date?

    init(library: LibraryStore, settings: SettingsStore, resolver: TrackResolver) {
        self.library = library
        self.settings = settings
        self.resolver = resolver
    }

    static let order: [String] = [
        "lb:weekly-jams", "lb:weekly-exploration", "lb:daily-jams", "lfm:weekly", "lfm:discovery",
        "lib:on-repeat", "lib:forgotten", "lib:deep-cuts", "lib:fresh", "lib:top-rated",
        "lb:top-discoveries", "lb:top-missed",
    ]

    func mixes(for source: Mix.Source) -> [Mix] {
        mixes.filter { $0.source == source }
    }

    func mix(id: String) -> Mix? {
        mixes.first { $0.id == id }
    }

    func loadCached() {
        guard let db = library.db else {
            mixes = []
            return
        }
        let decoder = JSONDecoder()
        mixes = sort(db.mixes().compactMap { try? decoder.decode(Mix.self, from: $0) })
    }

    func reset() {
        mixes = []
        lastRefresh = nil
        resolver.clear()
    }

    private func sort(_ list: [Mix]) -> [Mix] {
        list.sorted { (Self.order.firstIndex(of: $0.id) ?? 99) < (Self.order.firstIndex(of: $1.id) ?? 99) }
    }

    private func save(_ mix: Mix, persist: Bool = true) {
        if let index = mixes.firstIndex(where: { $0.id == mix.id }) {
            if mixes[index] != mix { mixes[index] = mix }
        } else {
            mixes = sort(mixes + [mix])
        }
        guard persist else { return }
        if let data = try? JSONEncoder().encode(mix) {
            library.db?.saveMix(id: mix.id, payload: data)
        }
    }

    private func remove(prefix: String) {
        for mix in mixes where mix.id.hasPrefix(prefix) {
            library.db?.deleteMix(id: mix.id)
        }
        mixes.removeAll { $0.id.hasPrefix(prefix) }
    }

    func refreshIfStale() {
        if let lastRefresh, Date().timeIntervalSince(lastRefresh) < 3 * 3600 { return }
        Task { await refresh(force: false) }
    }

    func refresh(force: Bool) async {
        lastRefresh = Date()
        async let lb: Void = refreshListenBrainz(force: force)
        async let lfm: Void = refreshLastFM(force: force)
        refreshLibraryMixes(force: force)
        _ = await (lb, lfm)
    }

    // MARK: ListenBrainz

    private func refreshListenBrainz(force: Bool) async {
        let user = settings.listenBrainzUser.trimmingCharacters(in: .whitespaces)
        guard !user.isEmpty else {
            remove(prefix: "lb:")
            return
        }
        refreshing.insert(.listenBrainz)
        defer { refreshing.remove(.listenBrainz) }
        do {
            let playlists = try await listenBrainz.createdFor(user: user)
            errors[.listenBrainz] = nil
            let year = Calendar.current.component(.year, from: Date())
            let wanted: [(id: String, match: (String) -> Bool, title: String, symbol: String, hue: TagHue, detail: String)] = [
                ("lb:weekly-jams", { $0 == "weekly-jams" }, "Weekly Jams", "music.note.list", .blue,
                 "Songs you love and songs like them, refreshed every Monday by ListenBrainz."),
                ("lb:weekly-exploration", { $0 == "weekly-exploration" }, "Weekly Exploration", "safari", .purple,
                 "New-to-you songs picked from listeners with similar taste. Refreshed every Monday."),
                ("lb:daily-jams", { $0 == "daily-jams" }, "Daily Jams", "sun.max", .amber,
                 "A fresh daily mix of your favourites and close neighbours."),
                ("lb:top-discoveries", { $0.hasPrefix("top-discoveries") }, "Top Discoveries", "sparkles", .teal,
                 "The songs you discovered last year and kept coming back to."),
                ("lb:top-missed", { $0.hasPrefix("top-missed") }, "Top Missed Recordings", "questionmark.circle", .pink,
                 "Popular with listeners like you, but not something you played."),
            ]
            for spec in wanted {
                guard let latest = playlists.filter({ spec.match($0.sourcePatch) }).max(by: { ($0.date ?? .distantPast) < ($1.date ?? .distantPast) }) else {
                    continue
                }
                if !force, let existing = mix(id: spec.id), existing.version == latest.mbid {
                    if existing.pendingCount > 0 { await resolve(existing.id) }
                    continue
                }
                let tracks = try await listenBrainz.playlist(mbid: latest.mbid)
                let entries = tracks.enumerated().map { i, t in
                    MixEntry(id: "\(i)-\(t.recordingMBID ?? t.title)", title: t.title, artist: t.artist, album: t.album,
                             artworkURL: t.artworkURL, track: nil, state: .pending)
                }
                let subtitle: String
                if spec.id == "lb:top-discoveries" || spec.id == "lb:top-missed" {
                    subtitle = latest.title.components(separatedBy: " for ").first?.replacingOccurrences(of: spec.title + " of ", with: "") ?? String(year - 1)
                } else if let date = latest.date {
                    subtitle = "Updated " + date.formatted(.dateTime.day().month(.abbreviated))
                } else {
                    subtitle = "ListenBrainz"
                }
                save(Mix(id: spec.id, source: .listenBrainz, title: spec.title, subtitle: subtitle, detail: spec.detail,
                         symbol: spec.symbol, hue: spec.hue.rawValue, created: latest.date ?? Date(), version: latest.mbid, entries: entries))
                await resolve(spec.id)
            }
        } catch {
            errors[.listenBrainz] = error.isConnectivityError ? "ListenBrainz is unreachable right now." : "Couldn't load ListenBrainz playlists for “\(user)”."
        }
    }

    // MARK: Last.fm

    private func refreshLastFM(force: Bool) async {
        guard settings.hasLastFM else {
            remove(prefix: "lfm:")
            return
        }
        let user = settings.lastFMUser.trimmingCharacters(in: .whitespaces)
        let key = settings.lastFMKey
        let week = Self.isoWeek()
        if !force, let existing = mix(id: "lfm:weekly"), existing.version == week, mix(id: "lfm:discovery")?.version == week {
            for id in ["lfm:weekly", "lfm:discovery"] where (mix(id: id)?.pendingCount ?? 0) > 0 {
                await resolve(id)
            }
            return
        }
        refreshing.insert(.lastFM)
        defer { refreshing.remove(.lastFM) }
        do {
            // Weekly mix: what's similar to this month's most played songs, minus what
            // you already play a lot.
            let seeds = try await lastFM.topTracks(user: user, period: "1month", limit: 15, key: key)
            let known = try await lastFM.topTracks(user: user, period: "overall", limit: 300, key: key)
            let knownKeys = Set(known.map { TextKey.songKey(title: $0.title, artist: $0.artist) })
            var scores: [String: (RecommendedTrack, Double)] = [:]
            await withTaskGroup(of: [RecommendedTrack].self) { group in
                for seed in seeds {
                    group.addTask { (try? await self.lastFM.similarTracks(artist: seed.artist, track: seed.title, limit: 20, key: key)) ?? [] }
                }
                for await similar in group {
                    for rec in similar {
                        let k = TextKey.songKey(title: rec.title, artist: rec.artist)
                        guard !knownKeys.contains(k) else { continue }
                        let weight = rec.weight ?? 0.3
                        scores[k] = (rec, (scores[k]?.1 ?? 0) + weight)
                    }
                }
            }
            let ranked = Self.spreadArtists(scores.values.sorted { $0.1 > $1.1 }.map(\.0), limit: 40)
            save(Mix(id: "lfm:weekly", source: .lastFM, title: "Last.fm Weekly Mix", subtitle: "Week \(week.split(separator: "-").last ?? "")",
                     detail: "Built from what you scrobbled this month and the songs Last.fm finds similar. New every week.",
                     symbol: "waveform", hue: TagHue.red.rawValue, created: Date(), version: week,
                     entries: ranked.enumerated().map { MixEntry(id: "\($0)-\($1.title)", title: $1.title, artist: $1.artist, album: nil, artworkURL: nil, track: nil, state: .pending) }))

            // Discovery: top songs of artists similar to your top artists that you don't play.
            let topArtists = try await lastFM.topArtists(user: user, period: "3month", limit: 8, key: key)
            let knownArtists = Set(try await lastFM.topArtists(user: user, period: "overall", limit: 400, key: key).map(TextKey.fold))
            var discovered: [String] = []
            for artist in topArtists {
                let similar = (try? await lastFM.similarArtists(artist: artist, limit: 8, key: key)) ?? []
                for name in similar where !knownArtists.contains(TextKey.fold(name)) && !discovered.contains(name) {
                    discovered.append(name)
                }
            }
            var discoveryTracks: [RecommendedTrack] = []
            for name in discovered.prefix(18) {
                let top = (try? await lastFM.artistTopTracks(artist: name, limit: 2, key: key)) ?? []
                discoveryTracks += top
            }
            save(Mix(id: "lfm:discovery", source: .lastFM, title: "Last.fm Discovery", subtitle: "Artists new to you",
                     detail: "The best-known songs of artists close to the ones you play, but that you haven't scrobbled.",
                     symbol: "binoculars", hue: TagHue.orange.rawValue, created: Date(), version: week,
                     entries: discoveryTracks.shuffled().enumerated().map { MixEntry(id: "\($0)-\($1.title)", title: $1.title, artist: $1.artist, album: nil, artworkURL: nil, track: nil, state: .pending) }))
            errors[.lastFM] = nil
            await resolve("lfm:weekly")
            await resolve("lfm:discovery")
        } catch {
            errors[.lastFM] = error.isConnectivityError ? "Last.fm is unreachable right now." : "Couldn't build the Last.fm mix. Check the user name and API key in Settings."
        }
    }

    static func isoWeek(_ date: Date = Date()) -> String {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = .current
        let comps = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return "\(comps.yearForWeekOfYear ?? 0)-W\(comps.weekOfYear ?? 0)"
    }

    static func spreadArtists(_ tracks: [RecommendedTrack], limit: Int) -> [RecommendedTrack] {
        var perArtist: [String: Int] = [:]
        var result: [RecommendedTrack] = []
        for t in tracks {
            let a = TextKey.primaryArtist(t.artist)
            if perArtist[a, default: 0] >= 2 { continue }
            perArtist[a, default: 0] += 1
            result.append(t)
            if result.count == limit { break }
        }
        return result
    }

    // MARK: Library mixes

    private func refreshLibraryMixes(force: Bool) {
        guard let db = library.db, library.songCount > 0 else { return }
        let today = Calendar.current.startOfDay(for: Date())
        let version = String(Int(today.timeIntervalSince1970))
        func build(_ id: String, _ title: String, _ subtitle: String, _ detail: String, _ symbol: String, _ hue: TagHue, _ tracks: [Track]) {
            if !force, mix(id: id)?.version == version { return }
            guard tracks.count >= 5 else {
                library.db?.deleteMix(id: id)
                mixes.removeAll { $0.id == id }
                return
            }
            let entries = tracks.map { MixEntry(id: $0.id, title: $0.title, artist: $0.artist, album: $0.album, artworkURL: nil, track: $0, state: .library) }
            save(Mix(id: id, source: .library, title: title, subtitle: subtitle, detail: detail, symbol: symbol, hue: hue.rawValue,
                     created: Date(), version: version, entries: entries))
        }
        let onRepeat = db.songs(ids: db.onRepeatSongIds(since: Date().addingTimeInterval(-30 * 86400), limit: 50))
        let frequent = onRepeat.count >= 10 ? onRepeat : (onRepeat + db.mostPlayedSongs(limit: 60).filter { t in !onRepeat.contains { $0.id == t.id } }).prefix(50).map { $0 }
        build("lib:on-repeat", "On Repeat", "Your most played", "The songs you can't stop playing lately.", "repeat", .green, frequent.shuffled())
        build("lib:forgotten", "Forgotten Favourites", "Not heard in a while", "Songs you rated highly or played a lot, but not in the last two months.",
              "clock.arrow.circlepath", .lime, db.forgottenFavourites(olderThan: Date().addingTimeInterval(-60 * 86400), limit: 50))
        build("lib:deep-cuts", "Deep Cuts", "Unplayed songs by artists you love", "Songs in your library you've never played, by the artists you play most.",
              "square.stack.3d.down.right", .teal, AutoplayEngine.diversify(db.deepCuts(limit: 150), count: 50, recentArtists: []))
        build("lib:fresh", "Fresh in Your Library", "Recently added", "The newest additions to your library, including what octo-fiesta fetched.",
              "leaf", .blue, db.recentlyAddedSongs(limit: 60))
        build("lib:top-rated", "Top Rated", "Four stars and up", "Your highest-rated songs and favourites, shuffled.", "star", .amber, db.topRated(limit: 60))
    }

    // MARK: Resolution

    func resolve(_ mixId: String) async {
        guard !resolving.contains(mixId), var mix = mix(id: mixId) else { return }
        resolving.insert(mixId)
        defer { resolving.remove(mixId) }
        let pending = mix.entries.indices.filter { mix.entries[$0].state == .pending }
        // Library matches first (instant), then octo-fiesta lookups four at a time.
        for i in pending {
            if let local = resolver.local(title: mix.entries[i].title, artist: mix.entries[i].artist) {
                mix.entries[i].track = local
                mix.entries[i].state = .library
            }
        }
        let remaining = pending.filter { mix.entries[$0].state == .pending }
        save(mix, persist: remaining.isEmpty)
        // Every publish redraws the open mix page, so results go out every 16 lookups
        // (and once at the end) rather than after each batch of 4.
        var sincePublish = 0
        for chunk in stride(from: 0, to: remaining.count, by: 4) {
            let slice = Array(remaining[chunk..<min(chunk + 4, remaining.count)])
            let lookups = slice.map { (index: $0, title: mix.entries[$0].title, artist: mix.entries[$0].artist) }
            let resolver = self.resolver
            let results = await withTaskGroup(of: (Int, Track?).self) { group in
                for lookup in lookups {
                    group.addTask { @MainActor in
                        (lookup.index, await resolver.resolve(title: lookup.title, artist: lookup.artist, allowExternal: true))
                    }
                }
                var collected: [(Int, Track?)] = []
                for await result in group { collected.append(result) }
                return collected
            }
            // Build on the local copy (the store is only updated every few batches), and
            // stop if the mix was replaced by a newer week's in the meantime.
            guard self.mix(id: mixId)?.version == mix.version else { return }
            var latest = mix
            for (index, track) in results where latest.entries.indices.contains(index) {
                if var track {
                    if track.artworkURL == nil { track.artworkURL = latest.entries[index].artworkURL }
                    latest.entries[index].track = track
                    latest.entries[index].state = track.isExternal ? .external : .library
                } else {
                    latest.entries[index].state = .missing
                }
            }
            mix = latest
            sincePublish += slice.count
            let done = chunk + 4 >= remaining.count
            if sincePublish >= 16 || done {
                save(latest, persist: done)
                sincePublish = 0
            }
        }
    }

    /// Saves the playable part of a mix as a Navidrome playlist.
    func saveAsPlaylist(_ mix: Mix) async -> Playlist? {
        let name = "\(mix.title) · \(mix.created.formatted(.dateTime.day().month(.abbreviated).year()))"
        return await library.createPlaylist(name: name, tracks: mix.playable)
    }
}
