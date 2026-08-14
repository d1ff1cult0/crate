/**
 * Spotify Web API client — post-February-2026 surface only.
 *
 * Every method here corresponds to an endpoint verified as live in
 * docs/spotify-api-state.md on 2026-08-14. Endpoints that were removed are absent by
 * construction: if a caller needs one, the design is wrong (PROMPT.md §12), and the
 * compiler should say so rather than the API failing at runtime.
 *
 * Notable constraints baked in here:
 *   - NO batch fetches. One request per track. Callers must use the cache.
 *   - search limit is capped at 10 (was 50).
 *   - /artists/{id}/albums limit is capped at 10.
 *   - `market` is always sent, from settings — there is no way to read it from the
 *     profile any more and omitting it makes content read as unavailable (finding D).
 */

import { z } from 'zod'
import {
  AdaptiveRateLimiter,
  parseRetryAfter,
  QuotaExceededError,
} from './ratelimit.js'
import {
  ArtistSchema,
  CurrentUserSchema,
  FollowedArtistsSchema,
  PagingSchema,
  PlayHistorySchema,
  PlaylistItemSchema,
  PlaylistSchema,
  SavedAlbumSchema,
  SavedTrackSchema,
  SimplifiedAlbumSchema,
  SimplifiedTrackSchema,
  TrackSchema,
  type SpotifyPlaylist,
  type SpotifyTrack,
} from './schemas.js'

const API = 'https://api.spotify.com/v1'

export class SpotifyAuthError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'SpotifyAuthError'
    this.status = status
  }
}

/** Raised when a playlist is neither owned nor collaborated on (finding B). */
export class PlaylistNotAccessibleError extends Error {
  readonly playlistId: string
  constructor(playlistId: string) {
    super(
      `Spotify will not return the contents of playlist ${playlistId} because you are neither its owner nor a collaborator.`,
    )
    this.name = 'PlaylistNotAccessibleError'
    this.playlistId = playlistId
  }
}

export interface SpotifyClientOptions {
  getAccessToken: () => Promise<string>
  /** Called when a 401 suggests the token should be refreshed and the call retried. */
  onUnauthorized?: () => Promise<string | null>
  market: string
  limiter?: AdaptiveRateLimiter
  fetchImpl?: typeof fetch
  /** Structured logging hook — the worker passes a pino child with the job id. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object) => void
}

export interface RequestCounters {
  requests: number
  cacheHits: number
  retries: number
  rateLimitHits: number
}

export class SpotifyClient {
  private readonly opts: SpotifyClientOptions
  private readonly limiter: AdaptiveRateLimiter
  private readonly fetchImpl: typeof fetch
  readonly counters: RequestCounters = {
    requests: 0,
    cacheHits: 0,
    retries: 0,
    rateLimitHits: 0,
  }

  constructor(opts: SpotifyClientOptions) {
    this.opts = opts
    this.limiter = opts.limiter ?? new AdaptiveRateLimiter()
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  getLimiterStats() {
    return this.limiter.getStats()
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: object) {
    this.opts.log?.(level, msg, ctx)
  }

  /**
   * Core request. Handles rate limiting, quota exhaustion, token refresh and the
   * 403-means-not-yours case. Returns null on 404 so callers can treat a missing
   * resource as data rather than an exception.
   */
  private async request<T extends z.ZodTypeAny>(
    path: string,
    schema: T,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
    attempt = 0,
  ): Promise<z.infer<T> | null> {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`)
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }

    await this.limiter.acquire()
    const token = await this.opts.getAccessToken()
    this.counters.requests += 1

    const res = await this.fetchImpl(url.toString(), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (res.status === 429) {
      this.counters.rateLimitHits += 1
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'))
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        /* a 429 body is not guaranteed to be JSON */
      }
      // Throws QuotaExceededError when the quota is spent — deliberately NOT caught
      // here, so the job can checkpoint and stop rather than retry into a wall.
      const waited = await this.limiter.onRateLimited(retryAfter, body)
      this.log('warn', 'rate limited by Spotify, backing off', {
        path,
        waitedMs: waited,
        newRate: this.limiter.getStats().ratePerSecond,
      })
      if (attempt >= 8) throw new Error(`Gave up on ${path} after ${attempt} rate-limit retries`)
      this.counters.retries += 1
      return this.request(path, schema, init, attempt + 1)
    }

    if (res.status === 401) {
      const refreshed = await this.opts.onUnauthorized?.()
      if (refreshed && attempt < 2) {
        this.counters.retries += 1
        return this.request(path, schema, init, attempt + 1)
      }
      throw new SpotifyAuthError(
        'Spotify rejected the access token. The connection needs reauthorising.',
        401,
      )
    }

    if (res.status === 403) {
      // For playlist items this specifically means "not yours" (finding B).
      throw new SpotifyAuthError(
        `Spotify returned 403 for ${path}. For playlist contents this means the playlist is neither owned nor collaborated on.`,
        403,
      )
    }

    if (res.status === 404) return null

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Spotify ${res.status} for ${path}: ${text.slice(0, 300)}`)
    }

    this.limiter.onSuccess()

    const json = await res.json()
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      // Permissive by design: log and carry on with the raw shape rather than failing
      // a harvest because Spotify changed a field again.
      this.log('warn', 'Spotify response did not match the expected schema', {
        path,
        issues: parsed.error.issues.slice(0, 5),
      })
      return json as z.infer<T>
    }
    return parsed.data
  }

  /** Follow `next` links until exhausted, yielding each page's items. */
  private async *paginate<T extends z.ZodTypeAny>(
    path: string,
    itemSchema: T,
    query: Record<string, string | number | undefined> = {},
  ): AsyncGenerator<z.infer<T>[], void, unknown> {
    let url: string | null = path
    let q: Record<string, string | number | undefined> | undefined = {
      limit: 50,
      market: this.opts.market,
      ...query,
    }

    while (url) {
      // Annotated explicitly: the loop reassigns `url` from the page, so inference
      // would otherwise be circular.
      const page: { items?: unknown[]; next?: string | null } | null = await this.request(
        url,
        PagingSchema(itemSchema),
        { query: q },
      )
      if (!page) return
      const items = (page.items ?? []) as z.infer<T>[]
      if (items.length > 0) yield items
      url = page.next ?? null
      // `next` is a fully-qualified URL that already carries the query.
      q = undefined
    }
  }

  // ── Profile ────────────────────────────────────────────────

  async getCurrentUser() {
    const user = await this.request('/me', CurrentUserSchema)
    if (!user) throw new Error('GET /me returned 404, which should be impossible')
    return user
  }

  // ── Playlists ──────────────────────────────────────────────

  async *getMyPlaylists() {
    yield* this.paginate('/me/playlists', PlaylistSchema, { market: undefined })
  }

  async getPlaylist(id: string): Promise<SpotifyPlaylist | null> {
    return this.request(`/playlists/${id}`, PlaylistSchema, {
      query: { market: this.opts.market },
    })
  }

  /**
   * Playlist items. Throws PlaylistNotAccessibleError on 403 — the signal that the
   * playlist is neither owned nor collaborated on, which the importer turns into the
   * "copy it to your own library" flow rather than a generic error (§7.2 case 2).
   */
  async *getPlaylistItems(id: string) {
    try {
      yield* this.paginate(`/playlists/${id}/items`, PlaylistItemSchema)
    } catch (err) {
      if (err instanceof SpotifyAuthError && err.status === 403) {
        throw new PlaylistNotAccessibleError(id)
      }
      throw err
    }
  }

  // ── Library ────────────────────────────────────────────────

  /** Saved tracks carry FULL track objects including ISRC — free tier-1 keys. */
  async *getSavedTracks() {
    yield* this.paginate('/me/tracks', SavedTrackSchema)
  }

  async *getSavedAlbums() {
    yield* this.paginate('/me/albums', SavedAlbumSchema)
  }

  async *getFollowedArtists() {
    let after: string | undefined
    for (;;) {
      const page = await this.request('/me/following', FollowedArtistsSchema, {
        query: { type: 'artist', limit: 50, after },
      })
      const items = page?.artists?.items ?? []
      if (items.length > 0) yield items
      after = page?.artists?.cursors?.after
      if (!after || items.length === 0) return
    }
  }

  // ── Taste signals ──────────────────────────────────────────

  async *getTopItems(type: 'tracks' | 'artists', timeRange: 'short_term' | 'medium_term' | 'long_term') {
    const schema = type === 'tracks' ? TrackSchema : ArtistSchema
    yield* this.paginate(`/me/top/${type}`, schema, { time_range: timeRange, market: undefined })
  }

  async *getRecentlyPlayed() {
    // Cursor-paged, not offset-paged, and capped at 50 per page.
    let before: string | undefined
    for (;;) {
      const page = await this.request(
        '/me/player/recently-played',
        PagingSchema(PlayHistorySchema),
        { query: { limit: 50, before } },
      )
      const items = page?.items ?? []
      if (items.length === 0) return
      yield items
      const last = items[items.length - 1]
      const playedAt = last?.played_at
      if (!playedAt) return
      const ts = Date.parse(playedAt)
      if (!Number.isFinite(ts)) return
      before = String(ts)
    }
  }

  // ── Single-ID catalog fetches (no batch endpoints exist any more) ──

  /** ONE REQUEST PER TRACK. Always check the cache before calling this. */
  async getTrack(id: string): Promise<SpotifyTrack | null> {
    return this.request(`/tracks/${id}`, TrackSchema, { query: { market: this.opts.market } })
  }

  async getAlbum(id: string) {
    return this.request(`/albums/${id}`, SimplifiedAlbumSchema, {
      query: { market: this.opts.market },
    })
  }

  /** Album tracks are simplified and carry NO ISRC — see finding A. */
  async *getAlbumTracks(id: string) {
    yield* this.paginate(`/albums/${id}/tracks`, SimplifiedTrackSchema)
  }

  async getArtist(id: string) {
    return this.request(`/artists/${id}`, ArtistSchema)
  }

  /** Max limit is 10 here, down from 50 (finding G). */
  async *getArtistAlbums(id: string, groups = 'album,single') {
    yield* this.paginate(`/artists/${id}/albums`, SimplifiedAlbumSchema, {
      include_groups: groups,
      limit: 10,
    })
  }

  /** Search: limit is capped at 10, default 5, offset ≤ 1000. Paginate. */
  async search(
    query: string,
    type: 'track' | 'album' | 'artist',
    limit = 10,
    offset = 0,
  ): Promise<unknown> {
    return this.request(
      '/search',
      z.object({}).passthrough(),
      {
        query: {
          q: query,
          type,
          limit: Math.min(limit, 10),
          offset: Math.min(offset, 1000),
          market: this.opts.market,
        },
      },
    )
  }
}

export { AdaptiveRateLimiter, QuotaExceededError }
