import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var lbStatus: String?
    @State private var lfmStatus: String?
    @State private var verifying = false
    @State private var cacheSizes: (db: Int64, art: Int64, remote: Int64) = (0, 0, 0)

    var body: some View {
        @Bindable var settings = app.settings
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Settings").textStyle(.display).foregroundStyle(Tok.fg)
                    Text("Crate \(AppInfo.version)").textStyle(.small).foregroundStyle(Tok.fgMuted)
                }

                SettingsCard(title: "Updates", symbol: "arrow.down.app") {
                    SettingsRow(title: "Crate \(AppInfo.version)", detail: updateDetail) {
                        HStack(spacing: 8) {
                            if app.updater.phase == .checking || app.updater.phase == .downloading || app.updater.phase == .installing {
                                ProgressView().controlSize(.small)
                            }
                            if app.updater.isUpdateAvailable {
                                Button("Install \(app.updater.latest?.version ?? "")") { Task { await app.updater.install() } }
                                    .buttonStyle(.crate(.primary, size: .sm))
                            } else {
                                Button("Check now") { Task { await app.updater.check(userInitiated: true) } }
                                    .buttonStyle(.crate(.secondary, size: .sm))
                                    .disabled(!app.updater.isSupported || app.updater.phase == .checking)
                            }
                        }
                    }
                    Hairline()
                    SettingsRow(title: "Check for updates automatically", detail: "Looks for a new release on GitHub at launch and every few hours. Installing always waits for you.") {
                        Toggle("", isOn: $settings.checkForUpdates).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                }

                SettingsCard(title: "Account", symbol: "server.rack") {
                    SettingsRow(title: app.account?.username ?? "", detail: app.displayHost) {
                        HStack(spacing: 8) {
                            Pill(text: connectivityLabel, hue: app.isOffline ? .amber : .green)
                            Button("Sign out") { app.logout() }.buttonStyle(.crate(.secondary, size: .sm))
                        }
                    }
                }

                SettingsCard(title: "Appearance", symbol: "circle.lefthalf.filled") {
                    SettingsRow(title: "Theme", detail: "Follow macOS or pick one.") {
                        Segmented(options: AppearanceMode.allCases.map { ($0, $0.label) }, selection: $settings.appearance)
                    }
                    Hairline()
                    SettingsRow(title: "Compact rows", detail: "Fit more songs on screen.") {
                        Toggle("", isOn: $settings.compactRows).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                }

                SettingsCard(title: "Playback", symbol: "play.circle") {
                    SettingsRow(title: "Streaming quality", detail: "Original keeps lossless files lossless and makes seeking instant. Lower settings ask Navidrome to transcode to MP3.") {
                        Picker("", selection: $settings.streamQuality) {
                            ForEach(StreamQuality.allCases) { Text($0.label).tag($0) }
                        }
                        .labelsHidden()
                        .frame(width: 140)
                    }
                    Hairline()
                    SettingsRow(title: "Prefetch octo-fiesta songs", detail: "Fetch the next songs that aren't in your library while the current one plays, so they start without a wait.") {
                        Toggle("", isOn: $settings.prefetchExternal).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                    Hairline()
                    SettingsRow(title: "Report plays to Navidrome", detail: "Updates play counts and lets Navidrome scrobble to the services it's connected to.") {
                        Toggle("", isOn: $settings.scrobble).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                    Hairline()
                    SettingsRow(title: "Show octo-fiesta results in search", detail: "Include songs and albums from your provider that aren't in the library.") {
                        Toggle("", isOn: $settings.showExternalInSearch).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                }

                SettingsCard(title: "Autoplay", symbol: "infinity") {
                    SettingsRow(title: "Keep playing when the queue ends", detail: "Crate adds songs like the ones you just heard, using Navidrome's similar songs, your ratings and what you skip.") {
                        Toggle("", isOn: $settings.autoplay).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                    Hairline()
                    SettingsRow(title: "Discovery", detail: settings.discovery.detail) {
                        Segmented(options: DiscoveryLevel.allCases.map { ($0, $0.label) }, selection: $settings.discovery)
                    }
                    .disabled(!settings.autoplay)
                    Hairline()
                    SettingsRow(title: "Include songs outside your library", detail: "Autoplay may pick songs from ListenBrainz or Last.fm that octo-fiesta fetches for you. Always on with Adventurous.") {
                        Toggle("", isOn: $settings.autoplayExternal).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                    .disabled(!settings.autoplay)
                }

                SettingsCard(title: "ListenBrainz", symbol: "waveform.path.ecg") {
                    SettingsRow(title: "User name", detail: "Weekly Jams, Weekly Exploration and Daily Jams are public, so a user name is enough.") {
                        CrateTextField(placeholder: "listenbrainz user", text: $settings.listenBrainzUser, height: 32).frame(width: 220)
                    }
                    Hairline()
                    SettingsRow(title: "User token", detail: "Optional. Enables LB Radio in autoplay and submitting listens from Crate. Find it at listenbrainz.org/settings.") {
                        HStack(spacing: 8) {
                            CrateTextField(placeholder: "token", text: $settings.listenBrainzToken, secure: true, height: 32).frame(width: 220)
                            Button("Verify") { verifyListenBrainz() }
                                .buttonStyle(.crate(.secondary, size: .sm))
                                .disabled(settings.listenBrainzToken.isEmpty || verifying)
                        }
                    }
                    if let lbStatus {
                        Text(lbStatus).textStyle(.small).foregroundStyle(lbStatus.hasPrefix("✓") ? Tok.successText : Tok.dangerText)
                            .padding(.horizontal, 16).padding(.bottom, 10)
                    }
                    Hairline()
                    SettingsRow(title: "Submit listens from Crate", detail: "Turn on if Navidrome isn't already connected to ListenBrainz, otherwise plays count twice.") {
                        Toggle("", isOn: $settings.listenBrainzScrobble).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                    }
                    .disabled(settings.listenBrainzToken.isEmpty)
                }

                SettingsCard(title: "Last.fm", symbol: "dot.radiowaves.left.and.right") {
                    SettingsRow(title: "User name", detail: "Your Last.fm profile, used for the weekly mix and discovery.") {
                        CrateTextField(placeholder: "last.fm user", text: $settings.lastFMUser, height: 32).frame(width: 220)
                    }
                    Hairline()
                    SettingsRow(title: "API key", detail: "Last.fm requires a free API key. Create one at last.fm/api/account/create.") {
                        HStack(spacing: 8) {
                            CrateTextField(placeholder: "api key", text: $settings.lastFMKey, secure: true, height: 32).frame(width: 220)
                            Button("Verify") { verifyLastFM() }
                                .buttonStyle(.crate(.secondary, size: .sm))
                                .disabled(!settings.hasLastFM || verifying)
                        }
                    }
                    if let lfmStatus {
                        Text(lfmStatus).textStyle(.small).foregroundStyle(lfmStatus.hasPrefix("✓") ? Tok.successText : Tok.dangerText)
                            .padding(.horizontal, 16).padding(.bottom, 10)
                    }
                }

                SettingsCard(title: "Library and cache", symbol: "internaldrive") {
                    SettingsRow(title: "Library index",
                                detail: "\(Format.count(app.library.songCount, "song")) · \(Format.count(app.library.albumCount, "album")) · last synced \(Format.relative(app.library.lastSync)), full index \(Format.relative(app.library.lastFullSync))") {
                        HStack(spacing: 8) {
                            Button("Sync now") { app.library.startSync() }
                                .buttonStyle(.crate(.secondary, size: .sm))
                                .disabled(app.library.isSyncing || app.isOffline)
                            Button("Rebuild") { app.library.startSync(full: true) }
                                .buttonStyle(.crate(.secondary, size: .sm))
                                .disabled(app.library.isSyncing || app.isOffline)
                        }
                    }
                    Hairline()
                    SettingsRow(title: "Keep all artwork on this Mac", detail: artworkDetail) {
                        HStack(spacing: 8) {
                            if app.artwork.isRunning { ProgressView().controlSize(.small) }
                            Toggle("", isOn: $settings.cacheAllArtwork).toggleStyle(.switch).tint(Tok.accent).labelsHidden()
                        }
                    }
                    .onChange(of: settings.cacheAllArtwork) { _, on in
                        if on { app.prefetchArtwork() } else { app.artwork.cancel() }
                    }
                    Hairline()
                    SettingsRow(title: "Artwork cache", detail: "\(Format.bytes(cacheSizes.art)) on disk.") {
                        Button("Clear") {
                            ImageCache.shared.clear()
                            refreshSizes()
                        }
                        .buttonStyle(.crate(.secondary, size: .sm))
                    }
                    Hairline()
                    SettingsRow(title: "octo-fiesta cache", detail: "\(Format.bytes(cacheSizes.remote)) of songs fetched from your provider, kept for replays (up to 3 GB).") {
                        Button("Clear") {
                            app.fetcher.clear()
                            refreshSizes()
                        }
                        .buttonStyle(.crate(.secondary, size: .sm))
                    }
                    Hairline()
                    SettingsRow(title: "Waiting for octo-fiesta",
                                detail: app.library.pendingCount == 0
                                    ? "Nothing pending. Ratings, favourites and plays on songs outside your library are applied once octo-fiesta adds them."
                                    : "\(Format.count(app.library.pendingCount, "action")) (ratings, favourites, plays) will apply once octo-fiesta has added the songs to your library.") {
                        Button("Retry now") { Task { await app.library.processPending() } }
                            .buttonStyle(.crate(.secondary, size: .sm))
                            .disabled(app.library.pendingCount == 0 || app.isOffline)
                    }
                }

                SettingsCard(title: "Downloads", symbol: "arrow.down.circle") {
                    SettingsRow(title: "Download quality", detail: "Original files, or smaller MP3s transcoded by Navidrome.") {
                        Picker("", selection: $settings.downloadQuality) {
                            ForEach(StreamQuality.allCases) { Text($0.label).tag($0) }
                        }
                        .labelsHidden()
                        .frame(width: 140)
                    }
                    Hairline()
                    SettingsRow(title: "Storage", detail: "\(Format.count(app.downloads.downloaded.count, "song")) · \(Format.bytes(app.downloads.totalBytes))") {
                        Button("Manage") { app.nav.go(.downloads) }.buttonStyle(.crate(.secondary, size: .sm))
                    }
                }

                SettingsCard(title: "Keyboard", symbol: "keyboard") {
                    VStack(alignment: .leading, spacing: 8) {
                        shortcut("Play or pause", "Space")
                        shortcut("Next / previous", "⌘→  ⌘←")
                        shortcut("Volume up / down", "⌘↑  ⌘↓")
                        shortcut("Rate the current song", "⌘1 – ⌘5, ⌘0 clears")
                        shortcut("Favourite the current song", "⌘L")
                        shortcut("Jump to anything", "⌘K")
                        shortcut("Queue", "⌘U")
                        shortcut("Back / forward", "⌘[  ⌘]")
                    }
                    .padding(16)
                }

                Text("Crate uses Inter and Outfit under the SIL Open Font License. Made for Navidrome and octo-fiesta.")
                    .textStyle(.caption)
                    .foregroundStyle(Tok.fgPlaceholder)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(Metrics.contentGutter)
            .frame(maxWidth: .infinity)
        }
        .onAppear(perform: refreshSizes)
        .onChange(of: app.settings.listenBrainzUser) { app.mixes.reset(); app.mixes.loadCached() }
    }

    private func shortcut(_ label: String, _ keys: String) -> some View {
        HStack {
            Text(label).textStyle(.small).foregroundStyle(Tok.fgSecondary)
            Spacer()
            Text(keys).textStyle(.smallStrong).foregroundStyle(Tok.fgMuted)
        }
    }

    private var updateDetail: String {
        let updater = app.updater
        guard updater.isSupported else { return "Updates are turned off for development builds." }
        switch updater.phase {
        case .checking: return "Checking GitHub for a new release…"
        case .available: return "Version \(updater.latest?.version ?? "") is available. Installing replaces this copy and reopens Crate; your library, downloads and settings stay."
        case .downloading: return "Downloading the update…"
        case .installing: return "Installing…"
        case .upToDate: return "You're on the latest version."
        case let .failed(message): return message
        case .idle: return updater.lastCheck.map { "Last checked \(Format.relative($0))." } ?? "Updates come from the project's GitHub releases."
        }
    }

    private var artworkDetail: String {
        let prefetcher = app.artwork
        if prefetcher.isRunning, prefetcher.total > 0 {
            return "Fetching covers in the background: \(prefetcher.done.formatted()) of \(prefetcher.total.formatted())."
        }
        if prefetcher.total > 0 {
            return "All \(prefetcher.total.formatted()) album and artist covers are cached, so nothing loads from the network."
        }
        return "After each sync, every album and artist cover is downloaded once so browsing never waits for the network."
    }

    private var connectivityLabel: String {
        switch app.connectivity {
        case .online: "Connected"
        case .offline: "Offline"
        case .checking: "Connecting"
        }
    }

    private func refreshSizes() {
        let db = app.library.db?.fileSize ?? 0
        let remote = app.fetcher.diskUsage
        Task.detached(priority: .utility) {
            let art = ImageCache.shared.diskUsage
            await MainActor.run { cacheSizes = (db, art, remote) }
        }
    }

    private func verifyListenBrainz() {
        verifying = true
        Task {
            if let user = await ListenBrainzService().validate(token: app.settings.listenBrainzToken) {
                lbStatus = "✓ Token belongs to \(user)."
                if app.settings.listenBrainzUser.isEmpty { app.settings.listenBrainzUser = user }
            } else {
                lbStatus = "That token wasn't accepted by ListenBrainz."
            }
            verifying = false
            await app.mixes.refresh(force: false)
        }
    }

    private func verifyLastFM() {
        verifying = true
        Task {
            let ok = await LastFMService().validate(user: app.settings.lastFMUser, key: app.settings.lastFMKey)
            lfmStatus = ok ? "✓ Connected to Last.fm." : "Last.fm didn't accept this user name and API key."
            verifying = false
            if ok { await app.mixes.refresh(force: false) }
        }
    }
}

struct SettingsCard<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 13, weight: .medium)).foregroundStyle(Tok.icon)
                Text(title).textStyle(.title).foregroundStyle(Tok.fg)
            }
            VStack(alignment: .leading, spacing: 0) {
                content()
            }
            .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .hairline(Radius.card)
        }
    }
}

struct SettingsRow<Control: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let control: () -> Control

    var body: some View {
        HStack(alignment: .center, spacing: 20) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).textStyle(.bodyStrong).foregroundStyle(Tok.fg)
                Text(detail).textStyle(.small).foregroundStyle(Tok.fgMuted).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            control()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }
}
