/**
 * Taste model. PROMPT.md §7.8.
 *
 * "Compute per-artist and per-track affinity: play count weighted by an exponential
 *  recency decay (half-life ~90 days, configurable), boosted by stars, penalized by
 *  skip rate."
 *
 * Pure functions over plain events, so the whole taste model can be exercised against
 * fixtures without a database and without waiting weeks for a GDPR export to arrive.
 *
 * The design choice worth stating: affinity is a **weighted play count**, not a rating.
 * A track played forty times two years ago and a track played four times last week can
 * land in the same place, which is correct — both are things this listener returns to.
 * What it must never do is let a huge historical count drown out everything recent, and
 * the exponential decay is what prevents that.
 */

export interface PlayEvent {
  playedAt: Date
  /** Milliseconds actually played. GDPR export gives this; Navidrome does not. */
  msPlayed?: number | null
  /** Explicit skip flag, when the source knows better than the duration heuristic. */
  skipped?: boolean | null
}

export interface AffinityOptions {
  /** Half-life of the recency decay, in days. §7.8 suggests ~90. */
  halfLifeDays: number
  /** Reference point; injected rather than read from the clock so tests are stable. */
  now: Date
  /** Multiplier applied when the track is starred in Navidrome. */
  starBoost: number
  /** How much a high skip rate costs, at most. 1 = a fully-skipped track scores 0. */
  skipPenaltyWeight: number
}

export const AFFINITY_DEFAULTS: AffinityOptions = {
  halfLifeDays: 90,
  now: new Date(),
  starBoost: 1.5,
  skipPenaltyWeight: 0.8,
}

/** §7.8: "Treat `ms_played < 30000` as a skip." */
export const SKIP_MS_THRESHOLD = 30_000

export function isSkip(event: PlayEvent): boolean {
  if (event.skipped === true) return true
  if (event.msPlayed == null) return false
  return event.msPlayed < SKIP_MS_THRESHOLD
}

const MS_PER_DAY = 86_400_000

/**
 * Exponential decay: 1.0 today, 0.5 one half-life ago, 0.25 two half-lives ago.
 *
 * Future timestamps clamp to 1 rather than exceeding it — clock skew between the export,
 * Navidrome and this box is real, and a play "tomorrow" should not outweigh one today.
 */
export function recencyWeight(playedAt: Date, now: Date, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1
  const ageDays = (now.getTime() - playedAt.getTime()) / MS_PER_DAY
  if (ageDays <= 0) return 1
  return Math.pow(0.5, ageDays / halfLifeDays)
}

export interface AffinityResult {
  /** The headline number. Unbounded above; comparable within one computation run. */
  score: number
  plays: number
  skips: number
  skipRate: number
  lastPlayedAt: Date | null
  /** Sum of recency weights before penalties — useful for explaining a score. */
  weightedPlays: number
}

/**
 * Affinity for one track or artist from its play history.
 *
 * Skips count toward the skip rate but contribute nothing positive: a track started and
 * abandoned forty times is evidence against, not for, however often it appears.
 */
export function computeAffinity(
  events: PlayEvent[],
  opts: Partial<AffinityOptions> & { starred?: boolean } = {},
): AffinityResult {
  const cfg = { ...AFFINITY_DEFAULTS, ...opts }

  let weightedPlays = 0
  let plays = 0
  let skips = 0
  let lastPlayedAt: Date | null = null

  for (const event of events) {
    if (!lastPlayedAt || event.playedAt > lastPlayedAt) lastPlayedAt = event.playedAt
    if (isSkip(event)) {
      skips += 1
      continue
    }
    plays += 1
    weightedPlays += recencyWeight(event.playedAt, cfg.now, cfg.halfLifeDays)
  }

  const total = plays + skips
  const skipRate = total === 0 ? 0 : skips / total

  let score = weightedPlays
  score *= 1 - cfg.skipPenaltyWeight * skipRate
  if (opts.starred) score *= cfg.starBoost

  return {
    score: Number(Math.max(0, score).toFixed(6)),
    plays,
    skips,
    skipRate: Number(skipRate.toFixed(4)),
    lastPlayedAt,
    weightedPlays: Number(weightedPlays.toFixed(6)),
  }
}

/**
 * Roll per-track affinity up to artists.
 *
 * Sum rather than mean, deliberately. An artist with fifteen tracks in rotation is a
 * bigger part of this listener's taste than one with a single track played twice as
 * often, and averaging would erase exactly that difference — which is the difference the
 * mix clusters are built on.
 */
export function aggregateByArtist(
  tracks: Array<{ artist: string; affinity: number }>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const track of tracks) {
    out.set(track.artist, (out.get(track.artist) ?? 0) + track.affinity)
  }
  return out
}

/**
 * Rescale scores to 0–1 so terms from different sources can be blended.
 *
 * Uses the 95th percentile rather than the maximum as the ceiling: one pathological
 * outlier — a track left on repeat overnight, which every real listening history has —
 * would otherwise compress everything else into the bottom of the range.
 */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  const values = [...scores.values()].filter((v) => v > 0).sort((a, b) => a - b)
  if (values.length === 0) return new Map(scores)

  const ceiling = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!
  if (ceiling <= 0) return new Map(scores)

  const out = new Map<string, number>()
  for (const [key, value] of scores) {
    out.set(key, Math.min(1, Number((value / ceiling).toFixed(6))))
  }
  return out
}

export interface OutcomeEvent {
  trackId: string
  /** Did the recommendation actually get played, or skipped past? */
  played: boolean
}

/**
 * §7.8's feedback loop: "log which recommended tracks got played versus skipped, feed
 * that back as negative weight."
 *
 * Returns a multiplier per track. A track recommended and ignored repeatedly drops out;
 * one that gets played climbs. Bounded on both sides so a single bad day cannot bury a
 * track permanently, which matters because the engine only improves if it keeps offering
 * things occasionally.
 */
export function outcomeWeights(
  outcomes: OutcomeEvent[],
  opts: { floor?: number; ceiling?: number } = {},
): Map<string, number> {
  const floor = opts.floor ?? 0.35
  const ceiling = opts.ceiling ?? 1.4

  const tally = new Map<string, { played: number; ignored: number }>()
  for (const outcome of outcomes) {
    const entry = tally.get(outcome.trackId) ?? { played: 0, ignored: 0 }
    if (outcome.played) entry.played += 1
    else entry.ignored += 1
    tally.set(outcome.trackId, entry)
  }

  const out = new Map<string, number>()
  for (const [trackId, { played, ignored }] of tally) {
    const total = played + ignored
    if (total === 0) continue
    const rate = played / total
    // 0.5 (half played) is neutral; the range is clamped so nothing is exiled.
    const weight = 1 + (rate - 0.5) * 0.8
    out.set(trackId, Number(Math.min(ceiling, Math.max(floor, weight)).toFixed(4)))
  }
  return out
}
