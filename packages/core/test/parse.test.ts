import { describe, expect, it } from 'vitest'
import {
  detectCsvLayout,
  parseCsv,
  parseSpotifyRef,
  parseTrackLines,
  rowsToTracks,
} from '../src/parse.js'

describe('parseTrackLines', () => {
  it('parses the common "Artist - Title" form', () => {
    const r = parseTrackLines('Radiohead - Karma Police')
    expect(r.tracks[0]).toMatchObject({ artist: 'Radiohead', title: 'Karma Police' })
    expect(r.tracks[0]!.confidence).toBeGreaterThan(0.7)
  })

  it('strips list numbering in several styles', () => {
    const r = parseTrackLines(['1. A - One', '02 - B - Two', '3) C - Three'].join('\n'))
    expect(r.tracks.map((t) => t.title)).toEqual(['One', 'Two', 'Three'])
  })

  it('strips a trailing duration from a copied tracklist', () => {
    const r = parseTrackLines('Pink Floyd - Time (6:53)')
    expect(r.tracks[0]?.title).toBe('Time')
  })

  it('uses a feature credit to detect reversed order', () => {
    const r = parseTrackLines('Crazy In Love - Beyoncé feat. Jay-Z')
    expect(r.tracks[0]?.artist).toContain('Beyoncé')
    expect(r.tracks[0]?.title).toBe('Crazy In Love')
  })

  it('handles tab-separated columns with high confidence', () => {
    const r = parseTrackLines('Radiohead\tKarma Police')
    expect(r.tracks[0]).toMatchObject({ artist: 'Radiohead', title: 'Karma Police' })
    expect(r.tracks[0]!.confidence).toBeGreaterThan(0.9)
  })

  it('keeps a title-only line at low confidence rather than dropping it', () => {
    const r = parseTrackLines('Karma Police')
    expect(r.tracks[0]).toMatchObject({ artist: '', title: 'Karma Police' })
    expect(r.tracks[0]!.confidence).toBeLessThan(0.7)
  })

  it('ignores headings and separators', () => {
    const r = parseTrackLines(['Tracklist', '---', 'Disc 1', 'A - One'].join('\n'))
    expect(r.tracks).toHaveLength(1)
    expect(r.ignored.length).toBeGreaterThanOrEqual(3)
  })

  it('lowers confidence when a line has several dashes', () => {
    const multi = parseTrackLines('A - Album - Title').tracks[0]!
    const simple = parseTrackLines('A - Title').tracks[0]!
    expect(multi.confidence).toBeLessThan(simple.confidence)
  })

  it('keeps hyphenated names intact', () => {
    const r = parseTrackLines('Jay-Z - 99 Problems')
    expect(r.tracks[0]).toMatchObject({ artist: 'Jay-Z', title: '99 Problems' })
  })

  it('reports the source line number for the preview UI', () => {
    const r = parseTrackLines('\n\nA - One')
    expect(r.tracks[0]?.lineNumber).toBe(3)
  })
})

describe('parseCsv', () => {
  it('handles quoted fields containing commas', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('handles escaped quotes', () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('handles embedded newlines inside quotes', () => {
    expect(parseCsv('a,"line1\nline2"')).toEqual([['a', 'line1\nline2']])
  })

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('detectCsvLayout', () => {
  const exportify =
    '"Track URI","Track Name","Artist Name(s)","Album Name","Track Duration (ms)","ISRC","Added At"\n' +
    '"spotify:track:abc","Karma Police","Radiohead","OK Computer","261000","GBAAA1234567","2020-01-01T00:00:00Z"'

  it('recognises the Exportify layout', () => {
    const rows = parseCsv(exportify)
    const d = detectCsvLayout(rows)
    expect(d.layout).toBe('exportify')
    expect(d.mapping).not.toBeNull()
  })

  it('maps every recognised column', () => {
    const d = detectCsvLayout(parseCsv(exportify))
    const tracks = rowsToTracks(parseCsv(exportify), d.mapping!)
    expect(tracks[0]).toMatchObject({
      title: 'Karma Police',
      album: 'OK Computer',
      isrc: 'GBAAA1234567',
      durationMs: 261000,
      spotifyId: 'abc',
    })
    expect(tracks[0]?.artists).toEqual(['Radiohead'])
  })

  it('handles a generic layout with different headers', () => {
    const d = detectCsvLayout(parseCsv('Song,Artist\nOne,Two'))
    expect(d.layout).toBe('generic')
    expect(d.mapping).not.toBeNull()
  })

  it('asks for a manual mapping when it cannot find the columns', () => {
    const d = detectCsvLayout(parseCsv('foo,bar\n1,2'))
    expect(d.mapping).toBeNull()
    expect(d.reason).toBeTruthy()
  })

  it('splits multiple artists in one cell', () => {
    const rows = parseCsv('Track Name,Artist Name\nSong,"A, B"')
    const d = detectCsvLayout(rows)
    expect(rowsToTracks(rows, d.mapping!)[0]?.artists).toEqual(['A', 'B'])
  })
})

describe('parseSpotifyRef', () => {
  it('parses a plain playlist URL', () => {
    expect(parseSpotifyRef('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      kind: 'playlist',
      id: '37i9dQZF1DXcBWIGoYBM5M',
    })
  })

  it('parses a URL with a locale prefix', () => {
    expect(parseSpotifyRef('https://open.spotify.com/intl-nl/track/abc123')).toEqual({
      kind: 'track',
      id: 'abc123',
    })
  })

  it('strips a query string', () => {
    expect(parseSpotifyRef('https://open.spotify.com/playlist/xyz?si=abcdef')?.id).toBe('xyz')
  })

  it('parses a spotify: URI', () => {
    expect(parseSpotifyRef('spotify:album:abc')).toEqual({ kind: 'album', id: 'abc' })
  })

  it('rejects a non-Spotify URL', () => {
    expect(parseSpotifyRef('https://example.com/playlist/abc')).toBeNull()
    expect(parseSpotifyRef('not a url')).toBeNull()
  })
})
