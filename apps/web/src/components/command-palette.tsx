'use client'

/**
 * Cmd+K command palette — PROMPT.md §8 (phase 8 polish).
 *
 * Two kinds of entry, and the distinction is visible rather than implied:
 *
 *  - **Go to** — navigation. Instant, reversible, harmless.
 *  - **Run** — enqueues a real job on the worker. Marked, and the destructive-adjacent
 *    ones say what they will and will not do, because a palette makes it very easy to
 *    fire something by muscle memory. Nothing that moves or deletes a file is reachable
 *    from here at all: applying a dedupe batch stays on the Duplicates screen behind its
 *    plan, which is the whole point of the plan.
 *
 * Search is a plain substring match over label and keywords. A fuzzy matcher would be
 * more impressive and would also happily rank "purge trash" first for the query "p".
 */

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface Command {
  id: string
  label: string
  keywords: string
  kind: 'navigate' | 'run'
  href?: string
  job?: string
  /** Shown under the label when the consequence is worth stating. */
  note?: string
}

const COMMANDS: Command[] = [
  { id: 'nav-overview', label: 'Go to Overview', keywords: 'home status dashboard', kind: 'navigate', href: '/' },
  { id: 'nav-setup', label: 'Go to Setup', keywords: 'wizard first run onboarding', kind: 'navigate', href: '/setup' },
  { id: 'nav-import', label: 'Go to Import', keywords: 'paste url csv gdpr export', kind: 'navigate', href: '/import' },
  { id: 'nav-playlists', label: 'Go to Playlists', keywords: 'm3u navidrome', kind: 'navigate', href: '/playlists' },
  { id: 'nav-queue', label: 'Go to Queue', keywords: 'downloads providers attempts', kind: 'navigate', href: '/queue' },
  { id: 'nav-review', label: 'Go to Review', keywords: 'matches confidence decide', kind: 'navigate', href: '/review' },
  { id: 'nav-duplicates', label: 'Go to Duplicates', keywords: 'dedupe trash keeper variants', kind: 'navigate', href: '/duplicates' },
  { id: 'nav-mixes', label: 'Go to Mixes', keywords: 'recommendations daily curator llm', kind: 'navigate', href: '/mixes' },
  { id: 'nav-library', label: 'Go to Library', keywords: 'files tracks search', kind: 'navigate', href: '/library' },
  { id: 'nav-settings', label: 'Go to Settings', keywords: 'paths connections spotify navidrome tuning', kind: 'navigate', href: '/settings' },

  { id: 'run-scan', label: 'Scan library', keywords: 'files new changed', kind: 'run', job: 'library-scan' },
  { id: 'run-scan-full', label: 'Full library reconcile', keywords: 'rescan everything', kind: 'run', job: 'library-scan-full', note: 'Re-reads every file. Slow on a large library.' },
  { id: 'run-match', label: 'Run match sweep', keywords: 'rematch missing coverage', kind: 'run', job: 'match-sweep' },
  { id: 'run-fingerprint', label: 'Run fingerprint sweep', keywords: 'chromaprint acoustid isrc mbid', kind: 'run', job: 'fingerprint-sweep', note: 'CPU-heavy, throttled, resumable.' },
  { id: 'run-spotify', label: 'Sync Spotify now', keywords: 'harvest playlists refresh', kind: 'run', job: 'spotify-sync' },
  { id: 'run-dedupe', label: 'Scan for duplicates', keywords: 'dedupe groups', kind: 'run', job: 'dedupe-scan', note: 'Groups only. Moves nothing.' },
  { id: 'run-downloads', label: 'Queue all missing downloads', keywords: 'acquire providers fetch', kind: 'run', job: 'download-missing' },
  { id: 'run-retry', label: 'Retry tracks nothing could find', keywords: 'abandoned failed', kind: 'run', job: 'download-retry-abandoned' },
  { id: 'run-taste', label: 'Refresh taste model', keywords: 'affinity play counts scrobbles', kind: 'run', job: 'taste-refresh' },
  { id: 'run-mixes', label: 'Regenerate mixes', keywords: 'daily recommendations clusters', kind: 'run', job: 'generate-mixes' },
  { id: 'run-radar', label: 'Check release radar', keywords: 'new releases musicbrainz', kind: 'run', job: 'release-radar' },
  { id: 'run-playlists', label: 'Rewrite every playlist', keywords: 'm3u write navidrome', kind: 'run', job: 'playlists-write-all' },
  { id: 'run-navidrome', label: 'Ask Navidrome to rescan', keywords: 'subsonic startscan', kind: 'run', job: 'navidrome-scan' },
]

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return COMMANDS
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.keywords.includes(q),
    )
  }, [query])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setCursor(0)
  }, [])

  const execute = useCallback(
    async (command: Command) => {
      if (command.kind === 'navigate' && command.href) {
        close()
        router.push(command.href)
        return
      }
      if (!command.job) return
      setStatus(`Queueing ${command.label.toLowerCase()}…`)
      try {
        const res = await fetch('/api/jobs/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job: command.job }),
        })
        const body = (await res.json()) as { description?: string; error?: string }
        setStatus(res.ok ? (body.description ?? 'Queued.') : (body.error ?? 'That did not work.'))
      } catch {
        setStatus('That did not work.')
      }
      close()
      // The activity drawer takes over from here; this is just an acknowledgement.
      setTimeout(() => setStatus(null), 6000)
    },
    [close, router],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((o) => !o)
        return
      }
      if (!open) return
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [query])

  if (!open) {
    return status ? (
      <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-[4px] border border-hairline bg-surface px-3 py-2 text-xs text-ink shadow-none">
        {status}
      </div>
    ) : null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 px-4 pt-[12vh]"
      onClick={close}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-[4px] border border-hairline bg-surface"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(results.length - 1, c + 1))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(0, c - 1))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const command = results[cursor]
              if (command) void execute(command)
            }
          }}
          placeholder="Go to a screen, or run a job…"
          className="w-full border-b border-hairline bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-muted focus:outline-none"
        />

        <ul className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-3 text-sm text-ink-muted">Nothing matches that.</li>
          )}
          {results.map((command, index) => (
            <li key={command.id}>
              <button
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => void execute(command)}
                className={`flex w-full items-start justify-between gap-3 px-4 py-2 text-left transition-state ${
                  index === cursor ? 'bg-recess' : ''
                }`}
              >
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{command.label}</span>
                  {command.note && (
                    <span className="block text-xs text-ink-muted">{command.note}</span>
                  )}
                </span>
                <span className="data shrink-0 text-[11px] uppercase tracking-wide text-ink-muted">
                  {command.kind === 'run' ? 'run' : 'go'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t border-hairline px-4 py-2 text-[11px] text-ink-muted">
          <span className="data">↑↓</span> move · <span className="data">↵</span> select ·{' '}
          <span className="data">esc</span> close · nothing here moves or deletes a file
        </div>
      </div>
    </div>
  )
}
