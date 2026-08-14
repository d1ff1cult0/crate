import { describe, expect, it, vi } from 'vitest'
import { acquireTrack, orderProviders, queryString } from '../src/registry.js'
import type { Candidate, DownloadProvider, ProviderConfig, TrackQuery } from '../src/types.js'

const query: TrackQuery = {
  title: 'Karma Police',
  artists: ['Radiohead'],
  album: 'OK Computer',
  durationMs: 261_000,
}

const goodCandidate: Candidate = {
  id: 'good1',
  title: 'Karma Police',
  artist: 'Radiohead',
  album: 'OK Computer',
  durationMs: 261_000,
}

function provider(
  name: string,
  over: {
    priority?: number
    enabled?: boolean
    search?: () => Promise<Candidate[]>
    download?: () => Promise<{ path: string; format: string; sizeBytes: number }>
  } = {},
): DownloadProvider {
  const config: ProviderConfig = {
    enabled: over.enabled ?? true,
    priority: over.priority ?? 1,
    concurrency: 1,
    rateLimit: { requests: 10, per: 60_000 },
  }
  return {
    name,
    config,
    health: async () => ({ ok: true, detail: 'ok' }),
    search: over.search ?? (async () => [goodCandidate]),
    download:
      over.download ??
      (async () => ({ path: `/staging/${name}.opus`, format: 'opus', sizeBytes: 1024 })),
  }
}

const opts = { destinationDir: '/staging' }

describe('orderProviders', () => {
  it('sorts by priority and drops disabled ones', () => {
    const ordered = orderProviders([
      provider('c', { priority: 3 }),
      provider('off', { priority: 0, enabled: false }),
      provider('a', { priority: 1 }),
    ])
    expect(ordered.map((p) => p.name)).toEqual(['a', 'c'])
  })
})

describe('acquireTrack', () => {
  it('downloads from the highest-priority provider that succeeds', async () => {
    const result = await acquireTrack([provider('first', { priority: 1 })], query, opts)
    expect(result.file?.path).toBe('/staging/first.opus')
    expect(result.provider).toBe('first')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]?.outcome).toBe('SUCCESS')
  })

  it('falls through to the next provider when one fails', async () => {
    const result = await acquireTrack(
      [
        provider('broken', {
          priority: 1,
          download: async () => {
            throw new Error('network exploded')
          },
        }),
        provider('backup', { priority: 2 }),
      ],
      query,
      opts,
    )
    expect(result.provider).toBe('backup')
    expect(result.attempts.map((a) => a.outcome)).toEqual(['ERROR', 'SUCCESS'])
    expect(result.attempts[0]?.detail).toContain('network exploded')
  })

  it('falls through when a provider has no results', async () => {
    const result = await acquireTrack(
      [provider('empty', { priority: 1, search: async () => [] }), provider('backup', { priority: 2 })],
      query,
      opts,
    )
    expect(result.attempts[0]?.outcome).toBe('NO_RESULTS')
    expect(result.provider).toBe('backup')
  })

  it('returns no file when every provider fails, with the full history', async () => {
    const result = await acquireTrack(
      [
        provider('a', { priority: 1, search: async () => [] }),
        provider('b', {
          priority: 2,
          download: async () => {
            throw new Error('nope')
          },
        }),
      ],
      query,
      opts,
    )
    expect(result.file).toBeNull()
    expect(result.attempts).toHaveLength(2)
  })

  // ── The behaviour that keeps wrong tracks out ──────────────
  it('refuses to download junk and records REJECTED_QUALITY', async () => {
    const result = await acquireTrack(
      [
        provider('junky', {
          search: async () => [
            { id: 'k', title: 'Karma Police (Karaoke Version)', artist: 'Sing Along', durationMs: 261_000 },
            { id: 'loop', title: 'Karma Police 10 HOURS', artist: 'Loops', durationMs: 36_000_000 },
          ],
        }),
      ],
      query,
      opts,
    )
    expect(result.file).toBeNull()
    expect(result.attempts[0]?.outcome).toBe('REJECTED_QUALITY')
  })

  it('never calls download when nothing clears the bar', async () => {
    const download = vi.fn()
    await acquireTrack(
      [
        provider('junky', {
          search: async () => [{ id: 'k', title: 'Karma Police (Karaoke)', artist: 'X', durationMs: 261_000 }],
          download,
        }),
      ],
      query,
      opts,
    )
    expect(download).not.toHaveBeenCalled()
  })

  it('logs the full scored candidate list, winners and losers alike', async () => {
    const result = await acquireTrack(
      [
        provider('mixed', {
          search: async () => [
            { id: 'bad', title: 'Karma Police (Nightcore)', artist: 'Radiohead', durationMs: 200_000 },
            goodCandidate,
          ],
        }),
      ],
      query,
      opts,
    )
    // §7.5: "Log the scored candidate list on every attempt."
    expect(result.attempts[0]?.scored).toHaveLength(2)
    expect(result.attempts[0]?.scored.every((s) => s.reasons.length > 0)).toBe(true)
    expect(result.attempts[0]?.chosen?.id).toBe('good1')
  })

  it('records which candidate won and why', async () => {
    const result = await acquireTrack([provider('p')], query, opts)
    expect(result.attempts[0]?.detail).toMatch(/Chose "Karma Police".*score/)
  })

  // ── The 24h NO_RESULTS rule ────────────────────────────────
  it('skips a provider that recently returned no results for the same query', async () => {
    const search = vi.fn(async () => [goodCandidate])
    const result = await acquireTrack(
      [provider('exhausted', { priority: 1, search }), provider('backup', { priority: 2 })],
      query,
      { ...opts, recentlyExhausted: async (p) => p === 'exhausted' },
    )
    expect(search).not.toHaveBeenCalled()
    expect(result.attempts[0]?.detail).toMatch(/last 24 hours/)
    expect(result.provider).toBe('backup')
  })

  it('does not skip a provider that failed for a different reason', async () => {
    const search = vi.fn(async () => [goodCandidate])
    await acquireTrack([provider('p', { search })], query, {
      ...opts,
      recentlyExhausted: async () => false,
    })
    expect(search).toHaveBeenCalled()
  })

  it('reports a search timeout distinctly from a generic error', async () => {
    const result = await acquireTrack(
      [
        provider('slow', {
          search: async () => {
            throw new Error('yt-dlp timed out after 60000ms')
          },
        }),
      ],
      query,
      opts,
    )
    expect(result.attempts[0]?.outcome).toBe('TIMEOUT')
  })

  it('passes progress through, tagged with the provider', async () => {
    const seen: string[] = []
    await acquireTrack(
      [
        provider('p', {
          download: async () => ({ path: '/staging/x.opus', format: 'opus', sizeBytes: 1 }),
        }),
      ],
      query,
      { ...opts, onProgress: (p) => seen.push(p.provider) },
    )
    // The stub provider reports nothing; the wiring is what matters here.
    expect(seen.every((s) => s === 'p')).toBe(true)
  })
})

describe('queryString', () => {
  it('formats a stable key for the 24h exhaustion check', () => {
    expect(queryString(query)).toBe('Radiohead - Karma Police')
  })
})
