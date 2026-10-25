import AppKit
import Foundation
import Observation

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

enum StreamQuality: Int, CaseIterable, Identifiable {
    case original = 0, kbps320 = 320, kbps256 = 256, kbps192 = 192, kbps128 = 128
    var id: Int { rawValue }
    var label: String { self == .original ? "Original" : "\(rawValue) kbps" }
}

enum DiscoveryLevel: Int, CaseIterable, Identifiable {
    case familiar = 0, balanced = 1, adventurous = 2
    var id: Int { rawValue }
    var label: String {
        switch self {
        case .familiar: "Familiar"
        case .balanced: "Balanced"
        case .adventurous: "Adventurous"
        }
    }

    var detail: String {
        switch self {
        case .familiar: "Mostly songs you've played and rated highly."
        case .balanced: "Favourites mixed with songs you haven't heard yet."
        case .adventurous: "Leans towards new songs, including ones outside your library."
        }
    }
}

/// User preferences backed by UserDefaults; secrets go to the keychain.
@MainActor
@Observable
final class SettingsStore {
    private let defaults = UserDefaults.standard

    var appearance: AppearanceMode { didSet { defaults.set(appearance.rawValue, forKey: "appearance"); applyAppearance() } }
    var streamQuality: StreamQuality { didSet { defaults.set(streamQuality.rawValue, forKey: "streamQuality") } }
    var downloadQuality: StreamQuality { didSet { defaults.set(downloadQuality.rawValue, forKey: "downloadQuality") } }
    var autoplay: Bool { didSet { defaults.set(autoplay, forKey: "autoplay") } }
    var discovery: DiscoveryLevel { didSet { defaults.set(discovery.rawValue, forKey: "discovery") } }
    var autoplayExternal: Bool { didSet { defaults.set(autoplayExternal, forKey: "autoplayExternal") } }
    var prefetchExternal: Bool { didSet { defaults.set(prefetchExternal, forKey: "prefetchExternal") } }
    var scrobble: Bool { didSet { defaults.set(scrobble, forKey: "scrobble") } }
    var listenBrainzUser: String { didSet { defaults.set(listenBrainzUser, forKey: "listenBrainzUser") } }
    var listenBrainzScrobble: Bool { didSet { defaults.set(listenBrainzScrobble, forKey: "listenBrainzScrobble") } }
    var lastFMUser: String { didSet { defaults.set(lastFMUser, forKey: "lastFMUser") } }
    var showExternalInSearch: Bool { didSet { defaults.set(showExternalInSearch, forKey: "showExternalInSearch") } }
    var compactRows: Bool { didSet { defaults.set(compactRows, forKey: "compactRows") } }
    var cacheAllArtwork: Bool { didSet { defaults.set(cacheAllArtwork, forKey: "cacheAllArtwork") } }
    var volume: Double { didSet { defaults.set(volume, forKey: "volume") } }
    var sidebarWidth: Double { didSet { defaults.set(sidebarWidth, forKey: "sidebarWidth") } }
    var queueWidth: Double { didSet { defaults.set(queueWidth, forKey: "queueWidth") } }

    static let sidebarRange: ClosedRange<Double> = 200...380
    static let queueRange: ClosedRange<Double> = 300...600
    static let defaultSidebarWidth: Double = 248
    static let defaultQueueWidth: Double = 360

    var listenBrainzToken: String {
        didSet { Keychain.set(listenBrainzToken, for: "listenbrainz-token") }
    }

    var lastFMKey: String {
        didSet { Keychain.set(lastFMKey, for: "lastfm-api-key") }
    }

    init() {
        defaults.register(defaults: [
            "autoplay": true, "discovery": DiscoveryLevel.balanced.rawValue, "autoplayExternal": false,
            "prefetchExternal": true, "scrobble": true, "showExternalInSearch": true, "volume": 0.8,
            "streamQuality": 0, "downloadQuality": 0, "sidebarWidth": 248.0, "queueWidth": 360.0, "cacheAllArtwork": true,
        ])
        appearance = AppearanceMode(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        streamQuality = StreamQuality(rawValue: defaults.integer(forKey: "streamQuality")) ?? .original
        downloadQuality = StreamQuality(rawValue: defaults.integer(forKey: "downloadQuality")) ?? .original
        autoplay = defaults.bool(forKey: "autoplay")
        discovery = DiscoveryLevel(rawValue: defaults.integer(forKey: "discovery")) ?? .balanced
        autoplayExternal = defaults.bool(forKey: "autoplayExternal")
        prefetchExternal = defaults.bool(forKey: "prefetchExternal")
        scrobble = defaults.bool(forKey: "scrobble")
        listenBrainzUser = defaults.string(forKey: "listenBrainzUser") ?? ""
        listenBrainzScrobble = defaults.bool(forKey: "listenBrainzScrobble")
        lastFMUser = defaults.string(forKey: "lastFMUser") ?? ""
        showExternalInSearch = defaults.bool(forKey: "showExternalInSearch")
        compactRows = defaults.bool(forKey: "compactRows")
        cacheAllArtwork = defaults.bool(forKey: "cacheAllArtwork")
        volume = defaults.double(forKey: "volume")
        sidebarWidth = min(max(defaults.double(forKey: "sidebarWidth"), Self.sidebarRange.lowerBound), Self.sidebarRange.upperBound)
        queueWidth = min(max(defaults.double(forKey: "queueWidth"), Self.queueRange.lowerBound), Self.queueRange.upperBound)
        listenBrainzToken = Keychain.get("listenbrainz-token") ?? ""
        lastFMKey = Keychain.get("lastfm-api-key") ?? ""
    }

    func applyAppearance() {
        switch appearance {
        case .system: NSApp?.appearance = nil
        case .light: NSApp?.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp?.appearance = NSAppearance(named: .darkAqua)
        }
    }

    var hasListenBrainz: Bool { !listenBrainzUser.trimmingCharacters(in: .whitespaces).isEmpty }
    var hasLastFM: Bool { !lastFMUser.trimmingCharacters(in: .whitespaces).isEmpty && !lastFMKey.isEmpty }

    // Saved account (password is in the keychain).
    var savedAccount: ServerAccount? {
        get {
            guard let data = defaults.data(forKey: "account") else { return nil }
            return try? JSONDecoder().decode(ServerAccount.self, from: data)
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                defaults.set(data, forKey: "account")
            } else {
                defaults.removeObject(forKey: "account")
            }
        }
    }
}
