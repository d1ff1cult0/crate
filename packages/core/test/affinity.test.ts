import { describe, expect, it } from 'vitest'
import {
  aggregateByArtist,
  computeAffinity,
  isSkip,
  normalizeScores,
  outcomeWeights,
  recencyWeight,
  SKIP_MS_THRESHOLD,
} from '../src/affinity.js'

const NOW = new Date('2026-08-14T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

describe('isSkip', () => {
  it('treats under 30 seconds played as a skip, per §7.8', () => {
    expect(isSkip({ playedAt: NOW, msPlayed: SKIP_MS_THRESHOLD - 1 })).toBe(true)
    expect(isSkip({ playedAt: NOW, msPlayed: SKIP_MS_THRESHOLD })).toBe(false)
  })

  it('honours an explicit flag over the duration heuristic', () => {
    expect(isSkip({ playedAt: NOW, msPlayed: 240_000, skipped: true })).toBe(true)
  })

  it('does not guess when the source has no duration', () => {
    // Navidrome reports play counts without ms_played. Calling those skips would
    // erase the entire post-Spotify signal.
    expect(isSkip({ playedAt: NOW })).toBe(false)
  })
})

describe('recencyWeight', () => {
  it('halves every half-life', () => {
    expect(recencyWeight(NOW, NOW, 90)).toBeCloseTo(1, 5)
    expect(recencyWeight(daysAgo(90), NOW, 90)).toBeCloseTo(0.5, 5)
    expect(recencyWeight(daysAgo(180), NOW, 90)).toBeCloseTo(0.25, 5)
  })

  it('clamps future timestamps to 1 rather than exceeding it', () => {
    const tomorrow = new Date(NOW.getTime() + 86_400_000)
    expect(recencyWeight(tomorrow, NOW, 90)).toBe(1)
  })
})

describe('computeAffinity', () => {
  it('ranks recent listening above an old binge of the same size', () => {
    const recent = computeAffinity(
      Array.from({ length: 10 }, (_, i) => ({ playedAt: daysAgo(i), msPlayed: 200_000 })),
      { halfLifeDays: 90, now: NOW },
    )
    const old = computeAffinity(
      Array.from({ length: 10 }, (_, i) => ({ playedAt: daysAgo(400 + i), msPlayed: 200_000 })),
      { halfLifeDays: 90, now: NOW },
    )
    expect(recent.score).toBeGreaterThan(old.score * 5)
  })

  it('does not let an old binge be erased entirely — it still outranks silence', () => {
    const old = computeAffinity(
      Array.from({ length: 40 }, (_, i) => ({ playedAt: daysAgo(500 + i), msPlayed: 200_000 })),
      { halfLifeDays: 90, now: NOW },
    )
    expect(old.score).toBeGreaterThan(0)
  })

  it('penalises a high skip rate', () => {
    const events = [
      { playedAt: daysAgo(1), msPlayed: 200_000 },
      { playedAt: daysAgo(2), msPlayed: 1000 },
      { playedAt: daysAgo(3), msPlayed: 1000 },
      { playedAt: daysAgo(4), msPlayed: 1000 },
    ]
    const result = computeAffinity(events, { halfLifeDays: 90, now: NOW })
    expect(result.plays).toBe(1)
    expect(result.skips).toBe(3)
    expect(result.skipRate).toBeCloseTo(0.75, 2)
    // One play at ~1.0 weight, cut by 0.8 × 0.75.
    expect(result.score).toBeLessThan(0.5)
  })

  it('boosts a starred track', () => {
    const events = [{ playedAt: daysAgo(1), msPlayed: 200_000 }]
    const plain = computeAffinity(events, { halfLifeDays: 90, now: NOW })
    const starred = computeAffinity(events, { halfLifeDays: 90, now: NOW, starred: true })
    expect(starred.score).toBeGreaterThan(plain.score)
  })

  it('reports zero for a track that was only ever skipped', () => {
    const result = computeAffinity(
      Array.from({ length: 5 }, (_, i) => ({ playedAt: daysAgo(i), msPlayed: 2000 })),
      { halfLifeDays: 90, now: NOW },
    )
    expect(result.score).toBe(0)
    expect(result.skipRate).toBe(1)
  })

  it('records the most recent play even when every event is a skip', () => {
    const result = computeAffinity(
      [
        { playedAt: daysAgo(10), msPlayed: 1000 },
        { playedAt: daysAgo(2), msPlayed: 1000 },
      ],
      { now: NOW },
    )
    expect(result.lastPlayedAt).toEqual(daysAgo(2))
  })
})

describe('aggregateByArtist', () => {
  it('sums rather than averages, so breadth of catalogue counts', () => {
    const totals = aggregateByArtist([
      { artist: 'IDLES', affinity: 0.4 },
      { artist: 'IDLES', affinity: 0.4 },
      { artist: 'IDLES', affinity: 0.4 },
      { artist: 'Shame', affinity: 1.0 },
    ])
    expect(totals.get('IDLES')).toBeCloseTo(1.2, 5)
    expect(totals.get('IDLES')!).toBeGreaterThan(totals.get('Shame')!)
  })
})

describe('normalizeScores', () => {
  it('uses the 95th percentile so one outlier cannot flatten everything else', () => {
    const scores = new Map<string, number>()
    for (let i = 1; i <= 20; i++) scores.set(`a${i}`, i)
    scores.set('overnight-repeat', 10_000)

    const normalized = normalizeScores(scores)
    expect(normalized.get('overnight-repeat')).toBe(1)
    // Without percentile clamping this would be 20/10000 = 0.002.
    expect(normalized.get('a20')).toBeGreaterThan(0.5)
  })

  it('returns the input unchanged when there is nothing positive to scale', () => {
    const scores = new Map([['a', 0]])
    expect([...normalizeScores(scores)]).toEqual([['a', 0]])
  })
})

describe('outcomeWeights', () => {
  it('rewards played recommendations and penalises ignored ones', () => {
    const weights = outcomeWeights([
      { trackId: 'played', played: true },
      { trackId: 'played', played: true },
      { trackId: 'ignored', played: false },
      { trackId: 'ignored', played: false },
    ])
    expect(weights.get('played')!).toBeGreaterThan(1)
    expect(weights.get('ignored')!).toBeLessThan(1)
  })

  it('never exiles a track completely — the engine has to keep offering things', () => {
    const ignored = Array.from({ length: 50 }, () => ({ trackId: 't', played: false }))
    expect(outcomeWeights(ignored).get('t')!).toBeGreaterThanOrEqual(0.35)
  })
})
