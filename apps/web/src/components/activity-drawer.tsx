'use client'

/**
 * Persistent activity drawer, fed by SSE. PROMPT.md §9 explicitly rejects toasts for
 * this app: the work is long-running, so a notification that disappears is the wrong
 * shape. This stays docked, collapsed to a single status line until something is
 * happening.
 *
 * Amber appears here and almost nowhere else — that is the point of §9's colour rule.
 */

import { useEffect, useState } from 'react'
import { SegmentedMeter } from './meter'

interface ProgressEvent {
  jobRunId: string
  queue: string
  name: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PAUSED'
  progress: number
  total?: number
  message?: string
  at: string
}

export function ActivityDrawer() {
  const [jobs, setJobs] = useState<Record<string, ProgressEvent>>({})
  const [open, setOpen] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ProgressEvent
        setJobs((prev) => {
          const next = { ...prev, [event.jobRunId]: event }
          // Drop finished jobs after a moment so the drawer reflects what is live.
          if (event.status === 'SUCCEEDED') {
            setTimeout(() => {
              setJobs((p) => {
                const { [event.jobRunId]: _removed, ...rest } = p
                return rest
              })
            }, 8000)
          }
          return next
        })
      } catch {
        // Malformed frame: ignore rather than tear down the stream.
      }
    }

    return () => source.close()
  }, [])

  const list = Object.values(jobs).sort((a, b) => b.at.localeCompare(a.at))
  const running = list.filter((j) => j.status === 'RUNNING')
  const problems = list.filter((j) => j.status === 'FAILED' || j.status === 'PAUSED')

  // Nothing happening and nothing wrong: stay out of the way entirely.
  if (list.length === 0) return null

  const headline =
    running.length > 0
      ? `${running.length} job${running.length === 1 ? '' : 's'} running`
      : problems.length > 0
        ? `${problems.length} need${problems.length === 1 ? 's' : ''} attention`
        : 'Idle'

  return (
    <aside
      className="fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-surface"
      aria-label="Activity"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-4 py-2 text-left transition-state hover:bg-recess md:px-8"
      >
        <span className="flex items-center gap-3">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              running.length > 0 ? 'bg-accent' : problems.length > 0 ? 'bg-error' : 'bg-ink-muted/40'
            }`}
            aria-hidden
          />
          <span className="label">Activity</span>
          <span className="text-sm text-ink">{headline}</span>
        </span>
        <span className="data text-xs text-ink-muted">
          {connected ? (open ? 'hide' : 'show') : 'reconnecting'}
        </span>
      </button>

      {open && (
        <ul className="max-h-72 overflow-y-auto border-t border-hairline">
          {list.map((job) => (
            <li key={job.jobRunId} className="border-b border-hairline px-4 py-2.5 md:px-8">
              <div className="flex items-baseline justify-between gap-4">
                <span className="data text-xs text-ink">
                  {job.queue} · {job.name}
                </span>
                <span
                  className={`data text-[11px] uppercase ${
                    job.status === 'FAILED'
                      ? 'text-error'
                      : job.status === 'PAUSED'
                        ? 'text-warn'
                        : job.status === 'SUCCEEDED'
                          ? 'text-ok'
                          : 'text-ink-muted'
                  }`}
                >
                  {job.status}
                </span>
              </div>
              {job.message && (
                <p className="mt-1 truncate text-xs text-ink-muted">{job.message}</p>
              )}
              {job.status === 'RUNNING' && (
                <SegmentedMeter
                  value={(job.progress ?? 0) / 100}
                  tone="active"
                  size="sm"
                  className="mt-2"
                  aria-label={`${job.name} progress`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
