import { createHash, timingSafeEqual } from 'node:crypto'

export type ImportAuthorization = 'disabled' | 'unauthorized' | 'authorized'

export function authorizeYouTubeImport(configured: string | undefined, presented: string | undefined): ImportAuthorization {
  if (!configured) return 'disabled'
  if (!presented) return 'unauthorized'
  const expected = Buffer.from(configured)
  const actual = Buffer.from(presented)
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? 'authorized' : 'unauthorized'
}

export function validateMutationOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  try { return new URL(origin).origin === new URL(requestUrl).origin } catch { return false }
}

export function youtubeImportRateLimitKey(method: 'GET' | 'POST', identity: string): string {
  const client = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return `crate:youtube-import:${method.toLowerCase()}:${client}`
}
