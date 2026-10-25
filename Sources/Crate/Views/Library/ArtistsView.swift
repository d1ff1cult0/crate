import SwiftUI

struct ArtistsView: View {
    @Environment(AppModel.self) private var app
    @State private var filter = ""
    @State private var artists: [Artist] = []
    @State private var total = 0
    @State private var exhausted = false
    private let pageSize = 300

    var body: some View {
        VStack(spacing: 0) {
            PageToolbar {
                CrateTextField(placeholder: "Filter artists", text: $filter, icon: "magnifyingglass", height: 32)
                    .frame(maxWidth: 280)
                Spacer()
                Text(Format.count(total, "artist")).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
            }
            Hairline()
            if artists.isEmpty, app.library.songCount == 0 {
                LoadingGrid()
            } else if artists.isEmpty {
                EmptyState(symbol: "music.mic", title: "No artists match", message: "Try a different filter.")
                Spacer()
            } else {
                ScrollView {
                    AdaptiveGrid(items: artists, minItemWidth: 140, onReachEnd: loadMore) { artist, width in
                        ArtistCard(artist: artist, size: width - 8)
                    }
                    .padding(Metrics.contentGutter)
                }
            }
        }
        .onAppear(perform: reload)
        .onChange(of: filter) { reload() }
        .onChange(of: app.library.revision) { reload() }
    }

    private func reload() {
        guard let db = app.library.db else { return }
        artists = db.artists(filter: filter, limit: pageSize, offset: 0)
        total = db.artistCount(filter: filter)
        exhausted = artists.count < pageSize
    }

    private func loadMore() {
        guard !exhausted, let db = app.library.db else { return }
        let next = db.artists(filter: filter, limit: pageSize, offset: artists.count)
        exhausted = next.count < pageSize
        artists += next
    }
}

struct ArtistDetailView: View {
    @Environment(AppModel.self) private var app
    let artistId: String
    @State private var artist: Artist?
    @State private var albums: [Album] = []
    @State private var topSongs: [Track] = []
    @State private var similar: [Artist] = []
    @State private var biography: String?
    @State private var selection: Set<Int> = []
    @State private var showAllTop = false
    @State private var error: String?
    @State private var localSongCount = 0

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let artist {
                    DetailHero(
                        kind: artist.isExternal ? "Artist · \(OctoID.providerName(artist.id) ?? "external")" : "Artist",
                        title: artist.name,
                        meta: [Format.count(max(albums.count, artist.albumCount), "album"),
                               localSongCount > 0 ? Format.count(localSongCount, "song") + " in your library" : nil]
                            .compactMap { $0 }.joined(separator: " · "),
                        cover: { Artwork(coverArt: artist.coverArt, size: 184, circle: true, placeholderName: artist.name) },
                        actions: {
                            Button {
                                app.player.play(topSongs.isEmpty ? allSongs() : topSongs, shuffled: false, context: "artist:\(artist.id)")
                            } label: { Label("Play", systemImage: "play.fill") }
                                .buttonStyle(.crate(.primary))
                            Button {
                                app.player.play(allSongs().isEmpty ? topSongs : allSongs(), shuffled: true, context: "artist:\(artist.id)")
                            } label: { Label("Shuffle", systemImage: "shuffle") }
                                .buttonStyle(.crate(.secondary))
                            Button {
                                app.player.startRadio(.artist(name: artist.name, id: artist.id), name: artist.name)
                            } label: { Label("Radio", systemImage: "dot.radiowaves.left.and.right") }
                                .buttonStyle(.crate(.secondary))
                        }
                    )
                    if !topSongs.isEmpty {
                        SectionTitle(title: "Popular")
                            .padding(.horizontal, Metrics.contentGutter)
                            .padding(.bottom, 6)
                        TrackRows(tracks: showAllTop ? topSongs : Array(topSongs.prefix(5)), options: TrackListOptions(artwork: true, album: true),
                                  context: "artist:\(artist.id)", playAction: { index in
                                      app.player.play(topSongs, startAt: index, context: "artist:\(artist.id)")
                                  }, selection: $selection)
                            .padding(.horizontal, Metrics.contentGutter - 12)
                        if topSongs.count > 5 {
                            Button(showAllTop ? "Show less" : "Show \(topSongs.count - 5) more") {
                                withAnimation(Motion.base) { showAllTop.toggle() }
                            }
                            .buttonStyle(.crate(.ghost, size: .xs))
                            .padding(.horizontal, Metrics.contentGutter - 8)
                            .padding(.top, 6)
                        }
                    }
                    if !albums.isEmpty {
                        SectionTitle(title: "Albums", count: albums.count)
                            .padding(.horizontal, Metrics.contentGutter)
                            .padding(.top, 32)
                            .padding(.bottom, 14)
                        AdaptiveGrid(items: albums, minItemWidth: 156) { album, width in
                            AlbumCard(album: album, size: width)
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                    }
                    if !similar.isEmpty {
                        VStack(alignment: .leading, spacing: 14) {
                            SectionTitle(title: "Similar artists")
                            Carousel(items: similar) { ArtistCard(artist: $0, size: 120) }
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                        .padding(.top, 36)
                    }
                    if let biography, !biography.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionTitle(title: "About")
                            Text(Self.clean(biography))
                                .textStyle(.body)
                                .foregroundStyle(Tok.fgSecondary)
                                .lineSpacing(4)
                                .frame(maxWidth: 720, alignment: .leading)
                                .textSelection(.enabled)
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                        .padding(.top, 36)
                    }
                } else if let error {
                    EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't load this artist", message: error)
                } else {
                    HStack(alignment: .bottom, spacing: 24) {
                        Skeleton(width: 184, height: 184, radius: 92)
                        VStack(alignment: .leading, spacing: 10) {
                            Skeleton(width: 60, height: 10)
                            Skeleton(width: 240, height: 26)
                        }
                    }
                    .padding(Metrics.contentGutter)
                }
                Color.clear.frame(height: 32)
            }
        }
        .pageTitle(artist?.name)
        .task { await load() }
    }

    private func allSongs() -> [Track] {
        guard let artist, let db = app.library.db else { return [] }
        return artist.isExternal ? db.songs(artistName: artist.name) : db.songs(artistId: artist.id, limit: 2000)
    }

    /// Last.fm biographies end with a "Read more on Last.fm" link in HTML.
    static func clean(_ html: String) -> String {
        var text = html
        if let range = text.range(of: "<a ") { text = String(text[..<range.lowerBound]) }
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func load() async {
        if let db = app.library.db, let cached = db.artist(id: artistId) {
            artist = cached
            albums = db.albums(artistId: artistId)
            localSongCount = db.songs(artistId: artistId, limit: 5000).count
        }
        guard let client = app.library.client, !app.isOffline else {
            if artist == nil { error = "You're offline and this artist isn't cached." }
            return
        }
        do {
            let (fresh, freshAlbums) = try await client.artist(id: artistId)
            artist = fresh
            albums = freshAlbums.sorted { ($0.year ?? 0) > ($1.year ?? 0) }
            async let top = client.topSongs(artist: fresh.name, count: 20)
            async let info = OctoID.isExternal(artistId) ? nil : client.artistInfo(id: artistId, count: 12)
            topSongs = (try? await top) ?? []
            if let info = try? await info {
                biography = info.biography
                // Only artists in the library are worth a click here.
                similar = info.similar.filter { !$0.isExternal && $0.albumCount > 0 }
            }
        } catch {
            if artist == nil { self.error = error.localizedDescription }
        }
    }
}

struct SongsView: View {
    @Environment(AppModel.self) private var app
    @State private var filter = ""
    @State private var sort: SongSort = .recentlyAdded
    @State private var songs: [Track] = []
    @State private var total = 0
    @State private var exhausted = false
    @State private var selection: Set<Int> = []
    private let pageSize = 400

    var body: some View {
        VStack(spacing: 0) {
            PageToolbar {
                CrateTextField(placeholder: "Filter songs", text: $filter, icon: "magnifyingglass", height: 32)
                    .frame(maxWidth: 280)
                SortChip(label: "Sorted by", options: SongSort.allCases.map { ($0, $0.label) }, selection: $sort)
                Spacer()
                Text(Format.count(total, "song")).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
                Button {
                    guard let db = app.library.db else { return }
                    app.player.play(db.randomSongs(limit: 300), shuffled: true)
                } label: { Label("Shuffle all", systemImage: "shuffle") }
                    .buttonStyle(.crate(.secondary, size: .sm))
            }
            Hairline()
            if songs.isEmpty, app.library.songCount == 0 {
                LoadingRows(count: 14).padding(.horizontal, Metrics.contentGutter - 12).padding(.top, 12)
                Spacer()
            } else if songs.isEmpty {
                EmptyState(symbol: "music.note", title: "No songs match", message: "Try a different filter.")
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        TrackRows(tracks: songs, playAction: playFrom, onReachEnd: loadMore, selection: $selection)
                    }
                    .padding(.horizontal, Metrics.contentGutter - 12)
                    .padding(.vertical, 8)
                }
            }
        }
        .onAppear(perform: reload)
        .onChange(of: filter) { reload() }
        .onChange(of: sort) { reload() }
        .onChange(of: app.library.revision) { reload() }
    }

    /// Plays from the clicked song through the next 500, so the queue stays manageable.
    private func playFrom(_ index: Int) {
        let slice = Array(songs[index..<min(songs.count, index + 500)])
        app.player.play(slice, startAt: 0)
    }

    private func reload() {
        guard let db = app.library.db else { return }
        songs = db.songs(sort: sort, filter: filter, limit: pageSize, offset: 0)
        total = db.songCount(filter: filter)
        exhausted = songs.count < pageSize
        selection = []
    }

    private func loadMore() {
        guard !exhausted, let db = app.library.db else { return }
        let next = db.songs(sort: sort, filter: filter, limit: pageSize, offset: songs.count)
        exhausted = next.count < pageSize
        songs += next
    }
}
