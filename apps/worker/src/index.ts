/**
 * Worker entrypoint.
 *
 * A long-running process, deliberately separate from Next.js (§4): downloads and
 * harvests take minutes and must survive a redeploy. Nothing here runs inside a request
 * handler.
 */

import { prisma } from '@crate/db'
import type { Job } from 'bullmq'
import { runHarvest, runIsrcBackfill } from './jobs/harvest.js'
import { runFingerprintFile, runFingerprintSweep } from './jobs/fingerprint.js'
import { runMatchSweep } from './jobs/match.js'
import {
  materializePlaylist,
  triggerScan,
  writeAllPlaylists,
  writePlaylist,
} from './jobs/playlist.js'
import { runLibraryScan } from './jobs/scan.js'
import { JobRunContext } from './lib/jobrun.js'
import { closeAll, createWorker, type QueueName } from './lib/queues.js'
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
      'playlist-write',
      tracked('playlist-write', async (ctx, job) => {
        if (job.name === 'write-all') return writeAllPlaylists(ctx)

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
        await ctx.log('info', `maintenance: ${job.name}`)
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
