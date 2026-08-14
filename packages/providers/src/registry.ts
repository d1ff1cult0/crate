/**
 * Provider registry and the fall-through chain. PROMPT.md §7.5.
 *
 * "On failure, fall through to the next provider automatically. After all providers
 *  fail, mark ABANDONED with the full attempt history."
 *
 * Two rules encoded here that are easy to get wrong:
 *
 *  - A provider that returned NO_RESULTS for the same query within 24h is skipped
 *    rather than re-asked. Without this, a nightly retry sweep hammers every provider
 *    with queries already known to be fruitless.
 *  - Candidate scoring happens BEFORE download, and the full scored list is returned
 *    whether or not anything won — §7.5 requires that log so a wrong pick can be
 *    explained after the fact.
 */

import { rankCandidates, type ScoredCandidate } from '@crate/core'
import type {
  AttemptOutcome,
  Candidate,
  DownloadProvider,
  DownloadedFile,
  Progress,
  TrackQuery,
} from './types.js'

/**
 * A score joined back to the candidate it describes.
 *
 * `ScoredCandidate` alone carries only an id, and §7.5 asks for a log that explains why
 * a wrong track won — which needs the title, artist, album and duration that lost to it,
 * not a list of opaque provider ids.
 */
export interface ScoredEntry extends ScoredCandidate {
  title: string
  artist: string
  album?: string | undefined
  durationMs?: number | undefined
  format?: string | undefined
  bitrate?: number | undefined
}

export interface AttemptRecord {
  provider: string
  query: string
  outcome: AttemptOutcome
  detail?: string
  durationMs: number
  /** Every candidate with its score and reasons, winner or not. */
  scored: ScoredEntry[]
  chosen?: Candidate
}

export interface AcquireResult {
  file: DownloadedFile | null
  chosen?: Candidate | undefined
  provider?: string | undefined
  attempts: AttemptRecord[]
}

export interface AcquireOptions {
  destinationDir: string
  onProgress?: (p: Progress & { provider: string }) => void
  /** Returns true when this provider already returned NO_RESULTS for this query. */
  recentlyExhausted?: (provider: string, query: string) => Promise<boolean>
  minBitrateKbps?: number
}

export function queryString(query: TrackQuery): string {
  return `${query.artists.join(', ')} - ${query.title}`
}

/** Enabled providers, best first. */
export function orderProviders(providers: DownloadProvider[]): DownloadProvider[] {
  return providers
    .filter((p) => p.config.enabled)
    .sort((a, b) => a.config.priority - b.config.priority)
}

export async function acquireTrack(
  providers: DownloadProvider[],
  query: TrackQuery,
  opts: AcquireOptions,
): Promise<AcquireResult> {
  const attempts: AttemptRecord[] = []
  const q = queryString(query)

  for (const provider of orderProviders(providers)) {
    const started = Date.now()

    // Don't re-ask a provider that already said no for this exact query today.
    if (await opts.recentlyExhausted?.(provider.name, q)) {
      attempts.push({
        provider: provider.name,
        query: q,
        outcome: 'NO_RESULTS',
        detail: 'Skipped — this provider had no results for the same query within the last 24 hours.',
        durationMs: 0,
        scored: [],
      })
      continue
    }

    let candidates: Candidate[]
    try {
      candidates = await provider.search(query)
    } catch (err) {
      attempts.push({
        provider: provider.name,
        query: q,
        outcome: /timed out/i.test(String(err)) ? 'TIMEOUT' : 'ERROR',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        scored: [],
      })
      continue
    }

    if (candidates.length === 0) {
      attempts.push({
        provider: provider.name,
        query: q,
        outcome: 'NO_RESULTS',
        durationMs: Date.now() - started,
        scored: [],
      })
      continue
    }

    const target = {
      title: query.title,
      artists: query.artists,
      album: query.album ?? null,
      durationMs: query.durationMs ?? null,
    }
    const scoringOpts = opts.minBitrateKbps ? { minBitrateKbps: opts.minBitrateKbps } : {}
    const byId = new Map(candidates.map((c) => [c.id, c]))

    // Ranked once. `rankCandidates` already sorts accepted-before-rejected and then by
    // descending score, so the winner is simply the head of the list when it is not
    // rejected — scoring twice to ask the same question would only risk the two answers
    // disagreeing after a future tuning pass.
    const ranked = rankCandidates(
      target,
      candidates.map((c) => ({
        id: c.id,
        title: c.title,
        artist: c.artist,
        album: c.album ?? null,
        durationMs: c.durationMs ?? null,
        format: c.format ?? null,
        bitrate: c.bitrate ?? null,
      })),
      { durationToleranceMs: 5000, minBitrateKbps: 0, acceptFloor: 0.5, artistPlausibilityFloor: 0.3, ...scoringOpts },
    )

    const scored: ScoredEntry[] = ranked.map((s) => {
      const c = byId.get(s.id)
      return {
        ...s,
        title: c?.title ?? '',
        artist: c?.artist ?? '',
        album: c?.album,
        durationMs: c?.durationMs,
        format: c?.format,
        bitrate: c?.bitrate,
      }
    })

    const head = ranked[0]
    const winner = head && !head.rejected ? head : null

    if (!winner) {
      // Results existed but none were good enough. This is a DIFFERENT outcome from
      // "no results" and must not suppress a retry the way NO_RESULTS does.
      attempts.push({
        provider: provider.name,
        query: q,
        outcome: 'REJECTED_QUALITY',
        detail: `${candidates.length} result(s), none cleared the quality bar. Best was ${scored[0]?.score.toFixed(2) ?? 'n/a'}.`,
        durationMs: Date.now() - started,
        scored,
      })
      continue
    }

    const chosen = byId.get(winner.id)!
    try {
      const file = await provider.download(chosen, opts.destinationDir, (p) =>
        opts.onProgress?.({ ...p, provider: provider.name }),
      )
      attempts.push({
        provider: provider.name,
        query: q,
        outcome: 'SUCCESS',
        detail: `Chose "${chosen.title}" by "${chosen.artist}" at score ${winner.score.toFixed(2)}`,
        durationMs: Date.now() - started,
        scored,
        chosen,
      })
      return { file, chosen, provider: provider.name, attempts }
    } catch (err) {
      attempts.push({
        provider: provider.name,
        query: q,
        outcome: /timed out/i.test(String(err)) ? 'TIMEOUT' : 'ERROR',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        scored,
        chosen,
      })
      // Fall through to the next provider (§7.5).
    }
  }

  return { file: null, attempts }
}
