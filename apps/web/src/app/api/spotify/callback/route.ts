/**
 * Spotify OAuth callback.
 *
 * Exchanges the code for tokens, stores them encrypted, and records the account
 * identity. Both `account_id` (stable, what Spotify says to use for linking since
 * May 2026) and `id` (still needed, because playlist `owner.id` is an `id`) are kept —
 * see docs/spotify-api-state.md finding F.
 *
 * Failures redirect back to Settings with a readable reason rather than rendering a
 * bare JSON error: this is a browser-facing flow.
 */

import { prisma } from '@crate/db'
import { SpotifyClient, exchangeCode } from '@crate/integrations'
import { cookies } from 'next/headers'
import { encryptJson } from '../../../../lib/crypto'
import { PKCE_COOKIE, STATE_COOKIE, publicBaseUrl, spotifyRedirectUri } from '../../../../lib/oauth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function settingsRedirect(params: Record<string, string>): Response {
  const url = new URL(`${publicBaseUrl()}/settings`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return Response.redirect(url.toString(), 302)
}

export async function GET(request: Request) {
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
    return settingsRedirect({
      spotify: 'error',
      reason:
        denied === 'access_denied'
          ? 'You declined the Spotify consent screen. Nothing was connected.'
          : `Spotify returned an error: ${denied}`,
    })
  }

  if (!code || !state) {
    return settingsRedirect({ spotify: 'error', reason: 'Spotify did not return an authorization code.' })
  }

  // CSRF check: the state we issued must come back unchanged.
  if (!expectedState || state !== expectedState) {
    return settingsRedirect({
      spotify: 'error',
      reason:
        'The authorization state did not match. Start the connection again from this browser — the flow has to finish in the same session it began in.',
    })
  }

  if (!verifier) {
    return settingsRedirect({
      spotify: 'error',
      reason: 'The PKCE verifier expired. Connections have to be completed within ten minutes.',
    })
  }

  const row = await prisma.setting.findUnique({ where: { key: 'app' } })
  const settings = (row?.value ?? {}) as { spotifyClientId?: string; spotifyMarket?: string }
  const clientId = settings.spotifyClientId?.trim()
  if (!clientId) {
    return settingsRedirect({ spotify: 'error', reason: 'The Spotify client ID was removed mid-flow.' })
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

    await prisma.connection.upsert({
      where: { provider: 'spotify' },
      create: {
        provider: 'spotify',
        enabled: true,
        accountId: me.account_id ?? null,
        externalId: me.id,
        displayName: me.display_name ?? me.id,
        secretCipher: encryptJson({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt.toISOString(),
        }),
        expiresAt: tokens.expiresAt,
        lastOkAt: new Date(),
        lastError: null,
        metaJson: { scope: tokens.scope ?? '' },
      },
      update: {
        enabled: true,
        accountId: me.account_id ?? null,
        externalId: me.id,
        displayName: me.display_name ?? me.id,
        secretCipher: encryptJson({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt.toISOString(),
        }),
        expiresAt: tokens.expiresAt,
        lastOkAt: new Date(),
        lastError: null,
        metaJson: { scope: tokens.scope ?? '' },
      },
    })

    return settingsRedirect({ spotify: 'connected', as: me.display_name ?? me.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.connection
      .update({ where: { provider: 'spotify' }, data: { lastError: message } })
      .catch(() => undefined)
    return settingsRedirect({ spotify: 'error', reason: message })
  }
}
