/**
 * AcoustID — fingerprint lookup that returns MusicBrainz recording IDs and, through
 * them, ISRCs.
 *
 * Promoted to a phase 2 deliverable (docs/DECISIONS.md D3 / plan.md §1.3): the owner's
 * existing library is mostly untagged with ISRC, so without this the matching cascade's
 * tier 1 misses on music they already own and the coverage report lies. This is the
 * path that recovers those keys WITHOUT spending Spotify quota.
 *
 * Rate limited to 3 req/s per AcoustID's terms. The key is optional — without it, every
 * method here returns empty and logs once, rather than throwing (D3: "skips cleanly").
 */

import { z } from 'zod'

const API = 'https://api.acoustid.org/v2/lookup'

const LookupSchema = z
  .object({
    status: z.string().optional(),
    error: z.object({ message: z.string().optional() }).passthrough().optional(),
    results: z
      .array(
        z
          .object({
            id: z.string().optional(),
            score: z.number().optional(),
            recordings: z
              .array(
                z
                  .object({
                    id: z.string().optional(),
                    title: z.string().optional(),
                    duration: z.number().optional(),
                    artists: z.array(z.object({ name: z.string().optional() }).passthrough()).optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

export interface AcoustidConfig {
  /** Optional by design — absence disables the integration cleanly. */
  apiKey?: string | undefined
  fetchImpl?: typeof fetch
  /** Injected limiter; AcoustID's terms ask for no more than 3 requests per second. */
  beforeRequest?: () => Promise<void>
  log?: (level: 'info' | 'warn', msg: string) => void
}

export interface AcoustidMatch {
  acoustId: string
  score: number
  recordings: Array<{ mbid: string; title?: string; artist?: string; durationSec?: number }>
}

export class AcoustidClient {
  private readonly cfg: AcoustidConfig
  private readonly fetchImpl: typeof fetch
  private warned = false

  constructor(cfg: AcoustidConfig = {}) {
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  get enabled(): boolean {
    return Boolean(this.cfg.apiKey)
  }

  private skip(): void {
    if (!this.warned) {
      this.warned = true
      this.cfg.log?.(
        'info',
        'AcoustID has no API key configured — fingerprint lookups are being skipped. Add one in Settings to backfill ISRCs and MusicBrainz IDs onto existing files.',
      )
    }
  }

  /**
   * Look up a chromaprint fingerprint. `duration` is in whole seconds and is required
   * by the API — AcoustID matches on fingerprint AND duration together.
   */
  async lookup(fingerprint: string, durationSec: number): Promise<AcoustidMatch[]> {
    if (!this.cfg.apiKey) {
      this.skip()
      return []
    }

    await this.cfg.beforeRequest?.()

    const body = new URLSearchParams({
      client: this.cfg.apiKey,
      fingerprint,
      duration: String(Math.round(durationSec)),
      meta: 'recordings',
    })

    const res = await this.fetchImpl(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) {
      this.cfg.log?.('warn', `AcoustID lookup returned HTTP ${res.status}`)
      return []
    }

    const parsed = LookupSchema.safeParse(await res.json())
    if (!parsed.success) return []
    if (parsed.data.status !== 'ok') {
      this.cfg.log?.('warn', `AcoustID error: ${parsed.data.error?.message ?? 'unknown'}`)
      return []
    }

    return (parsed.data.results ?? [])
      .filter((r) => r.id)
      .map((r) => ({
        acoustId: r.id!,
        score: r.score ?? 0,
        recordings: (r.recordings ?? [])
          .filter((rec) => rec.id)
          .map((rec) => ({
            mbid: rec.id!,
            ...(rec.title ? { title: rec.title } : {}),
            ...(rec.artists?.[0]?.name ? { artist: rec.artists[0].name } : {}),
            ...(rec.duration !== undefined ? { durationSec: rec.duration } : {}),
          })),
      }))
      .sort((a, b) => b.score - a.score)
  }

  /** Best single recording match above a confidence floor. */
  async bestRecording(
    fingerprint: string,
    durationSec: number,
    minScore = 0.7,
  ): Promise<{ acoustId: string; mbid: string } | null> {
    const results = await this.lookup(fingerprint, durationSec)
    for (const r of results) {
      if (r.score < minScore) continue
      const rec = r.recordings[0]
      if (rec) return { acoustId: r.acoustId, mbid: rec.mbid }
    }
    return null
  }
}
