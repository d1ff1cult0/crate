/**
 * Fingerprinting and the AcoustID → MusicBrainz → ISRC backfill. Phase 2.
 *
 * This is the argument from plan.md §1.3 made concrete: the matching cascade's tier 1
 * is ISRC, but ISRC tags are written by the phase-4 post-processor, and the owner's
 * existing library is a Lidarr-managed collection of rips that mostly lack them. So for
 * every file already on disk, this path recovers the identifiers for free:
 *
 *   fpcalc → chromaprint → AcoustID → MusicBrainz recording id → ISRC
 *
 * It costs no Spotify quota, which matters a great deal with the subscription lapsing.
 * Without it, phase 3 reports the owner as missing music they already own.
 *
 * AcoustID is optional throughout: with no key configured every lookup returns empty
 * and the fingerprint is still stored, which keeps local dedupe fully functional
 * (DECISIONS D3).
 */

import { prisma } from '@crate/db'
import { AcoustidClient, MusicbrainzClient } from '@crate/integrations'
import type { JobRunContext } from '../lib/jobrun.js'
import { computeFingerprint } from './scan.js'

/** Simple spacing limiter — AcoustID asks for ≤3 req/s, MusicBrainz for ≤1 req/s. */
function spacer(minIntervalMs: number): () => Promise<void> {
  let last = 0
  return async () => {
    const wait = last + minIntervalMs - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    last = Date.now()
  }
}

const acoustidSpacer = spacer(350) // ~3/s
const musicbrainzSpacer = spacer(1100) // ~1/s

export async function runFingerprintFile(
  ctx: JobRunContext,
  fileId: string,
  path: string,
): Promise<void> {
  const result = await computeFingerprint(path)
  if (!result) {
    await ctx.log('warn', 'fpcalc produced no fingerprint', { path })
    return
  }

  await prisma.libraryFile.update({
    where: { id: fileId },
    data: { fingerprint: result.fingerprint },
  })

  const apiKey = process.env.ACOUSTID_API_KEY
  const acoustid = new AcoustidClient({
    apiKey,
    beforeRequest: acoustidSpacer,
    log: (level, msg) => {
      void ctx.log(level, msg)
    },
  })

  if (!acoustid.enabled) {
    // Fingerprint is stored, so dedupe still works fully. Only the ISRC/MBID
    // enrichment is skipped, and it is skipped quietly rather than as an error.
    return
  }

  const match = await acoustid.bestRecording(result.fingerprint, result.durationSec)
  if (!match) {
    await ctx.log('debug', 'AcoustID had no confident match', { path })
    return
  }

  const file = await prisma.libraryFile.findUnique({
    where: { id: fileId },
    select: { trackId: true },
  })
  if (!file?.trackId) return

  const track = await prisma.libraryTrack.findUnique({ where: { id: file.trackId } })
  if (!track) return

  // Recover the ISRC via MusicBrainz — the half that makes tier-1 matching possible.
  let isrc = track.isrc
  if (!isrc) {
    const mb = new MusicbrainzClient({
      beforeRequest: musicbrainzSpacer,
      log: (level, msg) => {
        void ctx.log(level, msg)
      },
    })
    const isrcs = await mb.getRecordingIsrcs(match.mbid)
    isrc = isrcs[0] ?? null
  }

  await prisma.libraryTrack.update({
    where: { id: track.id },
    data: {
      acoustId: match.acoustId,
      ...(track.mbid ? {} : { mbid: match.mbid }),
      ...(isrc && !track.isrc ? { isrc } : {}),
    },
  })

  await ctx.log(
    'info',
    isrc ? 'Recovered ISRC from fingerprint' : 'Recovered MusicBrainz id from fingerprint',
    { path, mbid: match.mbid, ...(isrc ? { isrc } : {}) },
  )
}

/**
 * Sweep files that have no fingerprint yet. Resumable and throttled by construction —
 * it processes a bounded batch and reports what remains, so it can be interrupted at
 * any point without losing progress (§7.4).
 */
export async function runFingerprintSweep(
  ctx: JobRunContext,
  batchSize = 200,
): Promise<{ processed: number; remaining: number }> {
  const pending = await prisma.libraryFile.findMany({
    where: { fingerprint: null, missingSince: null },
    select: { id: true, path: true },
    take: batchSize,
  })

  let processed = 0
  for (const file of pending) {
    try {
      await runFingerprintFile(ctx, file.id, file.path)
      processed += 1
    } catch (err) {
      await ctx.log('warn', 'Fingerprinting failed', {
        path: file.path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await ctx.setProgress(processed, pending.length, `${processed} of ${pending.length} fingerprinted`)
  }

  const remaining = await prisma.libraryFile.count({
    where: { fingerprint: null, missingSince: null },
  })

  await ctx.log('info', 'Fingerprint sweep batch complete', { processed, remaining })
  return { processed, remaining }
}
