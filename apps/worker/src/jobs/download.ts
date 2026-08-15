/**
 * The download queue — PROMPT.md §7.5, phase 4.
 *
 * Drives the provider chain for one `DownloadRequest`, records every scored candidate
 * whether it won or not, and hands the staged file to the post-processor.
 *
 * Two rules from the brief are implemented here rather than in the registry, because
 * both need the database:
 *
 *  - **Never re-run a provider that returned NO_RESULTS for the same query within 24h.**
 *    Without this, the nightly retry sweep hammers every provider with queries already
 *    known to be fruitless.
 *  - **After all providers fail, mark ABANDONED with the full attempt history**, so the
 *    "couldn't find these" view can explain what was tried and the owner can paste a URL.
 *
 * The single most damaging failure this app can have is the wrong track landing in the
 * library. That is why nothing here decides what "good enough" means: scoring is pure
 * and lives in `packages/core`, the whole scored list is written to `DownloadAttempt`
 * before any bytes move, and verification runs in the post-processor before the file is
 * allowed anywhere near `MUSIC_ROOT`.
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@crate/db'
import {
  acquireTrack,
  queryString,
  YtmProvider,
  type DownloadProvider,
  type TrackQuery,
} from '@crate/providers'
import { reconcileDownloadQueue, requestDownload } from '../lib/download-queue.js'
import type { JobRunContext } from '../lib/jobrun.js'
import { enqueue, jobId } from '../lib/queues.js'
import { loadSettings, type Settings } from '../lib/settings.js'

export interface DownloadJobInput {
  requestId: string
  /** Providers already rejected for this request — post-processing verification failed. */
  exclude?: string[]
}

/**
 * Build the enabled provider set from settings.
 *
 * Only YouTube Music exists so far, and that is deliberate (§10 phase 4): it needs no
 * credentials, so it is the one adapter that can be exercised end to end without asking
 * the owner to set anything up, which makes it what the post-processing chain gets
 * tested against. slskd and streamrip both need setup the brief says to ask about first
 * (§12), so they are not written yet — the registry takes them as new files, not a
 * refactor.
 */
export function buildProviders(settings: Settings): DownloadProvider[] {
  const configured = settings.providers ?? {}
  const providers: DownloadProvider[] = []

  const ytmConfig = configured['ytm']
  providers.push(
    new YtmProvider({
      config: {
        ...(ytmConfig?.enabled === false ? { enabled: false } : { enabled: true }),
        ...(ytmConfig?.priority !== undefined ? { priority: ytmConfig.priority } : {}),
        ...(ytmConfig?.concurrency !== undefined ? { concurrency: ytmConfig.concurrency } : {}),
      },
    }),
  )

  return providers
}

/** §7.5: no re-asking a provider that said "nothing" for this query in the last 24 hours. */
async function recentlyExhausted(provider: string, query: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const hit = await prisma.downloadAttempt.findFirst({
    where: { provider, query, outcome: 'NO_RESULTS', createdAt: { gte: since } },
    select: { id: true },
  })
  return hit !== null
}

export interface DownloadResult {
  status: 'SUCCEEDED' | 'ABANDONED' | 'FAILED' | 'SKIPPED'
  provider?: string
  detail: string
}

export async function runDownload(
  ctx: JobRunContext,
  input: DownloadJobInput,
): Promise<DownloadResult> {
  const settings = await loadSettings()

  const request = await prisma.downloadRequest.findUnique({
    where: { id: input.requestId },
    include: { sourceTrack: true },
  })
  if (!request) {
    await ctx.log('warn', 'Download request no longer exists', { requestId: input.requestId })
    return { status: 'SKIPPED', detail: 'request no longer exists' }
  }
  if (request.status === 'SUCCEEDED') {
    return { status: 'SKIPPED', detail: 'already satisfied' }
  }
  if (request.status === 'MANUAL_HOLD') {
    await ctx.log('info', 'On manual hold — not attempting')
    return { status: 'SKIPPED', detail: 'manual hold' }
  }
  if (!settings.downloadEnabled) {
    await ctx.log('info', 'Downloading is switched off in settings')
    return { status: 'SKIPPED', detail: 'downloads disabled' }
  }

  const source = request.sourceTrack
  const raw = source.rawJson && typeof source.rawJson === 'object' && !Array.isArray(source.rawJson)
    ? source.rawJson as Record<string, unknown>
    : null
  const preferredCandidateId = source.source === 'YOUTUBE' && typeof raw?.crateCanonicalYtmVideoId === 'string'
    ? raw.crateCanonicalYtmVideoId
    : undefined
  const query: TrackQuery = {
    title: source.title,
    artists: source.artists,
    album: source.album ?? undefined,
    durationMs: source.durationMs ?? undefined,
    isrc: source.isrc ?? undefined,
    year: source.year ?? undefined,
    ...(preferredCandidateId ? { preferredCandidateId } : {}),
  }
  const label = queryString(query)

  await prisma.downloadRequest.update({
    where: { id: request.id },
    data: { status: 'RUNNING' },
  })
  await ctx.log('info', `Looking for ${label}`, {
    isrc: source.isrc ?? '(none)',
    durationMs: source.durationMs,
    excluded: input.exclude ?? [],
  })

  const excluded = new Set(input.exclude ?? [])
  const providers = buildProviders(settings).filter((p) => !excluded.has(p.name))

  if (providers.length === 0) {
    return abandon(ctx, request.id, 'Every configured provider has already been tried and rejected')
  }

  // Staging is per-request so a failed attempt leaves nothing behind to confuse the
  // next one, and so two concurrent downloads cannot collide on a filename.
  const stagingRoot = process.env.STAGING_ROOT ?? settings.stagingRoot
  const stagingDir = join(stagingRoot, request.id)
  await mkdir(stagingDir, { recursive: true })

  let result
  try {
    result = await acquireTrack(providers, query, {
      destinationDir: stagingDir,
      recentlyExhausted,
      ...(settings.downloadMinBitrateKbps > 0
        ? { minBitrateKbps: settings.downloadMinBitrateKbps }
        : {}),
      onProgress: (p) => {
        if (p.percent !== undefined) {
          void ctx.setProgress(Math.round(p.percent), 100, `${p.provider}: ${p.message ?? 'downloading'}`)
        }
      },
    })
  } catch (err) {
    // An unexpected throw out of the chain itself, not a provider failure — those are
    // caught inside and recorded as attempts.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  // Record every attempt, with the full scored candidate list. §7.5: "when a wrong track
  // lands I want to see why it won."
  for (const attempt of result.attempts) {
    await prisma.downloadAttempt.create({
      data: {
        requestId: request.id,
        provider: attempt.provider,
        query: attempt.query,
        outcome: attempt.outcome,
        detail: attempt.detail ?? null,
        durationMs: attempt.durationMs,
        candidateJson: {
          scored: attempt.scored.map((c) => ({
            id: c.id,
            title: c.title,
            artist: c.artist,
            album: c.album,
            durationMs: c.durationMs,
            format: c.format,
            bitrate: c.bitrate,
            score: c.score,
            reasons: c.reasons,
            rejected: c.rejected ?? null,
          })),
          chosen: attempt.chosen ?? null,
        } as object,
      },
    })
    await ctx.log(
      attempt.outcome === 'SUCCESS' ? 'info' : 'warn',
      `${attempt.provider}: ${attempt.outcome}${attempt.detail ? ` — ${attempt.detail}` : ''}`,
      { candidates: attempt.scored.length },
    )
  }

  if (!result.file) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    const summary = result.attempts.map((a) => `${a.provider} (${a.outcome})`).join(', ') || 'none'

    // ABANDONED is a CONCLUSION, not a synonym for "this attempt did not work."
    //
    // It means every provider was asked and none has this track — a settled fact that
    // stops further attempts until the owner explicitly retries. A transient failure is
    // a completely different thing: a 403 from YouTube throttling, a timeout, a network
    // blip. Treating those as ABANDONED would permanently write off tracks that are
    // perfectly obtainable an hour later, and on a bulk drain it would do that to
    // hundreds at once. Observed for real: the same video downloaded fine, then returned
    // `HTTP Error 403: Forbidden` under repeated requests, then worked again.
    const transient = result.attempts.some(
      (a) => a.outcome === 'ERROR' || a.outcome === 'TIMEOUT' || a.outcome === 'RATE_LIMITED',
    )

    if (transient) {
      await prisma.downloadRequest.update({
        where: { id: request.id },
        data: { status: 'FAILED', lastError: `Temporary failure. Tried: ${summary}` },
      })
      await ctx.log('warn', `Temporary failure, will retry later: ${summary}`, {
        note: 'Left as FAILED rather than ABANDONED — retry it from the Queue screen, or it will be picked up by the next retry sweep.',
      })
      return { status: 'FAILED', detail: `temporary failure: ${summary}` }
    }

    return abandon(ctx, request.id, `No provider could supply this track. Tried: ${summary}`)
  }

  await ctx.log('info', `Got it from ${result.provider}`, {
    path: result.file.path,
    format: result.file.format,
    sizeBytes: result.file.sizeBytes,
  })

  // Hand off. Post-processing is its own queue because it is CPU work (decode, hash,
  // fingerprint) and must not hold a download slot while it runs.
  await enqueue(
    'postprocess',
    'postprocess',
    { requestId: request.id, stagedPath: result.file.path, provider: result.provider },
    { jobId: jobId('pp', request.id, Date.now()) },
  )

  return {
    status: 'SUCCEEDED',
    ...(result.provider ? { provider: result.provider } : {}),
    detail: `staged from ${result.provider}, queued for post-processing`,
  }
}

/**
 * Re-run the chain excluding providers whose file failed verification.
 *
 * §7.6 step 1: "Reject and fall through to the next provider on failure." Verification
 * happens in the post-processor, one queue later, so the fall-through is a re-queue
 * rather than a loop iteration — the excluded list is what carries the state across.
 */
export async function retryAfterRejection(
  requestId: string,
  rejectedProvider: string,
): Promise<void> {
  const settings = await loadSettings()
  const attempts = await prisma.downloadAttempt.findMany({
    where: { requestId, outcome: 'REJECTED_VERIFY' },
    select: { provider: true },
  })
  const exclude = [...new Set([...attempts.map((a) => a.provider), rejectedProvider])]

  const remaining = buildProviders(settings).filter((p) => !exclude.includes(p.name))
  if (remaining.length === 0) {
    await prisma.downloadRequest.update({
      where: { id: requestId },
      data: {
        status: 'ABANDONED',
        lastError: `Every provider produced a file that failed verification: ${exclude.join(', ')}`,
      },
    })
    return
  }

  // A distinct id per exclusion round, so this is a genuinely new job rather than an
  // add() silently swallowed by the completed one it is retrying (see core/download-queue).
  await enqueue(
    'download',
    'download',
    { requestId, exclude },
    { jobId: jobId('dl', requestId, 'retry', exclude.length) },
  )
}

async function abandon(
  ctx: JobRunContext,
  requestId: string,
  detail: string,
): Promise<DownloadResult> {
  await prisma.downloadRequest.update({
    where: { id: requestId },
    data: { status: 'ABANDONED', lastError: detail },
  })
  await ctx.log('warn', `Abandoned: ${detail}`)
  return { status: 'ABANDONED', detail }
}

/**
 * Raise download requests for everything the matcher marked MISSING.
 *
 * Idempotent by construction: one request per source track, and an existing one in any
 * state other than ABANDONED is left alone rather than duplicated. Priority favours
 * tracks that appear in more playlists — those are the gaps the owner will actually
 * notice.
 */
export async function enqueueMissing(
  ctx: JobRunContext,
  opts: { limit?: number; retryAbandoned?: boolean } = {},
): Promise<{ queued: number; alreadyQueued: number; reconciled: number }> {
  const missing = await prisma.match.findMany({
    where: { status: 'MISSING' },
    select: {
      sourceTrackId: true,
      sourceTrack: { select: { _count: { select: { memberships: true } } } },
    },
    take: opts.limit ?? 5000,
  })

  let queued = 0
  let alreadyQueued = 0

  for (const match of missing) {
    // `requestDownload` reuses an existing row and — critically — still guarantees a job
    // behind it. The old code here skipped any track that already had a request,
    // treating "a row exists" as "the work is scheduled". For 168 rows written by a
    // producer that never enqueued anything, it was not, and this was the button that
    // should have rescued them and instead reported them all as already queued.
    const result = await requestDownload(match.sourceTrackId, {
      priority: match.sourceTrack._count.memberships,
      ...(opts.retryAbandoned ? { retryAbandoned: true } : {}),
    })
    if (result.enqueued) queued += 1
    else alreadyQueued += 1
  }

  // Anything outstanding that no longer maps to a MISSING match — a request whose match
  // was since resolved by hand, or one left orphaned by a worker that died mid-flight —
  // is swept up here rather than left to sit forever.
  const reconciled = await reconcileDownloadQueue(ctx)

  await ctx.log('info', `Queued ${queued} download(s)`, {
    alreadyQueued,
    reconciled: reconciled.enqueued,
  })
  return { queued, alreadyQueued, reconciled: reconciled.enqueued }
}
