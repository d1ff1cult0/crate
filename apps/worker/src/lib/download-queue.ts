/**
 * The bridge between `DownloadRequest` rows and BullMQ jobs.
 *
 * Every producer of download work goes through here rather than writing a row and hoping
 * something picks it up. The reconciler underneath is the safety net for when one
 * doesn't — which is not hypothetical: it is how 168 requests ended up queued in the
 * database with nothing whatsoever in Redis.
 *
 * See packages/core/src/download-queue.ts for the reasoning and the pure planner.
 */

import {
  downloadJobId,
  planQueueReconciliation,
  bullPriority,
  RECONCILABLE_STATUSES,
  type QueueJobState,
  type ReconcilableRequest,
} from '@crate/core'
import { prisma } from '@crate/db'
import type { JobRunContext } from './jobrun.js'
import { canonicalYouTubeEligibility } from './canonical-youtube.js'
import { getQueue } from './queues.js'

/**
 * Ask the queue what it currently holds for a set of job ids.
 *
 * `getJob` then `getState` rather than reading the waiting list, because a job can be in
 * any of seven states and only some of them mean "will run". A missing job and a finished
 * job look identical from the outside and need opposite treatment.
 */
export async function readJobStates(jobIds: string[]): Promise<Map<string, QueueJobState>> {
  const queue = getQueue('download')
  const states = new Map<string, QueueJobState>()

  for (const jobId of jobIds) {
    const job = await queue.getJob(jobId)
    if (!job) continue
    const state = (await job.getState()) as QueueJobState
    states.set(jobId, state)
  }
  return states
}

export interface ReconcileResult {
  considered: number
  enqueued: number
  replaced: number
  alreadyPending: number
  /** Set when a large backlog was found and deliberately NOT released. */
  heldBack?: number
}

/**
 * How much drift a boot-time reconcile will repair on its own.
 *
 * Small drift is a glitch and fixing it silently is right. A large backlog is a different
 * event: releasing 168 orphaned requests would start 168 downloads seconds after a
 * restart, which is a surprise nobody asked for and the opposite of what an operator
 * wants while they are still working out what went wrong. Above this, the reconciler
 * reports and waits for the explicit action.
 */
export const BOOT_AUTO_RECONCILE_MAX = 25

/**
 * Make sure every outstanding request has a job behind it.
 *
 * Safe to run at any time and as often as you like: a request with a pending job is left
 * strictly alone, so this converges rather than duplicating. That is what makes it usable
 * as a boot-time self-heal.
 *
 * `autoLimit` caps how many it will release without being asked — see
 * `BOOT_AUTO_RECONCILE_MAX`. The explicit "reconcile" action passes no limit.
 */
export async function reconcileDownloadQueue(
  ctx: JobRunContext,
  opts: { limit?: number; autoLimit?: number } = {},
): Promise<ReconcileResult> {
  const rows = await prisma.downloadRequest.findMany({
    where: { status: { in: [...RECONCILABLE_STATUSES] as Array<'QUEUED' | 'RUNNING'> } },
    select: { id: true, status: true, priority: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: opts.limit ?? 10_000,
  })

  if (rows.length === 0) {
    await ctx.log('debug', 'Nothing outstanding — download queue and database agree')
    return { considered: 0, enqueued: 0, replaced: 0, alreadyPending: 0 }
  }

  const requests: ReconcilableRequest[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    priority: r.priority,
  }))
  const states = await readJobStates(requests.map((r) => downloadJobId(r.id)))
  const plan = planQueueReconciliation(requests, states)

  const pendingWork = plan.enqueue + plan.replace
  if (opts.autoLimit !== undefined && pendingWork > opts.autoLimit) {
    await ctx.log(
      'warn',
      `${pendingWork} download request(s) have no queue job behind them and will never run on their own`,
      {
        orphaned: pendingWork,
        autoLimit: opts.autoLimit,
        action:
          'Not released automatically — that many at once would start a mass download unannounced. Run "Reconcile download queue" from Settings or the Cmd+K palette when you want them to drain.',
      },
    )
    return {
      considered: plan.actions.length,
      enqueued: 0,
      replaced: 0,
      alreadyPending: plan.skip,
      heldBack: pendingWork,
    }
  }

  const queue = getQueue('download')
  let enqueued = 0
  let replaced = 0

  for (const action of plan.actions) {
    if (action.action === 'skip') continue

    if (action.action === 'replace') {
      // Removing first is mandatory, not tidiness: `add()` with an id that still exists
      // in completed/failed history returns the old job and adds nothing, with no error.
      const stale = await queue.getJob(action.jobId)
      await stale?.remove().catch(() => undefined)
      replaced += 1
    }

    await queue.add(
      'download',
      { requestId: action.requestId },
      { jobId: action.jobId, priority: action.priority },
    )
    enqueued += 1
  }

  if (enqueued > 0) {
    await ctx.log('info', `Reconciled ${enqueued} download request(s) into the queue`, {
      considered: plan.actions.length,
      enqueued,
      replaced,
      alreadyPending: plan.skip,
      note:
        'These rows existed in the database with no job behind them. They would never have run.',
    })
  }

  return {
    considered: plan.actions.length,
    enqueued,
    replaced,
    alreadyPending: plan.skip,
  }
}

/**
 * Create (or reuse) a request for one source track and guarantee a job behind it.
 *
 * The single entry point for "I want this track". Reusing an existing row rather than
 * adding another keeps one request per recording (plan.md §2.1) while still ensuring the
 * queue side exists — which is precisely what the old skip-if-exists logic got wrong: it
 * treated "a row already exists" as "the work is already scheduled", and for 168 rows it
 * was not.
 */
export async function requestDownload(
  sourceTrackId: string,
  opts: { priority?: number; retryAbandoned?: boolean } = {},
): Promise<{ requestId: string; created: boolean; enqueued: boolean }> {
  const sourceTrack = await prisma.sourceTrack.findUnique({ where: { id: sourceTrackId } })
  if (!sourceTrack) throw new Error(`Source track ${sourceTrackId} no longer exists`)

  const eligibility = canonicalYouTubeEligibility(sourceTrack)
  if (!eligibility.eligible) throw new Error(eligibility.error)

  const existing = await prisma.downloadRequest.findUnique({
    where: { sourceTrackId },
  })

  // Already satisfied, or deliberately held — leave both alone.
  if (existing && (existing.status === 'SUCCEEDED' || existing.status === 'MANUAL_HOLD')) {
    return { requestId: existing.id, created: false, enqueued: false }
  }

  // ABANDONED means every provider was asked and none had it; FAILED means an attempt
  // hit something temporary. Both stay put until a retry is explicitly asked for — an
  // automatic retry loop against a provider that is rate-limiting us just burns the
  // limit harder — but both are recoverable, unlike the old behaviour where a throttled
  // request was written off permanently.
  if (
    existing &&
    (existing.status === 'ABANDONED' || existing.status === 'FAILED') &&
    !opts.retryAbandoned
  ) {
    return { requestId: existing.id, created: false, enqueued: false }
  }

  const request = existing
    ? await prisma.downloadRequest.update({
        where: { id: existing.id },
        data: {
          status: 'QUEUED',
          lastError: null,
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        },
      })
    : await prisma.downloadRequest.upsert({
        where: { sourceTrackId },
        create: {
          sourceTrackId,
          status: 'QUEUED',
          ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        },
        // A concurrent caller may have created the row after our read. Preserve that
        // exact request/job identity and merely converge it to the requested priority.
        update: { ...(opts.priority !== undefined ? { priority: opts.priority } : {}) },
      })

  const enqueued = await ensureJobFor(request.id, request.priority)
  return { requestId: request.id, created: existing === null, enqueued }
}

/**
 * Guarantee a pending job for one request id. Returns whether anything was added.
 *
 * Shared by `requestDownload` and the reconciler so the "remove a finished job before
 * re-adding" rule lives in exactly one place.
 */
export async function ensureJobFor(requestId: string, priority: number): Promise<boolean> {
  const queue = getQueue('download')
  const id = downloadJobId(requestId)

  const existing = await queue.getJob(id)
  if (existing) {
    const state = (await existing.getState()) as QueueJobState
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return false
    await existing.remove().catch(() => undefined)
  }

  await queue.add(
    'download',
    { requestId },
    { jobId: id, priority: bullPriority(priority) },
  )
  return true
}
