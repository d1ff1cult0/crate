/**
 * Shared OAuth constants and helpers.
 *
 * These live here rather than in the route files because Next.js route modules may only
 * export request handlers and route config — any other export is a build error.
 */

export const PKCE_COOKIE = 'crate_pkce'
export const STATE_COOKIE = 'crate_oauth_state'

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
}

/**
 * The OAuth redirect URI.
 *
 * This must match what is registered in the Spotify dashboard EXACTLY — Spotify
 * compares the full string, and a mismatch fails the token exchange with an opaque
 * INVALID_CLIENT error rather than anything useful.
 *
 * The owner's existing app is registered with `https://spotdl.jplessers.com/callback`,
 * so that is the default and the app serves a route at `/callback` to match. Override
 * with SPOTIFY_REDIRECT_URI if the dashboard entry ever changes.
 */
export function spotifyRedirectUri(): string {
  return (
    process.env.SPOTIFY_REDIRECT_URI?.trim() || 'https://spotdl.jplessers.com/callback'
  )
}

export function oauthCookieOptions() {
  const redirect = spotifyRedirectUri()
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    // Secure when the flow actually runs over HTTPS. Keyed off the redirect URI rather
    // than PUBLIC_URL, because that is the origin the browser returns to.
    secure: redirect.startsWith('https://'),
    path: '/',
    maxAge: 600, // ten minutes is plenty to complete a consent screen
  }
}

/** Where to send the browser after the callback resolves. */
export function settingsUrl(params: Record<string, string>): string {
  // Prefer the redirect URI's own origin: after the round trip the browser is on
  // whatever host Spotify sent it back to, and bouncing it to a different origin would
  // drop the session cookie.
  let origin: string
  try {
    origin = new URL(spotifyRedirectUri()).origin
  } catch {
    origin = publicBaseUrl()
  }
  const url = new URL(`${origin}/settings`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}
