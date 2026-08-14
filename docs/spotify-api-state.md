# Spotify Web API — verified state

**Verified:** 2026-08-14
**Verified against:** the February / March / May / July 2026 changelogs, the February 2026 migration guide, the November 2024 deprecation blog post, and individual endpoint reference pages.
**Status of this file:** authoritative. Where this document and `PROMPT.md` §2 disagree, **this file wins** (per §0.1).

Re-verify before starting any phase that touches the connector. Spotify has shipped four changelogs in the last seven months.

---

## 1. Summary

`PROMPT.md` §2 is substantially correct. The architecture it drives — harvest-once, persist-forever, work fully offline — is the right response to the API as it actually stands, and nothing found here undermines it.

Eleven things are wrong, imprecise, or missing. Four of them change the design:

| # | Finding | Impact |
|---|---|---|
| **A** | Album tracks carry **no ISRC**. Only playlist items and `/me/tracks` do. | **High** — breaks a §7.1 rule, drives harvest cost |
| **B** | Non-owned playlists fail with **403 / absent field**, not "empty items with non-zero total" | **High** — §7.2's detection heuristic doesn't work |
| **C** | Quota 429s (`reason: QUOTA_EXCEEDED`) are **not** rate-limit 429s | **Medium** — §7.1's backoff rule is wrong for these |
| **D** | No reliable market value: user `country` deprecated, `GET /markets` gone | **Medium** — silent unavailable-content failures |

Plus: collaborator access exists (§2 says owner-only), `account_id` is new and is the identifier to use, `/artists/{id}/albums` had its page size cut to 10, `/artists/{id}/top-tracks` is deprecated rather than removed, and the docs' own response samples are stale.

---

## 2. Confirmed correct in §2

- **November 2024 removals** — Related Artists, Recommendations, Audio Features, Audio Analysis, Get Featured Playlists, Get Category's Playlists, and 30-second preview URLs in multi-get responses. Confirmed. Applies to apps in Development Mode and apps registered on/after 2024-11-27. Apps with pre-existing *extended* quota access were grandfathered — we are not one of those, so for us these are simply gone, with no application path. §2's framing is right.
- **`/playlists/{id}/tracks` → `/playlists/{id}/items`** — confirmed, with a nuance (§3.2).
- **`GET /users/{id}` and `GET /users/{id}/playlists`** — removed. No reading anyone else's account.
- **All batch/multi-get fetches removed** — `GET /tracks`, `/albums`, `/artists`, `/episodes`, `/shows`, `/audiobooks`, `/chapters` with comma-separated IDs are gone. Single-ID fetches only. **One HTTP request per track** is real and is the defining throughput constraint.
- **`GET /browse/new-releases`, `GET /browse/categories`, `GET /markets`** — removed.
- **Field removals** — `popularity` (track/album/artist), `followers`, `linked_from`, `available_markets`, `label`, `album_group`; user `country`/`email`/`product`.
- **`GET /search` limit** — confirmed: default 5, **range 0–10**. `offset` range 0–1000, so a search is capped at ~1000 results.
- **ISRC reverted** — `Track.external_ids` and `Album.external_ids` were marked removed in February and explicitly restored in the March 2026 changelog: *"previously marked as removed in the February 2026 changelog but will continue to be available."* ISRC is safe to build on. Keep degrading gracefully anyway; it has been flip-flopped once already.
- **Development Mode requires the app owner to hold active Spotify Premium.** Confirmed in the migration guide and in contemporaneous press. If the subscription lapses, the app stops working. §2's central premise holds — **the connector is a harvesting tool with an expiry date.**
- **Quotas** — 5 authorized users per new app; 25 Client IDs per developer account (raised from 1 in July 2026); quota counted **per developer account**, not per Client ID.
- **Rate limits** — undocumented numeric value, calculated on a **rolling 30-second window**, `Retry-After` present on 429. Adaptive backoff is the correct approach.
- **Enforcement dates** — 2026-02-11 for newly created apps, 2026-03-09 for existing apps. Both are in the past; we are building against the post-migration API from day one.

### Still available and load-bearing (all re-verified individually)

| Endpoint | Notes |
|---|---|
| `GET /me` | Now returns `account_id` — see §3.6 |
| `GET /me/playlists` | max limit 50; includes `snapshot_id` and `owner.id` |
| `GET /playlists/{id}` | metadata always; `items` field only when owned/collaborating |
| `GET /playlists/{id}/items` | max limit 50; **403** when not owner/collaborator |
| `GET /me/tracks` | max 50; **full** TrackObject **with `external_ids.isrc`** |
| `GET /me/albums` | active, not deprecated |
| `GET /me/following` | active, `user-follow-read` |
| `GET /me/top/{tracks,artists}` | active; `short_term` / `medium_term` (default) / `long_term`; max 50 |
| `GET /me/player/recently-played` | active; max 50; `after`/`before` cursors; tracks only, no episodes |
| `GET /tracks/{id}` | active; full TrackObject **with ISRC** |
| `GET /albums/{id}` | active; `external_ids` present (isrc/ean/upc) |
| `GET /albums/{id}/tracks` | active — **but see finding A** |
| `GET /artists/{id}` | active |
| `GET /artists/{id}/albums` | active — **but max limit is now 10** (finding G) |
| `POST /me/playlists` | confirmed as the create path; replaces `POST /users/{id}/playlists` |
| `POST` / `PUT` / `DELETE /playlists/{id}/items` | active |

---

## 3. Corrections and additions

### A. Album tracks do not carry ISRC — §7.1's caching rule is wrong for albums

**§7.1 says:** *"never fetch a track individually when it arrived embedded in a playlist or album response."*

That rule is correct for playlists and wrong for albums.

- `GET /playlists/{id}/items` → each item's `item` is a **full TrackObject including `external_ids.isrc`**. ✅
- `GET /me/tracks` → each `SavedTrackObject.track` is a **full TrackObject including `external_ids.isrc`**. ✅
- `GET /albums/{id}/tracks` → each entry is a **SimplifiedTrackObject, which has no `external_ids` field at all**. ❌

The album object itself has `external_ids`, but that is the album's UPC/EAN, not a per-track ISRC.

**Consequence.** Every track that reaches us only via a saved album arrives without its highest-confidence matching key. Recovering it costs **one `GET /tracks/{id}` per track**, and batch fetching is gone. For a library of saved albums this is the single largest cost in the entire harvest.

**Recommended design change:**

1. Amend the §7.1 rule to: *never re-fetch a track that arrived from a **playlist** or `/me/tracks`; **do** enqueue an ISRC backfill for tracks that arrived only from an album.*
2. Make that backfill a **separate, lowest-priority, resumable queue** (`spotify-isrc-backfill`) that runs after the primary harvest completes. Getting playlists and liked songs secured must never be blocked behind thousands of album-track requests.
3. Order the primary harvest by information density: playlists and liked songs first (ISRC inline, free), then album *metadata*, then album-track ISRC backfill last.
4. Keep the "calls avoided by cache" counter §7.1 asks for, and add a second counter for "ISRC backfills outstanding" so the pre-cancellation decision is informed.
5. There is a no-API fallback: local fingerprinting → AcoustID → MusicBrainz → ISRC (§7.4 already builds this). For tracks we already own, that path costs Spotify nothing. Prefer it, and reserve the Spotify backfill for tracks we *don't* own and intend to download.

### B. Non-owned playlist detection — the actual mechanism

**§2/§7.2 say:** detect via *"owner ID ≠ my ID, or empty items with non-zero total"*.

The second half is not what the API does. Verified behaviour:

- `GET /playlists/{id}/items` → **`403 Forbidden`**. The reference page states: *"This endpoint is only accessible for playlists owned by the current user or playlists the user is a collaborator of. A `403 Forbidden` status code will be returned if the user is neither the owner nor a collaborator of the playlist."*
- `GET /playlists/{id}` → succeeds, returns name/cover/owner, and the `items` field is **absent**, not empty: *"This field is only available for playlists owned by the current user or playlists the user is a collaborator of."*

So the resolver should: fetch `GET /playlists/{id}` for metadata (always works), then treat **absence of `items`** or a **403 from `/items`** as the not-yours signal. Do not test for `total > 0 && items.length === 0` — that state does not occur, and an ownership-ID comparison alone misses the collaborator case (finding E).

This also means §7.2's inline workaround copy is reachable with the playlist's real name and cover art in hand, exactly as the brief wants. That flow is sound.

### C. Quota 429s are a different failure from rate-limit 429s

New in the **July 2026** changelog: when the development-mode quota is exhausted, the API returns `429` with a body containing `"reason": "QUOTA_EXCEEDED"`.

**§7.1 says:** *"on 429 respect `Retry-After` and halve the rate for the rest of the run."*

That is right for rate limiting and wrong for quota exhaustion — slowing down does not restore an exhausted quota, and a harvest that halves its rate repeatedly against a quota wall will crawl for hours and then fail anyway.

**Recommended:** branch on the 429 body.
- No `QUOTA_EXCEEDED` → rolling-window rate limit. Honour `Retry-After`, halve the token-bucket rate, recover slowly. As specified.
- `QUOTA_EXCEEDED` → **pause the harvest, checkpoint, surface it in the UI plainly** ("Spotify's daily quota for this app is used up; the harvest will resume automatically"), and schedule resumption rather than retrying into the wall.

Also note quota is now shared **per developer account across all 25 Client IDs** — a second app on the same account eats the same budget.

### D. There is no reliable market value any more

`GET /markets` is removed, and user `country` is deprecated on the profile. Meanwhile `GET /tracks/{id}` carries this note:

> *"If neither market or user country are provided, the content is considered unavailable for the client."*

So the obvious ways to obtain a market are gone, while omitting it can make content read as unavailable. This is a quiet failure mode: tracks come back looking unplayable/incomplete rather than erroring.

**Recommended:** add an explicit **`SPOTIFY_MARKET` setting** (ISO 3166-1 alpha-2, default `BE`, surfaced in Settings), pass it on every catalog request, and never derive it from the profile. Note it in the first-run wizard. §2 does not mention this at all.

### E. Collaborator playlists work — §2 says owner-only

§2's phrasing is *"only returned for playlists the authenticated user owns."* The API's actual rule is **"owns or collaborates on."**

Small but useful: a shared playlist a friend has added you to as a collaborator returns full contents. Worth one line in the §7.2 workaround copy ("…or ask them to add you as a collaborator"), and it's why the detection must not be a bare `owner.id === me.id` check.

### F. `account_id` is new and is the identifier to use

Added in the **May 2026** changelog: *"A public, immutable, pseudoanonymous identifier for the user's account. Use this field for account linking rather than the `id` field."*

`id` still exists but is explicitly discouraged for linking. Store `account_id` on the connection record as the stable identity. Keep `id` too — playlist `owner.id` is still an `id`, so the ownership comparison needs it.

### G. `GET /artists/{id}/albums` page size cut to 10

Default 5, **maximum 10** (it was 50). §2 lists the endpoint as available but doesn't note this. Walking an artist's discography now costs ~5× the requests it used to. Relevant to §7.8's Release Radar — though that is specified against MusicBrainz, which is the right call and should stay that way.

### H. `/artists/{id}/top-tracks` is deprecated, not removed

§2 lists it under "removed". It is still documented and functional, carrying a deprecation notice. Don't build on it — but if something needs it as a stopgap, it exists. No design change.

### I. `PUT`/`DELETE`/`GET /me/library` — the consolidated library endpoints

February replaced the per-type save/remove/follow/unfollow endpoints with three generic ones keyed by Spotify **URI** rather than ID:

- `PUT /me/library` — save / follow
- `DELETE /me/library` — remove / unfollow
- `GET /me/library/contains` — containment check

Reads (`GET /me/tracks`, `/me/albums`, `/me/following`) are unaffected. §2 omits these. They only matter if §7.9's optional reverse-sync ever writes to the library; playlist creation is unchanged.

### J. The documentation's own response samples are stale

The deprecated `/playlists/{id}/tracks` reference page still shows `available_markets`, `popularity`, and `linked_from` in its response sample, despite the February changelog removing all three. Old and new field names also coexist during the transition: the playlist object carries both `items` and a deprecated `tracks`; each item carries both `item` and a deprecated `track`.

**Recommended:** every Spotify response goes through Zod with **all** fields optional and unknown keys passed through, reading `items ?? tracks` and `item ?? track`, and persisting the untouched payload to `rawJson` regardless. Never trust a sample; never let a missing field throw. This is what §11's "Zod at every boundary" should mean in practice here.

### K. Unconfirmed: Client Credentials for metadata endpoints

A pinned comment on a third-party client's tracking issue (`rspotify` #550) reports Spotify *"moving away from the Client Credentials flow for metadata endpoints."* I could **not** confirm this in official documentation — the authorization concept page still lists Client Credentials as supported, with only the long-standing caveat that it can't reach user data.

**Treated as unconfirmed.** No impact on us either way: our design is Authorization Code + PKCE with a user token for every call, which is the safe side of this question. Flagging it only so nobody later "optimises" catalog lookups onto an app token.

---

## 4. What this means for the build

Nothing here invalidates the architecture. The four load-bearing consequences:

1. **Harvest ordering matters more than §7.1 implies.** Playlists and liked songs are cheap and ISRC-complete. Album tracks are expensive and ISRC-blind. Secure the cheap, complete data first; the "Spotify data secured" summary should report ISRC coverage split by source so the pre-cancellation decision is informed.
2. **The §7.2 not-your-playlist resolver keys off 403 / absent `items`**, and should mention collaborator access. This is the flow the brief says will be used most, so it needs to be built against the real behaviour and tested against a real non-owned playlist.
3. **429 handling branches** on `QUOTA_EXCEEDED`.
4. **Market is explicit configuration**, not something derived from the profile.

Everything else is a note, a limit change, or a naming detail — all captured in `CLAUDE.md`'s gotchas section.

---

## Sources

- [Web API Changelog — February 2026](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
- [Web API Changelog — March 2026](https://developer.spotify.com/documentation/web-api/references/changes/march-2026)
- [Web API Changelog — May 2026](https://developer.spotify.com/documentation/web-api/references/changes/may-2026)
- [Web API Changelog — July 2026](https://developer.spotify.com/documentation/web-api/references/changes/july-2026)
- [February 2026 Web API Dev Mode Changes — Migration Guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
- [Introducing some changes to our Web API (November 2024)](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api)
- [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) · [Get Playlist](https://developer.spotify.com/documentation/web-api/reference/get-playlist) · [Get Playlist Tracks (deprecated)](https://developer.spotify.com/documentation/web-api/reference/get-playlists-tracks)
- [Get User's Saved Tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks) · [Get User's Saved Albums](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-albums) · [Get Current User's Profile](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile) · [Get Current User's Playlists](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists)
- [Get Track](https://developer.spotify.com/documentation/web-api/reference/get-track) · [Get Album](https://developer.spotify.com/documentation/web-api/reference/get-an-album) · [Get Artist's Albums](https://developer.spotify.com/documentation/web-api/reference/get-an-artists-albums) · [Get Artist's Top Tracks](https://developer.spotify.com/documentation/web-api/reference/get-an-artists-top-tracks)
- [Create Playlist](https://developer.spotify.com/documentation/web-api/reference/create-playlist) · [Get Followed Artists](https://developer.spotify.com/documentation/web-api/reference/get-followed) · [Get User's Top Items](https://developer.spotify.com/documentation/web-api/reference/get-users-top-artists-and-tracks) · [Search](https://developer.spotify.com/documentation/web-api/reference/search)
- [Rate Limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits) · [Authorization](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [rspotify issue #550 — Spotify Web API changes (February 2026)](https://github.com/ramsayleung/rspotify/issues/550) *(third-party, used only for the unconfirmed item K)*
- [TechCrunch — Spotify changes developer mode API to require premium accounts](https://techcrunch.com/2026/02/06/spotify-changes-developer-mode-api-to-require-premium-accounts-limits-test-users/)
