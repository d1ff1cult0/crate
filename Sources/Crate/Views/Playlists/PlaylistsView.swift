import SwiftUI

struct PlaylistsView: View {
    @Environment(AppModel.self) private var app
    @State private var filter = ""
    @State private var sort = "name"
    @FocusState private var filterFocused: Bool

    var body: some View {
        let library = app.library
        let all = sorted(library.playlists.filter { filter.isEmpty || $0.displayName.localizedCaseInsensitiveContains(filter) })
        let pinned = library.pinnedPlaylists.filter { filter.isEmpty || $0.displayName.localizedCaseInsensitiveContains(filter) }
        let rest = all.filter { !library.isPinned($0.id) }

        VStack(spacing: 0) {
            PageToolbar {
                CrateTextField(placeholder: "Find a playlist (⌘F)", text: $filter, icon: "magnifyingglass", height: 32)
                    .frame(maxWidth: 320)
                    .focused($filterFocused)
                SortChip(label: "Sorted by", options: [("name", "Name"), ("updated", "Recently updated"), ("songs", "Most songs")], selection: $sort)
                Spacer()
                Text(Format.count(library.playlists.count, "playlist")).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
                Button {
                    app.playlistPrompt = PlaylistPrompt(tracks: [])
                } label: { Label("New playlist", systemImage: "plus") }
                    .buttonStyle(.crate(.primary, size: .sm))
            }
            Hairline()
            if library.playlists.isEmpty {
                if library.isSyncing {
                    LoadingRows(count: 10).padding(.horizontal, Metrics.contentGutter - 12).padding(.top, 12)
                    Spacer()
                } else {
                    EmptyState(symbol: "music.note.list", title: "No playlists yet", message: "Create one, or save a Discover mix as a playlist.",
                               action: ("New playlist", { app.playlistPrompt = PlaylistPrompt(tracks: []) }))
                    Spacer()
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if !pinned.isEmpty {
                            ListSectionLabel(title: "Pinned", detail: "Shown in the sidebar · drag there to reorder")
                            ForEach(pinned) { PlaylistRow(playlist: $0) }
                            ListSectionLabel(title: "All playlists", detail: nil)
                                .padding(.top, 12)
                        } else if filter.isEmpty {
                            HStack(spacing: 10) {
                                Image(systemName: "pin").font(.system(size: 13, weight: .medium)).foregroundStyle(Tok.accent)
                                Text("Pin the playlists you play most. They stay at the top here and in the sidebar.")
                                    .textStyle(.small).foregroundStyle(Tok.fgSecondary)
                                Spacer()
                            }
                            .padding(12)
                            .background(Tok.infoBg, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Tok.infoBorder, lineWidth: 1))
                            .padding(.horizontal, 12)
                            .padding(.bottom, 12)
                        }
                        ForEach(rest) { PlaylistRow(playlist: $0) }
                        if all.isEmpty {
                            EmptyState(symbol: "magnifyingglass", title: "No playlists match “\(filter)”", message: "Check the spelling or try part of the name.")
                        }
                    }
                    .padding(.horizontal, Metrics.contentGutter - 12)
                    .padding(.vertical, 12)
                }
            }
        }
        .background {
            Button("") { filterFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .hidden()
        }
    }

    private func sorted(_ list: [Playlist]) -> [Playlist] {
        switch sort {
        case "updated": list.sorted { ($0.changed ?? .distantPast) > ($1.changed ?? .distantPast) }
        case "songs": list.sorted { $0.songCount > $1.songCount }
        default: list
        }
    }
}

struct ListSectionLabel: View {
    let title: String
    let detail: String?
    var body: some View {
        HStack(spacing: 6) {
            Text(title).textStyle(.captionStrong).foregroundStyle(Tok.fgMuted)
            if let detail {
                Text("· \(detail)").textStyle(.caption).foregroundStyle(Tok.fgPlaceholder)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

struct PlaylistRow: View {
    @Environment(AppModel.self) private var app
    let playlist: Playlist
    @State private var hovering = false

    var body: some View {
        let pinned = app.library.isPinned(playlist.id)
        let offline = app.downloads.isOffline(.playlist, playlist.id)
        let playing = app.player.context == "playlist:\(playlist.id)" && app.player.current != nil
        HStack(spacing: 14) {
            ZStack {
                Artwork(coverArt: playlist.coverArt, size: 44, radius: 8, placeholderSymbol: "music.note.list")
                if hovering {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.black.opacity(0.35)).frame(width: 44, height: 44)
                    Button { play(shuffled: false) } label: {
                        Image(systemName: "play.fill").font(.system(size: 14)).foregroundStyle(.white).frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(playlist.displayName).textStyle(.bodyStrong).foregroundStyle(playing ? Tok.accentText : Tok.fg).lineLimit(1)
                    if playing { NowPlayingBars(animating: app.player.isPlaying, height: 10) }
                }
                Text([Format.count(playlist.songCount, "song"), Format.longDuration(playlist.duration)].joined(separator: " · "))
                    .textStyle(.small, tabular: true)
                    .foregroundStyle(Tok.fgMuted)
            }
            Spacer()
            if let changed = playlist.changed {
                Text("Updated \(Format.relative(changed))").textStyle(.caption).foregroundStyle(Tok.fgPlaceholder)
                    .opacity(hovering ? 1 : 0)
            }
            if offline {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Tok.success)
                    .help("Available offline")
            }
            Button {
                withAnimation(Motion.base) { app.library.togglePin(playlist.id) }
            } label: {
                Image(systemName: pinned ? "pin.fill" : "pin")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(pinned ? Tok.accent : Tok.icon)
                    .rotationEffect(.degrees(pinned ? 0 : 30))
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(pinned || hovering ? 1 : 0)
            .help(pinned ? "Unpin" : "Pin to the top and the sidebar")
            Menu {
                PlaylistMenuItems(playlist: playlist)
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tok.icon).frame(width: 26, height: 26)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .frame(width: 26)
            .opacity(hovering ? 1 : 0)
        }
        .padding(.horizontal, 12)
        .frame(height: 60)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(hovering ? Tok.surfaceHover : .clear))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture { app.nav.go(.playlist(playlist.id)) }
        .contextMenu { PlaylistMenuItems(playlist: playlist) }
    }

    private func play(shuffled: Bool) {
        Task {
            let songs = await app.library.songs(of: playlist)
            app.player.play(songs, shuffled: shuffled, context: "playlist:\(playlist.id)")
        }
    }
}

struct PlaylistDetailView: View {
    @Environment(AppModel.self) private var app
    let playlistId: String
    @State private var playlist: Playlist?
    @State private var tracks: [Track] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var filter = ""
    @State private var selection: Set<Int> = []

    var body: some View {
        let visible = filteredIndexes
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let playlist {
                    hero(playlist)
                    if tracks.count > 15 {
                        HStack {
                            CrateTextField(placeholder: "Filter in playlist", text: $filter, icon: "magnifyingglass", height: 32)
                                .frame(maxWidth: 280)
                            Spacer()
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                        .padding(.bottom, 12)
                    }
                    if !loaded, tracks.isEmpty {
                        LoadingRows(count: 10).padding(.horizontal, Metrics.contentGutter - 12)
                    } else if tracks.isEmpty {
                        EmptyState(symbol: "music.note.list", title: "This playlist is empty", message: "Add songs from any list with right-click → Add to playlist.")
                    } else {
                        TrackRows(
                            tracks: visible.map { tracks[$0] },
                            context: "playlist:\(playlist.id)",
                            playAction: { index in
                                let original = visible[index]
                                let playable = tracks.enumerated().filter { app.isPlayable($0.element) }
                                let start = playable.firstIndex { $0.offset == original } ?? 0
                                app.player.play(playable.map(\.element), startAt: start, context: "playlist:\(playlist.id)")
                            },
                            extraMenu: { index in
                                AnyView(Button("Remove from this playlist") {
                                    let original = visible[index]
                                    tracks.remove(at: original)
                                    selection = []
                                    Task { await app.library.remove(indexes: [original], from: playlist.id) }
                                })
                            },
                            selection: $selection
                        )
                        .padding(.horizontal, Metrics.contentGutter - 12)
                    }
                } else if let error {
                    EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't load this playlist", message: error)
                } else {
                    LoadingRows(count: 10).padding(Metrics.contentGutter)
                }
                Color.clear.frame(height: 32)
            }
        }
        .pageTitle(playlist?.displayName)
        .task { await load() }
        .onChange(of: filter) { selection = [] }
    }

    private var filteredIndexes: [Int] {
        guard !filter.isEmpty else { return Array(tracks.indices) }
        return tracks.indices.filter {
            tracks[$0].title.localizedCaseInsensitiveContains(filter) || tracks[$0].artist.localizedCaseInsensitiveContains(filter)
                || tracks[$0].album.localizedCaseInsensitiveContains(filter)
        }
    }

    @ViewBuilder
    private func hero(_ playlist: Playlist) -> some View {
        let pinned = app.library.isPinned(playlist.id)
        let offline = app.downloads.isOffline(.playlist, playlist.id)
        let progress = offline ? app.downloads.sets.first { $0.kind == .playlist && $0.setId == playlist.id }.map { app.downloads.progress(of: $0) } : nil
        DetailHero(
            kind: "Playlist",
            title: playlist.displayName,
            subtitle: playlist.comment.flatMap { $0.hasPrefix("Auto-imported") || $0.isEmpty ? nil : AnyView(Text($0).textStyle(.small).foregroundStyle(Tok.fgSecondary)) },
            meta: [playlist.owner, Format.count(tracks.isEmpty ? playlist.songCount : tracks.count, "song"),
                   Format.longDuration(tracks.isEmpty ? playlist.duration : tracks.reduce(0) { $0 + $1.duration }),
                   playlist.changed.map { "updated \(Format.relative($0))" },
                   progress.map { $0.done == $0.total ? "downloaded" : "downloading \($0.done) of \($0.total)" }]
                .compactMap { $0 }.joined(separator: " · "),
            cover: { Artwork(coverArt: playlist.coverArt, size: 200, radius: Radius.card, placeholderSymbol: "music.note.list") },
            actions: {
                Button {
                    app.player.play(tracks.filter(app.isPlayable), shuffled: false, context: "playlist:\(playlist.id)")
                } label: { Label("Play", systemImage: "play.fill") }
                    .buttonStyle(.crate(.primary))
                    .disabled(tracks.isEmpty)
                Button {
                    app.player.play(tracks.filter(app.isPlayable), shuffled: true, context: "playlist:\(playlist.id)")
                } label: { Label("Shuffle", systemImage: "shuffle") }
                    .buttonStyle(.crate(.secondary))
                    .disabled(tracks.isEmpty)
                Button {
                    withAnimation(Motion.base) { app.library.togglePin(playlist.id) }
                } label: { Label(pinned ? "Pinned" : "Pin", systemImage: pinned ? "pin.fill" : "pin") }
                    .buttonStyle(.crate(.secondary))
                    .foregroundStyle(pinned ? Tok.accent : Tok.fg)
                    .help(pinned ? "Unpin from the sidebar" : "Pin to the top of Playlists and the sidebar")
                IconActionButton(symbol: offline ? "arrow.down.circle.fill" : "arrow.down.circle",
                                 help: offline ? "Remove the offline copy" : "Make available offline (stays in sync)", active: offline) {
                    app.downloads.toggleOffline(.playlist, id: playlist.id, name: playlist.displayName, tracks: tracks)
                }
                .disabled(tracks.isEmpty)
                Menu {
                    Button("Start radio from this playlist") {
                        app.player.startRadio(.recent(Array(tracks.shuffled().prefix(6))), name: playlist.displayName)
                    }
                    Divider()
                    Button("Rename…") { app.playlistPrompt = PlaylistPrompt(tracks: [], renaming: playlist) }
                    Button("Delete playlist", role: .destructive) { app.confirmDelete = playlist }
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

    private func load() async {
        playlist = app.library.playlist(id: playlistId)
        if let playlist, let cached = app.library.cachedPlaylistSongs(playlist), !cached.isEmpty {
            tracks = cached
            loaded = true
        }
        guard !app.isOffline else {
            loaded = true
            if playlist == nil { error = "You're offline and this playlist isn't cached." }
            return
        }
        do {
            let (fresh, songs) = try await app.library.fetchPlaylist(playlistId)
            playlist = fresh
            tracks = songs
        } catch {
            if tracks.isEmpty { self.error = error.localizedDescription }
        }
        loaded = true
    }
}
