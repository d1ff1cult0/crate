import { createHash } from 'node:crypto'

export function validateMutationOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return false
  try { return new URL(origin).origin === new URL(requestUrl).origin } catch { return false }
}

export function youtubeImportRateLimitKey(method: 'GET' | 'POST', identity: string): string {
  const client = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return `crate:youtube-import:${method.toLowerCase()}:${client}`
}
