/**
 * Quality scoring. PROMPT.md §7.6.
 *
 * One number that drives keeper selection in dedupe (§7.7) and candidate acceptance in
 * downloads (§7.5). The weights are deliberately explicit and commented — §11 says
 * these get tuned by hand, and a keeper rule nobody can explain is a keeper rule
 * nobody trusts.
 *
 *   format rank      0–100   the dominant term: lossless beats everything
 *   bitrate bonus    0–15
 *   sample/bit depth 0–10
 *   tag completeness 0–15
 *   embedded art     0–5
 *   source trust     0–10
 *                    ─────
 *   total            0–155, reported as-is (not rescaled — the spread is the point)
 */

export interface FileQualityInput {
  format: string
  bitrate?: number | null
  sampleRate?: number | null
  bitDepth?: number | null
  tags?: Record<string, unknown> | null
  hasEmbeddedArt?: boolean
  sourceProvider?: string | null
  /** Lossy files transcoded from lossy sources sound worse than their bitrate implies. */
  suspectedTranscode?: boolean
}

export const FORMAT_RANK: Record<string, number> = {
  flac: 100,
  alac: 100,
  wav: 95, // lossless but bulky and usually untagged
  aiff: 95,
  ape: 95,
  wv: 95,
  opus: 80,
  vorbis: 70,
  ogg: 70,
  mp3: 60, // refined by bitrate below
  aac: 65,
  m4a: 65,
  wma: 30,
  unknown: 20,
}

/** Tags that matter for library hygiene and for closing the ISRC loop (§7.6 step 3). */
const IMPORTANT_TAGS = [
  'title',
  'artist',
  'albumartist',
  'album',
  'date',
  'track',
  'disc',
  'genre',
  'isrc',
  'musicbrainz_trackid',
] as const

/** Providers we trust to deliver what they claim. Tuned from experience over time. */
const SOURCE_TRUST: Record<string, number> = {
  streamrip: 10,
  deemix: 10,
  bandcamp: 10,
  slskd: 7, // real rips, but uploader quality varies
  lidarr: 8,
  ytm: 4, // transcoded from YouTube's own encode
  ytdlp: 3,
  manual: 6,
}

export function formatRank(format: string, bitrate?: number | null): number {
  const f = format.toLowerCase().replace(/^\./, '')
  const base = FORMAT_RANK[f] ?? FORMAT_RANK.unknown!

  // MP3 spans a huge quality range; the brief calls out 320 and V0 explicitly.
  if (f === 'mp3' && bitrate) {
    const kbps = bitrate > 10000 ? bitrate / 1000 : bitrate
    if (kbps >= 320) return 75
    if (kbps >= 245) return 70 // V0 lands around 245–260
    if (kbps >= 192) return 55
    if (kbps >= 128) return 40
    return 25
  }
  if ((f === 'aac' || f === 'm4a') && bitrate) {
    const kbps = bitrate > 10000 ? bitrate / 1000 : bitrate
    if (kbps >= 256) return 70
    if (kbps >= 192) return 62
    return 45
  }
  return base
}

export function isLossless(format: string): boolean {
  return ['flac', 'alac', 'wav', 'aiff', 'ape', 'wv'].includes(
    format.toLowerCase().replace(/^\./, ''),
  )
}

export function tagCompleteness(tags?: Record<string, unknown> | null): number {
  if (!tags) return 0
  const present = IMPORTANT_TAGS.filter((t) => {
    const v = tags[t] ?? tags[t.toUpperCase()]
    return v !== undefined && v !== null && String(v).trim() !== ''
  }).length
  return Math.round((present / IMPORTANT_TAGS.length) * 15)
}

export function qualityScore(input: FileQualityInput): number {
  const fmt = input.format.toLowerCase().replace(/^\./, '')
  let score = formatRank(fmt, input.bitrate)

  // Bitrate bonus, lossy only — for lossless it is a function of the source material.
  if (!isLossless(fmt) && input.bitrate) {
    const kbps = input.bitrate > 10000 ? input.bitrate / 1000 : input.bitrate
    score += Math.min(15, Math.max(0, Math.round((kbps - 128) / 16)))
  }

  // Hi-res bonus, lossless only.
  if (isLossless(fmt)) {
    if ((input.sampleRate ?? 0) > 48000) score += 5
    if ((input.bitDepth ?? 0) > 16) score += 5
  }

  score += tagCompleteness(input.tags)
  if (input.hasEmbeddedArt) score += 5
  if (input.sourceProvider) score += SOURCE_TRUST[input.sourceProvider.toLowerCase()] ?? 0

  // A "FLAC" transcoded from a 128k MP3 is worse than an honest MP3, and lossless
  // format rank would otherwise reward the lie.
  if (input.suspectedTranscode) score -= 30

  return Math.max(0, Math.round(score))
}

export interface KeeperInput extends FileQualityInput {
  id: string
  qualityScore?: number
  path: string
  mtime: Date
}

/**
 * Keeper selection (§7.7): highest qualityScore, tie-broken on tag completeness, then
 * embedded art, then a proper album folder over a loose file, then oldest mtime.
 *
 * Oldest-wins on the final tie-break is deliberate: the older file is the one already
 * referenced by existing playlists and play counts.
 */
export function selectKeeper<T extends KeeperInput>(files: T[]): T | null {
  if (files.length === 0) return null
  if (files.length === 1) return files[0]!

  const scored = files.map((f) => ({
    file: f,
    score: f.qualityScore ?? qualityScore(f),
    tags: tagCompleteness(f.tags),
    art: f.hasEmbeddedArt ? 1 : 0,
    foldered: looksFoldered(f.path) ? 1 : 0,
    mtime: f.mtime.getTime(),
  }))

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.tags - a.tags ||
      b.art - a.art ||
      b.foldered - a.foldered ||
      a.mtime - b.mtime,
  )

  return scored[0]!.file
}

/**
 * Heuristic for "lives in a proper album folder" rather than a loose file: at least
 * two directory levels under the root, and the parent isn't an obvious dumping ground.
 */
export function looksFoldered(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length < 3) return false
  const parent = (parts[parts.length - 2] ?? '').toLowerCase()
  return !['downloads', 'music', 'incoming', 'complete', 'unsorted', 'misc', 'various'].includes(
    parent,
  )
}
