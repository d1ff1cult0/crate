/**
 * Queue — PROMPT.md §8: "everything downloading, with the provider chain visible per
 * item and why attempts failed."
 *
 * The failure detail is the point. §7.5 requires the scored candidate list to be logged
 * on every attempt so that when a wrong track lands, it's possible to see why it won —
 * this screen is where that gets read.
 */

import { prisma } from '@crate/db'
import { SegmentedMeter } from '../../components/meter'
import { Badge, EmptyState, Panel, Readout } from '../../components/ui'

export const dynamic = 'force-dynamic'

const STATUS_TONE = {
  QUEUED: 'idle',
  RUNNING: 'active',
  SUCCEEDED: 'ok',
  FAILED: 'error',
  ABANDONED: 'error',
  MANUAL_HOLD: 'warn',
} as const

export default async function QueuePage() {
  const [requests, counts, jobs] = await Promise.all([
    prisma.downloadRequest.findMany({
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
      take: 100,
      include: {
        sourceTrack: { select: { title: true, artists: true, album: true } },
        attempts: { orderBy: { createdAt: 'asc' } },
      },
    }),
    prisma.downloadRequest.groupBy({ by: ['status'], _count: true }),
    prisma.jobRun.findMany({
      where: { status: { in: ['RUNNING', 'PAUSED'] } },
      orderBy: { startedAt: 'desc' },
      take: 10,
    }),
  ])

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<
    string,
    number
  >
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const done = byStatus.SUCCEEDED ?? 0

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Queue
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Downloads in flight, with every provider attempt and why it failed.
        </p>
      </header>

      {jobs.length > 0 && (
        <Panel title="Running now">
          <ul className="space-y-3">
            {jobs.map((job) => (
              <li key={job.id} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="data text-xs text-ink">
                    {job.queue} · {job.name}
                  </span>
                  <Badge tone={job.status === 'PAUSED' ? 'warn' : 'active'}>{job.status}</Badge>
                </div>
                <SegmentedMeter
                  value={job.progress / 100}
                  tone={job.status === 'PAUSED' ? 'warn' : 'active'}
                  size="sm"
                  aria-label={`${job.name} progress`}
                />
                {job.error && <p className="text-xs text-warn">{job.error}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {total > 0 && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Panel>
            <Readout label="Queued" value={byStatus.QUEUED ?? 0} />
          </Panel>
          <Panel>
            <Readout label="Running" value={byStatus.RUNNING ?? 0} />
          </Panel>
          <Panel>
            <Readout label="Done" value={done} tone="ok" />
          </Panel>
          <Panel>
            <Readout
              label="Couldn't find"
              value={byStatus.ABANDONED ?? 0}
              tone={(byStatus.ABANDONED ?? 0) > 0 ? 'error' : undefined}
            />
          </Panel>
        </div>
      )}

      <Panel title="Downloads">
        {requests.length === 0 ? (
          <EmptyState title="Nothing in the queue">
            Tracks arrive here when you queue a download from Review, or when a playlist
            import finds something you don&rsquo;t own yet. Nothing downloads on its own
            until a provider is configured in Settings.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hairline">
            {requests.map((req) => (
              <li key={req.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-ink">{req.sourceTrack.title}</div>
                    <div className="truncate text-xs text-ink-muted">
                      {req.sourceTrack.artists.join(', ')}
                      {req.sourceTrack.album ? ` · ${req.sourceTrack.album}` : ''}
                    </div>
                  </div>
                  <Badge tone={STATUS_TONE[req.status] ?? 'idle'}>{req.status}</Badge>
                </div>

                {/* The provider chain: every attempt, in order, with its outcome. */}
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
                          <span className="text-ink-muted">— {attempt.detail}</span>
                        )}
                        {attempt.durationMs != null && (
                          <span className="data text-ink-muted">
                            {(attempt.durationMs / 1000).toFixed(1)}s
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}

                {req.status === 'ABANDONED' && (
                  <p className="mt-2 text-xs text-ink-muted">
                    Every provider was tried and none had it. Paste a direct URL to fetch it
                    manually, or leave it — the next match sweep will pick it up if it turns
                    out you already own it.
                  </p>
                )}
                {req.lastError && <p className="mt-1 text-xs text-error">{req.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
