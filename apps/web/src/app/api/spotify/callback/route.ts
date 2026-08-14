/**
 * Spotify OAuth callback (alternate mount point).
 *
 * The owner's app is registered against /callback, which is where this normally runs.
 * This path is kept so a dashboard entry pointing at /api/spotify/callback also works.
 */

import { handleSpotifyCallback } from '../../../../lib/spotify-callback'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  return handleSpotifyCallback(request)
}
