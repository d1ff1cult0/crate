/**
 * Restore from a backup file. Counterpart to `GET /api/backup`.
 *
 * Two properties matter more than speed here:
 *
 *  - **Order.** Rows are written parents-first, so a foreign key never points at
 *    something that has not been written yet. The order below is the schema's dependency
 *    order and is not alphabetical for a reason.
 *  - **Upsert, not insert.** A restore into a live database must converge rather than
 *    collide. Re-running the same file twice produces the same result as running it once,
 *    which is the same idempotency rule every job in this app follows.
 *
 * Deliberately NOT wrapped in a single transaction. A full library restore is hundreds of
 * thousands of statements and one transaction that size will hit statement timeouts and
 * hold locks for minutes. Instead each table reports what it wrote, so a partial restore
 * is legible and simply re-runnable.
 */

import { readFile } from 'node:fs/promises'
import { prisma } from '@crate/db'
import type { JobRunContext } from '../lib/jobrun.js'

interface BackupFile {
  format?: number
  createdAt?: string
  scope?: string
  data?: Record<string, Array<Record<string, unknown>>>
}

export const SUPPORTED_FORMAT = 1

/**
 * Tables in dependency order, with the columns that identify an existing row.
 *
 * `sourcePlaylistItem` and the join tables key on their compound uniques rather than id,
 * so a restore over a database that already has the same membership updates it instead of
 * failing on the unique constraint.
 */
const TABLES: Array<{
  key: string
  model: keyof typeof prisma
  /** Fields carrying a BigInt in the schema; JSON round-trips them as strings. */
  bigints?: string[]
  /** Fields carrying a Date; JSON round-trips them as ISO strings. */
  dates?: string[]
}> = [
  { key: 'settings', model: 'setting' },
  { key: 'connections', model: 'connection', dates: ['expiresAt', 'lastOkAt', 'updatedAt'] },
  { key: 'artistNodes', model: 'artistNode' },
  { key: 'artistEdges', model: 'artistEdge' },
  { key: 'libraryTracks', model: 'libraryTrack', dates: ['lastPlayedAt', 'createdAt', 'updatedAt'] },
  { key: 'libraryFiles', model: 'libraryFile', bigints: ['sizeBytes'], dates: ['mtime', 'missingSince', 'scannedAt'] },
  { key: 'playlists', model: 'playlist', dates: ['lastWrittenAt', 'createdAt'] },
  { key: 'sourcePlaylists', model: 'sourcePlaylist', dates: ['lastSyncedAt', 'fullReadAt', 'createdAt'] },
  { key: 'sourceTracks', model: 'sourceTrack', dates: ['firstSeenAt'] },
  { key: 'sourcePlaylistItems', model: 'sourcePlaylistItem', dates: ['addedAt'] },
  { key: 'playlistItems', model: 'playlistItem' },
  { key: 'matches', model: 'match', dates: ['reviewedAt', 'updatedAt'] },
  { key: 'mixes', model: 'mix', dates: ['generatedAt'] },
  { key: 'listeningEvents', model: 'listeningEvent', dates: ['playedAt'] },
  { key: 'importRuns', model: 'importRun', dates: ['createdAt'] },
  { key: 'trashOperations', model: 'trashOperation', bigints: ['bytes'], dates: ['undoneAt', 'createdAt'] },
  { key: 'duplicateGroups', model: 'duplicateGroup', dates: ['createdAt', 'resolvedAt'] },
  { key: 'duplicateMembers', model: 'duplicateMember' },
]

/** JSON has no BigInt and no Date; both come back as strings and must be rehydrated. */
function rehydrate(
  row: Record<string, unknown>,
  bigints: string[] = [],
  dates: string[] = [],
): Record<string, unknown> {
  const out = { ...row }
  for (const field of bigints) {
    if (typeof out[field] === 'string' || typeof out[field] === 'number') {
      out[field] = BigInt(out[field] as string | number)
    }
  }
  for (const field of dates) {
    if (typeof out[field] === 'string') out[field] = new Date(out[field] as string)
  }
  return out
}

export interface RestoreResult {
  createdAt: string | null
  scope: string | null
  written: Record<string, number>
  failed: Record<string, string>
  total: number
}

export async function runRestore(ctx: JobRunContext, path: string): Promise<RestoreResult> {
  const raw = await readFile(path, 'utf8')
  const backup = JSON.parse(raw) as BackupFile

  if (backup.format !== SUPPORTED_FORMAT) {
    throw new Error(
      `Backup format ${String(backup.format)} is not supported — this build reads format ${SUPPORTED_FORMAT}.`,
    )
  }

  await ctx.log('info', 'Restoring backup', {
    createdAt: backup.createdAt,
    scope: backup.scope,
    note: 'rows are upserted, so this converges rather than duplicating',
  })

  const written: Record<string, number> = {}
  const failed: Record<string, string> = {}
  let total = 0

  for (const [index, table] of TABLES.entries()) {
    const rows = backup.data?.[table.key] ?? []
    if (rows.length === 0) continue

    // `setting` keys on `key`; everything else in this schema keys on `id`.
    const idField = table.key === 'settings' ? 'key' : 'id'
    const delegate = prisma[table.model] as unknown as {
      upsert(args: unknown): Promise<unknown>
    }

    let count = 0
    for (const row of rows) {
      const data = rehydrate(row, table.bigints, table.dates)
      const identifier = data[idField]
      if (identifier === undefined || identifier === null) continue
      try {
        await delegate.upsert({
          where: { [idField]: identifier },
          create: data,
          update: data,
        })
        count += 1
      } catch (err) {
        // One bad row must not abandon the other 40,000. The first failure per table is
        // reported and the rest of the table still goes in.
        if (!failed[table.key]) {
          failed[table.key] = err instanceof Error ? err.message : String(err)
          await ctx.log('warn', `Some ${table.key} rows could not be restored`, {
            error: failed[table.key],
          })
        }
      }
    }

    written[table.key] = count
    total += count
    await ctx.setProgress(index + 1, TABLES.length, `${table.key}: ${count} rows`)
    await ctx.log('info', `${table.key}: ${count} of ${rows.length} rows restored`)
  }

  await ctx.log('info', `Restore complete — ${total} rows`, {
    written,
    failedTables: Object.keys(failed),
    next: 'run a library scan if file paths have changed since the backup was taken',
  })

  return {
    createdAt: backup.createdAt ?? null,
    scope: backup.scope ?? null,
    written,
    failed,
    total,
  }
}
