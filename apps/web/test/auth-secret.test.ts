import { describe, expect, it } from 'vitest'
import { resolveAuthSecret } from '../src/lib/auth-secret'

describe('auth secret resolution', () => {
  it('uses the Crate runtime secret', () => {
    expect(resolveAuthSecret({ CRATE_SESSION_SECRET: 'runtime-secret' })).toBe('runtime-secret')
  })

  it('fails clearly when a production runtime secret is missing', () => {
    expect(() => resolveAuthSecret({ NODE_ENV: 'production' })).toThrow(
      'CRATE_SESSION_SECRET is required outside development',
    )
  })

  it('allows Better Auth development defaults only in development', () => {
    expect(resolveAuthSecret({ NODE_ENV: 'development' })).toBeUndefined()
  })
})
