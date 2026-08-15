/**
 * Spotify OAuth callback, mounted at the path the owner's existing Spotify app is
 * registered with: https://spotdl.jplessers.com/callback
 *
 * The handler itself lives in lib/spotify-callback.ts and is shared with
 * /api/spotify/callback, so either dashboard entry works.
 */

import { handleSpotifyCallback } from '../../lib/spotify-callback'
import { isUnauthorized, requireApiSession } from '../../lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  return handleSpotifyCallback(request)
}
