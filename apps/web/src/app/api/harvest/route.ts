/**
 * Start a harvest, and read back the last summary.
 *
 * The route only ENQUEUES — the harvest itself takes many minutes and runs in the
 * worker (§4: never run long work from a request handler).
 */

import { prisma } from '@crate/db'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const row = await prisma.setting.findUnique({ where: { key: 'spotify:harvest:summary' } })
  if (!row) return new Response(null, { status: 204 })
  return Response.json(row.value)
}

export async function POST() {
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  })
  try {
    const queue = new Queue('spotify-sync', { connection })
    // Deterministic id keyed to the minute: double-clicking the button cannot start
    // two concurrent harvests. Colons are stripped — BullMQ rejects them in custom ids.
    const jobId = `harvest__${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')}`
    await queue.add('harvest', { resume: true }, { jobId })
    await queue.close()
    return Response.json({ ok: true, jobId })
  } finally {
    await connection.quit()
  }
}
