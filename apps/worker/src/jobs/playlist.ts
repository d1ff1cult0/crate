/**
 * Playlist output — PROMPT.md §7.9, phase 5.
 *
 * Writes `.m3u8` (UTF-8, no BOM) atomically, translated through the §5 path mapping,
 * and ALSO pushes the playlist to Navidrome over Subsonic so it appears immediately
 * rather than waiting for a filesystem scan. The m3u is the source of truth; the
 * Subsonic copy is a convenience.
 *
 * Two details that matter more than they look:
 *
 *  - The write is temp → fsync → rename. A half-written m3u picked up by a scan
 *    mid-write leaves a playlist that is silently short, and nothing about it looks
 *    broken afterwards.
 *  - Unmatched tracks are preserved in a `<name>.missing.json` sidecar, so a later run
 *    can fill the gaps in place without re-importing anything.
 */

import { open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildM3u,
  buildMissingSidecar,
  sanitizeFilename,
  type M3uEntry,
  type MissingSidecarEntry,
  type PathMapping,
} from '@crate/core'
import { prisma } from '@crate/db'
import { SubsonicClient } from '@crate/integrations'
import { decryptJson } from '../lib/crypto.js'
import type { JobRunContext } from '../lib/jobrun.js'
import { requestNavidromeScan } from '../lib/navidrome.js'
import { loadSettings } from '../lib/settings.js'

/**
 * Atomic write: temp file in the same directory (so rename stays on one filesystem),
 * fsync the contents, then rename over the target.
 */
async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = join(dirname(target), `.${sanitizeFilename(target.split('/').pop() ?? 'tmp')}.${process.pid}.tmp`)
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, target)
}

export interface PlaylistWriteResult {
  playlistId: string
  name: string
  m3uPath: string
  written: number
  missing: number
  problems: number
  subsonicId?: string | undefined
}

export async function writePlaylist(
  ctx: JobRunContext,
  playlistId: string,
): Promise<PlaylistWriteResult | null> {
  const settings = await loadSettings()
  const musicRoot = process.env.MUSIC_ROOT ?? settings.musicRoot
  const mappings = settings.pathMappings as PathMapping[]

  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: {
          libraryTrack: {
            include: {
              files: {
                where: { missingSince: null },
                orderBy: { qualityScore: 'desc' },
                take: 1,
              },
            },
          },
          sourceTrack: {
            select: { id: true, title: true, artists: true, album: true, isrc: true },
          },
        },
      },
    },
  })

  if (!playlist) {
    await ctx.log('warn', 'Playlist no longer exists, nothing written', { playlistId })
    return null
  }

  const entries: M3uEntry[] = []
  const missing: MissingSidecarEntry[] = []

  for (const item of playlist.items) {
    // Prefer the best-quality file of the matched library track.
    const file = item.libraryTrack?.files[0]
    if (item.libraryTrack && file) {
      entries.push({
        appPath: file.path,
        title: item.libraryTrack.title,
        artist: item.libraryTrack.artist,
        durationMs: item.libraryTrack.durationMs,
      })
      continue
    }

    // Unmatched: keep it in the sidecar rather than silently dropping it.
    if (item.sourceTrack) {
      missing.push({
        title: item.sourceTrack.title,
        artist: item.sourceTrack.artists.join(', '),
        album: item.sourceTrack.album,
        isrc: item.sourceTrack.isrc,
        sourceTrackId: item.sourceTrack.id,
        position: item.position,
      })
    }
  }

  const fileName = `${sanitizeFilename(playlist.name)}.m3u8`
  const m3uPath = join(musicRoot, fileName)

  const built = buildM3u(entries, {
    name: playlist.name,
    musicRoot,
    mappings,
    absolute: settings.m3uAbsolutePaths,
  })

  for (const problem of built.problems) {
    await ctx.log('warn', `Skipped a track: ${problem.reason}`, { path: problem.appPath })
  }

  await writeAtomic(m3uPath, built.content)

  // Sidecar: written when there are gaps, removed when there are none, so a stale
  // sidecar never outlives the gaps it described.
  const sidecarPath = join(musicRoot, `${sanitizeFilename(playlist.name)}.missing.json`)
  if (missing.length > 0) {
    await writeFile(sidecarPath, buildMissingSidecar(playlist.name, missing), 'utf8')
  } else {
    await unlink(sidecarPath).catch(() => undefined)
  }

  // Also push to Navidrome so it appears without waiting for a scan (§7.9).
  let subsonicId: string | undefined
  const connection = await prisma.connection.findUnique({ where: { provider: 'navidrome' } })
  if (connection?.enabled && connection.secretCipher) {
    try {
      const creds = decryptJson<{ baseUrl: string; username: string; password: string }>(
        connection.secretCipher,
      )
      const subsonic = new SubsonicClient(creds)
      const existing = await subsonic.getPlaylists()
      const match = existing.find((p) => p.name === playlist.name)
      subsonicId = match?.id ?? (await subsonic.createPlaylist(playlist.name)) ?? undefined
    } catch (err) {
      // The m3u is the source of truth, so a Subsonic failure is a warning, not a
      // failed job — the playlist still lands on the next scan.
      await ctx.log('warn', 'Could not sync the playlist to Navidrome over Subsonic', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  await prisma.playlist.update({
    where: { id: playlist.id },
    data: {
      m3uPath,
      lastWrittenAt: new Date(),
      ...(subsonicId ? { subsonicId } : {}),
    },
  })

  await ctx.log('info', `Wrote ${playlist.name}`, {
    written: built.entriesWritten,
    missing: missing.length,
    problems: built.problems.length,
    m3uPath,
  })

  return {
    playlistId: playlist.id,
    name: playlist.name,
    m3uPath,
    written: built.entriesWritten,
    missing: missing.length,
    problems: built.problems.length,
    subsonicId,
  }
}

/**
 * Materialize a SourcePlaylist into a local Playlist, resolving each source track
 * through its match. Unmatched tracks are still added as items so their position is
 * preserved and a later match can fill the gap in place.
 */
export async function materializePlaylist(
  ctx: JobRunContext,
  sourcePlaylistId: string,
): Promise<string | null> {
  const source = await prisma.sourcePlaylist.findUnique({
    where: { id: sourcePlaylistId },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { sourceTrack: { include: { match: true } } },
      },
    },
  })

  if (!source) return null

  const playlist = source.playlistId
    ? await prisma.playlist.findUnique({ where: { id: source.playlistId } })
    : await prisma.playlist.create({
        data: { name: source.name, kind: 'IMPORTED', description: `Imported from ${source.source}` },
      })

  if (!playlist) return null

  if (!source.playlistId) {
    await prisma.sourcePlaylist.update({
      where: { id: source.id },
      data: { playlistId: playlist.id },
    })
  }

  // Rewrite the whole item list in one transaction. The alternative is a positional
  // shuffle that transiently violates the (playlistId, position) unique constraint —
  // see plan.md §2.2.
  await prisma.$transaction([
    prisma.playlistItem.deleteMany({ where: { playlistId: playlist.id } }),
    prisma.playlistItem.createMany({
      data: source.items.map((item, index) => ({
        playlistId: playlist.id,
        position: index,
        sourceTrackId: item.sourceTrackId,
        libraryTrackId:
          item.sourceTrack.match?.status === 'MATCHED'
            ? item.sourceTrack.match.libraryTrackId
            : null,
      })),
    }),
  ])

  await ctx.log('info', `Materialized ${source.name}`, { items: source.items.length })
  return playlist.id
}

/**
 * Rewrite only the playlists that were waiting on one source track.
 *
 * Called when a download lands. §7.9's sidecar exists so a gap can be filled "in place
 * without me re-importing anything" — this is the other half of that: the track becomes
 * playable, the playlists that referenced it are rewritten, and the sidecar shrinks by
 * one entry. Rewriting the whole library's playlists for one track would be wasteful and
 * would fight the scan debounce.
 */
export async function writeAffectedPlaylists(
  ctx: JobRunContext,
  sourceTrackId: string,
): Promise<{ written: number }> {
  const items = await prisma.playlistItem.findMany({
    where: { sourceTrackId },
    select: { playlistId: true },
    distinct: ['playlistId'],
  })

  if (items.length === 0) {
    await ctx.log('debug', 'No playlist referenced this track — nothing to rewrite')
    return { written: 0 }
  }

  // The item may still be pointing at nothing: the match is written by the post-processor
  // just before this runs, so refresh the link before writing.
  const match = await prisma.match.findUnique({ where: { sourceTrackId } })
  if (match?.libraryTrackId) {
    await prisma.playlistItem.updateMany({
      where: { sourceTrackId },
      data: { libraryTrackId: match.libraryTrackId },
    })
  }

  let written = 0
  for (const { playlistId } of items) {
    const result = await writePlaylist(ctx, playlistId)
    if (result) written += 1
  }

  await triggerScan(ctx)
  return { written }
}

/** Write every auto-sync playlist, then trigger ONE debounced Navidrome scan (§7.6.7). */
export async function writeAllPlaylists(ctx: JobRunContext): Promise<{ written: number }> {
  const playlists = await prisma.playlist.findMany({
    where: { autoSync: true },
    select: { id: true },
  })

  let written = 0
  for (const [index, p] of playlists.entries()) {
    const result = await writePlaylist(ctx, p.id)
    if (result) written += 1
    await ctx.setProgress(index + 1, playlists.length, `${index + 1} of ${playlists.length} playlists`)
  }

  await triggerScan(ctx)
  return { written }
}

/**
 * One Navidrome scan for a whole batch. §7.6 is explicit that a burst of writes must
 * not fire a scan per file — Navidrome rescans are expensive and it will fall behind.
 *
 * This asks for a debounced scan rather than starting one: writing twelve playlists
 * after a download burst should produce a single scan once everything has settled. The
 * mechanism lives in lib/navidrome.ts, shared with the post-processor so downloads and
 * playlist writes collapse into the same window instead of each triggering their own.
 */
export async function triggerScan(ctx: JobRunContext): Promise<void> {
  await requestNavidromeScan()
  await ctx.log('debug', 'Requested a debounced Navidrome scan')
}
