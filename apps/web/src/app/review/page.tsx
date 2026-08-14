/**
 * Review — ambiguous matches, keyboard-first (PROMPT.md §7.3).
 *
 * "J/K to move, Enter to accept, X to reject, D to queue download. I should be able to
 * clear 200 ambiguous matches in a few minutes."
 */

import { prisma } from '@crate/db'
import { ReviewQueue } from '../../components/review-queue'
import { EmptyState, Panel } from '../../components/ui'

export const dynamic = 'force-dynamic'

export default async function ReviewPage() {
  const matches = await prisma.match.findMany({
    where: { status: 'NEEDS_REVIEW' },
    orderBy: { confidence: 'desc' },
    take: 200,
    include: {
      sourceTrack: {
        select: { id: true, title: true, artists: true, album: true, durationMs: true, isrc: true },
      },
      libraryTrack: {
        select: { id: true, title: true, artist: true, album: true, durationMs: true },
      },
    },
  })

  const items = matches.map((m) => ({
    id: m.id,
    confidence: m.confidence,
    method: m.method,
    source: {
      title: m.sourceTrack.title,
      artists: m.sourceTrack.artists,
      album: m.sourceTrack.album,
      durationMs: m.sourceTrack.durationMs,
    },
    candidate: m.libraryTrack
      ? {
          title: m.libraryTrack.title,
          artist: m.libraryTrack.artist,
          album: m.libraryTrack.album,
          durationMs: m.libraryTrack.durationMs,
        }
      : null,
    notes:
      (m.detailJson as { evidence?: { notes?: string[] } } | null)?.evidence?.notes ?? [],
  }))

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Review
        </h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Matches Crate is not confident enough to accept on its own. Anything above 0.90
          was accepted automatically; anything below 0.60 is treated as missing.
        </p>
      </header>

      {items.length === 0 ? (
        <Panel>
          <EmptyState title="Nothing to review">
            Ambiguous matches land here — usually a live version against a studio one, or
            two artists with the same track title. There are none right now, which either
            means everything matched cleanly or nothing has been imported yet.
          </EmptyState>
        </Panel>
      ) : (
        <ReviewQueue items={items} />
      )}
    </div>
  )
}
