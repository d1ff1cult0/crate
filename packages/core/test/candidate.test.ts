import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_DEFAULTS,
  pickBestCandidate,
  rankCandidates,
  scoreCandidate,
  type ScoreCandidate,
  type ScoreTarget,
} from '../src/candidate.js'

const target: ScoreTarget = {
  title: 'Karma Police',
  artists: ['Radiohead'],
  album: 'OK Computer',
  durationMs: 261_000,
}

const cand = (over: Partial<ScoreCandidate> & { id: string }): ScoreCandidate => ({
  title: 'Karma Police',
  artist: 'Radiohead',
  album: 'OK Computer',
  durationMs: 261_000,
  ...over,
})

describe('scoreCandidate — hard rejects', () => {
  it('rejects anything more than twice the target duration', () => {
    // The ten-hour-loop case the brief calls out explicitly.
    const r = scoreCandidate(target, cand({ id: 'loop', durationMs: 36_000_000 }))
    expect(r.rejected).toBe(true)
    expect(r.score).toBe(0)
    expect(r.reasons[0]).toMatch(/more than twice/)
  })

  it('rejects a clip shorter than half the target', () => {
    const r = scoreCandidate(target, cand({ id: 'clip', durationMs: 30_000 }))
    expect(r.rejected).toBe(true)
    expect(r.reasons[0]).toMatch(/less than half/)
  })

  it('rejects below the configured minimum bitrate', () => {
    const r = scoreCandidate(
      target,
      cand({ id: 'lowbr', bitrate: 96 }),
      { ...CANDIDATE_DEFAULTS, minBitrateKbps: 192 },
    )
    expect(r.rejected).toBe(true)
    expect(r.reasons[0]).toMatch(/below the 192kbps minimum/)
  })

  it('does not apply the bitrate check when it is disabled', () => {
    expect(scoreCandidate(target, cand({ id: 'x', bitrate: 96 })).rejected).toBe(false)
  })
})

describe('scoreCandidate — junk markers', () => {
  const junk = [
    ['Karma Police (Karaoke Version)', 'karaoke'],
    ['Karma Police - Sped Up', 'sped up'],
    ['Karma Police [Nightcore]', 'nightcore'],
    ['Karma Police (8D Audio)', '8D'],
    ['Karma Police (Lyrics)', 'lyrics video'],
  ] as const

  for (const [title, label] of junk) {
    it(`penalises "${label}"`, () => {
      const clean = scoreCandidate(target, cand({ id: 'clean' }))
      const dirty = scoreCandidate(target, cand({ id: 'dirty', title }))
      expect(dirty.score).toBeLessThan(clean.score)
      expect(dirty.reasons.join(' ')).toContain(label)
    })
  }

  it('rejects a karaoke version outright at default settings', () => {
    expect(scoreCandidate(target, cand({ id: 'k', title: 'Karma Police (Karaoke)' })).rejected).toBe(
      true,
    )
  })

  it('does NOT penalise a marker the source also wants', () => {
    // Searching for a live version should not be punished for finding one.
    const liveTarget: ScoreTarget = { ...target, title: 'Karma Police (Live at Glastonbury)' }
    const r = scoreCandidate(liveTarget, cand({ id: 'live', title: 'Karma Police (Live)' }))
    expect(r.reasons.join(' ')).toMatch(/not penalised/)
    expect(r.rejected).toBe(false)
  })
})

describe('scoreCandidate — similarity and duration', () => {
  it('scores an exact match highly', () => {
    expect(scoreCandidate(target, cand({ id: 'exact' })).score).toBeGreaterThan(0.9)
  })

  it('rewards a duration within tolerance', () => {
    const near = scoreCandidate(target, cand({ id: 'near', durationMs: 262_000 }))
    const off = scoreCandidate(target, cand({ id: 'off', durationMs: 285_000 }))
    expect(near.score).toBeGreaterThan(off.score)
  })

  it('tapers the duration penalty rather than cliff-edging it', () => {
    const slightly = scoreCandidate(target, cand({ id: 'a', durationMs: 268_000 }))
    const badly = scoreCandidate(target, cand({ id: 'b', durationMs: 300_000 }))
    expect(slightly.score).toBeGreaterThan(badly.score)
    expect(slightly.rejected).toBe(false)
  })

  it('punishes a wrong artist even with an identical title', () => {
    const r = scoreCandidate(target, cand({ id: 'wrong', artist: 'Some Cover Band' }))
    expect(r.score).toBeLessThan(0.7)
  })

  it('rewards a matching album', () => {
    // Duration is nudged off tolerance so neither score is clamped at 1 and the
    // album term is actually observable.
    const withAlbum = scoreCandidate(target, cand({ id: 'a', durationMs: 275_000 }))
    const withoutAlbum = scoreCandidate(
      target,
      cand({ id: 'b', album: 'Greatest Hits', durationMs: 275_000 }),
    )
    expect(withAlbum.score).toBeGreaterThan(withoutAlbum.score)
  })

  it('always records its reasoning', () => {
    expect(scoreCandidate(target, cand({ id: 'x' })).reasons.length).toBeGreaterThan(0)
  })
})

describe('rankCandidates', () => {
  it('puts the best non-rejected candidate first', () => {
    const ranked = rankCandidates(target, [
      cand({ id: 'karaoke', title: 'Karma Police (Karaoke Version)' }),
      cand({ id: 'good' }),
      cand({ id: 'loop', durationMs: 36_000_000 }),
    ])
    expect(ranked[0]?.id).toBe('good')
    expect(ranked.at(-1)?.rejected).toBe(true)
  })

  it('keeps rejected candidates in the list so the attempt log is complete', () => {
    const ranked = rankCandidates(target, [cand({ id: 'loop', durationMs: 36_000_000 })])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.rejected).toBe(true)
  })
})

describe('pickBestCandidate', () => {
  it('returns the winner when one clears the floor', () => {
    expect(pickBestCandidate(target, [cand({ id: 'good' })])?.id).toBe('good')
  })

  it('returns null rather than downloading junk', () => {
    expect(
      pickBestCandidate(target, [
        cand({ id: 'karaoke', title: 'Karma Police (Karaoke Version)' }),
        cand({ id: 'loop', durationMs: 36_000_000 }),
      ]),
    ).toBeNull()
  })

  it('returns null for an empty result set', () => {
    expect(pickBestCandidate(target, [])).toBeNull()
  })
})
