/**
 * Duplicate group actions. PROMPT.md §7.7.
 *
 * The split here is deliberate and follows §4:
 *
 *  - **Reads and flag flips** — the dry-run plan, marking a group ignored, moving the
 *    keeper — happen inline. They are single database statements and the UI should feel
 *    instant.
 *  - **Anything that moves a file** — apply, undo — is enqueued for the worker. Moving
 *    files across mounts takes real time and must survive a redeploy half-done, which is
 *    exactly what the trash manifest is for.
 *
 * "Dry run is the default" is enforced in the worker (`applyDedupe`), not here, so it
 * holds for the scheduled path too and cannot be bypassed by calling this endpoint.
 */

import { prisma } from '@crate/db'
import { z } from 'zod'
import { BULK_DELETE_MIN_CONFIDENCE } from '../../../../lib/jobs'
import { enqueueJob, jobId } from '../../../../lib/queue'
import { isUnauthorized, requireApiSession } from '../../../../lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('plan'), groupIds: z.array(z.string()).optional() }),
  /** What a bulk delete would remove — count and size, for the confirmation. */
  z.object({
    action: z.literal('preview-bulk-delete'),
    minConfidence: z.number().min(0).max(1).optional(),
  }),
  /**
   * The confirmed bulk delete. `confirm` is required and must be the literal word, so
   * this cannot be triggered by a stray request or a mis-click.
   */
  z.object({
    action: z.literal('bulk-delete'),
    minConfidence: z.number().min(0).max(1).optional(),
    confirm: z.literal('DELETE'),
  }),
  z.object({
    action: z.literal('apply'),
    groupIds: z.array(z.string()).min(1).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  }),
  z.object({ action: z.literal('undo'), operationId: z.string().min(1) }),
  z.object({ action: z.literal('ignore'), groupId: z.string().min(1) }),
  z.object({ action: z.literal('keeper'), groupId: z.string().min(1), fileId: z.string().min(1) }),
])

export async function POST(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })
  const body = parsed.data

  if (body.action === 'plan') {
    const groups = await prisma.duplicateGroup.findMany({
      where: {
        status: 'OPEN',
        ...(body.groupIds ? { id: { in: body.groupIds } } : {}),
      },
      include: { members: { include: { file: true } } },
    })

    // Exactly what would move, and what would not. §7.7: "Every batch shows exactly what
    // will move before anything moves."
    const plan = groups.map((group) => {
      const variant = group.reason === 'VARIANT'
      const losers = variant ? [] : group.members.filter((m) => !m.isKeeper)
      return {
        groupId: group.id,
        reason: group.reason,
        confidence: group.confidence,
        variant,
        keeper: group.members.find((m) => m.isKeeper)?.file.path ?? null,
        wouldMove: losers.map((m) => ({
          fileId: m.fileId,
          path: m.file.path,
          sizeBytes: String(m.file.sizeBytes),
          qualityScore: m.file.qualityScore,
        })),
        note: variant
          ? 'Kept as a variant — the durations differ by more than 5s, so this is a live, extended or remixed take rather than a duplicate.'
          : null,
      }
    })

    return Response.json({
      groups: plan.length,
      filesToMove: plan.reduce((sum, g) => sum + g.wouldMove.length, 0),
      bytes: String(
        plan.reduce(
          (sum, g) => sum + g.wouldMove.reduce((s, f) => s + BigInt(f.sizeBytes), 0n),
          0n,
        ),
      ),
      plan,
    })
  }

  if (body.action === 'preview-bulk-delete') {
    const minConfidence = body.minConfidence ?? BULK_DELETE_MIN_CONFIDENCE

    // Aggregate, not a row-by-row plan: the confirmation needs a count and a size, and
    // it has to render inside a dialog rather than after a scroll through 3,000 paths.
    const groups = await prisma.duplicateGroup.findMany({
      where: { status: 'OPEN', confidence: { gte: minConfidence } },
      select: {
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

    return Response.json({
      minConfidence,
      groups: resolvable.length,
      files,
      bytes: String(bytes),
      variantGroupsExcluded: groups.length - resolvable.length,
    })
  }

  if (body.action === 'bulk-delete') {
    await enqueueJob(
      'maintenance',
      'dedupe-delete-high-confidence',
      { minConfidence: body.minConfidence ?? BULK_DELETE_MIN_CONFIDENCE },
      { jobId: jobId('dedupe-bulk-delete', Date.now()) },
    )
    return Response.json({ ok: true, queued: true })
  }

  if (body.action === 'ignore') {
    await prisma.duplicateGroup.update({
      where: { id: body.groupId },
      data: { status: 'IGNORED', resolvedAt: new Date() },
    })
    return Response.json({ ok: true })
  }

  if (body.action === 'keeper') {
    // One statement per side, in a transaction — a group with two keepers or none would
    // make the apply path ambiguous.
    await prisma.$transaction([
      prisma.duplicateMember.updateMany({
        where: { groupId: body.groupId },
        data: { isKeeper: false },
      }),
      prisma.duplicateMember.updateMany({
        where: { groupId: body.groupId, fileId: body.fileId },
        data: { isKeeper: true },
      }),
    ])
    return Response.json({ ok: true })
  }

  if (body.action === 'undo') {
    await enqueueJob(
      'maintenance',
      'dedupe-undo',
      { operationId: body.operationId },
      { jobId: jobId('undo', body.operationId) },
    )
    return Response.json({ ok: true, queued: true })
  }

  await enqueueJob(
    'maintenance',
    'dedupe-apply',
    {
      ...(body.groupIds ? { groupIds: body.groupIds } : {}),
      ...(body.minConfidence !== undefined ? { minConfidence: body.minConfidence } : {}),
      dryRun: false,
    },
    { jobId: jobId('dedupe-apply', Date.now()) },
  )
  return Response.json({ ok: true, queued: true })
}
