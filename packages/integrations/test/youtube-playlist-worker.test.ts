import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  confirmCanonical: vi.fn(),
  sourceTrackUpsert: vi.fn(),
}))

vi.mock('../../core/src/index.ts', () => ({
  normalizeTrack: () => ({ title: { norm: 'canonical title' }, artist: { norm: 'canonical artist' } }),
}))
vi.mock('../src/index.ts', () => ({
  YouTubePlaylistUrlSchema: { parse: (url: string) => ({ url, playlistId: 'playlist-id' }) },
  YouTubePlaylistClient: class {
    async resolve() {
      return {
        playlistId: 'playlist-id', name: 'Playlist', duplicates: 0, invalidEntries: 0,
        tracks: [{
          videoId: 'original-playlist-video', title: 'Untrusted title', artists: ['Untrusted artist'],
          album: 'Untrusted album', albumArtist: 'Untrusted album artist', durationMs: 111_000,
          year: 1999, metadataSource: 'structured', raw: { id: 'original-playlist-video' },
        }],
      }
    }
  },
}))
vi.mock('../../providers/src/index.ts', () => ({
  YtmProvider: class { confirmCanonical = mocks.confirmCanonical },
}))
vi.mock('../../db/src/index.ts', () => ({
  prisma: {
    importRun: { update: vi.fn() },
    sourceTrack: { findMany: vi.fn().mockResolvedValue([]), upsert: mocks.sourceTrackUpsert },
    sourcePlaylist: { upsert: vi.fn().mockResolvedValue({ id: 'source-playlist-id' }) },
    sourcePlaylistItem: { deleteMany: vi.fn(), createMany: vi.fn() },
    match: { findMany: vi.fn().mockResolvedValue([]) },
  },
}))
vi.mock('../../../apps/worker/src/jobs/match.js', () => ({
  runMatchSweep: vi.fn().mockResolvedValue({ matched: 0, missing: 0, review: 0 }),
}))
vi.mock('../../../apps/worker/src/jobs/playlist.js', () => ({
  materializePlaylist: vi.fn().mockResolvedValue(null), triggerScan: vi.fn(), writePlaylist: vi.fn(),
}))
vi.mock('../../../apps/worker/src/lib/download-queue.js', () => ({ requestDownload: vi.fn() }))
vi.mock('../../../apps/worker/src/lib/youtube-import-status.js', () => ({
  recordYouTubePlaylistWriteOutcome: vi.fn(), refreshYouTubeImport: vi.fn(),
}))

import { runYouTubePlaylistImport } from '../../../apps/worker/src/jobs/youtube-playlist.js'

describe('YouTube playlist canonical metadata gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirmCanonical.mockResolvedValue({
      videoId: 'confirmed-ytm-video', title: 'Canonical title', artists: ['Canonical artist'],
      album: 'Canonical album', albumArtist: 'Canonical album artist', durationMs: 222_000, year: 2024,
    })
    mocks.sourceTrackUpsert.mockResolvedValue({ id: 'source-track-id' })
  })

  it('confirms plain yt-dlp artist and album hints before persisting canonical metadata', async () => {
    await runYouTubePlaylistImport(
      { log: vi.fn() } as never,
      { importRunId: 'import-run-id', url: 'https://www.youtube.com/playlist?list=playlist-id' },
    )

    expect(mocks.confirmCanonical).toHaveBeenCalledOnce()
    expect(mocks.sourceTrackUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { source_externalId: { source: 'YOUTUBE', externalId: 'original-playlist-video' } },
      create: expect.objectContaining({
        externalId: 'original-playlist-video', title: 'Canonical title', artists: ['Canonical artist'],
        album: 'Canonical album', albumArtist: 'Canonical album artist', durationMs: 222_000, year: 2024,
        rawJson: expect.objectContaining({ crateCanonicalYtmVideoId: 'confirmed-ytm-video' }),
      }),
    }))
  })
})
