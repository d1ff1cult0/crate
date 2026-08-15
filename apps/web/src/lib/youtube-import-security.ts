import { createHash } from 'node:crypto'
import { isTrustedMutationOrigin } from './trusted-origins'

export function validateMutationOrigin(origin: string | null, allowedOrigins: string[]): boolean {
  return isTrustedMutationOrigin(origin, allowedOrigins)
}

export function youtubeImportRateLimitKey(method: 'GET' | 'POST', identity: string): string {
  const client = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return `crate:youtube-import:${method.toLowerCase()}:${client}`
}
