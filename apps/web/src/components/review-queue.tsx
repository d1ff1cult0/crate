'use client'

/**
 * Keyboard-driven review queue (PROMPT.md §7.3).
 *
 * J/K move, Enter accepts, X rejects, D queues a download. The whole point is throughput
 * — 200 decisions in a few minutes — so the hands never need to leave the keyboard and
 * every action is optimistic, with the row disappearing immediately.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ConfidenceMeter } from './meter'
import { Badge, Button, Panel } from './ui'

interface ReviewItem {
  id: string
  confidence: number
  method: string
  source: { title: string; artists: string[]; album: string | null; durationMs: number | null }
  candidate: { title: string; artist: string; album: string | null; durationMs: number | null } | null
  notes: string[]
}

function duration(ms: number | null): string {
  if (!ms) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}


/**
 * One field, wanted above have, aligned on a shared left edge.
 *
 * The two values are the whole decision, so they get identical type and identical
 * indentation and nothing sits between them. A field whose two sides are identical is
 * dimmed: it carries no information for the comparison, and dimming it leaves the
 * differing fields as the only thing with contrast on the row.
 */
function CompareRow({
  label,
  wanted,
  have,
  mono = false,
}: {
  label: string
  wanted: string
  have: string
  mono?: boolean
}) {
  const same = wanted.trim().toLowerCase() === have.trim().toLowerCase()
  const value = `min-w-0 truncate ${mono ? 'data' : ''} text-sm`

  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-x-3">
      <span className={`label self-start pt-0.5 ${same ? 'opacity-40' : ''}`}>{label}</span>
      <div className="min-w-0 space-y-0.5">
        <div className={`${value} ${same ? 'text-ink-muted' : 'text-ink'}`} title={wanted}>
          <span className="mr-1.5 text-[10px] uppercase tracking-wide text-ink-muted">want</span>
          {wanted}
        </div>
        <div className={`${value} ${same ? 'text-ink-muted' : 'text-ink'}`} title={have}>
          <span className="mr-1.5 text-[10px] uppercase tracking-wide text-ink-muted">have</span>
          {have}
        </div>
      </div>
    </div>
  )
}

export function ReviewQueue({
  items: initial,
  totalRemaining,
}: {
  items: ReviewItem[]
  totalRemaining: number
}) {
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(0)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const rowRefs = useRef<Array<HTMLLIElement | null>>([])

  const act = useCallback(
    async (index: number, action: 'accept' | 'reject' | 'download') => {
      const item = items[index]
      if (!item || pending.has(item.id)) return

      // Optimistic: the row goes immediately, which is what makes the pace possible.
      setPending((p) => new Set(p).add(item.id))
      setItems((list) => list.filter((_, i) => i !== index))
      setCursor((c) => Math.min(c, Math.max(0, items.length - 2)))

      try {
        await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchId: item.id, action }),
        })
      } catch {
        // Put it back rather than silently losing the decision.
        setItems((list) => [...list.slice(0, index), item, ...list.slice(index)])
      } finally {
        setPending((p) => {
          const next = new Set(p)
          next.delete(item.id)
          return next
        })
      }
    },
    [items, pending],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key.toLowerCase()) {
        case 'j':
          e.preventDefault()
          setCursor((c) => Math.min(c + 1, items.length - 1))
          break
        case 'k':
          e.preventDefault()
          setCursor((c) => Math.max(c - 1, 0))
          break
        case 'enter':
          e.preventDefault()
          void act(cursor, 'accept')
          break
        case 'x':
          e.preventDefault()
          void act(cursor, 'reject')
          break
        case 'd':
          e.preventDefault()
          void act(cursor, 'download')
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cursor, items.length, act])

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (items.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-ink">
          Queue cleared. Anything you accepted is now matched; rejections were recorded so
          they will not be offered again.
        </p>
      </Panel>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="data text-sm text-ink-muted">
          {totalRemaining.toLocaleString()} to review · {items.length} on this page ·
          reviewing {Math.min(cursor + 1, items.length)}
        </span>
        <div className="flex flex-wrap gap-2 text-xs text-ink-muted">
          {[
            ['J / K', 'move'],
            ['Enter', 'accept'],
            ['X', 'reject'],
            ['D', 'download'],
          ].map(([key, meaning]) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <kbd className="data rounded-[3px] border border-hairline bg-recess px-1.5 py-0.5 text-[11px]">
                {key}
              </kbd>
              {meaning}
            </span>
          ))}
        </div>
      </div>

      <ul className="space-y-2">
        {items.map((item, i) => {
          const active = i === cursor
          return (
            <li
              key={item.id}
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              onClick={() => setCursor(i)}
              className={`panel cursor-pointer p-3 transition-state ${
                active ? 'border-ink' : 'border-hairline'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  {/*
                    Stacked and aligned rather than side by side. The decision being made
                    is "are these the same recording?", which is a character-by-character
                    comparison of two titles and two artists — and the eye does that far
                    faster when the strings start at the same x position, one directly
                    above the other, than when they are in separate columns.
                  */}
                  {item.candidate ? (
                    <div className="space-y-1.5">
                      <CompareRow
                        label="Title"
                        wanted={item.source.title}
                        have={item.candidate.title}
                      />
                      <CompareRow
                        label="Artist"
                        wanted={item.source.artists.join(', ')}
                        have={item.candidate.artist}
                      />
                      <CompareRow
                        label="Album"
                        wanted={item.source.album ?? '—'}
                        have={item.candidate.album ?? '—'}
                      />
                      <CompareRow
                        label="Length"
                        wanted={duration(item.source.durationMs)}
                        have={duration(item.candidate.durationMs)}
                        mono
                      />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="text-sm text-ink">{item.source.title}</div>
                      <div className="text-xs text-ink-muted">
                        {item.source.artists.join(', ')}
                        {item.source.album ? ` · ${item.source.album}` : ''}
                      </div>
                      <div className="text-sm text-warn">
                        No candidate in the library — accepting this would match it to nothing.
                      </div>
                    </div>
                  )}

                  {item.notes.length > 0 && (
                    <ul className="space-y-0.5">
                      {item.notes.map((note, n) => (
                        <li key={n} className="text-xs text-ink-muted">
                          {note}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Badge>{item.method}</Badge>
                  <ConfidenceMeter confidence={item.confidence} />
                  {active && (
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="primary" onClick={() => void act(i, 'accept')}>
                        Accept
                      </Button>
                      <Button size="sm" onClick={() => void act(i, 'download')}>
                        Download
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void act(i, 'reject')}>
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
