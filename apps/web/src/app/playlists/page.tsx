/**
 * Playlists — PROMPT.md §8: "imported and generated, coverage per playlist, per-track
 * match state, a 'fill gaps' action."
 *
 * Playlists whose contents Spotify withheld are shown honestly rather than hidden: they
 * are real playlists in the account, they just cannot be read, and saying so is more
 * useful than pretending they do not exist.
 */

import { prisma } from '@crate/db'
import Link from 'next/link'
import { SegmentedMeter } from '../../components/meter'
import { Badge, EmptyState, Panel } from '../../components/ui'
import { PlaylistActions } from '../../components/playlist-actions'

export const dynamic = 'force-dynamic'

export default async function PlaylistsPage() {
  const sourcePlaylists = await prisma.sourcePlaylist.findMany({
    orderBy: [{ isOwned: 'desc' }, { name: 'asc' }],
    include: {
      _count: { select: { items: true } },
      playlist: { select: { id: true, m3uPath: true, lastWrittenAt: true, subsonicId: true } },
      items: {
        select: { sourceTrack: { select: { match: { select: { status: true } } } } },
      },
    },
  })

  const readable = sourcePlaylists.filter((p) => p.isOwned || p.isCollaborative)
  const withheld = sourcePlaylists.filter((p) => !p.isOwned && !p.isCollaborative)

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Playlists
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Coverage is how much of each playlist already exists in your library.
        </p>
      </header>

      {sourcePlaylists.length === 0 ? (
        <Panel>
          <EmptyState
            title="No playlists yet"
            action={
              <Link href="/import" className="label hover:text-ink">
                Go to Import
              </Link>
            }
          >
            Import a Spotify playlist, a CSV, or paste a tracklist. Once matched, each
            playlist here can be written out as an m3u8 and pushed to Navidrome.
          </EmptyState>
        </Panel>
      ) : (
        <Panel title={`Readable (${readable.length})`}>
          <ul className="divide-y divide-hairline">
            {readable.map((p) => {
              const total = p.items.length
              const matched = p.items.filter(
                (i) => i.sourceTrack.match?.status === 'MATCHED',
              ).length
              const coverage = total === 0 ? 0 : matched / total
              const gaps = total - matched

              return (
                <li key={p.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{p.name}</span>
                        {p.isCollaborative && !p.isOwned && <Badge>collaborative</Badge>}
                      </div>
                      <div className="data mt-0.5 text-xs text-ink-muted">
                        {matched} of {total} in library
                        {p.playlist?.lastWrittenAt
                          ? ` · written ${new Date(p.playlist.lastWrittenAt).toLocaleDateString()}`
                          : ' · not written yet'}
                      </div>
                    </div>
                    <PlaylistActions
                      sourcePlaylistId={p.id}
                      hasGaps={gaps > 0}
                      gapCount={gaps}
                    />
                  </div>
                  <SegmentedMeter
                    value={coverage}
                    tone={coverage > 0.8 ? 'ok' : coverage > 0.4 ? 'warn' : 'error'}
                    aria-label={`${p.name} coverage`}
                  />
                </li>
              )
            })}
          </ul>
        </Panel>
      )}

      {withheld.length > 0 && (
        <Panel title={`Contents withheld by Spotify (${withheld.length})`}>
          <p className="mb-3 max-w-prose text-xs leading-relaxed text-ink-muted">
            Spotify returns the name and cover for these but not the tracks, because you
            neither own them nor collaborate on them. Copy one into your own library in
            the Spotify app — select all, right-click, add to a new playlist — then
            recheck from the Import screen.
          </p>
          <ul className="divide-y divide-hairline">
            {withheld.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-sm text-ink">{p.name}</span>
                <span className="data text-xs text-ink-muted">
                  {p.trackTotal != null ? `${p.trackTotal} tracks` : 'unknown size'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}
