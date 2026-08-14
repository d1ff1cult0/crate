import { describe, expect, it } from 'vitest'
import { autoResolvable, findDuplicateGroups, planTrashMoves, type DedupeFile } from '../src/dedupe.js'

const mk = (over: Partial<DedupeFile> & { id: string }): DedupeFile => ({
  path: `/music/Artist/Album/${over.id}.flac`,
  format: 'flac',
  title: 'Song',
  artist: 'Artist',
  durationMs: 200_000,
  mtime: new Date('2024-01-01'),
  tags: { title: 'Song', artist: 'Artist' },
  ...over,
})

describe('findDuplicateGroups', () => {
  it('groups identical audio hashes with certainty', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', contentHash: 'h1' }),
      mk({ id: 'b', contentHash: 'h1', format: 'mp3', bitrate: 320 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.reason).toBe('HASH')
    expect(groups[0]?.confidence).toBe(1)
    expect(groups[0]?.keeperId).toBe('a') // flac beats mp3
  })

  it('groups identical fingerprints, catching re-encodes', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', fingerprint: 'fp1' }),
      mk({ id: 'b', fingerprint: 'fp1', format: 'mp3', bitrate: 128 }),
    ])
    expect(groups[0]?.reason).toBe('FINGERPRINT')
    expect(groups[0]?.keeperId).toBe('a')
  })

  it('does not double-claim a file already grouped by a stronger pass', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', contentHash: 'h1', fingerprint: 'fp1' }),
      mk({ id: 'b', contentHash: 'h1', fingerprint: 'fp1' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.reason).toBe('HASH')
  })

  it('groups on ISRC when durations agree', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', isrc: 'GBAAA1234567' }),
      mk({ id: 'b', isrc: 'GBAAA1234567', durationMs: 201_000 }),
    ])
    expect(groups[0]?.reason).toBe('ISRC')
  })

  it('groups on normalized artist and title', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', title: 'Song - Remastered 2011' }),
      mk({ id: 'b', title: 'Song' }),
    ])
    expect(groups[0]?.reason).toBe('FUZZY')
    expect(groups[0]?.variant).toBe(false)
  })

  // ── The behaviour the brief cares about most ──────────────
  it('treats a >5s duration difference as a VARIANT and keeps both', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'studio', durationMs: 200_000 }),
      mk({ id: 'extended', durationMs: 420_000 }),
    ])
    expect(groups[0]?.reason).toBe('VARIANT')
    expect(groups[0]?.variant).toBe(true)
    expect(groups[0]?.keeperId).toBeNull()
  })

  it('never offers a variant group for auto-resolution', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'studio', durationMs: 200_000 }),
      mk({ id: 'live', durationMs: 400_000 }),
    ])
    expect(autoResolvable(groups)).toHaveLength(0)
  })

  it('does not group a live take with the studio take at all', () => {
    // Different variant markers mean different normalization keys, so they never meet.
    const groups = findDuplicateGroups([
      mk({ id: 'studio', title: 'Song' }),
      mk({ id: 'live', title: 'Song (Live at Wembley)' }),
    ])
    expect(groups).toHaveLength(0)
  })

  it('flags a 2–5s difference for review rather than resolving it', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', durationMs: 200_000 }),
      mk({ id: 'b', durationMs: 203_500 }),
    ])
    expect(groups[0]?.reason).toBe('FUZZY')
    expect(groups[0]?.confidence).toBeLessThan(0.98)
    expect(autoResolvable(groups)).toHaveLength(0)
  })

  it('leaves unrelated files alone', () => {
    expect(
      findDuplicateGroups([mk({ id: 'a', title: 'One' }), mk({ id: 'b', title: 'Two' })]),
    ).toHaveLength(0)
  })

  it('reports only the attributes that actually differ', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', contentHash: 'h', format: 'flac' }),
      mk({ id: 'b', contentHash: 'h', format: 'mp3', bitrate: 320 }),
    ])
    expect(groups[0]?.differing).toContain('format')
    expect(groups[0]?.differing).not.toContain('duration')
  })
})

describe('autoResolvable', () => {
  it('admits only high-confidence non-variant groups', () => {
    const groups = findDuplicateGroups([
      mk({ id: 'a', contentHash: 'h1' }),
      mk({ id: 'b', contentHash: 'h1' }),
    ])
    expect(autoResolvable(groups)).toHaveLength(1)
  })
})

describe('planTrashMoves', () => {
  it('preserves the relative path inside the trash root', () => {
    const files = [
      mk({ id: 'a', contentHash: 'h', path: '/music/Artist/Album/a.flac' }),
      mk({ id: 'b', contentHash: 'h', path: '/music/Artist/Album/b.mp3', format: 'mp3', bitrate: 128 }),
    ]
    const groups = findDuplicateGroups(files)
    const plan = planTrashMoves(groups, new Map(files.map((f) => [f.id, f])), '/music', '/trash')

    expect(plan).toHaveLength(1)
    expect(plan[0]?.fileId).toBe('b')
    expect(plan[0]?.to).toBe('/trash/Artist/Album/b.mp3')
  })

  it('never plans a move for a variant group', () => {
    const files = [mk({ id: 'a', durationMs: 200_000 }), mk({ id: 'b', durationMs: 500_000 })]
    const groups = findDuplicateGroups(files)
    const plan = planTrashMoves(groups, new Map(files.map((f) => [f.id, f])), '/music', '/trash')
    expect(plan).toHaveLength(0)
  })

  it('never plans a move for the keeper', () => {
    const files = [
      mk({ id: 'a', contentHash: 'h' }),
      mk({ id: 'b', contentHash: 'h' }),
      mk({ id: 'c', contentHash: 'h' }),
    ]
    const groups = findDuplicateGroups(files)
    const plan = planTrashMoves(groups, new Map(files.map((f) => [f.id, f])), '/music', '/trash')
    expect(plan.map((p) => p.fileId)).not.toContain(groups[0]?.keeperId)
    expect(plan).toHaveLength(2)
  })
})
