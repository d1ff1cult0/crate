import SwiftUI

struct AlbumCard: View {
    @Environment(AppModel.self) private var app
    let album: Album
    var size: CGFloat = 168
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                Artwork(coverArt: album.coverArt, size: size, radius: Radius.card, placeholderSymbol: album.isExternalPlaylist ? "music.note.list" : "square.stack")
                if hovering {
                    PlayCircleButton(size: 38) { play(shuffled: false) }
                        .padding(8)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(album.name).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                    if album.isExternal {
                        Image(systemName: "arrow.down.forward")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(TagHue.purple.text)
                            .help("From \(OctoID.providerName(album.id) ?? "a provider") via octo-fiesta")
                    }
                }
                Text(subtitle).textStyle(.small).foregroundStyle(Tok.fgMuted).lineLimit(1)
            }
            .frame(width: size, alignment: .leading)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
        .onTapGesture { app.nav.go(.album(album.id)) }
        .contextMenu { AlbumMenuItems(album: album) }
    }

    private var subtitle: String {
        if let year = album.year, year > 0 { return "\(album.artist) · \(year)" }
        return album.artist
    }

    private func play(shuffled: Bool) {
        Task {
            let songs = await app.library.songs(ofAlbum: album.id)
            app.player.play(songs, shuffled: shuffled, context: "album:\(album.id)")
        }
    }
}

struct AlbumMenuItems: View {
    @Environment(AppModel.self) private var app
    let album: Album

    var body: some View {
        Button("Play") { load { app.player.play($0, shuffled: false, context: "album:\(album.id)") } }
        Button("Shuffle") { load { app.player.play($0, shuffled: true, context: "album:\(album.id)") } }
        Button("Play next") { load { app.player.playNext($0) } }
        Button("Add to queue") { load { app.player.addToQueue($0) } }
        Button("Start radio") { app.player.startRadio(.artist(name: album.artist, id: album.artistId), name: album.artist) }
        Divider()
        Button(app.library.isStarred(album: album) ? "Remove from favourites" : (album.isExternal ? "Add to library" : "Add to favourites")) {
            app.library.toggleStar(album: album)
        }
        if let artistId = album.artistId {
            Button("Go to artist") { app.nav.go(.artist(artistId)) }
        }
        Divider()
        Button(app.downloads.isOffline(.album, album.id) ? "Remove download" : "Download") {
            load { app.downloads.toggleOffline(.album, id: album.id, name: album.name, tracks: $0) }
        }
    }

    private func load(_ action: @escaping ([Track]) -> Void) {
        Task {
            let songs = await app.library.songs(ofAlbum: album.id)
            action(songs)
        }
    }
}

struct ArtistCard: View {
    @Environment(AppModel.self) private var app
    let artist: Artist
    var size: CGFloat = 148

    var body: some View {
        VStack(spacing: 10) {
            Artwork(coverArt: artist.coverArt, size: size, circle: true, placeholderName: artist.name)
            VStack(spacing: 2) {
                Text(artist.name).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                Text(artist.isExternal ? "From \(OctoID.providerName(artist.id) ?? "provider")" : Format.count(artist.albumCount, "album"))
                    .textStyle(.small)
                    .foregroundStyle(Tok.fgMuted)
            }
            .frame(width: size)
        }
        .contentShape(Rectangle())
        .onTapGesture { app.nav.go(.artist(artist.id)) }
        .contextMenu {
            Button("Start radio") { app.player.startRadio(.artist(name: artist.name, id: artist.id), name: artist.name) }
            Button("Go to artist") { app.nav.go(.artist(artist.id)) }
        }
    }
}

struct MixCard: View {
    @Environment(AppModel.self) private var app
    let mix: Mix
    var size: CGFloat = 168
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottomTrailing) {
                MixCover(mix: mix, size: size)
                if hovering, !mix.playable.isEmpty {
                    PlayCircleButton(size: 38) { app.player.play(mix.playable, shuffled: false, context: "mix:\(mix.id)") }
                        .padding(8)
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(mix.title).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                Text(mix.subtitle).textStyle(.small).foregroundStyle(Tok.fgMuted).lineLimit(1)
            }
            .frame(width: size, alignment: .leading)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
        .onTapGesture { app.nav.go(.mix(mix.id)) }
    }
}

/// A mix cover: the tag-palette tile with a 2×2 mosaic of its first covers when there are some.
struct MixCover: View {
    @Environment(AppModel.self) private var app
    let mix: Mix
    var size: CGFloat

    var body: some View {
        // Four different albums, not four songs from the same one.
        var seen = Set<String>()
        let covers = Array(mix.entries.compactMap { e -> (String?, URL?)? in
            let key: String
            let cover: (String?, URL?)
            if let t = e.track, let art = app.library.cover(for: t) {
                key = t.albumId ?? art
                cover = (art, nil)
            } else if let url = e.artworkURL {
                key = url.absoluteString
                cover = (nil, url)
            } else {
                return nil
            }
            return seen.insert(key).inserted ? cover : nil
        }.prefix(4))
        ZStack(alignment: .bottomLeading) {
            if covers.count == 4 {
                let tile = size / 2
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        Artwork(coverArt: covers[0].0, url: covers[0].1, size: tile, radius: 0)
                        Artwork(coverArt: covers[1].0, url: covers[1].1, size: tile, radius: 0)
                    }
                    HStack(spacing: 0) {
                        Artwork(coverArt: covers[2].0, url: covers[2].1, size: tile, radius: 0)
                        Artwork(coverArt: covers[3].0, url: covers[3].1, size: tile, radius: 0)
                    }
                }
                LinearGradient(colors: [.black.opacity(0), .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
                HStack(spacing: 6) {
                    Image(systemName: mix.symbol).font(.system(size: size * 0.08, weight: .semibold))
                    Text(mix.title).font(CrateFonts.font(size: max(11, size * 0.085), weight: .semibold)).lineLimit(1)
                }
                .foregroundStyle(.white)
                .padding(size * 0.07)
            } else {
                GeneratedCover(title: mix.title, symbol: mix.symbol, hue: mix.tagHue, size: size, radius: 0)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size > 120 ? Radius.card : 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size > 120 ? Radius.card : 8, style: .continuous).strokeBorder(Tok.border, lineWidth: 1))
    }
}

/// A grid whose cards fill the available width exactly.
struct AdaptiveGrid<Item: Identifiable, Content: View>: View {
    let items: [Item]
    var minItemWidth: CGFloat = 160
    var spacing: CGFloat = 20
    var onReachEnd: (() -> Void)?
    @ViewBuilder let content: (Item, CGFloat) -> Content
    @State private var width: CGFloat = 900

    var body: some View {
        let columns = max(1, Int((width + spacing) / (minItemWidth + spacing)))
        let itemWidth = floor((width - spacing * CGFloat(columns - 1)) / CGFloat(columns))
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(itemWidth), spacing: spacing, alignment: .top), count: columns),
                  alignment: .leading, spacing: 24) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                content(item, itemWidth)
                    .onAppear {
                        if index >= items.count - columns * 3 { onReachEnd?() }
                    }
            }
        }
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { width = geo.size.width }
                    .onChange(of: geo.size.width) { _, new in width = new }
            }
        )
    }
}

struct Carousel<Item: Identifiable, Content: View>: View {
    let items: [Item]
    var spacing: CGFloat = 18
    @ViewBuilder let content: (Item) -> Content

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: spacing) {
                ForEach(items) { item in content(item) }
            }
            .padding(.horizontal, Metrics.contentGutter)
        }
        .padding(.horizontal, -Metrics.contentGutter)
    }
}

/// Header for album, playlist, artist, genre and mix pages.
struct DetailHero<Cover: View, Actions: View>: View {
    let kind: String
    let title: String
    var subtitle: AnyView?
    var meta: String
    var pills: AnyView?
    @ViewBuilder let cover: () -> Cover
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(alignment: .bottom, spacing: 24) {
            cover()
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(kind).textStyle(.captionStrong).foregroundStyle(Tok.fgMuted)
                    if let pills { pills }
                }
                Text(title)
                    .textStyle(.hero)
                    .foregroundStyle(Tok.fg)
                    .lineLimit(2)
                    .textSelection(.enabled)
                if let subtitle { subtitle }
                Text(meta).textStyle(.small, tabular: true).foregroundStyle(Tok.fgMuted)
                HStack(spacing: 8) {
                    actions()
                }
                .padding(.top, 8)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.contentGutter)
        .padding(.top, 24)
        .padding(.bottom, 20)
    }
}

/// Toolbar row under the page header for collection pages.
struct PageToolbar<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        HStack(spacing: 8) { content() }
            .padding(.horizontal, Metrics.contentGutter - 8)
            .frame(height: Metrics.toolbarHeight + 8)
    }
}

struct LoadingRows: View {
    var count = 8
    var artwork = true

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { i in
                HStack(spacing: 12) {
                    Skeleton(width: 16, height: 10).frame(width: 28)
                    if artwork { Skeleton(width: 36, height: 36, radius: 6) }
                    VStack(alignment: .leading, spacing: 6) {
                        Skeleton(width: CGFloat(140 + (i * 37) % 120), height: 11)
                        Skeleton(width: CGFloat(80 + (i * 23) % 70), height: 9)
                    }
                    Spacer()
                    Skeleton(width: 36, height: 10)
                }
                .padding(.horizontal, 12)
                .frame(height: artwork ? Metrics.rowHeight : 42)
            }
        }
    }
}
