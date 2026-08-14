/**
 * JobRun tracking and progress publishing.
 *
 * PROMPT.md §4: "Every job writes a JobRun row with structured logs, so the UI has real
 * history and I can debug a failed download from three days ago without SSH."
 *
 * Progress goes two places: the JobRun row (durable, survives restarts, what the UI
 * reads on load) and a Redis pub/sub channel (ephemeral, what the SSE endpoint streams
 * live). Neither is authoritative alone — the row is the record, the channel is the
 * notification.
 */

import { prisma, type JobStatus } from '@crate/db'
import type { Redis } from 'ioredis'
import { getRedis, type QueueName } from './queues.js'

export const PROGRESS_CHANNEL = 'crate:progress'

export interface ProgressEvent {
  jobRunId: string
  queue: string
  name: string
  status: JobStatus
  progress: number
  total?: number | undefined
  message?: string | undefined
  at: string
}

export interface LogLine {
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  msg: string
  [key: string]: unknown
}

/**
 * Handle for one running job. Owns its JobRun row and batches log writes so a chatty
 * job doesn't issue a database round trip per line.
 */
export class JobRunContext {
  readonly id: string
  readonly queue: QueueName
  readonly name: string
  private logs: LogLine[] = []
  private lastFlush = Date.now()
  private progress = 0
  private total: number | undefined
  private readonly redis: Redis

  private constructor(id: string, queue: QueueName, name: string, redis: Redis) {
    this.id = id
    this.queue = queue
    this.name = name
    this.redis = redis
  }

  /**
   * Begin (or resume) the run record for one job.
   *
   * `JobRun` is unique on `(queue, jobId)` and BullMQ reuses the job id across retries —
   * so the obvious `create` here threw "Unique constraint failed on the fields:
   * (queue, jobId)" on the *second* attempt of anything that failed once. That is a
   * uniquely bad failure mode: it replaces the real error with a bookkeeping one, so the
   * log shows a Prisma constraint violation instead of whatever actually went wrong, and
   * every remaining retry dies the same way. Found in production when a broken index
   * made the fingerprint queue fail on every file.
   *
   * Retrying therefore reuses the row rather than fighting the constraint. Previous
   * logs are deliberately KEPT and appended to — when a job is on its third attempt, the
   * first two failures are exactly what you came to read.
   */
  static async start(
    queue: QueueName,
    name: string,
    payload?: Record<string, unknown>,
    bullJobId?: string,
  ): Promise<JobRunContext> {
    const fresh = {
      queue,
      name,
      status: 'RUNNING' as const,
      ...(bullJobId ? { jobId: bullJobId } : {}),
      ...(payload ? { payload: payload as object } : {}),
    }

    // A null jobId is not covered by the unique constraint (Postgres treats NULLs as
    // distinct), so an untracked job just gets its own row.
    if (!bullJobId) {
      const row = await prisma.jobRun.create({ data: fresh })
      const ctx = new JobRunContext(row.id, queue, name, getRedis())
      await ctx.log('info', `${name} started`)
      return ctx
    }

    const row = await prisma.jobRun.upsert({
      where: { queue_jobId: { queue, jobId: bullJobId } },
      create: fresh,
      update: {
        name,
        status: 'RUNNING',
        progress: 0,
        // Clearing these matters: a row left with the previous attempt's endedAt and
        // error would render in the UI as a finished, failed job while it is running.
        endedAt: null,
        error: null,
        ...(payload ? { payload: payload as object } : {}),
      },
    })

    const ctx = new JobRunContext(row.id, queue, name, getRedis())
    // A row that already carries log lines is one that has run before. No extra query
    // needed, and the label is cosmetic — the lines themselves are the useful part.
    const isRetry = Array.isArray(row.logsJson) && row.logsJson.length > 0
    await ctx.log('info', isRetry ? `${name} retrying after an earlier attempt` : `${name} started`)
    return ctx
  }

  async log(level: LogLine['level'], msg: string, extra?: Record<string, unknown>): Promise<void> {
    this.logs.push({ ts: new Date().toISOString(), level, msg, ...(extra ?? {}) })
    // Flush on error immediately — that's the line someone will come looking for.
    if (level === 'error' || Date.now() - this.lastFlush > 2000 || this.logs.length > 50) {
      await this.flush()
    }
  }

  async setProgress(done: number, total?: number, message?: string): Promise<void> {
    this.progress = total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : done
    this.total = total
    await this.publish('RUNNING', message)

    // Throttled persistence: the live view comes from pub/sub, the row only needs to be
    // roughly current for a page load.
    if (Date.now() - this.lastFlush > 2000) await this.flush()
  }

  private async publish(status: JobStatus, message?: string): Promise<void> {
    const event: ProgressEvent = {
      jobRunId: this.id,
      queue: this.queue,
      name: this.name,
      status,
      progress: this.progress,
      total: this.total,
      message,
      at: new Date().toISOString(),
    }
    try {
      await this.redis.publish(PROGRESS_CHANNEL, JSON.stringify(event))
    } catch {
      // A dead pub/sub connection must never fail the job it is reporting on.
    }
  }

  private async flush(): Promise<void> {
    this.lastFlush = Date.now()
    if (this.logs.length === 0) return
    const existing = await prisma.jobRun.findUnique({
      where: { id: this.id },
      select: { logsJson: true },
    })
    const prior = Array.isArray(existing?.logsJson) ? (existing.logsJson as unknown[]) : []
    // Cap retained lines so one runaway job cannot bloat the row.
    const merged = [...prior, ...this.logs].slice(-2000)
    this.logs = []
    await prisma.jobRun.update({
      where: { id: this.id },
      data: { logsJson: merged as object, progress: this.progress },
    })
  }

  async succeed(message?: string): Promise<void> {
    if (message) await this.log('info', message)
    this.progress = 100
    await this.flush()
    await prisma.jobRun.update({
      where: { id: this.id },
      data: { status: 'SUCCEEDED', progress: 100, endedAt: new Date() },
    })
    await this.publish('SUCCEEDED', message)
  }

  async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.log('error', message, {
      stack: error instanceof Error ? error.stack : undefined,
    })
    await this.flush()
    await prisma.jobRun.update({
      where: { id: this.id },
      data: { status: 'FAILED', error: message, endedAt: new Date() },
    })
    await this.publish('FAILED', message)
  }

  /**
   * Paused, not failed. Used when Spotify reports QUOTA_EXCEEDED: the work is
   * checkpointed and will resume, and presenting that as a failure would be misleading
   * (spotify-api-state.md finding C).
   */
  async pause(message: string): Promise<void> {
    await this.log('warn', message)
    await this.flush()
    await prisma.jobRun.update({
      where: { id: this.id },
      data: { status: 'PAUSED', error: message, endedAt: new Date() },
    })
    await this.publish('PAUSED', message)
  }
}

/** Wrap a job body so every path writes a terminal JobRun state exactly once. */
export async function withJobRun<T>(
  queue: QueueName,
  name: string,
  payload: Record<string, unknown> | undefined,
  bullJobId: string | undefined,
  body: (ctx: JobRunContext) => Promise<T>,
): Promise<T> {
  const ctx = await JobRunContext.start(queue, name, payload, bullJobId)
  try {
    const result = await body(ctx)
    await ctx.succeed()
    return result
  } catch (err) {
    await ctx.fail(err)
    throw err
  }
}
