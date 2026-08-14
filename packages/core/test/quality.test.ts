import { describe, expect, it } from 'vitest'
import {
  formatRank,
  isLossless,
  looksFoldered,
  qualityScore,
  selectKeeper,
  tagCompleteness,
} from '../src/quality.js'

const FULL_TAGS = {
  title: 'X', artist: 'Y', albumartist: 'Y', album: 'Z', date: '2001',
  track: '1', disc: '1', genre: 'Rock', isrc: 'GBAAA1234567',
  musicbrainz_trackid: 'abc',
}

describe('formatRank', () => {
  it('ranks lossless above every lossy format', () => {
    expect(formatRank('flac')).toBeGreaterThan(formatRank('mp3', 320))
    expect(formatRank('alac')).toBeGreaterThan(formatRank('opus'))
  })

  it('separates MP3 bitrates', () => {
    expect(formatRank('mp3', 320)).toBeGreaterThan(formatRank('mp3', 192))
    expect(formatRank('mp3', 192)).toBeGreaterThan(formatRank('mp3', 128))
  })

  it('accepts bitrate in bits per second as well as kbps', () => {
    expect(formatRank('mp3', 320_000)).toBe(formatRank('mp3', 320))
  })

  it('falls back for an unknown format', () => {
    expect(formatRank('xyz')).toBe(20)
  })
})

describe('isLossless', () => {
  it('classifies correctly', () => {
    expect(isLossless('FLAC')).toBe(true)
    expect(isLossless('.flac')).toBe(true)
    expect(isLossless('mp3')).toBe(false)
  })
})

describe('tagCompleteness', () => {
  it('scores a fully tagged file at the maximum', () => {
    expect(tagCompleteness(FULL_TAGS)).toBe(15)
  })

  it('scores an untagged file at zero', () => {
    expect(tagCompleteness(null)).toBe(0)
    expect(tagCompleteness({})).toBe(0)
  })

  it('ignores empty-string tags', () => {
    expect(tagCompleteness({ title: '', artist: '  ' })).toBe(0)
  })
})

describe('qualityScore', () => {
  it('prefers FLAC over MP3 320 all else equal', () => {
    const flac = qualityScore({ format: 'flac', tags: FULL_TAGS, hasEmbeddedArt: true })
    const mp3 = qualityScore({ format: 'mp3', bitrate: 320, tags: FULL_TAGS, hasEmbeddedArt: true })
    expect(flac).toBeGreaterThan(mp3)
  })

  it('rewards hi-res lossless', () => {
    const cd = qualityScore({ format: 'flac', sampleRate: 44100, bitDepth: 16 })
    const hires = qualityScore({ format: 'flac', sampleRate: 96000, bitDepth: 24 })
    expect(hires).toBeGreaterThan(cd)
  })

  it('penalises a suspected transcode below an honest lossy file', () => {
    const fake = qualityScore({ format: 'flac', tags: FULL_TAGS, suspectedTranscode: true })
    const honest = qualityScore({ format: 'mp3', bitrate: 320, tags: FULL_TAGS })
    expect(fake).toBeLessThan(honest)
  })

  it('never returns a negative score', () => {
    expect(qualityScore({ format: 'wma', suspectedTranscode: true })).toBeGreaterThanOrEqual(0)
  })
})

describe('selectKeeper', () => {
  const base = { mtime: new Date('2024-01-01'), tags: FULL_TAGS }

  it('picks the highest quality file', () => {
    const keeper = selectKeeper([
      { id: 'mp3', path: '/m/a/b/x.mp3', format: 'mp3', bitrate: 192, ...base },
      { id: 'flac', path: '/m/a/b/x.flac', format: 'flac', ...base },
    ])
    expect(keeper?.id).toBe('flac')
  })

  it('breaks a quality tie on tag completeness', () => {
    const keeper = selectKeeper([
      { id: 'bare', path: '/m/a/b/x.flac', format: 'flac', mtime: new Date('2024-01-01'), tags: {} },
      { id: 'tagged', path: '/m/a/b/y.flac', format: 'flac', mtime: new Date('2024-01-01'), tags: FULL_TAGS },
    ])
    expect(keeper?.id).toBe('tagged')
  })

  it('prefers a foldered file over a loose one when all else ties', () => {
    const keeper = selectKeeper([
      { id: 'loose', path: '/m/downloads/x.flac', format: 'flac', ...base },
      { id: 'foldered', path: '/m/Artist/Album/x.flac', format: 'flac', ...base },
    ])
    expect(keeper?.id).toBe('foldered')
  })

  it('falls back to the oldest file, which existing playlists already reference', () => {
    const keeper = selectKeeper([
      { id: 'new', path: '/m/a/b/x.flac', format: 'flac', tags: FULL_TAGS, mtime: new Date('2025-01-01') },
      { id: 'old', path: '/m/a/b/y.flac', format: 'flac', tags: FULL_TAGS, mtime: new Date('2020-01-01') },
    ])
    expect(keeper?.id).toBe('old')
  })

  it('handles the empty and single cases', () => {
    expect(selectKeeper([])).toBeNull()
    const one = { id: 'a', path: '/m/a.flac', format: 'flac', ...base }
    expect(selectKeeper([one])?.id).toBe('a')
  })
})

describe('looksFoldered', () => {
  it('recognises an album folder', () => {
    expect(looksFoldered('/music/Radiohead/OK Computer/01 Airbag.flac')).toBe(true)
  })

  it('rejects a known dumping ground', () => {
    expect(looksFoldered('/music/downloads/track.flac')).toBe(false)
  })

  it('rejects a file sitting at the root', () => {
    expect(looksFoldered('/music/track.flac')).toBe(false)
  })
})
