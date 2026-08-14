'use client'

/**
 * Per-playlist actions: write it out, or queue downloads for the tracks that are
 * missing ("fill gaps", §8).
 *
 * Both enqueue worker jobs rather than doing the work here — writing a playlist touches
 * the filesystem and Navidrome, and filling gaps starts downloads (§4).
 */

import { useState } from 'react'
import { Button } from './ui'

export function PlaylistActions({
  sourcePlaylistId,
  hasGaps,
  gapCount,
}: {
  sourcePlaylistId: string
  hasGaps: boolean
  gapCount: number
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: 'write' | 'fill-gaps') => {
    setBusy(action)
    setError(null)
    try {
      const res = await fetch('/api/playlists/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePlaylistId, action }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setError(body.error ?? 'That did not work.')
      } else {
        setDone(action)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-1.5">
        <Button size="sm" disabled={busy !== null} onClick={() => void run('write')}>
          {busy === 'write' ? 'Writing…' : done === 'write' ? 'Queued' : 'Write playlist'}
        </Button>
        {hasGaps && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            onClick={() => void run('fill-gaps')}
          >
            {busy === 'fill-gaps'
              ? 'Queueing…'
              : done === 'fill-gaps'
                ? 'Queued'
                : `Fill ${gapCount} gap${gapCount === 1 ? '' : 's'}`}
          </Button>
        )}
      </div>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  )
}
