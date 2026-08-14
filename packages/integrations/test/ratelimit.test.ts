import { describe, expect, it } from 'vitest'
import {
  AdaptiveRateLimiter,
  QuotaExceededError,
  isQuotaExceeded,
  parseRetryAfter,
} from '../src/spotify/ratelimit.js'

/** Virtual clock so the tests don't actually sleep. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('isQuotaExceeded', () => {
  it('detects the July 2026 quota marker at the top level', () => {
    expect(isQuotaExceeded({ reason: 'QUOTA_EXCEEDED' })).toBe(true)
  })

  it('detects it nested under error', () => {
    expect(isQuotaExceeded({ error: { status: 429, reason: 'QUOTA_EXCEEDED' } })).toBe(true)
  })

  it('does not fire on an ordinary rate-limit body', () => {
    expect(isQuotaExceeded({ error: { status: 429, message: 'API rate limit exceeded' } })).toBe(false)
    expect(isQuotaExceeded(null)).toBe(false)
    expect(isQuotaExceeded('QUOTA_EXCEEDED')).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  it('parses a seconds value', () => {
    expect(parseRetryAfter('30')).toBe(30)
  })

  it('parses an HTTP date', () => {
    const now = Date.parse('2026-08-14T00:00:00Z')
    expect(parseRetryAfter('Fri, 14 Aug 2026 00:00:30 GMT', now)).toBe(30)
  })

  it('returns undefined when absent or unparseable', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })

  it('never returns a negative wait', () => {
    const now = Date.parse('2026-08-14T00:01:00Z')
    expect(parseRetryAfter('Fri, 14 Aug 2026 00:00:00 GMT', now)).toBe(0)
  })
})

describe('AdaptiveRateLimiter', () => {
  it('lets the initial burst through without waiting', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 5, sleep: clock.sleep, now: clock.now })
    for (let i = 0; i < 5; i++) await l.acquire()
    expect(l.getStats().totalWaitMs).toBe(0)
  })

  it('waits once the bucket is drained', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 2, sleep: clock.sleep, now: clock.now })
    await l.acquire()
    await l.acquire()
    await l.acquire()
    expect(l.getStats().totalWaitMs).toBeGreaterThan(0)
  })

  it('halves the rate on a rate-limit 429', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 8, sleep: clock.sleep, now: clock.now })
    await l.onRateLimited(1, { error: { message: 'rate limited' } })
    expect(l.getStats().ratePerSecond).toBe(4)
    await l.onRateLimited(1, undefined)
    expect(l.getStats().ratePerSecond).toBe(2)
  })

  it('honours Retry-After exactly', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 8, sleep: clock.sleep, now: clock.now })
    const waited = await l.onRateLimited(30, undefined)
    expect(waited).toBe(30_000)
  })

  it('never drops below the floor', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({
      initialRatePerSecond: 4, minRatePerSecond: 1, sleep: clock.sleep, now: clock.now,
    })
    for (let i = 0; i < 10; i++) await l.onRateLimited(0, undefined)
    expect(l.getStats().ratePerSecond).toBe(1)
  })

  it('recovers gradually on success but never exceeds the ceiling', () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({
      initialRatePerSecond: 1, maxRatePerSecond: 10, recoveryStep: 0.1,
      sleep: clock.sleep, now: clock.now,
    })
    for (let i = 0; i < 500; i++) l.onSuccess()
    expect(l.getStats().ratePerSecond).toBe(10)
  })

  // ── The distinction that matters most ──────────────────────
  it('throws QuotaExceededError instead of backing off when the quota is spent', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 8, sleep: clock.sleep, now: clock.now })
    await expect(l.onRateLimited(60, { reason: 'QUOTA_EXCEEDED' })).rejects.toBeInstanceOf(
      QuotaExceededError,
    )
    // The rate must be untouched — slowing down does not restore a spent quota.
    expect(l.getStats().ratePerSecond).toBe(8)
    expect(l.getStats().quotaHits).toBe(1)
    expect(l.getStats().rateLimitHits).toBe(0)
  })

  it('carries Retry-After through on the quota error', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ sleep: clock.sleep, now: clock.now })
    await l.onRateLimited(3600, { reason: 'QUOTA_EXCEEDED' }).catch((e: QuotaExceededError) => {
      expect(e.retryAfterSeconds).toBe(3600)
    })
  })

  it('refills over time', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 2, sleep: clock.sleep, now: clock.now })
    await l.acquire()
    await l.acquire()
    clock.advance(1000) // a second passes → 2 more tokens
    await l.acquire()
    await l.acquire()
    expect(l.getStats().totalWaitMs).toBe(0)
  })

  it('serializes concurrent acquisitions so the bucket cannot go negative', async () => {
    const clock = fakeClock()
    const l = new AdaptiveRateLimiter({ initialRatePerSecond: 3, sleep: clock.sleep, now: clock.now })
    await Promise.all([l.acquire(), l.acquire(), l.acquire(), l.acquire(), l.acquire()])
    expect(l.getStats().requests).toBe(5)
    expect(l.getStats().totalWaitMs).toBeGreaterThan(0)
  })
})
