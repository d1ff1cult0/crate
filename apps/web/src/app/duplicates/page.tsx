/**
 * Duplicates — PROMPT.md §7.7, phase 6.
 *
 * Paginated server-side at 50. Counts and reclaimable space are aggregates over the whole
 * table, not over the page — the screen previously fetched 200 groups and presented that
 * as the total, which on a library with thousands is a wrong number rather than a
 * truncated one.
 */

import { paginate, parsePageRequest } from '@crate/core'
import { prisma } from '@crate/db'
import { DuplicateReview, type DuplicateGroupView } from '../../components/duplicate-review'
import { JobButton } from '../../components/job-button'
import { Pager } from '../../components/pagination'
import { EmptyState, Panel, Readout } from '../../components/ui'
import { BULK_DELETE_MIN_CONFIDENCE } from '../../lib/jobs'
import { requireSession } from '../../lib/session'

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

export default async function DuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string }>
}) {
  await requireSession('/duplicates')
  const params = await searchParams
  const request = parsePageRequest(params)

  const [total, setting, operations, aggregates] = await Promise.all([
    prisma.duplicateGroup.count({ where: { status: 'OPEN' } }),
    prisma.setting.findUnique({ where: { key: 'app' } }),
    prisma.trashOperation.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    // Whole-table aggregates, computed in the database rather than by loading rows.
    prisma.duplicateGroup.findMany({
      where: { status: 'OPEN' },
      select: {
        reason: true,
        confidence: true,
        members: { where: { isKeeper: false }, select: { file: { select: { sizeBytes: true } } } },
      },
    }),
  ])

  const pagination = paginate(request, total)

  const groups = await prisma.duplicateGroup.findMany({
    where: { status: 'OPEN' },
    orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
    skip: pagination.skip,
    take: pagination.take,
    include: { members: { include: { file: { include: { track: true } } } } },
  })

  const settings = (setting?.value ?? {}) as { dedupeDryRunOnly?: boolean }
  const dryRunOnly = settings.dedupeDryRunOnly !== false

  let variants = 0
  let reclaimable = 0n
  let deletableGroups = 0
  let deletableFiles = 0
  let deletableBytes = 0n

  for (const group of aggregates) {
    if (group.reason === 'VARIANT') {
      variants += 1
      continue
    }
    const eligible = group.confidence >= BULK_DELETE_MIN_CONFIDENCE
    if (eligible) deletableGroups += 1
    for (const member of group.members) {
      reclaimable += member.file.sizeBytes
      if (eligible) {
        deletableFiles += 1
        deletableBytes += member.file.sizeBytes
      }
    }
  }

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

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-20">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
            Duplicates
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Grouped most-confident first. Nothing is ever deleted outright — files move to
            the trash with a manifest and can be restored.
          </p>
        </div>
        <JobButton job="dedupe-scan" label="Rescan for duplicates" />
      </header>

      {total > 0 && (
        <div className="grid gap-4 sm:grid-cols-4">
          <Panel>
            <Readout label="Groups" value={(total - variants).toLocaleString()} />
          </Panel>
          <Panel>
            <Readout label="Variants kept" value={variants.toLocaleString()} tone={variants > 0 ? 'warn' : undefined} />
          </Panel>
          <Panel>
            <Readout
              label="Reclaimable"
              value={(Number(reclaimable) / 1_073_741_824).toFixed(2)}
              suffix="GB"
            />
          </Panel>
          <Panel>
            <Readout
              label={`At ≥ ${BULK_DELETE_MIN_CONFIDENCE}`}
              value={deletableFiles.toLocaleString()}
              suffix="files"
            />
          </Panel>
        </div>
      )}

      {total === 0 && operations.length === 0 ? (
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
          bulkDelete={{
            minConfidence: BULK_DELETE_MIN_CONFIDENCE,
            groups: deletableGroups,
            files: deletableFiles,
            bytes: String(deletableBytes),
          }}
          operations={operations.map((o) => ({
            id: o.id,
            fileCount: o.fileCount,
            bytes: String(o.bytes),
            reason: ((o.manifestJson ?? {}) as { reason?: string }).reason ?? 'Trash operation',
            createdAt: o.createdAt.toISOString(),
            undoneAt: o.undoneAt?.toISOString() ?? null,
          }))}
          pager={<Pager pagination={pagination} basePath="/duplicates" noun="group" />}
        />
      )}
    </div>
  )
}
