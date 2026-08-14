/**
 * Audio tooling — the ffmpeg/ffprobe/fpcalc surface, in one place.
 *
 * These are runtime dependencies of the postprocess and fingerprint queues (CLAUDE.md
 * "Audio tooling"): a worker image without them fails at job time, not at boot, which is
 * a bad failure. `toolingHealth()` exists so the UI can report the truth up front.
 *
 * Everything here shells out. Nothing here touches the database — callers decide what to
 * record. The rules encoded:
 *
 *  - `hashAudioStream` hashes the DECODED AUDIO, not the file, so retagging a file does
 *    not make it look like a new one.
 *  - `verifyAudio` decodes the whole file rather than trusting the header. A truncated
 *    download has a perfectly plausible header and reports a plausible duration; the
 *    only way to catch it is to decode it.
 *  - Tag writes never re-encode (`-c copy`). Step 3 of §7.6 is a metadata operation and
 *    a re-encode there would quietly degrade every file we touch.
 */

import { spawn } from 'node:child_process'
import { rename, unlink } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
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

// ─────────────────────────────────────────────────────────────
// Probing
// ─────────────────────────────────────────────────────────────

export interface AudioProbe {
  durationMs: number | null
  codec: string | null
  format: string | null
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  bitDepth: number | null
  hasAudioStream: boolean
  hasVideoStream: boolean
  /** An attached cover image reads as a video stream with `disposition.attached_pic`. */
  hasEmbeddedArt: boolean
  tags: Record<string, string>
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  sample_rate?: string
  channels?: number
  bits_per_raw_sample?: string
  bits_per_sample?: number
  bit_rate?: string
  disposition?: Record<string, number>
  /** Vorbis comments (ogg/opus) land here rather than on the format. */
  tags?: Record<string, string>
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: {
    duration?: string
    bit_rate?: string
    format_name?: string
    tags?: Record<string, string>
  }
}

export async function probeAudio(path: string): Promise<AudioProbe | null> {
  let result: RunResult
  try {
    result = await run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { timeoutMs: 60_000 },
    )
  } catch {
    return null
  }
  if (result.code !== 0) return null

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(result.stdout) as FfprobeOutput
  } catch {
    return null
  }

  const streams = parsed.streams ?? []
  const audio = streams.find((s) => s.codec_type === 'audio')
  const video = streams.filter((s) => s.codec_type === 'video')
  const seconds = Number(parsed.format?.duration)
  const bitrate = Number(audio?.bit_rate ?? parsed.format?.bit_rate)

  // ffprobe reports bit depth in one of two fields depending on the codec.
  const depth = Number(audio?.bits_per_raw_sample ?? audio?.bits_per_sample ?? 0)

  // Where the tags live depends on the container, and getting this wrong is silent.
  //
  // ID3 and MP4 atoms are container-level, so ffprobe reports them under `format.tags`.
  // Vorbis comments — which is what Ogg and Opus use — are STREAM-level, and appear
  // under the audio stream instead. Reading only `format.tags` therefore reports an
  // Opus file as completely untagged even when it is fully tagged, which is exactly the
  // format the YouTube Music provider produces. Both are merged, with container-level
  // winning, and keys are lowercased because case differs across all three.
  const tags: Record<string, string> = {}
  for (const [k, v] of Object.entries(audio?.tags ?? {})) tags[k.toLowerCase()] = v
  for (const [k, v] of Object.entries(parsed.format?.tags ?? {})) tags[k.toLowerCase()] = v

  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    codec: audio?.codec_name ?? null,
    format: parsed.format?.format_name ?? null,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    bitDepth: Number.isFinite(depth) && depth > 0 ? depth : null,
    hasAudioStream: audio !== undefined,
    hasVideoStream: video.length > 0,
    hasEmbeddedArt: video.some((s) => (s.disposition?.attached_pic ?? 0) === 1),
    tags,
  }
}

/** Duration only — the cheap path used by the scanner when tags are unreliable. */
export async function ffprobeDuration(path: string): Promise<number | null> {
  try {
    const { code, stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path,
    ])
    if (code !== 0) return null
    const seconds = Number(stdout.trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
  } catch {
    return null
  }
}

/**
 * Hash the DECODED AUDIO STREAM, not the container (§7.4). This is what makes retagging
 * invisible to the scanner and dedupe pass 1 certain rather than probable.
 */
export async function hashAudioStream(path: string): Promise<string | null> {
  try {
    const { code, stdout } = await run(
      'ffmpeg',
      ['-v', 'error', '-i', path, '-map', '0:a', '-f', 'md5', '-'],
      { timeoutMs: 180_000 },
    )
    if (code !== 0) return null
    const match = /MD5=([0-9a-f]+)/i.exec(stdout)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export async function computeFingerprint(
  path: string,
): Promise<{ fingerprint: string; durationSec: number } | null> {
  try {
    const { code, stdout } = await run('fpcalc', ['-json', path], { timeoutMs: 180_000 })
    if (code !== 0) return null
    const parsed = JSON.parse(stdout) as { fingerprint?: string; duration?: number }
    if (!parsed.fingerprint || parsed.duration === undefined) return null
    return { fingerprint: parsed.fingerprint, durationSec: parsed.duration }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Verification — §7.6 step 1
// ─────────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** Source duration to check against, when we know it. */
  expectedMs?: number | null
  /** ±ms tolerance against `expectedMs`. */
  toleranceMs?: number
  /** Anything shorter than this is a stub, a preview, or an error page. */
  minDurationMs?: number
  /** Mean volume at or below this reads as silence. */
  silenceThresholdDb?: number
  /** Full decode catches truncation. Off only for very large batch re-verification. */
  fullDecode?: boolean
}

export interface VerifyResult {
  ok: boolean
  /** Machine-readable reason for the first failed check, for the attempt log. */
  reason?:
    | 'UNREADABLE'
    | 'NO_AUDIO_STREAM'
    | 'NO_DURATION'
    | 'TOO_SHORT'
    | 'DURATION_MISMATCH'
    | 'SILENT'
    | 'TRUNCATED'
  detail?: string
  probe?: AudioProbe
  meanVolumeDb?: number | null
}

const VERIFY_DEFAULTS = {
  toleranceMs: 8000,
  minDurationMs: 20_000,
  silenceThresholdDb: -60,
  fullDecode: true,
} as const

/** Mean volume over the whole file, via ffmpeg's volumedetect filter. */
export async function meanVolumeDb(path: string): Promise<number | null> {
  try {
    const { stderr } = await run(
      'ffmpeg',
      ['-v', 'info', '-i', path, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'],
      { timeoutMs: 180_000 },
    )
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr)
    return match?.[1] ? Number(match[1]) : null
  } catch {
    return null
  }
}

/**
 * "Real audio, expected duration, not silent, not truncated" (§7.6 step 1).
 *
 * The duration check is deliberately looser than the matcher's: providers legitimately
 * differ from Spotify's stated length by a few seconds (fades, gapless trims, different
 * masters). A hard reject here would bounce good files. The *candidate scorer* is where
 * the tight ±5s duration rule lives, because that is a choice between options; this is a
 * last gate on something already chosen, and its job is to catch garbage, not to
 * second-guess the scoring.
 */
export async function verifyAudio(path: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const cfg = { ...VERIFY_DEFAULTS, ...opts }

  const probe = await probeAudio(path)
  if (!probe) return { ok: false, reason: 'UNREADABLE', detail: 'ffprobe could not read the file' }
  if (!probe.hasAudioStream) {
    return { ok: false, reason: 'NO_AUDIO_STREAM', detail: 'the file contains no audio stream', probe }
  }
  if (probe.durationMs === null) {
    return { ok: false, reason: 'NO_DURATION', detail: 'no decodable duration', probe }
  }
  if (probe.durationMs < cfg.minDurationMs) {
    return {
      ok: false,
      reason: 'TOO_SHORT',
      detail: `${Math.round(probe.durationMs / 1000)}s is below the ${Math.round(cfg.minDurationMs / 1000)}s floor — usually a preview or an error page`,
      probe,
    }
  }
  if (opts.expectedMs) {
    const delta = Math.abs(probe.durationMs - opts.expectedMs)
    if (delta > cfg.toleranceMs) {
      return {
        ok: false,
        reason: 'DURATION_MISMATCH',
        detail: `${Math.round(probe.durationMs / 1000)}s against an expected ${Math.round(opts.expectedMs / 1000)}s (off by ${Math.round(delta / 1000)}s)`,
        probe,
      }
    }
  }

  const volume = await meanVolumeDb(path)
  if (volume !== null && volume <= cfg.silenceThresholdDb) {
    return {
      ok: false,
      reason: 'SILENT',
      detail: `mean volume ${volume} dB — the file decodes but contains no sound`,
      probe,
      meanVolumeDb: volume,
    }
  }

  if (cfg.fullDecode) {
    const decode = await decodeFully(path)
    if (!decode.clean) {
      return {
        ok: false,
        reason: 'TRUNCATED',
        detail: decode.detail,
        probe,
        meanVolumeDb: volume,
      }
    }
    // Header says 45s, decoder produced 22s: the file is cut short. This is the check
    // that actually catches a truncated download, because the container header is
    // written up front and keeps claiming the full length after the bytes stop.
    if (probe.durationMs - decode.decodedMs > 2000) {
      return {
        ok: false,
        reason: 'TRUNCATED',
        detail: `the header claims ${Math.round(probe.durationMs / 1000)}s but only ${Math.round(decode.decodedMs / 1000)}s decoded`,
        probe,
        meanVolumeDb: volume,
      }
    }
  }

  return { ok: true, probe, meanVolumeDb: volume }
}

/**
 * Decode the whole file, discarding the output, and report what happened.
 *
 * Two signals, because neither is sufficient alone and the failure mode being caught —
 * a truncated download that looks perfectly healthy — is one of the most damaging
 * things that can reach the library:
 *
 *  - **Any stderr at `-v error`.** A clean decode is completely silent at this level, so
 *    a single line means the decoder hit something it did not like. Exit status is NOT
 *    usable here: ffmpeg 6.1 prints "invalid residual / decode_frame() failed" for a
 *    half-truncated FLAC and still exits 0, even with `-xerror`. Verified by cutting a
 *    file in half and running it; trusting the exit code let it through.
 *  - **How much actually decoded**, read from `-progress`. Some containers truncate
 *    without upsetting the decoder at all — the audio simply stops — and only the
 *    decoded length gives that away.
 */
async function decodeFully(
  path: string,
): Promise<{ clean: boolean; decodedMs: number; detail: string }> {
  const { stdout, stderr } = await run(
    'ffmpeg',
    [
      '-v', 'error',
      '-nostats',
      '-i', path,
      '-map', '0:a',
      '-f', 'null',
      '-progress', 'pipe:1',
      '-',
    ],
    { timeoutMs: 300_000 },
  )

  // The last out_time_us in the progress stream is how far the decoder actually got.
  let decodedMs = 0
  for (const match of stdout.matchAll(/out_time_us=(\d+)/g)) {
    decodedMs = Math.max(decodedMs, Math.round(Number(match[1]) / 1000))
  }

  const errors = stderr.trim()
  if (errors.length > 0) {
    return {
      clean: false,
      decodedMs,
      detail: `decode errors: ${errors.split('\n').slice(0, 2).join(' ').slice(0, 300)}`,
    }
  }
  return { clean: true, decodedMs, detail: '' }
}

// ─────────────────────────────────────────────────────────────
// Tagging — §7.6 step 3
// ─────────────────────────────────────────────────────────────

export interface AudioTags {
  title?: string | null
  artist?: string | null
  albumartist?: string | null
  album?: string | null
  date?: string | number | null
  track?: string | number | null
  disc?: string | number | null
  genre?: string | null
  isrc?: string | null
  musicbrainz_trackid?: string | null
  /** Which provider this came from. Ours, not a standard — §7.6 asks for it by name. */
  CRATE_SOURCE?: string | null
}

/**
 * ffmpeg cannot edit metadata in place, so this writes a sibling temp file and renames
 * over the original. `-c copy` means no re-encode: the audio bytes are untouched, which
 * is why `contentHash` survives a retag.
 *
 * Vorbis-family containers (ogg/opus) use their own comment names for a few fields;
 * ffmpeg maps the common ones but not ISRC or custom keys reliably, so those go through
 * `-metadata` verbatim and are read back the same way.
 */
export async function writeTags(path: string, tags: AudioTags): Promise<void> {
  const ext = extname(path)
  const tmp = join(dirname(path), `.crate-tag-${process.pid}-${Date.now()}${ext}`)

  const args = ['-v', 'error', '-y', '-i', path, '-map', '0', '-c', 'copy']

  // Clear inherited junk (encoder comments, uploader fields from yt-dlp) before writing
  // our own, so what lands is exactly what we intended.
  args.push('-map_metadata', '-1')

  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null || String(value).trim() === '') continue
    args.push('-metadata', `${key}=${String(value)}`)
  }

  // MP3 needs ID3v2.3 for maximum compatibility with older scanners; Navidrome reads
  // either, but Windows Explorer and some phones only read 2.3.
  if (ext.toLowerCase() === '.mp3') args.push('-id3v2_version', '3')

  args.push(tmp)

  const { code, stderr } = await run('ffmpeg', args, { timeoutMs: 120_000 })
  if (code !== 0) {
    await unlink(tmp).catch(() => undefined)
    throw new Error(`tag write failed: ${stderr.trim().slice(-300)}`)
  }
  await rename(tmp, path)
}

// ─────────────────────────────────────────────────────────────
// Cover art — §7.6 step 4
// ─────────────────────────────────────────────────────────────

/** Containers ffmpeg can carry an attached picture in. */
const ART_CAPABLE = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aiff', '.aif'])

export function canEmbedArt(path: string): boolean {
  return ART_CAPABLE.has(extname(path).toLowerCase())
}

/**
 * Embed a cover image. Returns false — without throwing — when the container cannot
 * hold one.
 *
 * Ogg/Opus is the case that matters here, because the YouTube Music provider produces
 * Opus. Cover art in Ogg is a base64 METADATA_BLOCK_PICTURE comment, which ffmpeg does
 * not write. Rather than pretend, the caller drops a `cover.jpg` in the album folder,
 * which is what Navidrome falls back to anyway.
 */
export async function embedCoverArt(path: string, imagePath: string): Promise<boolean> {
  if (!canEmbedArt(path)) return false

  const ext = extname(path)
  const tmp = join(dirname(path), `.crate-art-${process.pid}-${Date.now()}${ext}`)

  const args = [
    '-v', 'error', '-y',
    '-i', path,
    '-i', imagePath,
    '-map', '0:a',
    '-map', '1:v',
    '-c', 'copy',
    '-map_metadata', '0',
    '-disposition:v:0', 'attached_pic',
    // Some players only recognise the picture when it is typed and described.
    '-metadata:s:v', 'title=Album cover',
    '-metadata:s:v', 'comment=Cover (front)',
  ]
  if (ext.toLowerCase() === '.mp3') args.push('-id3v2_version', '3')
  args.push(tmp)

  const { code } = await run('ffmpeg', args, { timeoutMs: 120_000 })
  if (code !== 0) {
    await unlink(tmp).catch(() => undefined)
    return false
  }
  await rename(tmp, path)
  return true
}

// ─────────────────────────────────────────────────────────────
// Transcode policy — §7.6 step 2
// ─────────────────────────────────────────────────────────────

export const LOSSLESS_CODECS = new Set(['flac', 'alac', 'pcm_s16le', 'pcm_s24le', 'wavpack', 'ape', 'tta'])

export interface TranscodeDecision {
  transcode: boolean
  targetExt?: string
  reason: string
}

/**
 * "Never re-encode a lossless source. Optionally normalize container/format for lossy
 * sources; default off." (§7.6 step 2)
 *
 * The lossless guard is absolute and deliberately not configurable: a lossy re-encode of
 * a lossless file is unrecoverable, and no setting is worth that.
 */
export function decideTranscode(
  probe: AudioProbe,
  policy: { normalizeLossy: boolean; targetFormat: string },
): TranscodeDecision {
  const codec = (probe.codec ?? '').toLowerCase()

  if (LOSSLESS_CODECS.has(codec)) {
    return { transcode: false, reason: `${codec} is lossless — never re-encoded` }
  }
  if (!policy.normalizeLossy) {
    return { transcode: false, reason: 'lossy normalization is off (the default)' }
  }
  const target = policy.targetFormat.toLowerCase().replace(/^\./, '')
  if (codec === target || (target === 'mp3' && codec === 'mp3')) {
    return { transcode: false, reason: `already ${target}` }
  }
  return {
    transcode: true,
    targetExt: `.${target}`,
    // Worth saying out loud in the log: this is a second lossy generation.
    reason: `normalizing ${codec} to ${target} (a lossy-to-lossy re-encode, as configured)`,
  }
}

export async function transcode(
  path: string,
  targetExt: string,
  quality: { bitrateKbps?: number } = {},
): Promise<string> {
  const target = path.replace(/\.[^.]+$/, '') + targetExt
  const codecArgs =
    targetExt === '.mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', `${quality.bitrateKbps ?? 320}k`]
      : targetExt === '.opus'
        ? ['-c:a', 'libopus', '-b:a', `${quality.bitrateKbps ?? 192}k`]
        : targetExt === '.flac'
          ? ['-c:a', 'flac']
          : ['-c:a', 'aac', '-b:a', `${quality.bitrateKbps ?? 256}k`]

  const { code, stderr } = await run(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', path, '-map', '0:a', ...codecArgs, target],
    { timeoutMs: 600_000 },
  )
  if (code !== 0) throw new Error(`transcode failed: ${stderr.trim().slice(-300)}`)
  if (target !== path) await unlink(path).catch(() => undefined)
  return target
}

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────

export interface ToolStatus {
  name: string
  ok: boolean
  version?: string
  detail?: string
}

/**
 * Report which binaries are actually present. The postprocess and fingerprint queues are
 * useless without these, and finding out at job time is worse than being told up front.
 */
export async function toolingHealth(): Promise<ToolStatus[]> {
  const checks: Array<[string, string[]]> = [
    ['ffmpeg', ['-version']],
    ['ffprobe', ['-version']],
    ['fpcalc', ['-version']],
    ['yt-dlp', ['--version']],
  ]

  return Promise.all(
    checks.map(async ([name, args]) => {
      try {
        const { code, stdout } = await run(name, args, { timeoutMs: 15_000 })
        if (code !== 0) return { name, ok: false, detail: `exited ${code}` }
        return { name, ok: true, version: stdout.split('\n')[0]?.trim().slice(0, 80) ?? '' }
      } catch (err) {
        return {
          name,
          ok: false,
          detail: /ENOENT/.test(String(err)) ? 'not installed in this container' : String(err),
        }
      }
    }),
  )
}
