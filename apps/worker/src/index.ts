/**
 * Worker entrypoint.
 *
 * A long-running process, deliberately separate from Next.js (§4): downloads and
 * harvests take minutes and must survive a redeploy. Nothing here runs inside a request
 * handler.
 */

import { prisma } from '@crate/db'
import type { Job } from 'bullmq'
import { applyDedupe, runDedupeScan } from './jobs/dedupe.js'
import { enqueueMissing, retryAfterRejection, runDownload } from './jobs/download.js'
import { BOOT_AUTO_RECONCILE_MAX, reconcileDownloadQueue } from './lib/download-queue.js'
import { runHarvest, runIsrcBackfill } from './jobs/harvest.js'
import { runFingerprintFile, runFingerprintSweep } from './jobs/fingerprint.js'
import { runMatchSweep } from './jobs/match.js'
import {
  materializePlaylist,
  triggerScan,
  writeAffectedPlaylists,
  writeAllPlaylists,
  writePlaylist,
} from './jobs/playlist.js'
import { runPostprocess } from './jobs/postprocess.js'
import { runCurate, runGenerateMixes, runReleaseRadar, runTasteRefresh } from './jobs/recommend.js'
import { runRestore } from './jobs/restore.js'
import { runLibraryScan } from './jobs/scan.js'
import { JobRunContext } from './lib/jobrun.js'
import { runNavidromeScan } from './lib/navidrome.js'
import { closeAll, createWorker, type QueueName } from './lib/queues.js'
import { loadSettings } from './lib/settings.js'
import { purgeTrash, undoTrashOperation } from './lib/trash.js'
import { registerSchedules } from './schedules.js'

const log = (msg: string, extra?: Record<string, unknown>) => {
  // Structured, one line per event, so `docker compose logs -f worker` is readable.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...extra }))
}

/** Wrap a processor so every job gets a JobRun row and a terminal state. */
function tracked(
  queue: QueueName,
  handler: (ctx: JobRunContext, job: Job) => Promise<unknown>,
) {
  return async (job: Job) => {
    const ctx = await JobRunContext.start(queue, job.name, job.data, job.id)
    try {
      const result = await handler(ctx, job)
      // A job that paused itself has already written its terminal state.
      const row = await prisma.jobRun.findUnique({ where: { id: ctx.id }, select: { status: true } })
      if (row?.status === 'RUNNING') await ctx.succeed()
      return result
    } catch (err) {
      await ctx.fail(err)
      throw err
    }
  }
}

async function main() {
  log('worker starting')

  const workers = [
    createWorker(
      'spotify-sync',
      tracked('spotify-sync', async (ctx, job) => {
        if (job.name === 'harvest') {
          return runHarvest(ctx, { resume: job.data?.resume === true })
        }
        // Hourly sync reuses the harvest with resume semantics: unchanged snapshot_ids
        // are skipped inside the orchestrator.
        return runHarvest(ctx, { resume: true })
      }),
    ),

    createWorker(
      'spotify-isrc-backfill',
      tracked('spotify-isrc-backfill', async (ctx, job) => {
        const spotifyId = String(job.data?.spotifyId ?? '')
        if (!spotifyId) return
        return runIsrcBackfill(ctx, spotifyId)
      }),
    ),

    createWorker(
      'library-scan',
      tracked('library-scan', async (ctx, job) => runLibraryScan(ctx, { full: job.data?.full === true })),
    ),

    createWorker(
      'fingerprint',
      tracked('fingerprint', async (ctx, job) => {
        if (job.name === 'fingerprint-sweep') return runFingerprintSweep(ctx)
        return runFingerprintFile(ctx, String(job.data.fileId), String(job.data.path))
      }),
    ),

    createWorker(
      'match',
      tracked('match', async (ctx, job) => runMatchSweep(ctx, { all: job.data?.all === true })),
    ),

    createWorker(
      'download',
      tracked('download', async (ctx, job) => {
        if (job.name === 'enqueue-missing') {
          return enqueueMissing(ctx, {
            retryAbandoned: job.data?.retryAbandoned === true,
          })
        }
        if (job.name === 'reconcile') {
          return reconcileDownloadQueue(ctx)
        }
        return runDownload(ctx, {
          requestId: String(job.data.requestId),
          ...(Array.isArray(job.data.exclude) ? { exclude: job.data.exclude as string[] } : {}),
        })
      }),
    ),

    createWorker(
      'postprocess',
      tracked('postprocess', async (ctx, job) => {
        const result = await runPostprocess(ctx, {
          requestId: String(job.data.requestId),
          stagedPath: String(job.data.stagedPath),
          provider: String(job.data.provider),
        })
        // §7.6 step 1: a file that fails verification falls through to the next
        // provider. Across a queue boundary that means re-queueing the download with
        // this provider excluded, rather than failing the job.
        if (result.rejected) {
          await retryAfterRejection(String(job.data.requestId), String(job.data.provider))
        }
        return result
      }),
    ),

    createWorker(
      'recommend',
      tracked('recommend', async (ctx, job) => {
        if (job.name === 'release-radar') return runReleaseRadar(ctx)
        if (job.name === 'taste-refresh') return runTasteRefresh(ctx)
        if (job.name === 'curate') {
          return runCurate(ctx, String(job.data.request), Number(job.data.size ?? 30))
        }
        return runGenerateMixes(ctx, {
          ...(typeof job.data?.slot === 'number' ? { onlySlot: job.data.slot as number } : {}),
        })
      }),
    ),

    createWorker(
      'playlist-write',
      tracked('playlist-write', async (ctx, job) => {
        if (job.name === 'write-all') return writeAllPlaylists(ctx)
        if (job.name === 'write-affected') {
          return writeAffectedPlaylists(ctx, String(job.data.sourceTrackId))
        }
        if (job.data?.playlistId) {
          const result = await writePlaylist(ctx, String(job.data.playlistId))
          await triggerScan(ctx)
          return result
        }

        const sourcePlaylistId = String(job.data?.sourcePlaylistId ?? '')
        if (!sourcePlaylistId) return
        // Materialize first so the item list reflects the current match state, then
        // write. Doing it in this order is what makes "fill gaps" show up immediately
        // after a download lands.
        const playlistId = await materializePlaylist(ctx, sourcePlaylistId)
        if (!playlistId) return
        const result = await writePlaylist(ctx, playlistId)
        await triggerScan(ctx)
        return result
      }),
    ),

    createWorker(
      'maintenance',
      tracked('maintenance', async (ctx, job) => {
        switch (job.name) {
          case 'navidrome-scan':
            return runNavidromeScan(ctx)
          case 'dedupe-scan':
            return runDedupeScan(ctx)
          case 'dedupe-apply':
            return applyDedupe(ctx, {
              ...(Array.isArray(job.data?.groupIds)
                ? { groupIds: job.data.groupIds as string[] }
                : {}),
              ...(typeof job.data?.minConfidence === 'number'
                ? { minConfidence: job.data.minConfidence as number }
                : {}),
              dryRun: job.data?.dryRun !== false,
            })
          case 'dedupe-undo': {
            const result = await undoTrashOperation(String(job.data.operationId))
            await ctx.log('info', `Restored ${result.restored} file(s) from the trash`, {
              failed: result.failed,
            })
            return result
          }
          case 'restore-backup':
            return runRestore(ctx, String(job.data.path))
          case 'trash-retention': {
            const settings = await loadSettings()
            return purgeTrash(ctx, {
              enabled: settings.trashRetentionEnabled,
              days: settings.trashRetentionDays,
              trashRoot: process.env.TRASH_ROOT ?? settings.trashRoot,
            })
          }
          default:
            await ctx.log('warn', `Unknown maintenance job: ${job.name}`)
            return
        }
      }),
    ),
  ]

  for (const w of workers) {
    w.on('failed', (job, err) => {
      log('job failed', { queue: w.name, job: job?.name, error: err.message })
    })
    w.on('completed', (job) => {
      log('job completed', { queue: w.name, job: job.name })
    })
  }

  await registerSchedules()

  // Self-heal on boot.
  //
  // A DownloadRequest row and its BullMQ job live in two stores with no transaction
  // between them, so they can drift — and when they do the symptom is silence: rows sit
  // at QUEUED, Redis is empty, and nothing errors because nothing was ever asked to run.
  // Reconciling at startup means that state cannot outlive a restart, which is the one
  // recovery action an operator is guaranteed to try.
  try {
    const bootCtx = await JobRunContext.start('download', 'reconcile-on-boot')
    // Capped: small drift is repaired silently, a large backlog is reported and left for
    // an explicit decision rather than starting a mass download seconds after a restart.
    const result = await reconcileDownloadQueue(bootCtx, { autoLimit: BOOT_AUTO_RECONCILE_MAX })
    await bootCtx.succeed(
      result.heldBack
        ? `${result.heldBack} orphaned download request(s) found — not released automatically`
        : result.enqueued > 0
          ? `Re-queued ${result.enqueued} orphaned download request(s) on boot`
          : undefined,
    )
    if (result.enqueued > 0 || result.heldBack) {
      log('download queue reconciliation on boot', { ...result })
    }
  } catch (err) {
    // Never let a reconciliation failure stop the worker from starting.
    log('boot reconciliation failed', { error: err instanceof Error ? err.message : String(err) })
  }

  log('worker ready', { queues: workers.map((w) => w.name) })

  const shutdown = async (signal: string) => {
    log('shutting down', { signal })
    // Let in-flight jobs finish: a half-written harvest checkpoint is worse than a
    // slightly slower restart.
    await Promise.all(workers.map((w) => w.close()))
    await closeAll()
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: err.message, stack: err.stack }))
  process.exit(1)
})
