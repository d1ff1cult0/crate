import SwiftUI

/// Full-panel lyrics for the current song. Synced lyrics follow playback, keep the current
/// line centred and jump there when clicked; plain lyrics scroll freely.
struct LyricsView: View {
    @Environment(AppModel.self) private var app
    @State private var lyrics: Lyrics?
    @State private var loading = false
    @State private var loadedFor: String?

    var body: some View {
        if let track = app.player.current?.track {
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    Artwork(coverArt: app.library.cover(for: track), url: track.artworkURL, size: 48, radius: 8)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).textStyle(.bodyStrong).foregroundStyle(Tok.fg).lineLimit(1)
                        Text(track.artist).textStyle(.small).foregroundStyle(Tok.fgMuted).lineLimit(1)
                    }
                    Spacer()
                    if let lyrics {
                        Pill(text: lyrics.synced ? "Synced" : "Not synced", hue: lyrics.synced ? .blue : .grey,
                             symbol: lyrics.synced ? "waveform" : nil)
                        Text(lyrics.source).textStyle(.caption).foregroundStyle(Tok.fgPlaceholder)
                    }
                    IconButton(symbol: "xmark", help: "Close lyrics (⌥⌘L)") { app.showLyrics = false }
                }
                .padding(.horizontal, Metrics.contentGutter)
                .padding(.vertical, 16)
                Hairline()
                Group {
                    if loading && lyrics == nil {
                        VStack(alignment: .leading, spacing: 22) {
                            ForEach(0..<7, id: \.self) { i in
                                Skeleton(width: CGFloat(220 + (i * 67) % 260), height: 22, radius: 8)
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                        .padding(48)
                    } else if let lyrics {
                        if lyrics.synced {
                            SyncedLyrics(lines: lyrics.lines)
                        } else {
                            PlainLyrics(lines: lyrics.lines)
                        }
                    } else {
                        EmptyState(symbol: "quote.bubble", title: "No lyrics for this song",
                                   message: "Neither your server nor LRCLIB has lyrics for “\(track.title)”.")
                            .frame(maxHeight: .infinity)
                    }
                }
            }
            .task(id: track.id) { await load(track) }
        } else {
            EmptyState(symbol: "quote.bubble", title: "Nothing playing", message: "Lyrics appear here for the song that's playing.")
                .frame(maxHeight: .infinity)
        }
    }

    private func load(_ track: Track) async {
        guard loadedFor != track.id else { return }
        loadedFor = track.id
        if let cached = app.lyrics.cached(track) {
            lyrics = cached
        } else {
            lyrics = nil
            loading = true
            let result = await app.lyrics.lyrics(for: track)
            guard app.player.current?.track.id == track.id else { return }
            lyrics = result
            loading = false
        }
        // Have the next song's lyrics ready when it starts.
        app.lyrics.prefetch(app.player.upcoming.first?.track)
    }
}

private struct SyncedLyrics: View {
    @Environment(AppModel.self) private var app
    let lines: [LyricLine]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let time = app.player.preciseTime()
            // Lines switch slightly early so the highlight lands as the singer does.
            let current = lines.lastIndex { ($0.start ?? 0) <= time + 0.2 }
            LyricLines(lines: lines, current: current) { line in
                if let start = line.start {
                    app.player.seek(to: start)
                    if !app.player.isPlaying { app.player.resume() }
                }
            }
        }
    }
}

private struct LyricLines: View {
    let lines: [LyricLine]
    let current: Int?
    let onTap: (LyricLine) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Color.clear.frame(height: 120)
                    ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                        LyricLineText(text: line.text, state: state(index))
                            .id(line.id)
                            .onTapGesture { onTap(line) }
                    }
                    Color.clear.frame(height: 240)
                }
                .padding(.horizontal, 48)
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.never)
            .onChange(of: current) { _, new in
                guard let new, lines.indices.contains(new) else { return }
                withAnimation(.timingCurve(0.2, 0, 0, 1, duration: 0.45)) {
                    proxy.scrollTo(lines[new].id, anchor: UnitPoint(x: 0, y: 0.38))
                }
            }
            .onAppear {
                if let current, lines.indices.contains(current) {
                    proxy.scrollTo(lines[current].id, anchor: UnitPoint(x: 0, y: 0.38))
                }
            }
        }
    }

    private func state(_ index: Int) -> LyricLineText.State {
        guard let current else { return .upcoming }
        if index == current { return .current }
        return index < current ? .past : .upcoming
    }
}

private struct LyricLineText: View {
    enum State { case past, current, upcoming }
    let text: String
    let state: State
    @SwiftUI.State private var hovering = false

    var body: some View {
        Text(text.isEmpty ? "♪" : text)
            .font(CrateFonts.font(size: 28, weight: .semibold))
            .tracking(-0.4)
            .lineSpacing(4)
            .foregroundStyle(color)
            .scaleEffect(state == .current ? 1 : 0.985, anchor: .leading)
            .animation(.easeOut(duration: 0.25), value: state)
            .fixedSize(horizontal: false, vertical: true)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }

    private var color: Color {
        switch state {
        case .current: Tok.fg
        case .past: hovering ? Tok.fgSecondary : Tok.fgDisabled
        case .upcoming: hovering ? Tok.fgSecondary : Tok.fgMuted.opacity(0.75)
        }
    }
}

private struct PlainLyrics: View {
    let lines: [LyricLine]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(lines) { line in
                    let isSection = line.text.hasPrefix("[") && line.text.hasSuffix("]")
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(CrateFonts.font(size: isSection ? 14 : 22, weight: isSection ? .semibold : .medium))
                        .foregroundStyle(isSection ? Tok.fgMuted : Tok.fg)
                        .padding(.top, isSection ? 14 : 0)
                        .textSelection(.enabled)
                }
            }
            .padding(48)
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
