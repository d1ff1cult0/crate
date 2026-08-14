/**
 * Text and CSV parsing for the importers. PROMPT.md §7.2 items 4 and 5.
 *
 * The text parser has to be tolerant of what people actually paste: numbered lists,
 * "Artist - Title", "Title - Artist", tracklists copied out of a webpage with
 * durations and junk on the end. It reports a per-line confidence so the UI can show
 * a preview and let the owner fix the ambiguous ones rather than silently guessing.
 */

export interface ParsedLine {
  lineNumber: number
  raw: string
  artist: string
  title: string
  /** 0–1. Below ~0.7 the UI should ask rather than assume. */
  confidence: number
  /** Why this reading was chosen, shown in the preview. */
  note: string
}

export interface TextParseResult {
  tracks: ParsedLine[]
  /** Lines that were skipped entirely (blank, headers, separators). */
  ignored: Array<{ lineNumber: number; raw: string; reason: string }>
}

const DASH_SPLIT = /\s+[-–—−]\s+|\s+[-–—−]|[-–—−]\s+/

/** Trailing "(3:42)" / "[03:42]" / bare "3:42" durations from copied tracklists. */
const TRAILING_DURATION = /[\s([]*\b\d{1,2}:\d{2}\b[\s)\]]*$/

/** Leading "1." / "01 -" / "1)" / "#1" list numbering. */
const LEADING_INDEX = /^\s*[#(]?\s*\d{1,3}\s*[.)\-–—:]\s*/

const IGNORABLE = /^\s*(?:tracklist|track list|disc\s*\d+|cd\s*\d+|side\s*[ab]|[-=_*]{3,})\s*:?\s*$/i

/**
 * Tokens that identify the ARTIST side when the order is ambiguous. Feature credits
 * almost always attach to the artist, so their presence disambiguates "A - B".
 */
const ARTIST_HINTS = /\b(?:feat\.?|ft\.?|featuring|&|vs\.?|presents|pres\.)\b/i

export function parseTrackLines(input: string): TextParseResult {
  const tracks: ParsedLine[] = []
  const ignored: TextParseResult['ignored'] = []

  const lines = input.split(/\r?\n/)

  lines.forEach((raw, idx) => {
    const lineNumber = idx + 1
    const trimmed = raw.trim()

    if (!trimmed) {
      return // blank lines aren't worth reporting
    }
    if (IGNORABLE.test(trimmed)) {
      ignored.push({ lineNumber, raw, reason: 'looks like a heading or separator' })
      return
    }

    let work = trimmed.replace(LEADING_INDEX, '')
    const hadIndex = work !== trimmed
    work = work.replace(TRAILING_DURATION, '').trim()

    if (!work) {
      ignored.push({ lineNumber, raw, reason: 'nothing left after stripping numbering' })
      return
    }

    // Tab or a doubled separator is a strong signal of a two-column paste.
    const tabParts = work.split(/\t+/).map((p) => p.trim()).filter(Boolean)
    if (tabParts.length >= 2) {
      tracks.push({
        lineNumber,
        raw,
        artist: tabParts[0]!,
        title: tabParts[1]!,
        confidence: 0.95,
        note: 'tab-separated columns',
      })
      return
    }

    const parts = work.split(DASH_SPLIT).map((p) => p.trim()).filter(Boolean)

    if (parts.length === 1) {
      // No separator at all — we have a title and no artist. Real, and worth importing
      // as a title-only search rather than dropping.
      tracks.push({
        lineNumber,
        raw,
        artist: '',
        title: parts[0]!,
        confidence: 0.4,
        note: 'no separator found — treated as a title with no artist',
      })
      return
    }

    // More than two segments: "Artist - Album - Title" or a title containing a dash.
    // Prefer the first segment as artist and rejoin the rest, which is the common case.
    const left = parts[0]!
    const right = parts.slice(1).join(' - ')

    let artist = left
    let title = right
    let confidence = hadIndex ? 0.88 : 0.82
    let note = parts.length > 2 ? 'multiple dashes — first segment taken as the artist' : 'split on dash'

    // Disambiguate direction using feature credits.
    const leftHint = ARTIST_HINTS.test(left)
    const rightHint = ARTIST_HINTS.test(right)
    if (rightHint && !leftHint) {
      // "Title - Artist feat. X" — the credit is on the right, so the order is reversed.
      artist = right
      title = left
      confidence = 0.8
      note = 'feature credit on the right — read as "Title - Artist"'
    } else if (leftHint) {
      confidence = Math.min(0.92, confidence + 0.06)
      note = 'feature credit on the left confirms "Artist - Title"'
    }

    if (parts.length > 2) confidence -= 0.1

    tracks.push({ lineNumber, raw, artist, title, confidence: Math.max(0, Math.min(1, confidence)), note })
  })

  return { tracks, ignored }
}

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────

export interface CsvColumnMap {
  title: number
  artist: number
  album?: number
  isrc?: number
  durationMs?: number
  addedAt?: number
  spotifyId?: number
}

export interface CsvDetectResult {
  headers: string[]
  mapping: CsvColumnMap | null
  /** Named layout when recognized, e.g. "exportify". */
  layout: string | null
  /** Set when the layout could not be recognized — the UI then asks for a mapping. */
  reason?: string
}

/** RFC4180-ish CSV parser: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!

    if (inQuotes) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c === '\r') {
      // handled by the \n branch
    } else {
      field += c
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const HEADER_ALIASES: Record<keyof CsvColumnMap, string[]> = {
  title: ['track name', 'title', 'song', 'name', 'track', 'track title'],
  artist: ['artist name', 'artist', 'artists', 'album artist', 'artist(s)'],
  album: ['album name', 'album'],
  isrc: ['isrc'],
  durationMs: ['track duration (ms)', 'duration (ms)', 'duration_ms', 'length (ms)', 'duration'],
  addedAt: ['added at', 'added_at', 'date added'],
  spotifyId: ['track id', 'spotify id', 'track uri', 'spotify track id', 'uri'],
}

function findColumn(headers: string[], aliases: string[]): number | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase())
  for (const alias of aliases) {
    const idx = lower.indexOf(alias)
    if (idx !== -1) return idx
  }
  // Fall back to a contains match, longest alias first to avoid "artist" matching
  // "album artist" when a better column exists.
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    const idx = lower.findIndex((h) => h.includes(alias))
    if (idx !== -1) return idx
  }
  return undefined
}

/** Autodetect Exportify and similar layouts; return null mapping when unsure (§7.2.4). */
export function detectCsvLayout(rows: string[][]): CsvDetectResult {
  const headers = rows[0] ?? []
  if (headers.length === 0) {
    return { headers: [], mapping: null, layout: null, reason: 'file appears to be empty' }
  }

  const title = findColumn(headers, HEADER_ALIASES.title)
  const artist = findColumn(headers, HEADER_ALIASES.artist)

  if (title === undefined || artist === undefined) {
    return {
      headers,
      mapping: null,
      layout: null,
      reason:
        'Could not find a title and an artist column. Map them by hand and the rest will follow.',
    }
  }

  const lower = headers.map((h) => h.trim().toLowerCase())
  // Exportify's artist column is literally "Artist Name(s)", so this has to be a
  // contains check rather than an equality one.
  const has = (needle: string) => lower.some((h) => h.includes(needle))
  const isExportify = has('track uri') && has('track name') && has('artist name')

  const mapping: CsvColumnMap = { title, artist }
  const album = findColumn(headers, HEADER_ALIASES.album)
  const isrc = findColumn(headers, HEADER_ALIASES.isrc)
  const durationMs = findColumn(headers, HEADER_ALIASES.durationMs)
  const addedAt = findColumn(headers, HEADER_ALIASES.addedAt)
  const spotifyId = findColumn(headers, HEADER_ALIASES.spotifyId)
  if (album !== undefined) mapping.album = album
  if (isrc !== undefined) mapping.isrc = isrc
  if (durationMs !== undefined) mapping.durationMs = durationMs
  if (addedAt !== undefined) mapping.addedAt = addedAt
  if (spotifyId !== undefined) mapping.spotifyId = spotifyId

  return { headers, mapping, layout: isExportify ? 'exportify' : 'generic' }
}

export interface CsvTrack {
  title: string
  artists: string[]
  album?: string
  isrc?: string
  durationMs?: number
  addedAt?: string
  spotifyId?: string
}

export function rowsToTracks(rows: string[][], mapping: CsvColumnMap): CsvTrack[] {
  const out: CsvTrack[] = []
  for (const row of rows.slice(1)) {
    const title = (row[mapping.title] ?? '').trim()
    const artistRaw = (row[mapping.artist] ?? '').trim()
    if (!title) continue

    const track: CsvTrack = {
      title,
      artists: artistRaw ? artistRaw.split(/\s*[,;]\s*/).filter(Boolean) : [],
    }

    if (mapping.album !== undefined) {
      const v = (row[mapping.album] ?? '').trim()
      if (v) track.album = v
    }
    if (mapping.isrc !== undefined) {
      const v = (row[mapping.isrc] ?? '').trim()
      if (v) track.isrc = v
    }
    if (mapping.durationMs !== undefined) {
      const v = (row[mapping.durationMs] ?? '').trim()
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) track.durationMs = Math.round(n)
    }
    if (mapping.addedAt !== undefined) {
      const v = (row[mapping.addedAt] ?? '').trim()
      if (v) track.addedAt = v
    }
    if (mapping.spotifyId !== undefined) {
      const v = (row[mapping.spotifyId] ?? '').trim()
      if (v) track.spotifyId = v.replace(/^spotify:track:/, '')
    }

    out.push(track)
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Spotify URL / URI parsing (§7.2.1–2)
// ─────────────────────────────────────────────────────────────

export interface SpotifyRef {
  kind: 'playlist' | 'track' | 'album' | 'artist' | 'user'
  id: string
}

/** Accepts open.spotify.com URLs (with locale prefixes and query strings) and URIs. */
export function parseSpotifyRef(input: string): SpotifyRef | null {
  const s = input.trim()

  const uri = /^spotify:(playlist|track|album|artist|user):([A-Za-z0-9]+)$/.exec(s)
  if (uri) return { kind: uri[1] as SpotifyRef['kind'], id: uri[2]! }

  try {
    const url = new URL(s)
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null
    // Strip an optional locale segment: /intl-nl/playlist/xxxx
    const segments = url.pathname.split('/').filter(Boolean)
    const start = segments[0]?.startsWith('intl-') ? 1 : 0
    const kind = segments[start]
    const id = segments[start + 1]
    if (!kind || !id) return null
    if (!['playlist', 'track', 'album', 'artist', 'user'].includes(kind)) return null
    return { kind: kind as SpotifyRef['kind'], id: id.split('?')[0]! }
  } catch {
    return null
  }
}
