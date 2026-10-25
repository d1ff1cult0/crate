import Foundation

/// octo-fiesta identifiers. External items look like `ext-{provider}-{type}-{id}` (legacy:
/// `ext-{provider}-{id}` for songs) and provider playlists like `pl-{provider}-{id}`; they
/// are served as albums because Subsonic search has no playlist section.
enum OctoID {
    static let providers = ["deezer", "qobuz", "tidal", "squidwtf", "yandex"]

    static func isExternal(_ id: String) -> Bool {
        id.hasPrefix("ext-")
    }

    static func isExternalPlaylist(_ id: String) -> Bool {
        guard id.hasPrefix("pl-") else { return false }
        let rest = id.dropFirst(3).lowercased()
        return providers.contains { rest.hasPrefix($0 + "-") }
    }

    /// The provider slug ("deezer") of an external song, album, artist or playlist id.
    static func provider(_ id: String) -> String? {
        if isExternal(id) {
            let parts = id.split(separator: "-", maxSplits: 2)
            return parts.count >= 2 ? String(parts[1]) : nil
        }
        if isExternalPlaylist(id) {
            let parts = id.split(separator: "-", maxSplits: 2)
            return parts.count >= 2 ? String(parts[1]) : nil
        }
        return nil
    }

    static func providerName(_ id: String) -> String? {
        guard let slug = provider(id) else { return nil }
        switch slug.lowercased() {
        case "deezer": return "Deezer"
        case "qobuz": return "Qobuz"
        case "tidal": return "Tidal"
        case "squidwtf": return "SquidWTF"
        case "yandex": return "Yandex Music"
        default: return slug.capitalized
        }
    }

    /// The item type encoded in an external id ("song", "album", "artist").
    static func type(_ id: String) -> String? {
        guard isExternal(id) else { return nil }
        let parts = id.split(separator: "-")
        if parts.count >= 4, ["song", "album", "artist"].contains(String(parts[2])) {
            return String(parts[2])
        }
        return parts.count >= 3 ? "song" : nil
    }
}
