/**
 * Backup and restore — PROMPT.md §10 phase 8.
 *
 * What is worth backing up, and what is not:
 *
 *  - **Irreplaceable.** Everything harvested from Spotify. After the subscription lapses
 *    it cannot be fetched again at any price, which makes it the entire reason this
 *    endpoint exists. Also the owner's own decisions — match reviews, keeper overrides,
 *    ignored duplicate groups — because those represent time spent, not data.
 *  - **Expensive.** Listening history, the artist graph, fingerprints and content
 *    hashes. Rebuildable in principle; hours of CPU and API calls in practice.
 *  - **Cheap.** `JobRun` logs and `DownloadAttempt` rows. Deliberately excluded: they are
 *    the bulkiest tables and a week old they are worth nothing.
 *
 * The export includes credential ciphertext, not plaintext. It is only useful with the
 * same `CRATE_ENCRYPTION_KEY`, which is stated in the file itself so a restore into a
 * fresh install fails loudly rather than leaving mysteriously broken connections.
 *
 * The export is a read, so it runs inline. The restore does not: it writes tens of
 * thousands of rows and must survive a redeploy half-done, so it goes to the worker (§4).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@crate/db'
import { BACKUP_FORMAT } from '../../../lib/jobs'
import { enqueueJob, jobId } from '../../../lib/queue'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** JSON.stringify cannot serialize BigInt, and LibraryFile.sizeBytes is one. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? String(value) : value
}

export async function GET(request: Request) {
  const essentialOnly = new URL(request.url).searchParams.get('scope') === 'essential'

  const [
    settings,
    connections,
    sourcePlaylists,
    sourceTracks,
    sourcePlaylistItems,
    matches,
    playlists,
    playlistItems,
    mixes,
    listeningEvents,
    artistNodes,
    artistEdges,
    importRuns,
    trashOperations,
    duplicateGroups,
    duplicateMembers,
  ] = await Promise.all([
    prisma.setting.findMany(),
    prisma.connection.findMany(),
    prisma.sourcePlaylist.findMany(),
    prisma.sourceTrack.findMany(),
    prisma.sourcePlaylistItem.findMany(),
    prisma.match.findMany(),
    prisma.playlist.findMany(),
    prisma.playlistItem.findMany(),
    prisma.mix.findMany(),
    prisma.listeningEvent.findMany(),
    prisma.artistNode.findMany(),
    prisma.artistEdge.findMany(),
    prisma.importRun.findMany(),
    prisma.trashOperation.findMany(),
    prisma.duplicateGroup.findMany(),
    prisma.duplicateMember.findMany(),
  ])

  // The library tables are rebuildable by a scan, so "essential" leaves them out — that
  // is the difference between a file you can email yourself and one you cannot.
  const libraryTracks = essentialOnly ? [] : await prisma.libraryTrack.findMany()
  const libraryFiles = essentialOnly ? [] : await prisma.libraryFile.findMany()

  const backup = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    scope: essentialOnly ? 'essential' : 'full',
    note: 'Connection secrets are AES-256-GCM ciphertext. They are only readable with the same CRATE_ENCRYPTION_KEY this instance used — back that key up separately or the credentials in this file are unrecoverable.',
    counts: {
      sourceTracks: sourceTracks.length,
      matches: matches.length,
      listeningEvents: listeningEvents.length,
      libraryFiles: libraryFiles.length,
    },
    data: {
      settings,
      connections,
      sourcePlaylists,
      sourceTracks,
      sourcePlaylistItems,
      libraryTracks,
      libraryFiles,
      matches,
      playlists,
      playlistItems,
      mixes,
      listeningEvents,
      artistNodes,
      artistEdges,
      importRuns,
      trashOperations,
      duplicateGroups,
      duplicateMembers,
    },
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return new Response(JSON.stringify(backup, replacer, 0), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="crate-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Accept a backup file and hand it to the worker.
 *
 * The file lands in staging rather than being passed through Redis: a full backup of a
 * large library is tens of megabytes, and a job payload that size is abuse of a queue.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null)
  const file = form?.get('backup')
  const confirm = form?.get('confirm')

  if (!(file instanceof File)) {
    return Response.json({ error: 'Attach a backup file.' }, { status: 400 })
  }
  // A restore overwrites rows the owner may still want. It takes a deliberate word.
  if (confirm !== 'REPLACE') {
    return Response.json(
      { error: 'Type REPLACE to confirm. A restore overwrites rows that share an id with the backup.' },
      { status: 400 },
    )
  }

  const text = await file.text()
  let parsed: { format?: number }
  try {
    parsed = JSON.parse(text) as { format?: number }
  } catch {
    return Response.json({ error: 'That file is not valid JSON.' }, { status: 400 })
  }
  if (parsed.format !== BACKUP_FORMAT) {
    return Response.json(
      { error: `Unsupported backup format ${String(parsed.format)} — this build reads format ${BACKUP_FORMAT}.` },
      { status: 400 },
    )
  }

  const settingRow = await prisma.setting.findUnique({ where: { key: 'app' } })
  const stagingRoot =
    process.env.STAGING_ROOT ?? ((settingRow?.value ?? {}) as { stagingRoot?: string }).stagingRoot ?? '/staging'
  const dir = join(stagingRoot, '_restore')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `restore-${Date.now()}.json`)
  await writeFile(path, text, 'utf8')

  await enqueueJob('maintenance', 'restore-backup', { path }, { jobId: jobId('restore', Date.now()) })

  return Response.json({
    ok: true,
    message:
      'Restore queued. Watch the activity drawer — the job log lists every table and how many rows it wrote.',
  })
}
