# Build prompt: **Crate** — a self-hosted Spotify→Navidrome migration and library tool

> Paste this whole file into Claude Code as the opening message of a new project.
> Rename the app if you like; "Crate" is used throughout.

---

## 0. Before you write any code

Do these three things first, in order, and stop for my approval after step 3.

1. **Verify the Spotify Web API surface yourself.** My constraints in §2 were checked in August 2026 but Spotify has changed this API three times in the last twelve months. Fetch `https://developer.spotify.com/documentation/web-api/references/changes/february-2026`, the March/May/July 2026 changelogs, and the February 2026 migration guide. Write what you find to `docs/spotify-api-state.md` with a date stamp. If anything in §2 is wrong, that file wins and you tell me what changed.
2. **Write `CLAUDE.md`** at the repo root: stack, directory layout, commands, conventions, and a "gotchas" section (path mapping, container vs host paths, provider credentials).
3. **Write `docs/plan.md`**: the phase breakdown from §10, with your own estimate of the risky parts and anything in this brief you think is wrong or over-scoped. Argue with me if you disagree — I'd rather fix the design now than after phase 3.

Then wait. Don't scaffold until I say go.

---

## 1. Context and environment

I'm migrating off Spotify to a self-hosted setup and the migration itself is the painful part. I've tried twice and bounced back both times, because getting my music across and getting anything like Spotify's recommendations were both too much friction.

**The machine this runs on** (`d1ff1cult-server`, Ubuntu, i5-8400, GTX 1080, everything in Docker):

- **Navidrome** — primary music server, the target for playlists. Exposes the Subsonic API.
- **Jellyfin** — also reads the music library.
- **Lidarr** — already manages the library; has a REST API. Treat it as an optional downstream, not a competitor. Don't reimplement artist monitoring if Lidarr can do it.
- **qBittorrent behind Gluetun/Surfshark** — there's an established pattern here for routing a container's traffic through the VPN. Any download provider that should be VPN-routed must work under `network_mode: service:gluetun`.
- **Ollama** with Gemma models, GPU available — this is the LLM backend for the curator module in §7.8. Local first, no cloud dependency required.

Assume Docker Compose, assume a reverse proxy in front, assume single user (me). No multi-tenancy, no user management beyond one login.

**Stack** (non-negotiable, it's what I work in): Next.js 15 App Router + TypeScript + Prisma + PostgreSQL. Tailwind v4. Add BullMQ + Redis for the job queue.

---

## 2. Hard constraints: what Spotify actually allows in 2026

This is the part that determines the whole architecture. Read it carefully; a lot of tutorial-era knowledge about this API is now wrong.

Since the **February 2026** Development Mode changes (enforced for existing apps from 9 March 2026):

**Dead or unusable:**
- `GET /recommendations`, `/audio-features`, `/audio-analysis`, `/artists/{id}/related-artists`, featured playlists, category playlists — all killed in November 2024, no path to access for a new app, no replacement.
- `GET /playlists/{id}/tracks` → **removed**, replaced by `GET /playlists/{id}/items`. Response fields renamed: `tracks` → `items`, `tracks.items.track` → `items.items.item`.
- **Playlist contents are only returned for playlists the authenticated user owns.** Any other playlist — someone else's public playlist, an editorial playlist, Discover Weekly, a Daily Mix — returns metadata only. This is the single most important constraint in this document. "Paste any Spotify link and it just works" is not achievable through the official API.
- `GET /users/{id}/playlists` and `GET /users/{id}` — removed. No reading anyone else's account at all.
- All batch fetches removed: `GET /tracks`, `/albums`, `/artists`, `/episodes`, `/shows`. Only single-ID fetches remain. **One HTTP request per track.** This is a serious throughput problem and drives the caching design.
- `GET /browse/new-releases`, `/browse/categories`, `GET /artists/{id}/top-tracks`, `GET /markets` — removed.
- Fields gone: `popularity` (track/album/artist), `followers`, `linked_from`, `available_markets`, `label`, `album_group`, user `country`/`email`/`product`.
- `GET /search` — `limit` max dropped from 50 to **10**, default 5. Paginate.

**Still available and load-bearing for us:**
- `GET /me`, `GET /me/playlists`, `GET /playlists/{id}`, `GET /playlists/{id}/items` (own playlists)
- `GET /me/tracks` (liked songs), `GET /me/albums`, `GET /me/following`
- `GET /me/top/tracks` and `/me/top/artists` (`time_range`: short/medium/long_term)
- `GET /me/player/recently-played`
- `GET /tracks/{id}`, `/albums/{id}`, `/albums/{id}/tracks`, `/artists/{id}`, `/artists/{id}/albums`
- `POST /me/playlists`, `POST|PUT|DELETE /playlists/{id}/items`
- **`external_ids.isrc` on tracks and albums** — removed in February, then reverted in March 2026 and confirmed staying. ISRC is our highest-confidence matching key; build around it, but degrade gracefully if it ever vanishes.

**The clock is ticking, and this shapes everything:**

> Development Mode now **requires the app owner to hold an active Spotify Premium subscription**. When my subscription lapses, the integration stops working entirely.

So: **the Spotify connector is a harvesting tool with an expiry date, not a permanent dependency.** Build accordingly.

- Everything fetched from Spotify is persisted locally and permanently on first sight — full track metadata, ISRCs, playlist snapshots, top items, recently-played, followed artists. Never re-fetch what's in the DB. Never require Spotify to be reachable for any read path in the UI.
- There is a prominent **"Harvest everything"** action that pulls the complete account state in one pass and stores it, designed to be run before cancellation.
- The app must be fully functional with the Spotify connector permanently disconnected. If a Spotify call 401s or 403s, the app degrades to local data with a quiet banner — it does not error out, and it does not nag.
- Everything Spotify-derived is stored in a source-neutral shape (see `SourceTrack` in §6), so the other importers in §7.2 populate the same tables.

Other operational notes: Dev Mode is capped at 5 authorized users and 25 client IDs per developer account, quota is counted per developer account rather than per app. Rate limits are undocumented and calculated on a rolling ~30-second window — implement adaptive backoff on 429 using `Retry-After`, never a fixed sleep.

---

## 3. What the app has to do

Four goals, in priority order.

1. **Bulk import must be effortless.** I have a lot of music on Spotify. Getting it local should be one screen and a progress bar, not a weekend.
2. **Make Navidrome pleasant.** Playlists that actually appear and stay in sync, and a library free of the duplicate mess that accumulates when you download from four sources.
3. **Real recommendations.** Not a "similar artists" list. Something that produces a rotating set of mixes I actually want to press play on, the way Daily Mix did. If it can't be good, I'd rather it not exist than exist badly.
4. **Automatic by default.** Every routine action should happen on a schedule without me opening the app. The UI is for reviewing what happened and handling the genuinely ambiguous cases.

---

## 4. Architecture

```
apps/
  web/          Next.js 15 App Router — UI, API routes, server actions
  worker/       Long-running Node process — BullMQ consumers, schedulers, watchers
packages/
  db/           Prisma schema + client (shared by web and worker)
  core/         Domain logic, no I/O: normalization, matching, scoring, dedupe, mix generation
  providers/    Download provider adapters behind one interface
  integrations/ Spotify, Navidrome/Subsonic, Last.fm, Deezer, YouTube Music, MusicBrainz, AcoustID, Lidarr
```

- `packages/core` is pure functions with no network or filesystem access, and it's where the test suite lives. Matching and dedupe logic must be testable against fixtures without spinning up anything.
- The **worker is a separate process**, not Next.js route handlers. Downloads take minutes and survive redeploys. Never run a download from a request handler.
- **Queues** (BullMQ, one per concern, separate concurrency and rate limits): `spotify-sync`, `library-scan`, `match`, `download`, `postprocess`, `fingerprint`, `playlist-write`, `recommend`.
- **Progress to the UI** via Server-Sent Events from a `/api/events` endpoint backed by Redis pub/sub. Fall back to polling. No websocket server.
- **Every job writes a `JobRun` row** with structured logs, so the UI has real history and I can debug a failed download from three days ago without SSH.
- Idempotency everywhere: re-running any job must converge, not duplicate. Use deterministic BullMQ job IDs.

---

## 5. Path mapping — get this right or nothing works

The single most common failure in this class of app: the path Navidrome sees is not the path this app sees.

Config carries three roots, each with an explicit host↔container mapping:

- `MUSIC_ROOT` — the library Navidrome scans
- `STAGING_ROOT` — where downloads land before post-processing
- `TRASH_ROOT` — where dedupe losers go (never delete in place)

Store an explicit `pathMappings: [{ appPath, navidromePath }]` in settings. Every path written to an m3u is translated through it. Add a **"Verify paths"** diagnostic on the settings page that writes a probe playlist, calls Navidrome's Subsonic `startScan`, polls `getScanStatus`, then checks via `getPlaylists` whether the probe resolved — and reports exactly which segment of the mapping is wrong if it didn't. This should run automatically on first setup.

---

## 6. Data model

Prisma + Postgres. This is the shape, not the final schema — add indexes, refine, tell me if you'd model it differently.

```prisma
// ── Sources: anything that describes music I want, wherever it came from
model SourcePlaylist {
  id           String   @id @default(cuid())
  source       Source   // SPOTIFY | CSV | TEXT | GDPR_EXPORT | MANUAL | GENERATED
  externalId   String?  // Spotify playlist id, etc.
  name         String
  ownerName    String?
  snapshotId   String?  // Spotify snapshot_id — skip re-sync when unchanged
  imageUrl     String?
  lastSyncedAt DateTime?
  tracks       SourceTrack[]
  playlist     Playlist?    // the local playlist this materializes into
  @@unique([source, externalId])
}

model SourceTrack {
  id           String   @id @default(cuid())
  playlistId   String?
  position     Int?
  title        String
  artists      String[]
  albumArtist  String?
  album        String?
  durationMs   Int?
  isrc         String?  // primary matching key
  spotifyId    String?
  mbid         String?
  year         Int?
  addedAt      DateTime?
  rawJson      Json?    // full upstream payload, kept forever
  normTitle    String   // computed, indexed
  normArtist   String   // computed, indexed
  match        Match?
  @@index([isrc]) @@index([normArtist, normTitle]) @@index([spotifyId])
}

// ── The local library
model LibraryTrack {   // canonical recording; may have several files
  id          String @id @default(cuid())
  title       String
  artist      String
  albumArtist String?
  album       String?
  durationMs  Int?
  isrc        String?
  mbid        String?
  acoustId    String?
  normTitle   String
  normArtist  String
  files       LibraryFile[]
  playCount   Int      @default(0)   // synced from Navidrome
  lastPlayedAt DateTime?
  starred     Boolean  @default(false)
  @@index([isrc]) @@index([acoustId]) @@index([normArtist, normTitle])
}

model LibraryFile {
  id           String @id @default(cuid())
  trackId      String
  path         String @unique
  format       String   // flac, mp3, opus, m4a
  bitrate      Int?
  sampleRate   Int?
  bitDepth     Int?
  channels     Int?
  sizeBytes    BigInt
  durationMs   Int?
  mtime        DateTime
  contentHash  String?  // hash of audio stream, not the container
  fingerprint  String?  // chromaprint
  tagsJson     Json
  qualityScore Int      // computed, see §7.6
  sourceProvider String?
  @@index([contentHash]) @@index([fingerprint])
}

model Match {
  id            String @id @default(cuid())
  sourceTrackId String @unique
  libraryTrackId String?
  method        MatchMethod  // ISRC | MBID | FINGERPRINT | EXACT_NORM | FUZZY | MANUAL | NONE
  confidence    Float
  status        MatchStatus  // MATCHED | MISSING | NEEDS_REVIEW | REJECTED | DOWNLOADING
  reviewedAt    DateTime?
}

// ── Playlists we own and write out
model Playlist {
  id             String @id @default(cuid())
  name           String
  kind           PlaylistKind  // IMPORTED | GENERATED_MIX | MANUAL
  description    String?
  m3uPath        String?
  subsonicId     String?
  autoSync       Boolean @default(true)
  lastWrittenAt  DateTime?
  items          PlaylistItem[]
  mixConfigJson  Json?     // for generated mixes: seeds, rules
}

model PlaylistItem {
  id         String @id @default(cuid())
  playlistId String
  position   Int
  libraryTrackId String?
  sourceTrackId  String?   // kept even when unmatched, so gaps can be filled later
  @@unique([playlistId, position])
}

// ── Acquisition
model DownloadRequest {
  id            String @id @default(cuid())
  sourceTrackId String
  status        DownloadStatus  // QUEUED | RUNNING | SUCCEEDED | FAILED | ABANDONED | MANUAL_HOLD
  priority      Int    @default(0)
  attempts      DownloadAttempt[]
  resultFileId  String?
  createdAt     DateTime @default(now())
}

model DownloadAttempt {
  id         String @id @default(cuid())
  requestId  String
  provider   String
  query      String
  candidateJson Json?    // what the provider offered, and why we picked it
  outcome    String      // SUCCESS | NO_RESULTS | REJECTED_QUALITY | ERROR | TIMEOUT | RATE_LIMITED
  detail     String?
  durationMs Int?
  createdAt  DateTime @default(now())
}

// ── Duplicates
model DuplicateGroup {
  id         String @id @default(cuid())
  reason     String   // HASH | FINGERPRINT | ISRC | FUZZY
  confidence Float
  status     String   // OPEN | RESOLVED | IGNORED
  members    DuplicateMember[]
  resolvedAt DateTime?
}
model DuplicateMember {
  id       String  @id @default(cuid())
  groupId  String
  fileId   String
  isKeeper Boolean @default(false)
  action   String? // KEPT | TRASHED | IGNORED
}

// ── Taste and recommendations
model ListeningEvent {
  id        String @id @default(cuid())
  source    String   // SPOTIFY_EXPORT | SPOTIFY_API | NAVIDROME | LASTFM
  trackId   String?
  artistName String
  trackName  String
  playedAt  DateTime
  msPlayed  Int?
  skipped   Boolean @default(false)
  @@index([playedAt]) @@index([artistName])
}

model ArtistNode {
  id         String @id @default(cuid())
  name       String @unique
  normName   String @unique
  mbid       String?
  inLibrary  Boolean @default(false)
  affinity   Float   @default(0)   // computed taste weight
  edgesOut   ArtistEdge[] @relation("from")
}
model ArtistEdge {
  id       String @id @default(cuid())
  fromId   String
  toId     String
  source   String   // LASTFM | DEEZER | YTM | COOCCURRENCE | LLM
  weight   Float
  @@unique([fromId, toId, source])
}

model Mix {
  id          String @id @default(cuid())
  slot        Int      // 1..6, stable "Daily Mix N" identity
  name        String
  descriptor  String   // human-readable: the artists/mood that define it
  generatedAt DateTime
  playlistId  String?
  seedJson    Json
}

model JobRun {
  id        String @id @default(cuid())
  queue     String
  name      String
  status    String
  progress  Int      @default(0)
  payload   Json?
  logsJson  Json?
  error     String?
  startedAt DateTime @default(now())
  endedAt   DateTime?
}

model Setting { key String @id  value Json }
```

---

## 7. Modules

### 7.1 Spotify harvester

OAuth Authorization Code + PKCE, refresh token stored encrypted at rest. Scopes: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`, `user-top-read`, `user-read-recently-played`, `user-follow-read`, plus write scopes only if you implement the reverse-sync in §7.9.

**Harvest everything** does, in one job, with a live checklist UI:
- profile → all own playlists (paginated) → items for each → liked songs → saved albums → followed artists → top tracks and artists at all three time ranges → recently played.
- Persists every track object in full, including `external_ids.isrc`, into `SourceTrack` with `rawJson`.
- Since batch endpoints are gone, **never** fetch a track individually when it arrived embedded in a playlist or album response. Maintain a `spotifyId → SourceTrack` cache and check it before every single-ID call. Log a counter of "calls avoided by cache" — I want to see it.
- Adaptive rate limiting: token bucket, on 429 respect `Retry-After` and halve the rate for the rest of the run, recovering slowly. Persist queue position so an interrupted harvest resumes rather than restarts.
- After completion, show a **"Spotify data secured"** summary: N playlists, N unique tracks, N with ISRC, and a one-line note that this data survives cancellation.

### 7.2 Importers — the answer to "paste a link"

Because the API only returns contents for playlists I own, the paste box needs to be smart about what it's been given rather than just failing.

**One input, several resolvers, tried in order:**

1. **Own Spotify playlist URL/URI** → API, full contents. The happy path.
2. **Someone else's playlist / editorial / algorithmic URL** → API returns metadata only. Detect this precisely (owner ID ≠ my ID, or empty items with non-zero total) and **do not show a generic error**. Show the playlist's name and cover, then the workaround, inline and specific:
   > This playlist isn't yours, so Spotify won't hand over the tracks. Open it in Spotify, select all tracks (Ctrl/Cmd+A), right-click → Add to playlist → New playlist. Come back and it'll be in your list.
   Include a **"Recheck my playlists"** button right there that re-syncs `/me/playlists` and picks up the copy. Test this flow end to end — it's the one I'll use most.
3. **Spotify GDPR data export** (a `.zip` from spotify.com/account/privacy) → parse `Playlist1.json`, `YourLibrary.json`, `Follow.json`, and `StreamingHistory*.json` / `Streaming_History_Audio*.json`. This path needs no API, no Premium, and includes the complete streaming history that the recommendation engine wants. Make it a first-class importer with a real drag-and-drop zone, not a hidden CLI script.
4. **CSV** → autodetect Exportify's column layout and a few other common exporters; fall back to a column-mapping UI.
5. **Plain text** → one track per line, tolerant of `Artist - Title`, `Title - Artist`, `1. Artist – Title (Remaster)`, numbered lists, and pasted tracklists with junk. Show a parse preview with per-line confidence and let me fix the ambiguous ones.
6. **Other services** → Apple Music / YouTube Music / Deezer / Tidal playlist URLs, resolved via public metadata. Nice to have, phase 5.

There's also an unofficial route — the Spotify web player's internal GraphQL API, authenticated with an `sp_dc` cookie, which does return contents for non-owned and algorithmic playlists. It's undocumented, outside the developer terms, and breaks without warning. **Build the resolver interface so it could be added as a plugin, ship nothing that uses it, and don't make any feature depend on it.** If I want it later I'll add it myself; I'd rather the core app never break because Spotify changed a query hash.

### 7.3 Matching engine

The quality of this determines whether the app feels magic or infuriating. Put it in `packages/core` with a fixture-based test suite.

**Normalization** (one function, heavily tested):
- NFKD, strip diacritics, lowercase, collapse whitespace
- strip bracketed noise: `remaster(ed) YYYY`, `deluxe`, `radio edit`, `single version`, `mono/stereo`, `bonus track`, `explicit`, `clean`, `expanded`, `anniversary`
- extract and keep separately: `feat./ft./featuring X`, `live`, `acoustic`, `demo`, `instrumental`, `remix by X` — these are **not** noise, they identify different recordings and must not be normalized away
- normalize `&`/`and`/`+`, leading `the `, punctuation, and unicode quotes/dashes
- split multi-artist strings on `,`, `;`, `/`, `feat.`, `x`, `&` into an ordered array

**Cascade**, first hit wins, each recording its confidence:

| # | Method | Confidence | Notes |
|---|--------|-----------|-------|
| 1 | ISRC exact | 1.00 | Requires local files tagged with ISRC — the post-processor writes it |
| 2 | MusicBrainz recording ID | 0.98 | |
| 3 | Chromaprint/AcoustID fingerprint | 0.95 | Also catches re-encodes |
| 4 | Normalized artist + title + duration within ±3s | 0.90 | |
| 5 | Normalized title + duration ±3s, artist token-set ratio ≥ 0.85 | 0.75 | |
| 6 | Fuzzy below that | < 0.75 | → `NEEDS_REVIEW`, never auto-acted |

Guard rails: a duration mismatch beyond ±10s vetoes any non-ISRC match. A live/acoustic/remix variant marker present on one side and absent on the other drops confidence by 0.3. Auto-accept ≥ 0.90, review queue between 0.6 and 0.90, treat as missing below.

The review queue is a keyboard-driven screen — `J`/`K` to move, `Enter` to accept, `X` to reject, `D` to queue download. I should be able to clear 200 ambiguous matches in a few minutes.

### 7.4 Library scanner

- Initial full scan with a concurrency-limited walk; incremental afterwards via `chokidar` plus a nightly full reconcile.
- Read tags with `music-metadata`. Read duration and stream properties with `ffprobe` when tags are unreliable.
- `contentHash` must hash the **audio stream** (`ffmpeg -map 0:a -f md5 -`), not the file, so a retagged file isn't seen as new.
- Fingerprint with `fpcalc` (chromaprint) in a separate lower-priority queue — it's CPU-heavy, so make it resumable and throttled.
- Optional AcoustID lookup to backfill MBID and ISRC on files that lack them. Rate-limit to 3 req/s per their terms; make the API key optional and skip cleanly without it.

### 7.5 Download providers

One interface, several adapters, ordered by priority, each with independent concurrency and rate limits so one provider being throttled doesn't stall the rest.

```ts
interface DownloadProvider {
  name: string
  enabled: boolean
  priority: number
  concurrency: number
  rateLimit: { requests: number; per: number }
  health(): Promise<HealthStatus>
  search(q: TrackQuery): Promise<Candidate[]>
  download(c: Candidate, dest: string, onProgress: (p: Progress) => void): Promise<DownloadedFile>
}
```

Adapters, in default priority order — all optional, all configured from the UI, and the app must work with only the last one enabled:

1. **slskd** (Soulseek daemon, REST API) — best source for real rips and lossless. Route through Gluetun. Needs candidate filtering by format, bitrate, and uploader queue length.
2. **streamrip / deemix** — Deezer, Qobuz, Tidal, SoundCloud if I supply credentials. Proper FLAC with clean tags.
3. **Bandcamp** via yt-dlp — often the legitimate source for smaller artists.
4. **YouTube Music** via `ytmusicapi` for resolution + `yt-dlp` for the pull. Resolve by searching YTM's catalog and matching on duration and album, rather than handing yt-dlp a raw text query — that's the difference between getting the track and getting a ten-hour loop.
5. **spotdl** — convenient but it needs Spotify credentials for metadata, so it dies with my subscription. Ship it disabled by default with that noted in the UI.
6. **Lidarr handoff** — for anything better handled as a full album, push to Lidarr's API instead of downloading directly.

**Candidate scoring** before download: duration within ±5s of the source, format/bitrate against my minimum, title/artist similarity, penalties for `live`, `cover`, `karaoke`, `sped up`, `nightcore`, `8D`, `reverb`, `lyrics` when the source has none, and a hard reject if duration is more than 2× the target. Log the scored candidate list on every attempt — when a wrong track lands I want to see why it won.

**Failure handling:** on failure, fall through to the next provider automatically. After all providers fail, mark `ABANDONED` with the full attempt history and surface it in a "couldn't find these" view where I can paste a URL manually. Retries use exponential backoff with jitter and never re-run a provider that returned `NO_RESULTS` for the same query within 24h.

### 7.6 Post-processing

Every download runs this chain before it's allowed into the library:

1. **Verify** — ffprobe: real audio, expected duration, not silent, not truncated. Reject and fall through to the next provider on failure.
2. **Transcode policy** — never re-encode a lossless source. Optionally normalize container/format for lossy sources; default off.
3. **Tag** — write `title`, `artist`, `albumartist`, `album`, `date`, `track`, `disc`, `genre`, plus **`isrc`**, `musicbrainz_trackid`, and a custom `CRATE_SOURCE` tag naming the provider. ISRC comes from the Spotify metadata we harvested — this closes the loop so future matches hit tier 1.
4. **Cover art** — embed if missing, from the source metadata or Deezer/MusicBrainz Cover Art Archive.
5. **File placement** — configurable template, default `{albumartist}/{album} ({year})/{disc}-{track:02} {title}.{ext}`, with a sanitizer for filesystem-hostile characters that doesn't mangle non-ASCII.
6. **Fingerprint, then dedupe check** — if it collides with something already present, apply the §7.7 keeper rule instead of blindly adding a second copy.
7. **Register and rescan** — DB update, then a debounced Navidrome `startScan` (batch a burst of downloads into one scan, don't fire per file).

Compute `qualityScore` here: format rank (FLAC/ALAC 100, Opus 80, MP3 320 75, AAC 256 70, MP3 V0 70, down to 20) + bitrate/sample-rate bonuses + tag completeness + embedded art + source trust. This single number drives keeper selection.

### 7.7 Duplicate detection

Grouping passes, most to least confident:

1. Identical audio `contentHash` — certain
2. Identical chromaprint fingerprint — near-certain, catches re-encodes at different bitrates
3. Same ISRC or MBID with duration within ±2s
4. Normalized artist + title with duration within ±2s — likely, needs review
5. Same artist + title but duration differs by more than 5s — flag as **variant**, not duplicate, and default to keeping both (this is usually a live or remix version, and auto-deleting these is how a dedupe tool loses my trust permanently)

**Resolution:**
- Keeper = highest `qualityScore`; tie-break on tag completeness, then embedded art, then a proper album folder over a loose file, then oldest mtime.
- Non-keepers **move to `TRASH_ROOT`** preserving relative paths, with a JSON manifest per operation. Never `unlink`. An **Undo** button restores an entire operation. A configurable retention job empties trash after N days, default 30, off by default.
- **Dry run is the default.** Every batch shows exactly what will move before anything moves.
- Review UI: grouped rows, keeper preselected and highlighted, inline audio preview of each candidate, a diff of the differing attributes only, `A` to accept a group, `Shift+A` to accept all groups above a confidence threshold.

### 7.8 Recommendations — the part that has to actually be good

Spotify's recommendation endpoint is gone and my subscription is going away, so this is entirely self-hosted. Requirement: **it produces six named, rotating mixes that refresh daily and appear in Navidrome without me doing anything.** If a mix isn't good enough to press play on, the engine has failed.

**Taste model.** Build from everything available:
- Full Spotify streaming history from the GDPR export — this is the richest signal by far, with timestamps and `ms_played`. Treat `ms_played < 30000` as a skip. Import it during setup and tell me to request it early, since it takes weeks to arrive.
- Spotify top tracks/artists across all three time ranges, and recently-played, harvested while the connector lives.
- **Navidrome play counts, star ratings and last-played**, pulled continuously via Subsonic `getStarred`/`getAlbumList2`/`getNowPlaying`. After Spotify is gone this becomes the live signal, so it needs to work from day one.
- Optional Last.fm scrobbles if I connect an account.

Compute per-artist and per-track `affinity`: play count weighted by an exponential recency decay (half-life ~90 days, configurable), boosted by stars, penalized by skip rate.

**Similarity graph.** Populate `ArtistEdge` from several sources and blend the weights:
- **Last.fm** `artist.getSimilar` and `track.getSimilar` — free key, real collaborative-filtering data, still the best open source of "people who like X also like Y"
- **Deezer public API** — `/artist/{id}/related`, no auth required
- **YouTube Music** via `ytmusicapi` — `get_watch_playlist(radio=True)` returns YTM's actual radio sequence, which is the closest freely available thing to Daily Mix quality; harvest co-occurrence from radios seeded on my top tracks
- **Co-occurrence** mined from my own playlists and listening sessions — artists that repeatedly appear near each other in my history are related *for me*, which generic data can't know
- Explicitly **do not** build on ListenBrainz. I've tried it and don't want it.

**Mix generation** (nightly job):
- Run community detection (Louvain) over the subgraph of library artists weighted by affinity → natural clusters. These become stable mix slots 1–6, so "Mix 3" keeps meaning roughly the same thing week to week, the way Daily Mix does.
- Name each mix from its top artists: *"Mix 2 — Fontaines D.C., IDLES, Shame and more"*. Never generic names.
- Fill each with ~50 tracks: weighted sampling by affinity × cluster fit × a recency penalty (nothing played in the last 14 days, nothing repeated across mixes on the same day), max 2 tracks per artist, and a deliberate mix of deep familiarity and things I haven't played in months.
- **Reserve 15–25% for discovery slots** filled from high-weight graph neighbours not yet in the library. If `autoDownloadDiscovery` is on, these queue downloads automatically and land in the mix on the next run — recommendations that fulfil themselves, which is the whole point.
- **New Release Radar**: weekly, query MusicBrainz release-groups for high-affinity artists since the last run (Spotify's new-releases endpoint is gone), and either queue downloads or push to Lidarr.
- Track outcomes: log which recommended tracks got played versus skipped, feed that back as negative weight. The engine should get better with use.

**LLM curator** (optional module, on by default since I have Ollama locally):
- Configurable backend — Ollama endpoint and model, or an Anthropic API key.
- Sends a compact taste profile (top artists, recent plays, cluster summaries) and asks for themed playlists with a short rationale: *"Late-night driving, mostly instrumental, from my library."*
- **Strict JSON output, and every returned track resolved against the actual library before use. Anything that doesn't resolve is dropped silently, with a count logged.** Models will invent plausible tracks; the resolver is the guardrail, not a nicety.
- Also useful for naming and describing the algorithmic mixes in a way that isn't robotic.
- A free-text box on the mixes page: describe a mood, get a playlist written to Navidrome in seconds.

### 7.9 Playlist output

- Write **`.m3u8`**, UTF-8 without BOM, `#EXTM3U` header, `#PLAYLIST:<name>`, `#EXTINF:<seconds>,<Artist> - <Title>` per entry.
- Paths **relative to `MUSIC_ROOT`** by default (most reliable for Navidrome), absolute as an option. Always translated through §5's mapping.
- Write atomically: temp file, `fsync`, rename. A half-written playlist that Navidrome picks up mid-write is a mess.
- Unmatched tracks are preserved in a sidecar `<name>.missing.json` so a later run can fill the gaps in place without me re-importing anything.
- **Also** create/update playlists directly via the Subsonic API (`createPlaylist`/`updatePlaylist`) so they appear immediately without waiting for a filesystem scan. Both paths, configurable, m3u as the source of truth.
- Optional reverse sync: push a local playlist back up to Spotify via `POST /me/playlists` + `POST /playlists/{id}/items`, while that still works.

### 7.10 Automation

Everything on a schedule, all intervals configurable, all with a manual "run now":

| Job | Default | Does |
|---|---|---|
| Spotify sync | hourly | Own playlists; skip any whose `snapshot_id` is unchanged |
| Library scan | nightly + live watch | New/changed/removed files |
| Match sweep | after every scan/import | Re-attempt `MISSING` and low-confidence matches with new library state |
| Download queue | continuous | Drains with per-provider limits |
| Dedupe scan | weekly | Populates groups; never auto-deletes above the auto-resolve threshold |
| Mix generation | daily 05:00 | Regenerates the six mixes, writes playlists |
| Release radar | weekly | New releases from high-affinity artists |
| Playlist rewrite | on change | Debounced, then one Navidrome rescan |
| Trash retention | daily | Purges trash older than N days if enabled |

Plus a **first-run wizard** that goes: connect Spotify → verify paths → harvest → scan library → review the match report → choose what to download → go. One flow, resumable, and it should be plausible to have music arriving within ten minutes of first launch.

---

## 8. Interface

Screens, in the order I'll use them:

- **Overview** — library coverage (how much of my Spotify world exists locally), active jobs, provider health, recent activity. Not a dashboard of vanity charts; a status board I can read in three seconds.
- **Import** — the paste box, drop zone, and history of past imports with their outcomes.
- **Playlists** — imported and generated, coverage per playlist, per-track match state, a "fill gaps" action.
- **Queue** — everything downloading, with the provider chain visible per item and why attempts failed.
- **Review** — ambiguous matches, keyboard-first.
- **Duplicates** — groups, keeper preselected, dry-run then apply, undo.
- **Mixes** — today's six, why each exists, what's new in each, the free-text curator box.
- **Library** — searchable table of everything, quality column, source column.
- **Settings** — connections, providers, paths, schedules, diagnostics.

Behaviour that matters more than looks: optimistic updates, live progress without refresh, `Cmd+K` command palette, every destructive action reversible, every empty state explaining what to do rather than saying "no data".

---

## 9. Design direction

Light mode, modern, and specifically **not** looking like it fell out of a template. Read `/mnt/skills/public/frontend-design/SKILL.md` and do the two-pass process it describes — brainstorm tokens, critique them against this brief, then build.

**The concept: a daylight studio console.** This is a control surface for moving thousands of files around, so it should feel like well-made equipment — dense, legible, honest about status, with the confidence of something built for a professional who uses it every day. Not a consumer music app, not a SaaS marketing page.

**Palette** — cool neutrals with a faint green cast, like anodized panel metal, not warm paper:

```
--panel-bg     #F1F3F1   page
--surface      #FFFFFF   cards, tables
--recess       #E6E9E5   inset areas, table headers, empty states
--hairline     #D2D7D1
--ink          #14181A   primary text
--ink-muted    #5E6862   secondary text
--accent       #E0A100   active/running — a lit-meter amber, used sparingly
--ok           #1F7A5C   matched, complete
--warn         #8A6D00   needs review, duplicate
--error        #B3341F   missing, failed
```

Primary buttons are solid `--ink`. Amber is reserved for *things currently happening* — if everything is idle, there's almost no amber on screen, and that's the point.

**Type** — three roles, deliberately different from each other:
- Labels and section headers: a grotesque set in uppercase with wide tracking, small size, like silkscreen on a panel (Archivo, or Archivo Narrow for tight columns)
- Body and UI: something with more warmth than Inter — Public Sans or Inter Tight
- **All data in mono** — durations, bitrates, ISRCs, file paths, counts, percentages (JetBrains Mono). Tabular numerals everywhere numbers align. This is a big part of the character: the data reads like readouts.

**Signature element: segmented meters.** Progress, library coverage, provider health, and match confidence all render as segmented LED-style ladders rather than smooth bars — discrete blocks with a lit/unlit state. Use it consistently everywhere something has a level, and it becomes the thing the app is recognized by. Spend the boldness here and keep everything else quiet.

**Structure:** 1px hairlines and background tint for separation, not drop shadows. Border radius 4px maximum. Dense tables, 36–40px rows, sticky headers, monospace columns aligned right. Left rail navigation with uppercase labels and live counts. Generous space between sections, tight space within data.

**Anti-patterns — do not do any of these:**
- Warm cream backgrounds (~`#F4F1EA`) with a big serif display and a terracotta accent (~`#D97757`). This is currently the single most recognizable AI-design signature and it would defeat the entire brief.
- Purple/indigo→pink gradients, gradient buttons, glassmorphism, blurred colour blobs
- `rounded-2xl` cards with `shadow-xl` floating on a light background
- Emoji in headings or buttons
- A centered hero with a tagline like "Your music, liberated ✨"
- A three-card feature grid with an icon in a rounded square above each
- Icons decorating every heading
- Default shadcn styling left untouched — use it as behaviour, restyle it completely
- Toast spam. Use a persistent activity drawer instead; this app does long work and toasts are the wrong shape for it.

**Motion:** 120–180ms ease-out on state change only. Meters animate when values change. No page transitions, no scroll-triggered anything, `prefers-reduced-motion` respected.

**Copy:** plain and specific. "Couldn't find 12 tracks" not "Some items were unsuccessful". Errors say what happened and what to do. Buttons name their action and keep that name through the flow.

Build to a real quality floor: responsive down to a phone (I'll check download progress from bed), visible keyboard focus, and every screen usable without a mouse.

---

## 10. Phases

Ship each phase working before starting the next. I'd rather have phase 3 solid than phase 7 half-built.

**1 — Foundations.** Monorepo, Prisma schema, Docker Compose (web, worker, postgres, redis), auth, settings, path mapping with the verify diagnostic, job infrastructure with SSE progress, design system and shell.
*Done when:* I can log in, configure paths, run a trivial job, and watch it progress live.

**2 — Library.** Scanner, tag reading, ffprobe, hashing, fingerprinting, library table UI.
*Done when:* my whole existing library is indexed with accurate metadata and I can search it.

**3 — Spotify + import + matching.** OAuth, harvest-everything, all importers from §7.2, the matching cascade, coverage report, review queue.
*Done when:* I can import my entire Spotify account and see exactly what I already own and what's missing — no downloading yet.

**4 — Acquisition.** Provider interface, YouTube Music first (it needs no credentials), then slskd and streamrip, candidate scoring, the post-processing chain, queue UI.
*Done when:* missing tracks download unattended, land tagged and correctly placed, and Navidrome sees them.

**5 — Playlists.** m3u8 writer, Subsonic playlist API, gap-filling, auto-rewrite, scan triggering.
*Done when:* an imported playlist plays in Navidrome end to end.

**6 — Duplicates.** Grouping passes, quality scoring, keeper selection, dry-run/apply/undo, review UI.
*Done when:* it finds the duplicates I know about, correctly refuses to touch live/remix variants, and I trust it enough to apply without reading every row.

**7 — Recommendations.** Taste model, similarity graph, mix generation, discovery slots with auto-download, release radar, LLM curator.
*Done when:* six mixes appear in Navidrome every morning and I'd genuinely press play on at least four.

**8 — Polish.** First-run wizard, command palette, mobile, backup/restore, docs.

---

## 11. Engineering conventions

- TypeScript strict. Zod at every boundary — API responses, uploads, LLM output, config. Never trust an external shape.
- Server Actions for mutations, route handlers only for webhooks/SSE/OAuth callbacks.
- Vitest for `packages/core`, with real fixture data: the nastiest track titles I own, unicode, `feat.` in five formats, remaster suffixes, tracks that differ only by duration. Matching and dedupe need genuine coverage; the UI does not.
- Structured logging (pino) with a job ID on every line. `JobRun.logsJson` is what the UI reads.
- Secrets encrypted at rest, decrypted only in the worker. Never send a provider credential to the client.
- All external calls behind an adapter with a timeout, retry policy, and circuit breaker. Any integration must be disableable and the app must run without it.
- Migrations are checked in; nothing runs `db push` against my data.
- **Don't mock anything into the UI.** If a feature isn't built, the screen says so. I'd rather see an honest empty state than a fake chart.
- Comment the non-obvious parts — the normalization rules and the scoring weights especially. I'll be tuning those.

---

## 12. Ask me rather than guessing

Stop and ask when you hit any of these:

- Anything that deletes or moves a file outside the designed trash flow
- A schema change that would need a destructive migration
- Adding a paid or account-requiring service to the critical path
- A provider whose setup is genuinely involved (slskd, Deezer ARL) — ask before writing the adapter, in case I don't want it
- Any point where the design would need a Spotify endpoint that §2 says is unavailable — that's a signal the design is wrong, not that the constraint should be worked around

And if the Spotify API has changed again since this brief was written: say so plainly and propose the adjustment before building around a stale assumption.