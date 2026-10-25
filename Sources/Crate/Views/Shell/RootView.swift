import SwiftUI

struct PageTitleKey: PreferenceKey {
    static let defaultValue: String? = nil
    static func reduce(value: inout String?, nextValue: () -> String?) {
        value = nextValue() ?? value
    }
}

extension View {
    /// The title shown after the section name in the panel header breadcrumb.
    func pageTitle(_ title: String?) -> some View {
        preference(key: PageTitleKey.self, value: title)
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                Tok.canvas
            case .loggedOut:
                LoginView()
            case .ready:
                MainShell()
            }
        }
        .frame(minWidth: 1000, minHeight: 660)
        .background(Tok.canvas)
        .ignoresSafeArea()
    }
}

struct MainShell: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var settings = app.settings
        ZStack(alignment: .bottomLeading) {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Sidebar()
                        .frame(width: settings.sidebarWidth)
                        .overlay(alignment: .trailing) {
                            ResizeHandle(width: $settings.sidebarWidth, range: SettingsStore.sidebarRange,
                                         defaultWidth: SettingsStore.defaultSidebarWidth, edge: .trailing)
                                .offset(x: 5)
                        }
                        .zIndex(1)
                    MainPanel()
                        .padding(.top, Metrics.panelInset)
                        .padding(.trailing, Metrics.panelInset)
                }
                PlayerBar()
                    .frame(height: Metrics.playerHeight)
            }
            ToastOverlay()
                .padding(.leading, settings.sidebarWidth + 12)
                .padding(.bottom, Metrics.playerHeight + 12)
            if app.showPalette {
                CommandPalette()
                    .transition(.opacity)
            }
        }
        .background(Tok.canvas)
        .animation(Motion.base, value: app.showPalette)
        .onChange(of: app.nav.current) { app.showPalette = false }
    }
}

struct MainPanel: View {
    @Environment(AppModel.self) private var app
    @State private var pageTitle: String?

    var body: some View {
        @Bindable var settings = app.settings
        VStack(spacing: 0) {
            PanelHeader(pageTitle: app.nav.stack.isEmpty ? nil : pageTitle)
            Hairline()
            ZStack(alignment: .trailing) {
                PageContainer()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                if app.showLyrics {
                    LyricsView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Tok.surface)
                        .transition(.opacity)
                }
                if app.showQueue {
                    QueuePanel()
                        .frame(width: settings.queueWidth)
                        .frame(maxHeight: .infinity)
                        .background(Tok.surface)
                        .overlay(alignment: .leading) { Hairline(vertical: true) }
                        .overlay(alignment: .leading) {
                            ResizeHandle(width: $settings.queueWidth, range: SettingsStore.queueRange,
                                         defaultWidth: SettingsStore.defaultQueueWidth, edge: .leading)
                                .offset(x: -4)
                        }
                        .shadow(color: .black.opacity(0.08), radius: 16, x: -6, y: 0)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .clipped()
        }
        .background(Tok.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Tok.border, lineWidth: 1))
        .onPreferenceChange(PageTitleKey.self) { pageTitle = $0 }
        .animation(Motion.slow, value: app.showQueue)
        .animation(Motion.base, value: app.showLyrics)
        .onChange(of: app.nav.current) { app.showLyrics = false }
    }
}

struct PageContainer: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ZStack {
            // The section stays alive under detail pages so going back keeps its scroll position.
            rootView(app.nav.root)
                .opacity(app.nav.stack.isEmpty ? 1 : 0)
                .allowsHitTesting(app.nav.stack.isEmpty)
                .accessibilityHidden(!app.nav.stack.isEmpty)
            if let top = app.nav.stack.last {
                detailView(top)
                    .id(top)
                    .background(Tok.surface)
            }
        }
    }

    @ViewBuilder
    private func rootView(_ route: Route) -> some View {
        switch route {
        case .home: HomeView()
        case .discover: DiscoverView()
        case .albums: AlbumsView()
        case .artists: ArtistsView()
        case .songs: SongsView()
        case .genres: GenresView()
        case .playlists: PlaylistsView()
        case .favourites: FavouritesView()
        case .downloads: DownloadsView()
        case .settings: SettingsView()
        default: EmptyView()
        }
    }

    @ViewBuilder
    private func detailView(_ route: Route) -> some View {
        switch route {
        case let .album(id): AlbumDetailView(albumId: id)
        case let .artist(id): ArtistDetailView(artistId: id)
        case let .playlist(id): PlaylistDetailView(playlistId: id)
        case let .genre(name): GenreDetailView(genre: name)
        case let .mix(id): MixDetailView(mixId: id)
        case let .search(query): SearchView(query: query)
        default: rootView(route)
        }
    }
}

struct PanelHeader: View {
    @Environment(AppModel.self) private var app
    let pageTitle: String?

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) {
                IconButton(symbol: "chevron.left", help: "Back (⌘[)") { app.nav.back() }
                    .disabled(!app.nav.canGoBack)
                    .opacity(app.nav.canGoBack ? 1 : 0.35)
                IconButton(symbol: "chevron.right", help: "Forward (⌘])") { app.nav.forward() }
                    .disabled(!app.nav.canGoForward)
                    .opacity(app.nav.canGoForward ? 1 : 0.35)
            }
            if app.showLyrics {
                HStack(spacing: 8) {
                    Image(systemName: "quote.bubble").font(.system(size: 14, weight: .medium)).foregroundStyle(Tok.icon)
                    Text("Lyrics").textStyle(.nav).foregroundStyle(Tok.fg)
                }
            } else {
            HStack(spacing: 8) {
                Image(systemName: isSearch ? "magnifyingglass" : app.nav.root.symbol)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Tok.icon)
                if let pageTitle, !app.nav.stack.isEmpty {
                    Button {
                        app.nav.go(app.nav.root)
                    } label: {
                        Text(sectionTitle).textStyle(.nav).foregroundStyle(Tok.fgMuted)
                    }
                    .buttonStyle(.plain)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Tok.fgDisabled)
                    Text(pageTitle).textStyle(.nav).foregroundStyle(Tok.fg).lineLimit(1)
                } else {
                    Text(sectionTitle).textStyle(.nav).foregroundStyle(Tok.fg)
                }
            }
            }
            Spacer(minLength: 12)
            SyncStatusView()
            if app.isOffline {
                Pill(text: "Offline", hue: .amber, symbol: "wifi.slash")
                    .help("Crate can't reach your server. Downloaded songs still play.")
            }
            IconButton(symbol: "list.bullet", help: "Queue (⌘U)", active: app.showQueue) {
                app.showQueue.toggle()
            }
        }
        .padding(.horizontal, 14)
        .frame(height: Metrics.headerHeight)
        .background(WindowDragArea())
    }

    private var isSearch: Bool {
        if case .search = app.nav.stack.last { return true }
        return false
    }

    private var sectionTitle: String {
        if app.nav.stack.isEmpty { return app.nav.root.title }
        if case .search = app.nav.stack.last { return "Search" }
        return app.nav.root.title
    }
}

struct SyncStatusView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        switch app.library.syncPhase {
        case let .syncing(message, progress):
            HStack(spacing: 8) {
                if let progress, progress > 0 {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .tint(Tok.accent)
                        .frame(width: 64)
                } else {
                    ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 14, height: 14)
                }
                Text(message).textStyle(.caption, tabular: true).foregroundStyle(Tok.fgMuted).lineLimit(1)
            }
            .transition(.opacity)
        case let .failed(message):
            Button {
                app.library.startSync()
            } label: {
                Pill(text: "Sync failed · Retry", hue: .red, symbol: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .help(message)
        case .idle:
            EmptyView()
        }
    }
}

struct ToastOverlay: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(app.toasts.toasts) { toast in
                HStack(alignment: .top, spacing: 10) {
                    Text(toast.message)
                        .textStyle(.small)
                        .foregroundStyle(Tok.fg)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button {
                        app.toasts.dismiss(toast.id)
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Tok.fgMuted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(width: 360, alignment: .leading)
                .background(Tok.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .hairline(Radius.card)
                .popoverShadow()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}
