/**
 * Last.fm.
 *
 * Load-bearing by decision (docs/DECISIONS.md D7): with ListenBrainz ruled out, this is
 * the only remaining source of real collaborative-filtering data in the similarity
 * blend. Deezer's related-artists is thin, YTM radios reflect YouTube's population, and
 * co-occurrence only knows what the owner already has. So this connects in phase 1 and
 * starts accumulating well before phase 7 needs it.
 *
 * Free API key, no OAuth needed for the read endpoints used here.
 */

import { z } from 'zod'

const API = 'https://ws.audioscrobbler.com/2.0/'

const SimilarArtistSchema = z
  .object({
    name: z.string(),
    match: z.union([z.string(), z.number()]).optional(),
    mbid: z.string().optional(),
  })
  .passthrough()

const SimilarArtistsSchema = z
  .object({
    similarartists: z.object({ artist: z.array(SimilarArtistSchema).optional() }).passthrough().optional(),
  })
  .passthrough()

const SimilarTrackSchema = z
  .object({
    name: z.string(),
    match: z.union([z.string(), z.number()]).optional(),
    artist: z.object({ name: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()

const SimilarTracksSchema = z
  .object({
    similartracks: z.object({ track: z.array(SimilarTrackSchema).optional() }).passthrough().optional(),
  })
  .passthrough()

const RecentTracksSchema = z
  .object({
    recenttracks: z
      .object({
        track: z
          .array(
            z
              .object({
                name: z.string().optional(),
                artist: z.union([z.string(), z.object({ '#text': z.string().optional() }).passthrough()]).optional(),
                date: z.object({ uts: z.string().optional() }).passthrough().optional(),
              })
              .passthrough(),
          )
          .optional(),
        '@attr': z.object({ totalPages: z.string().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

export interface LastfmConfig {
  apiKey: string
  fetchImpl?: typeof fetch
  /** Last.fm asks for ~5 req/s; the worker passes a limiter to stay polite. */
  beforeRequest?: () => Promise<void>
}

function toNumber(v: string | number | undefined): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export class LastfmClient {
  private readonly cfg: LastfmConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: LastfmConfig) {
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private async call<T extends z.ZodTypeAny>(
    method: string,
    params: Record<string, string | number>,
    schema: T,
  ): Promise<z.infer<T> | null> {
    await this.cfg.beforeRequest?.()
    const url = new URL(API)
    url.searchParams.set('method', method)
    url.searchParams.set('api_key', this.cfg.apiKey)
    url.searchParams.set('format', 'json')
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    const res = await this.fetchImpl(url.toString())
    if (!res.ok) return null
    const parsed = schema.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  }

  /** The single most valuable call here: real "people who like X also like Y" data. */
  async getSimilarArtists(
    artist: string,
    limit = 50,
  ): Promise<Array<{ name: string; weight: number; mbid?: string }>> {
    const data = await this.call('artist.getSimilar', { artist, limit, autocorrect: 1 }, SimilarArtistsSchema)
    const list = data?.similarartists?.artist ?? []
    return list.map((a) => ({
      name: a.name,
      weight: toNumber(a.match),
      ...(a.mbid ? { mbid: a.mbid } : {}),
    }))
  }

  async getSimilarTracks(
    artist: string,
    track: string,
    limit = 50,
  ): Promise<Array<{ name: string; artist: string; weight: number }>> {
    const data = await this.call(
      'track.getSimilar',
      { artist, track, limit, autocorrect: 1 },
      SimilarTracksSchema,
    )
    const list = data?.similartracks?.track ?? []
    return list.map((t) => ({
      name: t.name,
      artist: t.artist?.name ?? '',
      weight: toNumber(t.match),
    }))
  }

  /** Scrobbles, optionally connected — another live signal after Spotify is gone. */
  async getRecentTracks(
    user: string,
    page = 1,
    limit = 200,
  ): Promise<{ tracks: Array<{ artist: string; track: string; playedAt: Date }>; totalPages: number }> {
    const data = await this.call('user.getRecentTracks', { user, page, limit }, RecentTracksSchema)
    const raw = data?.recenttracks?.track ?? []
    const tracks = raw
      .map((t) => {
        const uts = t.date?.uts
        if (!uts) return null // "now playing" entries have no date
        const artist = typeof t.artist === 'string' ? t.artist : (t.artist?.['#text'] ?? '')
        return { artist, track: t.name ?? '', playedAt: new Date(Number(uts) * 1000) }
      })
      .filter((t): t is NonNullable<typeof t> => t !== null)

    return {
      tracks,
      totalPages: Number(data?.recenttracks?.['@attr']?.totalPages ?? 1),
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.getSimilarArtists('Radiohead', 1)
      return r.length > 0
        ? { ok: true, detail: 'Last.fm responding' }
        : { ok: false, detail: 'Last.fm responded but returned no data — check the API key' }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }
}
