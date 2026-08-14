/**
 * Overview — PROMPT.md §8: "library coverage, active jobs, provider health, recent
 * activity. Not a dashboard of vanity charts; a status board I can read in three
 * seconds."
 *
 * Every number here is counted from the database. Nothing is estimated, and when there
 * is no data the screen says what to do about it (§11: don't mock anything into the UI).
 */

import { prisma } from '@crate/db'
import Link from 'next/link'
import { MeterRow } from '../components/meter'
import { Badge, Button, EmptyState, Panel, Readout, StatusDot } from '../components/ui'

export const dynamic = 'force-dynamic'

/** Days until the Spotify connector stops working (DECISIONS D1). */
const PREMIUM_LAPSE = new Date('2026-09-01T00:00:00Z')

async function getOverview() {
  const [
    sourceTracks,
    matched,
    review,
    missing,
    libraryTracks,
    libraryFiles,
    playlists,
    notOwned,
    withIsrc,
    awaitingIsrc,
    recentJobs,
    connections,
    harvestSummary,
  ] = await Promise.all([
    prisma.sourceTrack.count(),
    prisma.match.count({ where: { status: 'MATCHED' } }),
    prisma.match.count({ where: { status: 'NEEDS_REVIEW' } }),
    prisma.match.count({ where: { status: 'MISSING' } }),
    prisma.libraryTrack.count(),
    prisma.libraryFile.count({ where: { missingSince: null } }),
    prisma.sourcePlaylist.count(),
    prisma.sourcePlaylist.count({ where: { isOwned: false, isCollaborative: false } }),
    prisma.sourceTrack.count({ where: { isrc: { not: null } } }),
    prisma.sourceTrack.count({ where: { isrcStatus: { in: ['ABSENT', 'BACKFILL_QUEUED'] } } }),
    prisma.jobRun.findMany({ orderBy: { startedAt: 'desc' }, take: 8 }),
    prisma.connection.findMany(),
    prisma.setting.findUnique({ where: { key: 'spotify:harvest:summary' } }),
  ])

  return {
    sourceTracks, matched, review, missing, libraryTracks, libraryFiles,
    playlists, notOwned, withIsrc, awaitingIsrc, recentJobs, connections,
    harvested: harvestSummary !== null,
  }
}

export default async function OverviewPage() {
  const d = await getOverview()
  const coverage = d.sourceTracks === 0 ? 0 : d.matched / d.sourceTracks
  const isrcCoverage = d.sourceTracks === 0 ? 0 : d.withIsrc / d.sourceTracks
  const daysLeft = Math.ceil((PREMIUM_LAPSE.getTime() - Date.now()) / 86_400_000)

  const spotify = d.connections.find((c) => c.provider === 'spotify')

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
            Overview
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {d.sourceTracks > 0
              ? `${d.matched.toLocaleString()} of ${d.sourceTracks.toLocaleString()} wanted tracks are in the library.`
              : 'Nothing imported yet.'}
          </p>
        </div>
        <Button variant="primary">
          <Link href="/import">Import music</Link>
        </Button>
      </header>

      {/*
        The deadline is the single most time-sensitive fact in the app, so it sits at
        the top until the harvest is done. See DECISIONS D1.
      */}
      {!d.harvested && daysLeft > 0 && (
        <div className="panel border-accent/40 bg-accent/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="label text-warn">Spotify access expires</div>
              <p className="mt-1 max-w-prose text-sm text-ink">
                Premium lapses on 1 September 2026 —{' '}
                <span className="data">{daysLeft}</span> days from now. After that the
                connector stops entirely and anything not harvested is unobtainable.
                Everything already harvested keeps working forever.
              </p>
            </div>
            <Button variant="primary">
              <Link href="/settings">Run harvest</Link>
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <Readout label="Library tracks" value={d.libraryTracks.toLocaleString()} />
        </Panel>
        <Panel>
          <Readout label="Files" value={d.libraryFiles.toLocaleString()} />
        </Panel>
        <Panel>
          <Readout
            label="Needs review"
            value={d.review.toLocaleString()}
            tone={d.review > 0 ? 'warn' : undefined}
          />
        </Panel>
        <Panel>
          <Readout
            label="Missing"
            value={d.missing.toLocaleString()}
            tone={d.missing > 0 ? 'error' : undefined}
          />
        </Panel>
      </div>

      <Panel title="Coverage">
        {d.sourceTracks === 0 ? (
          <EmptyState
            title="Nothing to measure yet"
            action={
              <Button variant="primary">
                <Link href="/import">Go to Import</Link>
              </Button>
            }
          >
            Coverage compares what you want against what you own. Import a playlist, a
            CSV, or your Spotify account first, then scan your library — this panel fills
            in on its own.
          </EmptyState>
        ) : (
          <div className="space-y-5">
            <MeterRow
              label="Library coverage"
              value={coverage}
              tone={coverage > 0.8 ? 'ok' : coverage > 0.4 ? 'warn' : 'error'}
              detail={`${Math.round(coverage * 100)}% · ${d.matched.toLocaleString()} of ${d.sourceTracks.toLocaleString()}`}
            />
            <MeterRow
              label="ISRC coverage"
              value={isrcCoverage}
              tone={isrcCoverage > 0.8 ? 'ok' : 'warn'}
              detail={`${d.withIsrc.toLocaleString()} tracks${d.awaitingIsrc > 0 ? ` · ${d.awaitingIsrc.toLocaleString()} awaiting backfill` : ''}`}
            />
            {d.awaitingIsrc > 0 && (
              <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
                Tracks that reached us only through a saved album arrive without an ISRC —
                Spotify&rsquo;s album endpoint does not include one. Each needs its own
                request, which the backfill queue is working through at low priority.
              </p>
            )}
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Connections">
          {d.connections.length === 0 ? (
            <EmptyState
              title="Nothing connected"
              action={
                <Button variant="primary">
                  <Link href="/settings">Open Settings</Link>
                </Button>
              }
            >
              Connect Navidrome so playlists have somewhere to go, and Spotify while the
              subscription still works. Last.fm is worth connecting early too — it feeds
              the recommendation engine and starts accumulating immediately.
            </EmptyState>
          ) : (
            <ul className="space-y-2.5">
              {d.connections.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-4">
                  <StatusDot
                    tone={!c.enabled ? 'idle' : c.lastError ? 'error' : c.lastOkAt ? 'ok' : 'warn'}
                    label={c.provider}
                  />
                  <span className="data text-xs text-ink-muted">
                    {c.lastError
                      ? 'error'
                      : c.lastOkAt
                        ? new Date(c.lastOkAt).toLocaleDateString()
                        : 'never used'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Playlists">
          {d.playlists === 0 ? (
            <EmptyState title="No playlists yet">
              Playlists appear here once you import them. If you paste a link to a
              playlist you don&rsquo;t own, Crate will show you how to get its contents —
              Spotify only hands over tracks for playlists you own or collaborate on.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-8">
                <Readout label="Total" value={d.playlists} />
                <Readout
                  label="Contents withheld"
                  value={d.notOwned}
                  tone={d.notOwned > 0 ? 'warn' : undefined}
                />
              </div>
              {d.notOwned > 0 && (
                <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
                  {d.notOwned} playlist{d.notOwned === 1 ? '' : 's'} you neither own nor
                  collaborate on. Spotify returns their name and cover but not their
                  tracks. Copy them into your own library to import them.
                </p>
              )}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Recent activity"
        action={
          <Link href="/queue" className="label hover:text-ink">
            All jobs
          </Link>
        }
      >
        {d.recentJobs.length === 0 ? (
          <EmptyState title="No jobs have run yet">
            Every scan, import, download and match writes a job record here with its full
            log, so you can see what happened without going near the server.
          </EmptyState>
        ) : (
          <table className="dense">
            <thead>
              <tr>
                <th className="label">Queue</th>
                <th className="label">Job</th>
                <th className="label">Status</th>
                <th className="label num">Started</th>
              </tr>
            </thead>
            <tbody>
              {d.recentJobs.map((job) => (
                <tr key={job.id}>
                  <td className="data text-xs">{job.queue}</td>
                  <td className="text-sm">{job.name}</td>
                  <td>
                    <Badge
                      tone={
                        job.status === 'SUCCEEDED'
                          ? 'ok'
                          : job.status === 'FAILED'
                            ? 'error'
                            : job.status === 'PAUSED'
                              ? 'warn'
                              : job.status === 'RUNNING'
                                ? 'active'
                                : 'idle'
                      }
                    >
                      {job.status}
                    </Badge>
                  </td>
                  <td className="num text-xs text-ink-muted">
                    {new Date(job.startedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
