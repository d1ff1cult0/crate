import { describe, expect, it } from 'vitest'
import { authorizeYouTubeImport, youtubeImportRateLimitKey, validateMutationOrigin } from '../src/lib/youtube-import-security'

describe('YouTube import route security', () => {
  it('is disabled without a configured server token', () => {
    expect(authorizeYouTubeImport(undefined, 'anything')).toBe('disabled')
  })

  it('requires the exact token without leaking comparison detail', () => {
    expect(authorizeYouTubeImport('secret', undefined)).toBe('unauthorized')
    expect(authorizeYouTubeImport('secret', 'wrong')).toBe('unauthorized')
    expect(authorizeYouTubeImport('secret', 'secret')).toBe('authorized')
  })

  it('requires mutation Origin to match the request origin', () => {
    expect(validateMutationOrigin('https://crate.example', 'https://crate.example/api/import/youtube')).toBe(true)
    expect(validateMutationOrigin('https://evil.example', 'https://crate.example/api/import/youtube')).toBe(false)
    expect(validateMutationOrigin(null, 'https://crate.example/api/import/youtube')).toBe(false)
  })

  it('uses separate stable rate-limit buckets for GET and POST clients', () => {
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).toMatch(/^crate:youtube-import:get:[a-f0-9]{24}$/)
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).toBe(youtubeImportRateLimitKey('GET', '203.0.113.7'))
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).not.toBe(youtubeImportRateLimitKey('POST', '203.0.113.7'))
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).not.toBe(youtubeImportRateLimitKey('GET', '203.0.113.8'))
  })
})
