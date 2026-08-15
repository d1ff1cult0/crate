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
    const calls: string[][] = []
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async (_cmd, args) => {
        calls.push(args)
        return {
          code: 0,
          stderr: '',
          stdout: [
            JSON.stringify({
              id: 'plain-youtube-result',
              title: 'Goud',
              channel: 'Suzan & Freek',
              duration: 203,
            }),
            JSON.stringify({
              id: 'incomplete-music-result',
              title: 'Goud',
              artist: 'Suzan & Freek',
              duration: 203,
            }),
            JSON.stringify({
              id: 'MWxopWLwKv4',
              title: 'Goud',
              artist: 'Suzan & Freek',
              album: 'Dromen In Kleur',
              album_artist: 'Suzan & Freek',
              duration: 203,
              release_year: 2021,
            }),
          ].join('\n'),
        }
      },
    })

    await expect(provider.confirmCanonical({ title: 'Goud', artists: ['Suzan & Freek'] })).resolves.toEqual({
      videoId: 'MWxopWLwKv4',
      title: 'Goud',
      artists: ['Suzan & Freek'],
      album: 'Dromen In Kleur',
      albumArtist: 'Suzan & Freek',
      durationMs: 203_000,
      year: 2021,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('https://music.youtube.com/search?q=Suzan%20%26%20Freek%20Goud')
    expect(calls[0]).not.toContain('--flat-playlist')
    expect(calls[0]).toEqual(expect.arrayContaining([
      '--playlist-items',
      '1:5',
      '--extractor-args',
      'youtube:player_client=web_music',
    ]))
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

  it('never treats incomplete entries as canonical metadata', async () => {
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async () => ({
        code: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ id: 'channel-only', title: 'Goud', channel: 'Suzan & Freek - Topic', album: 'Dromen In Kleur' }),
          JSON.stringify({ id: 'uploader-only', title: 'Goud', uploader: 'Suzan & Freek', album: 'Dromen In Kleur' }),
          JSON.stringify({ id: 'missing-album', title: 'Goud', artist: 'Suzan & Freek' }),
          JSON.stringify({ id: 'blank-artist', title: 'Goud', artist: '  ', album: 'Dromen In Kleur' }),
          JSON.stringify({ id: 'blank-album', title: 'Goud', artist: 'Suzan & Freek', album: '  ' }),
        ].join('\n'),
      }),
    })

    await expect(provider.confirmCanonical({ title: 'Goud', artists: ['Suzan & Freek'] })).resolves.toBeNull()
  })
})

describe('YtmProvider generic search', () => {
  it('retains ytsearch10 and flat playlist extraction', async () => {
    const calls: string[][] = []
    const provider = new YtmProvider({
      spacer: async () => undefined,
      runner: async (_cmd, args) => {
        calls.push(args)
        return { code: 0, stderr: '', stdout: '' }
      },
    })

    await provider.search({ title: 'Goud', artists: ['Suzan & Freek'] })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('ytsearch10:Suzan & Freek Goud')
    expect(calls[0]).toContain('--flat-playlist')
    expect(calls[0]).toEqual(expect.arrayContaining([
      '--extractor-args',
      'youtube:player_client=web_music',
    ]))
  })
})
