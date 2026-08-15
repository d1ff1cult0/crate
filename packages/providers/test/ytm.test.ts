import { describe, expect, it } from 'vitest'
import { YtmProvider } from '../src/ytm.js'

describe('YtmProvider catalog confirmation', () => {
  it('uses an already-confirmed catalog id without searching for a substitute', async () => {
    let calls = 0
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async () => { calls++; return { code: 1, stdout: '', stderr: 'must not search' } },
    })

    await expect(provider.search({
      title: 'Ani Kuni', artists: ['Polo & Pan'], album: 'Cyclorama', preferredCandidateId: 'canonical-ytm-id',
    })).resolves.toEqual([expect.objectContaining({ id: 'canonical-ytm-id', album: 'Cyclorama' })])
    expect(calls).toBe(0)
  })

  it('returns album-bearing canonical metadata and the exact catalog video id', async () => {
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async () => ({
        code: 0,
        stderr: '',
        stdout: `${JSON.stringify({
          id: 'canonical-ytm-id',
          title: 'Ani Kuni',
          artist: 'Polo & Pan',
          album: 'Cyclorama',
          album_artist: 'Polo & Pan',
          duration: 200,
          release_year: 2021,
        })}\n`,
      }),
    })

    await expect(provider.confirmCanonical({ title: 'Ani Kuni', artists: ['Polo & Pan'] })).resolves.toEqual({
      videoId: 'canonical-ytm-id',
      title: 'Ani Kuni',
      artists: ['Polo & Pan'],
      album: 'Cyclorama',
      albumArtist: 'Polo & Pan',
      durationMs: 200_000,
      year: 2021,
    })
  })

  it('rejects a plausible catalog hit when its album is missing', async () => {
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async () => ({
        code: 0,
        stderr: '',
        stdout: `${JSON.stringify({ id: 'upload-id', title: 'Ani Kuni', artist: 'Polo & Pan' })}\n`,
      }),
    })

    await expect(provider.confirmCanonical({ title: 'Ani Kuni', artists: ['Polo & Pan'] })).resolves.toBeNull()
  })

  it('rejects an album-bearing result without an explicit structured artist', async () => {
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async () => ({
        code: 0,
        stderr: '',
        stdout: `${JSON.stringify({
          id: 'upload-id',
          title: 'Ani Kuni',
          channel: 'Polo & Pan - Topic',
          album: 'Cyclorama',
        })}\n`,
      }),
    })

    await expect(provider.confirmCanonical({ title: 'Ani Kuni', artists: ['Polo & Pan'] })).resolves.toBeNull()
  })
})
