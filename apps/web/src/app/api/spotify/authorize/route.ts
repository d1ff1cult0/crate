/**
 * Start the Spotify OAuth flow (Authorization Code + PKCE).
 *
 * A route handler rather than a Server Action because it ends in a redirect to Spotify
 * and must set cookies on the way out — §11 allows route handlers for exactly this.
 *
 * Scopes are READ-ONLY (docs/DECISIONS.md D4: the owner declined reverse-sync), so the
 * consent screen asks for the minimum and nothing in this app can write to the Spotify
 * account.
 */

import { prisma } from '@crate/db'
import { buildAuthorizeUrl, createPkcePair, createState } from '@crate/integrations'
import { cookies } from 'next/headers'
import {
  PKCE_COOKIE,
  STATE_COOKIE,
  oauthCookieOptions,
  spotifyRedirectUri,
} from '../../../../lib/oauth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const row = await prisma.setting.findUnique({ where: { key: 'app' } })
  const settings = (row?.value ?? {}) as { spotifyClientId?: string }
  const clientId = settings.spotifyClientId?.trim()

  if (!clientId) {
    return Response.json(
      {
        error:
          'No Spotify client ID configured. Create an app at developer.spotify.com, then paste its client ID into Settings → Connections.',
      },
      { status: 400 },
    )
  }

  const { verifier, challenge } = createPkcePair()
  const state = createState()

  // The verifier must survive the round trip to Spotify but never reach client JS.
  const jar = await cookies()
  const options = oauthCookieOptions()
  jar.set(PKCE_COOKIE, verifier, options)
  jar.set(STATE_COOKIE, state, options)

  return Response.redirect(
    buildAuthorizeUrl({ clientId, redirectUri: spotifyRedirectUri(), challenge, state }),
    302,
  )
}
