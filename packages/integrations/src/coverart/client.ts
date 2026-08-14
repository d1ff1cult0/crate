/**
 * Cover art lookup. PROMPT.md §7.6 step 4 — "embed if missing, from the source metadata
 * or Deezer/MusicBrainz Cover Art Archive".
 *
 * Three sources, in the order that gives the best picture for the least work:
 *
 *  1. The harvested Spotify payload. We already persisted `rawJson` on first sight, so
 *     the album image URL is sitting in the database at zero API cost — and it is the
 *     art the owner actually associates with the track. This one keeps working after the
 *     connector dies, because the URL came out of stored data rather than a live call.
 *  2. Cover Art Archive, when we have an MBID. Authoritative and unmetered.
 *  3. Deezer's public search, no auth required. The fallback that works for almost
 *     everything, at 500×500.
 *
 * Every path is optional. Art is a nicety — a failure here must never fail a download,
 * so everything returns null rather than throwing.
 */

import { z } from 'zod'

export interface CoverArtResult {
  url: string
  source: 'spotify' | 'coverartarchive' | 'deezer'
  width?: number | undefined
}

export interface CoverArtOptions {
  timeoutMs?: number
  userAgent?: string
  fetchImpl?: typeof fetch
}

const DEFAULT_UA = 'Crate/0.1 (self-hosted library tool)'

async function getJson<T>(
  url: string,
  schema: z.ZodType<T>,
  opts: CoverArtOptions,
): Promise<T | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': opts.userAgent ?? DEFAULT_UA, Accept: 'application/json' },
    })
    if (!res.ok) return null
    const parsed = schema.safeParse(await res.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── 1. Spotify payload we already own ─────────────────────────

/** Images as they appear inside a persisted TrackObject. Parsed permissively. */
const SpotifyImagesSchema = z
  .object({
    album: z
      .object({
        images: z
          .array(z.object({ url: z.string(), width: z.number().optional() }))
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

/**
 * Pull the largest album image out of a stored Spotify payload. Costs no network call
 * and no quota, which is why it is tried first.
 */
export function coverFromSpotifyPayload(rawJson: unknown): CoverArtResult | null {
  const parsed = SpotifyImagesSchema.safeParse(rawJson)
  if (!parsed.success) return null
  const images = parsed.data.album?.images ?? []
  if (images.length === 0) return null
  // Spotify returns widest-first, but sorting defends against that changing.
  const best = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]!
  return { url: best.url, source: 'spotify', width: best.width }
}

// ── 2. Cover Art Archive ──────────────────────────────────────

const CaaSchema = z.object({
  images: z
    .array(
      z.object({
        image: z.string(),
        front: z.boolean().optional(),
        thumbnails: z.record(z.string()).optional(),
      }),
    )
    .optional(),
})

/**
 * Cover Art Archive by MusicBrainz RELEASE id. Note this is a release MBID, not a
 * recording MBID — the fingerprint backfill gives us recordings, so callers generally
 * only have one of these when MusicBrainz lookup supplied it.
 */
export async function coverFromCoverArtArchive(
  releaseMbid: string,
  opts: CoverArtOptions = {},
): Promise<CoverArtResult | null> {
  const data = await getJson(
    `https://coverartarchive.org/release/${encodeURIComponent(releaseMbid)}`,
    CaaSchema,
    opts,
  )
  const images = data?.images ?? []
  const front = images.find((i) => i.front) ?? images[0]
  if (!front) return null
  return { url: front.thumbnails?.['500'] ?? front.image, source: 'coverartarchive' }
}

// ── 3. Deezer public search ───────────────────────────────────

const DeezerSearchSchema = z.object({
  data: z
    .array(
      z.object({
        title: z.string().optional(),
        artist: z.object({ name: z.string().optional() }).optional(),
        album: z
          .object({
            cover_xl: z.string().optional(),
            cover_big: z.string().optional(),
            cover_medium: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

/**
 * Deezer's public search. No auth, no key, and it covers essentially everything with a
 * commercial release — which is the case where missing art is most annoying.
 */
export async function coverFromDeezer(
  query: { title: string; artist: string; isrc?: string | null },
  opts: CoverArtOptions = {},
): Promise<CoverArtResult | null> {
  // ISRC is an exact identifier, so try it before text.
  if (query.isrc) {
    const byIsrc = await getJson(
      `https://api.deezer.com/track/isrc:${encodeURIComponent(query.isrc)}`,
      z.object({
        album: z
          .object({ cover_xl: z.string().optional(), cover_big: z.string().optional() })
          .optional(),
      }),
      opts,
    )
    const url = byIsrc?.album?.cover_xl ?? byIsrc?.album?.cover_big
    if (url) return { url, source: 'deezer' }
  }

  const terms = `artist:"${query.artist}" track:"${query.title}"`
  const data = await getJson(
    `https://api.deezer.com/search?q=${encodeURIComponent(terms)}&limit=5`,
    DeezerSearchSchema,
    opts,
  )
  for (const item of data?.data ?? []) {
    const url = item.album?.cover_xl ?? item.album?.cover_big ?? item.album?.cover_medium
    if (url) return { url, source: 'deezer' }
  }
  return null
}

// ── Orchestration ─────────────────────────────────────────────

export interface CoverArtQuery {
  title: string
  artist: string
  isrc?: string | null
  releaseMbid?: string | null
  /** Persisted Spotify TrackObject, if this track came from the harvest. */
  spotifyRaw?: unknown
}

/** Try each source in order and return the first hit, or null if none has art. */
export async function findCoverArt(
  query: CoverArtQuery,
  opts: CoverArtOptions = {},
): Promise<CoverArtResult | null> {
  if (query.spotifyRaw) {
    const fromSpotify = coverFromSpotifyPayload(query.spotifyRaw)
    if (fromSpotify) return fromSpotify
  }
  if (query.releaseMbid) {
    const fromCaa = await coverFromCoverArtArchive(query.releaseMbid, opts)
    if (fromCaa) return fromCaa
  }
  return coverFromDeezer(query, opts)
}

/**
 * Fetch the image bytes. Returns null on anything unexpected — including a response that
 * is not actually an image, which is how a redirect to an error page usually presents.
 */
export async function downloadCoverArt(
  url: string,
  opts: CoverArtOptions = {},
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const doFetch = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': opts.userAgent ?? DEFAULT_UA },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    // A "cover" under 1 KB is a placeholder or a tracking pixel, not art.
    if (bytes.byteLength < 1024) return null
    return { bytes, contentType }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
