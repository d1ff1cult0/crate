/**
 * Server-only secret decryption for the web process.
 *
 * §11: "Secrets encrypted at rest, decrypted only in the worker. Never send a provider
 * credential to the client." The web process needs to READ a credential in exactly one
 * place — the path-verification diagnostic, which calls Navidrome directly — so this is
 * the same scheme as the worker's, and the `server-only` import guarantees it can never
 * be pulled into a client bundle.
 */

import 'server-only'
import { createDecipheriv } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32

function getKey(): Buffer {
  const raw = process.env.CRATE_ENCRYPTION_KEY
  if (!raw) throw new Error('CRATE_ENCRYPTION_KEY is not set.')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error(`CRATE_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes.`)
  }
  return key
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored secret is not in the expected format.')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64!, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64!, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
