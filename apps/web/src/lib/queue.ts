/**
 * Enqueueing from the web process.
 *
 * §4 is strict about this: route handlers exist for webhooks, SSE and the OAuth
 * callback. Anything that takes minutes — a download, a scan, a harvest, an LLM call —
 * runs in the worker and must survive a redeploy. So the web side never *does* the work;
 * it drops a job on a queue and returns immediately, and the UI watches progress over
 * SSE like everything else.
 *
 * Job ids are deterministic and go through `jobId()` for the same reason the worker's do:
 * BullMQ rejects a custom id containing ":" at enqueue time, which is exactly the
 * separator everyone reaches for first (DECISIONS A19).
 */

import { bullPriority, downloadJobId } from '@crate/core'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

export type QueueName =
  | 'spotify-sync'
  | 'spotify-isrc-backfill'
  | 'library-scan'
  | 'match'
  | 'download'
  | 'postprocess'
  | 'fingerprint'
  | 'playlist-write'
  | 'recommend'
  | 'maintenance'

/** Sanitised deterministic job id — BullMQ refuses ":" in a custom id. */
export function jobId(...parts: Array<string | number>): string {
  return parts
    .map((p) => String(p).replace(/[:\s]+/g, '-'))
    .filter(Boolean)
    .join('__')
}

/**
 * Add one job and close the connection.
 *
 * A short-lived connection per request rather than a module-level pool: Next.js route
 * handlers can be replaced or re-instantiated at will, and a leaked Redis client per
 * reload is a slow, confusing failure.
 */
export async function enqueueJob(
  queue: QueueName,
  name: string,
  data: Record<string, unknown> = {},
  opts: { jobId?: string } = {},
): Promise<void> {
  await withQueue(queue, async (q) => {
    await q.add(name, data, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    })
  })
}

/**
 * Run a batch of queue work over ONE connection.
 *
 * Filling the gaps in a large playlist touches hundreds of jobs; opening and quitting a
 * Redis connection per job would be absurd, and leaking one per request worse.
 */
export async function withQueue<T>(
  queue: QueueName,
  fn: (queue: Queue) => Promise<T>,
): Promise<T> {
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  })
  const q = new Queue(queue, { connection })
  try {
    return await fn(q)
  } finally {
    await q.close()
    await connection.quit()
  }
}

/**
 * Guarantee a pending download job for each request. Returns how many were added.
 *
 * Mirrors `ensureJobFor` in the worker, including the rule that matters most: a job id
 * still occupied by a **completed or failed** job blocks `add()` silently, so the stale
 * job has to be removed first. Skipping that is indistinguishable from success and leaves
 * the request stuck — which is the failure this whole change exists to fix.
 *
 * Takes the whole batch so one connection covers a playlist's worth of gaps.
 */
export async function ensureDownloadJobs(
  requests: Array<{ id: string; priority: number }>,
): Promise<number> {
  if (requests.length === 0) return 0

  return withQueue('download', async (queue) => {
    let added = 0

    for (const request of requests) {
      const id = downloadJobId(request.id)
      const existing = await queue.getJob(id)

      if (existing) {
        const state = await existing.getState()
        // A pending job is already going to run; leave it exactly as it is.
        if (state !== 'completed' && state !== 'failed' && state !== 'unknown') continue
        await existing.remove().catch(() => undefined)
      }

      await queue.add(
        'download',
        { requestId: request.id },
        {
          jobId: id,
          priority: bullPriority(request.priority),
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      )
      added += 1
    }

    return added
  })
}
