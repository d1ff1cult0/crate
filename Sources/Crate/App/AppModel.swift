import Foundation
import Network
import Observation
import SwiftUI

enum Route: Hashable {
    case home, discover, albums, artists, songs, genres, playlists, favourites, downloads, settings
    case search(String)
    case album(String)
    case artist(String)
    case playlist(String)
    case genre(String)
    case mix(String)

    var isRoot: Bool {
        switch self {
        case .home, .discover, .albums, .artists, .songs, .genres, .playlists, .favourites, .downloads, .settings: true
        default: false
        }
    }

    var title: String {
        switch self {
        case .home: "Home"
        case .discover: "Discover"
        case .albums: "Albums"
        case .artists: "Artists"
        case .songs: "Songs"
        case .genres: "Genres"
        case .playlists: "Playlists"
        case .favourites: "Favourites"
        case .downloads: "Downloads"
        case .settings: "Settings"
        case .search: "Search"
        case .album: "Album"
        case .artist: "Artist"
        case .playlist: "Playlist"
        case .genre: "Genre"
        case .mix: "Mix"
        }
    }

    var activeSymbol: String {
        switch self {
        case .home: "house.fill"
        case .favourites: "heart.fill"
        case .downloads: "arrow.down.circle.fill"
        default: symbol
        }
    }

    var symbol: String {
        switch self {
        case .home: "house"
        case .discover: "sparkles"
        case .albums: "square.stack"
        case .artists: "music.mic"
        case .songs: "music.note"
        case .genres: "tag"
        case .playlists: "music.note.list"
        case .favourites: "heart"
        case .downloads: "arrow.down.circle"
        case .settings: "gearshape"
        case .search: "magnifyingglass"
        case .album: "square.stack"
        case .artist: "music.mic"
        case .playlist: "music.note.list"
        case .genre: "tag"
        case .mix: "sparkles"
        }
    }
}

@MainActor
@Observable
final class Navigator {
    private(set) var root: Route = .home
    private(set) var stack: [Route] = []
    private(set) var forwardStack: [Route] = []
    private var rootHistory: [Route] = []

    var current: Route { stack.last ?? root }
    var canGoBack: Bool { !stack.isEmpty || !rootHistory.isEmpty }
    var canGoForward: Bool { !forwardStack.isEmpty }

    func go(_ route: Route) {
        if route == current { return }
        if route.isRoot {
            rootHistory.append(root)
            if rootHistory.count > 30 { rootHistory.removeFirst() }
            root = route
            stack = []
        } else {
            stack.append(route)
        }
        forwardStack = []
    }

    func back() {
        if let last = stack.popLast() {
            forwardStack.append(last)
        } else if let previous = rootHistory.popLast() {
            forwardStack.append(root)
            root = previous
        }
    }

    func forward() {
        guard let next = forwardStack.popLast() else { return }
        if next.isRoot {
            rootHistory.append(root)
            root = next
            stack = []
        } else {
            stack.append(next)
        }
    }

    func reset() {
        root = .home
        stack = []
        forwardStack = []
        rootHistory = []
    }
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    let message: String
}

@MainActor
@Observable
final class ToastCenter {
    private(set) var toasts: [Toast] = []

    func show(_ message: String) {
        // Don't stack the same message twice.
        if toasts.contains(where: { $0.message == message }) { return }
        let toast = Toast(message: message)
        withAnimation(Motion.base) {
            toasts.append(toast)
            if toasts.count > 3 { toasts.removeFirst() }
        }
        Task {
            try? await Task.sleep(for: .seconds(max(3.5, Double(message.count) / 18)))
            dismiss(toast.id)
        }
    }

    func dismiss(_ id: UUID) {
        withAnimation(Motion.base) { toasts.removeAll { $0.id == id } }
    }
}

/// Root state: the session, the stores and connectivity.
@MainActor
@Observable
final class AppModel {
    enum Phase { case launching, loggedOut, ready }
    enum Connectivity { case online, offline, checking }

    var phase: Phase = .launching
    var connectivity: Connectivity = .checking
    var showQueue = false
    var showPalette = false
    var showLyrics = false
    var paletteQuery = ""
    var playlistPrompt: PlaylistPrompt?
    var confirmDelete: Playlist?
    var confirmRemoveDownloads = false
    private(set) var account: ServerAccount?

    let settings = SettingsStore()
    let library = LibraryStore()
    let player = PlayerController()
    let downloads = DownloadManager()
    let fetcher = RemoteFetcher()
    let nav = Navigator()
    let toasts = ToastCenter()
    let artwork = ArtworkPrefetcher()
    @ObservationIgnored let lyrics: LyricsStore
    @ObservationIgnored let resolver: TrackResolver
    @ObservationIgnored let autoplay: AutoplayEngine
    let mixes: MixStore

    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var periodicTask: Task<Void, Never>?

    var isOffline: Bool { connectivity == .offline }

    init() {
        resolver = TrackResolver(library: library)
        lyrics = LyricsStore(library: library)
        autoplay = AutoplayEngine(library: library, settings: settings, resolver: resolver)
        mixes = MixStore(library: library, settings: settings, resolver: resolver)
        downloads.configure(library: library, settings: settings)
        player.configure(library: library, downloads: downloads, fetcher: fetcher, settings: settings, autoplay: autoplay)

        let toasts = self.toasts
        library.onNotice = { toasts.show($0) }
        downloads.onNotice = { toasts.show($0) }
        player.onNotice = { toasts.show($0) }
        library.onConnectivityError = { [weak self] in self?.markOffline() }
        library.onSyncFinished = { [weak self] in self?.prefetchArtwork() }
        player.isOffline = { [weak self] in self?.connectivity == .offline }

        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self, self.phase == .ready else { return }
                if path.status == .satisfied {
                    await self.checkConnectivity()
                } else {
                    self.connectivity = .offline
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "crate.network"))
    }

    // MARK: Session

    func launch() {
        settings.applyAppearance()
        let env = ProcessInfo.processInfo.environment
        if let server = env["CRATE_SERVER"], let user = env["CRATE_USER"], let password = env["CRATE_PASSWORD"],
           let url = Self.normalize(server) {
            activate(SubsonicClient(account: ServerAccount(url: url, username: user), password: password))
            return
        }
        if let saved = settings.savedAccount, let password = Keychain.get("password:\(saved.key)") {
            activate(SubsonicClient(account: saved, password: password))
        } else {
            phase = .loggedOut
        }
    }

    static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        if text.hasSuffix("/rest") { text.removeLast(5) }
        return URL(string: text)
    }

    func login(server: String, username: String, password: String) async throws {
        guard let url = Self.normalize(server) else { throw CrateError.invalidResponse }
        let account = ServerAccount(url: url, username: username.trimmingCharacters(in: .whitespaces))
        let client = SubsonicClient(account: account, password: password)
        try await client.ping()
        settings.savedAccount = account
        Keychain.set(password, for: "password:\(account.key)")
        activate(client)
    }

    private func activate(_ client: SubsonicClient) {
        account = client.account
        library.attach(client: client)
        ImageCache.shared.configure(client: client)
        fetcher.configure(client: client)
        downloads.attach(account: client.account)
        mixes.loadCached()
        player.persistenceURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Crate/Accounts/\(client.account.key)/queue.json")
        player.restore()
        nav.reset()
        phase = .ready
        Task {
            await checkConnectivity()
            if connectivity == .online {
                library.startSync()
                mixes.refreshIfStale()
                await downloads.refreshAll()
            }
        }
        startPeriodicWork()
    }

    func prefetchArtwork() {
        guard settings.cacheAllArtwork, connectivity == .online, let db = library.db else { return }
        let covers = db.allCoverArts()
        artwork.start(coverArts: covers)
    }

    func logout() {
        artwork.cancel()
        player.reset()
        if let account { Keychain.set(nil, for: "password:\(account.key)") }
        settings.savedAccount = nil
        library.detach()
        downloads.detach()
        fetcher.configure(client: nil)
        ImageCache.shared.configure(client: nil)
        mixes.reset()
        account = nil
        periodicTask?.cancel()
        phase = .loggedOut
    }

    // MARK: Connectivity

    func checkConnectivity() async {
        guard let client = library.client else { return }
        let wasOffline = connectivity == .offline
        do {
            try await client.ping()
            connectivity = .online
            retryTask?.cancel()
            if wasOffline {
                toasts.show("Back online.")
                library.startSync()
                Task { await downloads.refreshAll() }
            }
        } catch {
            if error.isConnectivityError {
                markOffline()
            } else if let crate = error as? CrateError, crate.isAuthError {
                connectivity = .online
                toasts.show("The server rejected your credentials. Sign in again in Settings.")
            } else {
                connectivity = .online
            }
        }
    }

    func markOffline() {
        guard connectivity != .offline else { return }
        connectivity = .offline
        retryTask?.cancel()
        retryTask = Task {
            while !Task.isCancelled, connectivity == .offline {
                try? await Task.sleep(for: .seconds(20))
                await checkConnectivity()
            }
        }
    }

    /// Light background upkeep: pick up new scans and replay pending octo-fiesta actions.
    private func startPeriodicWork() {
        periodicTask?.cancel()
        periodicTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10 * 60))
                guard connectivity == .online, phase == .ready else { continue }
                await library.sync()
                mixes.refreshIfStale()
            }
        }
    }

    // MARK: URL scheme

    /// `crate://` links for launchers and scripting, e.g. `crate://playlist/<id>`,
    /// `crate://play/album/<id>`, `crate://control/next`, `crate://go/discover`.
    func handle(_ url: URL) {
        guard url.scheme == "crate", phase == .ready else { return }
        let parts = url.pathComponents.filter { $0 != "/" }.map { $0.removingPercentEncoding ?? $0 }
        let first = parts.first ?? ""
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value ?? ""
        switch url.host ?? "" {
        case "go":
            let routes: [String: Route] = ["home": .home, "discover": .discover, "albums": .albums, "artists": .artists, "songs": .songs,
                                           "genres": .genres, "playlists": .playlists, "favourites": .favourites, "downloads": .downloads, "settings": .settings]
            if let route = routes[first] { nav.go(route) }
        case "album": nav.go(.album(first))
        case "artist": nav.go(.artist(first))
        case "playlist": nav.go(.playlist(first))
        case "genre": nav.go(.genre(first))
        case "mix": nav.go(.mix(first))
        case "search": nav.go(.search(query.isEmpty ? first : query))
        case "palette":
            paletteQuery = query
            showPalette = true
        case "queue": showQueue.toggle()
        case "lyrics": showLyrics.toggle()
        case "pin": library.togglePin(first)
        case "theme": settings.appearance = AppearanceMode(rawValue: first) ?? .system
        case "offline":
            // crate://offline/playlist/<id> and crate://offline/favourites toggle offline copies.
            let id = parts.dropFirst().first ?? ""
            Task {
                switch first {
                case "playlist":
                    if let playlist = library.playlist(id: id) {
                        downloads.toggleOffline(.playlist, id: id, name: playlist.displayName, tracks: await library.songs(of: playlist))
                    }
                case "favourites":
                    let songs = library.db?.starredSongs() ?? []
                    downloads.toggleOffline(.favourites, id: "favourites", name: "Favourites", tracks: songs + library.pendingFavourites())
                default: break
                }
            }
        case "control":
            switch first {
            case "toggle": player.togglePlayPause()
            case "next": player.next()
            case "previous": player.previous()
            case "shuffle": player.toggleShuffle()
            default: break
            }
        case "play":
            let id = parts.dropFirst().first ?? ""
            Task {
                switch first {
                case "album": player.play(await library.songs(ofAlbum: id), context: "album:\(id)")
                case "playlist":
                    if let playlist = library.playlist(id: id) { player.play(await library.songs(of: playlist), context: "playlist:\(id)") }
                case "mix": if let mix = mixes.mix(id: id) { player.play(mix.playable, context: "mix:\(id)") }
                case "song":
                    if let track = library.db?.song(id: id) {
                        player.play([track])
                    } else if let track = try? await library.client?.song(id: id) {
                        player.play([track])
                    }
                case "radio": if let track = library.db?.song(id: id) { player.startRadio(.track(track), name: track.title, leading: [track]) }
                default: break
                }
            }
        default:
            break
        }
    }

    // MARK: Convenience

    func openAlbum(_ id: String?) {
        guard let id else { return }
        nav.go(.album(id))
    }

    func openArtist(_ track: Track) {
        if let artistId = track.artistId {
            nav.go(.artist(artistId))
        } else if let artist = library.db?.artist(named: TextKey.primaryCredit(track.artist)) {
            nav.go(.artist(artist.id))
        }
    }

    func isPlayable(_ track: Track) -> Bool {
        guard isOffline else { return true }
        return downloads.localURL(for: track.id) != nil || (track.isExternal && fetcher.cachedFile(for: track.id) != nil)
    }
}
