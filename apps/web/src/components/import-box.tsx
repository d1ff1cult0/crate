'use client'

/**
 * The paste box. PROMPT.md §7.2 — one input, several resolvers, tried in order.
 *
 * The case that matters most is a playlist the owner does not own: Spotify returns its
 * name and cover but withholds the tracks. §7.2 is emphatic that this must not be a
 * generic error, so it renders the playlist's real identity alongside the exact
 * workaround and a "Recheck my playlists" button.
 */

import { useState } from 'react'
import { Button, Panel } from './ui'

interface ResolveResult {
  kind: 'owned' | 'not-owned' | 'text' | 'csv' | 'error' | 'unsupported'
  playlistName?: string
  imageUrl?: string
  ownerName?: string
  trackTotal?: number
  imported?: number
  message?: string
  preview?: Array<{ artist: string; title: string; confidence: number; note: string }>
}

export function ImportBox() {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ResolveResult | null>(null)
  const [rechecking, setRechecking] = useState(false)

  const submit = async () => {
    if (!input.trim()) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/import/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      setResult((await res.json()) as ResolveResult)
    } catch (err) {
      setResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Something went wrong.',
      })
    } finally {
      setBusy(false)
    }
  }

  const recheck = async () => {
    setRechecking(true)
    try {
      await fetch('/api/import/recheck', { method: 'POST' })
    } finally {
      setRechecking(false)
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (!file) return
    setBusy(true)
    setResult(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/import/file', { method: 'POST', body: form })
      setResult((await res.json()) as ResolveResult)
    } catch (err) {
      setResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not read that file.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="Paste a link or a tracklist">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="space-y-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
            }}
            rows={5}
            placeholder={
              'https://open.spotify.com/playlist/...\n\nor a tracklist, one per line:\nRadiohead - Karma Police\n2. Portishead – Glory Box'
            }
            className="data w-full resize-y rounded-[4px] border border-hairline bg-surface p-3 text-sm leading-relaxed text-ink placeholder:text-ink-muted/60"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">
              Or drop a <span className="data">.zip</span> export or a{' '}
              <span className="data">.csv</span> anywhere in this box.
            </p>
            <Button variant="primary" onClick={submit} disabled={busy || !input.trim()}>
              {busy ? 'Working…' : 'Import'}
            </Button>
          </div>
        </div>
      </Panel>

      {result?.kind === 'not-owned' && (
        <Panel title="This playlist isn't yours">
          <div className="flex flex-col gap-4 sm:flex-row">
            {result.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={result.imageUrl}
                alt=""
                className="h-24 w-24 shrink-0 rounded-[4px] border border-hairline object-cover"
              />
            )}
            <div className="space-y-3">
              <div>
                <div className="font-medium text-ink">{result.playlistName}</div>
                {result.ownerName && (
                  <div className="text-sm text-ink-muted">by {result.ownerName}</div>
                )}
                {result.trackTotal !== undefined && (
                  <div className="data mt-1 text-xs text-ink-muted">
                    {result.trackTotal} tracks, contents withheld
                  </div>
                )}
              </div>

              <p className="max-w-prose text-sm leading-relaxed text-ink">
                Spotify won&rsquo;t hand over the tracks for a playlist you don&rsquo;t own.
                Open it in Spotify, select all tracks (Ctrl/Cmd+A), right-click → Add to
                playlist → New playlist. Come back and it&rsquo;ll be in your list.
              </p>
              <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
                Being added as a collaborator works too — Spotify returns full contents for
                playlists you own <em>or</em> collaborate on.
              </p>

              <Button variant="primary" onClick={recheck} disabled={rechecking}>
                {rechecking ? 'Rechecking…' : 'Recheck my playlists'}
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {result?.kind === 'owned' && (
        <Panel title="Imported">
          <p className="text-sm text-ink">
            <span className="font-medium">{result.playlistName}</span> —{' '}
            <span className="data">{result.imported ?? 0}</span> tracks stored. Matching
            against your library runs next; check Review for anything ambiguous.
          </p>
        </Panel>
      )}

      {result?.kind === 'text' && result.preview && (
        <Panel title={`Parsed ${result.preview.length} lines`}>
          <p className="mb-3 max-w-prose text-xs text-ink-muted">
            Low-confidence lines are worth a look before importing — the parser guesses
            which side is the artist and it is not always right.
          </p>
          <table className="dense">
            <thead>
              <tr>
                <th className="label">Artist</th>
                <th className="label">Title</th>
                <th className="label">Confidence</th>
                <th className="label">Read as</th>
              </tr>
            </thead>
            <tbody>
              {result.preview.map((line, i) => (
                <tr key={i}>
                  <td className="text-sm">{line.artist || <span className="text-ink-muted">—</span>}</td>
                  <td className="text-sm">{line.title}</td>
                  <td className="num text-xs">
                    <span className={line.confidence < 0.7 ? 'text-warn' : 'text-ok'}>
                      {line.confidence.toFixed(2)}
                    </span>
                  </td>
                  <td className="text-xs text-ink-muted">{line.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {result?.kind === 'error' && (
        <Panel title="Couldn't import that">
          <p className="max-w-prose text-sm text-ink">{result.message}</p>
        </Panel>
      )}

      {result?.kind === 'unsupported' && (
        <Panel title="Not something Crate can read">
          <p className="max-w-prose text-sm text-ink">{result.message}</p>
        </Panel>
      )}
    </div>
  )
}
