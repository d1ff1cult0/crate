/**
 * ListenBrainz — the similarity source for recommendations (§7.8).
 *
 * Replaces Last.fm. `PROMPT.md` §7.8 originally said "explicitly do not build on
 * ListenBrainz"; the owner has since corrected that — the objection was to a *Navidrome
 * scrobbling* setup (multi-scrobbler and the Navidrome plugin), not to ListenBrainz as a
 * data source. See docs/DECISIONS.md D8.
 *
 * ## The endpoints that actually exist, verified 2026-08-14
 *
 * Similarity does **not** live on the core API. `GET /1/artist/{mbid}/similar` — the
 * obvious guess — **404s**, as does `/1/similar-artists`. The working surface is the
 * separate Labs host:
 *
 *   https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=…&algorithm=…
 *   https://labs.api.listenbrainz.org/similar-recordings/json?recording_mbids=…&algorithm=…
 *
 * `algorithm` is **required** and validated against a fixed enum — omit it or guess wrong
 * and the response is a 400 with an HTML body, not JSON. The permitted values differ
 * between the two endpoints, which is why they are separate constants below.
 *
 * ## The structural difference from Last.fm
 *
 * Last.fm resolved artists by NAME. ListenBrainz works entirely in **MBIDs**. That is
 * more work on the way in — a name has to be resolved through MusicBrainz first — and
 * considerably better once you are there: no fuzzy name collisions, and results come back
 * as MBIDs that can be stored and reused. It also composes with the rest of this app,
 * because the fingerprint backfill and the release radar already deal in MBIDs.
 *
 * The listen history is the same story: each listen carries `artist_mbids` and
 * `recording_mbid` inline, so the taste model feeds the similarity graph directly without
 * a single name lookup for anything actually played.
 *
 * ## Auth and rate limits
 *
 * No token is needed for similarity — it is open data. A token unlocks the user's own
 * listens. Rate limiting is real and documented in the response headers: 30 requests per
 * ~10s window, with `X-RateLimit-Reset-In` telling you exactly how long to wait. That
 * header is honoured rather than approximated with a fixed sleep.
 */

import { z } from 'zod'

const CORE_API = 'https://api.listenbrainz.org'
const LABS_API = 'https://labs.api.listenbrainz.org'

/**
 * Default similarity algorithms.
 *
 * Both are the widest-window variants available on their endpoint — `days_7500` is
 * roughly twenty years of listening sessions, which is what you want for a personal
 * library spanning decades rather than a chart-following one. The values are exposed so
 * they can be tuned without a redeploy; anything not in the endpoint's enum is rejected
 * with a 400, so they are not free-form.
 */
export const ARTIST_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30'

export const RECORDING_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30'

// ─────────────────────────────────────────────────────────────
// Schemas — permissive, per CLAUDE.md: parse, don't assert
// ─────────────────────────────────────────────────────────────

const SimilarArtistSchema = z
  .object({
    artist_mbid: z.string(),
    name: z.string().optional(),
    comment: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    score: z.number().optional(),
    reference_mbid: z.string().optional(),
  })
  .passthrough()

const SimilarRecordingSchema = z
  .object({
    recording_mbid: z.string(),
    recording_name: z.string().optional(),
    artist_credit_name: z.string().optional(),
    artist_credit_mbids: z.array(z.string()).nullable().optional(),
    release_name: z.string().nullable().optional(),
    score: z.number().optional(),
    reference_mbid: z.string().optional(),
  })
  .passthrough()

/** A listen. MBIDs appear in two places depending on how it was submitted. */
const ListenSchema = z
  .object({
    listened_at: z.number().optional(),
    track_metadata: z
      .object({
        artist_name: z.string().optional(),
        track_name: z.string().optional(),
        release_name: z.string().nullable().optional(),
        additional_info: z
          .object({
            artist_mbids: z.array(z.string()).nullable().optional(),
            recording_mbid: z.string().nullable().optional(),
            duration_ms: z.number().nullable().optional(),
          })
          .passthrough()
          .optional(),
        // Populated by ListenBrainz's own matching when the submitter sent no MBIDs.
        mbid_mapping: z
          .object({
            artist_mbids: z.array(z.string()).nullable().optional(),
            recording_mbid: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const ListensResponseSchema = z
  .object({
    payload: z
      .object({
        count: z.number().optional(),
        listens: z.array(ListenSchema).optional(),
        latest_listen_ts: z.number().optional(),
        oldest_listen_ts: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const ValidateTokenSchema = z
  .object({
    code: z.number().optional(),
    valid: z.boolean().optional(),
    user_name: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough()

// ─────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────

export interface SimilarArtist {
  mbid: string
  name: string
  /** Raw co-listen score. Unbounded; the graph normalizes per source. */
  score: number
  comment?: string | undefined
}

export interface SimilarRecording {
  mbid: string
  title: string
  artist: string
  artistMbids: string[]
  score: number
}

export interface Listen {
  playedAt: Date
  artistName: string
  trackName: string
  artistMbids: string[]
  recordingMbid: string | null
  durationMs: number | null
}

export interface ListenbrainzConfig {
  /** Optional. Only the user's own listens need it; similarity is open data. */
  token?: string | undefined
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Overridable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class ListenbrainzClient {
  private readonly cfg: ListenbrainzConfig
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  /** Epoch ms before which no request may be made, from X-RateLimit-Reset-In. */
  private blockedUntil = 0

  constructor(cfg: ListenbrainzConfig = {}) {
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.sleep = cfg.sleep ?? defaultSleep
  }

  get hasToken(): boolean {
    return Boolean(this.cfg.token)
  }

  /**
   * One request, honouring the documented rate limit.
   *
   * ListenBrainz reports `X-RateLimit-Remaining` and `X-RateLimit-Reset-In` on every
   * response. When the remaining count hits zero it waits exactly as long as the server
   * asked, rather than guessing with a fixed sleep — the same discipline the Spotify
   * limiter uses, and for the same reason: a fixed sleep is either too slow or not slow
   * enough, and you cannot tell which.
   */
  private async request<T>(url: string, schema: z.ZodType<T>): Promise<T | null> {
    const wait = this.blockedUntil - Date.now()
    if (wait > 0) await this.sleep(wait)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 20_000)

    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (this.cfg.token) headers.Authorization = `Token ${this.cfg.token}`

      const res = await this.fetchImpl(url, { signal: controller.signal, headers })

      const remaining = Number(res.headers.get('x-ratelimit-remaining'))
      const resetIn = Number(res.headers.get('x-ratelimit-reset-in'))
      if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetIn)) {
        // +250ms of slack: the header is whole seconds and the clocks are not aligned.
        this.blockedUntil = Date.now() + resetIn * 1000 + 250
      }

      if (res.status === 429) {
        const retryIn = Number.isFinite(resetIn) ? resetIn * 1000 + 250 : 5000
        this.blockedUntil = Date.now() + retryIn
        await this.sleep(retryIn)
        return this.request(url, schema)
      }

      if (!res.ok) return null

      // A 400 from the Labs API arrives as an HTML error page, so a JSON parse failure
      // here is an expected outcome rather than an exception worth propagating.
      const body: unknown = await res.json().catch(() => null)
      if (body === null) return null

      const parsed = schema.safeParse(body)
      return parsed.success ? parsed.data : null
    } catch {
      // Every integration is disableable and the app runs without it (CLAUDE.md).
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Similarity ──────────────────────────────────────────

  /**
   * Artists similar to one MBID, strongest first.
   *
   * The Labs endpoint accepts several reference MBIDs at once and tags each result with
   * `reference_mbid`, but it is called one at a time here: a batched call makes the
   * per-artist failure modes indistinguishable, and the rate limiter already spaces the
   * requests out.
   */
  async similarArtists(
    artistMbid: string,
    opts: { algorithm?: string; limit?: number } = {},
  ): Promise<SimilarArtist[]> {
    const url = new URL(`${LABS_API}/similar-artists/json`)
    url.searchParams.set('artist_mbids', artistMbid)
    url.searchParams.set('algorithm', opts.algorithm ?? ARTIST_ALGORITHM)

    const data = await this.request(url.toString(), z.array(SimilarArtistSchema))
    if (!data) return []

    return data
      // The reference artist comes back in its own result set; drop it.
      .filter((a) => a.artist_mbid !== artistMbid)
      .map((a) => ({
        mbid: a.artist_mbid,
        name: a.name ?? '',
        score: a.score ?? 0,
        comment: a.comment ?? undefined,
      }))
      .filter((a) => a.name !== '')
      .slice(0, opts.limit ?? 50)
  }

  /** Recordings similar to one recording MBID. The track-level half of §7.8's blend. */
  async similarRecordings(
    recordingMbid: string,
    opts: { algorithm?: string; limit?: number } = {},
  ): Promise<SimilarRecording[]> {
    const url = new URL(`${LABS_API}/similar-recordings/json`)
    url.searchParams.set('recording_mbids', recordingMbid)
    url.searchParams.set('algorithm', opts.algorithm ?? RECORDING_ALGORITHM)

    const data = await this.request(url.toString(), z.array(SimilarRecordingSchema))
    if (!data) return []

    return data
      .filter((r) => r.recording_mbid !== recordingMbid)
      .map((r) => ({
        mbid: r.recording_mbid,
        title: r.recording_name ?? '',
        artist: r.artist_credit_name ?? '',
        artistMbids: r.artist_credit_mbids ?? [],
        score: r.score ?? 0,
      }))
      .filter((r) => r.title !== '')
      .slice(0, opts.limit ?? 50)
  }

  // ── The user's own listens ──────────────────────────────

  /**
   * A page of listens, newest first.
   *
   * `minTs` is exclusive and lets a sync resume from the last import rather than
   * re-reading everything — the same checkpointing idea as the Spotify harvest, and it
   * matters here too because the owner's history is fed continuously by multi-scrobbler.
   */
  async listens(
    username: string,
    opts: { count?: number; minTs?: number; maxTs?: number } = {},
  ): Promise<Listen[]> {
    const url = new URL(`${CORE_API}/1/user/${encodeURIComponent(username)}/listens`)
    url.searchParams.set('count', String(Math.min(1000, opts.count ?? 100)))
    if (opts.minTs !== undefined) url.searchParams.set('min_ts', String(opts.minTs))
    if (opts.maxTs !== undefined) url.searchParams.set('max_ts', String(opts.maxTs))

    const data = await this.request(url.toString(), ListensResponseSchema)
    const listens = data?.payload?.listens ?? []

    return listens
      .map((listen): Listen | null => {
        if (!listen.listened_at) return null
        const meta = listen.track_metadata
        const info = meta?.additional_info
        const mapping = meta?.mbid_mapping

        // Prefer whichever source actually HAS ids, not merely whichever is non-null.
        //
        // This is not pedantry. Navidrome submits `additional_info.artist_mbids: []` — an
        // empty array, not a missing field — and ListenBrainz fills in the real ids under
        // `mbid_mapping` from its own matching. A `??` chain keeps the empty array and
        // throws the ids away, which silently cost every listen its MBIDs: exactly the
        // thing that makes ListenBrainz better than Last.fm here. Caught by running it
        // against the owner's real listen history, not by reading the docs.
        const submittedArtists = info?.artist_mbids ?? []
        const mappedArtists = mapping?.artist_mbids ?? []
        const artistMbids = submittedArtists.length > 0 ? submittedArtists : mappedArtists

        const recordingMbid = info?.recording_mbid || mapping?.recording_mbid || null

        return {
          playedAt: new Date(listen.listened_at * 1000),
          artistName: meta?.artist_name ?? '',
          trackName: meta?.track_name ?? '',
          artistMbids,
          recordingMbid,
          durationMs: info?.duration_ms ?? null,
        }
      })
      .filter((l): l is Listen => l !== null && l.artistName !== '' && l.trackName !== '')
  }

  /** Resolve the username the token belongs to, and prove the token works. */
  async validateToken(): Promise<{ valid: boolean; username?: string; detail: string }> {
    if (!this.cfg.token) return { valid: false, detail: 'No token configured' }

    const data = await this.request(`${CORE_API}/1/validate-token`, ValidateTokenSchema)
    if (!data) return { valid: false, detail: 'ListenBrainz did not respond' }
    return data.valid
      ? {
          valid: true,
          ...(data.user_name ? { username: data.user_name } : {}),
          detail: `Token valid for ${data.user_name ?? 'an unnamed user'}`,
        }
      : { valid: false, detail: data.message ?? 'Token rejected' }
  }

  /**
   * Health. Deliberately checks the SIMILARITY endpoint rather than the core API, since
   * that is what the recommendations actually depend on — and it is the half that needs
   * no token, so a health check passes even with nothing configured.
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    // Radiohead — a stable, well-listened MBID that will not stop existing.
    const probe = await this.similarArtists('a74b1b7f-71a5-4011-9441-d0b5e4122711', { limit: 1 })
    if (probe.length === 0) {
      return { ok: false, detail: 'ListenBrainz similarity returned nothing — the service may be down' }
    }

    if (!this.cfg.token) {
      return {
        ok: true,
        detail: 'Similarity reachable. No token set, so your own listens are not imported.',
      }
    }

    const token = await this.validateToken()
    return token.valid
      ? { ok: true, detail: `Similarity reachable; ${token.detail}` }
      : { ok: false, detail: `Similarity reachable, but the token was rejected: ${token.detail}` }
  }
}
