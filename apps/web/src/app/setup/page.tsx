/**
 * First-run wizard — PROMPT.md §7.10.
 *
 * "connect Spotify → verify paths → harvest → scan library → review the match report →
 *  choose what to download → go. One flow, resumable, and it should be plausible to have
 *  music arriving within ten minutes of first launch."
 *
 * Resumable falls out of the design rather than being bolted on: every step's state is
 * *derived* from the database, not stored as a wizard cursor. Close the tab, come back
 * next week, and the page shows exactly where things actually stand — including if
 * something was undone outside the wizard. There is no "step 3 of 6" counter to get out
 * of sync with reality.
 *
 * Steps are never blocked on the ones above. A path mapping can be fixed after a harvest,
 * and the library can be scanned before Spotify is connected at all — the order is the
 * recommended one, not a gate.
 */

import { prisma } from '@crate/db'
import Link from 'next/link'
import { JobButton } from '../../components/job-button'
import { SegmentedMeter } from '../../components/meter'
import { Badge, Button, Panel } from '../../components/ui'
import { PATHS_VERIFIED_KEY, pathVerificationState } from '../../lib/setup-state'
import { requireSession } from '../../lib/session'

export const dynamic = 'force-dynamic'

type StepState = 'done' | 'ready' | 'attention'

interface Step {
  title: string
  state: StepState
  detail: string
  /** What the owner does next, when there is something to do. */
  action?: { kind: 'link'; href: string; label: string } | { kind: 'job'; job: string; label: string }
}

/** Days until the Spotify connector stops working (DECISIONS D1). */
const PREMIUM_LAPSE = new Date('2026-09-01T00:00:00Z')

export default async function SetupPage() {
  await requireSession('/setup')
  const [
    spotify,
    navidrome,
    settingRow,
    pathProbe,
    sourceTracks,
    libraryFiles,
    matched,
    needsReview,
    missing,
    downloads,
    succeeded,
  ] = await Promise.all([
    prisma.connection.findUnique({ where: { provider: 'spotify' } }),
    prisma.connection.findUnique({ where: { provider: 'navidrome' } }),
    prisma.setting.findUnique({ where: { key: 'app' } }),
    prisma.setting.findUnique({ where: { key: PATHS_VERIFIED_KEY } }),
    prisma.sourceTrack.count(),
    prisma.libraryFile.count({ where: { missingSince: null } }),
    prisma.match.count({ where: { status: 'MATCHED' } }),
    prisma.match.count({ where: { status: 'NEEDS_REVIEW' } }),
    prisma.match.count({ where: { status: 'MISSING' } }),
    prisma.downloadRequest.count(),
    prisma.downloadRequest.count({ where: { status: 'SUCCEEDED' } }),
  ])

  const settings = (settingRow?.value ?? {}) as {
    pathMappings?: Array<{ appPath: string; navidromePath: string }>
    musicRoot?: string
  }
  const mappings = settings.pathMappings ?? []
  // A pass only vouches for the mappings it tested — editing one makes it stale.
  const pathState = pathVerificationState(pathProbe?.value, mappings)
  const daysLeft = Math.ceil((PREMIUM_LAPSE.getTime() - Date.now()) / 86_400_000)

  const steps: Step[] = [
    {
      title: 'Connect Spotify',
      state: spotify?.enabled ? 'done' : 'attention',
      detail: spotify?.enabled
        ? `Connected as ${spotify.displayName ?? spotify.accountId ?? 'your account'}.`
        : `Not connected. This is the only step with a deadline — Development Mode needs your active Premium, which lapses in ${daysLeft} days. Everything else here works forever.`,
      ...(spotify?.enabled
        ? {}
        : { action: { kind: 'link' as const, href: '/settings', label: 'Connect Spotify' } }),
    },
    {
      title: 'Verify paths',
      state:
        pathState.status === 'verified'
          ? 'done'
          : pathState.status === 'never' && mappings.length === 0
            ? 'attention'
            : pathState.status === 'failed'
              ? 'attention'
              : 'ready',
      detail:
        pathState.status === 'verified'
          ? `Verified ${pathState.at.toLocaleString()}. Navidrome reads the same files this app writes.`
          : pathState.status === 'stale'
            ? `Verified ${pathState.at.toLocaleString()}, but the mappings have been edited since. That earlier pass only vouched for the configuration it tested, so run it again.`
            : pathState.status === 'failed'
              ? `The last run on ${pathState.at.toLocaleString()} did not pass. Until it does, playlists will very likely come out empty in Navidrome.`
              : mappings.length > 0
                ? 'Mappings are configured but the probe has not run. Run it — an unverified mapping is the single most common reason playlists come out empty in Navidrome.'
                : 'No path mappings yet. The path this app sees is almost never the path Navidrome sees, and getting it wrong makes every playlist silently empty.',
      action: {
        kind: 'link' as const,
        href: '/settings',
        label: pathState.status === 'verified' ? 'Re-verify paths' : 'Set up and verify paths',
      },
    },
    {
      title: 'Harvest Spotify',
      state: sourceTracks > 0 ? 'done' : spotify?.enabled ? 'ready' : 'attention',
      detail:
        sourceTracks > 0
          ? `${sourceTracks.toLocaleString()} tracks captured and stored permanently. The connector can die tomorrow without losing any of it.`
          : spotify?.enabled
            ? 'Ready to run. Everything fetched is persisted on first sight, so this only needs to succeed once.'
            : 'Needs Spotify connected first.',
      ...(sourceTracks === 0 && spotify?.enabled
        ? { action: { kind: 'link' as const, href: '/', label: 'Harvest everything' } }
        : {}),
    },
    {
      title: 'Scan your library',
      state: libraryFiles > 0 ? 'done' : 'ready',
      detail:
        libraryFiles > 0
          ? `${libraryFiles.toLocaleString()} files indexed with tags, duration and an audio-stream hash.`
          : `Walks ${settings.musicRoot ?? 'MUSIC_ROOT'}, reads tags, and hashes the audio itself so retagging never looks like a new file. Fingerprinting and the ISRC backfill follow on their own queue.`,
      action: { kind: 'job' as const, job: 'library-scan', label: 'Scan library' },
    },
    {
      title: 'Review the match report',
      state: matched + missing > 0 ? (needsReview > 0 ? 'ready' : 'done') : 'ready',
      detail:
        matched + missing === 0
          ? 'Nothing matched yet — this fills in once both a harvest and a scan have run.'
          : needsReview > 0
            ? `${matched.toLocaleString()} matched, ${missing.toLocaleString()} missing, ${needsReview.toLocaleString()} need a decision. Nothing below 0.90 confidence was accepted automatically.`
            : `${matched.toLocaleString()} matched, ${missing.toLocaleString()} missing, nothing waiting on you.`,
      action: { kind: 'link' as const, href: '/review', label: 'Open review queue' },
    },
    {
      title: 'Choose what to download',
      state: succeeded > 0 ? 'done' : downloads > 0 ? 'ready' : 'ready',
      detail:
        succeeded > 0
          ? `${succeeded.toLocaleString()} downloaded, tagged and placed. ${downloads - succeeded} still in the queue.`
          : missing > 0
            ? `${missing.toLocaleString()} tracks are missing. Queue them all, or fill one playlist at a time from the Playlists screen.`
            : 'Nothing is missing yet — this fills in after matching.',
      ...(missing > 0
        ? { action: { kind: 'job' as const, job: 'download-missing', label: `Queue ${missing} downloads` } }
        : {}),
    },
    {
      title: 'Connect Navidrome',
      state: navidrome?.enabled ? 'done' : 'ready',
      detail: navidrome?.enabled
        ? 'Connected. Playlists are pushed over Subsonic as well as written to disk, and play counts flow back as the post-Spotify taste signal.'
        : 'Optional, but it is what makes playlists appear without waiting for a filesystem scan — and after Spotify is gone, Navidrome play counts become the live taste signal the mixes run on.',
      ...(navidrome?.enabled
        ? {}
        : { action: { kind: 'link' as const, href: '/settings', label: 'Connect Navidrome' } }),
    },
  ]

  const done = steps.filter((s) => s.state === 'done').length

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Setup
        </h1>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          Work down the list. Nothing here is a gate — every step reads its state from the
          database, so you can leave and come back and it will show you where things
          actually stand.
        </p>
      </header>

      <Panel>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="label">Progress</span>
            <span className="data text-xs text-ink-muted">
              {done} of {steps.length}
            </span>
          </div>
          <SegmentedMeter
            value={done / steps.length}
            segments={steps.length}
            tone={done === steps.length ? 'ok' : 'neutral'}
            aria-label="setup progress"
          />
        </div>
      </Panel>

      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={step.title}>
            <Panel>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="data text-xs text-ink-muted">{index + 1}</span>
                    <h2 className="font-medium text-ink">{step.title}</h2>
                    <Badge
                      tone={step.state === 'done' ? 'ok' : step.state === 'attention' ? 'warn' : 'idle'}
                    >
                      {step.state === 'done' ? 'done' : step.state === 'attention' ? 'needs you' : 'ready'}
                    </Badge>
                  </div>
                  <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">
                    {step.detail}
                  </p>
                </div>

                {step.action && (
                  <div className="shrink-0">
                    {step.action.kind === 'link' ? (
                      <Link href={step.action.href}>
                        <Button variant={step.state === 'attention' ? 'primary' : 'secondary'} size="sm">
                          {step.action.label}
                        </Button>
                      </Link>
                    ) : (
                      <JobButton
                        job={step.action.job}
                        label={step.action.label}
                        variant={step.state === 'attention' ? 'primary' : 'secondary'}
                      />
                    )}
                  </div>
                )}
              </div>
            </Panel>
          </li>
        ))}
      </ol>

      <Panel title="What happens on its own after this">
        <ul className="space-y-1.5 text-sm text-ink-muted">
          <li>Spotify playlists re-sync hourly, skipping anything whose snapshot is unchanged.</li>
          <li>The library is scanned nightly, with a full reconcile weekly.</li>
          <li>A match sweep runs after every scan and import, so new files fill old gaps.</li>
          <li>Duplicates are grouped weekly. Nothing is ever moved without you saying so.</li>
          <li>Mixes regenerate at 05:00 and are written straight into Navidrome.</li>
          <li>Release radar checks MusicBrainz weekly for new records by artists you play.</li>
        </ul>
      </Panel>
    </div>
  )
}
