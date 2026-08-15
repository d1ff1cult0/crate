import { describe, expect, it } from 'vitest'
import { youtubeImportRateLimitKey, validateMutationOrigin } from '../src/lib/youtube-import-security'

describe('YouTube import route security', () => {
  it('requires mutation Origin to match an exact trusted origin', () => {
    const allowed = ['https://crate.example']
    expect(validateMutationOrigin('https://crate.example', allowed)).toBe(true)
    expect(validateMutationOrigin('https://evil.example', allowed)).toBe(false)
    expect(validateMutationOrigin(null, allowed)).toBe(false)
  })

  it('uses separate stable rate-limit buckets for GET and POST clients', () => {
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).toMatch(/^crate:youtube-import:get:[a-f0-9]{24}$/)
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).toBe(youtubeImportRateLimitKey('GET', '203.0.113.7'))
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).not.toBe(youtubeImportRateLimitKey('POST', '203.0.113.7'))
    expect(youtubeImportRateLimitKey('GET', '203.0.113.7')).not.toBe(youtubeImportRateLimitKey('GET', '203.0.113.8'))
  })
})
