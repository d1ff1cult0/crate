/**
 * Spotify OAuth callback, mounted at the path the owner's existing Spotify app is
 * registered with: https://spotdl.jplessers.com/callback
 *
 * The handler itself lives in lib/spotify-callback.ts and is shared with
 * /api/spotify/callback, so either dashboard entry works.
 */

import { handleSpotifyCallback } from '../../lib/spotify-callback'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  return handleSpotifyCallback(request)
}
