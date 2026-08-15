import { describe, expect, it } from 'vitest'
import { isTrustedMutationOrigin, trustedOrigins } from '../src/lib/trusted-origins'

describe('trusted origin policy', () => {
  const origins = trustedOrigins({
    PUBLIC_URL: 'https://spotdl.jplessers.com',
    CRATE_TRUSTED_ORIGINS: ' https://crate.jplessers.com/some/path,not a url,https://crate.jplessers.com ',
  })

  it('includes the canonical and normalized configured exact origins once', () => {
    expect(origins).toEqual([
      'https://spotdl.jplessers.com',
      'https://crate.jplessers.com',
    ])
  })

  it('allows an alternate-host POST origin and rejects evil or missing origins', () => {
    expect(isTrustedMutationOrigin('https://crate.jplessers.com', origins)).toBe(true)
    expect(isTrustedMutationOrigin('https://evil.example', origins)).toBe(false)
    expect(isTrustedMutationOrigin(null, origins)).toBe(false)
  })

  it('does not treat configured origins as wildcard host patterns', () => {
    expect(isTrustedMutationOrigin('https://sub.crate.jplessers.com', origins)).toBe(false)
    expect(isTrustedMutationOrigin('https://crate.jplessers.com.evil.example', origins)).toBe(false)
  })
})
