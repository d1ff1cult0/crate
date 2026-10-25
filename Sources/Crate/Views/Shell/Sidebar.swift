import SwiftUI
import UniformTypeIdentifiers

struct Sidebar: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Traffic lights live in this strip; it and the logo row move the window.
            VStack(spacing: 0) {
                Color.clear.frame(height: 30)
                HStack(spacing: 9) {
                    CrateMark(size: 26)
                    Wordmark(size: 22)
                    Spacer()
                }
                .padding(.horizontal, 10)
                .frame(height: 40)
            }
            .background(WindowDragArea())

            SearchLauncher()
                .padding(.top, 8)
                .padding(.bottom, 12)

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 2) {
                    NavItem(route: .home)
                    NavItem(route: .discover)
                    SidebarSectionLabel(title: "Library")
                    NavItem(route: .albums)
                    NavItem(route: .artists)
                    NavItem(route: .songs)
                    NavItem(route: .genres)
                    NavItem(route: .playlists)
                    NavItem(route: .favourites)
                    NavItem(route: .downloads, badge: app.downloads.queue.count + app.downloads.progress.count)
                    PinnedSection()
                }
                .padding(.bottom, 12)
            }
            .fadeBottom(24)

            Spacer(minLength: 0)
            NavItem(route: .settings)
            AccountRow()
                .padding(.top, 6)
                .padding(.bottom, 10)
        }
        .padding(.horizontal, 12)
    }
}

struct SidebarSectionLabel: View {
    let title: String
    var action: (() -> Void)?

    var body: some View {
        HStack {
            Text(title).textStyle(.captionStrong).foregroundStyle(Tok.fgMuted)
            Spacer()
            if let action {
                Button(action: action) {
                    Image(systemName: "plus")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Tok.icon)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Pin playlists from the Playlists page")
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 14)
        .padding(.bottom, 4)
    }
}

struct NavItem: View {
    @Environment(AppModel.self) private var app
    let route: Route
    var badge: Int = 0
    @State private var hovering = false

    private var active: Bool {
        app.nav.root == route && (app.nav.stack.isEmpty || route != .settings)
    }

    var body: some View {
        Button {
            app.nav.go(route)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: active ? route.activeSymbol : route.symbol)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(active ? Tok.iconStrong : Tok.icon)
                    .frame(width: 18)
                Text(route.title)
                    .textStyle(.bodyStrong)
                    .foregroundStyle(active ? Tok.fg : Tok.fgNav)
                Spacer()
                if badge > 0 {
                    Text(badge.formatted()).textStyle(.micro, tabular: true).foregroundStyle(Tok.fgMuted)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(active ? Tok.sidebarActive : (hovering ? Tok.sidebarHover : .clear))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

struct SearchLauncher: View {
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    var body: some View {
        Button {
            app.paletteQuery = ""
            app.showPalette = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Tok.fgPlaceholder)
                Text("Search…").textStyle(.small).foregroundStyle(Tok.fgPlaceholder)
                Spacer()
                HStack(spacing: 2) {
                    Kbd(keys: "⌘")
                    Kbd(keys: "K")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(hovering ? Tok.divider : Tok.borderStrong, lineWidth: 1))
            .shadow(color: .black.opacity(0.03), radius: 1, y: 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

/// Pinned playlists: the fix for scrolling through 80+ playlists to find the one you
/// always play. Drag to reorder, right-click to unpin.
struct PinnedSection: View {
    @Environment(AppModel.self) private var app
    @State private var dropTarget: String?

    var body: some View {
        let pinned = app.library.pinnedPlaylists
        SidebarSectionLabel(title: "Pinned") { app.nav.go(.playlists) }
        if pinned.isEmpty {
            Text("Pin a playlist and it shows up here.")
                .textStyle(.caption)
                .foregroundStyle(Tok.fgPlaceholder)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
        }
        ForEach(pinned) { playlist in
            PinnedRow(playlist: playlist, isDropTarget: dropTarget == playlist.id)
                .draggable(playlist.id) {
                    Text(playlist.displayName).textStyle(.smallStrong).padding(6)
                }
                .dropDestination(for: String.self) { items, _ in
                    guard let moved = items.first, moved != playlist.id else { return false }
                    if app.library.isPinned(moved) {
                        withAnimation(Motion.base) { app.library.movePin(moved, before: playlist.id) }
                        return true
                    }
                    // Songs dragged from any list are added to the playlist.
                    let tracks = items.compactMap { app.library.db?.song(id: $0) }
                    guard !tracks.isEmpty else { return false }
                    Task { await app.library.add(tracks, to: playlist.id) }
                    return true
                } isTargeted: { targeted in
                    dropTarget = targeted ? playlist.id : (dropTarget == playlist.id ? nil : dropTarget)
                }
        }
    }
}

struct PinnedRow: View {
    @Environment(AppModel.self) private var app
    let playlist: Playlist
    var isDropTarget = false
    @State private var hovering = false

    private var active: Bool {
        if case let .playlist(id) = app.nav.current { return id == playlist.id }
        return false
    }

    var body: some View {
        Button {
            app.nav.go(.playlist(playlist.id))
        } label: {
            HStack(spacing: 10) {
                Artwork(coverArt: playlist.coverArt, size: 20, radius: 5, placeholderSymbol: "music.note.list")
                Text(playlist.displayName)
                    .textStyle(.smallStrong)
                    .foregroundStyle(active ? Tok.fg : Tok.fgNav)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if app.downloads.isOffline(.playlist, playlist.id) {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Tok.fgDisabled)
                }
                if isPlayingFromThis {
                    NowPlayingBars(animating: app.player.isPlaying, height: 10)
                }
            }
            .padding(.horizontal, 9)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(active ? Tok.sidebarActive : (hovering ? Tok.sidebarHover : .clear))
            )
            .overlay(alignment: .top) {
                if isDropTarget {
                    Rectangle().fill(Tok.accent).frame(height: 2).offset(y: -1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu {
            Button("Play") { play(shuffled: false) }
            Button("Shuffle") { play(shuffled: true) }
            Divider()
            Button("Unpin") { app.library.togglePin(playlist.id) }
        }
    }

    private var isPlayingFromThis: Bool {
        app.player.context == "playlist:\(playlist.id)" && app.player.current != nil
    }

    private func play(shuffled: Bool) {
        Task {
            let songs = await app.library.songs(of: playlist)
            app.player.play(songs, shuffled: shuffled, context: "playlist:\(playlist.id)")
        }
    }
}

struct AccountRow: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 10) {
            ZStack(alignment: .bottomTrailing) {
                Artwork(coverArt: nil, size: 30, circle: true, placeholderName: app.account?.username ?? "?")
                Circle()
                    .fill(statusColor)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().strokeBorder(Tok.canvas, lineWidth: 2))
                    .offset(x: 1, y: 1)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(app.account?.username ?? "").textStyle(.smallStrong).foregroundStyle(Tok.fg).lineLimit(1)
                Text(statusText).textStyle(.caption).foregroundStyle(Tok.fgMuted).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .help(app.account?.url.absoluteString ?? "")
    }

    private var statusColor: Color {
        switch app.connectivity {
        case .online: Tok.success
        case .offline: Color(hex: 0xF59E0B)
        case .checking: Tok.fgDisabled
        }
    }

    private var statusText: String {
        switch app.connectivity {
        case .online: app.account?.displayHost ?? ""
        case .offline: "Offline"
        case .checking: "Connecting…"
        }
    }
}
