/**
 * Spotify OAuth callback (alternate mount point).
 *
 * The owner's app is registered against /callback, which is where this normally runs.
 * This path is kept so a dashboard entry pointing at /api/spotify/callback also works.
 */

import { handleSpotifyCallback } from '../../../../lib/spotify-callback'
import { isUnauthorized, requireApiSession } from '../../../../lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  return handleSpotifyCallback(request)
}
