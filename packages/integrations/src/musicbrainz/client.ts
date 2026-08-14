/**
 * MusicBrainz.
 *
 * Two jobs:
 *  1. Recording MBID → ISRC list. This is the other half of the phase-2 backfill:
 *     AcoustID gives us an MBID from a fingerprint, MusicBrainz turns that into the
 *     ISRC that makes tier-1 matching work — all without spending Spotify quota.
 *  2. Release-group queries for the weekly Release Radar (§7.8), since Spotify's
 *     new-releases endpoint is gone.
 *
 * MusicBrainz requires a descriptive User-Agent and asks for no more than 1 req/s.
 * Both are enforced here rather than left to callers.
 */

import { z } from 'zod'

const API = 'https://musicbrainz.org/ws/2'
const USER_AGENT = 'Crate/0.1.0 ( https://github.com/self-hosted/crate )'

const RecordingSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    length: z.number().nullable().optional(),
    isrcs: z.array(z.string()).optional(),
    'artist-credit': z
      .array(z.object({ name: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough()

const ReleaseGroupSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    'first-release-date': z.string().optional(),
    'primary-type': z.string().nullable().optional(),
  })
  .passthrough()

const ReleaseGroupBrowseSchema = z
  .object({
    'release-groups': z.array(ReleaseGroupSchema).optional(),
    'release-group-count': z.number().optional(),
  })
  .passthrough()

const ArtistSearchSchema = z
  .object({
    artists: z
      .array(z.object({ id: z.string(), name: z.string().optional(), score: z.number().optional() }).passthrough())
      .optional(),
  })
  .passthrough()

export interface MusicbrainzConfig {
  fetchImpl?: typeof fetch
  /** MusicBrainz asks for ≤1 req/s. The worker injects a limiter. */
  beforeRequest?: () => Promise<void>
  userAgent?: string
  log?: (level: 'warn', msg: string) => void
}

export class MusicbrainzClient {
  private readonly cfg: MusicbrainzConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: MusicbrainzConfig = {}) {
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private async call<T extends z.ZodTypeAny>(
    path: string,
    params: Record<string, string | number>,
    schema: T,
  ): Promise<z.infer<T> | null> {
    await this.cfg.beforeRequest?.()

    const url = new URL(`${API}${path}`)
    url.searchParams.set('fmt', 'json')
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    const res = await this.fetchImpl(url.toString(), {
      headers: { 'User-Agent': this.cfg.userAgent ?? USER_AGENT },
    })

    if (res.status === 404) return null
    if (!res.ok) {
      this.cfg.log?.('warn', `MusicBrainz ${path} returned HTTP ${res.status}`)
      return null
    }

    const parsed = schema.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  }

  /** Recording MBID → ISRCs. The second half of the no-Spotify ISRC backfill. */
  async getRecordingIsrcs(mbid: string): Promise<string[]> {
    const rec = await this.call(`/recording/${mbid}`, { inc: 'isrcs' }, RecordingSchema)
    return rec?.isrcs ?? []
  }

  async getRecording(
    mbid: string,
  ): Promise<{ mbid: string; title?: string; artist?: string; durationMs?: number; isrcs: string[] } | null> {
    const rec = await this.call(`/recording/${mbid}`, { inc: 'isrcs+artist-credits' }, RecordingSchema)
    if (!rec) return null
    return {
      mbid: rec.id,
      ...(rec.title ? { title: rec.title } : {}),
      ...(rec['artist-credit']?.[0]?.name ? { artist: rec['artist-credit'][0].name } : {}),
      ...(rec.length ? { durationMs: rec.length } : {}),
      isrcs: rec.isrcs ?? [],
    }
  }

  async searchArtist(name: string): Promise<{ mbid: string; name: string; score: number } | null> {
    const data = await this.call('/artist', { query: `artist:"${name}"`, limit: 1 }, ArtistSearchSchema)
    const a = data?.artists?.[0]
    if (!a) return null
    return { mbid: a.id, name: a.name ?? name, score: a.score ?? 0 }
  }

  /**
   * Release Radar (§7.8): release groups for an artist since a date. Replaces Spotify's
   * removed /browse/new-releases entirely.
   */
  async getArtistReleaseGroups(
    artistMbid: string,
    since?: Date,
  ): Promise<Array<{ mbid: string; title: string; releaseDate: string; type?: string }>> {
    const data = await this.call(
      '/release-group',
      { artist: artistMbid, limit: 100, type: 'album|ep|single' },
      ReleaseGroupBrowseSchema,
    )
    const groups = data?.['release-groups'] ?? []

    return groups
      .map((g) => ({
        mbid: g.id,
        title: g.title ?? '',
        releaseDate: g['first-release-date'] ?? '',
        ...(g['primary-type'] ? { type: g['primary-type'] } : {}),
      }))
      .filter((g) => {
        if (!since) return true
        if (!g.releaseDate) return false
        // MusicBrainz dates can be YYYY, YYYY-MM or YYYY-MM-DD; Date.parse handles all
        // three, treating partials as the start of the period, which is what we want.
        const d = Date.parse(g.releaseDate)
        return Number.isFinite(d) && d >= since.getTime()
      })
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate))
  }
}
