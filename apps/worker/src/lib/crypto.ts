/**
 * Secret storage. PROMPT.md §11: "Secrets encrypted at rest, decrypted only in the
 * worker. Never send a provider credential to the client."
 *
 * AES-256-GCM with a random IV per record and the auth tag stored alongside
 * (docs/DECISIONS.md A4). The key comes from CRATE_ENCRYPTION_KEY and never touches the
 * database — losing it means re-entering every credential, which is stated in
 * .env.example and in the compose file.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96 bits, the GCM standard
const KEY_LENGTH = 32

let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey) return cachedKey

  const raw = process.env.CRATE_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'CRATE_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and put it in .env — without it no stored credential can be read.',
    )
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `CRATE_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes (got ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    )
  }

  cachedKey = key
  return key
}

/** Encrypt to a self-describing string: v1:<iv>:<tag>:<ciphertext>, all base64. */
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
    throw new Error('Stored secret is not in the expected format — it may predate the current encryption scheme.')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64!, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64!, 'base64')), decipher.final()]).toString('utf8')
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value))
}

export function decryptJson<T>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T
}

/** True when a usable key is configured — lets the UI warn before anything is saved. */
export function encryptionAvailable(): boolean {
  try {
    getKey()
    return true
  } catch {
    return false
  }
}
