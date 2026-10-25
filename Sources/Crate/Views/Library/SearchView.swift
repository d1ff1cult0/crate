import SwiftUI

/// Full search: the library index instantly, then the server's search3, which octo-fiesta
/// extends with results from its providers.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    let query: String
    @State private var text: String = ""
    @State private var local = SearchResults()
    @State private var remote: SearchResults?
    @State private var searching = false
    @State private var selection: Set<Int> = []
    @State private var task: Task<Void, Never>?

    var body: some View {
        let results = merged
        VStack(spacing: 0) {
        PageToolbar {
            CrateTextField(placeholder: "Search songs, albums and artists", text: $text, icon: "magnifyingglass", height: 32) {
                run()
            }
            .frame(maxWidth: 420)
            if searching { ProgressView().controlSize(.small) }
            Spacer()
            if !results.isEmpty {
                Text([results.songs.isEmpty ? nil : Format.count(results.songs.count, "song"),
                      results.albums.isEmpty ? nil : Format.count(results.albums.count, "album"),
                      results.artists.isEmpty ? nil : Format.count(results.artists.count, "artist")]
                    .compactMap { $0 }.joined(separator: " · "))
                    .textStyle(.small, tabular: true)
                    .foregroundStyle(Tok.fgMuted)
            }
        }
        Hairline()
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: 20)

                if text.isEmpty {
                    EmptyState(symbol: "magnifyingglass", title: "Search everything", message: "Your library and, through octo-fiesta, everything your provider has.")
                } else if results.isEmpty, !searching {
                    EmptyState(symbol: "magnifyingglass", title: "Nothing found for “\(text)”", message: app.isOffline ? "You're offline, so only your cached library was searched." : "Check the spelling or try fewer words.")
                } else {
                    if !results.artists.isEmpty {
                        SectionTitle(title: "Artists").padding(.horizontal, Metrics.contentGutter).padding(.bottom, 14)
                        Carousel(items: results.artists) { ArtistCard(artist: $0, size: 112) }
                            .padding(.horizontal, Metrics.contentGutter)
                            .padding(.bottom, 32)
                    }
                    if !results.songs.isEmpty {
                        SectionTitle(title: "Songs", count: results.songs.count).padding(.horizontal, Metrics.contentGutter).padding(.bottom, 6)
                        // Search results aren't a list worth queueing: play the song and
                        // let autoplay continue with songs like it.
                        // Modifiers on TrackRows apply to every row, so spacing goes in its own view.
                        TrackRows(tracks: results.songs, playAction: { index in
                            app.player.play([results.songs[index]])
                        }, selection: $selection)
                            .padding(.horizontal, Metrics.contentGutter - 12)
                        Color.clear.frame(height: 32)
                    }
                    if !results.albums.isEmpty {
                        SectionTitle(title: "Albums", count: results.albums.count).padding(.horizontal, Metrics.contentGutter).padding(.bottom, 14)
                        AdaptiveGrid(items: results.albums, minItemWidth: 150) { album, width in
                            AlbumCard(album: album, size: width)
                        }
                        .padding(.horizontal, Metrics.contentGutter)
                    }
                }
                Color.clear.frame(height: 32)
            }
        }
        }
        .pageTitle(text.isEmpty ? "Search" : "“\(text)”")
        .onAppear {
            text = query
            run()
        }
        .onChange(of: text) {
            task?.cancel()
            task = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                run()
            }
        }
    }

    /// Library hits first (they play without octo-fiesta), then provider results that
    /// aren't already in the library.
    private var merged: SearchResults {
        guard let remote else { return local }
        let showExternal = app.settings.showExternalInSearch
        var songs = local.songs
        let songKeys = Set(songs.map { TextKey.songKey(title: $0.title, artist: $0.artist) })
        for song in remote.songs where !songs.contains(where: { $0.id == song.id }) {
            if song.isExternal && (!showExternal || songKeys.contains(TextKey.songKey(title: song.title, artist: song.artist))) { continue }
            songs.append(song)
        }
        var albums = local.albums
        for album in remote.albums where !albums.contains(where: { $0.id == album.id }) {
            if album.isExternal && !showExternal { continue }
            albums.append(album)
        }
        var artists = local.artists
        let query = TextKey.fold(text)
        for artist in remote.artists where !artists.contains(where: { $0.id == artist.id || TextKey.fold($0.name) == TextKey.fold(artist.name) }) {
            if artist.isExternal {
                // Provider artist search pads results with loose matches ("Afroman" for
                // "stromae"); keep the ones whose name actually contains the query.
                let name = TextKey.fold(artist.name)
                if !showExternal || !(name.contains(query) || (query.contains(name) && name.count > 3)) { continue }
            }
            artists.append(artist)
        }
        return SearchResults(artists: artists, albums: albums, songs: songs)
    }

    private func run() {
        let q = text.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let db = app.library.db else {
            local = SearchResults()
            remote = nil
            return
        }
        local = SearchResults(artists: db.searchArtists(q, limit: 12), albums: db.searchAlbums(q, limit: 24), songs: db.searchSongs(q, limit: 40))
        remote = nil
        guard let client = app.library.client, !app.isOffline else { return }
        searching = true
        Task {
            let result = try? await client.search(q, songs: 40, albums: 24, artists: 12)
            guard q == text.trimmingCharacters(in: .whitespaces) else { return }
            remote = result
            searching = false
        }
    }
}
