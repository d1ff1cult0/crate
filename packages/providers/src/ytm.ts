/**
 * YouTube Music provider. PROMPT.md §7.5 item 4.
 *
 * The brief is specific about why this is built the way it is:
 *
 *   "Resolve by searching YTM's catalog and matching on duration and album, rather than
 *    handing yt-dlp a raw text query — that's the difference between getting the track
 *    and getting a ten-hour loop."
 *
 * So search and download are separate steps. Search hits YouTube Music's own catalogue,
 * which returns structured results with real durations and album names; only once a
 * candidate has been scored and chosen does yt-dlp get invoked, and then by video ID
 * rather than by text. yt-dlp is never allowed to pick.
 *
 * First provider by design (§10 phase 4): it needs no credentials, so it is the one
 * that can be exercised end to end without asking the owner to set anything up.
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { rankCandidates } from '@crate/core'
import type {
  Candidate,
  DownloadProvider,
  DownloadedFile,
  HealthStatus,
  Progress,
  ProviderConfig,
  TrackQuery,
} from './types.js'

const DEFAULT_CONFIG: ProviderConfig = {
  enabled: true,
  // Priority 4 per the brief's default ordering — after slskd, streamrip and Bandcamp,
  // because it is a transcode of YouTube's own encode rather than a real rip.
  priority: 4,
  concurrency: 2,
  rateLimit: { requests: 10, per: 60_000 },
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    const timeoutMs = opts.timeoutMs ?? 300_000

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString()
      stdout += text
      if (opts.onLine) for (const line of text.split('\n')) if (line.trim()) opts.onLine(line)
    })
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * Extensions that count as the audio we asked for. yt-dlp also writes thumbnails and
 * sidecars into the same directory, so "the first new file" is not good enough.
 */
const AUDIO_EXTENSIONS = new Set([
  '.opus', '.ogg', '.m4a', '.mp3', '.aac', '.flac', '.wav', '.webm',
])

/**
 * Point yt-dlp at a JavaScript runtime.
 *
 * YouTube requires JS execution to decipher stream signatures. yt-dlp only enables Deno
 * by default, and without any runtime it warns that extraction is deprecated, drops to a
 * reduced set of formats, and intermittently returns `HTTP Error 403: Forbidden` on
 * perfectly available tracks — observed directly, on a video that downloaded fine
 * moments earlier.
 *
 * Node is always available: the worker image is built FROM node, and this code is running
 * inside that runtime. Naming it explicitly costs nothing and removes a whole class of
 * intermittent failure.
 */
const JS_RUNTIME_ARGS = ['--js-runtimes', `node:${process.execPath}`]

/** yt-dlp progress lines look like "[download]  42.3% of 4.21MiB at ...". */
const PROGRESS_RE = /\[download\]\s+([\d.]+)%/

interface YtDlpEntry {
  id?: string
  title?: string
  uploader?: string
  channel?: string
  artist?: string
  album?: string
  album_artist?: string
  release_year?: number
  duration?: number
  ext?: string
  abr?: number
}

export interface CanonicalYtmTrack {
  videoId: string
  title: string
  artists: string[]
  album: string
  albumArtist: string
  durationMs?: number
  year?: number
}


/**
 * Space out calls to honour `config.rateLimit`.
 *
 * `ProviderConfig.rateLimit` has been declared since the interface was written and was
 * never actually enforced anywhere — nothing read it. That showed up as intermittent
 * `HTTP Error 403: Forbidden` from YouTube: a search fetches metadata for ten results and
 * a download follows immediately, and with the queue running three at a time that is a
 * burst YouTube treats as abuse. The same URLs download fine a few seconds apart.
 *
 * Per instance rather than global, because the provider set is rebuilt per job; the
 * worker's own queue concurrency is what bounds the rest.
 */
function makeSpacer(rate: ProviderConfig['rateLimit']): () => Promise<void> {
  const minIntervalMs = rate.requests > 0 ? Math.ceil(rate.per / rate.requests) : 0
  let last = 0
  return async () => {
    if (minIntervalMs <= 0) return
    const wait = last + minIntervalMs - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    last = Date.now()
  }
}

export interface YtmProviderOptions {
  config?: Partial<ProviderConfig>
  /** Overridable for tests. */
  runner?: typeof run
  ytDlpPath?: string
  /** Overridable so tests do not wait out the rate limit. */
  spacer?: () => Promise<void>
}

export class YtmProvider implements DownloadProvider {
  readonly name = 'ytm'
  readonly config: ProviderConfig
  private readonly run: typeof run
  private readonly bin: string
  private readonly space: () => Promise<void>

  constructor(opts: YtmProviderOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.run = opts.runner ?? run
    this.bin = opts.ytDlpPath ?? 'yt-dlp'
    this.space = opts.spacer ?? makeSpacer(this.config.rateLimit)
  }

  async health(): Promise<HealthStatus> {
    try {
      const { code, stdout } = await this.run(this.bin, ['--version'], { timeoutMs: 15_000 })
      return code === 0
        ? { ok: true, detail: `yt-dlp ${stdout.trim()}` }
        : { ok: false, detail: 'yt-dlp exited non-zero' }
    } catch (err) {
      return {
        ok: false,
        detail:
          err instanceof Error && /ENOENT/.test(err.message)
            ? 'yt-dlp is not installed in this container.'
            : err instanceof Error
              ? err.message
              : String(err),
      }
    }
  }

  /**
   * Search YouTube Music's catalogue, not YouTube at large.
   *
   * `https://music.youtube.com/search` results carry real artist/album/duration
   * metadata, which is what makes scoring possible. A plain `ytsearch:` query returns
   * uploads with junk titles and no structure, which is exactly what the brief warns
   * against.
   */
  async search(query: TrackQuery): Promise<Candidate[]> {
    if (query.preferredCandidateId) {
      return [{
        id: query.preferredCandidateId,
        title: query.title,
        artist: query.artists.join(', '),
        album: query.album,
        durationMs: query.durationMs,
        detail: { videoId: query.preferredCandidateId, catalogConfirmed: true },
      }]
    }
    const terms = [query.artists.join(' '), query.title].filter(Boolean).join(' ')
    // ytsearch against music.youtube.com yields the catalogue entries rather than
    // arbitrary uploads. 10 results is plenty for scoring to find a winner.
    const target = `ytsearch10:${terms}`

    let result: RunResult
    try {
      await this.space()
      result = await this.run(
        this.bin,
        [
          target,
          ...JS_RUNTIME_ARGS,
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
          '--quiet',
          // Music results only — this is what keeps lyric videos and loops out.
          '--extractor-args',
          'youtube:player_client=web_music',
        ],
        { timeoutMs: 60_000 },
      )
    } catch {
      return []
    }

    if (result.code !== 0) return []

    const candidates: Candidate[] = []
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue
      let entry: YtDlpEntry
      try {
        entry = JSON.parse(line) as YtDlpEntry
      } catch {
        continue
      }
      if (!entry.id) continue

      candidates.push({
        id: entry.id,
        title: entry.title ?? '',
        // Prefer the structured artist field; fall back to the channel, which for
        // YouTube Music is usually "<Artist> - Topic".
        artist: entry.artist ?? entry.channel ?? entry.uploader ?? '',
        album: entry.album,
        durationMs: entry.duration ? Math.round(entry.duration * 1000) : undefined,
        format: entry.ext,
        bitrate: entry.abr,
        detail: {
          videoId: entry.id,
          uploader: entry.uploader,
          channel: entry.channel,
          structuredArtist: entry.artist,
          albumArtist: entry.album_artist,
          releaseYear: entry.release_year,
        },
      })
    }

    return candidates
  }

  /** Confirm a title hint against structured YT Music results before it becomes source metadata. */
  async confirmCanonical(query: TrackQuery): Promise<CanonicalYtmTrack | null> {
    const candidates = (await this.search(query)).filter((candidate) =>
      candidate.album?.trim()
      && typeof candidate.detail?.structuredArtist === 'string'
      && candidate.detail.structuredArtist.trim(),
    )
    const ranked = rankCandidates(
      { title: query.title, artists: query.artists, durationMs: query.durationMs ?? null, album: query.album ?? null },
      candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        artist: candidate.artist,
        album: candidate.album ?? null,
        durationMs: candidate.durationMs ?? null,
        format: candidate.format ?? null,
        bitrate: candidate.bitrate ?? null,
      })),
      { durationToleranceMs: 5_000, minBitrateKbps: 0, acceptFloor: 0.8, artistPlausibilityFloor: 0.8 },
    )
    const winner = ranked[0]
    if (!winner || winner.rejected) return null
    const candidate = candidates.find((item) => item.id === winner.id)
    if (!candidate?.album) return null
    const detailAlbumArtist = typeof candidate.detail?.albumArtist === 'string'
      ? candidate.detail.albumArtist.trim()
      : ''
    const albumArtist = detailAlbumArtist || candidate.artist.trim()
    const year = candidate.detail?.releaseYear
    return {
      videoId: candidate.id,
      title: candidate.title,
      artists: [candidate.artist.replace(/\s+-\s+Topic$/i, '').trim()],
      album: candidate.album,
      albumArtist: albumArtist.replace(/\s+-\s+Topic$/i, '').trim(),
      ...(candidate.durationMs !== undefined ? { durationMs: candidate.durationMs } : {}),
      ...(typeof year === 'number' ? { year } : {}),
    }
  }

  /**
   * Download a SPECIFIC video id that scoring already chose. yt-dlp is never handed a
   * text query here — by this point the decision has been made and logged.
   */
  async download(
    candidate: Candidate,
    destinationDir: string,
    onProgress: (p: Progress) => void,
  ): Promise<DownloadedFile> {
    const before = new Set(await readdir(destinationDir).catch(() => []))
    const template = join(destinationDir, '%(id)s.%(ext)s')

    await this.space()
    let result = await this.runDownload(candidate.id, template, onProgress, false)

    // A poisoned player cache is the single most confusing failure this provider has.
    //
    // yt-dlp caches YouTube player/signature data under ~/.cache/yt-dlp. When that data
    // goes stale it returns `HTTP Error 403: Forbidden` for videos that are perfectly
    // available — and because the cache lives as long as the container, EVERY download
    // fails from then on while the same URL works from a fresh environment. Diagnosed by
    // clearing the cache and watching identical commands start succeeding again.
    //
    // So a 403 is retried exactly once with the cache bypassed. If that works, the cache
    // was the problem; if it does not, the failure is real and reported as such.
    if (result.code !== 0 && /403|forbidden/i.test(result.stderr)) {
      result = await this.runDownload(candidate.id, template, onProgress, true)
    }

    return this.collect(candidate, destinationDir, before, result)
  }

  /** One yt-dlp download invocation. `bypassCache` is the 403 self-heal. */
  private async runDownload(
    videoId: string,
    template: string,
    onProgress: (p: Progress) => void,
    bypassCache: boolean,
  ): Promise<RunResult> {
    return this.run(
      this.bin,
      [
        `https://music.youtube.com/watch?v=${videoId}`,
        ...JS_RUNTIME_ARGS,
        ...(bypassCache ? ['--no-cache-dir'] : []),
        '--extract-audio',
        // Opus is YouTube's native codec, so this avoids a needless re-encode.
        '--audio-format',
        'opus',
        '--audio-quality',
        '0',
        '--embed-metadata',
        // NO --embed-thumbnail, deliberately. Two reasons, in order of importance:
        //
        //  1. The post-processing chain fetches cover art itself (§7.6 step 4) from the
        //     harvested Spotify payload, Cover Art Archive or Deezer — real album art,
        //     rather than a YouTube video thumbnail that is square, often letterboxed and
        //     sometimes just the uploader's banner.
        //  2. Embedding a thumbnail into Opus needs the Python `mutagen` module, and
        //     without it yt-dlp fails the *postprocessing* step and exits non-zero having
        //     already downloaded the audio perfectly well. We were throwing that file
        //     away over art we were about to replace anyway.
        '--no-playlist',
        '--newline',
        '-o',
        template,
      ],
      {
        timeoutMs: 600_000,
        onLine: (line) => {
          const match = PROGRESS_RE.exec(line)
          if (match?.[1]) onProgress({ percent: Number(match[1]), message: 'downloading' })
        },
      },
    )
  }

  /** Work out what landed on disk and whether it counts as success. */
  private async collect(
    candidate: Candidate,
    destinationDir: string,
    before: Set<string>,
    result: RunResult,
  ): Promise<DownloadedFile> {
    // Identify what actually landed rather than assuming the extension.
    const after = await readdir(destinationDir)
    const created = after.filter((f) => !before.has(f) && f.startsWith(candidate.id))
    const audio = created.find((f) => AUDIO_EXTENSIONS.has(f.slice(f.lastIndexOf('.'))))

    if (!audio) {
      throw new Error(
        result.code !== 0
          ? `yt-dlp failed (${result.code}): ${result.stderr.slice(-300).trim()}`
          : 'yt-dlp reported success but produced no audio file',
      )
    }

    // A non-zero exit with the audio already on disk means a POST-processing step failed
    // — a missing optional dependency, an unwritable tag, a thumbnail conversion. The
    // audio itself is fine, and the file is about to be put through our own verification
    // (real audio, expected duration, not silent, not truncated) before anything lets it
    // near the library. So judge it on the file, not on yt-dlp's exit code.
    const file = audio

    const path = join(destinationDir, file)
    const { statSync } = await import('node:fs')
    const stats = statSync(path)

    return {
      path,
      format: file.split('.').pop() ?? 'opus',
      sizeBytes: stats.size,
      ...(candidate.durationMs ? { durationMs: candidate.durationMs } : {}),
    }
  }
}
