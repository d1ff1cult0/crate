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

/** Must match the redirect URI registered on the Spotify app exactly. */
export function spotifyRedirectUri(): string {
  return `${publicBaseUrl()}/api/spotify/callback`
}

export function oauthCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: publicBaseUrl().startsWith('https://'),
    path: '/',
    maxAge: 600, // ten minutes is plenty to complete a consent screen
  }
}
