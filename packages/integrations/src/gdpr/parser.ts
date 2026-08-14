/**
 * Spotify GDPR export parser — PROMPT.md §7.2 case 3.
 *
 * This path needs no API, no Premium and no quota, and it carries the complete
 * streaming history that the recommendation engine wants. Once the subscription lapses
 * on 2026-09-01 it becomes the ONLY way new Spotify data enters the system, so it is
 * built as a first-class importer.
 *
 * Caveat, recorded in docs/DECISIONS.md A9: the export was requested but has not
 * arrived, so this is written against Spotify's documented shapes and is the one
 * importer not verified against real data. Everything is therefore parsed permissively
 * — unknown keys pass through, absent fields are tolerated, and a single malformed
 * entry never fails the file.
 *
 * Two export variants exist and both are handled:
 *   "Account data"   → StreamingHistory0.json …      (~1 year, fewer fields)
 *   "Extended history" → Streaming_History_Audio_2023_1.json … (full history, richer)
 */

import { z } from 'zod'

/** Basic export. Field names are exactly as Spotify emits them. */
const BasicHistoryEntrySchema = z
  .object({
    endTime: z.string().optional(),
    artistName: z.string().optional(),
    trackName: z.string().optional(),
    msPlayed: z.number().optional(),
  })
  .passthrough()

/** Extended streaming history — richer, and what §7.8 actually wants. */
const ExtendedHistoryEntrySchema = z
  .object({
    ts: z.string().optional(),
    ms_played: z.number().optional(),
    master_metadata_track_name: z.string().nullable().optional(),
    master_metadata_album_artist_name: z.string().nullable().optional(),
    master_metadata_album_album_name: z.string().nullable().optional(),
    spotify_track_uri: z.string().nullable().optional(),
    reason_start: z.string().nullable().optional(),
    reason_end: z.string().nullable().optional(),
    skipped: z.boolean().nullable().optional(),
    shuffle: z.boolean().nullable().optional(),
  })
  .passthrough()

const PlaylistFileSchema = z
  .object({
    playlists: z
      .array(
        z
          .object({
            name: z.string().optional(),
            lastModifiedDate: z.string().optional(),
            description: z.string().nullable().optional(),
            items: z
              .array(
                z
                  .object({
                    track: z
                      .object({
                        trackName: z.string().nullable().optional(),
                        artistName: z.string().nullable().optional(),
                        albumName: z.string().nullable().optional(),
                        trackUri: z.string().nullable().optional(),
                      })
                      .passthrough()
                      .nullable()
                      .optional(),
                    addedDate: z.string().nullable().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

const YourLibrarySchema = z
  .object({
    tracks: z
      .array(
        z
          .object({
            artist: z.string().optional(),
            album: z.string().optional(),
            track: z.string().optional(),
            uri: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    albums: z
      .array(z.object({ artist: z.string().optional(), album: z.string().optional(), uri: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough()

const FollowSchema = z
  .object({
    followingUsers: z.array(z.unknown()).optional(),
    followerCount: z.number().optional(),
    dismissingUsers: z.array(z.unknown()).optional(),
  })
  .passthrough()

export interface StreamingEvent {
  artistName: string
  trackName: string
  albumName?: string
  playedAt: Date
  msPlayed: number
  /** §7.8: treat under 30s as a skip. */
  skipped: boolean
  spotifyId?: string
}

export interface ExportPlaylist {
  name: string
  description?: string
  tracks: Array<{
    title: string
    artists: string[]
    album?: string
    spotifyId?: string
    addedAt?: Date
  }>
}

export interface ParsedExport {
  streamingEvents: StreamingEvent[]
  playlists: ExportPlaylist[]
  savedTracks: Array<{ title: string; artists: string[]; album?: string; spotifyId?: string }>
  savedAlbums: Array<{ album: string; artist: string }>
  /** Non-fatal problems, surfaced in the import summary rather than thrown. */
  warnings: string[]
}

/** §7.8: "Treat ms_played < 30000 as a skip." */
export const SKIP_THRESHOLD_MS = 30_000

function uriToId(uri: string | null | undefined): string | undefined {
  if (!uri) return undefined
  const m = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri)
  return m?.[1]
}

/** Classify a filename from the export zip. Both variants use several conventions. */
export function classifyExportFile(
  filename: string,
): 'streaming-basic' | 'streaming-extended' | 'playlists' | 'library' | 'follow' | 'unknown' {
  const base = filename.split('/').pop() ?? filename

  if (/^Streaming_History_Audio.*\.json$/i.test(base)) return 'streaming-extended'
  // Both "StreamingHistory0.json" and "StreamingHistory_music_3.json" occur in the wild.
  if (/^StreamingHistory(?:_music)?_?\d*\.json$/i.test(base)) return 'streaming-basic'
  if (/^Playlist\d*\.json$/i.test(base)) return 'playlists'
  if (/^YourLibrary\.json$/i.test(base)) return 'library'
  if (/^Follow\.json$/i.test(base)) return 'follow'
  return 'unknown'
}

export function parseStreamingHistory(json: unknown, warnings: string[]): StreamingEvent[] {
  if (!Array.isArray(json)) {
    warnings.push('A streaming history file was not a JSON array and has been skipped.')
    return []
  }

  const events: StreamingEvent[] = []

  for (const raw of json) {
    // Try the extended shape first — it carries more, including an explicit skip flag.
    const ext = ExtendedHistoryEntrySchema.safeParse(raw)
    if (ext.success && ext.data.ts && ext.data.master_metadata_track_name) {
      const playedAt = new Date(ext.data.ts)
      if (Number.isNaN(playedAt.getTime())) continue
      const msPlayed = ext.data.ms_played ?? 0
      const id = uriToId(ext.data.spotify_track_uri)
      events.push({
        artistName: ext.data.master_metadata_album_artist_name ?? '',
        trackName: ext.data.master_metadata_track_name,
        ...(ext.data.master_metadata_album_album_name
          ? { albumName: ext.data.master_metadata_album_album_name }
          : {}),
        playedAt,
        msPlayed,
        // Prefer Spotify's own flag when present, fall back to the duration rule.
        skipped: ext.data.skipped === true || msPlayed < SKIP_THRESHOLD_MS,
        ...(id ? { spotifyId: id } : {}),
      })
      continue
    }

    const basic = BasicHistoryEntrySchema.safeParse(raw)
    if (basic.success && basic.data.endTime && basic.data.trackName) {
      // The basic export's endTime is "YYYY-MM-DD HH:MM" in UTC with no zone marker.
      const normalized = basic.data.endTime.includes('T')
        ? basic.data.endTime
        : basic.data.endTime.replace(' ', 'T') + ':00Z'
      const playedAt = new Date(normalized)
      if (Number.isNaN(playedAt.getTime())) continue
      const msPlayed = basic.data.msPlayed ?? 0
      events.push({
        artistName: basic.data.artistName ?? '',
        trackName: basic.data.trackName,
        playedAt,
        msPlayed,
        skipped: msPlayed < SKIP_THRESHOLD_MS,
      })
    }
  }

  return events
}

export function parsePlaylistFile(json: unknown, warnings: string[]): ExportPlaylist[] {
  const parsed = PlaylistFileSchema.safeParse(json)
  if (!parsed.success) {
    warnings.push('A playlist file did not match the expected shape and has been skipped.')
    return []
  }

  return (parsed.data.playlists ?? []).map((p) => ({
    name: p.name ?? '(untitled playlist)',
    ...(p.description ? { description: p.description } : {}),
    tracks: (p.items ?? [])
      .map((item) => {
        const t = item.track
        if (!t?.trackName) return null
        const id = uriToId(t.trackUri)
        const addedAt = item.addedDate ? new Date(item.addedDate) : undefined
        return {
          title: t.trackName,
          artists: t.artistName ? [t.artistName] : [],
          ...(t.albumName ? { album: t.albumName } : {}),
          ...(id ? { spotifyId: id } : {}),
          ...(addedAt && !Number.isNaN(addedAt.getTime()) ? { addedAt } : {}),
        }
      })
      .filter((t): t is NonNullable<typeof t> => t !== null),
  }))
}

export function parseLibraryFile(
  json: unknown,
  warnings: string[],
): Pick<ParsedExport, 'savedTracks' | 'savedAlbums'> {
  const parsed = YourLibrarySchema.safeParse(json)
  if (!parsed.success) {
    warnings.push('YourLibrary.json did not match the expected shape and has been skipped.')
    return { savedTracks: [], savedAlbums: [] }
  }

  return {
    savedTracks: (parsed.data.tracks ?? []).map((t) => {
      const id = uriToId(t.uri)
      return {
        title: t.track ?? '',
        artists: t.artist ? [t.artist] : [],
        ...(t.album ? { album: t.album } : {}),
        ...(id ? { spotifyId: id } : {}),
      }
    }).filter((t) => t.title),
    savedAlbums: (parsed.data.albums ?? [])
      .map((a) => ({ album: a.album ?? '', artist: a.artist ?? '' }))
      .filter((a) => a.album),
  }
}

/**
 * Parse a whole export from a map of filename → parsed JSON. Taking already-decoded
 * JSON keeps this package free of zip handling and filesystem access, which is the
 * worker's job.
 */
export function parseExport(files: Map<string, unknown>): ParsedExport {
  const warnings: string[] = []
  const result: ParsedExport = {
    streamingEvents: [],
    playlists: [],
    savedTracks: [],
    savedAlbums: [],
    warnings,
  }

  let sawStreaming = false

  for (const [filename, json] of files) {
    switch (classifyExportFile(filename)) {
      case 'streaming-extended':
      case 'streaming-basic':
        sawStreaming = true
        result.streamingEvents.push(...parseStreamingHistory(json, warnings))
        break
      case 'playlists':
        result.playlists.push(...parsePlaylistFile(json, warnings))
        break
      case 'library': {
        const lib = parseLibraryFile(json, warnings)
        result.savedTracks.push(...lib.savedTracks)
        result.savedAlbums.push(...lib.savedAlbums)
        break
      }
      case 'follow':
        FollowSchema.safeParse(json) // present for completeness; nothing needed yet
        break
      case 'unknown':
        break
    }
  }

  if (!sawStreaming) {
    warnings.push(
      'No streaming history files were found in this export. If you requested the basic "Account data" package rather than "Extended streaming history", the listening history the recommendation engine needs is not included — request the extended package as well.',
    )
  }

  // Chronological, so a resumed or partial import stays coherent.
  result.streamingEvents.sort((a, b) => a.playedAt.getTime() - b.playedAt.getTime())

  return result
}

/** Headline numbers for the import summary screen. */
export function summarizeExport(parsed: ParsedExport): {
  events: number
  skipped: number
  distinctArtists: number
  distinctTracks: number
  earliest?: Date
  latest?: Date
  playlists: number
  savedTracks: number
} {
  const artists = new Set<string>()
  const tracks = new Set<string>()
  let skipped = 0

  for (const e of parsed.streamingEvents) {
    artists.add(e.artistName.toLowerCase())
    tracks.add(`${e.artistName.toLowerCase()}|${e.trackName.toLowerCase()}`)
    if (e.skipped) skipped += 1
  }

  const first = parsed.streamingEvents[0]
  const last = parsed.streamingEvents[parsed.streamingEvents.length - 1]

  return {
    events: parsed.streamingEvents.length,
    skipped,
    distinctArtists: artists.size,
    distinctTracks: tracks.size,
    ...(first ? { earliest: first.playedAt } : {}),
    ...(last ? { latest: last.playedAt } : {}),
    playlists: parsed.playlists.length,
    savedTracks: parsed.savedTracks.length,
  }
}
