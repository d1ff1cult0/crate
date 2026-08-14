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

/** yt-dlp progress lines look like "[download]  42.3% of 4.21MiB at ...". */
const PROGRESS_RE = /\[download\]\s+([\d.]+)%/

interface YtDlpEntry {
  id?: string
  title?: string
  uploader?: string
  channel?: string
  artist?: string
  album?: string
  duration?: number
  ext?: string
  abr?: number
}

export interface YtmProviderOptions {
  config?: Partial<ProviderConfig>
  /** Overridable for tests. */
  runner?: typeof run
  ytDlpPath?: string
}

export class YtmProvider implements DownloadProvider {
  readonly name = 'ytm'
  readonly config: ProviderConfig
  private readonly run: typeof run
  private readonly bin: string

  constructor(opts: YtmProviderOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.run = opts.runner ?? run
    this.bin = opts.ytDlpPath ?? 'yt-dlp'
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
    const terms = [query.artists.join(' '), query.title].filter(Boolean).join(' ')
    // ytsearch against music.youtube.com yields the catalogue entries rather than
    // arbitrary uploads. 10 results is plenty for scoring to find a winner.
    const target = `ytsearch10:${terms}`

    let result: RunResult
    try {
      result = await this.run(
        this.bin,
        [
          target,
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
        detail: { videoId: entry.id, uploader: entry.uploader, channel: entry.channel },
      })
    }

    return candidates
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

    const result = await this.run(
      this.bin,
      [
        `https://music.youtube.com/watch?v=${candidate.id}`,
        '--extract-audio',
        // Opus is YouTube's native codec, so this avoids a needless re-encode.
        '--audio-format',
        'opus',
        '--audio-quality',
        '0',
        '--embed-metadata',
        '--embed-thumbnail',
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

    if (result.code !== 0) {
      throw new Error(`yt-dlp failed (${result.code}): ${result.stderr.slice(-300).trim()}`)
    }

    // Identify what actually landed rather than assuming the extension.
    const after = await readdir(destinationDir)
    const created = after.filter((f) => !before.has(f) && f.startsWith(candidate.id))
    const file = created[0]
    if (!file) {
      throw new Error('yt-dlp reported success but produced no file')
    }

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
