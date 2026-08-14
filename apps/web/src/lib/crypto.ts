/**
 * Server-only secret encryption for the web process.
 *
 * §11: "Secrets encrypted at rest, decrypted only in the worker. Never send a provider
 * credential to the client."
 *
 * The web process WRITES credentials (the connections editor and the OAuth callback)
 * and reads exactly one (the path-verification diagnostic, which calls Navidrome
 * directly). Same AES-256-GCM scheme as the worker's, and the `server-only` import
 * guarantees none of this can be pulled into a client bundle.
 */

import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32

function getKey(): Buffer {
  const raw = process.env.CRATE_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'CRATE_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and put it in .env — without it no credential can be stored or read.',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error(`CRATE_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length}).`)
  }
  return key
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
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

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value))
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T
}

export function encryptionAvailable(): boolean {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}
