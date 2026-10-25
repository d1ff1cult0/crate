import Foundation

/// Turns "a song by an artist" from ListenBrainz or Last.fm into something playable: the
/// library copy when there is one, otherwise the octo-fiesta result for it.
@MainActor
final class TrackResolver {
    private let library: LibraryStore
    private var cache: [String: Track?] = [:]

    init(library: LibraryStore) {
        self.library = library
    }

    func local(title: String, artist: String) -> Track? {
        library.db?.match(title: title, artist: artist)
    }

    func resolve(title: String, artist: String, allowExternal: Bool) async -> Track? {
        let key = TextKey.songKey(title: title, artist: artist) + (allowExternal ? "|x" : "")
        if let cached = cache[key] { return cached }
        if let local = local(title: title, artist: artist) {
            cache[key] = local
            return local
        }
        guard allowExternal, let client = library.client else { return nil }
        guard let results = try? await client.search("\(TextKey.primaryCredit(artist)) \(title)", songs: 10, albums: 0, artists: 0) else {
            return nil
        }
        let wanted = TextKey.title(title)
        let candidates = results.songs.filter { TextKey.artistsOverlap($0.artist, artist) }
        let exact = candidates.filter { TextKey.title($0.title) == wanted }
        let loose = candidates.filter {
            let t = TextKey.title($0.title)
            return t.hasPrefix(wanted) || wanted.hasPrefix(t)
        }
        // Prefer a library copy the server's search found, then the provider's.
        let pick = exact.first { !$0.isExternal } ?? exact.first ?? loose.first { !$0.isExternal } ?? loose.first
        cache[key] = pick
        return pick
    }

    func clear() {
        cache.removeAll()
    }
}
