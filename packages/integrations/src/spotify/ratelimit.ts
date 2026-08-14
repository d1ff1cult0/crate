/**
 * Adaptive rate limiting for the Spotify Web API.
 *
 * Spotify's limit is undocumented and computed over a ROLLING ~30 SECOND WINDOW
 * (docs/spotify-api-state.md), so a fixed sleep is always either too slow or too fast.
 * This is a token bucket that halves its rate on a rate-limit 429 and recovers slowly.
 *
 * The critical distinction, new in the July 2026 changelog:
 *
 *   429 + body {"reason":"QUOTA_EXCEEDED"}  → the developer-account quota is spent.
 *                                             Slowing down does NOT help. Stop, check-
 *                                             point, and let the job resume later.
 *   429 without that reason                 → rolling-window rate limit. Honour
 *                                             Retry-After, halve the rate, recover.
 *
 * Treating the first as the second makes a harvest crawl for hours and then fail
 * anyway, which is exactly the wrong behaviour with a subscription about to lapse.
 */

export class QuotaExceededError extends Error {
  readonly retryAfterSeconds: number | undefined
  constructor(message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'QuotaExceededError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface RateLimiterOptions {
  /** Starting requests per second. Conservative by default — it adapts upward. */
  initialRatePerSecond?: number
  /** Never go below this, or a harvest never finishes. */
  minRatePerSecond?: number
  /** Never exceed this even after a long clean run. */
  maxRatePerSecond?: number
  /** Multiplier applied on a rate-limit 429. */
  backoffFactor?: number
  /** Additive recovery per successful request, as a fraction of the max. */
  recoveryStep?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface RateLimiterStats {
  ratePerSecond: number
  requests: number
  rateLimitHits: number
  quotaHits: number
  totalWaitMs: number
}

export class AdaptiveRateLimiter {
  private rate: number
  private readonly minRate: number
  private readonly maxRate: number
  private readonly backoffFactor: number
  private readonly recoveryStep: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  private tokens: number
  private lastRefill: number
  /** Serializes acquisition so concurrent callers cannot both drain the last token. */
  private chain: Promise<void> = Promise.resolve()

  private stats: RateLimiterStats

  constructor(opts: RateLimiterOptions = {}) {
    this.rate = opts.initialRatePerSecond ?? 5
    this.minRate = opts.minRatePerSecond ?? 0.5
    this.maxRate = opts.maxRatePerSecond ?? 10
    this.backoffFactor = opts.backoffFactor ?? 0.5
    this.recoveryStep = opts.recoveryStep ?? 0.02
    this.sleep = opts.sleep ?? defaultSleep
    this.now = opts.now ?? Date.now

    this.tokens = this.rate
    this.lastRefill = this.now()
    this.stats = {
      ratePerSecond: this.rate,
      requests: 0,
      rateLimitHits: 0,
      quotaHits: 0,
      totalWaitMs: 0,
    }
  }

  getStats(): RateLimiterStats {
    return { ...this.stats, ratePerSecond: this.rate }
  }

  private refill(): void {
    const t = this.now()
    const elapsedSec = (t - this.lastRefill) / 1000
    if (elapsedSec <= 0) return
    this.tokens = Math.min(this.rate, this.tokens + elapsedSec * this.rate)
    this.lastRefill = t
  }

  /** Wait until a token is available. Serialized so concurrency is respected. */
  async acquire(): Promise<void> {
    const run = this.chain.then(async () => {
      this.refill()
      while (this.tokens < 1) {
        const deficit = 1 - this.tokens
        const waitMs = Math.max(10, Math.ceil((deficit / this.rate) * 1000))
        this.stats.totalWaitMs += waitMs
        await this.sleep(waitMs)
        this.refill()
      }
      this.tokens -= 1
      this.stats.requests += 1
    })
    // Keep the chain alive even if a caller rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Called after a successful response — recovers the rate gradually. */
  onSuccess(): void {
    if (this.rate < this.maxRate) {
      this.rate = Math.min(this.maxRate, this.rate + this.maxRate * this.recoveryStep)
    }
  }

  /**
   * Called on a 429. Returns how long to wait before retrying.
   * Throws QuotaExceededError when the body says the quota is spent — the caller must
   * checkpoint and stop rather than retry.
   */
  async onRateLimited(retryAfterSeconds: number | undefined, body?: unknown): Promise<number> {
    if (isQuotaExceeded(body)) {
      this.stats.quotaHits += 1
      throw new QuotaExceededError(
        'Spotify returned QUOTA_EXCEEDED. The developer-account quota is spent; slowing down will not help. The harvest has been checkpointed and will resume automatically.',
        retryAfterSeconds,
      )
    }

    this.stats.rateLimitHits += 1
    this.rate = Math.max(this.minRate, this.rate * this.backoffFactor)
    // Refill from the new, lower rate rather than carrying stale tokens over.
    this.tokens = 0
    this.lastRefill = this.now()

    // Honour Retry-After when present; otherwise back off proportionally to the
    // new rate. Never a fixed sleep (§7.1).
    const waitMs =
      retryAfterSeconds !== undefined
        ? retryAfterSeconds * 1000
        : Math.ceil((1 / this.rate) * 1000)
    this.stats.totalWaitMs += waitMs
    await this.sleep(waitMs)
    return waitMs
  }
}

/** Spotify's quota-exceeded marker, per the July 2026 changelog. */
export function isQuotaExceeded(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (typeof b.reason === 'string' && b.reason === 'QUOTA_EXCEEDED') return true
  const err = b.error
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (typeof e.reason === 'string' && e.reason === 'QUOTA_EXCEEDED') return true
  }
  return false
}

/** Parse Retry-After, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const asNumber = Number(value)
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber)
  const asDate = Date.parse(value)
  if (Number.isFinite(asDate)) return Math.max(0, Math.ceil((asDate - now) / 1000))
  return undefined
}
