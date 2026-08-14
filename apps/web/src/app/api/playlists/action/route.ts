/**
 * Playlist actions: write it out, or queue downloads for its gaps.
 *
 * Both only ENQUEUE. Writing touches the filesystem and Navidrome; filling gaps starts
 * downloads that take minutes. Neither belongs in a request handler (§4).
 */

import { prisma } from '@crate/db'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'
import { z } from 'zod'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BodySchema = z.object({
  sourcePlaylistId: z.string().min(1),
  action: z.enum(['write', 'fill-gaps']),
})

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'Bad request' }, { status: 400 })

  const { sourcePlaylistId, action } = parsed.data
  const source = await prisma.sourcePlaylist.findUnique({
    where: { id: sourcePlaylistId },
    select: { id: true, name: true },
  })
  if (!source) return Response.json({ error: 'No such playlist' }, { status: 404 })

  if (action === 'fill-gaps') {
    // Everything in this playlist that is not matched, deduplicated by SourceTrack —
    // one download request per recording, not per playlist appearance (plan.md §2.1).
    const items = await prisma.sourcePlaylistItem.findMany({
      where: {
        playlistId: source.id,
        sourceTrack: { match: { is: null } },
      },
      select: { sourceTrackId: true },
    })
    const unmatched = await prisma.sourcePlaylistItem.findMany({
      where: {
        playlistId: source.id,
        sourceTrack: { match: { status: { in: ['MISSING', 'NEEDS_REVIEW'] } } },
      },
      select: { sourceTrackId: true },
    })

    const ids = [...new Set([...items, ...unmatched].map((i) => i.sourceTrackId))]
    if (ids.length === 0) return Response.json({ ok: true, queued: 0 })

    // Skip anything already queued or in flight, so pressing twice is harmless.
    const existing = await prisma.downloadRequest.findMany({
      where: { sourceTrackId: { in: ids }, status: { in: ['QUEUED', 'RUNNING', 'SUCCEEDED'] } },
      select: { sourceTrackId: true },
    })
    const skip = new Set(existing.map((e) => e.sourceTrackId))
    const toCreate = ids.filter((id) => !skip.has(id))

    if (toCreate.length > 0) {
      await prisma.downloadRequest.createMany({
        data: toCreate.map((sourceTrackId) => ({ sourceTrackId, status: 'QUEUED' as const })),
      })
    }
    return Response.json({ ok: true, queued: toCreate.length })
  }

  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  })
  try {
    const queue = new Queue('playlist-write', { connection })
    await queue.add(
      'write-playlist',
      { sourcePlaylistId: source.id },
      { jobId: `write__${source.id}` },
    )
    await queue.close()
    return Response.json({ ok: true })
  } finally {
    await connection.quit()
  }
}
