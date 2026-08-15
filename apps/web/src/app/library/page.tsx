/** Library — searchable table of everything, with quality and source columns (§8). */

import { prisma } from '@crate/db'
import { Badge, EmptyState, Panel } from '../../components/ui'
import { SegmentedMeter } from '../../components/meter'
import { requireSession } from '../../lib/session'

export const dynamic = 'force-dynamic'

function duration(ms: number | null): string {
  if (!ms) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireSession('/library')
  const { q } = await searchParams
  const query = q?.trim() ?? ''

  const tracks = await prisma.libraryTrack.findMany({
    where: query
      ? {
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { artist: { contains: query, mode: 'insensitive' } },
            { album: { contains: query, mode: 'insensitive' } },
          ],
        }
      : undefined,
    orderBy: [{ artist: 'asc' }, { album: 'asc' }, { title: 'asc' }],
    take: 200,
    include: {
      files: {
        where: { missingSince: null },
        orderBy: { qualityScore: 'desc' },
        take: 1,
        select: { format: true, bitrate: true, qualityScore: true, sourceProvider: true },
      },
    },
  })

  const total = await prisma.libraryTrack.count()

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
            Library
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            <span className="data">{total.toLocaleString()}</span> tracks indexed
          </p>
        </div>
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={query}
            placeholder="Search artist, title or album"
            className="w-64 rounded-[4px] border border-hairline bg-surface px-2.5 py-1.5 text-sm"
          />
        </form>
      </header>

      <Panel>
        {tracks.length === 0 ? (
          <EmptyState title={query ? `Nothing matches “${query}”` : 'Library not scanned yet'}>
            {query
              ? 'Try a shorter search, or check the spelling — search matches artist, title and album.'
              : 'Run a library scan from Settings and this fills in. Crate reads tags, measures each file with ffprobe, and hashes the audio stream so retagged files are not seen as new.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="dense">
              <thead>
                <tr>
                  <th className="label">Artist</th>
                  <th className="label">Title</th>
                  <th className="label">Album</th>
                  <th className="label num">Length</th>
                  <th className="label">Format</th>
                  <th className="label">Quality</th>
                  <th className="label">ISRC</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => {
                  const file = t.files[0]
                  return (
                    <tr key={t.id}>
                      <td className="max-w-[14rem] truncate text-sm">{t.artist}</td>
                      <td className="max-w-[18rem] truncate text-sm">{t.title}</td>
                      <td className="max-w-[14rem] truncate text-sm text-ink-muted">
                        {t.album ?? '—'}
                      </td>
                      <td className="num text-xs">{duration(t.durationMs)}</td>
                      <td className="data text-xs uppercase">
                        {file ? file.format : '—'}
                        {file?.bitrate ? (
                          <span className="text-ink-muted">
                            {' '}
                            {Math.round(file.bitrate / 1000)}k
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {file ? (
                          <SegmentedMeter
                            value={Math.min(1, file.qualityScore / 155)}
                            segments={8}
                            size="sm"
                            tone={file.qualityScore > 110 ? 'ok' : file.qualityScore > 70 ? 'warn' : 'error'}
                            className="w-16"
                            aria-label="quality"
                          />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {t.isrc ? (
                          <span className="data text-[11px] text-ink-muted">{t.isrc}</span>
                        ) : (
                          <Badge>none</Badge>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {tracks.length === 200 && (
              <p className="mt-3 text-xs text-ink-muted">
                Showing the first 200. Narrow the search to see more.
              </p>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}
