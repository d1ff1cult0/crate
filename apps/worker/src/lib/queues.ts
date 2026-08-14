/**
 * Queue definitions. PROMPT.md §4 — one queue per concern, each with its own
 * concurrency and rate limits so a throttled provider cannot stall the rest.
 *
 * `spotify-isrc-backfill` is the tenth queue, added per docs/spotify-api-state.md
 * finding A: album-sourced tracks have no ISRC and need one request each. It runs at
 * the lowest concurrency so it can never starve the primary harvest, which is the only
 * work with a real deadline.
 */

import { Queue, QueueEvents, Worker, type JobsOptions, type Processor } from 'bullmq'
import { Redis } from 'ioredis'

export const QUEUE_NAMES = [
  'spotify-sync',
  'spotify-isrc-backfill',
  'library-scan',
  'match',
  'download',
  'postprocess',
  'fingerprint',
  'playlist-write',
  'recommend',
  'maintenance',
] as const

export type QueueName = (typeof QUEUE_NAMES)[number]

export interface QueueConfig {
  concurrency: number
  /** BullMQ limiter: at most `max` jobs per `duration` ms. */
  limiter?: { max: number; duration: number }
}

/**
 * Defaults tuned for the target box: an i5-8400 (6 cores) also running Navidrome,
 * Jellyfin, Lidarr, qBittorrent and Ollama. Conservative on purpose — see
 * docs/DECISIONS.md A8. All are overridable from settings.
 */
export const QUEUE_DEFAULTS: Record<QueueName, QueueConfig> = {
  // One at a time: the harvest is a single coherent resumable pass, and running two
  // would double the request rate against an undocumented rate limit.
  'spotify-sync': { concurrency: 1 },
  // Lowest priority work in the system. One worker, hard-limited.
  'spotify-isrc-backfill': { concurrency: 1, limiter: { max: 20, duration: 10_000 } },
  'library-scan': { concurrency: 1 },
  match: { concurrency: 2 },
  download: { concurrency: 3 },
  postprocess: { concurrency: 2 },
  // CPU-heavy; must never starve the box (§7.4).
  fingerprint: { concurrency: 2 },
  'playlist-write': { concurrency: 1 },
  recommend: { concurrency: 1 },
  maintenance: { concurrency: 1 },
}

let connection: Redis | null = null

export function getRedis(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      // BullMQ requires this to be null so blocking commands work.
      maxRetriesPerRequest: null,
    })
  }
  return connection
}

/** A second connection for pub/sub — a subscriber cannot issue normal commands. */
export function createSubscriber(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  })
}

const queues = new Map<QueueName, Queue>()

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, {
      connection: getRedis(),
      defaultJobOptions: {
        // Keep enough history for the UI without unbounded growth; JobRun rows in
        // Postgres are the durable record, this is just BullMQ's own bookkeeping.
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    })
    queues.set(name, q)
  }
  return q
}

/**
 * Build a deterministic BullMQ job id from parts.
 *
 * BullMQ REJECTS custom ids containing ":" at runtime — it uses the colon as its own
 * Redis key separator, and the failure is an opaque "Custom Id cannot contain :" thrown
 * when the job is added, not when it is defined. Since colon-delimited ids are the
 * obvious thing to reach for, every id goes through here instead.
 */
export function jobId(...parts: Array<string | number>): string {
  return parts
    .map((p) => String(p).replace(/[:\s]+/g, '-'))
    .filter(Boolean)
    .join('__')
}

/**
 * Enqueue with a DETERMINISTIC job id (§4: "Idempotency everywhere"). BullMQ refuses a
 * duplicate id while the job is active or waiting, so re-running a sync converges
 * rather than duplicating.
 */
export async function enqueue(
  name: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts: JobsOptions & { jobId?: string } = {},
): Promise<string | undefined> {
  const job = await getQueue(name).add(jobName, data, opts)
  return job.id
}

export function createWorker(
  name: QueueName,
  processor: Processor,
  overrides: Partial<QueueConfig> = {},
): Worker {
  const cfg = { ...QUEUE_DEFAULTS[name], ...overrides }
  return new Worker(name, processor, {
    connection: getRedis(),
    concurrency: cfg.concurrency,
    ...(cfg.limiter ? { limiter: cfg.limiter } : {}),
  })
}

export function createQueueEvents(name: QueueName): QueueEvents {
  return new QueueEvents(name, { connection: getRedis() })
}

export async function closeAll(): Promise<void> {
  for (const q of queues.values()) await q.close()
  queues.clear()
  if (connection) {
    await connection.quit()
    connection = null
  }
}
