import { describe, expect, it } from 'vitest'
import {
  classifyExportFile,
  parseExport,
  parseStreamingHistory,
  summarizeExport,
  SKIP_THRESHOLD_MS,
} from '../src/gdpr/parser.js'

describe('classifyExportFile', () => {
  it('recognises both streaming history conventions', () => {
    expect(classifyExportFile('StreamingHistory0.json')).toBe('streaming-basic')
    expect(classifyExportFile('StreamingHistory_music_3.json')).toBe('streaming-basic')
    expect(classifyExportFile('Streaming_History_Audio_2023_1.json')).toBe('streaming-extended')
  })

  it('recognises the other first-class files', () => {
    expect(classifyExportFile('Playlist1.json')).toBe('playlists')
    expect(classifyExportFile('YourLibrary.json')).toBe('library')
    expect(classifyExportFile('Follow.json')).toBe('follow')
  })

  it('ignores paths and unknown files', () => {
    expect(classifyExportFile('MyData/Playlist1.json')).toBe('playlists')
    expect(classifyExportFile('Userdata.json')).toBe('unknown')
  })
})

describe('parseStreamingHistory — extended format', () => {
  const entry = {
    ts: '2026-03-01T12:00:00Z',
    ms_played: 210_000,
    master_metadata_track_name: 'Karma Police',
    master_metadata_album_artist_name: 'Radiohead',
    master_metadata_album_album_name: 'OK Computer',
    spotify_track_uri: 'spotify:track:abc123',
    skipped: false,
  }

  it('reads the rich fields', () => {
    const [e] = parseStreamingHistory([entry], [])
    expect(e).toMatchObject({
      artistName: 'Radiohead',
      trackName: 'Karma Police',
      albumName: 'OK Computer',
      msPlayed: 210_000,
      spotifyId: 'abc123',
      skipped: false,
    })
  })

  it('honours Spotify’s own skip flag even on a long play', () => {
    const [e] = parseStreamingHistory([{ ...entry, skipped: true }], [])
    expect(e?.skipped).toBe(true)
  })

  it('falls back to the 30s rule when the flag is absent', () => {
    const [short] = parseStreamingHistory([{ ...entry, skipped: null, ms_played: 5_000 }], [])
    const [long] = parseStreamingHistory([{ ...entry, skipped: null, ms_played: 200_000 }], [])
    expect(short?.skipped).toBe(true)
    expect(long?.skipped).toBe(false)
  })

  it('uses exactly the documented 30s threshold', () => {
    const [under] = parseStreamingHistory([{ ...entry, skipped: null, ms_played: SKIP_THRESHOLD_MS - 1 }], [])
    const [at] = parseStreamingHistory([{ ...entry, skipped: null, ms_played: SKIP_THRESHOLD_MS }], [])
    expect(under?.skipped).toBe(true)
    expect(at?.skipped).toBe(false)
  })

  it('skips podcast rows, which have no track name', () => {
    expect(parseStreamingHistory([{ ...entry, master_metadata_track_name: null }], [])).toHaveLength(0)
  })
})

describe('parseStreamingHistory — basic format', () => {
  const entry = {
    endTime: '2026-03-01 12:00',
    artistName: 'Radiohead',
    trackName: 'Creep',
    msPlayed: 120_000,
  }

  it('parses the space-separated UTC timestamp', () => {
    const [e] = parseStreamingHistory([entry], [])
    expect(e?.playedAt.toISOString()).toBe('2026-03-01T12:00:00.000Z')
  })

  it('applies the 30s skip rule', () => {
    const [e] = parseStreamingHistory([{ ...entry, msPlayed: 1000 }], [])
    expect(e?.skipped).toBe(true)
  })
})

describe('parseStreamingHistory — robustness', () => {
  it('warns and returns nothing when the file is not an array', () => {
    const warnings: string[] = []
    expect(parseStreamingHistory({ nope: true }, warnings)).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('drops malformed entries without failing the file', () => {
    const events = parseStreamingHistory(
      [{ garbage: true }, { ts: 'not-a-date', master_metadata_track_name: 'X' },
       { ts: '2026-01-01T00:00:00Z', master_metadata_track_name: 'Good', ms_played: 60_000 }],
      [],
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.trackName).toBe('Good')
  })
})

describe('parseExport', () => {
  const files = new Map<string, unknown>([
    ['Streaming_History_Audio_2026_1.json', [
      { ts: '2026-02-01T10:00:00Z', ms_played: 200_000, master_metadata_track_name: 'B', master_metadata_album_artist_name: 'Artist' },
      { ts: '2026-01-01T10:00:00Z', ms_played: 10_000, master_metadata_track_name: 'A', master_metadata_album_artist_name: 'Artist' },
    ]],
    ['Playlist1.json', {
      playlists: [{
        name: 'My Mix',
        items: [
          { track: { trackName: 'Song', artistName: 'Someone', albumName: 'Album', trackUri: 'spotify:track:xyz' }, addedDate: '2025-06-01' },
          { track: null },
        ],
      }],
    }],
    ['YourLibrary.json', {
      tracks: [{ artist: 'A', album: 'Al', track: 'T', uri: 'spotify:track:qqq' }],
      albums: [{ artist: 'B', album: 'Bl' }],
    }],
    ['Follow.json', { followerCount: 3 }],
    ['SomethingElse.json', { ignored: true }],
  ])

  it('parses every recognised file type', () => {
    const r = parseExport(files)
    expect(r.streamingEvents).toHaveLength(2)
    expect(r.playlists).toHaveLength(1)
    expect(r.playlists[0]?.tracks).toHaveLength(1) // the null track is dropped
    expect(r.savedTracks).toHaveLength(1)
    expect(r.savedAlbums).toHaveLength(1)
  })

  it('sorts streaming events chronologically', () => {
    const r = parseExport(files)
    expect(r.streamingEvents[0]?.trackName).toBe('A')
    expect(r.streamingEvents[1]?.trackName).toBe('B')
  })

  it('extracts the Spotify id from a track URI', () => {
    expect(parseExport(files).playlists[0]?.tracks[0]?.spotifyId).toBe('xyz')
  })

  it('warns clearly when the export has no streaming history at all', () => {
    const r = parseExport(new Map([['YourLibrary.json', { tracks: [] }]]))
    expect(r.warnings.join(' ')).toMatch(/Extended streaming history/)
  })

  it('produces no warning when history is present', () => {
    expect(parseExport(files).warnings).toHaveLength(0)
  })
})

describe('summarizeExport', () => {
  it('reports the headline numbers for the import screen', () => {
    const parsed = parseExport(new Map([['StreamingHistory0.json', [
      { endTime: '2026-01-01 10:00', artistName: 'A', trackName: 'One', msPlayed: 200_000 },
      { endTime: '2026-01-02 10:00', artistName: 'A', trackName: 'Two', msPlayed: 1_000 },
      { endTime: '2026-01-03 10:00', artistName: 'B', trackName: 'Three', msPlayed: 200_000 },
    ]]]))

    const s = summarizeExport(parsed)
    expect(s).toMatchObject({ events: 3, skipped: 1, distinctArtists: 2, distinctTracks: 3 })
    expect(s.earliest?.toISOString()).toBe('2026-01-01T10:00:00.000Z')
    expect(s.latest?.toISOString()).toBe('2026-01-03T10:00:00.000Z')
  })

  it('handles an empty export without throwing', () => {
    expect(summarizeExport(parseExport(new Map())).events).toBe(0)
  })
})
