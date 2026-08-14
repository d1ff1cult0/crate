import { describe, expect, it } from 'vitest'
import { autoResolvable, findDuplicateGroups, type DedupeFile } from '../src/dedupe.js'

/**
 * The bulk delete offered in the UI resolves everything at 0.95 confidence or above.
 * These lock in what that threshold actually admits, because the whole safety argument
 * for a one-press bulk delete rests on it: at 0.95 a group means proven-identical audio,
 * not a name that looks similar.
 */

const BULK_DELETE_MIN_CONFIDENCE = 0.95

const file = (over: Partial<DedupeFile> & { id: string }): DedupeFile => ({
  path: `/music/${over.id}.flac`,
  title: 'Song',
  artist: 'Artist',
  durationMs: 200_000,
  format: 'flac',
  mtime: new Date('2024-01-01'),
  ...over,
})

describe('what the 0.95 bulk-delete threshold admits', () => {
  it('admits identical audio (HASH, 1.0)', () => {
    const groups = findDuplicateGroups([
      file({ id: 'a', contentHash: 'same' }),
      file({ id: 'b', contentHash: 'same' }),
    ])
    expect(groups[0]!.reason).toBe('HASH')
    expect(groups[0]!.confidence).toBeGreaterThanOrEqual(BULK_DELETE_MIN_CONFIDENCE)
  })

  it('admits an identical fingerprint (0.99)', () => {
    const groups = findDuplicateGroups([
      file({ id: 'a', fingerprint: 'fp' }),
      file({ id: 'b', fingerprint: 'fp' }),
    ])
    expect(groups[0]!.reason).toBe('FINGERPRINT')
    expect(groups[0]!.confidence).toBeGreaterThanOrEqual(BULK_DELETE_MIN_CONFIDENCE)
  })

  it('admits a shared ISRC with a near-identical duration (0.97)', () => {
    const groups = findDuplicateGroups([
      file({ id: 'a', isrc: 'GBAYE9700263' }),
      file({ id: 'b', isrc: 'GBAYE9700263', durationMs: 201_000 }),
    ])
    expect(groups[0]!.reason).toBe('ISRC')
    expect(groups[0]!.confidence).toBeGreaterThanOrEqual(BULK_DELETE_MIN_CONFIDENCE)
  })

  it('EXCLUDES name-similarity matches (FUZZY, 0.85)', () => {
    // The safety argument for one-press bulk deletion: nothing decided by how alike two
    // strings look is ever deleted without a human seeing it.
    const groups = findDuplicateGroups([
      file({ id: 'a', title: 'Song', artist: 'Artist' }),
      file({ id: 'b', title: 'Song', artist: 'Artist', durationMs: 201_000 }),
    ])
    expect(groups[0]!.reason).toBe('FUZZY')
    expect(groups[0]!.confidence).toBeLessThan(BULK_DELETE_MIN_CONFIDENCE)
  })

  it('EXCLUDES the ambiguous 2–5s band', () => {
    const groups = findDuplicateGroups([
      file({ id: 'a', durationMs: 200_000 }),
      file({ id: 'b', durationMs: 203_500 }),
    ])
    expect(groups[0]!.confidence).toBeLessThan(BULK_DELETE_MIN_CONFIDENCE)
  })

  it('EXCLUDES variants, whatever the threshold', () => {
    const groups = findDuplicateGroups([
      file({ id: 'a', durationMs: 200_000 }),
      file({ id: 'b', durationMs: 400_000 }),
    ])
    expect(groups[0]!.reason).toBe('VARIANT')
    expect(groups[0]!.variant).toBe(true)
    // A variant has no keeper, so there is nothing to delete even if it were admitted.
    expect(groups[0]!.keeperId).toBeNull()
    expect(autoResolvable(groups, { durationToleranceMs: 2000, variantThresholdMs: 5000, autoResolveAt: 0 }))
      .toHaveLength(0)
  })

  it('never selects every file in a group — one copy is always kept', () => {
    const groups = findDuplicateGroups([
      file({ id: 'a', contentHash: 'same', format: 'flac' }),
      file({ id: 'b', contentHash: 'same', format: 'mp3', bitrate: 128_000 }),
      file({ id: 'c', contentHash: 'same', format: 'mp3', bitrate: 320_000 }),
    ])
    const group = groups[0]!
    expect(group.keeperId).not.toBeNull()
    // The keeper is excluded from deletion, so 3 members means 2 deletions.
    expect(group.memberIds.filter((id) => id !== group.keeperId)).toHaveLength(2)
    // And it keeps the best one.
    expect(group.keeperId).toBe('a')
  })

  it('admits at exactly 0.95, not just above it', () => {
    const groups = [
      { reason: 'ISRC' as const, confidence: 0.95, variant: false, memberIds: ['a', 'b'], keeperId: 'a', differing: [], explanation: '' },
    ]
    expect(
      autoResolvable(groups, { durationToleranceMs: 2000, variantThresholdMs: 5000, autoResolveAt: BULK_DELETE_MIN_CONFIDENCE }),
    ).toHaveLength(1)
  })
})
