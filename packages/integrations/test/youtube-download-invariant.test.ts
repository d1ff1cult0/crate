import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findRequest: vi.fn(),
  findSourceTrack: vi.fn(),
  updateRequest: vi.fn(),
  upsertRequest: vi.fn(),
  queueAdd: vi.fn(),
  queueGetJob: vi.fn(),
  acquireTrack: vi.fn(),
  verifyAudio: vi.fn(),
  writeTags: vi.fn(),
  registerFile: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock('../../db/src/index.ts', () => ({
  prisma: {
    downloadRequest: {
      findUnique: mocks.findRequest,
      update: mocks.updateRequest,
      upsert: mocks.upsertRequest,
    },
    sourceTrack: { findUnique: mocks.findSourceTrack },
    downloadAttempt: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    libraryFile: { findFirst: vi.fn(), findUnique: vi.fn() },
    match: { upsert: vi.fn() },
    duplicateGroup: { create: vi.fn() },
    duplicateMember: { createMany: vi.fn() },
  },
}))

vi.mock('../../../apps/worker/src/lib/queues.js', () => ({
  getQueue: () => ({ add: mocks.queueAdd, getJob: mocks.queueGetJob }),
  enqueue: vi.fn(),
  jobId: (...parts: unknown[]) => parts.join(':'),
}))

vi.mock('../../../apps/worker/src/lib/settings.js', () => ({
  loadSettings: vi.fn().mockResolvedValue({
    downloadEnabled: true,
    stagingRoot: '/staging',
    musicRoot: '/music',
    trashRoot: '/trash',
    downloadMinBitrateKbps: 0,
    verifyDurationToleranceMs: 5_000,
    verifyMinDurationMs: 1_000,
    verifyFullDecode: false,
    transcodeNormalizeLossy: false,
    transcodeTargetFormat: 'mp3',
    transcodeBitrateKbps: 320,
    coverArtEnabled: false,
    placementTemplate: '{albumartist}/{album}/{title}.{ext}',
    fingerprintEnabled: false,
    providers: {},
  }),
}))

vi.mock('../../providers/src/index.ts', () => ({
  acquireTrack: mocks.acquireTrack,
  queryString: vi.fn(() => 'query'),
  YtmProvider: class { name = 'ytm' },
}))

vi.mock('../../../apps/worker/src/lib/audio.js', () => ({
  verifyAudio: mocks.verifyAudio,
  writeTags: mocks.writeTags,
  decideTranscode: vi.fn(),
  probeAudio: vi.fn(),
  canEmbedArt: vi.fn(),
  computeFingerprint: vi.fn(),
  embedCoverArt: vi.fn(),
  fingerprintDigest: vi.fn(),
  hashAudioStream: vi.fn(),
  transcode: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: vi.fn(),
  unlink: mocks.unlink,
}))

vi.mock('../../../apps/worker/src/jobs/scan.js', () => ({
  readFileMetadata: vi.fn(),
  registerFile: mocks.registerFile,
}))
vi.mock('../../../apps/worker/src/lib/navidrome.js', () => ({ requestNavidromeScan: vi.fn() }))
vi.mock('../../../apps/worker/src/lib/trash.js', () => ({
  moveToTrash: vi.fn(),
  trashDestination: vi.fn(),
}))
vi.mock('../../integrations/src/index.ts', () => ({
  downloadCoverArt: vi.fn(),
  findCoverArt: vi.fn(),
}))

import { requestDownload } from '../../../apps/worker/src/lib/download-queue.js'
import { runDownload } from '../../../apps/worker/src/jobs/download.js'
import { runPostprocess } from '../../../apps/worker/src/jobs/postprocess.js'

const badSource = {
  id: 'source-1',
  source: 'YOUTUBE',
  title: 'A title',
  artists: ['Uploader'],
  album: '   ',
  rawJson: { id: 'youtube-video' },
  albumArtist: null,
  durationMs: 180_000,
  isrc: null,
  mbid: null,
  year: null,
}

const ctx = () => ({ log: vi.fn(), setProgress: vi.fn() }) as never

describe('canonical YouTube eligibility at download execution boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findSourceTrack.mockResolvedValue(badSource)
    mocks.findRequest.mockResolvedValue(null)
    mocks.updateRequest.mockResolvedValue({})
    mocks.upsertRequest.mockResolvedValue({ id: 'request-1', priority: 0 })
    mocks.queueGetJob.mockResolvedValue(null)
    mocks.acquireTrack.mockResolvedValue({ attempts: [], file: null })
    mocks.verifyAudio.mockResolvedValue({ ok: false, reason: 'BAD_AUDIO', detail: 'test rejection' })
    mocks.unlink.mockResolvedValue(undefined)
  })

  it('requestDownload refuses to create or enqueue an ineligible YouTube source track', async () => {
    await expect(requestDownload(badSource.id)).rejects.toThrow(/canonical YouTube metadata/i)

    expect(mocks.upsertRequest).not.toHaveBeenCalled()
    expect(mocks.queueAdd).not.toHaveBeenCalled()
  })

  it('runDownload holds an existing bad request before provider or staging work', async () => {
    mocks.findRequest.mockResolvedValue({
      id: 'request-1', status: 'QUEUED', priority: 0, sourceTrack: badSource,
    })

    const result = await runDownload(ctx(), { requestId: 'request-1' })

    expect(result.status).toBe('SKIPPED')
    expect(mocks.updateRequest).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'MANUAL_HOLD', lastError: expect.stringMatching(/canonical YouTube metadata/i) },
    })
    expect(mocks.acquireTrack).not.toHaveBeenCalled()
  })

  it('runPostprocess discards staged input and holds before verify, tags, move, or register', async () => {
    mocks.findRequest.mockResolvedValue({
      id: 'request-1', status: 'RUNNING', priority: 0, sourceTrack: badSource,
    })

    const result = await runPostprocess(ctx(), {
      requestId: 'request-1', stagedPath: '/staging/request-1/file.opus', provider: 'ytm',
    })

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/canonical YouTube metadata/i) })
    expect(mocks.unlink).toHaveBeenCalledWith('/staging/request-1/file.opus')
    expect(mocks.updateRequest).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { status: 'MANUAL_HOLD', lastError: expect.stringMatching(/canonical YouTube metadata/i) },
    })
    expect(mocks.verifyAudio).not.toHaveBeenCalled()
    expect(mocks.writeTags).not.toHaveBeenCalled()
    expect(mocks.registerFile).not.toHaveBeenCalled()
  })
})
