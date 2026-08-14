'use client'

/**
 * "Harvest everything" with the live checklist §7.1 asks for, and the "Spotify data
 * secured" summary that follows it.
 *
 * The summary deliberately reports the cache-avoidance counter — the owner asked to see
 * it explicitly — and states plainly that the data survives cancellation, because that
 * is the entire point of the harvest.
 */

import { useEffect, useState } from 'react'
import { SegmentedMeter } from './meter'
import { Button, Panel, Readout } from './ui'

const STAGES = [
  ['profile', 'Profile'],
  ['playlists', 'Playlists'],
  ['playlist-items', 'Playlist contents'],
  ['saved-tracks', 'Liked songs'],
  ['saved-albums', 'Saved albums'],
  ['followed-artists', 'Followed artists'],
  ['top-items', 'Top tracks and artists'],
  ['recently-played', 'Recently played'],
] as const

interface Summary {
  playlists: number
  playlistsNotOwned: number
  uniqueTracks: number
  tracksWithIsrc: number
  tracksAwaitingIsrc: number
  followedArtists: number
  listeningEvents: number
  requests: number
  callsAvoidedByCache: number
  stagesCompleted: string[]
  interruptedBy?: string
  at?: string
}

export function HarvestPanel() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    void fetch('/api/harvest')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSummary(d as Summary | null))
      .catch(() => undefined)
  }, [])

  const start = async () => {
    setStarting(true)
    try {
      await fetch('/api/harvest', { method: 'POST' })
    } finally {
      setStarting(false)
    }
  }

  const completed = new Set(summary?.stagesCompleted ?? [])
  const isrcRatio =
    summary && summary.uniqueTracks > 0 ? summary.tracksWithIsrc / summary.uniqueTracks : 0

  return (
    <Panel
      title="Harvest everything"
      action={
        <Button variant="primary" size="sm" onClick={start} disabled={starting}>
          {starting ? 'Starting…' : summary ? 'Run again' : 'Harvest everything'}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="max-w-prose text-sm leading-relaxed text-ink">
          Pulls your complete Spotify account in one resumable pass and stores it
          permanently. Run this before the subscription lapses.
        </p>

        <ul className="grid gap-1.5 sm:grid-cols-2">
          {STAGES.map(([key, label]) => (
            <li key={key} className="flex items-center gap-2">
              <span
                className={`data text-xs ${completed.has(key) ? 'text-ok' : 'text-ink-muted'}`}
              >
                {completed.has(key) ? '✓' : '·'}
              </span>
              <span
                className={`text-sm ${completed.has(key) ? 'text-ink' : 'text-ink-muted'}`}
              >
                {label}
              </span>
            </li>
          ))}
        </ul>

        {summary && (
          <div className="space-y-4 border-t border-hairline pt-4">
            {summary.interruptedBy === 'QUOTA_EXCEEDED' && (
              <p className="rounded-[4px] border border-warn/30 bg-warn/5 p-3 text-sm text-ink">
                Spotify&rsquo;s quota was used up part-way through. Everything fetched so
                far is saved and the harvest will resume from its checkpoint
                automatically — nothing was lost.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-4">
              <Readout label="Playlists" value={summary.playlists} />
              <Readout label="Unique tracks" value={summary.uniqueTracks.toLocaleString()} />
              <Readout label="With ISRC" value={summary.tracksWithIsrc.toLocaleString()} />
              <Readout label="Plays" value={summary.listeningEvents.toLocaleString()} />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="label">ISRC coverage</span>
                <span className="data text-sm">{Math.round(isrcRatio * 100)}%</span>
              </div>
              <SegmentedMeter
                value={isrcRatio}
                tone={isrcRatio > 0.8 ? 'ok' : 'warn'}
                aria-label="ISRC coverage"
              />
            </div>

            <dl className="space-y-1 text-xs text-ink-muted">
              <div className="flex justify-between gap-4">
                <dt>Requests made</dt>
                <dd className="data">{summary.requests.toLocaleString()}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Calls avoided by cache</dt>
                <dd className="data text-ok">{summary.callsAvoidedByCache.toLocaleString()}</dd>
              </div>
              {summary.tracksAwaitingIsrc > 0 && (
                <div className="flex justify-between gap-4">
                  <dt>Awaiting ISRC backfill</dt>
                  <dd className="data">{summary.tracksAwaitingIsrc.toLocaleString()}</dd>
                </div>
              )}
              {summary.playlistsNotOwned > 0 && (
                <div className="flex justify-between gap-4">
                  <dt>Playlists whose contents Spotify withheld</dt>
                  <dd className="data">{summary.playlistsNotOwned}</dd>
                </div>
              )}
            </dl>

            <p className="max-w-prose text-xs leading-relaxed text-ok">
              This data is stored locally and survives cancellation. Crate keeps working
              with Spotify permanently disconnected.
            </p>
          </div>
        )}
      </div>
    </Panel>
  )
}
