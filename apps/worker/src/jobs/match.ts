/**
 * Match sweep — PROMPT.md §7.3 / §7.10.
 *
 * Runs after every scan and import: re-attempts MISSING and low-confidence matches
 * against the current library state. Because matching now happens once per SourceTrack
 * rather than once per playlist appearance (plan.md §2.1), fixing one track fixes it
 * everywhere it appears.
 *
 * Candidate narrowing matters for throughput: with tens of thousands of tracks on each
 * side, comparing everything to everything is quadratic. Candidates are pulled by index
 * lookup (isrc, then mbid, then normArtist+normTitle, then a title-token fallback) and
 * only that shortlist is scored.
 */

import { matchTrack, type MatchCandidate, type MatchDefaults } from '@crate/core'
import { Prisma, prisma } from '@crate/db'
import type { JobRunContext } from '../lib/jobrun.js'
import { loadSettings } from '../lib/settings.js'

async function findCandidates(source: {
  isrc: string | null
  mbid: string | null
  normArtist: string
  normTitle: string
}): Promise<MatchCandidate[]> {
  const found = new Map<string, MatchCandidate>()

  const add = (rows: Array<{
    id: string
    title: string
    artist: string
    durationMs: number | null
    isrc: string | null
    mbid: string | null
    acoustId: string | null
  }>) => {
    for (const r of rows) {
      if (!found.has(r.id)) {
        found.set(r.id, {
          id: r.id,
          title: r.title,
          artist: r.artist,
          durationMs: r.durationMs,
          isrc: r.isrc,
          mbid: r.mbid,
          acoustId: r.acoustId,
        })
      }
    }
  }

  const select = {
    id: true, title: true, artist: true, durationMs: true,
    isrc: true, mbid: true, acoustId: true,
  }

  // Tier 1 and 2 keys first — an exact hit here ends the search immediately.
  if (source.isrc) {
    add(await prisma.libraryTrack.findMany({ where: { isrc: source.isrc }, select }))
    if (found.size > 0) return [...found.values()]
  }
  if (source.mbid) {
    add(await prisma.libraryTrack.findMany({ where: { mbid: source.mbid }, select }))
    if (found.size > 0) return [...found.values()]
  }

  // Normalized exact.
  add(
    await prisma.libraryTrack.findMany({
      where: { normArtist: source.normArtist, normTitle: source.normTitle },
      select,
      take: 25,
    }),
  )

  // Fallback: same normalized title, any artist. Bounded, because a common title can
  // return a lot — the cascade's artist gate throws out the implausible ones.
  if (found.size === 0) {
    add(await prisma.libraryTrack.findMany({ where: { normTitle: source.normTitle }, select, take: 25 }))
  }

  // Last resort: same artist, fuzzy title. Only when nothing else matched at all.
  if (found.size === 0 && source.normArtist) {
    add(await prisma.libraryTrack.findMany({ where: { normArtist: source.normArtist }, select, take: 50 }))
  }

  return [...found.values()]
}

export async function runMatchSweep(
  ctx: JobRunContext,
  opts: { all?: boolean; batchSize?: number; sourceTrackIds?: string[] } = {},
): Promise<{ examined: number; matched: number; review: number; missing: number }> {
  const settings = await loadSettings()
  const cfg: MatchDefaults = {
    autoAcceptAt: settings.matchAutoAcceptAt,
    reviewFloorAt: settings.matchReviewFloorAt,
    durationToleranceMs: settings.matchDurationToleranceMs,
    durationVetoMs: settings.matchDurationVetoMs,
    variantMismatchPenalty: settings.matchVariantPenalty,
    artistTokenFloor: 0.85,
    artistPlausibilityFloor: 0.3,
  }

  // Re-attempt anything unresolved. A MATCHED track is left alone unless a full
  // re-match was asked for — re-deciding a settled match on every scan would churn
  // the review queue and undo manual decisions.
  const where: Prisma.SourceTrackWhereInput = opts.sourceTrackIds
    ? { id: { in: opts.sourceTrackIds } }
    : opts.all ? {} : {
        OR: [
          { match: { is: null } },
          { match: { status: { in: ['MISSING', 'NEEDS_REVIEW'] } } },
        ],
      }

  const total = await prisma.sourceTrack.count({ where })
  await ctx.log('info', `Match sweep over ${total} source tracks`, {
    all: opts.all ?? false,
    scoped: opts.sourceTrackIds?.length ?? null,
  })

  const batchSize = opts.batchSize ?? 500
  let examined = 0
  let matched = 0
  let review = 0
  let missing = 0
  let cursor: string | undefined

  for (;;) {
    const batch = await prisma.sourceTrack.findMany({
      where,
      select: {
        id: true, title: true, artists: true, durationMs: true,
        isrc: true, mbid: true, normArtist: true, normTitle: true,
      },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    })
    if (batch.length === 0) break
    cursor = batch[batch.length - 1]!.id

    for (const source of batch) {
      const candidates = await findCandidates(source)
      const result = matchTrack(
        {
          id: source.id,
          title: source.title,
          artists: source.artists,
          durationMs: source.durationMs,
          isrc: source.isrc,
          mbid: source.mbid,
        },
        candidates,
        cfg,
      )

      const existing = await prisma.match.findUnique({ where: { sourceTrackId: source.id } })

      // Never overwrite a human decision (§7.3: manual review is authoritative).
      if (existing?.reviewedAt && existing.method === 'MANUAL') continue

      const data = {
        libraryTrackId: result.candidateId,
        method: result.method,
        confidence: result.confidence,
        status: result.status,
        detailJson: {
          evidence: result.evidence,
          alternatives: result.alternatives,
        } as object,
      }

      await prisma.match.upsert({
        where: { sourceTrackId: source.id },
        create: { sourceTrackId: source.id, ...data },
        update: data,
      })

      if (result.status === 'MATCHED') matched += 1
      else if (result.status === 'NEEDS_REVIEW') review += 1
      else missing += 1

      examined += 1
    }

    await ctx.setProgress(examined, total, `${examined} of ${total} matched`)
  }

  await ctx.log('info', 'Match sweep complete', { examined, matched, review, missing })
  return { examined, matched, review, missing }
}

/** Library coverage for the Overview screen. Honest counts, no estimates. */
export async function computeCoverage(): Promise<{
  total: number
  matched: number
  review: number
  missing: number
  percent: number
}> {
  const [total, matched, review, missing] = await Promise.all([
    prisma.sourceTrack.count(),
    prisma.match.count({ where: { status: 'MATCHED' } }),
    prisma.match.count({ where: { status: 'NEEDS_REVIEW' } }),
    prisma.match.count({ where: { status: 'MISSING' } }),
  ])
  return {
    total,
    matched,
    review,
    missing,
    percent: total === 0 ? 0 : Math.round((matched / total) * 100),
  }
}
