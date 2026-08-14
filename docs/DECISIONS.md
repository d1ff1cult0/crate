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

### A20. Truncation detection cannot trust ffmpeg's exit code
**Found by running it.** The obvious full-decode check — `ffmpeg -xerror … -f null -` and
test the exit status — **does not work**. A FLAC cut in half at the byte level prints
`invalid residual / decode_frame() failed` and still exits **0** on ffmpeg 6.1.1. A
verification built on the exit code passes a truncated download straight into the library,
which is the most damaging failure this app has.

**Chose:** two signals instead. Any stderr output at `-v error` (a clean decode is silent
at that level), plus the decoded duration read from `-progress` compared against the
container header. The second catches formats that truncate without upsetting the decoder
at all — the header keeps claiming the full length because it was written up front.
**Verified:** good / silent / too-short / truncated / lossy fixtures all classify correctly.

### A21. Ogg and Opus keep their tags on the STREAM, not the container
**Found by running it.** `ffprobe` reports ID3 and MP4 metadata under `format.tags`, but
Vorbis comments — what Ogg and Opus use — appear under the audio *stream*. Reading only
`format.tags` reported a fully-tagged Opus file as completely untagged.

This mattered specifically because **Opus is what the YouTube Music provider produces**, so
the format most likely to be downloaded was the one whose tags were invisible. `probeAudio`
now merges both, container-level winning.

### A22. Post-processing collisions: the arrival loses, the library is never touched
§7.6 step 6 says to apply the §7.7 keeper rule when a download collides with something
already present. That rule is symmetric, but the two outcomes are not:

- **The download loses** → it goes to the trash and the request resolves against the
  existing file. Safe: it was never in the library, so there is nothing to disturb.
- **The download wins** → a duplicate group is raised for review and **the existing file is
  not moved**. Moving something already in the library is the §7.7 flow, which is dry-run
  by default and reviewed by hand (A13). A post-processor quietly relocating library files
  as a side effect of a download would be exactly the behaviour that loses trust.

### A23. Transcode policy defaults to doing nothing
**Chose:** `transcodeNormalizeLossy` off, per §7.6 step 2. The lossless guard above it is
**not** configurable at all — a lossy re-encode of a lossless source is unrecoverable and no
setting is worth that. When lossy normalization is on, the log says out loud that it is a
second lossy generation.

### A24. Only the YouTube Music provider is built
**Chose:** ship the chain with one adapter. §12 says to ask before writing an adapter with
genuinely involved setup, and slskd (Gluetun routing, credentials) and streamrip (Deezer
ARL, account) both qualify. YouTube Music needs no credentials, which is why §10 phase 4
puts it first: it is the one adapter that can be exercised end to end without asking the
owner to set anything up, so it is what the post-processing chain was tested against.

**To add either:** a new file in `packages/providers`, registered in `buildProviders`. The
registry, scoring, fall-through, attempt logging and post-processing are all provider-
agnostic already — no refactor.

### A25. The LLM curator retries once
**Found by running it** against the real Ollama on this box. The same prompt succeeds and
fails run to run: long structured output occasionally arrives truncated mid-array. One
retry turns an intermittent failure into a rare one and costs a few seconds.

Related: `llmModel` now defaults to `gemma4:e4b-it-qat`, which is what is actually installed
here (checked 2026-08-14). The health check matches on prefix, so the previous default of
`gemma3` reported the curator as unavailable rather than merely unconfigured.

**Verified:** asked for a calm instrumental playlist against a synthetic library; the model
returned five plausible-sounding tracks, the resolver dropped all five, and **no playlist
was written**. That is the guardrail working, not a failure.

### A26. What a backup contains, and what it deliberately does not
**Chose:** everything harvested from Spotify, every match decision, listening history, the
artist graph, and the library index. **Excluded:** `JobRun` and `DownloadAttempt` — the two
bulkiest tables, worth nothing a week later.

**The encryption key is NOT in the backup**, on purpose. Credentials are exported as
ciphertext and are only readable with the same `CRATE_ENCRYPTION_KEY`. A backup that
carried its own key would be a single file that hands over every credential.

Restore is upsert-in-dependency-order, not a transaction: a full library restore is
hundreds of thousands of statements and one transaction that size hits statement timeouts
and holds locks for minutes. Each table reports what it wrote, so a partial restore is
legible and simply re-runnable. **Verified:** wipe, restore, compare row-for-row, restore
again and confirm nothing changed.

### A27. Two pre-existing issues fixed in passing
- **`PlaylistSchema` exceeded TypeScript's serialization limit (TS7056)** and had been
  failing `pnpm typecheck` in `packages/integrations`. Cause: `PagingSchema(PlaylistItemSchema)`
  nested twice, each embedding the full TrackObject shape. Items are read from
  `GET /playlists/{id}/items` as their own call and never from the playlist object, so the
  nested paging is now a shallow schema. Behaviour is unchanged — the field is only ever
  tested for presence (finding B) and `total`.
- **`renderPlacement` produced `1-00 Title`** when a track number was unknown, which looks
  like real metadata. An unknown track number now blanks the disc as well and the whole
  prefix collapses, leaving just the title.

### A15. Postponed to a later pass
~~Recorded so they aren't mistaken for finished work: provider adapters beyond the interface itself, the LLM curator, mix generation, release radar, the duplicates review UI, the first-run wizard, and the command palette.~~

**All of these are now built.** The provider adapters are the one partial: the interface, chain and scoring are done and YouTube Music is implemented, but slskd and streamrip are not — see A24 for why that is a question for the owner rather than an omission. What genuinely remains is under "Still outstanding" in the build log below.

---

## Build log

Appended as phases complete. A phase is "done" only against its `PROMPT.md` §10 acceptance test.

| Phase | Status | Notes |
|---|---|---|
| 1 — Foundations | **done** | Verified end to end against real Postgres/Redis: pages render, a job runs, progress streams over SSE. |
| 1.5 — Harvest | **ready to run — needs your Spotify app** | Orchestrator + rate limiter tested against a fake Spotify (34 tests). OAuth flow and connections editor are now built and verified. The only remaining step is yours: create a Spotify app and click Connect. See "What's left" below. |
| 2 — Library | **done** | Scanner, ffprobe, audio-stream hashing, fpcalc fingerprinting and the AcoustID/MusicBrainz ISRC backfill all verified against real audio files. Library UI renders. |
| 3 — Spotify + import + matching | **done** | Matching cascade and importers built and tested; paste-box resolver and review queue working. Playlist and queue screens now real. |
| 4 — Acquisition | **done** | Provider chain, candidate scoring, full post-processing chain, queue UI with the provider chain and failure reasons visible. Only the YouTube Music adapter is implemented — A24. |
| 5 — Playlists | **done** | Atomic m3u8 writes, sidecars, Subsonic push, gap filling, debounced rescan shared with the post-processor. |
| 6 — Duplicates | **done** | Five grouping passes, keeper selection, dry-run default, trash with manifest, working undo, keyboard review UI. |
| 7 — Recommendations | **done** | Affinity with recency decay, blended artist graph, Louvain into stable slots, weighted sampling with discovery, release radar, LLM curator with the library resolver. |
| 8 — Polish | **done** | First-run wizard, `Cmd+K` palette, backup/restore, README. |

### Verified against real infrastructure — phases 4, 6, 7, 8

Run against real PostgreSQL 17, real Redis, real `ffmpeg`/`ffprobe`/`fpcalc`, real audio
files, and the real Ollama on this box. Not typechecked-and-assumed.

**Post-processing (§7.6)** — a staged Opus file went through the whole chain and landed at
`Radiohead/OK Computer (1997)/1-06 Paranoid Android.opus`, with the harvested ISRC,
`CRATE_SOURCE=ytm`, album artist and track number written into the file; audio-stream hash
and fingerprint computed; `LibraryFile` registered with provenance; the match resolved as
`MATCHED`/`ISRC`; the request marked `SUCCEEDED`.

**Retagging does not change the audio hash.** Confirmed directly — tag write, then rehash,
byte-identical. This is what makes dedupe pass 1 certain rather than probable.

**A truncated download is rejected and never reaches the library.** See A20 for why the
obvious version of this check silently did not work.

**A second copy arriving** was correctly superseded by the existing file and moved to
trash rather than deleted.

**Dedupe** grouped an identical pair by audio hash, selected the properly-foldered file as
keeper, **refused to apply while `dedupeDryRunOnly` was on**, applied once it was off,
and **undo restored the file exactly**.

**The trash purge refused a forged manifest** pointing at a live library file, and that file
survived.

**Mixes** — Louvain recovered all three seeded genre clusters, named them after their
artists, kept every slot's meaning across a second run (continuity 1.0), never repeated a
track across mixes, and never exceeded two tracks per artist. With the listening signal
removed it **refused to generate anything** and said what would fix it, rather than
producing six plausible-looking playlists out of noise.

**The LLM curator's guardrail works** — see A25.

**Backup/restore** round-tripped: export, wipe, restore, row-for-row comparison including
foreign keys, then a second restore that changed nothing.

**Every route returns 200** — all ten screens and the API endpoints, against a live database.

**331 tests pass** across `core` (237), `integrations` (80) and `providers` (14).

### Still outstanding

- **The Spotify harvest has still never run against the real API.** Everything else is
  verified; this one needs your app and your Premium, before 2026-09-01.
- **slskd and streamrip adapters** — A24. Your call, and the question is in §12's list.
- **The GDPR export parser is still untested against real data** — A9, unchanged. When the
  export arrives, run it through and expect to fix field names.
- **Mix quality is unfalsifiable until it runs on your real history.** The machinery is
  verified; whether the six mixes are worth pressing play on is the open question, and
  plan.md §1.4 set expectations for it deliberately.
- **The design system has not had the two-pass review** the frontend-design skill asks for
  (A14) — that path is still not present in this environment.

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

The OAuth flow and connections editor are built and verified. Everything that remains is on your side and takes about five minutes:

1. Create an app at **developer.spotify.com**.
2. Add `<PUBLIC_URL>/api/spotify/callback` as a redirect URI — it must match exactly.
3. Paste the client ID into **Settings → Spotify** and press **Connect Spotify**.
4. Press **Harvest everything**.

Note that Development Mode requires the app owner to hold active Premium, so this has to happen before **2026-09-01**.

**Verified about the OAuth flow** (against a real database, without completing a Spotify consent screen, which needs a real app):

- Authorize redirects to `accounts.spotify.com` with PKCE `S256` and exactly the six read-only scopes — no write scopes, confirming D4.
- PKCE verifier and state cookies are `HttpOnly`, `SameSite=Lax`, ten-minute expiry.
- A forged `state` is rejected; a declined consent, a missing code and an expired verifier each redirect back to Settings with a specific readable reason.
- Credentials are AES-256-GCM encrypted at rest — the plaintext AcoustID key appears nowhere in the database, and `GET /api/connections` returns only `hasSecret: true`, never the value.
- Saving a connection verifies it immediately where that is cheap, so a typo surfaces at save time rather than inside a failed job three days later.

The one path that genuinely cannot be tested without your app is the code-for-token exchange itself.
