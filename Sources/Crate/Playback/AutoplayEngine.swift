import Foundation

/// Decides what plays when the queue runs out.
///
/// Candidates come from several sources at once (Navidrome's similar songs, similar
/// artists from the library, ListenBrainz radio and Last.fm similar tracks when set up,
/// and the seed's genre). Each candidate is scored on how it was found, your ratings and
/// favourites, how recently you heard it, songs you've skipped and what you skipped this
/// session. The pick keeps artists apart so the result plays like a radio station
/// rather than an artist dump.
@MainActor
final class AutoplayEngine {
    enum Seed {
        case recent([Track])
        case artist(name: String, id: String?)
        case genre(String)
        case track(Track)
    }

    struct Candidate {
        var track: Track
        var score: Double
        var source: String
    }

    private let library: LibraryStore
    private let settings: SettingsStore
    private let resolver: TrackResolver
    private let listenBrainz = ListenBrainzService()
    private let lastFM = LastFMService()

    /// Artist key → penalty from skips this session; decays as other music plays through.
    private var artistPenalty: [String: Double] = [:]
    private var artistBoost: [String: Double] = [:]

    init(library: LibraryStore, settings: SettingsStore, resolver: TrackResolver) {
        self.library = library
        self.settings = settings
        self.resolver = resolver
    }

    // MARK: Feedback

    func feedback(_ track: Track, skipped: Bool, fromAutoplay: Bool) {
        let key = TextKey.primaryArtist(track.artist)
        if skipped {
            artistPenalty[key, default: 0] += fromAutoplay ? 0.6 : 0.3
            artistBoost[key] = nil
        } else {
            artistBoost[key] = min((artistBoost[key] ?? 0) + 0.08, 0.3)
            for (k, v) in artistPenalty {
                artistPenalty[k] = v * 0.85 < 0.05 ? nil : v * 0.85
            }
        }
    }

    // MARK: Picking

    /// Up to `count` tracks to follow `context` (what played and what's queued).
    func pick(seed: Seed, context: [Track], count: Int, isAvailable: @escaping (Track) -> Bool) async -> [Track] {
        let allowExternal = settings.autoplayExternal || settings.discovery == .adventurous
        var candidates = await gather(seed: seed, allowExternal: allowExternal)

        let excludedIds = Set(context.map(\.id))
        let excludedKeys = Set(context.map { TextKey.songKey(title: $0.title, artist: $0.artist) })
        let skips = recentSkips()

        candidates = candidates.filter { c in
            !excludedIds.contains(c.track.id)
                && !excludedKeys.contains(TextKey.songKey(title: c.track.title, artist: c.track.artist))
                && (allowExternal || !c.track.isExternal)
                && isAvailable(c.track)
        }

        // Merge duplicates found by several sources: agreement between sources is a
        // strong signal, so a song found twice outranks one found once.
        var merged: [String: Candidate] = [:]
        for c in candidates {
            let key = TextKey.songKey(title: c.track.title, artist: c.track.artist)
            if var existing = merged[key] {
                existing.score = max(existing.score, c.score) + min(existing.score, c.score) * 0.35
                if existing.track.isExternal && !c.track.isExternal { existing.track = c.track }
                merged[key] = existing
            } else {
                merged[key] = c
            }
        }

        var scored: [Candidate] = []
        for var c in merged.values {
            guard let adjusted = adjust(c.score, c.track, skips: skips) else { continue }
            c.score = adjusted
            scored.append(c)
        }
        scored.sort { $0.score > $1.score }

        let tail = context.suffix(2).map { TextKey.primaryArtist($0.artist) }
        var picked = Self.diversify(scored.map(\.track), count: count, recentArtists: tail)

        if picked.count < count {
            // Thin results (offline, tiny library, nothing similar): fill from the library.
            let filler = (library.db?.randomSongs(genre: seedGenre(seed), limit: 80) ?? [])
                .filter { t in isAvailable(t) && !excludedIds.contains(t.id) && !picked.contains { $0.id == t.id } && library.rating(of: t) != 1 }
            picked += Self.diversify(filler, count: count - picked.count, recentArtists: picked.suffix(2).map { TextKey.primaryArtist($0.artist) })
        }
        return picked
    }

    private func seedGenre(_ seed: Seed) -> String? {
        switch seed {
        case let .recent(tracks): tracks.last?.genre
        case let .track(track): track.genre
        case let .genre(genre): genre
        case .artist: nil
        }
    }

    /// Greedy pick in score order with at most two songs per artist and never the same
    /// artist back to back.
    nonisolated static func diversify(_ tracks: [Track], count: Int, recentArtists: [String]) -> [Track] {
        var picked: [Track] = []
        var perArtist: [String: Int] = [:]
        var remaining = tracks
        var lastArtist = recentArtists.last
        for pass in 0..<2 where picked.count < count {
            var next: [Track] = []
            for track in remaining {
                let artist = TextKey.primaryArtist(track.artist)
                let limit = pass == 0 ? 2 : 3
                if picked.count >= count || perArtist[artist, default: 0] >= limit || artist == lastArtist
                    || (pass == 0 && picked.isEmpty && recentArtists.contains(artist)) {
                    next.append(track)
                    continue
                }
                picked.append(track)
                perArtist[artist, default: 0] += 1
                lastArtist = artist
            }
            remaining = next
        }
        return picked
    }

    private func adjust(_ base: Double, _ track: Track, skips: [String: Int]) -> Double? {
        let rating = library.rating(of: track)
        if rating == 1 { return nil }
        var score = base
        switch rating {
        case 5: score += 0.45
        case 4: score += 0.3
        case 3: score += 0.05
        case 2: score -= 0.4
        default: break
        }
        if library.isStarred(track) { score += 0.3 }

        let plays = Double(min(track.playCount, 25))
        switch settings.discovery {
        case .familiar:
            score += plays * 0.02
            if track.isExternal { score -= 0.6 }
        case .balanced:
            if track.playCount == 0 { score += 0.08 }
            if track.isExternal { score -= 0.12 }
        case .adventurous:
            score += track.playCount == 0 ? 0.25 : -plays * 0.01
            if track.isExternal { score += 0.1 }
        }

        if let played = track.played {
            let age = Date().timeIntervalSince(played)
            let window: TimeInterval = 4 * 86400
            if age < window { score -= 0.45 * (1 - age / window) }
        }
        score -= Double(skips[track.id] ?? 0) * 0.35

        let artist = TextKey.primaryArtist(track.artist)
        score -= artistPenalty[artist] ?? 0
        score += artistBoost[artist] ?? 0
        score += Double.random(in: 0...0.2)
        return score
    }

    private func recentSkips() -> [String: Int] {
        guard let db = library.db else { return [:] }
        var counts: [String: Int] = [:]
        for play in db.recentPlays(since: Date().addingTimeInterval(-30 * 86400)) where play.skipped {
            counts[play.songId, default: 0] += 1
        }
        return counts
    }

    // MARK: Sources

    private func gather(seed: Seed, allowExternal: Bool) async -> [Candidate] {
        switch seed {
        case let .recent(tracks):
            // The last three distinct artists, most recent weighted highest.
            var seeds: [Track] = []
            for track in tracks.reversed() where !seeds.contains(where: { TextKey.primaryArtist($0.artist) == TextKey.primaryArtist(track.artist) }) {
                seeds.append(track)
                if seeds.count == 3 { break }
            }
            let weights = [1.0, 0.75, 0.55]
            var all: [Candidate] = []
            await withTaskGroup(of: [Candidate].self) { group in
                for (i, s) in seeds.enumerated() {
                    group.addTask { await self.candidates(forTrack: s, weight: weights[i], allowExternal: allowExternal, rich: i == 0) }
                }
                for await batch in group { all += batch }
            }
            return all
        case let .track(track):
            return await candidates(forTrack: track, weight: 1, allowExternal: allowExternal, rich: true)
        case let .artist(name, id):
            return await candidates(forArtist: name, id: id, allowExternal: allowExternal)
        case let .genre(genre):
            let songs = library.db?.randomSongs(genre: genre, limit: 120) ?? []
            return songs.map { Candidate(track: $0, score: 0.6, source: "genre") }
        }
    }

    private func candidates(forTrack seed: Track, weight w: Double, allowExternal: Bool, rich: Bool) async -> [Candidate] {
        guard let client = library.client, let db = library.db else {
            return (library.db?.randomSongs(genre: seed.genre, limit: 40) ?? []).map { Candidate(track: $0, score: 0.3 * w, source: "genre") }
        }
        var result: [Candidate] = []
        let localId = seed.isExternal ? await library.resolveLocal(seed.id) : seed.id
        let localSeed = localId.flatMap { db.song(id: $0) }
        let artistId = localSeed?.artistId ?? db.artist(named: TextKey.primaryCredit(seed.artist))?.id

        // Navidrome's similar songs (its Last.fm/ListenBrainz agents, limited to the library).
        async let similarSongs: [Track] = {
            guard let localId else { return [] }
            return (try? await client.similarSongs(id: localId, count: 40)) ?? []
        }()
        // Similar artists, then their best songs from the library.
        async let similarArtists: [Artist] = {
            guard let artistId else { return [] }
            return (try? await client.artistInfo(id: artistId, count: 10))?.similar ?? []
        }()
        async let radio: [RecommendedTrack] = rich ? listenBrainzRadio(artist: TextKey.primaryCredit(seed.artist)) : []
        async let lastFMSimilar: [RecommendedTrack] = rich ? lastFMSimilarTracks(seed) : []

        for (rank, track) in await similarSongs.enumerated() {
            result.append(Candidate(track: track, score: w * (1.0 - Double(rank) * 0.01), source: "similar"))
        }
        for (rank, artist) in await similarArtists.enumerated() {
            let songs = artist.isExternal ? db.songs(artistName: artist.name, limit: 40) : db.songs(artistId: artist.id, limit: 40)
            for track in Self.weightedSample(songs, count: 4, rating: library.rating) {
                result.append(Candidate(track: track, score: w * 0.62 * (1 - Double(rank) * 0.04), source: "similar-artist"))
            }
        }
        // A little of the same artist and genre keeps the thread.
        let sameArtist = artistId.map { db.songs(artistId: $0, limit: 60) } ?? db.songs(artistName: seed.artist, limit: 60)
        for track in Self.weightedSample(sameArtist, count: 3, rating: library.rating) {
            result.append(Candidate(track: track, score: w * 0.42, source: "artist"))
        }
        if let genre = seed.genre ?? localSeed?.genre {
            for track in db.randomSongs(genre: genre, limit: 24) {
                result.append(Candidate(track: track, score: w * 0.28, source: "genre"))
            }
        }

        let external = await radio + lastFMSimilar
        let resolved = await resolveRecommendations(Array(external.prefix(24)), allowExternal: allowExternal)
        for (rank, track) in resolved.enumerated() {
            result.append(Candidate(track: track, score: w * 0.8 * (1 - Double(rank) * 0.012), source: "recommendation"))
        }
        return result
    }

    private func candidates(forArtist name: String, id: String?, allowExternal: Bool) async -> [Candidate] {
        guard let client = library.client, let db = library.db else { return [] }
        var result: [Candidate] = []
        async let top: [Track] = (try? await client.topSongs(artist: name, count: 20)) ?? []
        async let similar: [Artist] = {
            guard let id, !OctoID.isExternal(id) else { return [] }
            return (try? await client.artistInfo(id: id, count: 12))?.similar ?? []
        }()
        async let radio = listenBrainzRadio(artist: name)
        for (rank, track) in await top.enumerated() {
            result.append(Candidate(track: track, score: 0.9 - Double(rank) * 0.02, source: "top"))
        }
        for (rank, artist) in await similar.enumerated() {
            let songs = artist.isExternal ? db.songs(artistName: artist.name, limit: 40) : db.songs(artistId: artist.id, limit: 40)
            for track in Self.weightedSample(songs, count: 4, rating: library.rating) {
                result.append(Candidate(track: track, score: 0.75 * (1 - Double(rank) * 0.03), source: "similar-artist"))
            }
        }
        for (rank, track) in await resolveRecommendations(Array(await radio.prefix(20)), allowExternal: allowExternal).enumerated() {
            result.append(Candidate(track: track, score: 0.7 - Double(rank) * 0.01, source: "radio"))
        }
        return result
    }

    private func listenBrainzRadio(artist: String) async -> [RecommendedTrack] {
        let token = settings.listenBrainzToken
        guard !token.isEmpty, settings.discovery != .familiar else { return [] }
        let tracks = (try? await listenBrainz.radio(prompt: "artist:(\(artist))", mode: "easy", token: token)) ?? []
        // LB radio leads with the seed artist; the similar artists are the interesting part.
        let seedKey = TextKey.primaryArtist(artist)
        return tracks.filter { TextKey.primaryArtist($0.artist) != seedKey }.shuffled()
    }

    private func lastFMSimilarTracks(_ seed: Track) async -> [RecommendedTrack] {
        guard settings.hasLastFM else { return [] }
        return (try? await lastFM.similarTracks(artist: TextKey.primaryCredit(seed.artist), track: seed.title, limit: 30, key: settings.lastFMKey)) ?? []
    }

    private func resolveRecommendations(_ recs: [RecommendedTrack], allowExternal: Bool) async -> [Track] {
        var tracks: [Track] = []
        // Library matches are instant; octo-fiesta lookups are capped to keep autoplay snappy.
        var externalLookups = 0
        for rec in recs {
            if let local = resolver.local(title: rec.title, artist: rec.artist) {
                tracks.append(local)
            } else if allowExternal, externalLookups < 6 {
                externalLookups += 1
                if let track = await resolver.resolve(title: rec.title, artist: rec.artist, allowExternal: true) {
                    tracks.append(track)
                }
            }
        }
        return tracks
    }

    /// A few songs from a list, favouring rated and played ones without always taking the top.
    nonisolated static func weightedSample(_ songs: [Track], count: Int, rating: (Track) -> Int) -> [Track] {
        var pool = songs.filter { rating($0) != 1 }
        var picked: [Track] = []
        while picked.count < count, !pool.isEmpty {
            let weights = pool.map { t -> Double in
                1 + Double(max(rating(t) - 2, 0)) * 0.8 + (t.starred ? 1 : 0) + min(Double(t.playCount), 20) * 0.05
            }
            let total = weights.reduce(0, +)
            var roll = Double.random(in: 0..<total)
            var index = 0
            for (i, weight) in weights.enumerated() {
                roll -= weight
                if roll <= 0 { index = i; break }
            }
            picked.append(pool.remove(at: index))
        }
        return picked
    }
}
