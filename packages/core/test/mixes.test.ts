import { describe, expect, it } from 'vitest'
import {
  interleave,
  planDiscoverySlots,
  sampleMix,
  seededRandom,
  weighCandidate,
  type MixCandidate,
} from '../src/mixes.js'

const NOW = new Date('2026-08-14T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

const candidate = (over: Partial<MixCandidate> & { trackId: string }): MixCandidate => ({
  artist: 'Artist',
  affinity: 0.8,
  clusterFit: 0.8,
  lastPlayedAt: null,
  ...over,
})

describe('weighCandidate', () => {
  it('penalises a recent play instead of excluding it — DECISIONS D7', () => {
    const yesterday = weighCandidate(candidate({ trackId: 'a', lastPlayedAt: daysAgo(1) }), {
      size: 50,
      maxPerArtist: 2,
      recencyPenaltyDays: 14,
      recencyPenaltyWeight: 0.6,
      deepCutRatio: 0.3,
      deepCutDays: 120,
      now: NOW,
      seed: 1,
    })
    // Penalised, but still in the running — a hard exclusion would build mixes out of
    // the things this listener skipped for a reason.
    expect(yesterday.weight).toBeGreaterThan(0)
    expect(yesterday.weight).toBeLessThan(0.8 * 0.8)
  })

  it('tapers the penalty across the window rather than cliff-edging it', () => {
    const opts = {
      size: 50, maxPerArtist: 2, recencyPenaltyDays: 14, recencyPenaltyWeight: 0.6,
      deepCutRatio: 0.3, deepCutDays: 120, now: NOW, seed: 1,
    }
    const today = weighCandidate(candidate({ trackId: 'a', lastPlayedAt: daysAgo(0) }), opts)
    const nearlyOut = weighCandidate(candidate({ trackId: 'b', lastPlayedAt: daysAgo(13) }), opts)
    const outside = weighCandidate(candidate({ trackId: 'c', lastPlayedAt: daysAgo(20) }), opts)

    expect(today.weight).toBeLessThan(nearlyOut.weight)
    expect(nearlyOut.weight).toBeLessThan(outside.weight)
  })

  it('marks a long-unplayed track as a deep cut', () => {
    const result = weighCandidate(candidate({ trackId: 'a', lastPlayedAt: daysAgo(300) }), {
      size: 50, maxPerArtist: 2, recencyPenaltyDays: 14, recencyPenaltyWeight: 0.6,
      deepCutRatio: 0.3, deepCutDays: 120, now: NOW, seed: 1,
    })
    expect(result.isDeepCut).toBe(true)
  })

  it('records why, so a pick can be explained afterwards', () => {
    const result = weighCandidate(
      candidate({ trackId: 'a', lastPlayedAt: daysAgo(2), outcomeWeight: 0.5 }),
      {
        size: 50, maxPerArtist: 2, recencyPenaltyDays: 14, recencyPenaltyWeight: 0.6,
        deepCutRatio: 0.3, deepCutDays: 120, now: NOW, seed: 1,
      },
    )
    expect(result.reasons.join(' ')).toMatch(/affinity/)
    expect(result.reasons.join(' ')).toMatch(/played 2d ago/)
    expect(result.reasons.join(' ')).toMatch(/feedback/)
  })
})

describe('sampleMix', () => {
  const library = (count: number, artists: number): MixCandidate[] =>
    Array.from({ length: count }, (_, i) =>
      candidate({
        trackId: `t${i}`,
        artist: `artist${i % artists}`,
        affinity: 0.3 + (i % 7) / 10,
        clusterFit: 0.5 + (i % 5) / 10,
        lastPlayedAt: i % 3 === 0 ? daysAgo(200) : daysAgo(30),
      }),
    )

  it('never exceeds the per-artist cap', () => {
    const result = sampleMix(library(200, 10), { size: 50, maxPerArtist: 2, now: NOW, seed: 42 })
    const counts = new Map<string, number>()
    for (const track of result.tracks) {
      counts.set(track.artist, (counts.get(track.artist) ?? 0) + 1)
    }
    for (const count of counts.values()) expect(count).toBeLessThanOrEqual(2)
  })

  it('reserves slots for deep cuts rather than leaving them to chance', () => {
    const result = sampleMix(library(300, 40), {
      size: 50, maxPerArtist: 2, deepCutRatio: 0.3, deepCutDays: 120, now: NOW, seed: 7,
    })
    expect(result.deepCuts).toBeGreaterThan(5)
  })

  it('is reproducible for a given seed', () => {
    const opts = { size: 30, maxPerArtist: 2, now: NOW, seed: 99 }
    const a = sampleMix(library(200, 20), opts).tracks.map((t) => t.trackId)
    const b = sampleMix(library(200, 20), opts).tracks.map((t) => t.trackId)
    expect(a).toEqual(b)
  })

  it('produces a different mix for a different seed', () => {
    const base = library(200, 20)
    const a = sampleMix(base, { size: 30, maxPerArtist: 2, now: NOW, seed: 1 }).tracks
    const b = sampleMix(base, { size: 30, maxPerArtist: 2, now: NOW, seed: 2 }).tracks
    expect(a.map((t) => t.trackId)).not.toEqual(b.map((t) => t.trackId))
  })

  it('honours the cross-mix exclusion set — no track appears in two mixes on one day', () => {
    const base = library(200, 20)
    const first = sampleMix(base, { size: 30, maxPerArtist: 2, now: NOW, seed: 1 })
    const used = new Set(first.tracks.map((t) => t.trackId))
    const second = sampleMix(base, {
      size: 30, maxPerArtist: 2, now: NOW, seed: 2, exclude: used,
    })
    for (const track of second.tracks) expect(used.has(track.trackId)).toBe(false)
  })

  it('returns what it can when the pool is smaller than the mix', () => {
    const result = sampleMix(library(5, 5), { size: 50, maxPerArtist: 2, now: NOW, seed: 3 })
    expect(result.tracks).toHaveLength(5)
  })

  it('returns nothing at all rather than filling a mix from zero-affinity tracks', () => {
    const dead = Array.from({ length: 20 }, (_, i) =>
      candidate({ trackId: `t${i}`, affinity: 0, clusterFit: 0.5 }),
    )
    expect(sampleMix(dead, { size: 50, now: NOW, seed: 1 }).tracks).toHaveLength(0)
  })
})

describe('interleave', () => {
  it('avoids two tracks by the same artist back to back where it can', () => {
    const items = [
      { artist: 'A', id: 1 }, { artist: 'A', id: 2 },
      { artist: 'B', id: 3 }, { artist: 'B', id: 4 },
      { artist: 'C', id: 5 }, { artist: 'C', id: 6 },
      { artist: 'D', id: 7 }, { artist: 'D', id: 8 },
    ]
    const out = interleave(items, seededRandom(11))
    let adjacent = 0
    for (let i = 1; i < out.length; i++) {
      if (out[i]!.artist === out[i - 1]!.artist) adjacent += 1
    }
    expect(adjacent).toBeLessThanOrEqual(1)
  })

  it('keeps every item', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ artist: `a${i % 5}`, id: i }))
    const out = interleave(items, seededRandom(5))
    expect(out.map((i) => i.id).sort((a, b) => a - b)).toEqual(items.map((i) => i.id))
  })
})

describe('planDiscoverySlots', () => {
  it('reserves the configured share of the mix', () => {
    const plan = planDiscoverySlots(50, 0.2, [
      { artist: 'a', weight: 1 }, { artist: 'b', weight: 0.9 },
      { artist: 'c', weight: 0.8 }, { artist: 'd', weight: 0.7 },
      { artist: 'e', weight: 0.6 }, { artist: 'f', weight: 0.5 },
      { artist: 'g', weight: 0.4 }, { artist: 'h', weight: 0.3 },
      { artist: 'i', weight: 0.2 }, { artist: 'j', weight: 0.1 },
      { artist: 'k', weight: 0.05 },
    ])
    expect(plan.count).toBe(10)
    expect(plan.artists).toHaveLength(10)
  })

  it('caps the ratio so a misconfiguration cannot make a mix entirely unfamiliar', () => {
    expect(planDiscoverySlots(50, 5, []).count).toBe(25)
  })
})
