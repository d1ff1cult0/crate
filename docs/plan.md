# Crate — build plan

**Written:** 2026-08-14
**Against:** `PROMPT.md` §10, adjusted by the verified API state in `docs/spotify-api-state.md`.

This is the phase breakdown you asked for, plus the parts I think are risky and the parts I think are wrong. §0.3 says to argue, so the disagreements are up front rather than buried — §1 is the stuff I'd want settled before writing code, §2 is the schema, §3 is the phases, §4 is the risk register.

---

## 1. Things I think are wrong or need a decision from you

### 1.1 The phase order puts the harvest last-ish, but the harvest is the thing on a clock — **needs your answer**

Everything in the brief acknowledges the Spotify connector dies when your Premium lapses. Then §10 puts Spotify harvesting in **phase 3**, behind foundations and a full library scanner.

If your subscription has months left, that ordering is fine and I'd keep it — the harvest wants a working DB and job system under it. If it lapses sooner, the ordering is backwards: the irreplaceable, time-limited work sits behind two phases of work that can be done any time.

There is a cheap hedge that doesn't compromise the architecture: land **phase 1 foundations**, then a **minimal harvest-only slice** — OAuth, the rate limiter, `SourceTrack`/`SourcePlaylist` persistence, "Harvest everything", no UI beyond a progress meter and no matching — and only then build phase 2's library scanner. The data is then secured and everything afterwards is offline work against a local database. Costs maybe two or three days of resequencing.

**Question: when does your Premium subscription actually lapse?** If it's more than ~3 months out, keep §10's order. If sooner, I'd take the hedge. I'm not making this call for you.

### 1.2 Request your Spotify GDPR export **today** — it is on the critical path for phase 7

§7.8 correctly identifies the GDPR streaming history as the richest taste signal by far, and §7.2.3 notes the export takes weeks. Phase 7 is where recommendation quality is decided, and its best input has a multi-week lead time that no amount of engineering compresses.

So: request it now, at spotify.com/account/privacy, before any code exists. If it arrives during phase 2 it's waiting when phase 7 starts. If it's requested when phase 7 starts, phase 7 stalls or ships on weaker signal. This is the single highest-leverage thing you can do this week and it takes five minutes.

Worth requesting the **extended streaming history** variant specifically — the default export covers a shorter window than the full account history.

### 1.3 Phase 3 will look much worse than it should, because tier-1 matching can't work yet

§7.3's cascade puts **ISRC exact (1.00)** at the top, with the note *"requires local files tagged with ISRC — the post-processor writes it."* The post-processor is **phase 4**. Phase 3's acceptance test is *"I can import my entire Spotify account and see exactly what I already own and what's missing."*

Your existing library is a Lidarr-managed collection of rips from assorted sources. Most of those files will not carry ISRC tags. So in phase 3, the top tier of the cascade misses on nearly everything you already own, matching falls through to normalized-artist-title-duration (0.90) and fuzzy (<0.75), and the coverage report understates what you own while the review queue fills with things you actually have. That's the exact failure mode that made the previous two migration attempts bounce.

**Proposed fix — move ISRC acquisition for the *existing* library into phase 2:**

Fingerprint (`fpcalc`) → AcoustID → MusicBrainz → recording MBID **and ISRC list**, written back to `LibraryTrack.isrc` / `.mbid`. §7.4 already specifies this machinery as "optional AcoustID lookup to backfill MBID and ISRC" — I want to promote it from optional to a phase-2 deliverable, and treat fingerprint+MBID as the realistic tier-1 for pre-existing files, with ISRC becoming tier-1 for everything Crate itself downloads later.

Consequence: phase 2 grows (fingerprinting the whole library is CPU-hours), phase 3 gets dramatically more honest, and the review queue becomes clearable rather than demoralising. I think this is the most valuable change in this document after §2.1.

It also needs an AcoustID API key — free, but it's an account. §12 says ask before putting an account-requiring service on the critical path: **this is me asking.** Without it the fallback is fingerprint-only local dedupe, which still works for §7.7 but does nothing for cross-referencing against Spotify's ISRCs.

### 1.4 Phase 7's acceptance criterion is the riskiest thing in the brief, and I want to set expectations now

*"Six mixes appear in Navidrome every morning and I'd genuinely press play on at least four."*

Everything else in this brief is engineering with a knowable answer. This isn't. Daily Mix quality comes from track-level collaborative filtering over hundreds of millions of listeners. What §7.8 specifies — Louvain communities over an artist graph blended from Last.fm, Deezer, YTM radios and your own co-occurrence, sampled by affinity with recency penalties — is a genuinely good approximation and I think it's the right design. But it's approximating a fundamentally different kind of signal, and the honest range of outcomes is "surprisingly good" to "pleasant but samey".

Three things move it toward the good end, in order of impact:

1. **The GDPR streaming history** (§1.2). With timestamps and `ms_played` this is real per-track behavioural data over years. Without it, the taste model runs on top-tracks snapshots and whatever Navidrome has accumulated since migration — which early on is nearly nothing.
2. **Last.fm connected early.** §7.8 rules out ListenBrainz, which is your call and I'll respect it — but that leaves Last.fm as the only remaining source of real collaborative-filtering data in the blend (Deezer's related-artists is thin, YTM radios are good but reflect YouTube's population, co-occurrence only knows what you already have). Last.fm carries more weight in this design than the brief implies. A free API key, connected in phase 1, costs nothing and starts accumulating.
3. **The outcome feedback loop** (§7.8's "log which recommended tracks got played versus skipped"). This is what makes it improve, and it needs weeks of use. Phase 7 shipping is where the engine starts learning, not where it's finished.

I'd also soften one rule: §7.8's *"nothing played in the last 14 days"* is aggressive. Daily Mix is comfortable and familiar *because* it replays things you like. A 14-day exclusion on a library the size of yours risks mixes made mostly of stuff you skipped for a reason. I'd make it a **penalty weight rather than a hard exclusion**, configurable, and tune from there.

### 1.5 Over-scoped — I'd cut or defer these

- **§7.2.6, other-service playlist URLs** (Apple/YTM/Deezer/Tidal). Four more scrapers of public metadata, each breaking independently, for a case the CSV and text importers already cover — export from the other service, paste the text. The brief already marks it "nice to have, phase 5". I'd drop it to phase 8 or out entirely, and let the text importer earn its keep.
- **§7.5.5, spotdl.** It needs Spotify credentials for metadata, so it dies on the same day the connector does. The brief ships it disabled by default with a note. Shipping a provider that is disabled by default and permanently expiring is maintenance with no payoff — I'd not build the adapter at all, and say so in the UI's provider list if you want the acknowledgement.
- **§7.9's reverse sync to Spotify.** Pushing local playlists back up to a service you're leaving, using write scopes that expire with the subscription. If you want it, it's an hour in phase 8 — I'd not carry the extra scopes through the OAuth design for it. **Tell me if you actually want this**, because it changes the scope list requested at first connect.
- **§7.8's LLM curator free-text box** — keep it, it's cheap and it's fun, but its value is entirely in the resolver guardrail (*"every returned track resolved against the actual library, anything that doesn't resolve dropped silently"*), which is also the only part that's real work. Build the resolver, then the box.

Not cutting, but flagging as bigger than they look: **slskd candidate filtering** (§7.5.1) and the **duplicate review UI** (§7.7). Both are "one screen" in the brief and neither is.

### 1.6 Smaller disagreements

- **§4's "one queue per concern"** should gain a tenth: `spotify-isrc-backfill`, per `docs/spotify-api-state.md` finding A. Album-sourced tracks arrive without ISRC and need one request each — that must never block the primary harvest.
- **§7.1's rule** *"never fetch a track individually when it arrived embedded in a playlist or album response"* is right for playlists and `/me/tracks`, wrong for albums. See finding A.
- **§7.2's non-owned-playlist detection** (*"empty items with non-zero total"*) doesn't match API behaviour — it's a 403 from `/items` and an absent field on the playlist object. See finding B. The user-facing flow is unaffected and stays exactly as written; only the detection changes. Worth adding "or ask them to add you as a collaborator" to the workaround copy, since collaborator access does return contents.
- **§7.1's 429 handling** needs to branch on `QUOTA_EXCEEDED`. See finding C.
- **Market** needs to be explicit configuration. See finding D.
- **§10 phase 4 "YouTube Music first (it needs no credentials)"** — agreed, and worth stating why this matters beyond convenience: it's the only provider that can be exercised end-to-end without asking you to set anything up, so it's what the post-processing chain gets tested against.

---

## 2. Data model — changes I'd make before the first migration

§6 says "tell me if you'd model it differently". One structural change, several small ones.

### 2.1 Split `SourceTrack` into an entity and a playlist membership — **the important one**

As written, `SourceTrack` carries both track identity (title, artists, isrc, spotifyId, rawJson) *and* playlist membership (`playlistId`, `position`, `addedAt`). A track in six playlists therefore becomes six rows, each with its own full `rawJson` copy — and each with its own `Match`, since `Match.sourceTrackId` is `@unique`. So the same recording gets matched six times, can be reviewed six times, can be *resolved differently* six times, and six `DownloadRequest`s can be raised for one missing track.

That also contradicts §7.1's `spotifyId → SourceTrack` cache, which assumes one row per Spotify track.

**Proposed:**

```prisma
model SourceTrack {        // the recording, one row per (source, externalId)
  id       String @id @default(cuid())
  source   Source
  spotifyId String?
  isrc     String?
  title    String
  artists  String[]
  album    String?
  albumArtist String?
  durationMs Int?
  mbid     String?
  year     Int?
  rawJson  Json?
  normTitle  String
  normArtist String
  isrcStatus IsrcStatus @default(UNKNOWN)  // PRESENT | ABSENT | BACKFILL_QUEUED | UNAVAILABLE
  match      Match?
  memberships SourcePlaylistItem[]
  @@unique([source, spotifyId])
  @@index([isrc]) @@index([normArtist, normTitle])
}

model SourcePlaylistItem { // membership: which playlist, what position, when added
  id            String @id @default(cuid())
  playlistId    String
  sourceTrackId String
  position      Int
  addedAt       DateTime?
  @@unique([playlistId, position])
  @@index([sourceTrackId])
}
```

Now matching runs once per recording, coverage per playlist is a join, a track fixed in the review queue is fixed everywhere at once, and one missing track raises one download. `isrcStatus` is what drives the backfill queue from finding A.

This is worth getting right before the first migration, because unpicking it later is exactly the destructive migration §12 says to stop and ask about.

### 2.2 Smaller schema notes

- **`ArtistNode.normName @unique`** will throw on legitimately distinct artists that normalize identically (there are more of these than you'd expect, and your normalizer is deliberately aggressive). Make it `@@index`, not `@unique`, and resolve collisions in application logic where you can see both candidates.
- **`PlaylistItem @@unique([playlistId, position])`** makes reordering painful — any insert needs a shuffle that transiently violates the constraint. Either rewrite the whole item list inside one transaction (simplest, fine at playlist scale) or use fractional positions. Worth deciding now.
- **`Mix.slot`** wants a uniqueness rule — `@@unique([slot])` if slots are permanent identities, or `@@unique([slot, generatedAt])` if you want history. §7.8's "Mix 3 keeps meaning roughly the same thing" implies the former plus a separate generation log.
- **Missing models:** `ImportRun` (§8's Import screen wants "history of past imports with their outcomes" and `JobRun` isn't the right grain), a credentials/connection model for provider secrets and OAuth tokens (§11 wants them encrypted at rest — they need somewhere to live that isn't `Setting`), and an auth/session model for the single login.
- **`LibraryTrack.playCount`/`lastPlayedAt`/`starred`** are Navidrome-synced. If Last.fm also lands, these want a source dimension or they'll fight. Suggest keeping the raw signal in `ListeningEvent` (which already has `source`) and treating these three as a derived cache.
- **`DownloadRequest.sourceTrackId`** points at the entity under §2.1, which is what you want — one request per missing recording, not per playlist appearance.

---

## 3. Phases

Same eight phases as §10, with the adjustments above folded in. Each ships working before the next starts.

### Phase 1 — Foundations
Monorepo, Prisma schema (with §2's changes), Docker Compose (web, worker, postgres, redis), single-user auth, settings with encrypted secrets, path mapping + **Verify paths** diagnostic, BullMQ infrastructure, `JobRun` + SSE progress, design system and app shell.

Also here: **connect Last.fm** (§1.4) and set `SPOTIFY_MARKET`.

**Done when:** you log in, configure paths, run a trivial job, and watch it progress live.
**Risk:** low. Path mapping is the one thing that must be exactly right, and the diagnostic is how we know it is.

### Phase 1.5 — Harvest slice — **CONFIRMED, deadline 2026-09-01**
Premium lapses 2026-09-01 (extendable to 2026-10-01). 18 days from the start of the build. This phase is the only work in the entire project with an external deadline; everything after it runs against a local database and can take as long as it takes. See `DECISIONS.md` D1-detail.

**The deadline gates data collection, not construction** (owner, 2026-08-14). Phase 1.5 runs early so the harvest is safely done before the cutoff, but phases 2–8 are built in full in parallel and do not wait for real data to arrive. Matching, dedupe, recommendations and the importers are all developed and verified against fixtures in `packages/core/test/fixtures`; the real GDPR export, Lidarr library and harvest output are fed in as they become available. See `DECISIONS.md` A18 for how this stays compatible with §11's "don't mock anything into the UI".

OAuth + PKCE, adaptive rate limiter with the `QUOTA_EXCEEDED` branch, `SourceTrack`/`SourcePlaylistItem` persistence, "Harvest everything" with resumable checkpointing, the ISRC backfill queue, the "Spotify data secured" summary. No matching, no UI beyond progress.

**Done when:** your complete Spotify account state is in Postgres and the connector could die tomorrow without loss.

### Phase 2 — Library
Scanner (concurrency-limited walk, then `chokidar` + nightly reconcile), `music-metadata` tags, `ffprobe`, audio-stream `contentHash`, fingerprinting queue, **AcoustID/MusicBrainz ISRC+MBID backfill (§1.3)**, library table UI.

**Done when:** the whole existing library is indexed with accurate metadata, a majority of files carry an MBID or ISRC, and you can search it.
**Risk:** medium — fingerprinting a large library is CPU-hours and must be resumable and throttled or it will starve everything else.

### Phase 3 — Spotify + import + matching
Harvest (or the rest of it, if 1.5 ran), all §7.2 importers, the GDPR export parser, the matching cascade in `packages/core` with fixture tests, coverage report, keyboard-driven review queue.

**Done when:** you can import your entire Spotify account and see exactly what you own and what's missing. No downloading.
**Risk:** **high** — this is where the app is judged. See §4.

### Phase 4 — Acquisition
Provider interface, YouTube Music first, then slskd, then streamrip. Candidate scoring, the full post-processing chain (verify → transcode policy → tag incl. ISRC → cover art → placement → fingerprint/dedupe check → register + debounced rescan), queue UI with visible provider chain and failure reasons.

**Done when:** missing tracks download unattended, land tagged and correctly placed, and Navidrome sees them.
**Risk:** high — slskd candidate filtering, and "wrong track landed" is the most damaging failure mode in the app.

### Phase 5 — Playlists
m3u8 writer (atomic, mapped paths, `.missing.json` sidecars), Subsonic playlist API, gap filling, auto-rewrite, debounced scan triggering.

**Done when:** an imported playlist plays in Navidrome end to end.
**Risk:** low-medium, concentrated entirely in path mapping — which phase 1 already proved.

### Phase 6 — Duplicates
Grouping passes, quality scoring, keeper selection, variant protection, dry-run/apply/undo with trash manifests, review UI.

**Done when:** it finds the duplicates you know about, refuses to touch live/remix variants, and you trust it enough to apply without reading every row.
**Risk:** medium — the trust bar is the hard part, not the grouping.

### Phase 7 — Recommendations
Taste model from GDPR history + Navidrome + Last.fm, similarity graph (Last.fm, Deezer, YTM radios, co-occurrence), Louvain clustering → six stable mix slots, weighted sampling with discovery slots, release radar via MusicBrainz, LLM curator with the library resolver.

**Done when:** six mixes appear in Navidrome every morning and you'd press play on at least four.
**Risk:** **highest, and least controllable.** See §1.4.

### Phase 8 — Polish
First-run wizard, `Cmd+K` palette, mobile, backup/restore, docs.

---

## 4. Risk register

| Risk | Phase | Why | Mitigation |
|---|---|---|---|
| **Recommendation quality is subjective and unfalsifiable until late** | 7 | Approximating population-scale collaborative filtering from single-user data | GDPR export requested now; Last.fm from phase 1; outcome feedback loop; expectations set in §1.4 |
| **Matching quality decides whether the app feels magic or infuriating** | 3 | Fuzzy matching on messy real-world metadata; both false positives and false negatives are costly | ISRC/MBID backfill moved to phase 2; fixture suite in `core` built from your nastiest titles; nothing below 0.90 auto-acted |
| **Wrong track downloads and lands in the library** | 4 | Provider search is text matching against an adversarial catalogue (karaoke, sped-up, 10-hour loops) | Candidate scoring with hard duration reject; full scored-candidate logging; postprocess verification before the library sees it |
| **Spotify harvest is slower than expected and the clock runs out** | 1.5/3 | One request per track, undocumented rate limits, ISRC backfill multiplies the album path | Resumable checkpointing; priority ordering (playlists/liked first); measure the real rate empirically in the first run rather than assuming |
| **Fingerprinting starves the box** | 2 | CPU-heavy across a large library on an i5-8400 | Dedicated low-priority queue, throttled, resumable, nice'd |
| **Path mapping wrong → nothing works** | 1 | The classic failure in this class of app | Verify-paths diagnostic on first setup, reporting which segment is wrong |
| **slskd setup is involved and may not be wanted** | 4 | §12 flags it explicitly | Ask before writing the adapter; YouTube Music proves the chain first |
| **Spotify changes the API again mid-build** | any | Four changelogs in seven months | `docs/spotify-api-state.md` is date-stamped and re-verified at the start of each connector-touching phase; everything parses permissively |

---

## 5. What I need from you before starting

1. **When does your Premium subscription lapse?** (§1.1 — decides whether phase 1.5 happens)
2. **Request the GDPR export today**, extended streaming history variant. (§1.2 — nothing blocks on your answer, but phase 7 quality does)
3. **AcoustID API key — yes or no?** (§1.3 — free, but it's an account on the critical path, and §12 says ask)
4. **Do you want reverse-sync to Spotify?** (§1.5 — changes the OAuth scopes requested at first connect)
5. **Agreement on the `SourceTrack` split** (§2.1) — or your reasons against, before the first migration exists.
6. Anything in §1.5 you want kept that I've proposed cutting.

Awaiting your go before scaffolding anything.
