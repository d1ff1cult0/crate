import { prisma } from '@crate/db'
import { YouTubePlaylistUrlSchema } from '@crate/integrations'
import { z } from 'zod'
import { jobId, withQueue } from '../../../../lib/queue'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z.object({ url: YouTubePlaylistUrlSchema })

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({
      error: parsed.error.issues[0]?.message ?? 'Enter a normal YouTube playlist URL.',
    }, { status: 400 })
  }
  const { url, playlistId } = parsed.data.url
  const active = await prisma.importRun.findFirst({
    where: { kind: 'YOUTUBE_PLAYLIST', input: url, status: { in: ['QUEUED', 'RUNNING'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (active) return Response.json({ ok: true, importRunId: active.id, reused: true })

  const deterministicId = jobId('youtube-playlist', playlistId)
  const run = await prisma.importRun.create({
    data: {
      kind: 'YOUTUBE_PLAYLIST', status: 'QUEUED', input: url, jobId: deterministicId,
      message: 'Waiting for the playlist importer worker.',
    },
  })
  try {
    await withQueue('youtube-import', async (queue) => {
      const stale = await queue.getJob(deterministicId)
      if (stale) {
        const state = await stale.getState()
        if (state === 'completed' || state === 'failed') await stale.remove()
        else throw new Error('This playlist already has an active queue job.')
      }
      await queue.add('youtube-playlist', { importRunId: run.id, url }, {
        jobId: deterministicId,
        removeOnComplete: { count: 200 }, removeOnFail: { count: 500 },
        attempts: 3, backoff: { type: 'exponential', delay: 5_000 },
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.importRun.update({ where: { id: run.id }, data: { status: 'FAILED', message } })
    return Response.json({ error: message }, { status: 503 })
  }
  return Response.json({ ok: true, importRunId: run.id, reused: false }, { status: 202 })
}

export async function GET() {
  const runs = await prisma.importRun.findMany({
    where: { kind: 'YOUTUBE_PLAYLIST' }, orderBy: { createdAt: 'desc' }, take: 25,
  })
  const jobIds = runs.map((run) => run.jobId).filter((id): id is string => Boolean(id))
  const jobs = jobIds.length ? await prisma.jobRun.findMany({
    where: { queue: 'youtube-import', jobId: { in: jobIds } },
    select: { jobId: true, progress: true, logsJson: true, error: true },
  }) : []
  const byId = new Map(jobs.map((job) => [job.jobId, job]))
  return Response.json(runs.map((run) => ({
    ...run,
    progress: run.jobId ? byId.get(run.jobId)?.progress ?? (run.status === 'SUCCEEDED' ? 100 : 0) : 0,
    error: run.jobId ? byId.get(run.jobId)?.error ?? null : null,
    logs: run.jobId ? byId.get(run.jobId)?.logsJson ?? [] : [],
  })))
}
