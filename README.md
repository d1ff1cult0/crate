<p align="center"><img src="Resources/AppIcon.png" width="128" alt=""></p>

# Crate

A native macOS music player for self-hosted [Navidrome](https://www.navidrome.org), built
for [octo-fiesta](https://github.com/V1ck3s/octo-fiesta). SwiftUI and AVFoundation, with
no web view and no Electron. The design follows Dopl's design language, in light and dark.

## What it does

- **Opens instantly.** The whole library (songs, albums, artists, playlists, genres) is
  indexed into a local SQLite cache. After that, only changes are synced in the background.
  Every album and artist cover is downloaded once and kept on disk.
- **Pinned playlists.** Pin the playlists you use most. They stay at the top of Playlists
  and in the sidebar, where you can drag to reorder them or drop songs onto them. ⌘K finds
  any playlist (or album, artist, song) as you type.
- **octo-fiesta native.** Songs that aren't in your library play without errors. Crate
  fetches them through octo-fiesta with a patient timeout, plays the local file, and
  prefetches upcoming ones. Ratings, favourites, plays and playlist adds on those songs are
  queued and applied as soon as octo-fiesta has added the song to your library.
- **Better autoplay.** When the queue ends, Crate blends Navidrome's similar songs, similar
  artists, ListenBrainz radio and Last.fm similar tracks. It scores the candidates on your
  ratings, favourites, recent plays and skips (including skips this session), and keeps
  artists apart. A Familiar / Balanced / Adventurous setting controls how much is new.
- **Weekly recommendations.** ListenBrainz Weekly Jams, Weekly Exploration and Daily Jams,
  a Last.fm weekly mix and artist discovery, plus mixes from your library (On Repeat,
  Forgotten Favourites, Deep Cuts…). Recommended songs you don't own play through
  octo-fiesta, and any mix can be saved as a playlist.
- **Offline.** Download playlists, albums, mixes or all your favourites. Downloaded
  collections stay in sync, and when the server is unreachable the cached library still
  browses and downloaded songs still play.
- **Lyrics.** Synced lyrics that follow the song (click a line to jump there), from your
  server or LRCLIB.
- **The basics, done well.** 1–5 star ratings, favourites, gapless playback, shuffle and
  repeat, a queue panel, genres, search, media keys and Now Playing, AirPlay, scrobbling,
  and resizable sidebar and queue.

## Install

Open `Crate-<version>.dmg` and drag Crate to Applications. Sign in with your server
address (the octo-fiesta address if you use it), user name and password.

The build is ad-hoc signed. If macOS refuses to open a copy downloaded from elsewhere,
right-click Crate.app → Open. After installing a new build, macOS may ask once whether
Crate may read its keychain item; choose Always Allow.

## Build

Needs macOS 14+ and the Swift 6 toolchain. The Command Line Tools are enough; Xcode is
not required.

```bash
make run     # fast arm64 build of dist/Crate.app, then open it
make app     # release build, universal binary
make dmg     # dist/Crate-<version>.dmg
make test    # unit tests
```

## Keyboard

| Action | Keys |
| --- | --- |
| Play / pause | Space |
| Next / previous | ⌘→ / ⌘← |
| Volume | ⌘↑ / ⌘↓ |
| Rate the current song | ⌘1 … ⌘5, ⌘0 clears |
| Favourite the current song | ⌘L |
| Jump to anything | ⌘K |
| Find a playlist (on Playlists) | ⌘F |
| Queue / lyrics | ⌘U / ⌥⌘L |
| Back / forward | ⌘[ / ⌘] |

## Scripting

Crate handles `crate://` links, for Raycast, Alfred or Shortcuts:
`crate://playlist/<id>`, `crate://play/playlist/<id>`, `crate://play/album/<id>`,
`crate://control/toggle|next|previous|shuffle`, `crate://go/discover`,
`crate://search?q=…`, `crate://offline/playlist/<id>`, `crate://lyrics`,
`crate://theme/light|dark|system`.
