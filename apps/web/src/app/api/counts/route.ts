/** Live counts for the left rail (§9: "uppercase labels and live counts"). */

import { prisma } from '@crate/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [playlists, queue, review, duplicates, library] = await Promise.all([
    prisma.sourcePlaylist.count(),
    prisma.downloadRequest.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } }),
    prisma.match.count({ where: { status: 'NEEDS_REVIEW' } }),
    prisma.duplicateGroup.count({ where: { status: 'OPEN' } }),
    prisma.libraryTrack.count(),
  ])

  return Response.json({ playlists, queue, review, duplicates, library })
}
