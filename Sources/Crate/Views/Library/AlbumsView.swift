import SwiftUI

struct AlbumsView: View {
    @Environment(AppModel.self) private var app
    @State private var filter = ""
    @State private var sort: AlbumSort = .recentlyAdded
    @State private var albums: [Album] = []
    @State private var total = 0
    @State private var exhausted = false
    private let pageSize = 240

    var body: some View {
        VStack(spacing: 0) {
            PageToolbar {
                CrateTextField(placeholder: "Filter albums", text: $filter, icon: "magnifyingglass", height: 32)
                    .frame(maxWidth: 280)
                SortChip(label: "Sorted by", options: AlbumSort.allCases.map { ($0, $0.label) }, selection: $sort)
                Spacer()
                Text(Format.count(total, "album")).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
            }
            Hairline()
            if albums.isEmpty, app.library.songCount == 0 {
                LoadingGrid()
            } else if albums.isEmpty {
                EmptyState(symbol: "square.stack", title: "No albums match", message: "Try a different filter.")
                Spacer()
            } else {
                ScrollView {
                    AdaptiveGrid(items: albums, minItemWidth: 164, onReachEnd: loadMore) { album, width in
                        AlbumCard(album: album, size: width)
                    }
                    .padding(Metrics.contentGutter)
                }
            }
        }
        .onAppear(perform: reload)
        .onChange(of: filter) { reload() }
        .onChange(of: sort) { reload() }
        .onChange(of: app.library.revision) { reload() }
    }

    private func reload() {
        guard let db = app.library.db else { return }
        albums = db.albums(sort: sort, filter: filter, limit: pageSize, offset: 0)
        total = db.albumCount(filter: filter)
        exhausted = albums.count < pageSize
    }

    private func loadMore() {
        guard !exhausted, let db = app.library.db else { return }
        let next = db.albums(sort: sort, filter: filter, limit: pageSize, offset: albums.count)
        exhausted = next.count < pageSize
        let known = Set(albums.map(\.id))
        albums += next.filter { !known.contains($0.id) }
    }
}

struct LoadingGrid: View {
    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 164), spacing: 20)], spacing: 24) {
                ForEach(0..<18, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 8) {
                        Skeleton(height: 164, radius: Radius.card).aspectRatio(1, contentMode: .fit)
                        Skeleton(width: 120, height: 11)
                        Skeleton(width: 80, height: 9)
                    }
                }
            }
            .padding(Metrics.contentGutter)
        }
        .disabled(true)
    }
}

struct AlbumDetailView: View {
    @Environment(AppModel.self) private var app
    let albumId: String
    @State private var album: Album?
    @State private var tracks: [Track] = []
    @State private var error: String?
    @State private var selection: Set<Int> = []
    @State private var moreByArtist: [Album] = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let album {
                    hero(album)
                    if album.isExternal {
                        Callout(kind: .info, message: externalMessage(album), symbol: "arrow.down.forward.circle")
                            .padding(.horizontal, Metrics.contentGutter)
                            .padding(.bottom, 16)
                    }
                    if tracks.isEmpty, error == nil {
                        LoadingRows(count: min(max(album.songCount, 4), 12), artwork: false)
                            .padding(.horizontal, Metrics.contentGutter - 12)
                    } else {
                        TrackRows(tracks: tracks, options: TrackListOptions(artwork: album.isExternalPlaylist, album: album.isExternalPlaylist, trackNumbers: !album.isExternalPlaylist),
                                  context: "album:\(album.id)", selection: $selection)
                            .padding(.horizontal, Metrics.contentGutter - 12)
                    }
                    if !moreByArtist.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            SectionTitle(title: "More by \(album.artist)")
                            Carousel(items: moreByArtist) { AlbumCard(album: $0, size: 148) }
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                        .padding(.top, 36)
                    }
                } else if error == nil {
                    HStack(alignment: .bottom, spacing: 24) {
                        Skeleton(width: 200, height: 200, radius: Radius.card)
                        VStack(alignment: .leading, spacing: 10) {
                            Skeleton(width: 60, height: 10)
                            Skeleton(width: 280, height: 26)
                            Skeleton(width: 180, height: 12)
                        }
                    }
                    .padding(Metrics.contentGutter)
                    LoadingRows(count: 10, artwork: false).padding(.horizontal, Metrics.contentGutter - 12)
                }
                if let error {
                    EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't load this album", message: error,
                               action: ("Try again", { Task { await load() } }))
                }
                Color.clear.frame(height: 32)
            }
        }
        .pageTitle(album?.name)
        .task { await load() }
    }

    @ViewBuilder
    private func hero(_ album: Album) -> some View {
        let duration = tracks.isEmpty ? album.duration : tracks.reduce(0) { $0 + $1.duration }
        let count = tracks.isEmpty ? album.songCount : tracks.count
        DetailHero(
            kind: album.isExternalPlaylist ? "Playlist" : "Album",
            title: album.name,
            subtitle: AnyView(
                Button {
                    if let artistId = album.artistId { app.nav.go(.artist(artistId)) }
                } label: {
                    Text(album.artist).textStyle(.bodyStrong).foregroundStyle(Tok.fgSecondary)
                }
                .buttonStyle(.plain)
            ),
            meta: [album.year.flatMap { $0 > 0 ? String($0) : nil }, album.genre, Format.count(count, "song"), Format.longDuration(duration)]
                .compactMap { $0 }.joined(separator: " · "),
            pills: album.isExternal ? AnyView(ExternalPill(provider: OctoID.providerName(album.id))) : nil,
            cover: { Artwork(coverArt: album.coverArt, size: 200, radius: Radius.card) },
            actions: {
                Button {
                    app.player.play(tracks, shuffled: false, context: "album:\(album.id)")
                } label: { Label("Play", systemImage: "play.fill") }
                    .buttonStyle(.crate(.primary))
                    .disabled(tracks.isEmpty)
                Button {
                    app.player.play(tracks, shuffled: true, context: "album:\(album.id)")
                } label: { Label("Shuffle", systemImage: "shuffle") }
                    .buttonStyle(.crate(.secondary))
                    .disabled(tracks.isEmpty)
                let starred = app.library.isStarred(album: album)
                IconActionButton(symbol: album.isExternal ? (starred ? "checkmark.circle.fill" : "plus.circle") : (starred ? "heart.fill" : "heart"),
                                 help: album.isExternal ? "Add the whole album to your library" : (starred ? "Remove from favourites" : "Add to favourites"),
                                 active: starred, activeTint: album.isExternal ? Tok.accent : Tok.heart) {
                    app.library.toggleStar(album: album)
                }
                let offline = app.downloads.isOffline(.album, album.id)
                IconActionButton(symbol: offline ? "arrow.down.circle.fill" : "arrow.down.circle", help: offline ? "Remove download" : "Download for offline", active: offline) {
                    app.downloads.toggleOffline(.album, id: album.id, name: album.name, tracks: tracks)
                }
                .disabled(tracks.isEmpty)
                Menu {
                    AlbumMenuItems(album: album)
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold)).foregroundStyle(Tok.iconStrong).frame(width: 20)
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.crate(.secondary))
                .fixedSize()
            }
        )
    }

    private func externalMessage(_ album: Album) -> String {
        let provider = OctoID.providerName(album.id) ?? "the provider"
        if album.isExternalPlaylist {
            return "A \(provider) playlist found through octo-fiesta. Songs are fetched as they play; adding it downloads all of them into your library."
        }
        return "This album isn't in your library. octo-fiesta fetches each song from \(provider) when it plays, or adds the whole album when you press +."
    }

    private func load() async {
        error = nil
        if let cached = app.library.cachedAlbum(albumId) {
            album = cached.0
            tracks = cached.1
        } else if album == nil, let db = app.library.db, let stored = db.album(id: albumId) {
            album = stored
        }
        loadMore()
        guard !app.isOffline else {
            if album == nil { error = "You're offline and this album isn't cached." }
            return
        }
        do {
            let (fresh, songs) = try await app.library.fetchAlbum(albumId)
            album = fresh
            tracks = songs
            loadMore()
        } catch {
            if tracks.isEmpty { self.error = error.localizedDescription }
        }
    }

    private func loadMore() {
        guard let album, let artistId = album.artistId, let db = app.library.db else { return }
        moreByArtist = db.albums(artistId: artistId).filter { $0.id != album.id }
    }
}
