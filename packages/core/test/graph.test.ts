import { describe, expect, it } from 'vitest'
import {
  assignStableSlots,
  blendEdges,
  discoveryCandidates,
  jaccard,
  louvain,
  nameMix,
  type RawEdge,
} from '../src/graph.js'

describe('blendEdges', () => {
  it('normalizes each source independently so raw scale cannot decide clusters', () => {
    // Co-occurrence counts run to the hundreds; ListenBrainz scores run to the
    // thousands and are on a different scale again. Without per-source normalization
    // whichever source happens to use the biggest numbers would decide every cluster.
    const edges: RawEdge[] = [
      { from: 'A', to: 'B', weight: 1.0, source: 'LISTENBRAINZ' },
      { from: 'C', to: 'D', weight: 400, source: 'COOCCURRENCE' },
      { from: 'C', to: 'E', weight: 4, source: 'COOCCURRENCE' },
    ]
    const blended = blendEdges(edges)
    const ab = blended.find((e) => e.from === 'A')!
    const cd = blended.find((e) => e.to === 'D')!
    const ce = blended.find((e) => e.to === 'E')!

    expect(ab.weight).toBeCloseTo(1.0, 5) // full normalized × LISTENBRAINZ weight 1.0
    expect(cd.weight).toBeCloseTo(0.9, 5) // full normalized × COOCCURRENCE weight 0.9
    expect(ce.weight).toBeLessThan(0.05) // 4/400 of the way up
  })

  it('merges the two directions of the same pair into one undirected edge', () => {
    const blended = blendEdges([
      { from: 'A', to: 'B', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'B', to: 'A', weight: 1, source: 'DEEZER' },
    ])
    expect(blended).toHaveLength(1)
    expect(blended[0]!.sources).toEqual(['DEEZER', 'LISTENBRAINZ'])
  })

  it('drops self-loops, which carry no similarity information', () => {
    expect(blendEdges([{ from: 'A', to: 'A', weight: 1, source: 'LISTENBRAINZ' }])).toHaveLength(0)
  })
})

describe('louvain', () => {
  it('separates two dense clusters joined by a single weak edge', () => {
    const edges = blendEdges([
      // Cluster one
      { from: 'a1', to: 'a2', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'a2', to: 'a3', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'a1', to: 'a3', weight: 1, source: 'LISTENBRAINZ' },
      // Cluster two
      { from: 'b1', to: 'b2', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'b2', to: 'b3', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'b1', to: 'b3', weight: 1, source: 'LISTENBRAINZ' },
      // The bridge
      { from: 'a1', to: 'b1', weight: 0.05, source: 'LISTENBRAINZ' },
    ])

    const communities = louvain(edges)
    expect(communities).toHaveLength(2)

    const groups = communities.map((c) => [...c.members].sort().join(','))
    expect(groups).toContain('a1,a2,a3')
    expect(groups).toContain('b1,b2,b3')
  })

  it('is deterministic — the same graph produces the same partition every time', () => {
    // Stability is the whole reason node order is fixed rather than shuffled: mixes
    // that reshuffle their meaning nightly are worse than a slightly worse partition.
    const edges = blendEdges(
      Array.from({ length: 30 }, (_, i) => ({
        from: `n${i % 6}`,
        to: `n${(i + 1) % 6}`,
        weight: 1,
        source: 'LISTENBRAINZ',
      })),
    )
    const first = louvain(edges).map((c) => c.members.sort().join(','))
    const second = louvain(edges).map((c) => c.members.sort().join(','))
    expect(first).toEqual(second)
  })

  it('ranks members by the supplied node weights', () => {
    const edges = blendEdges([
      { from: 'quiet', to: 'loud', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'loud', to: 'middle', weight: 1, source: 'LISTENBRAINZ' },
    ])
    const communities = louvain(edges, {
      nodeWeights: new Map([
        ['loud', 0.9],
        ['middle', 0.5],
        ['quiet', 0.1],
      ]),
    })
    expect(communities[0]!.ranked[0]).toBe('loud')
  })

  it('returns nothing for an empty graph rather than inventing a cluster', () => {
    expect(louvain([])).toEqual([])
  })
})

describe('assignStableSlots', () => {
  const community = (id: number, members: string[]) => ({
    id,
    members,
    ranked: members,
    internalWeight: members.length,
  })

  it('keeps a slot pointing at the community it already held', () => {
    const communities = [community(0, ['x', 'y', 'z']), community(1, ['a', 'b', 'c'])]
    const previous = new Map([
      [1, ['a', 'b', 'c', 'd']],
      [2, ['x', 'y']],
    ])

    const assigned = assignStableSlots(communities, previous, 6)
    expect(assigned.find((a) => a.slot === 1)!.community.members).toEqual(['a', 'b', 'c'])
    expect(assigned.find((a) => a.slot === 2)!.community.members).toEqual(['x', 'y', 'z'])
  })

  it('refuses to call a barely-overlapping community the same mix', () => {
    const communities = [community(0, ['p', 'q', 'r', 's', 't'])]
    const previous = new Map([[3, ['a', 'b', 'c', 'd', 'p']]])

    const assigned = assignStableSlots(communities, previous, 6)
    // Overlap is 1/9 — below the 0.15 floor, so it takes a fresh slot instead.
    expect(assigned[0]!.continuity).toBe(0)
    expect(assigned[0]!.slot).toBe(1)
  })

  it('fills unclaimed slots with the largest remaining communities', () => {
    const communities = [community(0, ['a', 'b', 'c']), community(1, ['d']), community(2, ['e'])]
    const assigned = assignStableSlots(communities, new Map(), 6)
    expect(assigned.map((a) => a.slot)).toEqual([1, 2, 3])
  })

  it('never assigns more slots than asked for', () => {
    const communities = Array.from({ length: 20 }, (_, i) => community(i, [`n${i}`]))
    expect(assignStableSlots(communities, new Map(), 6)).toHaveLength(6)
  })
})

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1)
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0)
  })
})

describe('nameMix', () => {
  it('names a mix after its top artists, never generically', () => {
    expect(nameMix(2, ['Fontaines D.C.', 'IDLES', 'Shame', 'Sleaford Mods'])).toBe(
      'Mix 2 — Fontaines D.C., IDLES and Shame and more',
    )
  })

  it('omits "and more" when there is nothing more', () => {
    expect(nameMix(1, ['Bjork', 'Portishead'])).toBe('Mix 1 — Bjork and Portishead')
  })

  it('degrades to a bare slot name rather than producing nonsense', () => {
    expect(nameMix(4, [])).toBe('Mix 4')
  })
})

describe('discoveryCandidates', () => {
  it('returns only artists NOT already in the library', () => {
    const edges = blendEdges([
      { from: 'owned', to: 'unowned', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'owned', to: 'alsoOwned', weight: 1, source: 'LISTENBRAINZ' },
    ])
    const candidates = discoveryCandidates(
      edges,
      new Set(['owned', 'alsoOwned']),
      new Map([['owned', 1]]),
    )
    expect(candidates.map((c) => c.artist)).toEqual(['unowned'])
  })

  it('weights a neighbour by how much the listener likes the artist it hangs off', () => {
    const edges = blendEdges([
      { from: 'favourite', to: 'viaFavourite', weight: 1, source: 'LISTENBRAINZ' },
      { from: 'barelyPlayed', to: 'viaBarely', weight: 1, source: 'LISTENBRAINZ' },
    ])
    const candidates = discoveryCandidates(
      edges,
      new Set(['favourite', 'barelyPlayed']),
      new Map([
        ['favourite', 1.0],
        ['barelyPlayed', 0.05],
      ]),
    )
    expect(candidates[0]!.artist).toBe('viaFavourite')
  })
})
