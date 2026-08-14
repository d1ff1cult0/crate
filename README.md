# Crate

Self-hosted Spotify → Navidrome migration and library tool. Single user, runs in Docker.

**Spotify is a harvesting source with an expiry date, not a dependency.** Everything
fetched is persisted permanently on first sight, and every read path in the UI works with
the connector disconnected. That is the one rule the whole design answers to.

---

## What it does

| | |
|---|---|
| **Harvest** | Pulls your entire Spotify account — playlists, saved tracks, saved albums, followed artists, top items, recently played — into Postgres, with the raw payloads kept forever. Resumable, rate-limit aware, and it knows the difference between a quota exhaustion and a rolling-window 429. |
| **Import** | Paste a playlist URL, drop a CSV, paste a block of text, or feed it the Spotify GDPR streaming-history export. |
| **Scan** | Walks your library, reads tags, probes with `ffprobe`, hashes the *audio stream* so retagging never looks like a new file, fingerprints with `fpcalc`, and backfills ISRC and MusicBrainz ids through AcoustID. |
| **Match** | A confidence cascade from ISRC down to fuzzy title matching, with duration vetoes and variant detection. Nothing below 0.90 is accepted without you. |
| **Download** | Provider chain with automatic fall-through, candidate scoring before anything is fetched, and the full scored list logged on every attempt. |
| **Post-process** | Verify → transcode policy → tag (including the harvested ISRC) → cover art → placement → dedupe check → register → one debounced Navidrome rescan. |
| **Playlists** | Atomic `.m3u8` writes with mapped paths and `.missing.json` sidecars, plus a Subsonic push so they appear without waiting for a scan. |
| **Duplicates** | Five grouping passes, quality-based keeper selection, dry run by default, trash instead of deletion, and a working undo. |
| **Recommendations** | Six stable daily mixes from your own listening history and a blended artist graph, plus a free-text LLM curator whose every suggestion is checked against your actual library. |

---

## Requirements

- Docker and Docker Compose
- A Spotify app (client ID only — PKCE needs no secret), while your Premium lasts
- Optional: Navidrome, Last.fm API key, AcoustID key, Ollama, Lidarr

The worker image carries `ffmpeg`, `ffprobe`, `fpcalc` and `yt-dlp`. They are runtime
dependencies of the post-processing and fingerprint queues, so a worker image without them
fails at job time rather than at boot.

---

## Setup

```bash
cp .env.example .env
```

Fill in `.env`. Two of them matter more than the rest:

```bash
# 32 random bytes, base64. Generate: openssl rand -base64 32
# LOSING THIS MEANS RE-ENTERING EVERY STORED CREDENTIAL. Back it up separately —
# it is NOT in the app's own backups, deliberately.
CRATE_ENCRYPTION_KEY=

# HOST paths. The containers see /music, /staging, /trash.
MUSIC_ROOT=./data/music
STAGING_ROOT=./data/staging
TRASH_ROOT=./data/trash
```

Then:

```bash
docker compose up -d
docker compose logs -f worker
```

Open the app and work down **Setup**. It reads its state from the database rather than
storing a wizard cursor, so you can leave and come back and it will show you where things
actually stand.

### The one thing that will bite you

**The path Navidrome sees is not the path this app sees.** Set `pathMappings` in Settings
and run **Verify paths** — it writes a probe playlist, triggers a Subsonic scan, polls for
it, and reports *which segment* of the mapping is wrong.

If a playlist is empty in Navidrome, check the mapping first. It is almost always the
mapping.

---

## Development

```bash
pnpm install
pnpm db:migrate          # migrations are CHECKED IN — never db push against real data
pnpm dev                 # web + worker in watch mode

pnpm test                # vitest across core, integrations and providers
pnpm typecheck           # tsc --noEmit across the workspace
```

`PORT` overrides the web port (`PORT=3199 pnpm dev:web`).

### Layout

```
apps/web/          Next.js — UI, route handlers, server actions
apps/worker/       Long-running Node process — BullMQ consumers, schedulers
packages/db/       Prisma schema + generated client
packages/core/     Pure domain logic, no I/O — normalization, matching, scoring, dedupe,
                   affinity, graph clustering, mix sampling. This is where the tests live.
packages/providers/    Download adapters behind one interface
packages/integrations/ Spotify, Subsonic, Last.fm, Deezer, YouTube Music, MusicBrainz,
                       AcoustID, Cover Art Archive, LLM backends
```

`packages/core` has no network and no filesystem access. If something there reaches for
`fetch` or `fs`, the logic belongs in `integrations` or `worker` and the pure part belongs
in `core`. That is what makes matching, dedupe and mix sampling testable against fixtures
without spinning anything up.

**The worker is a separate process.** Downloads, scans and harvests take minutes and must
survive a redeploy, so they never run in a request handler. Route handlers exist for
webhooks, SSE, the OAuth callback, and enqueueing.

---

## Operational notes

### Nothing is ever deleted

Duplicate losers and superseded downloads move to `TRASH_ROOT` with their relative paths
preserved, recorded in a manifest that is written both to the database *and* alongside the
files. Undo restores an entire operation. The only code that genuinely deletes is the
retention job, which is off by default, has a minimum age, and refuses any path that does
not resolve under `TRASH_ROOT`.

### Dry run is the default

Every batch operation shows exactly what would move — paths and megabytes, not a count —
before anything moves. `dedupeDryRunOnly` is on by default and blocks applies at the worker,
so the scheduled path is covered too and it cannot be bypassed through the API.

### Variants are not duplicates

Same artist and title with durations more than 5 seconds apart is a live take, an extended
cut or a remix. Those are grouped for visibility, given no keeper, and excluded from every
apply path including "accept all above a threshold". Auto-deleting someone's live version
is how a dedupe tool loses trust permanently.

### Backups

Settings → Backup and restore. The file carries everything harvested from Spotify, every
match decision you made, your listening history and the artist graph. Job logs and download
attempts are excluded — they are the bulkiest tables and worth nothing a week later.

Credentials are included as ciphertext. They are only readable with the same
`CRATE_ENCRYPTION_KEY`, which is why that key needs backing up somewhere else.

Restore merges by id and is idempotent — running the same file twice does the same thing as
running it once.

### Scheduled work

| Job | Default |
|---|---|
| Spotify sync | hourly, skipping unchanged `snapshot_id`s |
| Library scan | nightly, full reconcile weekly |
| Match sweep | after every scan and import |
| Fingerprint sweep | hourly, throttled and resumable |
| Dedupe scan | weekly — groups only, never moves anything |
| Mix generation | daily 05:00 |
| Release radar | weekly |
| Trash retention | daily, off by default |

Everything has a manual "run now", from the screen it belongs to or from `Cmd+K`.

---

## Documentation

- **`CLAUDE.md`** — conventions, gotchas, and the rules that are not negotiable
- **`PROMPT.md`** — the original build brief
- **`docs/spotify-api-state.md`** — verified API surface, date-stamped. **Overrides
  `PROMPT.md` §2 wherever they disagree.**
- **`docs/plan.md`** — phase plan, design arguments, risk register
- **`docs/DECISIONS.md`** — every decision made without the owner in the loop, and why
