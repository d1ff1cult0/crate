import { spawn } from 'node:child_process'
import { z } from 'zod'

const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

/** Server-boundary schema: only ordinary YouTube playlist URLs with a list id. */
export const YouTubePlaylistUrlSchema = z.string().trim().url().transform((input, ctx) => {
  const url = new URL(input)
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use a normal https://www.youtube.com/playlist?list=… URL.' })
    return z.NEVER
  }
  if (url.pathname !== '/playlist') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use the playlist page URL, not a video or channel URL.' })
    return z.NEVER
  }
  const listId = url.searchParams.get('list')?.trim()
  if (!listId || !/^[A-Za-z0-9_-]{10,}$/.test(listId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The URL has no valid YouTube playlist id.' })
    return z.NEVER
  }
  return { url: `https://www.youtube.com/playlist?list=${listId}`, playlistId: listId }
})

const EntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().optional(),
  uploader: z.string().optional(),
  channel: z.string().optional(),
  album: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  track_number: z.number().int().positive().optional(),
  release_year: z.number().int().optional(),
}).passthrough()

const PlaylistSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uploader: z.string().optional(),
  channel: z.string().optional(),
  thumbnail: z.string().url().optional(),
  thumbnails: z.array(z.object({ url: z.string().url() }).passthrough()).optional(),
  entries: z.array(z.unknown()),
}).passthrough()

export interface YouTubePlaylistTrack {
  videoId: string
  title: string
  artists: string[]
  album?: string
  durationMs?: number
  year?: number
  raw: Record<string, unknown>
}

export interface YouTubePlaylist {
  playlistId: string
  name: string
  ownerName?: string
  imageUrl?: string
  tracks: YouTubePlaylistTrack[]
  invalidEntries: number
}

/** Preserve first occurrence and order while removing repeated videos. */
export function dedupeYouTubeEntries(entries: YouTubePlaylistTrack[]): {
  tracks: YouTubePlaylistTrack[]
  duplicates: number
} {
  const seen = new Set<string>()
  const tracks: YouTubePlaylistTrack[] = []
  let duplicates = 0
  for (const entry of entries) {
    if (seen.has(entry.videoId)) {
      duplicates++
      continue
    }
    seen.add(entry.videoId)
    tracks.push(entry)
  }
  return { tracks, duplicates }
}

type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

function run(cmd: string, args: string[], timeoutMs: number): ReturnType<Runner> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)) }, timeoutMs)
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

export class YouTubePlaylistClient {
  constructor(private readonly opts: { ytDlpPath?: string; timeoutMs?: number; runner?: Runner } = {}) {}

  async resolve(input: string): Promise<YouTubePlaylist & { duplicates: number }> {
    const parsedUrl = YouTubePlaylistUrlSchema.parse(input)
    const runner = this.opts.runner ?? run
    let result: Awaited<ReturnType<Runner>>
    try {
      result = await runner(this.opts.ytDlpPath ?? 'yt-dlp', [
        parsedUrl.url,
        '--flat-playlist',
        '--dump-single-json',
        '--no-warnings',
        '--quiet',
      ], this.opts.timeoutMs ?? 180_000)
    } catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) {
        throw new Error('yt-dlp is not installed in the worker. Rebuild the worker image; docker/worker.Dockerfile installs and verifies it.')
      }
      throw error
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n').slice(-3).join(' ')
      throw new Error(`yt-dlp could not read this playlist${detail ? `: ${detail}` : '.'}`)
    }

    const playlist = PlaylistSchema.parse(JSON.parse(result.stdout) as unknown)
    const tracks: YouTubePlaylistTrack[] = []
    let invalidEntries = 0
    for (const raw of playlist.entries) {
      const entry = EntrySchema.safeParse(raw)
      if (!entry.success) { invalidEntries++; continue }
      const artist = (entry.data.artist ?? entry.data.channel ?? entry.data.uploader ?? 'Unknown artist')
        .replace(/\s+-\s+Topic$/i, '').trim()
      tracks.push({
        videoId: entry.data.id,
        title: entry.data.title,
        artists: [artist],
        ...(entry.data.album ? { album: entry.data.album } : {}),
        ...(entry.data.duration !== undefined ? { durationMs: Math.round(entry.data.duration * 1000) } : {}),
        ...(entry.data.release_year !== undefined ? { year: entry.data.release_year } : {}),
        raw: entry.data,
      })
    }
    const unique = dedupeYouTubeEntries(tracks)
    return {
      playlistId: playlist.id,
      name: playlist.title,
      ...(playlist.uploader ?? playlist.channel ? { ownerName: playlist.uploader ?? playlist.channel } : {}),
      ...(playlist.thumbnail ?? playlist.thumbnails?.at(-1)?.url ? { imageUrl: playlist.thumbnail ?? playlist.thumbnails?.at(-1)?.url } : {}),
      tracks: unique.tracks,
      duplicates: unique.duplicates,
      invalidEntries,
    }
  }
}
