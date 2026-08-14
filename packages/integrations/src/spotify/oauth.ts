/**
 * Spotify OAuth — Authorization Code with PKCE.
 *
 * Scopes are READ-ONLY by deliberate decision (docs/DECISIONS.md D4: the owner declined
 * reverse-sync). No playlist-modify-* scopes are requested, so the consent screen asks
 * for the minimum and nothing here can write to the Spotify account.
 *
 * If reverse-sync is ever wanted, adding the write scopes requires re-consenting the
 * connection — it is not a silent change.
 */

import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** Read-only. See D4 before adding to this list. */
export const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-top-read',
  'user-read-recently-played',
  'user-follow-read',
] as const

const AUTH_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'

export const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
  })
  .passthrough()

export interface PkcePair {
  verifier: string
  challenge: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkcePair(): PkcePair {
  // 64 bytes → 86 chars, comfortably inside the 43–128 the spec allows.
  const verifier = base64url(randomBytes(64))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function createState(): string {
  return base64url(randomBytes(24))
}

export function buildAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  challenge: string
  state: string
  scopes?: readonly string[]
}): string {
  const url = new URL(AUTH_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('code_challenge', params.challenge)
  url.searchParams.set('state', params.state)
  url.searchParams.set('scope', (params.scopes ?? SPOTIFY_SCOPES).join(' '))
  return url.toString()
}

export interface TokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt: Date
  scope?: string
}

function toTokenSet(raw: z.infer<typeof TokenResponseSchema>): TokenSet {
  // Expire a minute early so a long request can't straddle the boundary.
  const ttl = (raw.expires_in ?? 3600) - 60
  return {
    accessToken: raw.access_token,
    ...(raw.refresh_token ? { refreshToken: raw.refresh_token } : {}),
    expiresAt: new Date(Date.now() + ttl * 1000),
    ...(raw.scope ? { scope: raw.scope } : {}),
  }
}

export async function exchangeCode(params: {
  clientId: string
  code: string
  redirectUri: string
  verifier: string
  fetchImpl?: typeof fetch
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.verifier,
  })

  const res = await (params.fetchImpl ?? fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Spotify token exchange failed (${res.status}): ${text.slice(0, 300)}`)
  }
  return toTokenSet(TokenResponseSchema.parse(await res.json()))
}

export async function refreshToken(params: {
  clientId: string
  refreshToken: string
  fetchImpl?: typeof fetch
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  })

  const res = await (params.fetchImpl ?? fetch)(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Spotify token refresh failed (${res.status}): ${text.slice(0, 300)}`)
  }

  const set = toTokenSet(TokenResponseSchema.parse(await res.json()))
  // Spotify does not always return a new refresh token; keep the existing one.
  if (!set.refreshToken) set.refreshToken = params.refreshToken
  return set
}
