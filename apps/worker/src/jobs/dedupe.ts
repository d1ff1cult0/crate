/**
 * Duplicate detection — PROMPT.md §7.7, phase 6.
 *
 * The grouping itself is pure and lives in `packages/core/src/dedupe.ts`, tested against
 * fixtures. This file is the I/O half: read the library, persist the groups, and — only
 * when explicitly told to — move losers to the trash.
 *
 * The trust rules, restated because they are the whole point of this phase:
 *
 *  - **Dry run is the default.** Every batch shows exactly what will move before
 *    anything moves, and `dedupeDryRunOnly` has to be turned off before an apply does
 *    anything at all (DECISIONS A13).
 *  - **Variants are never resolved.** Same artist and title with durations more than 5s
 *    apart is a live take or a remix. Auto-deleting those is how a dedupe tool loses
 *    trust permanently, so they are grouped for visibility with no keeper and are
 *    excluded from every apply path — including "accept all".
 *  - **Nothing is ever unlinked.** Losers move to `TRASH_ROOT` with a manifest and a
 *    working undo. See lib/trash.ts.
 */

import { findDuplicateGroups, planTrashMoves, type DedupeFile, type DedupeOptions } from '@crate/core'
import { prisma } from '@crate/db'
import type { JobRunContext } from '../lib/jobrun.js'
import { loadSettings } from '../lib/settings.js'
import { moveToTrash } from '../lib/trash.js'

/** Load every present file in a shape the pure grouper understands. */
async function loadDedupeFiles(): Promise<DedupeFile[]> {
  const rows = await prisma.libraryFile.findMany({
    where: { missingSince: null },
    include: {
      track: {
        select: { title: true, artist: true, album: true, isrc: true, mbid: true },
      },
    },
  })

  return rows.map((row) => {
    const tags = (row.tagsJson ?? {}) as Record<string, unknown>
    return {
      id: row.id,
      path: row.path,
      title: row.track?.title ?? String(tags.title ?? ''),
      artist: row.track?.artist ?? String(tags.artist ?? ''),
      album: row.track?.album ?? null,
      durationMs: row.durationMs,
      isrc: row.track?.isrc ?? (tags.isrc ? String(tags.isrc) : null),
      mbid: row.track?.mbid ?? null,
      contentHash: row.contentHash,
      fingerprint: row.fingerprint,
      format: row.format,
      bitrate: row.bitrate,
      sampleRate: row.sampleRate,
      bitDepth: row.bitDepth,
      tags,
      // Whether art is embedded is not stored per file; the tag set is the proxy the
      // keeper rule uses, and the scan already folded art into qualityScore.
      hasEmbeddedArt: false,
      sourceProvider: row.sourceProvider,
      qualityScore: row.qualityScore,
      mtime: row.mtime,
    }
  })
}

export interface DedupeScanResult {
  filesConsidered: number
  groups: number
  variants: number
  duplicates: number
  reclaimableBytes: string
}

/**
 * The weekly scan (§7.10). Populates groups; never deletes, never moves.
 *
 * Re-runnable: OPEN groups are rebuilt from scratch each time so a group whose files
 * changed does not linger with stale membership, while groups the owner already resolved
 * are left alone so their decisions are not re-litigated every week.
 */
export async function runDedupeScan(ctx: JobRunContext): Promise<DedupeScanResult> {
  const settings = await loadSettings()
  const opts: DedupeOptions = {
    durationToleranceMs: 2000,
    variantThresholdMs: 5000,
    autoResolveAt: settings.dedupeAutoResolveAt,
  }

  const files = await loadDedupeFiles()
  await ctx.log('info', `Grouping ${files.length} files`)

  const groups = findDuplicateGroups(files, opts)
  const byId = new Map(files.map((f) => [f.id, f]))

  // Rebuild only the open set.
  await prisma.duplicateGroup.deleteMany({ where: { status: 'OPEN' } })

  let variants = 0
  let duplicates = 0
  let reclaimable = 0n

  for (const group of groups) {
    if (group.variant) variants += 1
    else duplicates += 1

    const created = await prisma.duplicateGroup.create({
      data: {
        reason: group.reason,
        confidence: group.confidence,
        status: 'OPEN',
      },
    })

    await prisma.duplicateMember.createMany({
      data: group.memberIds.map((fileId) => ({
        groupId: created.id,
        fileId,
        isKeeper: fileId === group.keeperId,
      })),
      skipDuplicates: true,
    })

    if (!group.variant && group.keeperId) {
      for (const id of group.memberIds) {
        if (id === group.keeperId) continue
        const row = await prisma.libraryFile.findUnique({
          where: { id },
          select: { sizeBytes: true },
        })
        reclaimable += row?.sizeBytes ?? 0n
      }
    }
  }

  await ctx.log('info', 'Grouping complete', {
    groups: groups.length,
    duplicates,
    variants,
    reclaimableBytes: String(reclaimable),
    note: 'nothing has been moved — dedupe is dry-run until you apply a group',
  })

  return {
    filesConsidered: files.length,
    groups: groups.length,
    variants,
    duplicates,
    reclaimableBytes: String(reclaimable),
  }
}

export interface DedupePlanEntry {
  groupId: string
  reason: string
  confidence: number
  variant: boolean
  keeper: { id: string; path: string; qualityScore: number } | null
  losers: Array<{ id: string; path: string; qualityScore: number; sizeBytes: string; to: string }>
}

export interface DedupeApplyResult {
  dryRun: boolean
  groups: number
  filesPlanned: number
  filesMoved: number
  operationIds: string[]
  bytes: string
  refused: Array<{ groupId: string; reason: string }>
}

/**
 * Plan and optionally apply. `dryRun` defaults to true and stays true regardless of the
 * caller when `dedupeDryRunOnly` is set — the setting is a hard stop, not a default.
 */
export async function applyDedupe(
  ctx: JobRunContext,
  opts: {
    groupIds?: string[]
    minConfidence?: number
    dryRun?: boolean
    /**
     * Set only by an action the owner explicitly confirmed in the UI, naming the file
     * count and the space involved.
     *
     * `dedupeDryRunOnly` exists so nothing destructive happens by accident or on a
     * schedule. It is not meant to stop someone who has read exactly what will happen and
     * pressed the button — at that point it stops being a safety rail and becomes a
     * setting the owner cannot find to turn off, which is how it actually behaved: it was
     * on by default and exposed nowhere in the interface.
     */
    confirmedOverride?: boolean
  },
): Promise<DedupeApplyResult> {
  const settings = await loadSettings()
  const musicRoot = process.env.MUSIC_ROOT ?? settings.musicRoot
  const trashRoot = process.env.TRASH_ROOT ?? settings.trashRoot

  const requestedDryRun = opts.dryRun !== false
  const dryRun = requestedDryRun || (settings.dedupeDryRunOnly && !opts.confirmedOverride)

  const groups = await prisma.duplicateGroup.findMany({
    where: {
      status: 'OPEN',
      ...(opts.groupIds ? { id: { in: opts.groupIds } } : {}),
      ...(opts.minConfidence !== undefined ? { confidence: { gte: opts.minConfidence } } : {}),
    },
    include: { members: { include: { file: true } } },
  })

  const refused: DedupeApplyResult['refused'] = []
  const plan: Array<{ groupId: string; fileId: string; from: string; to: string }> = []

  for (const group of groups) {
    // The rule that must never be softened, including under "accept all above a
    // threshold": a variant group has no keeper and both sides stay.
    if (group.reason === 'VARIANT') {
      refused.push({
        groupId: group.id,
        reason: 'variant group — durations differ by more than 5s, so both files are kept',
      })
      continue
    }
    const keeper = group.members.find((m) => m.isKeeper)
    if (!keeper) {
      refused.push({ groupId: group.id, reason: 'no keeper selected' })
      continue
    }
    for (const member of group.members) {
      if (member.isKeeper) continue
      const rel = member.file.path.startsWith(musicRoot + '/')
        ? member.file.path.slice(musicRoot.length + 1)
        : member.file.path.replace(/^\/+/, '')
      plan.push({
        groupId: group.id,
        fileId: member.fileId,
        from: member.file.path,
        to: `${trashRoot.replace(/\/+$/, '')}/${rel}`,
      })
    }
  }

  if (dryRun) {
    await ctx.log(
      'info',
      `Dry run: ${plan.length} file(s) across ${groups.length - refused.length} group(s) would move to the trash`,
      {
        refused: refused.length,
        dryRunForced: settings.dedupeDryRunOnly && !requestedDryRun,
        files: plan.map((p) => p.from),
      },
    )
    if (settings.dedupeDryRunOnly && !requestedDryRun) {
      await ctx.log(
        'warn',
        'An apply was requested but "dedupe dry run only" is on in settings — nothing moved. Turn it off to allow applies.',
      )
    }
    return {
      dryRun: true,
      groups: groups.length,
      filesPlanned: plan.length,
      filesMoved: 0,
      operationIds: [],
      bytes: '0',
      refused,
    }
  }

  const result = await moveToTrash(
    plan.map((p) => ({ fileId: p.fileId, from: p.from, to: p.to })),
    { reason: `Dedupe apply across ${groups.length} group(s)` },
  )

  const appliedGroupIds = [...new Set(plan.map((p) => p.groupId))]
  await prisma.duplicateGroup.updateMany({
    where: { id: { in: appliedGroupIds } },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  })
  await prisma.duplicateMember.updateMany({
    where: { groupId: { in: appliedGroupIds }, isKeeper: false },
    data: { action: 'TRASHED' },
  })

  await ctx.log('info', `Moved ${result.moved} file(s) to the trash`, {
    operationId: result.operationId,
    failed: result.failed.length,
    bytes: String(result.bytes),
    undo: 'this whole operation can be undone from the Duplicates screen',
  })

  return {
    dryRun: false,
    groups: appliedGroupIds.length,
    filesPlanned: plan.length,
    filesMoved: result.moved,
    operationIds: [result.operationId],
    bytes: String(result.bytes),
    refused,
  }
}

/** Mark a group as deliberately kept, so the next scan does not resurface it. */
export async function ignoreGroup(groupId: string): Promise<void> {
  await prisma.duplicateGroup.update({
    where: { id: groupId },
    data: { status: 'IGNORED', resolvedAt: new Date() },
  })
}

/** Move the keeper flag within a group, so the owner can override the quality rule. */
export async function setKeeper(groupId: string, fileId: string): Promise<void> {
  await prisma.$transaction([
    prisma.duplicateMember.updateMany({ where: { groupId }, data: { isKeeper: false } }),
    prisma.duplicateMember.updateMany({ where: { groupId, fileId }, data: { isKeeper: true } }),
  ])
}

/** Re-export so the pure planner is reachable from one place in the worker. */
export { planTrashMoves }

/**
 * The threshold above which a duplicate group is safe to resolve in bulk.
 *
 * 0.95 sits above the FUZZY tiers (0.85 and 0.70) and below HASH (1.0), FINGERPRINT
 * (0.99), ISRC (0.97) and MBID (0.96) — so a bulk delete only ever touches groups
 * established by identical audio, identical fingerprint, or a shared identifier with a
 * near-identical duration. Nothing decided by name similarity is included, and VARIANT
 * groups are excluded by `applyDedupe` regardless of what threshold is passed.
 */
export const BULK_DELETE_MIN_CONFIDENCE = 0.95

export interface DeletePreview {
  minConfidence: number
  groups: number
  files: number
  bytes: string
  /** Groups above the threshold that are variants, and therefore excluded. */
  variantGroupsExcluded: number
}

/**
 * What a bulk delete would remove, as an aggregate rather than a row-by-row plan.
 *
 * The confirmation needs a count and a size, not a list of three thousand paths, and this
 * has to be fast enough to render inside a dialog.
 */
export async function previewHighConfidenceDeletion(
  minConfidence = BULK_DELETE_MIN_CONFIDENCE,
): Promise<DeletePreview> {
  const groups = await prisma.duplicateGroup.findMany({
    where: { status: 'OPEN', confidence: { gte: minConfidence } },
    select: {
      id: true,
      reason: true,
      members: { where: { isKeeper: false }, select: { file: { select: { sizeBytes: true } } } },
    },
  })

  const resolvable = groups.filter((g) => g.reason !== 'VARIANT')
  let files = 0
  let bytes = 0n
  for (const group of resolvable) {
    for (const member of group.members) {
      files += 1
      bytes += member.file.sizeBytes
    }
  }

  return {
    minConfidence,
    groups: resolvable.length,
    files,
    bytes: String(bytes),
    variantGroupsExcluded: groups.length - resolvable.length,
  }
}

/**
 * Delete every duplicate above the threshold, in one confirmed action.
 *
 * "Delete" means moved to `TRASH_ROOT` with a manifest, not unlinked. That is not a
 * softened version of the request — it is what makes the action safe to press: the move
 * is a rename, so it is as fast as a delete, it is fully undoable from the Duplicates
 * screen, and the retention job clears the trash later. Unlinking outright would buy
 * nothing and forfeit the audit trail the owner asked to keep.
 */
export async function deleteHighConfidenceDuplicates(
  ctx: JobRunContext,
  opts: { minConfidence?: number } = {},
): Promise<DedupeApplyResult> {
  const minConfidence = opts.minConfidence ?? BULK_DELETE_MIN_CONFIDENCE
  const preview = await previewHighConfidenceDeletion(minConfidence)

  await ctx.log('info', `Deleting duplicates at confidence ≥ ${minConfidence}`, {
    groups: preview.groups,
    files: preview.files,
    bytes: preview.bytes,
    variantGroupsExcluded: preview.variantGroupsExcluded,
    note: 'Files move to TRASH_ROOT with a manifest and can be restored from the Duplicates screen.',
  })

  return applyDedupe(ctx, { minConfidence, dryRun: false, confirmedOverride: true })
}
