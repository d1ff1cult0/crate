/**
 * Keeping the download queue and the database in agreement.
 *
 * A `DownloadRequest` row and a BullMQ job are two halves of one intention, written to
 * two different stores with no transaction between them. Nothing reconciled them, and the
 * halves drifted apart in production: 168 rows sat at QUEUED with **no jobs in Redis at
 * all**, no attempts, no job runs, and — worst of all — no errors. Nothing had failed.
 * The work had simply never been asked for.
 *
 * Two failure modes produced that, and this module exists to make both recoverable:
 *
 *  1. **A producer wrote the row and forgot the job.** The "fill gaps" action created
 *     rows and returned. Fixed at the call site, but a fix that only covers the producer
 *     we know about leaves the next one free to make the same mistake silently.
 *
 *  2. **Re-enqueueing looked like it worked and did nothing.** BullMQ ignores `add()`
 *     when a job with that id already exists in *any* state, including `completed` and
 *     `failed`, which are retained by `removeOnComplete`/`removeOnFail`. Verified
 *     directly: re-adding a completed id returns the old job, leaves the queue empty, and
 *     reports no error. Any recovery built on a deterministic id therefore has to clear
 *     the finished job first or it silently no-ops — the exact shape of the original bug.
 *
 * The planning is pure so it can be tested without Redis. The caller supplies what the
 * queue currently holds; this decides what to do about it.
 */

/** Deterministic job id for a request. Stable, so double-enqueueing is a no-op. */
export function downloadJobId(requestId: string): string {
  // BullMQ rejects ":" in a custom id (DECISIONS A19), hence the double underscore.
  return `dl__${requestId.replace(/[:\s]+/g, '-')}`
}

/**
 * BullMQ job states, split by what they mean for reconciliation.
 *
 * Everything that will still run is *pending* — leave it alone. `completed` and `failed`
 * are *finished*: the id is still occupied and still blocks `add()`, but nothing is going
 * to run it.
 *
 * **`prioritized` is the one that catches people, including me.** A job added with a
 * `priority` does not go into the waiting list at all: its state is `prioritized` and it
 * is counted separately from `wait`. Since download jobs are always given a priority,
 * omitting it here classified *every* healthy job as finished — so each reconcile would
 * remove and re-add all of them, churning forever and yanking jobs out from under the
 * worker as they were about to run. Caught by asserting on the queue counts after a real
 * reconcile rather than trusting the enqueue tally.
 */
export type QueueJobState =
  | 'waiting'
  | 'waiting-children'
  | 'prioritized'
  | 'active'
  | 'delayed'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'unknown'

const PENDING_STATES: ReadonlySet<QueueJobState> = new Set<QueueJobState>([
  'waiting',
  'waiting-children',
  'prioritized',
  'active',
  'delayed',
  'paused',
])

export function isPendingState(state: QueueJobState): boolean {
  return PENDING_STATES.has(state)
}

export interface ReconcilableRequest {
  id: string
  status: string
  priority: number
}

export type ReconcileAction =
  /** No job exists for this request: add one. */
  | { action: 'enqueue'; requestId: string; jobId: string; priority: number }
  /**
   * A finished job still occupies the id. It must be REMOVED before adding, or the add
   * is silently ignored and the request stays stuck exactly as it is now.
   */
  | { action: 'replace'; requestId: string; jobId: string; priority: number; staleState: QueueJobState }
  /** A pending job already exists — leave it alone. */
  | { action: 'skip'; requestId: string; jobId: string; reason: string }

export interface ReconcilePlan {
  actions: ReconcileAction[]
  enqueue: number
  replace: number
  skip: number
}

/** Statuses whose rows are *supposed* to have a job backing them. */
export const RECONCILABLE_STATUSES: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING'])

/**
 * Decide what the queue needs so every outstanding request has a job behind it.
 *
 * `RUNNING` is included deliberately. A request is marked RUNNING by the job that picked
 * it up, so a RUNNING row with no pending job means the worker died mid-flight — the
 * request is orphaned and will never move again on its own. Those are exactly the ones a
 * human would never think to look for.
 *
 * BullMQ priority is inverted from ours: it treats *lower* numbers as more urgent, while
 * `DownloadRequest.priority` counts playlist memberships, so higher is more wanted.
 */
export function planQueueReconciliation(
  requests: ReconcilableRequest[],
  jobStates: Map<string, QueueJobState>,
): ReconcilePlan {
  const actions: ReconcileAction[] = []

  for (const request of requests) {
    if (!RECONCILABLE_STATUSES.has(request.status)) continue

    const jobId = downloadJobId(request.id)
    const state = jobStates.get(jobId)
    const priority = bullPriority(request.priority)

    if (state === undefined) {
      actions.push({ action: 'enqueue', requestId: request.id, jobId, priority })
      continue
    }
    if (isPendingState(state)) {
      actions.push({
        action: 'skip',
        requestId: request.id,
        jobId,
        reason: `a ${state} job already exists`,
      })
      continue
    }
    actions.push({
      action: 'replace',
      requestId: request.id,
      jobId,
      priority,
      staleState: state,
    })
  }

  return {
    actions,
    enqueue: actions.filter((a) => a.action === 'enqueue').length,
    replace: actions.filter((a) => a.action === 'replace').length,
    skip: actions.filter((a) => a.action === 'skip').length,
  }
}

/**
 * Our priority (higher = more wanted) → BullMQ's (lower = runs sooner).
 *
 * Clamped to 1 at the top because BullMQ treats 0 as "no priority", which sorts
 * differently from priority 1 rather than being the most urgent value.
 */
export function bullPriority(priority: number): number {
  return Math.min(1000, Math.max(1, 100 - priority))
}
