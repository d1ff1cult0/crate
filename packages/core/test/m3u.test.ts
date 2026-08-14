import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLACEMENT_TEMPLATE,
  buildM3u,
  buildMissingSidecar,
  renderPlacement,
  sanitizeFilename,
} from '../src/m3u.js'
import type { PathMapping } from '../src/pathmap.js'

const MAPPINGS: PathMapping[] = [{ appPath: '/music', navidromePath: '/data/media' }]

const entries = [
  { appPath: '/music/Radiohead/OK Computer/01 Airbag.flac', title: 'Airbag', artist: 'Radiohead', durationMs: 284000 },
  { appPath: '/music/Radiohead/OK Computer/02 Paranoid Android.flac', title: 'Paranoid Android', artist: 'Radiohead', durationMs: 383000 },
]

describe('buildM3u', () => {
  it('writes the header, playlist name and one EXTINF per entry', () => {
    const r = buildM3u(entries, { name: 'Test', musicRoot: '/music', mappings: MAPPINGS })
    const lines = r.content.split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[1]).toBe('#PLAYLIST:Test')
    expect(lines[2]).toBe('#EXTINF:284,Radiohead - Airbag')
    expect(lines[3]).toBe('Radiohead/OK Computer/01 Airbag.flac')
    expect(r.entriesWritten).toBe(2)
  })

  it('has no BOM and ends with a newline', () => {
    const r = buildM3u(entries, { name: 'T', musicRoot: '/music', mappings: MAPPINGS })
    expect(r.content.charCodeAt(0)).not.toBe(0xfeff)
    expect(r.content.endsWith('\n')).toBe(true)
  })

  it('writes paths relative to the music root as Navidrome sees it', () => {
    const r = buildM3u(entries, { name: 'T', musicRoot: '/music', mappings: MAPPINGS })
    expect(r.content).not.toContain('/data/media')
    expect(r.content).toContain('Radiohead/OK Computer/01 Airbag.flac')
  })

  it('writes mapped absolute paths when asked', () => {
    const r = buildM3u(entries, { name: 'T', musicRoot: '/music', mappings: MAPPINGS, absolute: true })
    expect(r.content).toContain('/data/media/Radiohead/OK Computer/01 Airbag.flac')
  })

  it('reports rather than silently writing an unmappable path', () => {
    const r = buildM3u(
      [{ appPath: '/elsewhere/x.flac', title: 'X', artist: 'Y' }],
      { name: 'T', musicRoot: '/music', mappings: MAPPINGS },
    )
    expect(r.entriesWritten).toBe(0)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]?.reason).toMatch(/mapping/)
  })

  it('uses -1 for an unknown duration', () => {
    const r = buildM3u(
      [{ appPath: '/music/a.flac', title: 'A', artist: 'B' }],
      { name: 'T', musicRoot: '/music', mappings: MAPPINGS },
    )
    expect(r.content).toContain('#EXTINF:-1,B - A')
  })

  it('strips newlines from titles so the line format cannot break', () => {
    const r = buildM3u(
      [{ appPath: '/music/a.flac', title: 'Bad\nTitle', artist: 'B', durationMs: 1000 }],
      { name: 'T', musicRoot: '/music', mappings: MAPPINGS },
    )
    expect(r.content.split('\n')[2]).toBe('#EXTINF:1,B - Bad Title')
  })
})

describe('buildMissingSidecar', () => {
  it('records the unmatched tracks as valid JSON', () => {
    const json = buildMissingSidecar('My Playlist', [
      { title: 'A', artist: 'B', sourceTrackId: 's1', position: 3, isrc: 'GBAAA1234567' },
    ])
    const parsed = JSON.parse(json)
    expect(parsed.playlist).toBe('My Playlist')
    expect(parsed.count).toBe(1)
    expect(parsed.tracks[0].position).toBe(3)
  })
})

describe('sanitizeFilename', () => {
  it('replaces filesystem-hostile characters', () => {
    expect(sanitizeFilename('AC/DC: Back?')).toBe('AC_DC_ Back_')
  })

  it('preserves non-ASCII rather than mangling it', () => {
    expect(sanitizeFilename('Sigur Rós')).toBe('Sigur Rós')
    expect(sanitizeFilename('До свидания')).toBe('До свидания')
  })

  it('strips trailing dots and spaces, which break on Windows shares', () => {
    expect(sanitizeFilename('Track. ')).toBe('Track')
  })

  it('never returns an empty name', () => {
    expect(sanitizeFilename('///')).toBe('___')
    expect(sanitizeFilename('')).toBe('untitled')
  })
})

describe('renderPlacement', () => {
  it('renders the default template with zero-padded track numbers', () => {
    expect(
      renderPlacement(DEFAULT_PLACEMENT_TEMPLATE, {
        albumartist: 'Radiohead', artist: 'Radiohead', album: 'OK Computer',
        year: 1997, disc: 1, track: 2, title: 'Paranoid Android', ext: 'flac',
      }),
    ).toBe('Radiohead/OK Computer (1997)/1-02 Paranoid Android.flac')
  })

  it('falls back to the track artist when there is no album artist', () => {
    expect(
      renderPlacement('{albumartist}/{title}.{ext}', {
        artist: 'Solo', album: 'A', title: 'T', ext: 'mp3',
      }),
    ).toBe('Solo/T.mp3')
  })

  it('collapses the empty parens when the year is unknown', () => {
    const out = renderPlacement(DEFAULT_PLACEMENT_TEMPLATE, {
      albumartist: 'A', artist: 'A', album: 'B', title: 'C', ext: 'flac', disc: 1, track: 1,
    })
    expect(out).toBe('A/B/1-01 C.flac')
  })

  it('drops the whole disc/track prefix when there is no track number', () => {
    // "1-00 Title" would look like real metadata. A downloaded single often has no
    // track number at all, and inventing one is worse than omitting it.
    const out = renderPlacement(DEFAULT_PLACEMENT_TEMPLATE, {
      albumartist: 'A', artist: 'A', album: 'B', year: 2020, title: 'C', ext: 'opus',
    })
    expect(out).toBe('A/B (2020)/C.opus')
  })

  it('defaults the disc to 1 when the track number is known but the disc is not', () => {
    const out = renderPlacement(DEFAULT_PLACEMENT_TEMPLATE, {
      albumartist: 'A', artist: 'A', album: 'B', year: 2020, track: 7, title: 'C', ext: 'flac',
    })
    expect(out).toBe('A/B (2020)/1-07 C.flac')
  })

  it('sanitizes each field independently so slashes cannot escape the template', () => {
    const out = renderPlacement('{albumartist}/{title}.{ext}', {
      artist: 'AC/DC', albumartist: 'AC/DC', title: 'Back/Slash', ext: 'flac',
    })
    expect(out).toBe('AC_DC/Back_Slash.flac')
  })
})
