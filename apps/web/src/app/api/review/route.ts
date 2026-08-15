/**
 * Review decisions. A manual decision is authoritative — the match sweep will not
 * revisit anything marked MANUAL (see apps/worker/src/jobs/match.ts).
 */

import { prisma } from '@crate/db'
import { z } from 'zod'
import { isUnauthorized, requireApiSession } from '../../../lib/session'

export const dynamic = 'force-dynamic'

const BodySchema = z.object({
  matchId: z.string().min(1),
  action: z.enum(['accept', 'reject', 'download']),
})

export async function POST(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })

  const { matchId, action } = parsed.data
  const match = await prisma.match.findUnique({ where: { id: matchId } })
  if (!match) return Response.json({ error: 'No such match' }, { status: 404 })

  if (action === 'accept') {
    await prisma.match.update({
      where: { id: matchId },
      data: { status: 'MATCHED', method: 'MANUAL', confidence: 1, reviewedAt: new Date() },
    })
  } else if (action === 'reject') {
    await prisma.match.update({
      where: { id: matchId },
      data: {
        status: 'REJECTED',
        method: 'MANUAL',
        libraryTrackId: null,
        reviewedAt: new Date(),
      },
    })
  } else {
    await prisma.$transaction([
      prisma.match.update({
        where: { id: matchId },
        data: { status: 'DOWNLOADING', method: 'MANUAL', reviewedAt: new Date() },
      }),
      prisma.downloadRequest.create({
        data: { sourceTrackId: match.sourceTrackId, status: 'QUEUED', priority: 5 },
      }),
    ])
  }

  return Response.json({ ok: true })
}
