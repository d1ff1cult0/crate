/**
 * Import — PROMPT.md §8: "the paste box, drop zone, and history of past imports with
 * their outcomes."
 *
 * The important behaviour is §7.2 case 2: a playlist the owner neither owns nor
 * collaborates on returns metadata but no tracks. That must never surface as a generic
 * error — it shows the playlist's real name and cover plus the specific workaround.
 */

import { prisma } from '@crate/db'
import { ImportBox } from '../../components/import-box'
import { Badge, EmptyState, Panel } from '../../components/ui'

export const dynamic = 'force-dynamic'

export default async function ImportPage() {
  const runs = await prisma.importRun.findMany({ orderBy: { createdAt: 'desc' }, take: 25 })

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Import
        </h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Paste a Spotify link, drop a GDPR export or a CSV, or paste a tracklist as plain
          text. Everything imported is stored permanently and never needs fetching again.
        </p>
      </header>

      <ImportBox />

      {/*
        The export takes weeks to arrive and is the richest input the recommendation
        engine has, so its status is stated plainly and permanently rather than nagged
        about (DECISIONS D2).
      */}
      <Panel title="Spotify data export">
        <div className="space-y-2">
          <p className="max-w-prose text-sm leading-relaxed text-ink">
            You requested your Spotify data export. It usually takes a few weeks to
            arrive. When it does, drop the <span className="data">.zip</span> above.
          </p>
          <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
            It contains your complete streaming history with timestamps — by far the
            richest signal the recommendation engine has, and the only Spotify data source
            that keeps working after the subscription lapses. Ask for the{' '}
            <em>extended streaming history</em> package specifically; the default account
            data export covers a much shorter window.
          </p>
        </div>
      </Panel>

      <Panel title="Import history">
        {runs.length === 0 ? (
          <EmptyState title="Nothing imported yet">
            Past imports appear here with what they found and anything that went wrong, so
            a partial import can be picked up rather than repeated.
          </EmptyState>
        ) : (
          <table className="dense">
            <thead>
              <tr>
                <th className="label">Source</th>
                <th className="label">Name</th>
                <th className="label">Result</th>
                <th className="label num">Tracks</th>
                <th className="label num">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="data text-xs">{run.kind}</td>
                  <td className="max-w-xs truncate text-sm">{run.playlistName ?? run.input ?? '—'}</td>
                  <td>
                    <Badge
                      tone={
                        run.status === 'SUCCEEDED'
                          ? 'ok'
                          : run.status === 'FAILED'
                            ? 'error'
                            : run.status === 'NOT_OWNED'
                              ? 'warn'
                              : 'idle'
                      }
                    >
                      {run.status === 'NOT_OWNED' ? 'not yours' : run.status}
                    </Badge>
                  </td>
                  <td className="num text-sm">
                    {run.tracksFound > 0 ? run.tracksFound.toLocaleString() : '—'}
                  </td>
                  <td className="num text-xs text-ink-muted">
                    {new Date(run.createdAt).toLocaleString()}
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
