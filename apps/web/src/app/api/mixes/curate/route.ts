/**
 * The free-text curator box (§7.8): "describe a mood, get a playlist written to
 * Navidrome in seconds."
 *
 * Enqueued, not executed here. An LLM round trip is tens of seconds against Ollama on a
 * shared GPU, and §4 keeps that out of a request handler — the job also has to survive a
 * redeploy, and the resolver that checks every returned track against the library needs
 * database access in the worker anyway.
 */

import { z } from 'zod'
import { enqueueJob, jobId } from '../../../../lib/queue'
import { isUnauthorized, requireApiSession } from '../../../../lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z.object({
  request: z.string().min(3).max(500),
  size: z.number().int().min(5).max(100).optional(),
})

export async function POST(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: 'Describe what you want in a sentence or two.' }, { status: 400 })
  }

  await enqueueJob(
    'recommend',
    'curate',
    { request: parsed.data.request, size: parsed.data.size ?? 30 },
    { jobId: jobId('curate', Date.now()) },
  )

  return Response.json({
    ok: true,
    message:
      'Working on it. Every track the model suggests is checked against your actual library and anything that is not there is dropped — the count appears in the job log.',
  })
}
