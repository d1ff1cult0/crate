import { deriveYouTubeImportStatus } from '@crate/core'
import { prisma } from '@crate/db'

export interface PersistedPlaylistWriteOutcome { written: number; problems: number; navidromeSync: 'ok' | 'failed' | 'disabled' }

export async function recordYouTubePlaylistWriteOutcome(sourcePlaylistId: string, outcome: PersistedPlaylistWriteOutcome): Promise<void> {
  const runs = await prisma.importRun.findMany({ where: { kind: 'YOUTUBE_PLAYLIST', sourcePlaylistId }, select: { id: true, detailJson: true } })
  for (const run of runs) {
    const prior = typeof run.detailJson === 'object' && run.detailJson && !Array.isArray(run.detailJson) ? run.detailJson as Record<string, unknown> : {}
    await prisma.importRun.update({ where: { id: run.id }, data: { detailJson: { ...prior, m3uEntries: outcome.written, mappingOmissions: outcome.problems, navidromeSync: outcome.navidromeSync } } })
  }
}

/** Recompute durable import status from the database; safe after every job transition. */
export async function refreshYouTubeImportsForTrack(sourceTrackId: string): Promise<void> {
  const runs = await prisma.importRun.findMany({
    where: {
      kind: 'YOUTUBE_PLAYLIST',
      sourcePlaylistId: { not: null },
      status: { in: ['QUEUED', 'RUNNING', 'PARTIAL'] },
    },
    select: { id: true, sourcePlaylistId: true, detailJson: true },
  })
  for (const run of runs) {
    if (!run.sourcePlaylistId) continue
    const belongs = await prisma.sourcePlaylistItem.count({
      where: { playlistId: run.sourcePlaylistId, sourceTrackId },
    })
    if (belongs) await refreshYouTubeImport(run.id)
  }
}

export async function refreshYouTubeImport(importRunId: string): Promise<void> {
  const run = await prisma.importRun.findUnique({ where: { id: importRunId } })
  if (!run?.sourcePlaylistId) return
  const items = await prisma.sourcePlaylistItem.findMany({
    where: { playlistId: run.sourcePlaylistId },
    select: {
      sourceTrack: {
        select: {
          match: { select: { status: true } },
          downloads: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, lastError: true } },
        },
      },
    },
  })
  let downloaded = 0
  let failed = 0
  let outstanding = 0
  const errors: string[] = []
  for (const item of items) {
    const request = item.sourceTrack.downloads[0]
    if (request?.status === 'SUCCEEDED') downloaded++
    else if (request?.status === 'FAILED' || request?.status === 'ABANDONED') {
      failed++
      if (request.lastError && errors.length < 20) errors.push(request.lastError)
    } else if (request?.status === 'QUEUED' || request?.status === 'RUNNING') {
      outstanding++
    } else if (item.sourceTrack.match?.status !== 'MATCHED') {
      failed++
      if (errors.length < 20) errors.push('A track could not be matched confidently and remains a visible playlist gap. Review it in Crate before downloading.')
    }
  }
  const prior = typeof run.detailJson === 'object' && run.detailJson && !Array.isArray(run.detailJson)
    ? run.detailJson as Record<string, unknown> : {}
  const invalidEntries = typeof prior.invalidEntries === 'number' ? prior.invalidEntries : 0
  const m3uEntries = typeof prior.m3uEntries === 'number' ? prior.m3uEntries : 0
  const mappingOmissions = typeof prior.mappingOmissions === 'number' ? prior.mappingOmissions : 0
  const navidromeSync = prior.navidromeSync === 'failed' || prior.navidromeSync === 'ok' ? prior.navidromeSync : 'disabled'
  const derived = deriveYouTubeImportStatus({ expected: items.length, m3uEntries, mappingOmissions, outstanding, failed, invalidEntries, navidromeSync })
  await prisma.importRun.update({
    where: { id: run.id },
    data: {
      status: derived.status,
      tracksAvailable: m3uEntries,
      tracksSucceeded: downloaded,
      tracksFailed: failed,
      message: derived.message,
      detailJson: { ...prior, errors },
    },
  })
}
