/**
 * Deezer public API. PROMPT.md §7.8 — "/artist/{id}/related, no auth required".
 *
 * One of the four sources feeding the artist similarity graph. It needs no key and no
 * account, which is its whole appeal; the brief is also honest that its related-artists
 * data is thin compared to ListenBrainz's, so it is blended at a lower weight (see
 * `SOURCE_WEIGHTS` in core/graph.ts) rather than treated as authoritative.
 *
 * Deezer returns related artists as an ordered list with no similarity scores at all, so
 * rank is converted into a synthetic 0–1 weight here. That conversion is the reason
 * blending normalizes per source: comparing a synthetic rank score against ListenBrainz's
 * real similarity would be meaningless.
 */

import { z } from 'zod'

export interface DeezerOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Deezer is not documented as rate-limited, but hammering it is rude. */
  minIntervalMs?: number
}

const ArtistSearchSchema = z.object({
  data: z
    .array(z.object({ id: z.number(), name: z.string(), nb_fan: z.number().optional() }))
    .optional(),
})

const RelatedSchema = z.object({
  data: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
})

export interface RelatedArtist {
  name: string
  /** Synthetic: 1.0 for the closest, tapering with rank. */
  weight: number
}

export class DeezerClient {
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly minIntervalMs: number
  private lastRequestAt = 0

  constructor(opts: DeezerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.minIntervalMs = opts.minIntervalMs ?? 200
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastRequestAt = Date.now()
  }

  private async get<T>(url: string, schema: z.ZodType<T>): Promise<T | null> {
    await this.throttle()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return null
      const parsed = schema.safeParse(await res.json())
      return parsed.success ? parsed.data : null
    } catch {
      // Every integration is disableable and the app runs without it (CLAUDE.md).
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolve an artist name to a Deezer id. Returns null when nothing plausible matches. */
  async findArtistId(name: string): Promise<number | null> {
    const data = await this.get(
      `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`,
      ArtistSearchSchema,
    )
    const results = data?.data ?? []
    if (results.length === 0) return null

    // Exact case-insensitive name match first; Deezer's own ranking otherwise.
    const exact = results.find((r) => r.name.toLowerCase() === name.toLowerCase())
    return (exact ?? results[0]!).id
  }

  async relatedArtists(name: string, limit = 20): Promise<RelatedArtist[]> {
    const id = await this.findArtistId(name)
    if (id === null) return []

    const data = await this.get(
      `https://api.deezer.com/artist/${id}/related?limit=${limit}`,
      RelatedSchema,
    )
    const related = data?.data ?? []

    return related.map((artist, rank) => ({
      name: artist.name,
      // Rank → weight. Reciprocal rather than linear because Deezer's list degrades
      // fast: positions 1–5 are usually genuinely related, 15–20 much less so.
      weight: Number((1 / (1 + rank * 0.35)).toFixed(4)),
    }))
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const data = await this.get(
      'https://api.deezer.com/search/artist?q=radiohead&limit=1',
      ArtistSearchSchema,
    )
    return data?.data?.length
      ? { ok: true, detail: 'Deezer public API reachable' }
      : { ok: false, detail: 'Deezer public API did not respond as expected' }
  }
}
