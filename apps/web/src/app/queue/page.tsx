/**
 * Queue — PROMPT.md §8: "everything downloading, with the provider chain visible per
 * item and why attempts failed."
 *
 * Two things this screen has to get right:
 *
 *  - **What is happening right now.** RUNNING items are pulled to the top and marked,
 *    with the live job progress beside them. A queue that does not distinguish "in
 *    flight" from "waiting" is just a list.
 *  - **Honest totals.** Counts come from grouped queries over the whole table, and the
 *    list is a real page of 50 — not the first 200 rows with their length shown as the
 *    total.
 */

import { paginate, parsePageRequest } from '@crate/core'
import { prisma } from '@crate/db'
import { JobButton } from '../../components/job-button'
import { SegmentedMeter } from '../../components/meter'
import { Pager } from '../../components/pagination'
import { Badge, EmptyState, Panel, Readout } from '../../components/ui'

export const dynamic = 'force-dynamic'

const STATUS_TONE = {
  QUEUED: 'idle',
  RUNNING: 'active',
  SUCCEEDED: 'ok',
  FAILED: 'warn',
  ABANDONED: 'error',
  MANUAL_HOLD: 'warn',
} as const

/** Waiting work first, then history — the queue is a to-do list, not an archive. */
const STATUS_ORDER: Record<string, number> = {
  RUNNING: 0,
  QUEUED: 1,
  FAILED: 2,
  ABANDONED: 3,
  MANUAL_HOLD: 4,
  SUCCEEDED: 5,
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; status?: string }>
}) {
  const params = await searchParams
  const request = parsePageRequest(params)
  const statusFilter = params.status

  const where = statusFilter
    ? { status: statusFilter as 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED' | 'MANUAL_HOLD' }
    : {}

  const [counts, total, activeJobs] = await Promise.all([
    prisma.downloadRequest.groupBy({ by: ['status'], _count: true }),
    prisma.downloadRequest.count({ where }),
    // The live view: jobs actually executing, with their progress.
    prisma.jobRun.findMany({
      where: { queue: { in: ['download', 'postprocess'] }, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
      take: 10,
    }),
  ])

  const pagination = paginate(request, total)

  const requests = await prisma.downloadRequest.findMany({
    where,
    orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
    skip: pagination.skip,
    take: pagination.take,
    include: {
      sourceTrack: { select: { title: true, artists: true, album: true } },
      attempts: { orderBy: { createdAt: 'asc' }, take: 8 },
    },
  })

  // Prisma orders by the enum's declaration order, which is not the order a person wants
  // to read; re-sort the page so anything in flight is at the top of it.
  const ordered = [...requests].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
  )

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>
  const running = byStatus.RUNNING ?? 0
  const queued = byStatus.QUEUED ?? 0

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
            Queue
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Downloads in flight, with every provider attempt and why it failed.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <JobButton job="download-reconcile" label="Reconcile queue" />
          <JobButton job="download-retry-abandoned" label="Retry failed" />
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ['Running', running, running > 0 ? 'warn' : undefined],
            ['Queued', queued, undefined],
            ['Done', byStatus.SUCCEEDED ?? 0, 'ok'],
            ['Failed', byStatus.FAILED ?? 0, (byStatus.FAILED ?? 0) > 0 ? 'warn' : undefined],
            ['Couldn’t find', byStatus.ABANDONED ?? 0, (byStatus.ABANDONED ?? 0) > 0 ? 'error' : undefined],
            ['On hold', byStatus.MANUAL_HOLD ?? 0, undefined],
          ] as const
        ).map(([label, value, tone]) => (
          <Panel key={label}>
            <Readout label={label} value={value.toLocaleString()} {...(tone ? { tone } : {})} />
          </Panel>
        ))}
      </div>

      {/* What is happening right now, as opposed to what is waiting. */}
      <Panel title={running > 0 ? `Downloading now — ${running}` : 'Downloading now'}>
        {activeJobs.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing is executing this second.{' '}
            {queued > 0
              ? `${queued.toLocaleString()} request${queued === 1 ? '' : 's'} waiting — the worker takes them a few at a time.`
              : 'The queue is empty.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {activeJobs.map((job) => (
              <li key={job.id} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="data text-xs text-ink">
                    {job.queue} · {job.name}
                  </span>
                  <Badge tone="active">{job.progress}%</Badge>
                </div>
                <SegmentedMeter
                  value={job.progress / 100}
                  tone="active"
                  size="sm"
                  aria-label="download progress"
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={statusFilter ? `Requests — ${statusFilter}` : 'Requests'}
        action={
          statusFilter ? (
            <a href="/queue" className="text-xs text-ink-muted underline">
              Clear filter
            </a>
          ) : undefined
        }
      >
        {ordered.length === 0 ? (
          <EmptyState title="Nothing in the queue">
            Tracks arrive here when you queue a download from Review, when a playlist
            import finds something you don&rsquo;t own yet, or from &ldquo;download all
            missing&rdquo; on the Overview.
          </EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-hairline">
              {ordered.map((req) => (
                <li
                  key={req.id}
                  className={`py-3 first:pt-0 last:pb-0 ${req.status === 'RUNNING' ? '-mx-2 rounded-[3px] bg-accent/5 px-2 ring-1 ring-accent/25' : ''}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-ink">{req.sourceTrack.title}</div>
                      <div className="truncate text-xs text-ink-muted">
                        {req.sourceTrack.artists.join(', ')}
                        {req.sourceTrack.album ? ` · ${req.sourceTrack.album}` : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {req.status === 'RUNNING' && (
                        <span className="text-xs text-warn">downloading…</span>
                      )}
                      <Badge tone={STATUS_TONE[req.status] ?? 'idle'}>{req.status}</Badge>
                    </div>
                  </div>

                  {req.attempts.length > 0 && (
                    <ol className="mt-2 space-y-1">
                      {req.attempts.map((attempt) => (
                        <li key={attempt.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="data text-ink">{attempt.provider}</span>
                          <span
                            className={
                              attempt.outcome === 'SUCCESS'
                                ? 'text-ok'
                                : attempt.outcome === 'NO_RESULTS'
                                  ? 'text-ink-muted'
                                  : 'text-error'
                            }
                          >
                            {attempt.outcome.toLowerCase().replace(/_/g, ' ')}
                          </span>
                          {attempt.detail && (
                            <span className="min-w-0 flex-1 truncate text-ink-muted" title={attempt.detail}>
                              — {attempt.detail}
                            </span>
                          )}
                          {attempt.durationMs != null && (
                            <span className="data shrink-0 text-ink-muted">
                              {(attempt.durationMs / 1000).toFixed(1)}s
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}

                  {req.status === 'ABANDONED' && (
                    <p className="mt-2 text-xs text-ink-muted">
                      Every provider was tried and none had it. Paste a direct URL to fetch
                      it manually, or leave it — the next match sweep will pick it up if it
                      turns out you already own it.
                    </p>
                  )}
                  {req.status === 'FAILED' && (
                    <p className="mt-2 text-xs text-ink-muted">
                      A temporary failure, not a verdict — the provider errored, timed out
                      or rate-limited us. &ldquo;Retry failed&rdquo; puts it back in the queue.
                    </p>
                  )}
                  {req.lastError && req.status !== 'FAILED' && (
                    <p className="mt-1 text-xs text-error">{req.lastError}</p>
                  )}
                </li>
              ))}
            </ul>

            <div className="pt-3">
              <Pager
                pagination={pagination}
                basePath="/queue"
                noun="request"
                {...(statusFilter ? { extraParams: { status: statusFilter } } : {})}
              />
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}
