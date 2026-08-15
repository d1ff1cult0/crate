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
  it('deduplicates repeated videos while preserving first-seen order', () => {
    const make = (videoId: string, title = videoId) => ({ videoId, title, artists: ['A'], raw: {} })
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
