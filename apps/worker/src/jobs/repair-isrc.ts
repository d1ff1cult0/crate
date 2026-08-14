/**
 * Split `LibraryTrack` rows that a junk ISRC merged together.
 *
 * `registerFile` resolves a file's track by ISRC first. Before `cleanIsrc` existed, any
 * file carrying a non-ISRC string in that tag matched every other file carrying the same
 * string, so unrelated songs collapsed into one track. Measured on the owner's library:
 * 14 values — `PMEDIA`, `P.M.E.D.I.A`, `WWW.iM1MUSIC.NET`, `SRC`, `www.viperial.com`,
 * `http:`, catalogue numbers, barcodes — absorbed **2,868 files that are really 2,805
 * distinct recordings**.
 *
 * The validation stops it happening again; it does not undo what already happened. This
 * does, by re-deriving each affected file's identity from its own tags exactly as a fresh
 * scan would, minus the bad ISRC.
 *
 * Non-destructive: no file is touched, no row is deleted. Files are re-pointed at correct
 * tracks and the emptied husks are removed. Re-runnable — a library with nothing wrong
 * reports zero and changes nothing.
 */

import { cleanIsrc, normalizeTrack } from '@crate/core'
import { prisma } from '@crate/db'
import type { JobRunContext } from '../lib/jobrun.js'

export interface RepairIsrcResult {
  tracksExamined: number
  badTracks: number
  filesReassigned: number
  tracksCreated: number
  emptyTracksRemoved: number
  isrcsCleared: number
}

export async function runRepairIsrc(
  ctx: JobRunContext,
  opts: { dryRun?: boolean } = {},
): Promise<RepairIsrcResult> {
  const dryRun = opts.dryRun === true

  // Every track claiming an ISRC, so each can be judged by the same rule the scanner now
  // applies. Cheap: only tracks WITH an isrc are candidates.
  const candidates = await prisma.libraryTrack.findMany({
    where: { isrc: { not: null } },
    select: { id: true, isrc: true, title: true, artist: true },
  })

  const bad = candidates.filter((t) => cleanIsrc(t.isrc) === null)

  await ctx.log('info', `Examined ${candidates.length} tracks with an ISRC`, {
    invalid: bad.length,
    dryRun,
  })
  if (bad.length === 0) {
    return {
      tracksExamined: candidates.length,
      badTracks: 0,
      filesReassigned: 0,
      tracksCreated: 0,
      emptyTracksRemoved: 0,
      isrcsCleared: 0,
    }
  }

  let filesReassigned = 0
  let tracksCreated = 0
  let emptyTracksRemoved = 0
  let isrcsCleared = 0

  for (const [index, track] of bad.entries()) {
    const files = await prisma.libraryFile.findMany({
      where: { trackId: track.id },
      select: { id: true, path: true, tagsJson: true, durationMs: true },
    })

    await ctx.log('info', `"${track.isrc}" merged ${files.length} file(s) under "${track.artist} — ${track.title}"`, {
      trackId: track.id,
    })
    if (dryRun) continue

    // The husk keeps whichever file matches its own title, so an existing track id stays
    // valid where it legitimately can — matches and playlist items pointing at it are not
    // invalidated for no reason.
    let keptOne = false

    for (const file of files) {
      const tags = (file.tagsJson ?? {}) as Record<string, unknown>
      const title = String(tags.title ?? '').trim() || fileNameTitle(file.path)
      const artist = String(tags.artist ?? tags.albumartist ?? '').trim() || track.artist

      const norm = normalizeTrack({ title, artists: artist })
      const normTitle = norm.title.norm
      const normArtist = norm.artist.normAll

      // This file genuinely belongs to the track it is already on.
      if (!keptOne && normTitle === normalizeTrack({ title: track.title, artists: track.artist }).title.norm) {
        keptOne = true
        continue
      }

      // Re-derive identity the way a fresh scan would: normalized artist + title only,
      // since the ISRC that got us here is worthless by definition.
      let target = await prisma.libraryTrack.findFirst({
        where: { normTitle, normArtist, id: { not: track.id } },
        select: { id: true },
      })

      if (!target) {
        target = await prisma.libraryTrack.create({
          data: {
            title,
            artist,
            album: String(tags.album ?? '') || null,
            albumArtist: String(tags.albumartist ?? '') || null,
            durationMs: file.durationMs,
            normTitle,
            normArtist,
          },
          select: { id: true },
        })
        tracksCreated += 1
      }

      await prisma.libraryFile.update({ where: { id: file.id }, data: { trackId: target.id } })
      filesReassigned += 1
    }

    // The bad ISRC must go regardless, or the next scan re-merges everything into it.
    await prisma.libraryTrack.update({ where: { id: track.id }, data: { isrc: null } })
    isrcsCleared += 1

    const remaining = await prisma.libraryFile.count({ where: { trackId: track.id } })
    if (remaining === 0) {
      // Nothing references it any more; a track with no files is not a recording.
      await prisma.match.updateMany({ where: { libraryTrackId: track.id }, data: { libraryTrackId: null, status: 'MISSING' } })
      await prisma.playlistItem.updateMany({ where: { libraryTrackId: track.id }, data: { libraryTrackId: null } })
      await prisma.libraryTrack.delete({ where: { id: track.id } }).catch(() => undefined)
      emptyTracksRemoved += 1
    }

    await ctx.setProgress(index + 1, bad.length, `${index + 1} of ${bad.length} merged tracks`)
  }

  const result = {
    tracksExamined: candidates.length,
    badTracks: bad.length,
    filesReassigned,
    tracksCreated,
    emptyTracksRemoved,
    isrcsCleared,
  }

  await ctx.log('info', 'ISRC repair complete', {
    ...result,
    note: 'Run a match sweep next — these recordings were invisible to matching while they were merged, so they were being reported as missing music you already own.',
  })
  return result
}

function fileNameTitle(path: string): string {
  return (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '').replace(/^\d+[\s.-]+/, '') || 'Unknown'
}
