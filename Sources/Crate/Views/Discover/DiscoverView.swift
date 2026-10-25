import SwiftUI

struct DiscoverView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let store = app.mixes
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Discover").textStyle(.display).foregroundStyle(Tok.fg)
                        Text("Weekly recommendations and mixes from your library. Songs you don't have yet play through octo-fiesta.")
                            .textStyle(.small)
                            .foregroundStyle(Tok.fgMuted)
                    }
                    Spacer()
                    Button {
                        Task { await store.refresh(force: true) }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.crate(.secondary, size: .sm))
                    .disabled(!store.refreshing.isEmpty || app.isOffline)
                }

                SourceSection(
                    title: "ListenBrainz",
                    symbol: "waveform.path.ecg",
                    configured: app.settings.hasListenBrainz,
                    refreshing: store.refreshing.contains(.listenBrainz),
                    error: store.errors[.listenBrainz],
                    mixes: store.mixes(for: .listenBrainz),
                    setupText: "Add your ListenBrainz user name in Settings to get Weekly Jams, Weekly Exploration and Daily Jams."
                )
                SourceSection(
                    title: "Last.fm",
                    symbol: "dot.radiowaves.left.and.right",
                    configured: app.settings.hasLastFM,
                    refreshing: store.refreshing.contains(.lastFM),
                    error: store.errors[.lastFM],
                    mixes: store.mixes(for: .lastFM),
                    setupText: "Add your Last.fm user name and an API key in Settings for a weekly mix and artist discovery."
                )
                SourceSection(
                    title: "From your library",
                    symbol: "square.stack.3d.up",
                    configured: true,
                    refreshing: false,
                    error: nil,
                    mixes: store.mixes(for: .library),
                    setupText: "Mixes appear once your library is indexed."
                )
            }
            .padding(Metrics.contentGutter)
        }
        .task { app.mixes.refreshIfStale() }
    }
}

private struct SourceSection: View {
    @Environment(AppModel.self) private var app
    let title: String
    let symbol: String
    let configured: Bool
    let refreshing: Bool
    let error: String?
    let mixes: [Mix]
    let setupText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(Tok.icon)
                Text(title).textStyle(.title).foregroundStyle(Tok.fg)
                if refreshing {
                    ProgressView().controlSize(.mini)
                }
                Spacer()
            }
            if let error {
                Callout(kind: .warning, message: error)
            }
            if !configured {
                HStack {
                    Text(setupText).textStyle(.small).foregroundStyle(Tok.fgMuted)
                    Spacer()
                    Button("Open settings") { app.nav.go(.settings) }
                        .buttonStyle(.crate(.secondary, size: .sm))
                }
                .padding(14)
                .background(Tok.surfaceMuted, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .hairline(Radius.card)
            } else if mixes.isEmpty {
                if refreshing {
                    HStack(spacing: 18) {
                        ForEach(0..<4, id: \.self) { _ in
                            VStack(alignment: .leading, spacing: 8) {
                                Skeleton(width: 168, height: 168, radius: Radius.card)
                                Skeleton(width: 110, height: 11)
                                Skeleton(width: 70, height: 9)
                            }
                        }
                    }
                } else {
                    Text(setupText).textStyle(.small).foregroundStyle(Tok.fgMuted)
                }
            } else {
                Carousel(items: mixes) { MixCard(mix: $0) }
            }
        }
    }
}

struct MixDetailView: View {
    @Environment(AppModel.self) private var app
    let mixId: String
    @State private var selection: Set<Int> = []
    @State private var showMissing = false
    @State private var saving = false

    var body: some View {
        if let mix = app.mixes.mix(id: mixId) {
            let playable = mix.playable
            let missing = mix.entries.filter { $0.state == .missing }
            let external = mix.entries.filter { $0.state == .external }.count
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    DetailHero(
                        kind: sourceLabel(mix.source),
                        title: mix.title,
                        subtitle: AnyView(Text(mix.detail).textStyle(.small).foregroundStyle(Tok.fgSecondary).frame(maxWidth: 520, alignment: .leading)),
                        meta: meta(mix, external: external, missing: missing.count),
                        cover: { MixCover(mix: mix, size: 184) },
                        actions: {
                            Button {
                                app.player.play(playable, shuffled: false, context: "mix:\(mix.id)")
                            } label: { Label("Play", systemImage: "play.fill") }
                                .buttonStyle(.crate(.primary))
                                .disabled(playable.isEmpty)
                            Button {
                                app.player.play(playable, shuffled: true, context: "mix:\(mix.id)")
                            } label: { Label("Shuffle", systemImage: "shuffle") }
                                .buttonStyle(.crate(.secondary))
                                .disabled(playable.isEmpty)
                            Button {
                                saving = true
                                Task {
                                    if let playlist = await app.mixes.saveAsPlaylist(mix) {
                                        app.toasts.show("Saved as “\(playlist.displayName)”.")
                                    }
                                    saving = false
                                }
                            } label: { Label(saving ? "Saving…" : "Save as playlist", systemImage: "plus") }
                                .buttonStyle(.crate(.secondary))
                                .disabled(playable.isEmpty || saving)
                            let offline = app.downloads.isOffline(.mix, mix.id)
                            IconActionButton(symbol: offline ? "arrow.down.circle.fill" : "arrow.down.circle",
                                             help: offline ? "Remove download" : "Download for offline", active: offline) {
                                app.downloads.toggleOffline(.mix, id: mix.id, name: mix.title, tracks: playable)
                            }
                        }
                    )
                    if mix.pendingCount > 0 {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.mini)
                            Text("Matching songs to your library and octo-fiesta… \(mix.entries.count - mix.pendingCount) of \(mix.entries.count)")
                                .textStyle(.small, tabular: true)
                                .foregroundStyle(Tok.fgMuted)
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                        .padding(.bottom, 12)
                    }
                    TrackRows(tracks: playable, context: "mix:\(mix.id)", selection: $selection)
                        .padding(.horizontal, Metrics.contentGutter - 12)
                    if !missing.isEmpty {
                        Button {
                            withAnimation(Motion.base) { showMissing.toggle() }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: showMissing ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
                                Text("Not found (\(missing.count))").textStyle(.smallStrong)
                            }
                            .foregroundStyle(Tok.fgMuted)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal, Metrics.contentGutter)
                        .padding(.top, 20)
                        .padding(.bottom, 8)
                        if showMissing {
                            ForEach(missing) { entry in
                                HStack(spacing: 12) {
                                    Artwork(coverArt: nil, url: entry.artworkURL, size: 32, radius: 6)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(entry.title).textStyle(.smallStrong).foregroundStyle(Tok.fgMuted)
                                        Text(entry.artist).textStyle(.caption).foregroundStyle(Tok.fgPlaceholder)
                                    }
                                    Spacer()
                                }
                                .padding(.horizontal, Metrics.contentGutter)
                                .frame(height: 44)
                            }
                        }
                    }
                    Color.clear.frame(height: 32)
                }
            }
            .pageTitle(mix.title)
            .task { await app.mixes.resolve(mix.id) }
        } else {
            EmptyState(symbol: "sparkles", title: "Mix not found", message: "It may have been replaced by a newer one.")
                .pageTitle("Mix")
        }
    }

    private func sourceLabel(_ source: Mix.Source) -> String {
        switch source {
        case .listenBrainz: "ListenBrainz mix"
        case .lastFM: "Last.fm mix"
        case .library: "Library mix"
        }
    }

    private func meta(_ mix: Mix, external: Int, missing: Int) -> String {
        var parts = [Format.count(mix.entries.count, "song")]
        let local = mix.entries.filter { $0.state == .library }.count
        if mix.source != .library {
            parts.append("\(local) in your library")
            if external > 0 { parts.append("\(external) via octo-fiesta") }
            if missing > 0 { parts.append("\(missing) not found") }
        }
        let seconds = mix.playable.reduce(0) { $0 + $1.duration }
        if seconds > 0 { parts.append(Format.longDuration(seconds)) }
        return parts.joined(separator: " · ")
    }
}

/// Outlined square icon button that sits next to Play and Shuffle in heroes.
struct IconActionButton: View {
    let symbol: String
    var help: String
    var active = false
    var activeTint: Color = Tok.accent
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(active ? activeTint : Tok.iconStrong)
                .frame(width: 20)
        }
        .buttonStyle(.crate(.secondary))
        .help(help)
    }
}
