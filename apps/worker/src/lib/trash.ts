/**
 * Trash. PROMPT.md §7.7 and CLAUDE.md "Destructive operations".
 *
 * **Never `unlink`.** Anything leaving the library moves to `TRASH_ROOT` with its
 * relative path preserved, recorded in a `TrashOperation` row whose manifest is enough
 * to put every file back exactly where it was. Undo replays that manifest in reverse.
 *
 * A JSON manifest is also written next to the files inside the trash directory. If the
 * database is ever lost, restoring by hand from the trash tree must still be possible —
 * a recovery mechanism that depends on the thing you are recovering from is not one.
 *
 * The only code in this project that genuinely deletes is `purgeTrash`, which is off by
 * default, has a minimum age, and only ever touches paths under `TRASH_ROOT`.
 */

import { copyFile, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { TrashPlanEntry } from '@crate/core'
import { prisma } from '@crate/db'
import type { JobRunContext } from './jobrun.js'

export interface TrashResult {
  operationId: string
  moved: number
  failed: Array<{ from: string; error: string }>
  bytes: bigint
}

/**
 * Rename, falling back to copy+unlink across filesystems.
 *
 * `TRASH_ROOT` is very often a different bind mount from `MUSIC_ROOT`, where rename
 * fails with EXDEV. The fallback verifies the copy landed at the right size before
 * removing the original — losing a file here would be unrecoverable and is exactly what
 * the trash exists to prevent.
 */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw err
  }

  const source = await stat(from)
  await copyFile(from, to)
  const copied = await stat(to)
  if (copied.size !== source.size) {
    await unlink(to).catch(() => undefined)
    throw new Error(`cross-device copy landed at ${copied.size} bytes, expected ${source.size}`)
  }
  await unlink(from)
}

export interface TrashOptions {
  reason: string
  /** Set false to leave LibraryFile rows alone (the file was never in the library). */
  markFilesMissing?: boolean
}

/**
 * Execute a move plan. Returns the operation id, which is what Undo needs.
 *
 * Partial failures do not abort the batch: a file that cannot move is reported and the
 * rest proceed, because a half-applied operation is still fully undoable from the
 * manifest of what actually moved.
 */
export async function moveToTrash(
  entries: TrashPlanEntry[],
  opts: TrashOptions,
): Promise<TrashResult> {
  const moved: TrashPlanEntry[] = []
  const failed: TrashResult['failed'] = []
  let bytes = 0n

  for (const entry of entries) {
    try {
      const info = await stat(entry.from)
      await moveFile(entry.from, entry.to)
      moved.push(entry)
      bytes += BigInt(info.size)
    } catch (err) {
      failed.push({ from: entry.from, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const operation = await prisma.trashOperation.create({
    data: {
      manifestJson: { reason: opts.reason, entries: moved, failed } as object,
      fileCount: moved.length,
      bytes,
    },
  })

  // The out-of-band copy: recoverable without the database.
  if (moved.length > 0) {
    const manifestPath = join(
      dirname(moved[0]!.to),
      `.crate-trash-${operation.id}.json`,
    )
    await writeFile(
      manifestPath,
      JSON.stringify(
        { operationId: operation.id, reason: opts.reason, at: new Date().toISOString(), entries: moved },
        null,
        2,
      ),
      'utf8',
    ).catch(() => undefined)
  }

  if (opts.markFilesMissing !== false && moved.length > 0) {
    // The file is gone from the library's point of view, but the row survives so the
    // undo can restore it and so history (play counts, playlist references) is not lost.
    await prisma.libraryFile.updateMany({
      where: { id: { in: moved.map((m) => m.fileId) } },
      data: { missingSince: new Date() },
    })
  }

  return { operationId: operation.id, moved: moved.length, failed, bytes }
}

export interface UndoResult {
  restored: number
  failed: Array<{ to: string; error: string }>
}

/** Put an entire operation back. §7.7: "An Undo button restores an entire operation." */
export async function undoTrashOperation(operationId: string): Promise<UndoResult> {
  const operation = await prisma.trashOperation.findUnique({ where: { id: operationId } })
  if (!operation) throw new Error(`Trash operation ${operationId} does not exist`)
  if (operation.undoneAt) throw new Error('That operation has already been undone')

  const manifest = operation.manifestJson as { entries?: TrashPlanEntry[] } | null
  const entries = manifest?.entries ?? []

  let restored = 0
  const failed: UndoResult['failed'] = []

  for (const entry of entries) {
    try {
      // Refuse to overwrite: if something already occupies the original path, the
      // library has moved on and silently clobbering it would be worse than stopping.
      const occupied = await stat(entry.from).then(
        () => true,
        () => false,
      )
      if (occupied) throw new Error('a file already exists at the original path')
      await moveFile(entry.to, entry.from)
      restored += 1
    } catch (err) {
      failed.push({ to: entry.to, error: err instanceof Error ? err.message : String(err) })
    }
  }

  await prisma.libraryFile.updateMany({
    where: { id: { in: entries.map((e) => e.fileId) } },
    data: { missingSince: null },
  })

  await prisma.trashOperation.update({
    where: { id: operationId },
    data: { undoneAt: new Date() },
  })

  return { restored, failed }
}

export interface PurgeResult {
  deleted: number
  bytes: bigint
  skipped: number
}

/**
 * The retention job (§7.10). Off by default, and the only deletion in the codebase.
 *
 * Three guards, because this is the one function that cannot be undone:
 *   - it refuses to run unless explicitly enabled by the caller;
 *   - it only considers operations older than `days`;
 *   - it resolves every path and refuses any that does not sit under `trashRoot`, so a
 *     corrupted manifest cannot point it at the library.
 */
export async function purgeTrash(
  ctx: JobRunContext,
  opts: { enabled: boolean; days: number; trashRoot: string },
): Promise<PurgeResult> {
  if (!opts.enabled) {
    await ctx.log('info', 'Trash retention is off — nothing purged')
    return { deleted: 0, bytes: 0n, skipped: 0 }
  }

  const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000)
  const operations = await prisma.trashOperation.findMany({
    where: { createdAt: { lt: cutoff }, undoneAt: null },
  })

  const root = resolve(opts.trashRoot)
  let deleted = 0
  let bytes = 0n
  let skipped = 0

  for (const operation of operations) {
    const manifest = operation.manifestJson as { entries?: TrashPlanEntry[] } | null
    for (const entry of manifest?.entries ?? []) {
      const target = resolve(entry.to)
      // The guard that matters: a manifest pointing outside the trash is a bug or
      // corruption, and deleting from the library on the strength of it is unthinkable.
      if (target !== root && !target.startsWith(root + '/')) {
        await ctx.log('error', 'Refusing to purge a path outside TRASH_ROOT', {
          path: target,
          trashRoot: root,
          operationId: operation.id,
        })
        skipped += 1
        continue
      }
      try {
        const info = await stat(target)
        await unlink(target)
        deleted += 1
        bytes += BigInt(info.size)
      } catch {
        skipped += 1 // already gone, which is fine
      }
    }

    await prisma.trashOperation.delete({ where: { id: operation.id } }).catch(() => undefined)
  }

  await ctx.log('info', `Purged ${deleted} file(s) from trash older than ${opts.days} days`, {
    bytes: String(bytes),
    skipped,
  })
  return { deleted, bytes, skipped }
}

/** Remove empty directories left behind under the trash root after a purge or undo. */
export async function pruneEmptyDirs(root: string): Promise<number> {
  let removed = 0
  const walk = async (dir: string): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    let empty = true
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const childEmpty = await walk(full)
        if (!childEmpty) empty = false
      } else if (entry.name.startsWith('.crate-trash-')) {
        // Manifests do not keep a directory alive on their own.
        continue
      } else {
        empty = false
      }
    }
    if (empty && resolve(dir) !== resolve(root)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      removed += 1
    }
    return empty
  }
  await walk(root)
  return removed
}

/** Relative path under a root, for building trash destinations outside `core`. */
export function trashDestination(path: string, musicRoot: string, trashRoot: string): string {
  const rel = relative(musicRoot, path)
  // A file outside the music root keeps a flattened, unambiguous name rather than
  // escaping the trash root via `../`.
  if (rel.startsWith('..')) return join(trashRoot, '_outside_root', path.replace(/^\/+/, ''))
  return join(trashRoot, rel)
}
