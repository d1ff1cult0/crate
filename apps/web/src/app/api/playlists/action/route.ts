/**
 * Playlist actions: write it out, or queue downloads for its gaps.
 *
 * Both only ENQUEUE. Writing touches the filesystem and Navidrome; filling gaps starts
 * downloads that take minutes. Neither belongs in a request handler (§4).
 */

import { prisma } from '@crate/db'
import { z } from 'zod'
import { ensureDownloadJobs, enqueueJob, jobId } from '../../../../lib/queue'

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

    // Everything already satisfied or deliberately held is left alone. Everything else —
    // INCLUDING rows that already sit at QUEUED — goes through `ensureDownloadJob`.
    //
    // That last part is the bug this endpoint used to have, and it was invisible: it
    // wrote DownloadRequest rows and returned without ever adding a BullMQ job, then
    // treated "a row already exists" as "the work is already scheduled" on the next
    // press. 168 requests accumulated in the database with nothing at all in Redis, no
    // attempts, no job runs and no errors, because nothing had failed — the work had
    // simply never been asked for. Pressing this now repairs those rows rather than
    // skipping past them.
    const settled = await prisma.downloadRequest.findMany({
      where: { sourceTrackId: { in: ids }, status: { in: ['SUCCEEDED', 'MANUAL_HOLD'] } },
      select: { sourceTrackId: true },
    })
    const skip = new Set(settled.map((e) => e.sourceTrackId))
    const wanted = ids.filter((id) => !skip.has(id))

    const existingRows = await prisma.downloadRequest.findMany({
      where: { sourceTrackId: { in: wanted } },
      orderBy: { createdAt: 'desc' },
    })
    const byTrack = new Map<string, (typeof existingRows)[number]>()
    for (const row of existingRows) if (!byTrack.has(row.sourceTrackId)) byTrack.set(row.sourceTrackId, row)

    const toEnqueue: Array<{ id: string; priority: number }> = []
    let created = 0

    for (const sourceTrackId of wanted) {
      const existing = byTrack.get(sourceTrackId)
      // Abandoned means every provider was already tried; don't silently retry it here.
      if (existing?.status === 'ABANDONED') continue

      if (existing) {
        toEnqueue.push({ id: existing.id, priority: existing.priority })
        continue
      }
      const request = await prisma.downloadRequest.create({
        data: { sourceTrackId, status: 'QUEUED' },
      })
      created += 1
      toEnqueue.push({ id: request.id, priority: request.priority })
    }

    const enqueued = await ensureDownloadJobs(toEnqueue)
    return Response.json({ ok: true, queued: enqueued, created })
  }

  await enqueueJob(
    'playlist-write',
    'write-playlist',
    { sourcePlaylistId: source.id },
    { jobId: jobId('write', source.id) },
  )
  return Response.json({ ok: true })
}
