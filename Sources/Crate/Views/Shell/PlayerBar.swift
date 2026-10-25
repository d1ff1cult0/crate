import AVKit
import SwiftUI

struct PlayerBar: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 16) {
            NowPlayingInfo()
                .frame(width: 300, alignment: .leading)
            Spacer(minLength: 8)
            TransportControls()
                .frame(maxWidth: 560)
            Spacer(minLength: 8)
            PlayerExtras()
                .frame(width: 300, alignment: .trailing)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 2)
    }
}

private struct NowPlayingInfo: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let item = app.player.current {
            let track = item.track
            HStack(spacing: 12) {
                Button {
                    app.openAlbum(track.albumId)
                } label: {
                    Artwork(coverArt: app.library.cover(for: track), url: track.artworkURL, size: 48, radius: 8)
                }
                .buttonStyle(.plain)
                .help("Go to album")
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(track.title).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                        if track.isExternal { ExternalPill(provider: track.provider).scaleEffect(0.9) }
                    }
                    Button {
                        app.openArtist(track)
                    } label: {
                        Text(track.artist).textStyle(.small).foregroundStyle(Tok.fgMuted).lineLimit(1)
                    }
                    .buttonStyle(.plain)
                }
                HeartButton(isOn: app.library.isStarred(track)) { app.library.toggleStar(track) }
                Spacer(minLength: 0)
            }
        } else {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Tok.sidebarActive)
                    .frame(width: 48, height: 48)
                    .overlay(Image(systemName: "music.note").foregroundStyle(Tok.fgDisabled))
                Text("Nothing playing").textStyle(.small).foregroundStyle(Tok.fgPlaceholder)
            }
        }
    }
}

private struct TransportControls: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let player = app.player
        VStack(spacing: 4) {
            HStack(spacing: 14) {
                IconButton(symbol: "shuffle", help: "Shuffle (⌘S)", size: 30, iconSize: 13, active: player.shuffle) {
                    player.toggleShuffle()
                }
                IconButton(symbol: "backward.fill", help: "Previous (⌘←)", size: 32, iconSize: 14, tint: Tok.iconStrong) {
                    player.previous()
                }
                PlayPauseButton()
                IconButton(symbol: "forward.fill", help: "Next (⌘→)", size: 32, iconSize: 14, tint: Tok.iconStrong) {
                    player.next()
                }
                IconButton(symbol: player.repeatMode == .one ? "repeat.1" : "repeat", help: repeatHelp, size: 30, iconSize: 13,
                           active: player.repeatMode != .off) {
                    player.cycleRepeat()
                }
            }
            ProgressRow()
        }
    }

    private var repeatHelp: String {
        switch app.player.repeatMode {
        case .off: "Repeat (⌘R)"
        case .all: "Repeating the queue"
        case .one: "Repeating this song"
        }
    }
}

private struct PlayPauseButton: View {
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    var body: some View {
        let player = app.player
        Button {
            player.togglePlayPause()
        } label: {
            ZStack {
                Circle().fill(hovering ? Tok.primaryHover : Tok.primary)
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Tok.onPrimary)
                        .colorInvert()
                        .opacity(0.9)
                } else {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Tok.onPrimary)
                        .offset(x: player.isPlaying ? 0 : 1)
                }
            }
            .frame(width: 36, height: 36)
            .scaleEffect(hovering ? 1.04 : 1)
        }
        .buttonStyle(.plain)
        .help(player.isPlaying ? "Pause (Space)" : "Play (Space)")
        .onHover { hovering = $0 }
        .animation(Motion.fast, value: hovering)
    }

    private var busy: Bool {
        switch app.player.status {
        case .loading, .fetching: app.player.isPlaying
        default: false
        }
    }
}

private struct ProgressRow: View {
    @Environment(AppModel.self) private var app
    @State private var scrubValue: Double?

    var body: some View {
        let player = app.player
        let time = scrubValue ?? player.clock.time
        HStack(spacing: 10) {
            Text(Format.clock(time))
                .textStyle(.caption, tabular: true)
                .foregroundStyle(Tok.fgMuted)
                .frame(width: 40, alignment: .trailing)
            if case let .fetching(provider) = player.status {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("octo-fiesta is fetching this song from \(provider)…")
                        .textStyle(.caption)
                        .foregroundStyle(Tok.fgMuted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 14)
            } else {
                CrateSlider(value: time, range: 0...max(player.duration, 1)) { scrubbing in
                    scrubValue = scrubbing
                } onCommit: { value in
                    scrubValue = nil
                    player.seek(to: value)
                }
                .disabled(player.current == nil)
            }
            Text(Format.clock(player.duration))
                .textStyle(.caption, tabular: true)
                .foregroundStyle(Tok.fgMuted)
                .frame(width: 40, alignment: .leading)
        }
    }
}

private struct PlayerExtras: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 10) {
            if let track = app.player.current?.track {
                StarRating(rating: app.library.rating(of: track), size: 11) { app.library.setRating(track, $0) }
            }
            IconButton(symbol: "quote.bubble", help: "Lyrics (⌥⌘L)", size: 30, iconSize: 13, active: app.showLyrics) {
                app.showLyrics.toggle()
            }
            IconButton(symbol: "list.bullet", help: "Queue (⌘U)", size: 30, iconSize: 13, active: app.showQueue) {
                app.showQueue.toggle()
            }
            VolumeControl()
            RoutePicker()
                .frame(width: 26, height: 26)
                .help("AirPlay and output devices")
        }
    }
}

private struct VolumeControl: View {
    @Environment(AppModel.self) private var app
    @State private var lastNonZero: Double = 0.8

    var body: some View {
        let player = app.player
        HStack(spacing: 6) {
            IconButton(symbol: volumeSymbol, help: player.volume == 0 ? "Unmute" : "Mute", size: 26, iconSize: 13) {
                if player.volume > 0 {
                    lastNonZero = player.volume
                    player.volume = 0
                } else {
                    player.volume = lastNonZero
                }
            }
            CrateSlider(value: player.volume, range: 0...1) { value in
                if let value { player.volume = value }
            } onCommit: { value in
                player.volume = value
            }
            .frame(width: 84)
        }
    }

    private var volumeSymbol: String {
        let v = app.player.volume
        if v == 0 { return "speaker.slash.fill" }
        if v < 0.34 { return "speaker.wave.1.fill" }
        if v < 0.67 { return "speaker.wave.2.fill" }
        return "speaker.wave.3.fill"
    }
}

/// Dopl-styled slider: a 4 pt track that thickens on hover, with the knob shown only on
/// hover or while dragging.
struct CrateSlider: View {
    let value: Double
    let range: ClosedRange<Double>
    var onScrub: (Double?) -> Void
    var onCommit: (Double) -> Void
    @State private var hovering = false
    @State private var dragging = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        GeometryReader { geo in
            let span = range.upperBound - range.lowerBound
            let fraction = span > 0 ? min(max((value - range.lowerBound) / span, 0), 1) : 0
            let active = (hovering || dragging) && isEnabled
            ZStack(alignment: .leading) {
                Capsule().fill(Tok.borderStrong).frame(height: active ? 5 : 4)
                Capsule().fill(active ? Tok.accent : Tok.fgSecondary).frame(width: max(0, geo.size.width * fraction), height: active ? 5 : 4)
                Circle()
                    .fill(Tok.surfaceRaised)
                    .overlay(Circle().strokeBorder(Tok.borderStrong, lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
                    .frame(width: 12, height: 12)
                    .offset(x: max(0, min(geo.size.width - 12, geo.size.width * fraction - 6)))
                    .opacity(active ? 1 : 0)
            }
            .frame(height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        guard isEnabled else { return }
                        dragging = true
                        let f = min(max(g.location.x / max(geo.size.width, 1), 0), 1)
                        onScrub(range.lowerBound + f * span)
                    }
                    .onEnded { g in
                        guard isEnabled else { return }
                        dragging = false
                        let f = min(max(g.location.x / max(geo.size.width, 1), 0), 1)
                        onCommit(range.lowerBound + f * span)
                    }
            )
            .onHover { hovering = $0 }
            .animation(Motion.fast, value: active)
        }
        .frame(height: 14)
    }
}

struct RoutePicker: NSViewRepresentable {
    func makeNSView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.isRoutePickerButtonBordered = false
        return view
    }

    func updateNSView(_ nsView: AVRoutePickerView, context: Context) {}
}
