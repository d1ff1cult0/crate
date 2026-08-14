/**
 * Mixes — PROMPT.md §7.8 and §8: "today's six, why each exists, and the free-text
 * curator box."
 *
 * "Why each exists" is the part that matters. A mix nobody understands is a mix nobody
 * trusts, so every one shows the artists it was built from, how much continuity it kept
 * with yesterday's version of the same slot, and how many deep cuts it reached for.
 *
 * When there is no taste signal yet, this page says so and says what would fix it. It
 * does not render six empty cards pretending to be mixes (§11).
 */

import { prisma } from '@crate/db'
import { CuratorBox } from '../../components/curator-box'
import { JobButton } from '../../components/job-button'
import { SegmentedMeter } from '../../components/meter'
import { Badge, EmptyState, Panel, Readout } from '../../components/ui'

export const dynamic = 'force-dynamic'

interface MixSeed {
  artists?: string[]
  continuity?: number
  deepCuts?: number
  discovery?: string[]
  cappedArtists?: string[]
}

export default async function MixesPage() {
  const [mixes, scoredTracks, edgeCount, releases, setting, curated] = await Promise.all([
    prisma.mix.findMany({
      orderBy: { slot: 'asc' },
      include: { playlist: { include: { _count: { select: { items: true } } } } },
    }),
    prisma.libraryTrack.count({ where: { affinity: { gt: 0 } } }),
    prisma.artistEdge.count(),
    prisma.setting.findUnique({ where: { key: 'releaseRadarResults' } }),
    prisma.setting.findUnique({ where: { key: 'app' } }),
    prisma.playlist.findMany({
      where: { kind: 'GENERATED_MIX', mixes: { none: {} } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { _count: { select: { items: true } } },
    }),
  ])

  const config = (setting?.value ?? {}) as { llmEnabled?: boolean }
  const releaseList = (releases?.value ?? []) as Array<{ artist: string; title: string; date: string }>

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
            Mixes
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Rebuilt every morning at 05:00 and written straight to Navidrome.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <JobButton job="taste-refresh" label="Refresh taste model" />
          <JobButton job="generate-mixes" label="Regenerate mixes" variant="primary" />
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Panel>
          <Readout label="Tracks with signal" value={scoredTracks} />
        </Panel>
        <Panel>
          <Readout label="Artist edges" value={edgeCount} />
        </Panel>
        <Panel>
          <Readout label="Mixes" value={mixes.length} />
        </Panel>
      </div>

      {mixes.length === 0 ? (
        <Panel title="Today's mixes">
          <EmptyState
            title="No mixes yet — there isn't enough listening signal to build one honestly"
            action={<JobButton job="taste-refresh" label="Refresh taste model" variant="primary" />}
          >
            Mixes come from three inputs, and the more of them exist the better they get:
            the Spotify GDPR streaming history (the richest by far — import it on the
            Import screen when it arrives), your ListenBrainz listens if you connect an account,
            and Navidrome play counts, which accumulate on their own once you start
            listening. With none of those, six playlists sampled from nothing would be
            indistinguishable from random, so this screen stays empty instead.
          </EmptyState>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {mixes.map((mix) => {
            const seed = (mix.seedJson ?? {}) as MixSeed
            const artists = seed.artists ?? []
            const trackCount = mix.playlist?._count.items ?? 0
            return (
              <Panel key={mix.id} title={`Slot ${mix.slot}`}>
                <div className="space-y-3">
                  <div>
                    <h3 className="text-base font-medium text-ink">{mix.name}</h3>
                    <p className="text-sm text-ink-muted">{mix.descriptor}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                    <span className="data text-ink">{trackCount} tracks</span>
                    {seed.deepCuts !== undefined && (
                      <span className="data text-ink-muted">{seed.deepCuts} deep cuts</span>
                    )}
                    <span className="data text-ink-muted">
                      {new Date(mix.generatedAt).toLocaleString()}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between">
                      <span className="label">Continuity with yesterday</span>
                      <span className="data text-xs text-ink-muted">
                        {((seed.continuity ?? 0) * 100).toFixed(0)}%
                      </span>
                    </div>
                    <SegmentedMeter
                      value={seed.continuity ?? 0}
                      segments={16}
                      size="sm"
                      tone={(seed.continuity ?? 0) > 0.4 ? 'ok' : 'neutral'}
                      aria-label="continuity"
                    />
                    <p className="text-xs text-ink-muted">
                      {(seed.continuity ?? 0) === 0
                        ? 'New to this slot — the clustering moved, so this mix means something different today.'
                        : 'This slot kept most of the artists it had, so it still means roughly what it did yesterday.'}
                    </p>
                  </div>

                  {artists.length > 0 && (
                    <div>
                      <div className="label mb-1">Built from</div>
                      <p className="text-xs leading-relaxed text-ink-muted">
                        {artists.slice(0, 14).join(' · ')}
                        {artists.length > 14 ? ` · +${artists.length - 14} more` : ''}
                      </p>
                    </div>
                  )}

                  {seed.discovery && seed.discovery.length > 0 && (
                    <div>
                      <div className="label mb-1">Discovery slots</div>
                      <p className="text-xs leading-relaxed text-ink-muted">
                        {seed.discovery.join(' · ')} — not in the library yet.
                      </p>
                    </div>
                  )}
                </div>
              </Panel>
            )
          })}
        </div>
      )}

      <Panel title="Ask for a playlist">
        <CuratorBox available={config.llmEnabled !== false} />
        {curated.length > 0 && (
          <ul className="mt-4 divide-y divide-hairline border-t border-hairline">
            {curated.map((playlist) => (
              <li key={playlist.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">{playlist.name}</div>
                  {playlist.description && (
                    <div className="truncate text-xs text-ink-muted">{playlist.description}</div>
                  )}
                </div>
                <span className="data shrink-0 text-xs text-ink-muted">
                  {playlist._count.items} tracks
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Release radar"
        action={<JobButton job="release-radar" label="Check now" />}
      >
        {releaseList.length === 0 ? (
          <EmptyState title="No new releases recorded yet">
            Checked weekly against MusicBrainz for artists you actually play. Spotify&rsquo;s
            new-releases endpoint is gone, and MusicBrainz replaces it outright — which
            also means this keeps working after the Spotify connector dies.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hairline">
            {releaseList.slice(0, 30).map((release, i) => (
              <li key={`${release.artist}-${release.title}-${i}`} className="flex items-baseline justify-between gap-4 py-2">
                <div className="min-w-0">
                  <span className="text-sm text-ink">{release.title}</span>
                  <span className="ml-2 text-xs text-ink-muted">{release.artist}</span>
                </div>
                <Badge tone="idle">{release.date}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
