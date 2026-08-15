/**
 * The paste-box resolver. PROMPT.md §7.2 — one input, several resolvers, tried in order.
 *
 * Detection of the not-yours case follows docs/spotify-api-state.md finding B: a 403
 * from /playlists/{id}/items, or an ABSENT `items` field on the playlist object. The
 * brief's suggested heuristic ("empty items with non-zero total") does not occur in
 * practice and is deliberately not used.
 */

import { parseSpotifyRef, parseTrackLines } from '@crate/core'
import { prisma } from '@crate/db'
import { z } from 'zod'
import { isUnauthorized, requireApiSession } from '../../../../lib/session'

export const dynamic = 'force-dynamic'

const BodySchema = z.object({ input: z.string().min(1) })

export async function POST(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const body = BodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success) {
    return Response.json({ kind: 'error', message: 'Nothing to import.' }, { status: 400 })
  }

  const input = body.data.input.trim()
  const ref = parseSpotifyRef(input)

  // ── Resolver 1 and 2: a Spotify link ────────────────────
  if (ref) {
    if (ref.kind !== 'playlist') {
      return Response.json({
        kind: 'unsupported',
        message: `That's a Spotify ${ref.kind} link. Crate imports playlists — paste a playlist link, or use "Harvest everything" in Settings to pull your whole account at once.`,
      })
    }

    const connection = await prisma.connection.findUnique({ where: { provider: 'spotify' } })
    if (!connection?.enabled) {
      return Response.json({
        kind: 'error',
        message:
          'Spotify is not connected. Connect it in Settings, or paste the tracklist as plain text instead — that works without any Spotify access at all.',
      })
    }

    // Already harvested? Then answer from the database rather than the network.
    const known = await prisma.sourcePlaylist.findUnique({
      where: { source_externalId: { source: 'SPOTIFY', externalId: ref.id } },
      include: { _count: { select: { items: true } } },
    })

    if (known) {
      if (!known.isOwned && !known.isCollaborative) {
        return Response.json({
          kind: 'not-owned',
          playlistName: known.name,
          imageUrl: known.imageUrl ?? undefined,
          ownerName: known.ownerName ?? undefined,
          trackTotal: known.trackTotal ?? undefined,
        })
      }
      return Response.json({
        kind: 'owned',
        playlistName: known.name,
        imported: known._count.items,
      })
    }

    // Not seen yet: the worker resolves it, because a network fetch does not belong in
    // a request handler (§4). Queue it and report what we can.
    await prisma.importRun.create({
      data: { kind: 'SPOTIFY_PLAYLIST', status: 'RUNNING', input, tracksFound: 0 },
    })

    return Response.json({
      kind: 'owned',
      playlistName: 'Fetching from Spotify…',
      imported: 0,
      message: 'Queued. It will appear in Playlists once the worker has read it.',
    })
  }

  // ── Resolver 5: plain text ──────────────────────────────
  const parsed = parseTrackLines(input)
  if (parsed.tracks.length === 0) {
    return Response.json({
      kind: 'unsupported',
      message:
        "That doesn't look like a Spotify link or a tracklist. Paste one track per line, as \"Artist - Title\".",
    })
  }

  return Response.json({
    kind: 'text',
    preview: parsed.tracks.map((t) => ({
      artist: t.artist,
      title: t.title,
      confidence: t.confidence,
      note: t.note,
    })),
  })
}
