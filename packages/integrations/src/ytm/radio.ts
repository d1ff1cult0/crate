/**
 * YouTube Music radios as a similarity source. PROMPT.md §7.8.
 *
 * "get_watch_playlist(radio=True) returns YTM's actual radio sequence, which is the
 *  closest freely available thing to Daily Mix quality; harvest co-occurrence from radios
 *  seeded on my top tracks."
 *
 * The brief names `ytmusicapi`, which is Python. Rather than add a Python runtime to the
 * worker image for one call, this drives the same endpoint through `yt-dlp` — already a
 * hard dependency for the download provider — by asking for the `RD<videoId>` radio
 * playlist and reading the sequence it returns. Same data, no second runtime.
 *
 * What comes out is an ORDERED sequence, and the order carries the signal: YTM puts the
 * closest neighbours first and drifts outward. Position is therefore converted into a
 * weight, and every pair in the sequence contributes co-occurrence, not just pairs with
 * the seed — two artists appearing together in the same radio is itself evidence.
 */

import { spawn } from 'node:child_process'

export interface YtmRadioOptions {
  ytDlpPath?: string
  timeoutMs?: number
  /** How many entries of the radio to read. YTM serves ~25 by default. */
  limit?: number
  runner?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>
}

export interface RadioEntry {
  videoId: string
  title: string
  artist: string
  position: number
}

function defaultRunner(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', () => undefined)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout })
    })
  })
}

interface FlatEntry {
  id?: string
  title?: string
  artist?: string
  channel?: string
  uploader?: string
}

/** "Radiohead - Topic" is how YouTube Music names an artist channel. */
export function cleanArtistName(raw: string | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/\s*VEVO\s*$/i, '')
    .trim()
}

export class YtmRadioClient {
  private readonly bin: string
  private readonly timeoutMs: number
  private readonly limit: number
  private readonly run: NonNullable<YtmRadioOptions['runner']>

  constructor(opts: YtmRadioOptions = {}) {
    this.bin = opts.ytDlpPath ?? 'yt-dlp'
    this.timeoutMs = opts.timeoutMs ?? 90_000
    this.limit = opts.limit ?? 25
    this.run = opts.runner ?? defaultRunner
  }

  /**
   * Fetch the radio sequence seeded on one video id.
   *
   * `RD<videoId>` is YouTube's own radio playlist id for that track — the same list the
   * "start radio" button produces.
   */
  async radioFor(videoId: string): Promise<RadioEntry[]> {
    const url = `https://music.youtube.com/watch?v=${videoId}&list=RD${videoId}`
    let result
    try {
      result = await this.run(
        this.bin,
        [
          url,
          '--flat-playlist',
          '--dump-json',
          '--no-warnings',
          '--quiet',
          '--playlist-end',
          String(this.limit),
        ],
        this.timeoutMs,
      )
    } catch {
      return []
    }
    if (result.code !== 0) return []

    const entries: RadioEntry[] = []
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue
      let parsed: FlatEntry
      try {
        parsed = JSON.parse(line) as FlatEntry
      } catch {
        continue
      }
      if (!parsed.id) continue
      entries.push({
        videoId: parsed.id,
        title: parsed.title ?? '',
        artist: cleanArtistName(parsed.artist ?? parsed.channel ?? parsed.uploader),
        position: entries.length,
      })
    }
    return entries
  }

  /**
   * Find a video id for a track so a radio can be seeded from it.
   *
   * Deliberately narrow: one result, matched by artist and title. Getting this wrong
   * seeds a radio for the wrong song and quietly poisons the similarity graph, which is
   * much harder to notice than a wrong download.
   */
  async resolveSeed(artist: string, title: string): Promise<string | null> {
    let result
    try {
      result = await this.run(
        this.bin,
        [
          `ytsearch1:${artist} ${title}`,
          '--flat-playlist',
          '--dump-json',
          '--no-warnings',
          '--quiet',
          '--extractor-args',
          'youtube:player_client=web_music',
        ],
        this.timeoutMs,
      )
    } catch {
      return null
    }
    if (result.code !== 0) return null

    const line = result.stdout.split('\n').find((l) => l.trim())
    if (!line) return null
    try {
      return (JSON.parse(line) as FlatEntry).id ?? null
    } catch {
      return null
    }
  }
}

export interface RadioEdge {
  from: string
  to: string
  weight: number
}

/**
 * Turn one radio sequence into weighted artist edges.
 *
 * Two contributions, and both matter:
 *
 *  - **seed → entry**, weighted by position. YTM orders its radios closest-first, so an
 *    artist at position 2 is a much stronger signal than one at position 22.
 *  - **entry ↔ entry**, at a lower weight, for pairs appearing near each other in the
 *    sequence. This is the co-occurrence the brief asks for, and it is what lets the
 *    graph learn relationships that never touch the listener's own library.
 */
export function edgesFromRadio(
  seedArtist: string,
  entries: RadioEntry[],
  opts: { neighbourWindow?: number } = {},
): RadioEdge[] {
  const window = opts.neighbourWindow ?? 3
  const edges: RadioEdge[] = []
  const seen = entries.filter((e) => e.artist && e.artist !== seedArtist)

  for (const entry of seen) {
    // Reciprocal decay: position 0 → 1.0, position 10 → ~0.29, position 24 → ~0.14.
    edges.push({
      from: seedArtist,
      to: entry.artist,
      weight: Number((1 / (1 + entry.position * 0.25)).toFixed(4)),
    })
  }

  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < Math.min(seen.length, i + 1 + window); j++) {
      const a = seen[i]!
      const b = seen[j]!
      if (a.artist === b.artist) continue
      edges.push({ from: a.artist, to: b.artist, weight: Number((0.4 / (j - i)).toFixed(4)) })
    }
  }

  return edges
}
