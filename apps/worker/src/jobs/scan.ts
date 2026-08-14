/**
 * Library scanner — PROMPT.md §7.4, phase 2.
 *
 * Walks MUSIC_ROOT, reads tags with music-metadata, falls back to ffprobe when tags are
 * unreliable, and hashes the AUDIO STREAM rather than the file so a retagged file is
 * not seen as new.
 *
 * Fingerprinting and the AcoustID→MusicBrainz→ISRC backfill run in a separate,
 * lower-priority queue. That backfill was promoted from "optional" to a phase-2
 * deliverable (plan.md §1.3, DECISIONS D3): most of the owner's existing files carry no
 * ISRC, so without it the matching cascade's tier 1 misses on music they already own
 * and the phase-3 coverage report understates the library badly.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { normalizeTrack, qualityScore } from '@crate/core'
import { prisma } from '@crate/db'
import { parseFile } from 'music-metadata'
import type { JobRunContext } from '../lib/jobrun.js'
import { enqueue, jobId } from '../lib/queues.js'
import { loadSettings } from '../lib/settings.js'

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.aiff', '.aif', '.wma', '.alac', '.ape', '.wv',
])

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '@eaDir', '.stfolder', 'lost+found'])

export async function* walkAudioFiles(root: string): AsyncGenerator<string> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable directory: skip rather than abort the scan
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) yield full
    }
  }
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
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
 * Hash the decoded AUDIO STREAM, not the container (§7.4). This is what makes retagging
 * invisible to the scanner and what lets dedupe pass 1 be certain rather than probable.
 */
export async function hashAudioStream(path: string): Promise<string | null> {
  try {
    const { code, stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a', '-f', 'md5', '-'], 120_000)
    if (code !== 0) return null
    const match = /MD5=([0-9a-f]+)/i.exec(stdout)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export async function ffprobeDuration(path: string): Promise<number | null> {
  try {
    const { code, stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path,
    ])
    if (code !== 0) return null
    const seconds = Number(stdout.trim())
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
  } catch {
    return null
  }
}

export async function computeFingerprint(
  path: string,
): Promise<{ fingerprint: string; durationSec: number } | null> {
  try {
    const { code, stdout } = await run('fpcalc', ['-json', path], 120_000)
    if (code !== 0) return null
    const parsed = JSON.parse(stdout) as { fingerprint?: string; duration?: number }
    if (!parsed.fingerprint || parsed.duration === undefined) return null
    return { fingerprint: parsed.fingerprint, durationSec: parsed.duration }
  } catch {
    return null
  }
}

export interface ScannedFile {
  path: string
  format: string
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
  channels?: number
  sizeBytes: bigint
  durationMs?: number
  mtime: Date
  tags: Record<string, unknown>
  hasEmbeddedArt: boolean
  title: string
  artist: string
  albumArtist?: string
  album?: string
  isrc?: string
  mbid?: string
  year?: number
}

/** Read one file's metadata. Falls back to the filename when tags are absent. */
export async function readFileMetadata(path: string): Promise<ScannedFile | null> {
  const info = await stat(path).catch(() => null)
  if (!info) return null

  let meta
  try {
    meta = await parseFile(path, { duration: false })
  } catch {
    return null // not decodable as audio
  }

  const common = meta.common
  const format = meta.format

  // Tags can be unreliable or absent; ffprobe is the fallback (§7.4).
  let durationMs = format.duration ? Math.round(format.duration * 1000) : undefined
  if (!durationMs) {
    const probed = await ffprobeDuration(path)
    if (probed) durationMs = probed
  }

  const isrc = Array.isArray(common.isrc) ? common.isrc[0] : undefined
  const mbid = common.musicbrainz_recordingid
    ? String(Array.isArray(common.musicbrainz_recordingid) ? common.musicbrainz_recordingid[0] : common.musicbrainz_recordingid)
    : undefined

  const tags: Record<string, unknown> = {
    title: common.title,
    artist: common.artist,
    albumartist: common.albumartist,
    album: common.album,
    date: common.date ?? common.year,
    track: common.track?.no,
    disc: common.disk?.no,
    genre: common.genre?.[0],
    isrc,
    musicbrainz_trackid: mbid,
  }

  // A file with no title tag still belongs in the library — use the filename.
  const fallbackTitle = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Unknown'

  return {
    path,
    format: (extname(path).slice(1) || format.container || 'unknown').toLowerCase(),
    ...(format.bitrate ? { bitrate: Math.round(format.bitrate) } : {}),
    ...(format.sampleRate ? { sampleRate: format.sampleRate } : {}),
    ...(format.bitsPerSample ? { bitDepth: format.bitsPerSample } : {}),
    ...(format.numberOfChannels ? { channels: format.numberOfChannels } : {}),
    sizeBytes: BigInt(info.size),
    ...(durationMs ? { durationMs } : {}),
    mtime: info.mtime,
    tags,
    hasEmbeddedArt: (common.picture?.length ?? 0) > 0,
    title: common.title ?? fallbackTitle,
    artist: common.artist ?? common.albumartist ?? '',
    ...(common.albumartist ? { albumArtist: common.albumartist } : {}),
    ...(common.album ? { album: common.album } : {}),
    ...(isrc ? { isrc } : {}),
    ...(mbid ? { mbid } : {}),
    ...(common.year ? { year: common.year } : {}),
  }
}

/**
 * Upsert a scanned file and attach it to a canonical LibraryTrack.
 *
 * Track identity resolution order mirrors the matching cascade: ISRC, then MBID, then
 * normalized artist+title. Two files of the same recording therefore share one
 * LibraryTrack, which is what makes dedupe and playlist resolution work.
 */
export async function registerFile(file: ScannedFile, contentHash: string | null): Promise<string> {
  const norm = normalizeTrack({ title: file.title, artists: file.artist })
  const normTitle = norm.title.norm
  const normArtist = norm.artist.normAll

  let track = null
  if (file.isrc) {
    track = await prisma.libraryTrack.findFirst({ where: { isrc: file.isrc } })
  }
  if (!track && file.mbid) {
    track = await prisma.libraryTrack.findFirst({ where: { mbid: file.mbid } })
  }
  if (!track) {
    track = await prisma.libraryTrack.findFirst({ where: { normTitle, normArtist } })
  }

  if (!track) {
    track = await prisma.libraryTrack.create({
      data: {
        title: file.title,
        artist: file.artist,
        albumArtist: file.albumArtist ?? null,
        album: file.album ?? null,
        durationMs: file.durationMs ?? null,
        isrc: file.isrc ?? null,
        mbid: file.mbid ?? null,
        normTitle,
        normArtist,
      },
    })
  } else if ((file.isrc && !track.isrc) || (file.mbid && !track.mbid)) {
    // Opportunistically enrich an existing track with better identifiers.
    track = await prisma.libraryTrack.update({
      where: { id: track.id },
      data: {
        ...(file.isrc && !track.isrc ? { isrc: file.isrc } : {}),
        ...(file.mbid && !track.mbid ? { mbid: file.mbid } : {}),
      },
    })
  }

  const score = qualityScore({
    format: file.format,
    bitrate: file.bitrate ?? null,
    sampleRate: file.sampleRate ?? null,
    bitDepth: file.bitDepth ?? null,
    tags: file.tags,
    hasEmbeddedArt: file.hasEmbeddedArt,
  })

  const data = {
    trackId: track.id,
    format: file.format,
    bitrate: file.bitrate ?? null,
    sampleRate: file.sampleRate ?? null,
    bitDepth: file.bitDepth ?? null,
    channels: file.channels ?? null,
    sizeBytes: file.sizeBytes,
    durationMs: file.durationMs ?? null,
    mtime: file.mtime,
    contentHash,
    tagsJson: file.tags as object,
    qualityScore: score,
    missingSince: null,
    scannedAt: new Date(),
  }

  const row = await prisma.libraryFile.upsert({
    where: { path: file.path },
    create: { path: file.path, ...data },
    update: data,
  })
  return row.id
}

export async function runLibraryScan(
  ctx: JobRunContext,
  opts: { full?: boolean } = {},
): Promise<{ scanned: number; added: number; unchanged: number; missing: number }> {
  const settings = await loadSettings()
  const root = process.env.MUSIC_ROOT ?? settings.musicRoot

  await ctx.log('info', `Scanning ${root}`, { full: opts.full ?? false })

  const existing = await prisma.libraryFile.findMany({
    select: { id: true, path: true, mtime: true, sizeBytes: true },
  })
  const byPath = new Map(existing.map((f) => [f.path, f]))
  const seen = new Set<string>()

  let scanned = 0
  let added = 0
  let unchanged = 0

  for await (const path of walkAudioFiles(root)) {
    seen.add(path)
    scanned += 1

    const prior = byPath.get(path)
    if (prior && !opts.full) {
      const info = await stat(path).catch(() => null)
      // Unchanged mtime AND size — cheap check that avoids re-reading tags.
      if (info && info.mtime.getTime() === prior.mtime.getTime() && BigInt(info.size) === prior.sizeBytes) {
        unchanged += 1
        if (scanned % 200 === 0) await ctx.setProgress(scanned, undefined, `${scanned} files`)
        continue
      }
    }

    const meta = await readFileMetadata(path)
    if (!meta) {
      await ctx.log('warn', `Could not read metadata, skipping`, { path })
      continue
    }

    const contentHash = await hashAudioStream(path)
    const fileId = await registerFile(meta, contentHash)
    added += 1

    if (settings.fingerprintEnabled) {
      // Separate low-priority queue: fingerprinting is CPU-heavy and must not starve
      // the box during a scan (§7.4).
      await enqueue('fingerprint', 'fingerprint-file', { fileId, path }, { jobId: jobId("fp", fileId) })
    }

    if (scanned % 50 === 0) await ctx.setProgress(scanned, undefined, `${scanned} files, ${added} new or changed`)
  }

  // Files no longer on disk are MARKED, not deleted — a missing mount would otherwise
  // wipe the library, and that is not recoverable from the DB alone.
  const goneIds = existing.filter((f) => !seen.has(f.path)).map((f) => f.id)
  if (goneIds.length > 0) {
    await prisma.libraryFile.updateMany({
      where: { id: { in: goneIds }, missingSince: null },
      data: { missingSince: new Date() },
    })
    await ctx.log('warn', `${goneIds.length} files are no longer on disk and have been marked missing (not deleted)`)
  }

  await ctx.log('info', 'Scan complete', { scanned, added, unchanged, missing: goneIds.length })

  // New library state means previously-missing matches may now resolve (§7.10).
  await enqueue('match', 'match-sweep', {}, { jobId: jobId("sweep", Date.now()) })

  return { scanned, added, unchanged, missing: goneIds.length }
}
