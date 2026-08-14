/**
 * "Run now" for every scheduled job. §7.10: "Everything on a schedule, all intervals
 * configurable, all with a manual 'run now'."
 *
 * The allow-list itself lives in `lib/jobs.ts` — a Next.js route file may only export
 * HTTP methods and a fixed set of config fields, and anything else fails the build.
 */

import { z } from 'zod'
import { RUNNABLE } from '../../../../lib/jobs'
import { enqueueJob, jobId } from '../../../../lib/queue'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z.object({ job: z.string().min(1) })

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })

  const job = RUNNABLE[parsed.data.job]
  if (!job) return Response.json({ error: `Unknown job "${parsed.data.job}"` }, { status: 400 })

  // Timestamped so a deliberate second press actually runs again — a stable id would be
  // rejected as a duplicate while the first is still queued, which reads as "nothing
  // happened".
  await enqueueJob(job.queue, job.name, job.data ?? {}, {
    jobId: jobId('manual', parsed.data.job, Date.now()),
  })

  return Response.json({ ok: true, description: job.description })
}

export async function GET() {
  return Response.json(
    Object.entries(RUNNABLE).map(([key, job]) => ({
      key,
      queue: job.queue,
      description: job.description,
    })),
  )
}
