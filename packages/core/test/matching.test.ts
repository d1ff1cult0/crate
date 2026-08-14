import { describe, expect, it } from 'vitest'
import { MATCH_DEFAULTS, matchTrack } from '../src/matching.js'
import { tokenSetRatio, ratio, levenshtein } from '../src/similarity.js'
import { MATCH_FIXTURES } from './fixtures/tracks.js'

describe('similarity', () => {
  it('levenshtein basics', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('same', 'same')).toBe(0)
  })

  it('ratio is symmetric and bounded', () => {
    expect(ratio('abc', 'abc')).toBe(1)
    expect(ratio('abc', 'xyz')).toBe(0)
    expect(ratio('radiohead', 'radiohed')).toBeCloseTo(0.888, 2)
  })

  it('tokenSetRatio ignores word order', () => {
    expect(tokenSetRatio('jack white meg white', 'meg white jack white')).toBe(1)
  })

  it('tokenSetRatio tolerates one side having extra artists', () => {
    expect(tokenSetRatio('radiohead', 'radiohead thom yorke')).toBeGreaterThan(0.85)
  })

  it('tokenSetRatio separates genuinely different artists', () => {
    expect(tokenSetRatio('radiohead', 'coldplay')).toBeLessThan(0.4)
  })
})

describe('matchTrack — fixture corpus', () => {
  for (const f of MATCH_FIXTURES) {
    it(`${f.name} (${f.why})`, () => {
      const result = matchTrack(f.source, f.candidates)
      expect(result.candidateId).toBe(f.expect.candidateId)
      expect(result.method).toBe(f.expect.method)
      expect(result.status).toBe(f.expect.status)
      if (f.expect.minConfidence !== undefined) {
        expect(result.confidence).toBeGreaterThanOrEqual(f.expect.minConfidence)
      }
      if (f.expect.maxConfidence !== undefined) {
        expect(result.confidence).toBeLessThanOrEqual(f.expect.maxConfidence)
      }
    })
  }
})

describe('matchTrack — guard rails', () => {
  it('vetoes a non-ISRC match beyond the duration limit', () => {
    const r = matchTrack(
      { id: 's', title: 'Test', artists: ['A'], durationMs: 200_000 },
      [{ id: 'c', title: 'Test', artist: 'A', durationMs: 215_000 }],
    )
    expect(r.status).toBe('MISSING')
    expect(r.candidateId).toBeNull()
  })

  it('does not veto an ISRC match beyond the duration limit', () => {
    const r = matchTrack(
      { id: 's', title: 'Test', artists: ['A'], durationMs: 200_000, isrc: 'GBAAA1234567' },
      [{ id: 'c', title: 'Test', artist: 'A', durationMs: 400_000, isrc: 'GBAAA1234567' }],
    )
    expect(r.method).toBe('ISRC')
    expect(r.status).toBe('MATCHED')
  })

  it('applies exactly one variant penalty', () => {
    const r = matchTrack(
      { id: 's', title: 'Song', artists: ['A'], durationMs: 200_000 },
      [{ id: 'c', title: 'Song (Live at Wembley)', artist: 'A', durationMs: 201_000 }],
    )
    expect(r.confidence).toBeCloseTo(0.9 - MATCH_DEFAULTS.variantMismatchPenalty, 5)
  })

  it('does not penalise when both sides carry the same variant', () => {
    const r = matchTrack(
      { id: 's', title: 'Song (Live at Wembley)', artists: ['A'], durationMs: 200_000 },
      [{ id: 'c', title: 'Song - Live in London', artist: 'A', durationMs: 201_000 }],
    )
    expect(r.confidence).toBeGreaterThanOrEqual(MATCH_DEFAULTS.autoAcceptAt)
    expect(r.status).toBe('MATCHED')
  })

  it('rejects a malformed ISRC rather than matching on it', () => {
    const r = matchTrack(
      { id: 's', title: 'X', artists: ['A'], durationMs: 200_000, isrc: 'BAD' },
      [{ id: 'c', title: 'X', artist: 'A', durationMs: 200_000, isrc: 'BAD' }],
    )
    // Falls through to EXACT_NORM rather than trusting a 3-character "ISRC".
    expect(r.method).toBe('EXACT_NORM')
  })

  it('normalizes ISRC formatting differences', () => {
    const r = matchTrack(
      { id: 's', title: 'X', artists: ['A'], durationMs: 200_000, isrc: 'gb-um7-10-29604' },
      [{ id: 'c', title: 'Different Title', artist: 'B', durationMs: 300_000, isrc: 'GBUM71029604' }],
    )
    expect(r.method).toBe('ISRC')
  })
})

describe('matchTrack — ranking', () => {
  it('returns runners-up as alternatives for the review queue', () => {
    const r = matchTrack(
      { id: 's', title: 'Song', artists: ['A'], durationMs: 200_000 },
      [
        { id: 'best', title: 'Song', artist: 'A', durationMs: 200_000 },
        { id: 'other', title: 'Song', artist: 'A B', durationMs: 201_000 },
      ],
    )
    expect(r.candidateId).toBe('best')
    expect(r.alternatives.map((a) => a.candidateId)).toContain('other')
  })

  it('records evidence explaining the decision', () => {
    const r = matchTrack(
      { id: 's', title: 'Song', artists: ['A'], durationMs: 200_000, isrc: 'GBAAA1234567' },
      [{ id: 'c', title: 'Song', artist: 'A', durationMs: 200_000, isrc: 'GBAAA1234567' }],
    )
    expect(r.evidence?.notes.join(' ')).toContain('ISRC')
  })

  it('is deterministic across repeated runs', () => {
    const args = [
      { id: 's', title: 'Song', artists: ['A'], durationMs: 200_000 },
      [
        { id: 'c1', title: 'Song', artist: 'A', durationMs: 200_500 },
        { id: 'c2', title: 'Song', artist: 'A', durationMs: 200_400 },
      ],
    ] as const
    const a = matchTrack(args[0], [...args[1]])
    const b = matchTrack(args[0], [...args[1]])
    expect(a).toEqual(b)
  })
})
