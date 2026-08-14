# Decisions and assumptions

**Started:** 2026-08-14
**Context:** The owner was asleep and authorised building to proceed unattended with stated defaults. Everything decided without the owner in the loop is recorded here for review.
**Updated 2026-08-14, later:** the owner answered all six questions directly. §D is now their actual answers, superseding the sleep-time defaults. **One answer changed the plan materially — see D1.**

Two kinds of entry:
- **D** — a decision the owner gave me explicitly. Recorded so it's traceable, not to be re-litigated.
- **A** — an assumption I made on my own because the work needed an answer. **These are the ones to review.** Each says what I'd have asked, what I chose, and what it costs to reverse.

---

## D — Owner's answers

| # | Question from `plan.md` §5 | Owner's answer | What I did |
|---|---|---|---|
| **D1** | When does Premium lapse? | **2026-09-01**, extendable to 2026-10-01 | **Changed the plan.** Phase 1.5 (harvest-only slice) is now real and runs immediately after phase 1. See §D1-detail below. |
| **D2** | GDPR export | Already requested; arrives in weeks | Importer built; the Import screen shows a persistent, non-nagging note that the export is expected and what it unlocks. Still untested against real data (A9). |
| **D3** | AcoustID | Key supplied; promote backfill to phase 2 | Adapter enabled, key stored as a credential (**not committed** — see A16). ISRC/MBID backfill is a phase-2 deliverable, per `plan.md` §1.3. |
| **D4** | Reverse sync to Spotify | No | No write scopes requested at OAuth. Scope list is read-only. |
| **D5** | `SourceTrack` split | Approved | Implemented as `SourceTrack` (identity, one row per source+externalId) + `SourcePlaylistItem` (membership/position/addedAt). |
| **D6** | Cuts | My call | Skipping other-service URL resolvers and spotdl, as proposed in `plan.md` §1.5. The resolver registry stays open, so either is a new file later rather than a refactor. |
| **D7** | Critique points | All approved | AcoustID/MusicBrainz backfill → phase 2. Last.fm connected in phase 1 and treated as load-bearing. The 14-day replay rule becomes a **penalty weight**, not a hard exclusion. |

### D1-detail — the deadline changes the build order

Premium lapses **2026-09-01**. Today is 2026-08-14. That is **18 days**, not the ~3 months the sleep-time default assumed.

Everything reachable only through the Spotify connector becomes permanently unobtainable on that date. Everything else — scanning, matching, dedupe, playlists, recommendations — works forever against a local database and has no deadline at all.

So the build order is now driven by the deadline rather than by dependency depth:

1. **Phase 1 foundations** — cut to what the harvest actually needs (DB, job infra, SSE, auth, shell, settings). Deferred within phase 1: the full settings surface, mobile polish, anything cosmetic.
2. **Phase 1.5 harvest** — OAuth, rate limiter, harvest-everything, ISRC backfill. **Target: complete and run well before 2026-09-01.**
3. Then phases 2→8 in the brief's order, against data that is already safe.

The owner mentioned the subscription can be extended to 2026-10-01. **Recommendation: extend it.** It buys the ISRC backfill (A12) room to finish without competing against the harvest for quota, and 18 days is tight for phase 1 + a full harvest with a re-run in reserve if the first pass reveals a gap.

### A12 — reversed by D1

The sleep-time default disabled the `spotify-isrc-backfill` queue so the owner could see the request cost before spending quota. **With a hard cutoff 18 days out that is the wrong default and I've flipped it: backfill now runs by default, at lowest priority, immediately after the primary harvest.**

The reasoning inverts cleanly. Quota is a *rolling* limit, not a lifetime budget — unspent quota before 2026-09-01 isn't saved, it's lost. An ISRC not captured before the cutoff is gone permanently, and recovering it later costs a fingerprint pass plus an AcoustID round trip and only works for files already owned. Spending freely now is strictly better than conserving.

The harvest summary still reports the outstanding count and the queue is still interruptible, so the owner keeps the visibility the original default was protecting — just without the wait.

---

## A — Assumptions I made unattended

### A1. Package manager and Node version
**Chose:** pnpm 9.15.4 (via corepack) + Node 22.
**Why:** `PROMPT.md` fixes the stack but not the package manager. The workspace layout in §4 is a monorepo, pnpm workspaces is the low-friction default, and Node 22 is what's on the box.
**Reversing:** cheap before the lockfile matters.

### A2. Single-user auth is a password + signed session cookie
**Chose:** one password, Argon2id hash held in `Setting`, HTTP-only signed session cookie, no user table beyond a single row.
**Why:** §1 says "single user (me). No multi-tenancy, no user management beyond one login." Anything more (OIDC, magic links) adds an external dependency to the critical path, which §12 says to ask about.
**Note:** the app assumes it sits behind the reverse proxy §1 mentions. It is not hardened for direct exposure to the internet.
**Reversing:** cheap, isolated in `apps/web/src/lib/auth.ts`.

### A3. `SPOTIFY_MARKET` defaults to `BE`
**Chose:** `BE`, configurable in Settings.
**Why:** finding D in `spotify-api-state.md` — market has to be explicit now, and there's no way to read it from the profile any more. The owner's machine is `d1ff1cult-server` and the email/locale signals point to Belgium.
**Cost if wrong:** tracks read as unavailable and harvest quality silently degrades. **Worth a 5-second check on review.**

### A4. Encryption at rest uses AES-256-GCM with a key from `CRATE_ENCRYPTION_KEY`
**Chose:** a single 32-byte key from env, per-record random IV, GCM auth tag stored alongside. Decryption happens in the worker; the web process can write secrets but the client never receives one.
**Why:** §11 requires secrets encrypted at rest. A KMS would be an external dependency.
**Consequence:** losing the env key means re-entering every credential. Documented in the compose file and in `CLAUDE.md`.

### A5. Postgres 17 and Redis 7 pinned in compose
**Chose:** `postgres:17-alpine`, `redis:7-alpine`.
**Why:** unspecified in the brief. Both are current stable and match what Prisma and BullMQ target.

### A6. Worker image carries ffmpeg, fpcalc, and yt-dlp
**Chose:** a Debian-slim worker image installing `ffmpeg`, `libchromaprint-tools`, and `yt-dlp`.
**Why:** these are runtime dependencies of the postprocess/fingerprint queues; a worker without them fails at job time rather than at boot, which is a bad failure. The host already has ffprobe 6.1.1 and fpcalc 1.5.1, so local dev works without the container too.

### A7. Path mapping is stored longest-prefix-first and applied deterministically
**Chose:** mappings sorted by descending `appPath` length; first match wins; a path matching no mapping is written unmapped **and flagged**, not silently passed through.
**Why:** §5 doesn't specify precedence for overlapping mappings, and silent pass-through is exactly how the classic failure in this class of app happens.

### A8. Scan concurrency defaults to 4, fingerprint concurrency to 2
**Chose:** conservative defaults, both configurable.
**Why:** the box is an i5-8400 (6 cores) also running Navidrome, Jellyfin, Lidarr, qBittorrent and Ollama. §7.4 says fingerprinting must be throttled and resumable; starving the rest of the box is a real risk (risk register in `plan.md`).

### A9. GDPR export parser is written against the documented shape, untested against real data
**Chose:** ship it, with permissive Zod parsing and both known filename conventions (`StreamingHistory*.json` and `Streaming_History_Audio*.json`).
**Why:** D2 — no export exists yet.
**Review action:** when the export arrives, run it through and expect to fix field names. This is the one importer I can't verify.

### A10. Match auto-accept threshold 0.90, review band 0.60–0.90
**Chose:** exactly as §7.3 specifies, exposed as settings rather than constants.
**Why:** §11 says these will be tuned by hand. Hard-coding them would mean a redeploy per tuning pass.

### A11. `snapshot_id` is the sync skip key, but a full re-read happens weekly regardless
**Chose:** trust `snapshot_id` for the hourly sync per §7.10; force a full re-read of every owned playlist once a week.
**Why:** `snapshot_id` is reliable in principle, but a missed change is a silently stale playlist forever. The weekly full pass is cheap relative to the harvest and bounds the staleness.

### A12. ISRC backfill queue — ~~off~~ **ON** by default
**Superseded by D1.** The original reasoning (conserve quota, let the owner see the cost first) assumed ~3 months of runway. With the real cutoff 18 days out the default flips to on. Full reasoning under **D1-detail → A12 reversed**.

### A16. The AcoustID key is stored as a credential, not committed
**Chose:** the key the owner supplied goes into `.env` (gitignored) and is read into the encrypted `Connection` record on first boot. `.env.example` carries a placeholder only.
**Why:** it's a real credential and this is a git repository. §11 requires secrets encrypted at rest and never sent to the client; a key pasted into a tracked file satisfies neither, and rotating it later would mean rewriting history.
**Note:** it also arrived over chat, so treat it as warm rather than clean — worth rotating at some point, though the exposure is low for a free metadata API.

### A18. The deadline gates data collection, not construction
**Owner clarification, 2026-08-14:** build all of phases 1–8 now. Phase 1.5 runs early to secure the Spotify data before 2026-09-01, but the rest of the build continues regardless and does not wait for real data.

**How fixtures are used, given §11 says "don't mock anything into the UI":**

These two instructions are compatible, and the boundary matters:

- **Fixtures live in `packages/core/test/fixtures`** and drive the Vitest suites. This is what §11 asks for — real fixture data, the nastiest titles, unicode, five spellings of `feat.`. Matching, dedupe, scoring and parsing are all fully exercised without any real library.
- **A dev seed (`packages/db/seed.ts`) populates a recognisable sample library** for building screens against. It is opt-in (`pnpm db:seed`), never runs in production, and every seeded row is tagged so it can be dropped in one statement.
- **The UI still never fakes.** A screen with no real data shows the honest empty state §11 asks for. Nothing renders a fabricated chart or an invented count. The seed is scaffolding for development, not a stand-in shown to the owner as if it were their library.

So: features are built complete, verified against fixtures, and meet real data when it arrives — the GDPR export, the Lidarr library, and the harvest.

### A17. Phase 1 is trimmed to what the harvest needs
**Chose:** deferred within phase 1 — full settings surface, mobile responsive pass, command palette, and anything cosmetic. Kept — DB, job infra, SSE progress, auth, app shell, path mapping + verify, Last.fm connect (D7).
**Why:** D1. Every day spent on phase 1 polish is a day of harvest runway. The deferred items have no deadline; the harvest does.
**Review:** if the subscription gets extended to 2026-10-01, some of this can come back before phase 2.

### A13. Nothing is auto-applied that moves or deletes a file
**Chose:** dedupe, trash, and retention all ship dry-run-only until explicitly enabled in settings, regardless of confidence.
**Why:** §7.7 says dry run is the default and §12 says ask before moving files outside the trash flow. With the owner asleep, the safe reading is that nothing destructive runs unattended at all.

### A14. Design system built from the §9 brief without the frontend-design skill
**Chose:** implemented the palette, type roles, and segmented meters exactly as §9 specifies.
**Note:** §9 says to read `/mnt/skills/public/frontend-design/SKILL.md` and run its two-pass process. That path is not present in this environment, so I worked from §9's direction directly — which is detailed enough to build from, including the anti-pattern list. Worth a design review pass when the skill is available.

### A15. Postponed to a later pass
Recorded so they aren't mistaken for finished work: provider adapters beyond the interface itself, the LLM curator, mix generation, release radar, the duplicates review UI, the first-run wizard, and the command palette. Status of each phase is in the build log at the bottom of this file.

---

## Build log

Appended as phases complete. A phase is "done" only against its `PROMPT.md` §10 acceptance test.

| Phase | Status | Notes |
|---|---|---|
| 1 — Foundations | **done** | Verified end to end against real Postgres/Redis: pages render, a job runs, progress streams over SSE. |
| 1.5 — Harvest | **code complete, not yet run** | Orchestrator + rate limiter fully tested against a fake Spotify (34 tests). Needs a real Spotify app + OAuth consent to run for real — see "What's left" below. |
| 2 — Library | **core done** | Scanner, ffprobe, audio-stream hashing, fpcalc fingerprinting and the AcoustID/MusicBrainz ISRC backfill all verified against real audio files. Library UI renders. |
| 3 — Spotify + import + matching | partial | Matching cascade and importers built and tested; paste-box resolver and review queue working. Playlist/queue screens still empty states. |
| 4–8 | not started | |

### Verified, not assumed

The following were exercised against real infrastructure rather than only typechecked:

- Prisma migration applied to a real PostgreSQL 17.
- Web app builds and every route returns 200.
- Redis pub/sub → SSE → browser confirmed by publishing an event and reading it off the stream.
- Worker boots with all queues and processes a job.
- A library scan over real FLAC and MP3 files produced correct rows: audio-stream `contentHash`, chromaprint fingerprints, quality scores (FLAC 106 vs low-bitrate MP3 30), and `"Paranoid Android - Remastered 2017"` normalised to `paranoid android` — the remaster suffix stripped as noise, exactly as §7.3 requires.
- The scan chained into fingerprinting and then a match sweep automatically.

### A19. BullMQ rejects `:` in custom job IDs

Found by running it, not by reading it. Every deterministic job ID in the codebase used colons (`fp:${fileId}`, `schedule:${name}`) and BullMQ throws `Custom Id cannot contain :` at enqueue time — which would have broken the idempotency §4 requires, silently, everywhere. All IDs now go through a `jobId()` helper in `apps/worker/src/lib/queues.ts` that sanitises separators.

### What's left before the harvest can actually run

Phase 1.5 is code-complete but has never talked to Spotify. To run it the owner needs to:

1. Create a Spotify app at developer.spotify.com and put its client ID in Settings.
2. Set the redirect URI to `<PUBLIC_URL>/api/spotify/callback`.
3. Complete the OAuth consent flow (read-only scopes only, per D4).

The OAuth callback route and the connections editor UI are the remaining gap between "tested against a fake Spotify" and "harvested". Given the 2026-09-01 deadline this is the highest-priority remaining work.
