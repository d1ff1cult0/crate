# Crate

Native macOS music player (SwiftUI + AVFoundation) for a self-hosted **Navidrome** server
that sits behind **octo-fiesta**. Built from scratch in one session (2026-10-25). It uses
the design language of the user's other app, Dopl (`/Users/d1ff1cult/Local/dopl`,
`docs/DESIGN_SYSTEM.md`), with a dark mode added.

## The brief (what the user asked for, and why)

The user moved off **Feishin** because it feels slow and laggy on macOS. They want simple
and native: connect to Navidrome, play music, genres, playlists, basic settings, ratings,
autoplay. Their specific complaints about Feishin, which are Crate's priorities:

1. **Playlists can't be favourited/pinned.** With 87 playlists this means scrolling every
   time. Crate has pinned playlists (top of Playlists + sidebar, drag to reorder, drop songs
   onto them) and ⌘K / ⌘F to find any playlist instantly.
2. **Errors on songs that aren't in the library** (they come from octo-fiesta). Crate is
   octo-fiesta native; see "octo-fiesta" below.
3. **Autoplay isn't good.** See `Playback/AutoplayEngine.swift`.
4. **Native ListenBrainz/Last.fm recommendations**, weekly like Spotify. See `Discover/`.
5. **Library and images re-index on every launch.** Crate keeps a SQLite index plus an
   on-disk artwork cache, and prefetches every cover after a sync.
6. **Download playlists / favourites for offline.** See `Downloads/DownloadManager.swift`.

Later requests in the same session (all done): resizable sidebar **and** queue panel, more
compact search results, fixing the artwork caching feel, **lyrics** like Feishin/Spotify,
and "push to main without giving yourself credit".

## Hard rules

- **No AI attribution** in commits, tags or PRs: no `Co-Authored-By`, no "Generated with
  Claude Code". The user is the sole author (see also `~/.claude/CLAUDE.md`).
- Never commit credentials. The test server is `navidrome.jplessers.com` (Navidrome 0.63.2
  behind octo-fiesta, ~76k songs, ~9.7k albums, ~3.9k artists, 87 playlists, 451 genres).
  The user gives credentials in the conversation when needed; pass them through env vars
  (below), never into files in the repo.

## Toolchain facts (this Mac has no Xcode)

- Only the **Command Line Tools** (Swift 6.2.3, macOS SDK 26). No `xcodebuild`, no asset
  catalogs (`actool`), no XCTest. Everything is SwiftPM plus shell scripts.
- `Package.swift`: one executable target `Crate` (Swift 5 language mode, so Swift 6 strict
  concurrency doesn't fight AppKit), links system `sqlite3`, no third-party dependencies.
- **App bundle:** `scripts/build-app.sh` builds release, lipos arm64 + x86_64 (set
  `UNIVERSAL=0` for a fast arm64-only build), assembles `dist/Crate.app` (Info.plist from
  `Resources/Info.plist` with `__VERSION__`/`__BUILD__`, fonts in `Contents/Resources/Fonts`,
  `AppIcon.icns`) and ad-hoc signs it. The version lives in `VERSION`.
- **DMG:** `scripts/make-dmg.sh` makes `dist/Crate-<version>.dmg` with an Applications link
  and a drawn background (`scripts/make-dmg-background.swift`). The Finder layout step uses
  AppleScript; it's skipped with `DMG_LAYOUT=0` and times out gracefully if Finder
  automation isn't allowed.
- **Icon:** `scripts/make-icon.swift` draws the icon with CoreGraphics (two records standing
  in a crate) → `Resources/AppIcon.icns` + `AppIcon.png`. The in-app `CrateMark` mirrors it.
- **Tests:** Swift Testing (`Tests/CrateTests`). Run `scripts/test.sh` / `make test`, not
  bare `swift test`. With only the CLT, `Testing.framework` lives in
  `/Library/Developer/CommandLineTools/Library/Developer/Frameworks`. SwiftPM's generated
  test runner must also see it, otherwise `canImport(Testing)` is false in the runner and
  `swift test` builds and **silently runs nothing**. So the script passes `-F`/rpath
  globally. Also: don't `import Foundation` in test files; that loads the
  `_Testing_Foundation` overlay, whose module layout is broken in this CLT. Foundation
  types are visible through `@testable import Crate`. Test helpers that touch decoding go
  through `SubsonicClient.decodePayload`.
- `make run | app | dmg | test | icon | clean`.

## Running and inspecting the app during development

- A bare `.build/debug/Crate` launched from a shell creates its window off-screen. Always
  build the bundle and launch it with `open`.
- Test credentials without touching the keychain:
  `open -n --env CRATE_SERVER=<host> --env CRATE_USER=<u> --env CRATE_PASSWORD=<p> dist/Crate.app`
  (`AppModel.launch()` checks these first).
- Mute before playback tests: `defaults write com.jplessers.crate volume -float 0`. The user
  may be at the machine, so set it back to `0.8` afterwards.
- Drive the UI with the **`crate://` URL scheme** (`AppModel.handle(_:)`): `go/<section>`,
  `album|artist|playlist|genre|mix/<id>`, `search?q=`, `palette?q=`, `play/album|playlist|mix|song|radio/<id>`,
  `control/toggle|next|previous|shuffle`, `queue`, `lyrics`, `pin/<playlistId>`,
  `offline/playlist/<id>`, `offline/favourites`, `theme/light|dark|system`.
- Screenshots: get the window id from `CGWindowListCopyWindowInfo` (owner "Crate", layer 0,
  on-screen), then `screencapture -x -o -l <id> out.png`. If the user hides the window or
  switches Space, capture fails. Don't keep stealing focus.
- Logs: `os.Logger` subsystem `com.jplessers.crate` (category `player`). In zsh, `log` is a
  builtin, so use `/usr/bin/log show --last 5m --predicate 'subsystem == "com.jplessers.crate"' --info`.
- Inspect the cache: `sqlite3 ~/Library/Application\ Support/Crate/Accounts/<user@host>/library.sqlite`.

## Data locations

| What | Where |
| --- | --- |
| Library index (SQLite, WAL) | `~/Library/Application Support/Crate/Accounts/<user@host>/library.sqlite` |
| Saved queue | same folder, `queue.json` |
| Offline downloads | `~/Library/Application Support/Crate/Offline/<user@host>/` |
| Artwork cache | `~/Library/Caches/Crate/Artwork/<user@host>/` (`<coverArt>@<px>.img`) |
| octo-fiesta fetched songs | `~/Library/Caches/Crate/Remote/<user@host>/` (capped at 3 GB, LRU) |
| Preferences | `UserDefaults` domain `com.jplessers.crate` |
| Secrets | Keychain service `com.jplessers.crate`: `password:<user@host>`, `listenbrainz-token`, `lastfm-api-key` |

Bundle id `com.jplessers.crate`. Each rebuild changes the ad-hoc signature, so macOS asks
once to allow keychain access. That's expected.

## Architecture

```
Sources/Crate/
  App/        CrateApp (Window scene, menus, Dock menu, key monitor, dialogs, WindowDragArea,
              ResizeHandle), AppModel (session, connectivity, URL scheme, Navigator, toasts),
              SettingsStore (UserDefaults + Keychain), Keychain
  Design/     Tokens (Dopl colours, light + dark), Typography (Inter with cv11/ss01/tnum,
              Outfit wordmark), Components (buttons, fields, pills, Artwork, StarRating,
              CrateMark…)
  Subsonic/   SubsonicClient (token auth, all endpoints, fetchFile), Models (lenient wire
              decoding), OctoID (external id helpers)
  Library/    SQLite (tiny wrapper: writer + reader connections), LibraryDatabase (schema +
              queries), LibraryStore (cache-first state, sync, ratings/stars/playlists,
              octo-fiesta pending actions), ImageCache + ArtworkPrefetcher, Format + TextKey
  Playback/   PlayerController (AVQueuePlayer, gapless preload, scrobbling, Now Playing,
              media keys, queue persistence), AutoplayEngine, RemoteFetcher (octo-fiesta),
              Lyrics (LyricsStore + LRCLib)
  Discover/   ListenBrainz + Last.fm services, TrackResolver (library → octo-fiesta),
              MixStore (weekly/daily/library mixes)
  Downloads/  DownloadManager (offline collections that stay in sync)
  Views/      Shell (RootView, Sidebar, PlayerBar, QueuePanel, LyricsView, CommandPalette,
              LoginView), Home, Discover, Library (albums, artists, songs, favourites,
              downloads, search), Genres, Playlists, Settings, Common (TrackRows, cards, grids)
```

- State is `@MainActor @Observable` stores owned by `AppModel`, injected with
  `.environment(app)`. Views read `app.library`, `app.player` and so on.
- **Navigation** is a custom `Navigator` (root section + detail stack + forward stack), not
  NavigationStack. The root view stays mounted under detail pages so going back keeps its
  scroll position. Detail pages set the header breadcrumb through `.pageTitle(_:)`.
- **Performance rules** (the reason for this app):
  - The playback position lives in `PlaybackClock`, so only the progress bar redraws at 4 Hz.
  - Lists are `LazyVStack`/`LazyVGrid` with fixed-height rows. Big collections (Songs,
    Albums, Artists, genre songs) page from SQLite.
  - All DB writes during sync run off the main thread (`LibraryStore.background`).
  - **`TrackRows` returns a header plus a `ForEach`**, so modifiers on it apply to every
    row. Put spacing in a separate view (`Color.clear.frame(height:)`), never
    `.padding(.bottom)` on `TrackRows` (that bug made search rows 120 pt apart).
- **Library sync** (`LibraryStore.sync`): playlists, genres, starred and scanStatus every
  time. A **full index** happens on first run, after 3 days, or on "Rebuild": albums via
  `getAlbumList2 alphabeticalByName`, artists via `getArtists`, songs via **`search3` with
  an empty query, paged 500 at a time with 4 requests in flight** (~76k songs in well under
  a minute), using generation numbers to delete stale rows. When Navidrome's `lastScan`
  changed, it runs an **incremental** sync instead (newest albums since the last sync).
  octo-fiesta triggers a scan for every song it fetches, so `lastScan` changes often. Home
  lists (recent/newest/frequent) are refreshed on every sync. Every 10 minutes the app
  syncs and replays pending actions.
- **Artwork:** memory (NSCache, 384 MB) → disk → network, in buckets 96/160/400/800 px.
  Smaller requests reuse a larger cached file. Thumbnails (≤160 px) load synchronously from
  disk so rows never flash. **Song rows use the album's cover id** (`LibraryStore.cover(for:)`),
  because songs carry per-file ids (`mf-…`) that would never share the album cache.
  `ArtworkPrefetcher` downloads every album and artist cover at 400 px after each sync
  (4 at a time; ~13.6k covers, ~400 MB). It can be turned off in Settings. `Artwork`
  tracks which cover its image belongs to, because a reused view (the player bar) must
  never keep the previous song's art.

## octo-fiesta (read from its source, V1ck3s/octo-fiesta, `Controllers/SubSonicController.cs`)

- IDs: `ext-{provider}-{song|album|artist}-{id}` (legacy `ext-{provider}-{id}` = song), and
  provider playlists `pl-{provider}-{id}`, which are returned **as albums** in `search3` and
  opened with `getAlbum`. Careful: Navidrome's *own* playlist cover art ids also start with
  `pl-` (`pl-<id>_<ts>`); `OctoID.isExternalPlaylist` checks for a known provider. External
  songs have `suffix: "Remote"` and `isExternal: true`.
- `search3` merges library and provider results, but an empty query is passed straight to
  Navidrome (that's what makes the full sync work).
- **`stream` of an external song sends nothing until the whole provider download has
  finished** (seconds to minutes). That's why Feishin errors. `RemoteFetcher` downloads it to
  a local file with a 300 s/900 s timeout, plays the file (seeking works), shows
  "octo-fiesta is fetching this song from Deezer…", and prefetches the next external songs
  in the queue.
- Not handled for external ids (Navidrome rejects them): `setRating`, `getSimilarSongs2`,
  `getArtistInfo2`, `getPlaylist`. `star` on an external song only makes octo-fiesta
  download it (no actual star); `unstar` errors; `scrobble` is silently dropped;
  `updatePlaylist` with an external song downloads it and waits for a scan (slow). On an
  external album or `pl-` playlist, `star` downloads the whole thing.
- **`getSong(ext-id)` returns the local song once octo-fiesta has it** (mapping exists).
  `LibraryStore.resolveLocal` relies on this and caches the mapping in `ext_map`.
  Ratings/stars/unstars/scrobbles (with their original timestamp)/playlist adds on
  unresolved external songs go to the `pending` table and are replayed by
  `processPending()` after syncs. Entries older than 30 days are dropped.
- `getCoverArt`, `getAlbum`, `getArtist`, `getTopSongs` and `getLyricsBySongId` work for
  external ids.
- Testing an uncached external song **adds it to the user's library** (octo-fiesta
  downloads it). Prefer songs that are already fetched (e.g. `ext-deezer-song-71428557`,
  `ext-deezer-song-71428560`, both Stromae).

## Navidrome facts (0.63.2, OpenSubsonic)

- Extensions: transcodeOffset, formPost, songLyrics v1/v2, indexBasedQueue, transcoding,
  playbackReport.
- `artistImageUrl` points at the internal host `http://navidrome:4533/...`; use
  `getCoverArt` with the `ar-…` id instead.
- The server has a Last.fm agent configured: `getSimilarSongs2`, `getArtistInfo2` and
  `getTopSongs` return useful data (limited to the library).
- AVFoundation on this macOS plays mp3, flac, m4a **and Ogg Opus** raw. Crate streams the
  original by default (instant seeking) and retries once as `format=mp3&maxBitRate=320`
  if an item fails. `format=aac` isn't configured on this server.
- Dates come with 0–9 fractional digits; `Format.parseDate` strips them.

## Recommendations and autoplay

- **ListenBrainz:** `GET /1/user/{user}/playlists/createdfor` (public, no auth); the
  `source_patch` in `extension…additional_metadata.algorithm_metadata` is `weekly-jams`,
  `weekly-exploration`, `daily-jams`, `top-discoveries-of-YYYY`, `top-missed-recordings-of-YYYY`.
  Tracks come from `GET /1/playlist/{mbid}` (JSPF; artwork via `caa_release_mbid`/`caa_id`).
  **LB Radio (`/1/explore/lb-radio?prompt=artist:(X)`) needs a user token** (401 without);
  it's used in autoplay when a token is set. Listens go to `POST /1/submit-listens`
  (optional, off by default, because Navidrome may already scrobble).
- **Last.fm** has no recommendations API. The weekly mix is built from track.getSimilar on
  the user's 1-month top tracks minus their overall top 300. Discovery is the top tracks of
  similar artists they don't play. It needs the user's own API key.
- **Library mixes** (no setup): On Repeat (local `plays` table), Forgotten Favourites, Deep
  Cuts, Fresh in Your Library, Top Rated; rebuilt daily.
- `TrackResolver`: library match by normalised title + artist (`TextKey`, indexed
  `title_key`), else octo-fiesta `search3 "<artist> <title>"`, picking an exact title match
  with overlapping artists and preferring library copies.
- **AutoplayEngine:** seeds are the last 3 distinct artists. Sources run in parallel:
  Navidrome similar songs, similar artists → their best library songs, same artist, genre,
  LB radio, Last.fm similar. Agreement between sources boosts a song. Scoring adds ratings
  (1★ excluded), favourites, the discovery level, recency (4-day decay), 30-day skips and
  session skip/listen feedback per artist, plus jitter. `diversify` allows at most 2 per
  artist and never the same artist back to back. When the queue is within 2 songs of the
  end, 10 more are appended (marked `fromAutoplay`, shown under "Autoplay" in the queue).
  Skips (< 30 s and < 50%) are recorded in `plays`.

## Design (Dopl language)

- Light-grey canvas, sidebar directly on the canvas (resizable 200–380, default 248), one
  white panel (radius 16, 1 px hairline, 8 pt inset), a player bar on the canvas, near-black
  primary buttons (near-white in dark mode), sky as the accent, and the lavender→sky
  gradient only on the logo. Tag palette (bg-50/border-200/text-700) for genres and mix
  covers, with the hue hashed from the name. Inter with Dopl's `cv11`+`ss01` features,
  tabular figures for numbers, Outfit SemiBold for the wordmark (fonts are bundled, OFL).
- Dark mode redefines the semantic tokens only (`Tok.*` are dynamic `NSColor`s). The
  Appearance setting sets `NSApp.appearance`.
- Sentence case everywhere, empty/loading (skeleton)/error states on every page.
  Destructive actions confirm.

## Testing notes from the session

- Verified against the real server: full sync, playlists/pins, album/artist/genre/search
  pages, playback and gapless queue, octo-fiesta fetch path (fetching state → plays),
  autoplay picks, synced lyrics from LRCLIB, offline download + removal, artwork
  prefetch (~13 covers/s), light and dark mode, ⌘K palette.
- Not exercised end to end: a Last.fm or ListenBrainz account (the user hasn't given their
  user names; the APIs were checked with a public LB user), real offline mode (network
  down), drag-resizing by mouse (rendering only).

## Ideas not done yet

- ReplayGain/normalisation, crossfade, an equaliser.
- A "radio from playlist" that weights playlist co-occurrence (artists that appear
  together in the user's playlists) as an extra autoplay signal.
- Finder layout for the DMG without AppleScript (write `.DS_Store` directly).
- Developer ID signing and notarisation if the app is ever shared.
