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
"push to main without giving yourself credit" (in several commits, not one). After the
user installed 1.0.0: smooth scrolling in mixes (it was laggy), a purple dot instead of the
"Deezer" pill, a README like Dopl's with screenshots, **no reinstalling for updates**
(in-app updater, 1.1.0) and **never re-entering credentials or API keys** after an update.
The user also asked that their installed `/Applications/Crate.app` be updated when work
is done (`scripts/install.sh`). The user writes in English and sometimes in Dutch.

Second session (2026-10-27): scrolling was **still** not smooth for the user although the
1.1 benchmark said it was (see "Measuring smoothness" for why), Space didn't pause after
typing in a field, ⌘K / Ctrl-K should be ready to type, Settings didn't resize with the
queue open (the queue now sits beside the page), and the logo should go home. The user
was (rightly) frustrated that scrolling a list still dropped frames: the bar is **zero
dropped frames**, measured the way a person scrolls, not "a few percent".

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
- `make run | dev | app | install | dmg | release | test | icon | clean`.

## Running and inspecting the app during development

- **The user runs the real app (`/Applications/Crate.app`) all day. Never test with it.**
  Use the dev variant: `VARIANT=dev UNIVERSAL=0 scripts/build-app.sh` (or `make dev`) builds
  `dist/Crate Dev.app` with bundle id `com.jplessers.crate.dev`, its own folders
  (`~/Library/Application Support/Crate Dev`, `~/Library/Caches/Crate Dev`), its own
  defaults domain, secrets and URL scheme **`crate-dev://`** (`AppPaths`). Updates are off
  in dev builds.
- Seed the dev variant from the user's cache instead of a full re-sync:
  `sqlite3 "<Crate>/Accounts/<acct>/library.sqlite" ".backup '<Crate Dev>/Accounts/<acct>/library.sqlite'"`
  (consistent copy of a live WAL database) and `cp -cR` the artwork folder (an APFS clone,
  so no extra disk space). Set `defaults write com.jplessers.crate.dev cacheAllArtwork -bool false`
  and `volume -float 0`.
- A bare `.build/debug/Crate` launched from a shell creates its window off-screen. Always
  build the bundle and launch it with `open`.
- **Without the user's password**: run a stand-in server that answers every request with
  HTTP 500 (`python3 -c` with `http.server`, e.g. on port 4599) and launch with
  `--env CRATE_SERVER=http://127.0.0.1:4599 --env CRATE_USER=<u> --env CRATE_PASSWORD=x`.
  A 500 isn't a connectivity error, so the app stays "online" (rows aren't dimmed as
  unplayable) and renders everything from the cache. Seed the account folder
  `<u>@127.0.0.1-4599` (and the artwork folder of the same name) as above. Playback fails,
  which is fine for UI work.
- Test credentials without touching stored secrets:
  `open -n "dist/Crate Dev.app" --env CRATE_SERVER=<host> --env CRATE_USER=<u> --env CRATE_PASSWORD=<p>`
  (`AppModel.launch()` checks these first). `--env CRATE_DISPLAY_HOST=music.example.com`
  masks the server address in the UI, which is how the README screenshots were taken.
- Drive the UI with the **URL scheme** (`crate-dev://` for the dev build, `AppModel.handle(_:)`): `go/<section>`,
  `album|artist|playlist|genre|mix/<id>`, `search?q=`, `palette?q=`, `play/album|playlist|mix|song|radio/<id>`,
  `control/toggle|next|previous|shuffle`, `queue`, `lyrics`, `pin/<playlistId>`,
  `offline/playlist/<id>`, `offline/favourites`, `theme/light|dark|system`, and in dev builds
  `debug/scroll` (below).
- **Measuring smoothness:** `crate-dev://debug/scroll` (`ScrollBenchmark`, dev only) scrolls
  the scroll view under the middle of the page with synthetic trackpad events while the
  pointer rests over the list, timed on the display refresh (this Mac is 60 Hz), and
  appends a line to `~/Library/Caches/Crate Dev/scroll-benchmark.txt` with missed frames
  and when the long ones happened. `?input=clip` moves the clip view instead (no events, no
  hover), `?input=hover` moves the pointer over rows without scrolling, `?pointer=0`,
  `?speed=` (pt/s, default 1500), `?seconds=`. Healthy is **0 missed** in steady state.
  Lessons from getting this wrong:
  - The 1.1 benchmark picked "the largest scroll view", which on a detail page was the
    **hidden root page** kept mounted under it (SwiftUI opacity 0 is invisible to AppKit),
    and it scrolled without a pointer, so it never saw hover. It reported smooth while
    the user's real scrolling dropped 25–54% of frames.
  - Hover changes need the dev app to be **active**; run with `open` (not `-g`) when
    measuring hover, and expect the user's real cursor to interfere. Results vary run to
    run; repeat 3–4 times and check `uptime` (background system jobs push the load to 15+
    and cause misses that aren't Crate's).
  - `sample` slows the app a lot: use it to see *where* time goes, never for frame counts.
  - `screencapture -v` recordings drop ~30% of frames by themselves (a trivial Core
    Animation control did too), so frame gaps in a recording prove nothing. Measuring how
    far the content moves per recorded frame does tell something (big jumps then still
    frames = the main thread falling behind).
  - `CGEvent.postToPid` delivers key events (when the app is active) but not mouse or
    scroll events. In-app, `window.sendEvent` works for clicks; an inactive window
    swallows the first click unless the view accepts first mouse.
  - **Don't activate the dev app while the user works**: their keystrokes land in it (a
    Space started playback there once). Use `open -g`, keep bursts short.
  Check idle CPU while playing too (`ps -o %cpu= -p <pid>`); it should be a few percent.
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
| Secrets | `~/Library/Application Support/Crate/secrets.bin` (AES-GCM, key from the hardware UUID + bundle id, 0600): `password:<user@host>`, `listenbrainz-token`, `lastfm-api-key` |

## Secrets and the keychain (important)

Crate is ad-hoc signed (no Apple Developer ID). macOS ties keychain items to the **exact
code hash** of the app that created them (`partition_id: cdhash:…` in
`security dump-keychain -a`), so every new build gets a "Crate wants to use your
confidential information" prompt for every item. A self-signed certificate doesn't help:
without a team ID the partition is still the cdhash. So since 1.1.0, `Secrets` keeps them
in an encrypted file instead, and only reads the 1.0 keychain items once to migrate them
(one prompt per item, one time).

**Never probe the user's keychain from a test binary.** `kSecUseAuthenticationUIFail` does
not suppress these legacy ACL prompts: the dialogs appear on the user's screen, and if they
click "Always Allow" the test binary ends up in the item's access list. This happened once
in this project; the user was told and the binaries were deleted.

## Updates and releases

- `Updater` checks `api.github.com/repos/d1ff1cult0/crate/releases/latest` at launch (after
  8 s) and every 6 h when "Check for updates automatically" is on. It downloads the release
  `.zip`, unzips it with `ditto`, checks the bundle id, swaps the bundle (keeping a backup
  until the move succeeds) and relaunches through `/bin/sh` once the old process has
  exited. A card above Settings in the sidebar offers the update; Settings → Updates shows
  the status.
- To ship: bump `VERSION`, commit, push, run `scripts/release.sh` (builds a universal app,
  `ditto -c -k --keepParent` zip and DMG, then `gh release create v<VERSION>`). `gh` is
  logged in as d1ff1cult0 and the repo is public, so the unauthenticated API check works.
- `scripts/install.sh` (`make install`) puts `dist/Crate.app` into `/Applications`, quitting
  and reopening a running copy. Everything the user set up lives outside the bundle.

## Architecture

```
Sources/Crate/
  App/        CrateApp (Window scene, menus, Dock menu, key monitor, dialogs, WindowDragArea,
              ResizeHandle), AppModel (session, connectivity, URL scheme, Navigator, toasts),
              SettingsStore (UserDefaults), Secrets (encrypted file + 1.0 keychain migration),
              AppPaths (release vs dev folders), Updater (GitHub releases), ScrollBenchmark (dev)
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
  - **No redraw storms.** Anything rows observe must change rarely: `RemoteFetcher.active`
    is a Set (no per-chunk progress), download progress is published in 10% steps,
    `MixStore.resolve` publishes every 16 lookups and writes to SQLite once at the end. The
    1.0 lag in Weekly Exploration came from exactly these: every visible row redrew on each
    progress tick.
  - Rows only build hover controls (play, stars, heart, "…" menu) while hovered or when they
    carry a value. `RemoteFetcher.cachedFile` is a dictionary lookup (use `validFile` right
    before playback); `ImageCache.diskImageSync` remembers covers that aren't on disk.
  - **Rows in scrolling lists use `.rowHover($hovering)`, not `.onHover`**, and **fixed
    rows use `.fixedRow(height:)`, not `.frame(height:)`** (`Components.swift`). With the
    pointer over a list, a new row passes under it every few frames; each hover change
    rebuilt that row, and because rows were sized by `.frame(height:)` the `LazyVStack`
    re-measured every visible row (all their text) to place them. That was the 1.1
    stutter. `ScrollActivity` watches scroll-wheel events and holds hover until a scroll
    has stopped; `FixedRowLayout` reports width × height without measuring its contents.
  - Covers for rows about to appear are decoded off the main thread (`ImageCache.warm`,
    triggered every 25 rows from `TrackRows`); a synchronous decode is ~1.3 ms per row.
  - Known remaining cost (~1 ms/frame while scrolling): with `.hiddenTitleBar`, SwiftUI's
    `WindowDragPreventionContentPathObserver` asks AppKit to recompute the title-bar drag
    area whenever any shape moves, and that walks the whole focus tree
    (`NSHostingView.acceptsFirstResponder`). The default window style plus a manual
    transparent title bar didn't avoid it; `allowsHitTesting(false)` on decorative shapes
    didn't either.
  - **Continuous animation goes through Core Animation**, not SwiftUI: `NowPlayingBars` is
    an `NSViewRepresentable` with CALayer animations. The SwiftUI `TimelineView` version kept
    the view graph busy 24×/s and the app at ~35% CPU while playing; now it's ~2.5%.
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

## README screenshots

`docs/screenshots/*.png` were captured from the dev build (light and dark via
`crate-dev://theme/…`, server masked with `CRATE_DISPLAY_HOST`, a few playlists pinned in
the dev copy only), with `screencapture -x -o -l <windowid>`, then `sips -Z 1800`. Don't
show the real server address or anything from the user's private data beyond what's already
visible in their library.

## Testing notes from the session

- Verified against the real server: full sync, playlists/pins, album/artist/genre/search
  pages, playback and gapless queue, octo-fiesta fetch path (fetching state → plays),
  autoplay picks, synced lyrics from LRCLIB, offline download + removal, artwork
  prefetch (~13 covers/s), light and dark mode, ⌘K palette.
- Not exercised end to end: real offline mode (network down) and drag-resizing by mouse
  (rendering only). The user has since connected ListenBrainz and Last.fm in their own app,
  and the mixes are in their cache.

## Ideas not done yet

- ReplayGain/normalisation, crossfade, an equaliser.
- A "radio from playlist" that weights playlist co-occurrence (artists that appear
  together in the user's playlists) as an extra autoplay signal.
- Finder layout for the DMG without AppleScript (write `.DS_Store` directly).
- Developer ID signing and notarisation if the app is ever shared.
- Load Songs pages off the main thread (each `loadMore` is a 400-row SQLite query on it).
