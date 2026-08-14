# Crate

Self-hosted Spotify → Navidrome migration and library tool. Single user, runs in Docker on `d1ff1cult-server`.

The governing idea: **Spotify is a harvesting source with an expiry date, not a dependency.** Everything fetched is persisted permanently on first sight, and every read path in the UI works with the connector disconnected. If that ever stops being true, the change is wrong.

Full build brief: `PROMPT.md`. Verified API constraints: `docs/spotify-api-state.md` — **that file overrides `PROMPT.md` §2 wherever they disagree.** Phase plan and open design arguments: `docs/plan.md`.

---

## Stack

Non-negotiable, it's what the owner works in:

- **Next.js 15** App Router + **TypeScript** (strict) + **Tailwind v4**
- **Prisma** + **PostgreSQL**
- **BullMQ** + **Redis** for the job queue
- **Vitest** for `packages/core`
- **pino** for structured logging
- **Zod** at every external boundary
- **Ollama** (local, GPU) as the default LLM backend; Anthropic API key optional

---

## Layout

```
apps/
  web/          Next.js — UI, route handlers, server actions
  worker/       Long-running Node process — BullMQ consumers, schedulers, watchers
packages/
  db/           Prisma schema + generated client (shared by web and worker)
  core/         Pure domain logic, no I/O — normalization, matching, scoring, dedupe, mixes
  providers/    Download provider adapters behind one interface
  integrations/ Spotify, Navidrome/Subsonic, Last.fm, Deezer, YouTube Music, MusicBrainz, AcoustID, Lidarr
docs/
  spotify-api-state.md   Verified API surface, date-stamped
  plan.md                Phases, risks, design disagreements
```

**`packages/core` has no network and no filesystem access.** It is pure functions over plain data, and it is where the test suite lives. If you reach for `fetch` or `fs` in `core`, the logic belongs in `integrations` or `worker` and the pure part belongs in `core`. This is what makes matching and dedupe testable against fixtures without spinning anything up.

**The worker is a separate process.** Never run a download, scan, or harvest from a request handler — they take minutes and must survive redeploys. Route handlers exist only for webhooks, SSE, and the OAuth callback.

---

## Commands

*(Populated as the scaffold lands — placeholders below reflect the intended shape, not working commands yet.)*

```bash
pnpm dev              # web + worker in watch mode
pnpm dev:web
pnpm dev:worker
pnpm build
pnpm test             # vitest, packages/core
pnpm test:watch
pnpm typecheck        # tsc --noEmit across the workspace
pnpm lint

pnpm db:migrate       # prisma migrate dev — migrations are CHECKED IN
pnpm db:deploy        # prisma migrate deploy (production path)
pnpm db:studio

docker compose up -d
docker compose logs -f worker
```

---

## Conventions

- **TypeScript strict.** No `any` at boundaries; parse, don't assert.
- **Zod at every boundary** — Spotify/Subsonic/Last.fm responses, uploads, LLM output, config, env. External shapes are never trusted.
- **Server Actions for mutations.** Route handlers only for webhooks, SSE, OAuth callback.
- **Queues, one per concern**, each with its own concurrency and rate limits: `spotify-sync`, `spotify-isrc-backfill`, `library-scan`, `match`, `download`, `postprocess`, `fingerprint`, `playlist-write`, `recommend`.
- **Idempotency everywhere.** Deterministic BullMQ job IDs; re-running any job converges rather than duplicating.
- **Every job writes a `JobRun` row** with structured logs. The UI reads `JobRun.logsJson` — it is the debugging surface, so log like someone will read it three days later.
- **Every log line carries the job ID.**
- **Progress via SSE** from `/api/events`, backed by Redis pub/sub, falling back to polling. No websocket server.
- **Secrets encrypted at rest, decrypted only in the worker.** A provider credential must never reach the client.
- **Every external call** goes through an adapter with a timeout, retry policy, and circuit breaker. Every integration is disableable and the app runs without it.
- **Migrations are checked in.** Never run `db push` against real data.
- **Never mock anything into the UI.** Unbuilt features say so. An honest empty state beats a fake chart.
- **Comment the non-obvious** — normalization rules and scoring weights especially; they will be tuned by hand.
- **Tests where they earn it:** matching, normalization, dedupe, scoring get genuine fixture coverage (nasty unicode, `feat.` in five formats, remaster suffixes, tracks differing only by duration). The UI does not.

### Design system

Light mode, "daylight studio console" — see `PROMPT.md` §9 for the full direction, palette, and the anti-pattern list. Load `/mnt/skills/public/frontend-design/SKILL.md` and run its two-pass process before building UI.

Load-bearing points: primary buttons solid `--ink`; amber (`--accent`) **only** for things currently happening; all data in mono with tabular numerals; **segmented LED-style meters** for every level (progress, coverage, health, confidence) — that's the signature element; 1px hairlines not shadows; radius ≤ 4px; persistent activity drawer, **never toast spam**.

---

## Gotchas

### Path mapping — the classic failure in this class of app

**The path Navidrome sees is not the path this app sees.** Three roots, each with an explicit host↔container mapping:

- `MUSIC_ROOT` — the library Navidrome scans
- `STAGING_ROOT` — where downloads land before post-processing
- `TRASH_ROOT` — where dedupe losers go

`pathMappings: [{ appPath, navidromePath }]` lives in settings, and **every path written to an m3u is translated through it.** The "Verify paths" diagnostic (writes a probe playlist → Subsonic `startScan` → poll `getScanStatus` → `getPlaylists`) must run automatically on first setup and must report *which segment* of the mapping is wrong, not just that something failed.

When debugging "the playlist is empty in Navidrome", check the mapping first. It's almost always the mapping.

### Container vs host paths

Bind mounts differ per container: the app, Navidrome, Jellyfin, and Lidarr can each see the same files at different paths. Nothing may assume its own view is universal. Store paths in the DB in **app-container** terms and translate on the way out.

`m3u8` paths are **relative to `MUSIC_ROOT` by default** — most reliable for Navidrome — with absolute as an option.

### Gluetun / VPN routing

Anything that must be VPN-routed (slskd, torrent-adjacent providers) runs `network_mode: service:gluetun`. Such a container **has no ports of its own** — it publishes through gluetun, so the app reaches it at gluetun's published port, not at `container:port`. `depends_on` gluetun, and expect the provider to be unreachable while the VPN reconnects: provider `health()` must treat that as degraded, not fatal.

### Spotify — read `docs/spotify-api-state.md` before touching the connector

The high-cost traps, all verified 2026-08-14:

- **Album tracks have no ISRC.** `GET /albums/{id}/tracks` returns SimplifiedTrackObjects with no `external_ids`. Playlist items and `/me/tracks` *do* carry full TrackObjects with ISRC. So: never re-fetch a track that came from a playlist or `/me/tracks`; **do** queue an ISRC backfill for album-only tracks — one request each, on the lowest-priority queue, after the primary harvest.
- **Batch endpoints are gone. One HTTP request per track.** Maintain the `spotifyId → SourceTrack` cache and check it before every single-ID call. Log the "calls avoided by cache" counter — the owner wants to see it.
- **Non-owned playlists:** `GET /playlists/{id}/items` → **403**; `GET /playlists/{id}` → succeeds with the `items` field **absent**. Don't test for "empty items with non-zero total" — that state doesn't exist. Owner-ID comparison alone is also wrong: **collaborators get full contents too.**
- **Two kinds of 429.** Body containing `"reason": "QUOTA_EXCEEDED"` = quota exhausted; pause and checkpoint, don't slow down. Anything else = rolling 30s window rate limit; honour `Retry-After`, halve the rate, recover slowly. Never a fixed sleep.
- **Market must be explicit.** `GET /markets` is gone and user `country` is deprecated, but omitting `market` makes content read as unavailable. Use the `SPOTIFY_MARKET` setting (default `BE`) on every catalog call.
- **Use `account_id`**, not `id`, as the stable account identity. `owner.id` on playlists is still an `id`, so keep both.
- **Field names coexist during the transition:** read `items ?? tracks` and `item ?? track`. Docs samples are stale and still show removed fields. Parse everything as optional, pass unknown keys through, and always persist the raw payload to `rawJson`.
- **Search: max limit 10, default 5**, offset ≤ 1000. Paginate.
- **`/artists/{id}/albums`: max limit 10.**
- **Dev Mode requires the owner's active Premium.** When it lapses, the connector dies. 5 authorized users per app; 25 Client IDs per developer; quota counted per developer account.
- **A 401/403 from Spotify degrades to local data with a quiet banner.** It never errors out and never nags.
- **Never design around a dead endpoint.** If a feature needs one, the design is wrong — stop and ask (`PROMPT.md` §12).

### Audio tooling

The worker image needs **`ffmpeg`/`ffprobe`**, **`fpcalc`** (chromaprint), and whatever `yt-dlp` requires. They're runtime dependencies of the postprocess and fingerprint queues — a worker image without them fails at job time, not at boot.

- `contentHash` hashes the **audio stream** (`ffmpeg -map 0:a -f md5 -`), not the file, so retagging doesn't look like a new file.
- Fingerprinting is CPU-heavy: separate lower-priority queue, resumable, throttled.
- AcoustID: rate-limit to 3 req/s per their terms; the API key is optional and its absence must skip cleanly.

### Navidrome / Subsonic

- Debounce `startScan` — batch a burst of downloads into one scan, never one per file.
- Playlists are written **both** as m3u8 and via Subsonic `createPlaylist`/`updatePlaylist` so they appear without waiting for a scan. **m3u is the source of truth.**
- Write playlists atomically: temp file → `fsync` → rename. A half-written m3u picked up mid-scan is a mess.
- m3u8 is UTF-8 **without BOM**, `#EXTM3U`, `#PLAYLIST:<name>`, `#EXTINF:<seconds>,<Artist> - <Title>`.
- Navidrome play counts / stars / last-played are pulled continuously — after Spotify is gone this is the live taste signal, so it must work from day one.

### Destructive operations

- **Never `unlink`.** Dedupe losers move to `TRASH_ROOT` preserving relative paths, with a JSON manifest per operation and a working Undo.
- **Dry run is the default** for every batch. Show exactly what will move before anything moves.
- Duration differing by >5s on the same artist+title is a **variant** (live/remix), not a duplicate — default to keeping both. Auto-deleting these is how the tool loses trust permanently.
- Anything that deletes or moves a file outside this flow: **stop and ask.**

### Lidarr

Already manages the library and has a REST API. It's an **optional downstream, not a competitor** — don't reimplement artist monitoring. Full albums are better handed to Lidarr than downloaded track-by-track.

### SSE behind the reverse proxy

Response buffering will silently break live progress. The proxy in front needs buffering off for `/api/events`. If progress "works locally but not on the server", that's the cause.

---

## Ask rather than guess

Per `PROMPT.md` §12 — stop and ask before:

- deleting or moving a file outside the designed trash flow
- a schema change needing a destructive migration
- adding a paid or account-requiring service to the critical path
- writing an adapter with genuinely involved setup (slskd, Deezer ARL) — the owner may not want it
- any design that would need a Spotify endpoint `docs/spotify-api-state.md` says is unavailable

And if the Spotify API has changed again: say so plainly and propose the adjustment rather than building on a stale assumption.
