import { prisma } from '@crate/db'
import { YouTubePlaylistUrlSchema } from '@crate/integrations'
import { z } from 'zod'
import { Redis } from 'ioredis'
import { jobId, withQueue } from '../../../../lib/queue'
import { isUnauthorized, requireApiSession } from '../../../../lib/session'
import { youtubeImportRateLimitKey } from '../../../../lib/youtube-import-security'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z.object({ url: YouTubePlaylistUrlSchema })
const MAX_BODY_BYTES = 4 * 1024
async function rateLimited(request: Request, method: 'GET' | 'POST', limit: number): Promise<boolean> {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const identity = forwarded ?? request.headers.get('x-real-ip') ?? 'unknown'
  const key = youtubeImportRateLimitKey(method, identity)
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, connectTimeout: 2_000 })
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 60)
    return count > limit
  } finally { await redis.quit().catch(() => undefined) }
}

export async function POST(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  try {
    if (await rateLimited(request, 'POST', 10)) return Response.json({ error: 'Too many import attempts. Retry in one minute.' }, { status: 429 })
  } catch { return Response.json({ error: 'Import protection is temporarily unavailable.' }, { status: 503 }) }
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return Response.json({ error: 'Request body is too large.' }, { status: 413 })
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return Response.json({ error: 'Request body is too large.' }, { status: 413 })
  const parsed = BodySchema.safeParse((() => { try { return JSON.parse(text) as unknown } catch { return null } })())
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

export async function GET(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  try {
    if (await rateLimited(request, 'GET', 60)) return Response.json({ error: 'Too many history requests. Retry in one minute.' }, { status: 429 })
  } catch { return Response.json({ error: 'Import protection is temporarily unavailable.' }, { status: 503 }) }
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
