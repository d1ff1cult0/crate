import SwiftUI

struct GenresView: View {
    @Environment(AppModel.self) private var app
    @State private var filter = ""
    @State private var sort = "songs"

    var body: some View {
        let genres = sortedGenres
        VStack(spacing: 0) {
            PageToolbar {
                CrateTextField(placeholder: "Filter \(app.library.genres.count) genres", text: $filter, icon: "magnifyingglass", height: 32)
                    .frame(maxWidth: 280)
                SortChip(label: "Sorted by", options: [("songs", "Most songs"), ("albums", "Most albums"), ("name", "Name")], selection: $sort)
                Spacer()
            }
            Hairline()
            if app.library.genres.isEmpty {
                if app.library.isSyncing {
                    LoadingGrid()
                } else {
                    EmptyState(symbol: "tag", title: "No genres yet", message: "Genres appear once your library has been indexed.")
                    Spacer()
                }
            } else if genres.isEmpty {
                EmptyState(symbol: "tag", title: "No genres match", message: "Try a different filter.")
                Spacer()
            } else {
                ScrollView {
                    AdaptiveGrid(items: genres, minItemWidth: 200, spacing: 14) { genre, width in
                        GenreTile(genre: genre, width: width)
                    }
                    .padding(Metrics.contentGutter)
                }
            }
        }
    }

    private var sortedGenres: [Genre] {
        var list = app.library.genres.filter { $0.songCount > 0 }
        if !filter.isEmpty {
            list = list.filter { $0.name.localizedCaseInsensitiveContains(filter) }
        }
        switch sort {
        case "name": list.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        case "albums": list.sort { $0.albumCount > $1.albumCount }
        default: list.sort { $0.songCount > $1.songCount }
        }
        return list
    }
}

private struct GenreTile: View {
    @Environment(AppModel.self) private var app
    let genre: Genre
    let width: CGFloat
    @State private var hovering = false

    var body: some View {
        let hue = TagHue.forName(genre.name)
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(genre.name)
                    .textStyle(.title)
                    .foregroundStyle(hue.text)
                    .lineLimit(1)
                Text("\(Format.count(genre.songCount, "song")) · \(Format.count(genre.albumCount, "album"))")
                    .textStyle(.caption, tabular: true)
                    .foregroundStyle(Tok.fgMuted)
            }
            Spacer(minLength: 0)
            if hovering {
                PlayCircleButton(size: 32) { shuffle() }
                    .help("Shuffle \(genre.name)")
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .frame(width: width, height: 76)
        .background(hue.bg, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(hue.border, lineWidth: 1))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
        .onTapGesture { app.nav.go(.genre(genre.name)) }
        .contextMenu {
            Button("Shuffle") { shuffle() }
            Button("Start genre radio") { app.player.startRadio(.genre(genre.name), name: genre.name) }
        }
    }

    private func shuffle() {
        let songs = app.library.db?.randomSongs(genre: genre.name, limit: 200) ?? []
        app.player.play(songs, shuffled: true, context: "genre:\(genre.name)")
    }
}

struct GenreDetailView: View {
    @Environment(AppModel.self) private var app
    let genre: String
    @State private var tab = "albums"
    @State private var albums: [Album] = []
    @State private var songs: [Track] = []
    @State private var songsExhausted = false
    @State private var selection: Set<Int> = []

    var body: some View {
        let info = app.library.genres.first { $0.name == genre }
        let hue = TagHue.forName(genre)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                DetailHero(
                    kind: "Genre",
                    title: genre,
                    meta: [info.map { Format.count($0.songCount, "song") }, info.map { Format.count($0.albumCount, "album") }]
                        .compactMap { $0 }.joined(separator: " · "),
                    cover: { GeneratedCover(title: genre, symbol: "tag", hue: hue, size: 184, showTitle: false) },
                    actions: {
                        Button {
                            let random = app.library.db?.randomSongs(genre: genre, limit: 200) ?? []
                            app.player.play(random, shuffled: true, context: "genre:\(genre)")
                        } label: { Label("Shuffle play", systemImage: "shuffle") }
                            .buttonStyle(.crate(.primary))
                        Button {
                            app.player.startRadio(.genre(genre), name: genre)
                        } label: { Label("Genre radio", systemImage: "dot.radiowaves.left.and.right") }
                            .buttonStyle(.crate(.secondary))
                    }
                )
                Segmented(options: [("albums", "Albums"), ("songs", "Songs")], selection: $tab)
                    .padding(.horizontal, Metrics.contentGutter)
                    .padding(.bottom, 16)
                if tab == "albums" {
                    if albums.isEmpty {
                        EmptyState(symbol: "square.stack", title: "No albums tagged \(genre)", message: "Albums use their own genre tag, which can differ from the songs on them.")
                    } else {
                        AdaptiveGrid(items: albums, minItemWidth: 156) { album, width in
                            AlbumCard(album: album, size: width)
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                    }
                } else {
                    TrackRows(tracks: songs, context: "genre:\(genre)", playAction: { index in
                        app.player.play(Array(songs[index..<min(songs.count, index + 500)]), context: "genre:\(genre)")
                    }, onReachEnd: loadMoreSongs, selection: $selection)
                        .padding(.horizontal, Metrics.contentGutter - 12)
                }
                Color.clear.frame(height: 32)
            }
        }
        .pageTitle(genre)
        .onAppear {
            guard let db = app.library.db else { return }
            albums = db.albums(sort: .mostPlayed, genre: genre, limit: 400, offset: 0)
            songs = db.songs(genre: genre, sort: .mostPlayed, limit: 300, offset: 0)
            songsExhausted = songs.count < 300
        }
    }

    private func loadMoreSongs() {
        guard !songsExhausted, let db = app.library.db else { return }
        let next = db.songs(genre: genre, sort: .mostPlayed, limit: 300, offset: songs.count)
        songsExhausted = next.count < 300
        songs += next
    }
}
