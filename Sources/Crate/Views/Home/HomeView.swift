import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let library = app.library
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(Format.greeting()), \(app.account?.username ?? "")")
                        .textStyle(.display)
                        .foregroundStyle(Tok.fg)
                    Text(summary).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
                }

                if library.songCount == 0 {
                    FirstSyncCallout()
                }

                if !library.pinnedPlaylists.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionTitle(title: "Pinned playlists", action: ("All playlists", { app.nav.go(.playlists) }))
                        Carousel(items: library.pinnedPlaylists) { PlaylistCard(playlist: $0) }
                    }
                }

                MixesSection()

                if let recent = library.homeLists["recent"], !recent.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionTitle(title: "Jump back in")
                        Carousel(items: recent) { AlbumCard(album: $0) }
                    }
                }
                if let newest = library.homeLists["newest"], !newest.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionTitle(title: "Recently added", action: ("All albums", { app.nav.go(.albums) }))
                        Carousel(items: newest) { AlbumCard(album: $0) }
                    }
                }
                if let frequent = library.homeLists["frequent"], !frequent.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        SectionTitle(title: "Most played")
                        Carousel(items: frequent) { AlbumCard(album: $0) }
                    }
                }
            }
            .padding(Metrics.contentGutter)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.automatic)
    }

    private var summary: String {
        let library = app.library
        var parts: [String] = []
        if library.songCount > 0 {
            parts.append(Format.count(library.songCount, "song"))
            parts.append(Format.count(library.albumCount, "album"))
            parts.append(Format.count(library.artistCount, "artist"))
        }
        if let last = library.lastSync {
            parts.append("synced \(Format.relative(last))")
        }
        return parts.joined(separator: " · ")
    }
}

private struct FirstSyncCallout: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 14) {
            ProgressView().controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text("Indexing your library").textStyle(.bodyStrong).foregroundStyle(Tok.fg)
                Text("This happens once. Afterwards Crate opens straight from its cache and only picks up what changed.")
                    .textStyle(.small)
                    .foregroundStyle(Tok.fgMuted)
            }
            Spacer()
        }
        .padding(16)
        .background(Tok.surfaceMuted, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .hairline(Radius.card)
    }
}

private struct MixesSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let mixes = app.mixes.mixes.filter { $0.source != .library || app.mixes.mixes.count < 6 }
        VStack(alignment: .leading, spacing: 14) {
            SectionTitle(title: "Made for you", action: ("Discover", { app.nav.go(.discover) }))
            if mixes.isEmpty && !app.settings.hasListenBrainz && !app.settings.hasLastFM {
                ConnectServicesCard()
            } else {
                Carousel(items: Array((mixes.isEmpty ? app.mixes.mixes : mixes).prefix(10))) { MixCard(mix: $0) }
            }
        }
    }
}

struct ConnectServicesCard: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 16) {
            CrateMark(size: 40, cutout: Tok.surfaceMuted)
            VStack(alignment: .leading, spacing: 3) {
                Text("Weekly recommendations").textStyle(.bodyStrong).foregroundStyle(Tok.fg)
                Text("Connect ListenBrainz or Last.fm to get Weekly Jams, Weekly Exploration and a weekly mix. Songs you don't own play through octo-fiesta.")
                    .textStyle(.small)
                    .foregroundStyle(Tok.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button("Connect") { app.nav.go(.settings) }
                .buttonStyle(.crate(.primary, size: .sm))
        }
        .padding(16)
        .background(Tok.surfaceMuted, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .hairline(Radius.card)
    }
}

struct PlaylistCard: View {
    @Environment(AppModel.self) private var app
    let playlist: Playlist
    var size: CGFloat = 168
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                Artwork(coverArt: playlist.coverArt, size: size, radius: Radius.card, placeholderSymbol: "music.note.list")
                if hovering {
                    PlayCircleButton(size: 38) { play() }
                        .padding(8)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(playlist.displayName).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                Text(Format.count(playlist.songCount, "song")).textStyle(.small).foregroundStyle(Tok.fgMuted)
            }
            .frame(width: size, alignment: .leading)
        }
        .contentShape(Rectangle())
        .rowHover($hovering)
        .animation(Motion.fast, value: hovering)
        .onTapGesture { app.nav.go(.playlist(playlist.id)) }
        .contextMenu { PlaylistMenuItems(playlist: playlist) }
    }

    private func play() {
        Task {
            let songs = await app.library.songs(of: playlist)
            app.player.play(songs, shuffled: false, context: "playlist:\(playlist.id)")
        }
    }
}

struct PlaylistMenuItems: View {
    @Environment(AppModel.self) private var app
    let playlist: Playlist

    var body: some View {
        Button("Play") { load { app.player.play($0, shuffled: false, context: "playlist:\(playlist.id)") } }
        Button("Shuffle") { load { app.player.play($0, shuffled: true, context: "playlist:\(playlist.id)") } }
        Button("Add to queue") { load { app.player.addToQueue($0) } }
        Divider()
        Button(app.library.isPinned(playlist.id) ? "Unpin" : "Pin to sidebar") { app.library.togglePin(playlist.id) }
        Button(app.downloads.isOffline(.playlist, playlist.id) ? "Remove download" : "Make available offline") {
            load { app.downloads.toggleOffline(.playlist, id: playlist.id, name: playlist.displayName, tracks: $0) }
        }
        Divider()
        Button("Rename…") { app.playlistPrompt = PlaylistPrompt(tracks: [], renaming: playlist) }
        Button("Delete playlist", role: .destructive) { app.confirmDelete = playlist }
    }

    private func load(_ action: @escaping ([Track]) -> Void) {
        Task {
            let songs = await app.library.songs(of: playlist)
            action(songs)
        }
    }
}
