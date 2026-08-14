import { describe, expect, it, vi } from 'vitest'
import { QuotaExceededError, type SpotifyClient } from '../src/spotify/client.js'
import {
  harvestEverything,
  type HarvestCheckpoint,
  type HarvestPort,
  type NormalizedSourceTrack,
} from '../src/spotify/harvest.js'

/** Minimal in-memory port that records what the harvest did. */
function makePort() {
  const state = {
    profile: null as unknown,
    playlists: [] as Array<Record<string, unknown>>,
    tracks: [] as NormalizedSourceTrack[],
    playlistItems: new Map<string, Array<{ externalId: string; position: number }>>(),
    followed: [] as Array<{ externalId: string; name: string }>,
    topItems: [] as Array<{ type: string; range: string; count: number }>,
    events: [] as Array<{ trackName: string }>,
    backfillQueued: [] as string[],
    checkpoints: [] as HarvestCheckpoint[],
    progress: [] as Array<{ stage: string; message: string }>,
  }

  const port: HarvestPort = {
    async saveProfile(p) {
      state.profile = p
    },
    async savePlaylist(p) {
      state.playlists.push(p as Record<string, unknown>)
    },
    async saveTracks(tracks) {
      const before = state.tracks.length
      const known = new Set(state.tracks.map((t) => t.externalId))
      for (const t of tracks) if (!known.has(t.externalId)) state.tracks.push(t)
      return { created: state.tracks.length - before }
    },
    async savePlaylistItems(id, items) {
      state.playlistItems.set(id, items)
    },
    async saveFollowedArtists(a) {
      state.followed.push(...a)
    },
    async saveTopItems(type, range, items) {
      state.topItems.push({ type, range, count: items.length })
    },
    async saveListeningEvents(e) {
      state.events.push(...e)
    },
    async queueIsrcBackfill(ids) {
      state.backfillQueued.push(...ids)
    },
    async saveCheckpoint(cp) {
      state.checkpoints.push(JSON.parse(JSON.stringify(cp)))
    },
    async loadCheckpoint() {
      return state.checkpoints.at(-1) ?? null
    },
    onProgress(u) {
      state.progress.push({ stage: u.stage, message: u.message })
    },
  }

  return { port, state }
}

const track = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Track ${id}`,
  duration_ms: 200_000,
  artists: [{ id: 'a1', name: 'Artist One' }],
  album: { id: 'al1', name: 'Album', release_date: '2001-05-05', artists: [{ name: 'Artist One' }] },
  external_ids: { isrc: `GBAAA00000${id}` },
  ...over,
})

/** Fake client exposing only what the harvest touches. */
function makeClient(over: Partial<Record<string, unknown>> = {}): SpotifyClient {
  const base = {
    counters: { requests: 0, cacheHits: 0, retries: 0, rateLimitHits: 0 },
    async getCurrentUser() {
      return { id: 'me', account_id: 'acct_1', display_name: 'Owner' }
    },
    async *getMyPlaylists() {
      yield [
        { id: 'p1', name: 'Mine', owner: { id: 'me' }, snapshot_id: 's1', collaborative: false },
        { id: 'p2', name: 'Someone else', owner: { id: 'other' }, collaborative: false, tracks: { total: 40 } },
        { id: 'p3', name: 'Collab', owner: { id: 'other' }, collaborative: true },
      ]
    },
    async *getPlaylistItems(id: string) {
      if (id === 'p1') yield [{ added_at: '2024-01-01T00:00:00Z', item: track('1') }, { added_at: null, track: track('2') }]
      else if (id === 'p3') yield [{ added_at: null, item: track('3') }]
    },
    async *getSavedTracks() {
      yield [{ added_at: '2024-02-02T00:00:00Z', track: track('4') }]
    },
    async *getSavedAlbums() {
      yield [{ album: { id: 'al9', name: 'Saved Album', release_date: '1999', artists: [{ name: 'AA' }] } }]
    },
    async *getAlbumTracks() {
      // SimplifiedTrackObject — deliberately NO external_ids (finding A).
      yield [
        { id: '50', name: 'Album Track A', duration_ms: 180_000, artists: [{ name: 'AA' }] },
        { id: '51', name: 'Album Track B', duration_ms: 190_000, artists: [{ name: 'AA' }] },
      ]
    },
    async *getFollowedArtists() {
      yield [{ id: 'ar1', name: 'Followed One' }]
    },
    async *getTopItems() {
      yield [track('60')]
    },
    async *getRecentlyPlayed() {
      yield [{ track: track('70'), played_at: '2026-08-01T10:00:00Z' }]
    },
  }
  return { ...base, ...over } as unknown as SpotifyClient
}

describe('harvestEverything', () => {
  it('walks every stage and records the profile', async () => {
    const { port, state } = makePort()
    const summary = await harvestEverything(makeClient(), port)

    expect(state.profile).toMatchObject({ id: 'me', accountId: 'acct_1' })
    expect(summary.stagesCompleted).toEqual([
      'profile', 'playlists', 'playlist-items', 'saved-tracks',
      'saved-albums', 'followed-artists', 'top-items', 'recently-played',
    ])
  })

  it('counts a non-owned playlist without trying to read its contents', async () => {
    const { port, state } = makePort()
    const summary = await harvestEverything(makeClient(), port)

    expect(summary.playlists).toBe(3)
    expect(summary.playlistsNotOwned).toBe(1) // p2 only
    // p2 was never read; p1 and p3 (collaborative) were.
    expect([...state.playlistItems.keys()].sort()).toEqual(['p1', 'p3'])
  })

  it('reads collaborative playlists, which the brief assumed were unavailable', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    expect(state.playlistItems.get('p3')).toHaveLength(1)
  })

  it('stores the reported track total for a playlist it cannot read', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    const p2 = state.playlists.find((p) => p.externalId === 'p2')
    expect(p2?.trackTotal).toBe(40)
  })

  it('records ISRC as PRESENT for playlist and saved tracks', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    const t1 = state.tracks.find((t) => t.externalId === '1')
    expect(t1?.isrc).toBe('GBAAA000001')
    expect(t1?.isrcStatus).toBe('PRESENT')
  })

  it('records album tracks as ABSENT and queues them for backfill', async () => {
    const { port, state } = makePort()
    const summary = await harvestEverything(makeClient(), port)

    const albumTrack = state.tracks.find((t) => t.externalId === '50')
    expect(albumTrack?.isrc).toBeUndefined()
    expect(albumTrack?.isrcStatus).toBe('ABSENT')
    expect(state.backfillQueued).toEqual(['50', '51'])
    expect(summary.tracksAwaitingIsrc).toBe(2)
  })

  it('never re-fetches a track that arrived embedded in a playlist', async () => {
    const getTrack = vi.fn()
    const { port } = makePort()
    await harvestEverything(makeClient({ getTrack }), port)
    expect(getTrack).not.toHaveBeenCalled()
  })

  it('reports how many individual calls the cache avoided', async () => {
    const { port } = makePort()
    // Same track in a playlist and in liked songs — the second sighting is a cache hit.
    const client = makeClient({
      async *getSavedTracks() {
        yield [{ added_at: null, track: track('1') }]
      },
    })
    const summary = await harvestEverything(client, port)
    expect(summary.callsAvoidedByCache).toBeGreaterThan(0)
  })

  it('deduplicates a track appearing in several places', async () => {
    const { port, state } = makePort()
    const client = makeClient({
      async *getSavedTracks() {
        yield [{ added_at: null, track: track('1') }]
      },
    })
    await harvestEverything(client, port)
    expect(state.tracks.filter((t) => t.externalId === '1')).toHaveLength(1)
  })

  it('checkpoints after every stage so an interrupted run resumes', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    const last = state.checkpoints.at(-1)!
    expect(last.completedStages).toContain('recently-played')
    expect(last.completedPlaylistIds).toContain('p1')
  })

  it('skips completed stages when resuming', async () => {
    const { port, state } = makePort()
    await port.saveCheckpoint({
      completedStages: ['profile', 'playlists', 'playlist-items', 'saved-tracks'],
      completedPlaylistIds: ['p1', 'p3'],
    })
    const getMyPlaylists = vi.fn(async function* () {})
    await harvestEverything(makeClient({ getMyPlaylists }), port, { resume: true })

    expect(getMyPlaylists).not.toHaveBeenCalled()
    expect(state.playlistItems.size).toBe(0) // already done, not re-read
    expect(state.followed).toHaveLength(1) // but the remaining stages ran
  })

  // ── The behaviour that matters with a deadline ─────────────
  it('stops cleanly and checkpoints when the quota is exhausted', async () => {
    const { port, state } = makePort()
    const client = makeClient({
      async *getSavedTracks(): AsyncGenerator<never> {
        throw new QuotaExceededError('quota spent', 3600)
      },
    })

    const summary = await harvestEverything(client, port)

    expect(summary.interruptedBy).toBe('QUOTA_EXCEEDED')
    // Everything up to the failure is safely persisted.
    expect(summary.stagesCompleted).toContain('playlist-items')
    expect(state.tracks.length).toBeGreaterThan(0)
    expect(state.checkpoints.at(-1)?.completedStages).toContain('playlist-items')
  })

  it('propagates a genuine error rather than silently truncating the harvest', async () => {
    const { port } = makePort()
    const client = makeClient({
      async *getSavedTracks(): AsyncGenerator<never> {
        throw new Error('network exploded')
      },
    })
    await expect(harvestEverything(client, port)).rejects.toThrow('network exploded')
  })

  it('emits progress for the live checklist UI', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    const stages = new Set(state.progress.map((p) => p.stage))
    expect(stages.has('playlists')).toBe(true)
    expect(stages.has('saved-albums')).toBe(true)
  })

  it('captures recently-played as listening events for the taste model', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    expect(state.events).toHaveLength(1)
    expect(state.events[0]?.trackName).toBe('Track 70')
  })

  it('harvests top items across all three time ranges for both types', async () => {
    const { port, state } = makePort()
    await harvestEverything(makeClient(), port)
    expect(state.topItems).toHaveLength(6)
  })

  it('skips local files, which have no id and cannot be matched upstream', async () => {
    const { port, state } = makePort()
    const client = makeClient({
      async *getPlaylistItems() {
        yield [{ added_at: null, item: { id: null, name: 'Local file', is_local: true } }]
      },
    })
    await harvestEverything(client, port)
    expect(state.tracks.find((t) => t.title === 'Local file')).toBeUndefined()
  })
})
