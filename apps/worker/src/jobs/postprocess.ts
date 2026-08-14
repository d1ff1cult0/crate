/**
 * Post-processing — PROMPT.md §7.6, phase 4.
 *
 * "Every download runs this chain before it's allowed into the library."
 *
 *   1. Verify        ffprobe: real audio, expected duration, not silent, not truncated
 *   2. Transcode     never re-encode lossless; normalize lossy only if asked
 *   3. Tag           incl. ISRC, MBID and CRATE_SOURCE — this closes the matching loop
 *   4. Cover art     embed if missing, from Spotify metadata / CAA / Deezer
 *   5. Placement     configurable template, non-ASCII-safe sanitizer
 *   6. Dedupe check  fingerprint, then the §7.7 keeper rule instead of a second copy
 *   7. Register      DB row, then ONE debounced Navidrome scan for the whole burst
 *
 * The ordering is load-bearing. Verification happens on the staged file before anything
 * else touches it, so a bad download never reaches `MUSIC_ROOT` — a wrong track landing
 * in the library is the most damaging failure this app has, and the cheapest place to
 * stop it is before it is moved.
 *
 * Step 3 is the one that pays off later: writing the harvested ISRC into the file means
 * the next match against this recording hits tier 1 of the cascade instead of falling
 * through to fuzzy. Every download makes the library more matchable.
 */

import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { qualityScore, renderPlacement, selectKeeper } from '@crate/core'
import { prisma } from '@crate/db'
import { downloadCoverArt, findCoverArt } from '@crate/integrations'
import { z } from 'zod'
import {
  canEmbedArt,
  computeFingerprint,
  decideTranscode,
  embedCoverArt,
  fingerprintDigest,
  hashAudioStream,
  probeAudio,
  transcode,
  verifyAudio,
  writeTags,
  type AudioTags,
} from '../lib/audio.js'
import type { JobRunContext } from '../lib/jobrun.js'
import { requestNavidromeScan } from '../lib/navidrome.js'
import { enqueue, jobId } from '../lib/queues.js'
import { loadSettings } from '../lib/settings.js'
import { moveToTrash, trashDestination } from '../lib/trash.js'
import { readFileMetadata, registerFile } from './scan.js'

export interface PostprocessInput {
  requestId: string
  stagedPath: string
  provider: string
}

export interface PostprocessResult {
  ok: boolean
  /** Set when verification rejected the file; the caller falls through to the next provider. */
  rejected?: boolean
  reason?: string
  fileId?: string
  finalPath?: string
  /** True when an equal-or-better copy already existed and this download was discarded. */
  supersededByExisting?: boolean
}

/**
 * Track and disc numbers live in the persisted Spotify payload, not on our columns.
 * Parsed permissively — CLAUDE.md is explicit that unknown shapes must pass through
 * rather than throw.
 */
const SpotifyTrackNumbersSchema = z
  .object({
    track_number: z.number().optional(),
    disc_number: z.number().optional(),
    album: z
      .object({
        release_date: z.string().optional(),
        name: z.string().optional(),
        album_type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

function trackNumbersFrom(rawJson: unknown): { track?: number; disc?: number; releaseDate?: string } {
  const parsed = SpotifyTrackNumbersSchema.safeParse(rawJson)
  if (!parsed.success) return {}
  return {
    ...(parsed.data.track_number ? { track: parsed.data.track_number } : {}),
    ...(parsed.data.disc_number ? { disc: parsed.data.disc_number } : {}),
    ...(parsed.data.album?.release_date ? { releaseDate: parsed.data.album.release_date } : {}),
  }
}

/** Find a free path, appending " (2)", " (3)" … rather than overwriting anything. */
async function uniquePath(target: string): Promise<string> {
  const ext = extname(target)
  const base = target.slice(0, target.length - ext.length)
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? target : `${base} (${n})${ext}`
    const exists = await stat(candidate).then(
      () => true,
      () => false,
    )
    if (!exists) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/** Move across roots, falling back to copy when staging and music are separate mounts. */
async function moveInto(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    const { copyFile } = await import('node:fs/promises')
    await copyFile(from, to)
    await unlink(from)
  }
}

export async function runPostprocess(
  ctx: JobRunContext,
  input: PostprocessInput,
): Promise<PostprocessResult> {
  const settings = await loadSettings()
  const musicRoot = process.env.MUSIC_ROOT ?? settings.musicRoot
  const trashRoot = process.env.TRASH_ROOT ?? settings.trashRoot

  const request = await prisma.downloadRequest.findUnique({
    where: { id: input.requestId },
    include: { sourceTrack: true },
  })
  if (!request) {
    await ctx.log('warn', 'Download request no longer exists — discarding the staged file', {
      ...input,
    })
    await unlink(input.stagedPath).catch(() => undefined)
    return { ok: false, reason: 'request no longer exists' }
  }

  const source = request.sourceTrack
  const label = `${source.artists.join(', ')} - ${source.title}`
  await ctx.log('info', `Post-processing ${label}`, {
    provider: input.provider,
    staged: input.stagedPath,
  })

  // ── 1. Verify ────────────────────────────────────────────
  const verification = await verifyAudio(input.stagedPath, {
    expectedMs: source.durationMs,
    toleranceMs: settings.verifyDurationToleranceMs,
    minDurationMs: settings.verifyMinDurationMs,
    fullDecode: settings.verifyFullDecode,
  })

  if (!verification.ok) {
    await ctx.log('warn', `Verification rejected the file: ${verification.detail}`, {
      reason: verification.reason,
      provider: input.provider,
      track: label,
    })
    // The staged file is discarded outright. It never entered the library, so this is
    // not a trash-flow deletion — there is nothing to restore and nothing to review.
    await unlink(input.stagedPath).catch(() => undefined)

    await prisma.downloadAttempt.create({
      data: {
        requestId: request.id,
        provider: input.provider,
        query: label,
        outcome: 'REJECTED_VERIFY',
        detail: `${verification.reason}: ${verification.detail}`,
      },
    })

    return { ok: false, rejected: true, reason: `${verification.reason}: ${verification.detail}` }
  }

  const probe = verification.probe!
  await ctx.log('info', 'Verified', {
    durationMs: probe.durationMs,
    codec: probe.codec,
    bitrate: probe.bitrate,
    meanVolumeDb: verification.meanVolumeDb,
  })

  // ── 2. Transcode policy ──────────────────────────────────
  let workingPath = input.stagedPath
  const decision = decideTranscode(probe, {
    normalizeLossy: settings.transcodeNormalizeLossy,
    targetFormat: settings.transcodeTargetFormat,
  })
  if (decision.transcode && decision.targetExt) {
    await ctx.log('info', `Transcoding: ${decision.reason}`)
    workingPath = await transcode(workingPath, decision.targetExt, {
      bitrateKbps: settings.transcodeBitrateKbps,
    })
  } else {
    await ctx.log('debug', `No transcode: ${decision.reason}`)
  }

  // ── 3. Tag ───────────────────────────────────────────────
  const numbers = trackNumbersFrom(source.rawJson)
  const year =
    source.year ?? (numbers.releaseDate ? Number(numbers.releaseDate.slice(0, 4)) : null)

  const tags: AudioTags = {
    title: source.title,
    artist: source.artists.join('; '),
    albumartist: source.albumArtist ?? source.artists[0] ?? null,
    album: source.album,
    date: year,
    track: numbers.track ?? null,
    disc: numbers.disc ?? null,
    // The point of the whole exercise: the harvested ISRC goes into the file, so the
    // next match on this recording resolves at tier 1 instead of guessing.
    isrc: source.isrc,
    musicbrainz_trackid: source.mbid,
    CRATE_SOURCE: input.provider,
  }
  await writeTags(workingPath, tags)
  await ctx.log('info', 'Tagged', {
    isrc: source.isrc ?? '(none — the source had no ISRC)',
    mbid: source.mbid ?? '(none)',
    source: input.provider,
  })

  // ── 4. Cover art ─────────────────────────────────────────
  // Held until placement, when the album folder is known. Local, not module state: the
  // postprocess queue runs several jobs at once and a shared slot would cross the wires.
  let pendingFolderCover: string | null = null
  let artNote = 'skipped'
  if (settings.coverArtEnabled) {
    const afterTagProbe = await probeAudio(workingPath)
    if (afterTagProbe?.hasEmbeddedArt) {
      artNote = 'already embedded'
    } else {
      const found = await findCoverArt({
        title: source.title,
        artist: source.artists[0] ?? '',
        isrc: source.isrc,
        spotifyRaw: source.rawJson,
      })
      if (!found) {
        artNote = 'none found'
      } else {
        const image = await downloadCoverArt(found.url)
        if (!image) {
          artNote = `found via ${found.source} but the image would not download`
        } else {
          const tmpImage = join(dirname(workingPath), `.crate-cover-${process.pid}.jpg`)
          await writeFile(tmpImage, image.bytes)
          const embedded = await embedCoverArt(workingPath, tmpImage)
          // Ogg/Opus cannot carry an attached picture through ffmpeg. Rather than
          // pretend, the art lands as a folder cover, which Navidrome reads anyway.
          artNote = embedded
            ? `embedded from ${found.source}`
            : `saved as a folder cover (${extname(workingPath)} cannot embed art)`
          if (embedded) await unlink(tmpImage).catch(() => undefined)
          else pendingFolderCover = tmpImage
        }
      }
    }
  }
  await ctx.log('info', `Cover art: ${artNote}`)

  // ── 5. Placement ─────────────────────────────────────────
  const ext = extname(workingPath)
  const relativeTarget = renderPlacement(settings.placementTemplate, {
    albumartist: source.albumArtist ?? source.artists[0] ?? null,
    artist: source.artists.join(', '),
    album: source.album,
    year,
    disc: numbers.disc ?? null,
    // Placement renders disc and track together: with no track number the whole
    // "1-04 " prefix collapses rather than leaving a stray separator.
    track: numbers.track ?? null,
    title: source.title,
    ext: ext.replace(/^\./, ''),
  })

  const finalPath = await uniquePath(join(musicRoot, relativeTarget))
  await moveInto(workingPath, finalPath)
  await ctx.log('info', `Placed at ${finalPath}`)

  if (pendingFolderCover) {
    await moveInto(pendingFolderCover, join(dirname(finalPath), 'cover.jpg')).catch(() => undefined)
  }

  // ── 6. Fingerprint, then the dedupe check ────────────────
  const contentHash = await hashAudioStream(finalPath)
  const fingerprintResult = settings.fingerprintEnabled ? await computeFingerprint(finalPath) : null
  const fingerprint = fingerprintResult?.fingerprint ?? null

  const collision = await findCollision(finalPath, contentHash, fingerprint)
  if (collision) {
    const meta = await readFileMetadata(finalPath)
    const incomingScore = meta
      ? qualityScore({
          format: meta.format,
          bitrate: meta.bitrate ?? null,
          sampleRate: meta.sampleRate ?? null,
          bitDepth: meta.bitDepth ?? null,
          tags: meta.tags,
          hasEmbeddedArt: meta.hasEmbeddedArt,
          sourceProvider: input.provider,
        })
      : 0

    // §7.6 step 6: apply the keeper rule rather than blindly adding a second copy.
    const keeper = selectKeeper([
      {
        id: 'incoming',
        path: finalPath,
        mtime: new Date(),
        format: meta?.format ?? ext.replace(/^\./, ''),
        bitrate: meta?.bitrate ?? null,
        sampleRate: meta?.sampleRate ?? null,
        bitDepth: meta?.bitDepth ?? null,
        tags: meta?.tags ?? null,
        hasEmbeddedArt: meta?.hasEmbeddedArt ?? false,
        qualityScore: incomingScore,
      },
      {
        id: collision.id,
        path: collision.path,
        mtime: collision.mtime,
        format: collision.format,
        bitrate: collision.bitrate,
        sampleRate: collision.sampleRate,
        bitDepth: collision.bitDepth,
        tags: collision.tagsJson as Record<string, unknown>,
        hasEmbeddedArt: false,
        qualityScore: collision.qualityScore,
      },
    ])

    if (keeper?.id !== 'incoming') {
      // The copy we already own is at least as good. Discard the download — into the
      // trash, not deleted, so a wrong call here is recoverable.
      await ctx.log(
        'info',
        'An equal or better copy is already in the library — keeping the existing file',
        {
          existing: collision.path,
          existingScore: collision.qualityScore,
          incomingScore,
        },
      )
      await moveToTrash(
        [
          {
            fileId: collision.id, // manifest references the survivor for context
            from: finalPath,
            to: trashDestination(finalPath, musicRoot, trashRoot),
          },
        ],
        { reason: 'Superseded on arrival by an equal or better existing file', markFilesMissing: false },
      )

      await prisma.downloadRequest.update({
        where: { id: request.id },
        data: { status: 'SUCCEEDED', resultFileId: collision.id },
      })
      await linkMatch(request.sourceTrackId, collision.trackId, source.isrc)
      return {
        ok: true,
        supersededByExisting: true,
        fileId: collision.id,
        finalPath: collision.path,
      }
    }

    // The download is better. The existing file is NOT touched automatically — moving
    // something already in the library is the §7.7 flow, which is dry-run by default
    // and reviewed by hand (DECISIONS A13). A group is raised instead.
    await raiseDuplicateGroup(collision.id, finalPath, contentHash, fingerprint)
    await ctx.log(
      'info',
      'This download is better than the copy already in the library — raised a duplicate group for review rather than moving anything',
      { existing: collision.path },
    )
  }

  // ── 7. Register, then one debounced rescan ───────────────
  const meta = await readFileMetadata(finalPath)
  if (!meta) {
    await ctx.log('error', 'The placed file could not be read back — leaving it in place for inspection', {
      path: finalPath,
    })
    return { ok: false, reason: 'placed file unreadable', finalPath }
  }

  const fileId = await registerFile(meta, contentHash, {
    sourceProvider: input.provider,
    fingerprint,
  })

  const file = await prisma.libraryFile.findUnique({
    where: { id: fileId },
    select: { trackId: true },
  })
  await linkMatch(request.sourceTrackId, file?.trackId ?? null, source.isrc)

  await prisma.downloadRequest.update({
    where: { id: request.id },
    data: { status: 'SUCCEEDED', resultFileId: fileId, lastError: null },
  })

  // Playlists that were waiting on this track can now be filled in place.
  await enqueue('playlist-write', 'write-affected', { sourceTrackId: request.sourceTrackId }, {
    jobId: jobId('pl-affected', request.sourceTrackId),
  })

  // One scan for the whole burst, never one per file.
  await requestNavidromeScan()

  await ctx.log('info', `Done: ${label}`, { fileId, path: finalPath })
  return { ok: true, fileId, finalPath }
}

/**
 * An existing library file that is certainly the same recording — identical audio bytes
 * or an identical fingerprint. Deliberately only the two certain passes: the fuzzier
 * tiers of §7.7 belong in the reviewed dedupe flow, not in an automatic decision made
 * while a download lands.
 */
async function findCollision(
  excludePath: string,
  contentHash: string | null,
  fingerprint: string | null,
) {
  const or = []
  if (contentHash) or.push({ contentHash })
  // Matched on the indexed digest, not the fingerprint itself — the fingerprint is far
  // too large for a btree index and querying it directly would be a sequential scan of
  // the whole library on every download.
  if (fingerprint) or.push({ fingerprintHash: fingerprintDigest(fingerprint) })
  if (or.length === 0) return null

  return prisma.libraryFile.findFirst({
    where: { OR: or, missingSince: null, NOT: { path: excludePath } },
    orderBy: { qualityScore: 'desc' },
  })
}

async function raiseDuplicateGroup(
  existingFileId: string,
  incomingPath: string,
  contentHash: string | null,
  fingerprint: string | null,
): Promise<void> {
  const incoming = await prisma.libraryFile.findUnique({ where: { path: incomingPath } })
  if (!incoming) return // not registered yet on the first pass; the weekly scan will catch it

  const group = await prisma.duplicateGroup.create({
    data: {
      reason: contentHash && fingerprint ? 'FINGERPRINT' : 'HASH',
      confidence: contentHash ? 1 : 0.99,
      status: 'OPEN',
    },
  })
  await prisma.duplicateMember.createMany({
    data: [
      { groupId: group.id, fileId: incoming.id, isKeeper: true },
      { groupId: group.id, fileId: existingFileId, isKeeper: false },
    ],
    skipDuplicates: true,
  })
}

/**
 * Point the source track's match at the file that just landed.
 *
 * Confidence 1 without review, because identity here is by construction rather than by
 * inference: this file exists only because we went and fetched this specific recording,
 * and step 3 wrote the source's own ISRC into it. The recorded method reflects which of
 * those two is true — ISRC when we actually stamped one, EXACT_NORM when the source had
 * none to stamp, so a later audit can tell the difference.
 */
async function linkMatch(
  sourceTrackId: string,
  libraryTrackId: string | null,
  isrc: string | null,
): Promise<void> {
  if (!libraryTrackId) return
  const data = {
    libraryTrackId,
    method: isrc ? ('ISRC' as const) : ('EXACT_NORM' as const),
    confidence: 1,
    status: 'MATCHED' as const,
    detailJson: {
      via: 'download',
      note: 'downloaded to satisfy this exact source track',
      isrcWritten: isrc ?? null,
    },
  }
  await prisma.match.upsert({
    where: { sourceTrackId },
    create: { sourceTrackId, ...data },
    update: data,
  })
}
