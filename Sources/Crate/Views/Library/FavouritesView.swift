import SwiftUI

struct FavouritesView: View {
    @Environment(AppModel.self) private var app
    @State private var tab = "songs"
    @State private var songs: [Track] = []
    @State private var pending: [Track] = []
    @State private var albums: [Album] = []
    @State private var selection: Set<Int> = []

    var body: some View {
        let all = songs + pending
        let offline = app.downloads.isOffline(.favourites, "favourites")
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                DetailHero(
                    kind: "Collection",
                    title: "Favourites",
                    meta: [Format.count(all.count, "song"), Format.longDuration(all.reduce(0) { $0 + $1.duration }),
                           albums.isEmpty ? nil : Format.count(albums.count, "album")].compactMap { $0 }.joined(separator: " · "),
                    cover: { GeneratedCover(title: "Favourites", symbol: "heart.fill", hue: .pink, size: 184, showTitle: false) },
                    actions: {
                        Button {
                            app.player.play(all.filter(app.isPlayable), shuffled: false, context: "favourites")
                        } label: { Label("Play", systemImage: "play.fill") }
                            .buttonStyle(.crate(.primary))
                            .disabled(all.isEmpty)
                        Button {
                            app.player.play(all.filter(app.isPlayable), shuffled: true, context: "favourites")
                        } label: { Label("Shuffle", systemImage: "shuffle") }
                            .buttonStyle(.crate(.secondary))
                            .disabled(all.isEmpty)
                        Button {
                            app.downloads.toggleOffline(.favourites, id: "favourites", name: "Favourites", tracks: all)
                        } label: {
                            Label(offline ? "Downloaded" : "Download", systemImage: offline ? "arrow.down.circle.fill" : "arrow.down.circle")
                        }
                        .buttonStyle(.crate(.secondary))
                        .foregroundStyle(offline ? Tok.accent : Tok.fg)
                        .help(offline ? "Favourites stay downloaded and in sync. Click to remove." : "Keep every favourite downloaded for offline listening")
                    }
                )
                Segmented(options: [("songs", "Songs"), ("albums", "Albums")], selection: $tab)
                    .padding(.horizontal, Metrics.contentGutter)
                    .padding(.bottom, 16)
                if tab == "songs" {
                    if all.isEmpty {
                        EmptyState(symbol: "heart", title: "No favourites yet", message: "Click the heart on any song to keep it here. Favourites can be downloaded for offline listening in one click.")
                    } else {
                        if !pending.isEmpty {
                            Callout(kind: .info, message: "\(Format.count(pending.count, "favourite")) from octo-fiesta \(pending.count == 1 ? "is" : "are") being added to your library and will be favourited there once Navidrome has scanned \(pending.count == 1 ? "it" : "them").", symbol: "arrow.down.forward.circle")
                                .padding(.horizontal, Metrics.contentGutter)
                                .padding(.bottom, 12)
                        }
                        TrackRows(tracks: all, context: "favourites", selection: $selection)
                            .padding(.horizontal, Metrics.contentGutter - 12)
                    }
                } else {
                    if albums.isEmpty {
                        EmptyState(symbol: "square.stack", title: "No favourite albums", message: "Use the heart on an album page to add it here.")
                    } else {
                        AdaptiveGrid(items: albums, minItemWidth: 156) { album, width in
                            AlbumCard(album: album, size: width)
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                    }
                }
                Color.clear.frame(height: 32)
            }
        }
        .onAppear(perform: reload)
        .onChange(of: app.library.revision) { reload() }
        .onChange(of: app.library.starOverrides) { reload() }
    }

    private func reload() {
        guard let db = app.library.db else { return }
        let overrides = app.library.starOverrides
        songs = db.starredSongs().filter { overrides[$0.id] != false }
        let extra = overrides.filter { $0.value && !OctoID.isExternal($0.key) }.map(\.key).filter { id in !songs.contains { $0.id == id } }
        songs += db.songs(ids: extra)
        pending = app.library.pendingFavourites().filter { overrides[$0.id] != false }
        albums = db.starredAlbums().filter { overrides[$0.id] != false }
    }
}

struct DownloadsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let downloads = app.downloads
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Downloads").textStyle(.display).foregroundStyle(Tok.fg)
                        Text("Downloaded songs play without a connection. Playlists and favourites you download stay in sync: new songs download automatically.")
                            .textStyle(.small)
                            .foregroundStyle(Tok.fgMuted)
                            .frame(maxWidth: 560, alignment: .leading)
                    }
                    Spacer()
                    if downloads.isRefreshing {
                        ProgressView().controlSize(.small)
                    }
                    Button {
                        Task { await downloads.refreshAll() }
                    } label: { Label("Sync now", systemImage: "arrow.clockwise") }
                        .buttonStyle(.crate(.secondary, size: .sm))
                        .disabled(downloads.sets.isEmpty || app.isOffline)
                }

                HStack(spacing: 12) {
                    StatTile(label: "Songs", value: downloads.downloaded.count.formatted())
                    StatTile(label: "Space used", value: Format.bytes(downloads.totalBytes))
                    StatTile(label: "In progress", value: (downloads.progress.count + downloads.queue.count).formatted())
                }

                VStack(alignment: .leading, spacing: 10) {
                    SectionTitle(title: "Collections", count: downloads.sets.count)
                    if downloads.sets.isEmpty {
                        EmptyState(symbol: "arrow.down.circle", title: "Nothing downloaded yet",
                                   message: "Use the download button on a playlist, album, mix or your favourites.")
                    } else {
                        VStack(spacing: 0) {
                            ForEach(downloads.sets) { set in
                                OfflineSetRow(set: set)
                                if set.id != downloads.sets.last?.id { Hairline() }
                            }
                        }
                        .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .hairline(Radius.card)
                    }
                }

                if !downloads.sets.isEmpty {
                    Button("Remove all downloads", role: .destructive) { app.confirmRemoveDownloads = true }
                        .buttonStyle(.crate(.secondary, size: .sm))
                        .foregroundStyle(Tok.dangerText)
                }
            }
            .padding(Metrics.contentGutter)
        }
    }
}

struct StatTile: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).textStyle(.caption).foregroundStyle(Tok.fgMuted)
            Text(value).textStyle(.titleLarge, tabular: true).foregroundStyle(Tok.fg)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.surfaceMuted, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .hairline(Radius.card)
    }
}

private struct OfflineSetRow: View {
    @Environment(AppModel.self) private var app
    let set: OfflineSet

    var body: some View {
        let progress = app.downloads.progress(of: set)
        HStack(spacing: 14) {
            cover
            VStack(alignment: .leading, spacing: 4) {
                Text(set.name).textStyle(.bodyStrong).foregroundStyle(Tok.fg)
                HStack(spacing: 8) {
                    Text(kindLabel).textStyle(.small).foregroundStyle(Tok.fgMuted)
                    Text("·").foregroundStyle(Tok.fgPlaceholder)
                    Text(progress.done == progress.total ? "\(progress.total) songs downloaded" : "\(progress.done) of \(progress.total) downloaded")
                        .textStyle(.small, tabular: true)
                        .foregroundStyle(progress.done == progress.total ? Tok.successText : Tok.fgMuted)
                }
                if progress.done < progress.total {
                    ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                        .progressViewStyle(.linear)
                        .tint(Tok.accent)
                        .frame(maxWidth: 320)
                }
            }
            Spacer()
            Button("Open") { open() }
                .buttonStyle(.crate(.ghost, size: .xs))
            Button("Remove") { app.downloads.removeOffline(set.kind, id: set.setId) }
                .buttonStyle(.crate(.secondary, size: .xs))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var cover: some View {
        switch set.kind {
        case .playlist:
            Artwork(coverArt: app.library.playlist(id: set.setId)?.coverArt, size: 44, radius: 8, placeholderSymbol: "music.note.list")
        case .favourites:
            GeneratedCover(title: "", symbol: "heart.fill", hue: .pink, size: 44, radius: 8, showTitle: false)
        case .album:
            if set.setId == "songs" {
                GeneratedCover(title: "", symbol: "music.note", hue: .blue, size: 44, radius: 8, showTitle: false)
            } else {
                Artwork(coverArt: app.library.db?.album(id: set.setId)?.coverArt, size: 44, radius: 8)
            }
        case .mix:
            if let mix = app.mixes.mix(id: set.setId) {
                MixCover(mix: mix, size: 44)
            } else {
                GeneratedCover(title: "", symbol: "sparkles", hue: .purple, size: 44, radius: 8, showTitle: false)
            }
        }
    }

    private var kindLabel: String {
        switch set.kind {
        case .playlist: "Playlist"
        case .favourites: "Favourites"
        case .album: set.setId == "songs" ? "Individual songs" : "Album"
        case .mix: "Mix"
        }
    }

    private func open() {
        switch set.kind {
        case .playlist: app.nav.go(.playlist(set.setId))
        case .favourites: app.nav.go(.favourites)
        case .album: if set.setId != "songs" { app.nav.go(.album(set.setId)) }
        case .mix: app.nav.go(.mix(set.setId))
        }
    }
}
