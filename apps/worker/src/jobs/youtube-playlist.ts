import { normalizeTrack } from '@crate/core'
import { prisma } from '@crate/db'
import { YouTubePlaylistClient, YouTubePlaylistUrlSchema } from '@crate/integrations'
import { YtmProvider } from '@crate/providers'
import type { JobRunContext } from '../lib/jobrun.js'
import { requestDownload } from '../lib/download-queue.js'
import { recordYouTubePlaylistWriteOutcome, refreshYouTubeImport } from '../lib/youtube-import-status.js'
import { materializePlaylist, triggerScan, writePlaylist } from './playlist.js'
import { runMatchSweep } from './match.js'

export async function runYouTubePlaylistImport(
  ctx: JobRunContext,
  input: { importRunId: string; url: string },
): Promise<void> {
  const boundary = YouTubePlaylistUrlSchema.parse(input.url)
  await prisma.importRun.update({ where: { id: input.importRunId }, data: { status: 'RUNNING' } })
  await ctx.log('info', 'Resolving YouTube playlist metadata', { playlistId: boundary.playlistId })

  try {
    const resolved = await new YouTubePlaylistClient().resolve(boundary.url)
    const ytm = new YtmProvider()
    const confirmedTracks: Array<(typeof resolved.tracks)[number] & { canonicalVideoId: string; album: string; albumArtist: string }> = []
    let unconfirmedEntries = 0
    for (const track of resolved.tracks) {
      if (track.metadataSource === 'structured' && track.album?.trim()) {
        confirmedTracks.push({
          ...track,
          canonicalVideoId: track.videoId,
          album: track.album,
          albumArtist: track.albumArtist?.trim() || track.artists[0]!,
        })
        continue
      }
      const canonical = await ytm.confirmCanonical({
        title: track.title,
        artists: track.artists,
        durationMs: track.durationMs,
      })
      if (!canonical?.album.trim()) { unconfirmedEntries++; continue }
      confirmedTracks.push({
        ...track,
        title: canonical.title,
        artists: canonical.artists,
        album: canonical.album,
        albumArtist: canonical.albumArtist,
        durationMs: canonical.durationMs ?? track.durationMs,
        year: canonical.year ?? track.year,
        canonicalVideoId: canonical.videoId,
      })
    }
    if (confirmedTracks.length === 0) throw new Error('YouTube returned no album-bearing tracks that could be confirmed in the YouTube Music catalog.')
    await ctx.log('info', `Resolved ${resolved.name}`, {
      entries: confirmedTracks.length,
      duplicatesRemoved: resolved.duplicates,
      invalidEntries: resolved.invalidEntries,
      unconfirmedEntries,
    })

    const externalIds = confirmedTracks.map((track) => track.videoId)
    const existing = await prisma.sourceTrack.findMany({
      where: { source: 'YOUTUBE', externalId: { in: externalIds } }, select: { externalId: true },
    })
    const existingIds = new Set(existing.map((track) => track.externalId))
    const sourcePlaylist = await prisma.sourcePlaylist.upsert({
      where: { source_externalId: { source: 'YOUTUBE', externalId: resolved.playlistId } },
      create: {
        source: 'YOUTUBE', externalId: resolved.playlistId, name: resolved.name,
        ownerName: resolved.ownerName, imageUrl: resolved.imageUrl,
        trackTotal: confirmedTracks.length, lastSyncedAt: new Date(), fullReadAt: new Date(),
      },
      update: {
        name: resolved.name, ownerName: resolved.ownerName, imageUrl: resolved.imageUrl,
        trackTotal: confirmedTracks.length, lastSyncedAt: new Date(), fullReadAt: new Date(),
      },
    })

    const sourceTrackIds: string[] = []
    for (const track of confirmedTracks) {
      const normalized = normalizeTrack({ title: track.title, artists: track.artists })
      const sourceTrack = await prisma.sourceTrack.upsert({
        where: { source_externalId: { source: 'YOUTUBE', externalId: track.videoId } },
        create: {
          source: 'YOUTUBE', externalId: track.videoId, title: track.title, artists: track.artists,
          albumArtist: track.albumArtist, album: track.album, durationMs: track.durationMs, year: track.year, isrcStatus: 'UNAVAILABLE',
          normTitle: normalized.title.norm, normArtist: normalized.artist.norm,
          rawJson: { ...track.raw, crateCanonicalYtmVideoId: track.canonicalVideoId } as object,
        },
        update: {
          title: track.title, artists: track.artists, albumArtist: track.albumArtist, album: track.album,
          durationMs: track.durationMs, year: track.year,
          normTitle: normalized.title.norm, normArtist: normalized.artist.norm,
          rawJson: { ...track.raw, crateCanonicalYtmVideoId: track.canonicalVideoId } as object,
        },
      })
      sourceTrackIds.push(sourceTrack.id)
    }

    await prisma.sourcePlaylistItem.deleteMany({ where: { playlistId: sourcePlaylist.id } })
    // Keep transactions and SQL parameter counts bounded for the 2,000-item ceiling.
    for (let offset = 0; offset < sourceTrackIds.length; offset += 250) {
      await prisma.sourcePlaylistItem.createMany({ data: sourceTrackIds.slice(offset, offset + 250).map((sourceTrackId, index) => ({ playlistId: sourcePlaylist.id, sourceTrackId, position: offset + index })) })
    }
    await prisma.importRun.update({
        where: { id: input.importRunId },
        data: {
          playlistName: resolved.name, imageUrl: resolved.imageUrl, sourcePlaylistId: sourcePlaylist.id,
          tracksFound: confirmedTracks.length, tracksNew: externalIds.filter((id) => !existingIds.has(id)).length,
          tracksDuplicate: resolved.duplicates,
          detailJson: { invalidEntries: resolved.invalidEntries, unconfirmedEntries, playlistId: resolved.playlistId, errors: [] },
        },
      })

    const matched = await runMatchSweep(ctx, { sourceTrackIds })
    await ctx.log('info', 'Checked the existing library before downloading', matched)
    let queued = 0
    const missing = await prisma.match.findMany({
      where: { sourceTrackId: { in: sourceTrackIds }, status: 'MISSING' }, select: { sourceTrackId: true },
    })
    for (const track of missing) {
      const requested = await requestDownload(track.sourceTrackId, { priority: 1 })
      if (requested.enqueued) queued++
    }
    await ctx.log('info', `Queued ${queued} recording(s) through the safe download pipeline`, {
      alreadyInLibrary: matched.matched, missing: matched.missing, needsReview: matched.review,
    })

    const playlistId = await materializePlaylist(ctx, sourcePlaylist.id)
    if (playlistId) {
      const outcome = await writePlaylist(ctx, playlistId)
      if (outcome) await recordYouTubePlaylistWriteOutcome(sourcePlaylist.id, outcome)
      await triggerScan(ctx)
    }
    await refreshYouTubeImport(input.importRunId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.importRun.update({
      where: { id: input.importRunId }, data: { status: 'FAILED', message, detailJson: { errors: [message] } },
    })
    throw error
  }
}
