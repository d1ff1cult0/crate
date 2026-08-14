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
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  })
  try {
    const q = new Queue(queue, { connection })
    await q.add(name, data, {
      ...(opts.jobId ? { jobId: opts.jobId } : {}),
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    })
    await q.close()
  } finally {
    await connection.quit()
  }
}
