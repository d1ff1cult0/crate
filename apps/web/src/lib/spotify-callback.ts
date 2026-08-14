/**
 * The Spotify OAuth callback handler.
 *
 * Extracted from the route file so it can be mounted at whatever path the Spotify
 * dashboard has registered. The owner's existing app uses `/callback`, so that is where
 * it is served; `/api/spotify/callback` stays mounted too, so a dashboard entry pointing
 * at either path works without a code change.
 */

import 'server-only'
import { prisma } from '@crate/db'
import { SpotifyClient, exchangeCode } from '@crate/integrations'
import { cookies } from 'next/headers'
import { encryptJson } from './crypto'
import { PKCE_COOKIE, STATE_COOKIE, settingsUrl, spotifyRedirectUri } from './oauth'

function redirectBack(params: Record<string, string>): Response {
  return Response.redirect(settingsUrl(params), 302)
}

export async function handleSpotifyCallback(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const denied = url.searchParams.get('error')

  const jar = await cookies()
  const verifier = jar.get(PKCE_COOKIE)?.value
  const expectedState = jar.get(STATE_COOKIE)?.value

  // Always clear the one-shot cookies, whatever happens next.
  jar.delete(PKCE_COOKIE)
  jar.delete(STATE_COOKIE)

  if (denied) {
    return redirectBack({
      spotify: 'error',
      reason:
        denied === 'access_denied'
          ? 'You declined the Spotify consent screen. Nothing was connected.'
          : `Spotify returned an error: ${denied}`,
    })
  }

  if (!code || !state) {
    return redirectBack({
      spotify: 'error',
      reason: 'Spotify did not return an authorization code.',
    })
  }

  // CSRF check: the state we issued must come back unchanged.
  if (!expectedState || state !== expectedState) {
    return redirectBack({
      spotify: 'error',
      reason:
        'The authorization state did not match. Start the connection again from this browser — the flow has to finish in the same session it began in.',
    })
  }

  if (!verifier) {
    return redirectBack({
      spotify: 'error',
      reason: 'The PKCE verifier expired. Connections have to be completed within ten minutes.',
    })
  }

  const row = await prisma.setting.findUnique({ where: { key: 'app' } })
  const settings = (row?.value ?? {}) as { spotifyClientId?: string; spotifyMarket?: string }
  const clientId = settings.spotifyClientId?.trim() || process.env.SPOTIFY_CLIENT_ID?.trim()

  if (!clientId) {
    return redirectBack({ spotify: 'error', reason: 'No Spotify client ID is configured.' })
  }

  try {
    const tokens = await exchangeCode({
      clientId,
      code,
      redirectUri: spotifyRedirectUri(),
      verifier,
    })

    // Identify the account straight away so the connection row is meaningful and the
    // harvest's owner comparison has something to work with.
    const client = new SpotifyClient({
      getAccessToken: async () => tokens.accessToken,
      market: settings.spotifyMarket ?? 'BE',
    })
    const me = await client.getCurrentUser()

    const secret = encryptJson({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt.toISOString(),
    })

    const fields = {
      enabled: true,
      // account_id is the stable identifier Spotify says to use for linking (May 2026);
      // `id` is kept because playlist owner.id is still an `id`.
      accountId: me.account_id ?? null,
      externalId: me.id,
      displayName: me.display_name ?? me.id,
      secretCipher: secret,
      expiresAt: tokens.expiresAt,
      lastOkAt: new Date(),
      lastError: null,
      metaJson: { scope: tokens.scope ?? '' },
    }

    await prisma.connection.upsert({
      where: { provider: 'spotify' },
      create: { provider: 'spotify', ...fields },
      update: fields,
    })

    return redirectBack({ spotify: 'connected', as: me.display_name ?? me.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.connection
      .update({ where: { provider: 'spotify' }, data: { lastError: message } })
      .catch(() => undefined)

    // The overwhelmingly common cause is a redirect URI that does not match the
    // dashboard byte for byte, and Spotify's own error text does not say so.
    const hint = /invalid_?client|redirect/i.test(message)
      ? ` Check that the redirect URI registered in the Spotify dashboard is exactly "${spotifyRedirectUri()}".`
      : ''
    return redirectBack({ spotify: 'error', reason: message + hint })
  }
}
