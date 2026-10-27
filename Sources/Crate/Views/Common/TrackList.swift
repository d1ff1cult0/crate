import AppKit
import SwiftUI

struct TrackListOptions {
    var artwork = true
    var album = true
    var trackNumbers = false
    var dateAdded = false
}

/// Rows for a track list, meant to sit directly inside a `LazyVStack` so long lists stay
/// lazy. Selection follows the Finder: click, ⌘-click, ⇧-click; double-click or Return plays.
struct TrackRows: View {
    @Environment(AppModel.self) private var app
    let tracks: [Track]
    var options = TrackListOptions()
    var context: String?
    var playAction: ((Int) -> Void)?
    var extraMenu: ((Int) -> AnyView)?
    var onReachEnd: (() -> Void)?
    @Binding var selection: Set<Int>
    @State private var anchor: Int?

    var body: some View {
        TrackListHeader(options: options)
        ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
            TrackRow(
                track: track,
                index: index,
                options: options,
                isSelected: selection.contains(index),
                onSelect: { select(index) },
                onPlay: { play(index) },
                menu: {
                    AnyView(Group {
                        let selected = selection.contains(index) && selection.count > 1
                            ? selection.sorted().compactMap { tracks.indices.contains($0) ? tracks[$0] : nil }
                            : [track]
                        if selected.count == 1 {
                            Button("Play") { play(index) }
                        } else {
                            Button("Play \(selected.count) songs") { app.player.play(selected) }
                        }
                        TrackMenuItems(tracks: selected)
                        if let extraMenu {
                            Divider()
                            extraMenu(index)
                        }
                    })
                }
            )
            .onAppear {
                if index == tracks.count - 40 || (tracks.count < 40 && index == tracks.count - 1) { onReachEnd?() }
                if index % 25 == 0 { warmCovers(from: index) }
            }
        }
    }

    /// Decodes the covers of the next rows in the background (see `ImageCache.warm`).
    private func warmCovers(from index: Int) {
        guard options.artwork, index < tracks.count else { return }
        let ahead = tracks[index..<min(index + 75, tracks.count)]
        ImageCache.shared.warm(ahead.map { (app.library.cover(for: $0), $0.artworkURL) }, points: app.settings.compactRows ? 32 : 36)
    }

    private func play(_ index: Int) {
        if let playAction {
            playAction(index)
        } else {
            let playable = tracks.enumerated().filter { app.isPlayable($0.element) }
            let start = playable.firstIndex { $0.offset == index } ?? 0
            app.player.play(playable.map(\.element), startAt: start, context: context)
        }
    }

    private func select(_ index: Int) {
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            if selection.contains(index) { selection.remove(index) } else { selection.insert(index) }
            anchor = index
        } else if flags.contains(.shift), let anchor {
            selection = Set(min(anchor, index)...max(anchor, index))
        } else {
            selection = [index]
            anchor = index
        }
    }
}

struct TrackListHeader: View {
    let options: TrackListOptions

    var body: some View {
        HStack(spacing: 12) {
            Text("#").frame(width: 28, alignment: .center)
            if options.artwork { Color.clear.frame(width: 36, height: 1) }
            Text("Title").frame(maxWidth: .infinity, alignment: .leading)
            if options.album {
                Text("Album").frame(maxWidth: 240, alignment: .leading)
            }
            Color.clear.frame(width: 18, height: 1)
            Text("Rating").frame(width: 84, alignment: .leading)
            Color.clear.frame(width: 26, height: 1)
            Image(systemName: "clock").font(.system(size: 11, weight: .medium)).frame(width: 46, alignment: .trailing)
            Color.clear.frame(width: 24, height: 1)
        }
        .textStyle(.captionStrong)
        .foregroundStyle(Tok.fgMuted)
        .padding(.horizontal, 12)
        .frame(height: 34)
        .overlay(alignment: .bottom) { Hairline() }
        .padding(.bottom, 4)
    }
}

struct TrackRow: View {
    @Environment(AppModel.self) private var app
    let track: Track
    let index: Int
    let options: TrackListOptions
    let isSelected: Bool
    let onSelect: () -> Void
    let onPlay: () -> Void
    let menu: () -> AnyView
    @State private var hovering = false

    var body: some View {
        let isCurrent = app.player.current?.track.id == track.id
        let rating = app.library.rating(of: track)
        let starred = app.library.isStarred(track)
        let playable = app.isPlayable(track)
        let rowHeight = options.artwork ? (app.settings.compactRows ? 44 : Metrics.rowHeight) : 42

        // Kept deliberately light: rows are created and recycled constantly while
        // scrolling, so controls that only matter under the pointer (play, rating, heart,
        // "…" menu) exist only while hovered or when they carry a value.
        HStack(spacing: 12) {
            ZStack {
                if isCurrent {
                    NowPlayingBars(animating: app.player.isPlaying, height: 12)
                } else if hovering, playable {
                    Image(systemName: "play.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Tok.fg)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onPlay)
                } else {
                    Text(numberText)
                        .textStyle(.small, tabular: true)
                        .foregroundStyle(Tok.fgPlaceholder)
                }
            }
            .frame(width: 28)

            if options.artwork {
                Artwork(coverArt: app.library.cover(for: track), url: track.artworkURL, size: app.settings.compactRows ? 32 : 36, radius: 6)
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(track.title)
                        .textStyle(.bodyStrong)
                        .foregroundStyle(isCurrent ? Tok.accentText : Tok.fg)
                        .lineLimit(1)
                    if track.isExternal { ExternalDot(provider: track.provider) }
                }
                if options.artwork || !options.trackNumbers || track.artist != track.albumArtist {
                    Text(track.artist)
                        .textStyle(.small)
                        .foregroundStyle(hovering ? Tok.fgSecondary : Tok.fgMuted)
                        .lineLimit(1)
                        .onTapGesture { app.openArtist(track) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if options.album {
                Text(track.album)
                    .textStyle(.small)
                    .foregroundStyle(hovering ? Tok.fgSecondary : Tok.fgMuted)
                    .lineLimit(1)
                    .frame(maxWidth: 240, alignment: .leading)
                    .onTapGesture { app.openAlbum(track.albumId) }
            }

            DownloadIndicator(track: track)
                .frame(width: 18)

            ZStack(alignment: .leading) {
                if hovering || rating > 0 {
                    StarRating(rating: rating, size: 10.5, showEmpty: hovering) { app.library.setRating(track, $0) }
                }
            }
            .frame(width: 84, alignment: .leading)

            ZStack {
                if hovering || starred {
                    HeartButton(isOn: starred, size: 12) { app.library.toggleStar(track) }
                }
            }
            .frame(width: 26)

            Text(track.durationText)
                .textStyle(.small, tabular: true)
                .foregroundStyle(Tok.fgMuted)
                .frame(width: 46, alignment: .trailing)

            ZStack {
                if hovering {
                    Menu {
                        menu()
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Tok.icon)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .menuIndicator(.hidden)
                }
            }
            .frame(width: 24)
        }
        .padding(.horizontal, 12)
        .fixedRow(height: rowHeight)
        .background(
            RoundedRectangle(cornerRadius: Radius.chip, style: .continuous)
                .fill(isSelected ? Tok.surfaceSelected : (hovering ? Tok.surfaceHover : .clear))
        )
        .opacity(playable ? 1 : 0.42)
        .contentShape(Rectangle())
        .rowHover($hovering)
        .gesture(TapGesture(count: 2).onEnded { if playable { onPlay() } })
        .simultaneousGesture(TapGesture().onEnded { onSelect() })
        .contextMenu { menu() }
        .draggable(track.id)
    }

    private var numberText: String {
        if options.trackNumbers, let n = track.track { return "\(n)" }
        return "\(index + 1)"
    }
}

struct DownloadIndicator: View {
    @Environment(AppModel.self) private var app
    let track: Track

    var body: some View {
        switch app.downloads.state(for: track.id) {
        case .done:
            Image(systemName: "arrow.down.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Tok.success)
                .help("Downloaded")
        case let .downloading(p):
            ProgressView(value: max(p, 0.02))
                .progressViewStyle(.circular)
                .controlSize(.mini)
                .help("Downloading")
        case .queued:
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 11))
                .foregroundStyle(Tok.fgDisabled)
                .help("Waiting to download")
        case .failed:
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 11))
                .foregroundStyle(Tok.danger)
                .help("Download failed")
        case .none:
            if app.fetcher.isFetching(track.id) {
                ProgressView().controlSize(.mini).help("octo-fiesta is fetching this song")
            } else {
                Color.clear
            }
        }
    }
}

/// The shared song actions, used in context menus and "…" buttons everywhere.
struct TrackMenuItems: View {
    @Environment(AppModel.self) private var app
    let tracks: [Track]

    var body: some View {
        let single = tracks.count == 1 ? tracks[0] : nil
        Button("Play next") { app.player.playNext(tracks) }
        Button("Add to queue") { app.player.addToQueue(tracks) }
        if let single {
            Button("Start radio") { app.player.startRadio(.track(single), name: single.title, leading: [single]) }
        }
        Divider()
        AddToPlaylistMenu(tracks: tracks)
        if let single {
            Button(app.library.isStarred(single) ? "Remove from favourites" : "Add to favourites") { app.library.toggleStar(single) }
            Menu("Rate") {
                ForEach((0...5).reversed(), id: \.self) { value in
                    Button {
                        app.library.setRating(single, value)
                    } label: {
                        if app.library.rating(of: single) == value {
                            Label(value == 0 ? "No rating" : String(repeating: "★", count: value), systemImage: "checkmark")
                        } else {
                            Text(value == 0 ? "No rating" : String(repeating: "★", count: value))
                        }
                    }
                }
            }
        }
        Divider()
        if let single {
            if single.albumId != nil {
                Button("Go to album") { app.openAlbum(single.albumId) }
            }
            Button("Go to artist") { app.openArtist(single) }
        }
        let downloaded = tracks.allSatisfy { app.downloads.localURL(for: $0.id) != nil }
        if downloaded {
            Button("Remove download") { tracks.forEach { app.downloads.removeDownload($0.id) } }
        } else {
            Button(tracks.count == 1 ? "Download" : "Download \(tracks.count) songs") { app.downloads.download(tracks) }
        }
    }
}

struct AddToPlaylistMenu: View {
    @Environment(AppModel.self) private var app
    let tracks: [Track]

    var body: some View {
        Menu("Add to playlist") {
            Button("New playlist…") { app.playlistPrompt = PlaylistPrompt(tracks: tracks) }
            let pinned = app.library.pinnedPlaylists
            if !pinned.isEmpty {
                Divider()
                ForEach(pinned) { playlist in
                    Button(playlist.displayName) { Task { await app.library.add(tracks, to: playlist.id) } }
                }
            }
            Divider()
            ForEach(app.library.playlists.filter { !app.library.isPinned($0.id) }) { playlist in
                Button(playlist.displayName) { Task { await app.library.add(tracks, to: playlist.id) } }
            }
        }
    }
}

struct PlaylistPrompt: Identifiable {
    let id = UUID()
    var tracks: [Track]
    var renaming: Playlist?
}
