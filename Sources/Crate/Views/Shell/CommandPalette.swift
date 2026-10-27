import SwiftUI

/// ⌘K: instant results from the local index (playlists first), with keyboard navigation.
/// Enter opens, ⌘Enter plays, and the last row hands the query to full search.
struct CommandPalette: View {
    @Environment(AppModel.self) private var app
    @State private var selected = 0
    @FocusState private var focused: Bool

    enum Result: Identifiable {
        case playlist(Playlist)
        case album(Album)
        case artist(Artist)
        case song(Track)
        case genre(Genre)
        case page(Route)
        case searchEverywhere(String)

        var id: String {
            switch self {
            case let .playlist(p): "p:\(p.id)"
            case let .album(a): "a:\(a.id)"
            case let .artist(a): "r:\(a.id)"
            case let .song(s): "s:\(s.id)"
            case let .genre(g): "g:\(g.name)"
            case let .page(r): "n:\(r.title)"
            case let .searchEverywhere(q): "q:\(q)"
            }
        }

        var section: String {
            switch self {
            case .playlist: "Playlists"
            case .album: "Albums"
            case .artist: "Artists"
            case .song: "Songs"
            case .genre: "Genres"
            case .page: "Go to"
            case .searchEverywhere: "Search"
            }
        }
    }

    var body: some View {
        @Bindable var app = app
        let results = self.results
        ZStack(alignment: .top) {
            Tok.overlay
                .ignoresSafeArea()
                .onTapGesture { close() }
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .medium)).foregroundStyle(Tok.icon)
                    TextField("", text: $app.paletteQuery, prompt: Text("Jump to a playlist, album, artist or song…").foregroundStyle(Tok.fgPlaceholder))
                        .textFieldStyle(.plain)
                        .font(CrateFonts.font(size: 16, weight: .regular))
                        .foregroundStyle(Tok.fg)
                        .focused($focused)
                        .onSubmit { activate(results, play: false) }
                        .onKeyPress(.downArrow) {
                            selected = min(selected + 1, max(results.count - 1, 0))
                            return .handled
                        }
                        .onKeyPress(.upArrow) {
                            selected = max(selected - 1, 0)
                            return .handled
                        }
                        .onKeyPress(.escape) {
                            close()
                            return .handled
                        }
                        .onKeyPress(.return, phases: .down) { press in
                            guard press.modifiers.contains(.command) else { return .ignored }
                            activate(results, play: true)
                            return .handled
                        }
                    Kbd(keys: "esc")
                }
                .padding(.horizontal, 16)
                .frame(height: 52)
                Hairline()
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(results.enumerated()), id: \.element.id) { index, result in
                                if index == 0 || results[index - 1].section != result.section {
                                    Text(result.section)
                                        .textStyle(.captionStrong)
                                        .foregroundStyle(Tok.fgMuted)
                                        .padding(.horizontal, 12)
                                        .padding(.top, index == 0 ? 6 : 12)
                                        .padding(.bottom, 4)
                                }
                                PaletteRow(result: result, isSelected: index == selected)
                                    .id(result.id)
                                    .onTapGesture {
                                        selected = index
                                        activate(results, play: false)
                                    }
                                    .onHover { if $0 { selected = index } }
                            }
                        }
                        .padding(8)
                    }
                    .frame(maxHeight: 420)
                    .onChange(of: selected) { _, new in
                        if results.indices.contains(new) { proxy.scrollTo(results[new].id) }
                    }
                }
                Hairline()
                HStack(spacing: 14) {
                    hint("↑↓", "navigate")
                    hint("↵", "open")
                    hint("⌘↵", "play")
                    Spacer()
                }
                .padding(.horizontal, 14)
                .frame(height: 36)
            }
            .frame(width: 640)
            .background(Tok.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .hairline(Radius.panel)
            .dialogShadow()
            .padding(.top, 110)
        }
        .onAppear {
            focused = true
            selected = 0
        }
        .task {
            // When the palette appears its field isn't always in the window yet, and then
            // the focus request is dropped and you'd have to click before typing. Asking
            // again once it's there is harmless when the first request did work.
            for delay in [0, 50, 150] {
                try? await Task.sleep(for: .milliseconds(delay))
                focused = true
            }
        }
        .onChange(of: app.paletteQuery) { selected = 0 }
    }

    private func hint(_ keys: String, _ label: String) -> some View {
        HStack(spacing: 5) {
            Kbd(keys: keys)
            Text(label).textStyle(.caption).foregroundStyle(Tok.fgMuted)
        }
    }

    private var results: [Result] {
        let q = app.paletteQuery.trimmingCharacters(in: .whitespaces)
        let library = app.library
        if q.isEmpty {
            let pinned = library.pinnedPlaylists.map(Result.playlist)
            let pages: [Route] = [.home, .discover, .albums, .artists, .songs, .genres, .playlists, .favourites, .downloads, .settings]
            return pinned + pages.map(Result.page)
        }
        var out: [Result] = []
        let playlists = library.playlists.filter { $0.displayName.localizedCaseInsensitiveContains(q) }
            .sorted { a, b in
                // Pinned first, then names that start with the query.
                let ap = library.isPinned(a.id), bp = library.isPinned(b.id)
                if ap != bp { return ap }
                let aStart = a.displayName.lowercased().hasPrefix(q.lowercased()), bStart = b.displayName.lowercased().hasPrefix(q.lowercased())
                if aStart != bStart { return aStart }
                return a.displayName < b.displayName
            }
        out += playlists.prefix(6).map(Result.playlist)
        if let db = library.db {
            out += db.searchArtists(q, limit: 4).map(Result.artist)
            out += db.searchAlbums(q, limit: 5).map(Result.album)
            out += db.searchSongs(q, limit: 6).map(Result.song)
        }
        out += library.genres.filter { $0.name.localizedCaseInsensitiveContains(q) }.prefix(3).map(Result.genre)
        out.append(.searchEverywhere(q))
        return out
    }

    private func activate(_ results: [Result], play: Bool) {
        guard results.indices.contains(selected) else { return }
        let result = results[selected]
        close()
        switch result {
        case let .playlist(p):
            if play {
                Task {
                    let songs = await app.library.songs(of: p)
                    app.player.play(songs, context: "playlist:\(p.id)")
                }
            } else {
                app.nav.go(.playlist(p.id))
            }
        case let .album(a):
            if play {
                Task {
                    let songs = await app.library.songs(ofAlbum: a.id)
                    app.player.play(songs, context: "album:\(a.id)")
                }
            } else {
                app.nav.go(.album(a.id))
            }
        case let .artist(a):
            if play { app.player.startRadio(.artist(name: a.name, id: a.id), name: a.name) } else { app.nav.go(.artist(a.id)) }
        case let .song(s):
            if play { app.player.play([s]) } else { app.player.play([s]) }
        case let .genre(g):
            app.nav.go(.genre(g.name))
        case let .page(route):
            app.nav.go(route)
        case let .searchEverywhere(q):
            app.nav.go(.search(q))
        }
    }

    private func close() {
        app.showPalette = false
    }
}

private struct PaletteRow: View {
    @Environment(AppModel.self) private var app
    let result: CommandPalette.Result
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 1) {
                Text(title).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                if let subtitle {
                    Text(subtitle).textStyle(.caption).foregroundStyle(Tok.fgMuted).lineLimit(1)
                }
            }
            Spacer()
            if case let .playlist(p) = result, app.library.isPinned(p.id) {
                Image(systemName: "pin.fill").font(.system(size: 10)).foregroundStyle(Tok.accent)
            }
            if isSelected {
                Image(systemName: "return").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tok.fgMuted)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 44)
        .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(isSelected ? Tok.sidebarActive : .clear))
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var leading: some View {
        switch result {
        case let .playlist(p): Artwork(coverArt: p.coverArt, size: 30, radius: 6, placeholderSymbol: "music.note.list")
        case let .album(a): Artwork(coverArt: a.coverArt, size: 30, radius: 6)
        case let .artist(a): Artwork(coverArt: a.coverArt, size: 30, circle: true, placeholderName: a.name)
        case let .song(s): Artwork(coverArt: app.library.cover(for: s), size: 30, radius: 6)
        case let .genre(g): GeneratedCover(title: "", symbol: "tag", hue: TagHue.forName(g.name), size: 30, radius: 6, showTitle: false)
        case let .page(r): icon(r.symbol)
        case .searchEverywhere: icon("magnifyingglass")
        }
    }

    private func icon(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Tok.icon)
            .frame(width: 30, height: 30)
            .background(Tok.surfaceMuted, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .hairline(6)
    }

    private var title: String {
        switch result {
        case let .playlist(p): p.displayName
        case let .album(a): a.name
        case let .artist(a): a.name
        case let .song(s): s.title
        case let .genre(g): g.name
        case let .page(r): r.title
        case let .searchEverywhere(q): "Search everywhere for “\(q)”"
        }
    }

    private var subtitle: String? {
        switch result {
        case let .playlist(p): Format.count(p.songCount, "song")
        case let .album(a): a.artist
        case let .artist(a): Format.count(a.albumCount, "album")
        case let .song(s): "\(s.artist) · \(s.album)"
        case let .genre(g): Format.count(g.songCount, "song")
        case .page: nil
        case .searchEverywhere: "Includes results from octo-fiesta"
        }
    }
}
