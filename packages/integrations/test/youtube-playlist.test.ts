import { describe, expect, it } from 'vitest'
import { dedupeYouTubeEntries, YouTubePlaylistClient, YouTubePlaylistUrlSchema } from '../src/youtube/playlist.js'

describe('YouTubePlaylistUrlSchema', () => {
  it('accepts and canonicalizes a normal playlist URL', () => {
    expect(YouTubePlaylistUrlSchema.parse('https://www.youtube.com/playlist?list=PL1234567890_abc&si=noise')).toEqual({
      url: 'https://www.youtube.com/playlist?list=PL1234567890_abc', playlistId: 'PL1234567890_abc',
    })
  })
  it.each(['https://youtu.be/abc?list=PL1234567890', 'https://www.youtube.com/watch?v=abc&list=PL1234567890', 'http://www.youtube.com/playlist?list=PL1234567890', 'https://evil.test/playlist?list=PL1234567890'])('rejects non-canonical or unsafe input: %s', (url) => {
    expect(YouTubePlaylistUrlSchema.safeParse(url).success).toBe(false)
  })
})

describe('YouTube playlist resolution', () => {
  it('never treats an ordinary uploader as canonical music metadata', async () => {
    const output = JSON.stringify({ id: 'PL1234567890', title: 'Bad production entries', entries: [
      { id: 'ordinary-upload', title: 'Polo & Pan - Ani Kuni', uploader: 'WMW LABEL' },
      { id: 'ambiguous-upload', title: 'Ani Kuni', uploader: 'WMW LABEL' },
    ] })
    const client = new YouTubePlaylistClient({ runner: async () => ({ code: 0, stdout: output, stderr: '' }) })

    const resolved = await client.resolve('https://www.youtube.com/playlist?list=PL1234567890')

    expect(resolved.tracks).toEqual([
      expect.objectContaining({
        videoId: 'ordinary-upload',
        title: 'Ani Kuni',
        artists: ['Polo & Pan'],
      }),
    ])
    expect(resolved.tracks[0]).not.toHaveProperty('album')
    expect(resolved.tracks[0]?.artists).not.toContain('WMW LABEL')
    expect(resolved.invalidEntries).toBe(1)
  })

  it('preserves genuinely structured YouTube Music metadata with a non-empty album', async () => {
    const output = JSON.stringify({ id: 'PL1234567890', title: 'Music', entries: [
      { id: 'ytm-track', title: 'Ani Kuni', artist: 'Polo & Pan', album: 'Cyclorama', album_artist: 'Polo & Pan' },
      { id: 'dash-track', title: 'Air – La femme d’argent', uploader: 'Label channel' },
    ] })
    const client = new YouTubePlaylistClient({ runner: async () => ({ code: 0, stdout: output, stderr: '' }) })

    const resolved = await client.resolve('https://www.youtube.com/playlist?list=PL1234567890')

    expect(resolved.tracks[0]).toEqual(expect.objectContaining({
      metadataSource: 'structured', album: 'Cyclorama', albumArtist: 'Polo & Pan', artists: ['Polo & Pan'],
    }))
    expect(resolved.tracks[0]?.album).not.toBe('')
    expect(resolved.tracks[1]).toEqual(expect.objectContaining({
      metadataSource: 'title', title: 'La femme d’argent', artists: ['Air'],
    }))
  })

  it('rejects a playlist beyond the documented item cap', async () => {
    const output = JSON.stringify({ id: 'PL1234567890', title: 'Too large', entries: Array.from({ length: 2001 }, (_, i) => ({ id: `video-${i}`, title: `Track ${i}` })) })
    const client = new YouTubePlaylistClient({ runner: async () => ({ code: 0, stdout: output, stderr: '' }) })
    await expect(client.resolve('https://www.youtube.com/playlist?list=PL1234567890')).rejects.toThrow(/2,000/)
  })

  it('rejects yt-dlp output beyond the documented byte cap', async () => {
    const client = new YouTubePlaylistClient({ runner: async () => ({ code: 0, stdout: 'x'.repeat(16 * 1024 * 1024 + 1), stderr: '' }) })
    await expect(client.resolve('https://www.youtube.com/playlist?list=PL1234567890')).rejects.toThrow(/16 MiB/)
  })

  it('deduplicates repeated videos while preserving first-seen order', () => {
    const make = (videoId: string, title = videoId) => ({ videoId, title, artists: ['A'], metadataSource: 'structured' as const, raw: {} })
    expect(dedupeYouTubeEntries([make('a'), make('b'), make('a', 'repeat')])).toEqual({
      tracks: [make('a'), make('b')], duplicates: 1,
    })
  })

  it('parses yt-dlp output and remains idempotent across reruns', async () => {
    const output = JSON.stringify({ id: 'PL1234567890', title: 'Road trip', entries: [
      { id: 'video-1', title: 'One', artist: 'Artist', duration: 180 },
      { id: 'video-1', title: 'One again', artist: 'Artist', duration: 180 },
    ] })
    const client = new YouTubePlaylistClient({ runner: async () => ({ code: 0, stdout: output, stderr: '' }) })
    const first = await client.resolve('https://www.youtube.com/playlist?list=PL1234567890')
    const second = await client.resolve('https://www.youtube.com/playlist?list=PL1234567890')
    expect(first.tracks.map((track) => track.videoId)).toEqual(['video-1'])
    expect(second).toEqual(first)
    expect(first.duplicates).toBe(1)
  })
})
