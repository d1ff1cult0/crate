'use client'

import { useCallback, useEffect, useState } from 'react'
import { SegmentedMeter } from './meter'
import { Badge, Button, EmptyState, Panel, Readout } from './ui'

type Status = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
interface ImportRun {
  id: string
  status: Status
  input: string | null
  playlistName: string | null
  tracksFound: number
  tracksNew: number
  tracksDuplicate: number
  tracksAvailable: number
  tracksSucceeded: number
  tracksFailed: number
  message: string | null
  detailJson: { invalidEntries?: number; errors?: string[] } | null
  createdAt: string
  updatedAt: string
  progress: number
  error: string | null
}

const tone = (status: Status) => status === 'SUCCEEDED' ? 'ok' : status === 'PARTIAL' ? 'warn' : status === 'FAILED' ? 'error' : status === 'RUNNING' ? 'active' : 'idle'

export function YouTubePlaylistImport({ initialRuns }: { initialRuns: ImportRun[] }) {
  const [url, setUrl] = useState('')
  const [runs, setRuns] = useState(initialRuns)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const response = await fetch('/api/import/youtube', { cache: 'no-store' })
    if (response.ok) setRuns(await response.json() as ImportRun[])
  }, [])

  useEffect(() => {
    if (!runs.some((run) => run.status === 'QUEUED' || run.status === 'RUNNING')) return
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(timer)
  }, [refresh, runs])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch('/api/import/youtube', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not queue the playlist.')
      setUrl('')
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return <div className="space-y-6">
    <Panel title="YouTube playlist URL">
      <form onSubmit={submit} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="label">Playlist address</span>
          <input
            type="url" required value={url} onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/playlist?list=…"
            className="data w-full rounded-[4px] border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
            Crate keeps the first occurrence of a repeated video, reuses recordings already in your library, and preserves unavailable entries as visible gaps. Rerunning the same URL updates the same Crate playlist.
          </p>
          <Button variant="primary" disabled={submitting || !url.trim()}>
            {submitting ? 'Queueing…' : 'Import playlist'}
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
      </form>
    </Panel>

    <Panel title="Import history">
      {runs.length === 0 ? <EmptyState title="No YouTube playlists imported">
        Paste a public or unlisted YouTube playlist URL above. Resolution and downloads run in the worker, so closing this page does not interrupt them.
      </EmptyState> : <ul className="divide-y divide-hairline">
        {runs.map((run) => {
          const total = run.tracksFound
          const coverage = total > 0 ? run.tracksAvailable / total : Math.max(0, run.progress / 100)
          const problems = [...(run.detailJson?.errors ?? []), ...(run.error ? [run.error] : [])]
          return <li key={run.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-medium text-ink">{run.playlistName ?? 'Reading playlist metadata…'}</h3>
                  <Badge tone={tone(run.status)}>{run.status.toLowerCase()}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-muted">{run.message ?? 'Queued.'}</p>
              </div>
              <span className="data text-[11px] text-ink-muted">{new Date(run.createdAt).toLocaleString()}</span>
            </div>
            <SegmentedMeter value={coverage} tone={run.status === 'RUNNING' ? 'active' : run.status === 'FAILED' ? 'error' : run.status === 'PARTIAL' ? 'warn' : 'ok'} aria-label={`${run.playlistName ?? 'Playlist'} import coverage`} />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Readout label="Playlist" value={total || '—'} />
              <Readout label="New source" value={run.tracksNew} />
              <Readout label="Duplicates" value={run.tracksDuplicate} />
              <Readout label="Available" value={run.tracksAvailable} tone={run.tracksAvailable > 0 ? 'ok' : undefined} />
              <Readout label="Failed" value={run.tracksFailed + (run.detailJson?.invalidEntries ?? 0)} tone={problems.length ? 'error' : undefined} />
            </div>
            {problems.length > 0 && <details className="recess rounded-[4px] border border-hairline px-3 py-2">
              <summary className="label cursor-pointer">Useful errors ({problems.length})</summary>
              <ul className="mt-2 space-y-1 data text-xs text-error">{problems.slice(0, 20).map((problem, index) => <li key={`${problem}-${index}`}>{problem}</li>)}</ul>
            </details>}
          </li>
        })}
      </ul>}
    </Panel>
  </div>
}
