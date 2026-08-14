/**
 * Duplicates — PROMPT.md §7.7, phase 6.
 *
 * The page is a thin server shell: it reads the groups and hands them to the review
 * component. The one thing it decides is whether applying is even possible, which is the
 * `dedupeDryRunOnly` setting — that stays server-side so the client cannot be tricked
 * into rendering an Apply button the worker would refuse anyway.
 */

import { prisma } from '@crate/db'
import { DuplicateReview, type DuplicateGroupView } from '../../components/duplicate-review'
import { JobButton } from '../../components/job-button'
import { EmptyState, Panel, Readout } from '../../components/ui'

export const dynamic = 'force-dynamic'

/** Only the attributes that actually differ, for the review diff (§7.7). */
function differingAttributes(files: Array<Record<string, unknown>>): string[] {
  const out: string[] = []
  const distinct = (key: string) =>
    new Set(files.map((f) => JSON.stringify(f[key] ?? null))).size > 1
  for (const key of ['format', 'bitrate', 'sampleRate', 'bitDepth', 'durationMs', 'sourceProvider']) {
    if (distinct(key)) out.push(key)
  }
  return out
}

export default async function DuplicatesPage() {
  const [groups, operations, setting] = await Promise.all([
    prisma.duplicateGroup.findMany({
      where: { status: 'OPEN' },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: { members: { include: { file: { include: { track: true } } } } },
    }),
    prisma.trashOperation.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.setting.findUnique({ where: { key: 'app' } }),
  ])

  const dryRunOnly = ((setting?.value ?? {}) as { dedupeDryRunOnly?: boolean }).dedupeDryRunOnly !== false

  const views: DuplicateGroupView[] = groups.map((group) => {
    const first = group.members[0]?.file
    return {
      id: group.id,
      reason: group.reason,
      confidence: group.confidence,
      variant: group.reason === 'VARIANT',
      title: first?.track?.title ?? 'Unknown title',
      artist: first?.track?.artist ?? 'Unknown artist',
      differing: differingAttributes(group.members.map((m) => m.file as unknown as Record<string, unknown>)),
      files: group.members.map((member) => ({
        id: member.fileId,
        path: member.file.path,
        format: member.file.format,
        bitrate: member.file.bitrate,
        sampleRate: member.file.sampleRate,
        durationMs: member.file.durationMs,
        sizeBytes: String(member.file.sizeBytes),
        qualityScore: member.file.qualityScore,
        isKeeper: member.isKeeper,
        sourceProvider: member.file.sourceProvider,
      })),
    }
  })

  const variants = views.filter((v) => v.variant).length
  const reclaimable = groups
    .filter((g) => g.reason !== 'VARIANT')
    .reduce(
      (sum, g) => sum + g.members.filter((m) => !m.isKeeper).reduce((s, m) => s + m.file.sizeBytes, 0n),
      0n,
    )

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
            Duplicates
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Grouped most-confident first. Nothing moves until you say so, and nothing is
            ever deleted.
          </p>
        </div>
        <JobButton job="dedupe-scan" label="Run duplicate scan" />
      </header>

      {views.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Panel>
            <Readout label="Groups" value={views.length - variants} />
          </Panel>
          <Panel>
            <Readout label="Variants kept" value={variants} tone={variants > 0 ? 'warn' : undefined} />
          </Panel>
          <Panel>
            <Readout
              label="Reclaimable"
              value={(Number(reclaimable) / 1_073_741_824).toFixed(2)}
              suffix="GB"
            />
          </Panel>
        </div>
      )}

      {views.length === 0 && operations.length === 0 ? (
        <Panel>
          <EmptyState title="Nothing grouped yet" action={<JobButton job="dedupe-scan" label="Run duplicate scan" />}>
            The scan groups the library by identical audio, then fingerprint, then ISRC or
            MBID, then normalized artist and title. Anything with the same name but a
            duration more than 5 seconds apart is flagged as a variant and kept — that is
            almost always a live or remixed take.
          </EmptyState>
        </Panel>
      ) : (
        <DuplicateReview
          groups={views}
          dryRunOnly={dryRunOnly}
          operations={operations.map((o) => ({
            id: o.id,
            fileCount: o.fileCount,
            bytes: String(o.bytes),
            reason: ((o.manifestJson ?? {}) as { reason?: string }).reason ?? 'Trash operation',
            createdAt: o.createdAt.toISOString(),
            undoneAt: o.undoneAt?.toISOString() ?? null,
          }))}
        />
      )}
    </div>
  )
}
