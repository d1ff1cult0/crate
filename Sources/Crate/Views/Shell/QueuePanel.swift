import SwiftUI

struct QueuePanel: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let player = app.player
        let upcoming = Array(player.upcoming)
        let chosen = upcoming.filter { !$0.fromAutoplay }
        let auto = upcoming.filter(\.fromAutoplay)

        VStack(spacing: 0) {
            HStack {
                Text("Queue").textStyle(.title).foregroundStyle(Tok.fg)
                Spacer()
                if !upcoming.isEmpty {
                    Button("Clear") { player.clearUpcoming() }
                        .buttonStyle(.crate(.ghost, size: .xs))
                }
                IconButton(symbol: "xmark", help: "Close") { app.showQueue = false }
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            Hairline()

            List {
                if let current = player.current {
                    Section {
                        QueueRow(item: current, isCurrent: true)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                    } header: {
                        QueueHeader(title: "Now playing", detail: player.radioName.map { "\($0) radio" })
                    }
                }
                if !chosen.isEmpty {
                    Section {
                        ForEach(chosen) { item in
                            QueueRow(item: item, isCurrent: false)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                        }
                        .onMove { source, destination in
                            player.moveUpcoming(fromOffsets: source, toOffset: destination)
                        }
                    } header: {
                        QueueHeader(title: "Up next", detail: Format.count(chosen.count, "song"))
                    }
                }
                Section {
                    if app.settings.autoplay {
                        ForEach(auto) { item in
                            QueueRow(item: item, isCurrent: false)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                        }
                        .onMove { source, destination in
                            let offset = chosen.count
                            player.moveUpcoming(fromOffsets: IndexSet(source.map { $0 + offset }), toOffset: destination + offset)
                        }
                        if player.isExtendingAutoplay {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.mini)
                                Text("Finding songs that fit…").textStyle(.small).foregroundStyle(Tok.fgMuted)
                            }
                            .padding(.vertical, 8)
                            .padding(.horizontal, 10)
                            .listRowSeparator(.hidden)
                        } else if auto.isEmpty {
                            Text("When the queue ends, Crate keeps playing songs like the ones you just heard.")
                                .textStyle(.small)
                                .foregroundStyle(Tok.fgMuted)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .listRowSeparator(.hidden)
                        }
                    }
                } header: {
                    AutoplayHeader()
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 1)
        }
    }
}

private struct QueueHeader: View {
    let title: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).textStyle(.captionStrong).foregroundStyle(Tok.fgMuted)
            if let detail {
                Text("· \(detail)").textStyle(.caption).foregroundStyle(Tok.fgPlaceholder)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.top, 12)
        .padding(.bottom, 2)
    }
}

private struct AutoplayHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var settings = app.settings
        HStack(spacing: 6) {
            Image(systemName: "infinity")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(app.settings.autoplay ? Tok.accent : Tok.fgMuted)
            Text("Autoplay").textStyle(.captionStrong).foregroundStyle(Tok.fgMuted)
            Text("· \(app.settings.discovery.label)").textStyle(.caption).foregroundStyle(Tok.fgPlaceholder)
            Spacer()
            Toggle("", isOn: $settings.autoplay)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .tint(Tok.accent)
                .labelsHidden()
        }
        .padding(.horizontal, 10)
        .padding(.top, 14)
        .padding(.bottom, 2)
    }
}

private struct QueueRow: View {
    @Environment(AppModel.self) private var app
    let item: QueueItem
    let isCurrent: Bool
    @State private var hovering = false

    var body: some View {
        let track = item.track
        HStack(spacing: 10) {
            ZStack {
                Artwork(coverArt: app.library.cover(for: track), url: track.artworkURL, size: 36, radius: 6)
                if isCurrent {
                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.black.opacity(0.35)).frame(width: 36, height: 36)
                    NowPlayingBars(animating: app.player.isPlaying, color: .white, height: 12)
                }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(track.title)
                    .textStyle(.smallStrong)
                    .foregroundStyle(isCurrent ? Tok.accentText : Tok.fg)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if item.fromAutoplay {
                        Image(systemName: "infinity").font(.system(size: 9, weight: .bold)).foregroundStyle(Tok.fgPlaceholder)
                    }
                    if track.isExternal {
                        Image(systemName: app.fetcher.cachedFile(for: track.id) != nil ? "checkmark.circle" : "arrow.down.forward")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(TagHue.purple.text)
                            .help(app.fetcher.cachedFile(for: track.id) != nil ? "Fetched from \(track.provider ?? "provider")" : "Fetched from \(track.provider ?? "provider") when it plays")
                    }
                    Text(track.artist).textStyle(.caption).foregroundStyle(Tok.fgMuted).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if app.fetcher.isFetching(track.id) {
                ProgressView().controlSize(.mini)
            }
            if hovering, !isCurrent {
                IconButton(symbol: "xmark", help: "Remove from queue", size: 22, iconSize: 10) {
                    app.player.remove(item.id)
                }
            } else {
                Text(track.durationText).textStyle(.caption, tabular: true).foregroundStyle(Tok.fgPlaceholder)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 50)
        .background(
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .fill(hovering ? Tok.surfaceHover : .clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(count: 2) {
            if !isCurrent { app.player.jump(to: item.id) }
        }
        .contextMenu {
            if !isCurrent {
                Button("Play now") { app.player.jump(to: item.id) }
                Button("Remove from queue") { app.player.remove(item.id) }
                Divider()
            }
            TrackMenuItems(tracks: [track])
        }
    }
}
