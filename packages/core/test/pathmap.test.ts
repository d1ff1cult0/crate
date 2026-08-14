import { describe, expect, it } from 'vitest'
import {
  relativeToRoot,
  toAppPath,
  toNavidromePath,
  validateMappings,
  type PathMapping,
} from '../src/pathmap.js'

// The real shape of this problem: this app sees /music, Navidrome sees /data/media.
const MAPPINGS: PathMapping[] = [{ appPath: '/music', navidromePath: '/data/media' }]

describe('toNavidromePath', () => {
  it('translates a path under a mapped root', () => {
    const r = toNavidromePath('/music/Radiohead/OK Computer/01 Airbag.flac', MAPPINGS)
    expect(r.path).toBe('/data/media/Radiohead/OK Computer/01 Airbag.flac')
    expect(r.mapped).toBe(true)
  })

  it('flags an unmapped path instead of passing it through silently', () => {
    const r = toNavidromePath('/elsewhere/track.flac', MAPPINGS)
    expect(r.mapped).toBe(false)
    // Still returns something usable, but the caller must check `mapped`.
    expect(r.path).toBe('/elsewhere/track.flac')
  })

  it('prefers the most specific mapping when they overlap', () => {
    const nested: PathMapping[] = [
      { appPath: '/music', navidromePath: '/data/media' },
      { appPath: '/music/lossless', navidromePath: '/data/flac' },
    ]
    expect(toNavidromePath('/music/lossless/a.flac', nested).path).toBe('/data/flac/a.flac')
    expect(toNavidromePath('/music/other/a.mp3', nested).path).toBe('/data/media/other/a.mp3')
  })

  it('does not match a partial directory name', () => {
    // "/music-old" must NOT match a "/music" mapping.
    const r = toNavidromePath('/music-old/a.flac', MAPPINGS)
    expect(r.mapped).toBe(false)
  })

  it('tolerates trailing slashes and doubled separators', () => {
    const m: PathMapping[] = [{ appPath: '/music/', navidromePath: '/data/media/' }]
    expect(toNavidromePath('/music//Artist/a.flac', m).path).toBe('/data/media/Artist/a.flac')
  })
})

describe('toAppPath', () => {
  it('is the inverse of toNavidromePath', () => {
    const appPath = '/music/Artist/Album/01 Track.flac'
    const nav = toNavidromePath(appPath, MAPPINGS)
    expect(toAppPath(nav.path, MAPPINGS).path).toBe(appPath)
  })
})

describe('relativeToRoot', () => {
  it('produces a relative path for m3u entries', () => {
    expect(relativeToRoot('/data/media/Artist/a.flac', '/data/media')).toBe('Artist/a.flac')
  })

  it('returns null when the path escapes the root', () => {
    expect(relativeToRoot('/other/a.flac', '/data/media')).toBeNull()
  })
})

describe('validateMappings', () => {
  it('reports having no mappings at all', () => {
    const problems = validateMappings([])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.kind).toBe('NO_MAPPINGS')
  })

  it('reports an empty side', () => {
    const problems = validateMappings([{ appPath: '/music', navidromePath: '' }])
    expect(problems.some((p) => p.kind === 'EMPTY_SEGMENT')).toBe(true)
  })

  it('reports overlapping mappings so an accidental reroute is visible', () => {
    const problems = validateMappings([
      { appPath: '/music', navidromePath: '/data/media' },
      { appPath: '/music/lossless', navidromePath: '/data/flac' },
    ])
    expect(problems.some((p) => p.kind === 'OVERLAPPING')).toBe(true)
  })

  it('reports a sample path that matches nothing — the actual failure mode', () => {
    const problems = validateMappings(MAPPINGS, '/srv/music/a.flac')
    expect(problems.some((p) => p.kind === 'UNMAPPED_PATH')).toBe(true)
  })

  it('is silent on a correct configuration', () => {
    expect(validateMappings(MAPPINGS, '/music/a.flac')).toHaveLength(0)
  })
})
