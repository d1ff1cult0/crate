/**
 * Mix sampling. PROMPT.md §7.8.
 *
 * "Fill each with ~50 tracks: weighted sampling by affinity × cluster fit × a recency
 *  penalty ... max 2 tracks per artist, and a deliberate mix of deep familiarity and
 *  things I haven't played in months."
 *
 * Pure and deterministic given a seed, so a mix can be reproduced exactly when the owner
 * asks why a track appeared — and so the sampler is testable without a library.
 *
 * The one deliberate deviation from the brief, agreed as DECISIONS D7: §7.8 says
 * "nothing played in the last 14 days" as a hard exclusion. It is a **penalty weight**
 * here instead. Daily Mix is comfortable partly *because* it replays things you like; a
 * hard two-week ban on a personal library builds mixes out of the things you skipped for
 * a reason. The window and the strength are both configurable, so the hard behaviour is
 * still reachable by setting the weight to 1.
 */

export interface MixCandidate {
  trackId: string
  artist: string
  /** 0–1, from the taste model. */
  affinity: number
  /** 0–1, how central this track's artist is to the cluster. */
  clusterFit: number
  lastPlayedAt?: Date | null
  /** Feedback multiplier from §7.8's outcome loop. Defaults to 1. */
  outcomeWeight?: number
}

export interface MixSamplingOptions {
  size: number
  maxPerArtist: number
  /** Plays inside this window are penalised, not excluded (D7). */
  recencyPenaltyDays: number
  /** 0 = no penalty, 1 = effectively the hard exclusion the brief originally asked for. */
  recencyPenaltyWeight: number
  /** Fraction of the mix reserved for tracks not played in a long time. */
  deepCutRatio: number
  /** Anything unplayed for this long counts as a deep cut. */
  deepCutDays: number
  now: Date
  seed: number
  /** Track ids already used by another mix today — §7.8 forbids repeats across mixes. */
  exclude?: Set<string>
}

export const MIX_DEFAULTS: MixSamplingOptions = {
  size: 50,
  maxPerArtist: 2,
  recencyPenaltyDays: 14,
  recencyPenaltyWeight: 0.6,
  deepCutRatio: 0.3,
  deepCutDays: 120,
  now: new Date(),
  seed: 1,
}

const MS_PER_DAY = 86_400_000

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * Seeded rather than `Math.random` so a mix is reproducible: "why is this track in Mix 4"
 * is a question the owner will ask, and it needs an answer better than "chance".
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ScoredMixCandidate extends MixCandidate {
  weight: number
  /** Human-readable, so the UI can explain a pick. */
  reasons: string[]
  isDeepCut: boolean
}

/** affinity × cluster fit × recency penalty × outcome feedback. */
export function weighCandidate(
  candidate: MixCandidate,
  opts: MixSamplingOptions,
): ScoredMixCandidate {
  const reasons: string[] = []
  let weight = Math.max(0, candidate.affinity) * Math.max(0.05, candidate.clusterFit)
  reasons.push(`affinity ${candidate.affinity.toFixed(2)} × fit ${candidate.clusterFit.toFixed(2)}`)

  const daysSincePlay =
    candidate.lastPlayedAt != null
      ? (opts.now.getTime() - candidate.lastPlayedAt.getTime()) / MS_PER_DAY
      : Number.POSITIVE_INFINITY

  if (daysSincePlay < opts.recencyPenaltyDays) {
    // Linear taper: played today takes the full penalty, played thirteen days ago
    // takes almost none.
    const closeness = 1 - daysSincePlay / opts.recencyPenaltyDays
    const penalty = opts.recencyPenaltyWeight * closeness
    weight *= 1 - penalty
    reasons.push(`played ${Math.round(daysSincePlay)}d ago: -${(penalty * 100).toFixed(0)}%`)
  }

  const outcome = candidate.outcomeWeight ?? 1
  if (outcome !== 1) {
    weight *= outcome
    reasons.push(`feedback ×${outcome.toFixed(2)}`)
  }

  const isDeepCut = daysSincePlay >= opts.deepCutDays
  if (isDeepCut) reasons.push('deep cut')

  return { ...candidate, weight: Number(Math.max(0, weight).toFixed(6)), reasons, isDeepCut }
}

/** Weighted sample without replacement. Returns the index chosen, or -1. */
function pickWeighted(pool: ScoredMixCandidate[], random: () => number): number {
  const total = pool.reduce((sum, c) => sum + c.weight, 0)
  if (total <= 0) return pool.length > 0 ? Math.floor(random() * pool.length) : -1

  let threshold = random() * total
  for (let i = 0; i < pool.length; i++) {
    threshold -= pool[i]!.weight
    if (threshold <= 0) return i
  }
  return pool.length - 1
}

export interface MixResult {
  tracks: ScoredMixCandidate[]
  /** How many of the picks were deep cuts, for the "familiar vs forgotten" balance. */
  deepCuts: number
  /** Artists that hit the per-artist cap — useful when a mix comes out thin. */
  cappedArtists: string[]
}

/**
 * Sample one mix.
 *
 * Deep cuts are filled first, up to `deepCutRatio`, because sampling purely by weight
 * would fill fifty slots with the most-played tracks every night and the mix would never
 * surprise anyone. The brief asks for "a deliberate mix of deep familiarity and things I
 * haven't played in months" — deliberate is the operative word, so it is a reserved
 * quota rather than something left to chance.
 */
export function sampleMix(
  candidates: MixCandidate[],
  options: Partial<MixSamplingOptions> = {},
): MixResult {
  const opts = { ...MIX_DEFAULTS, ...options }
  const random = seededRandom(opts.seed)
  const exclude = opts.exclude ?? new Set<string>()

  const scored = candidates
    .filter((c) => !exclude.has(c.trackId))
    .map((c) => weighCandidate(c, opts))
    .filter((c) => c.weight > 0)

  const perArtist = new Map<string, number>()
  const chosen: ScoredMixCandidate[] = []
  const capped = new Set<string>()

  const take = (pool: ScoredMixCandidate[], limit: number): void => {
    const working = [...pool]
    while (chosen.length < limit && working.length > 0) {
      const index = pickWeighted(working, random)
      if (index < 0) break
      const candidate = working.splice(index, 1)[0]!

      const used = perArtist.get(candidate.artist) ?? 0
      if (used >= opts.maxPerArtist) {
        capped.add(candidate.artist)
        continue
      }
      perArtist.set(candidate.artist, used + 1)
      chosen.push(candidate)
    }
  }

  const deepCutTarget = Math.min(opts.size, Math.round(opts.size * opts.deepCutRatio))
  take(
    scored.filter((c) => c.isDeepCut),
    deepCutTarget,
  )

  const chosenIds = new Set(chosen.map((c) => c.trackId))
  take(
    scored.filter((c) => !chosenIds.has(c.trackId)),
    opts.size,
  )

  // Interleave rather than leaving every deep cut at the front, where a listener would
  // hit an unbroken run of unfamiliar material and bail in the first two minutes.
  const shuffled = interleave(chosen, random)

  return {
    tracks: shuffled,
    deepCuts: chosen.filter((c) => c.isDeepCut).length,
    cappedArtists: [...capped],
  }
}

/**
 * Fisher-Yates over the seeded PRNG, with one constraint: never two tracks by the same
 * artist back to back. Two tracks by one artist in a row reads as a mistake even when it
 * is not.
 */
export function interleave<T extends { artist: string }>(items: T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }

  for (let i = 1; i < out.length; i++) {
    if (out[i]!.artist !== out[i - 1]!.artist) continue
    // Find the nearest later track by a different artist and swap it in.
    const swap = out.findIndex(
      (item, index) =>
        index > i && item.artist !== out[i - 1]!.artist && item.artist !== out[i + 1]?.artist,
    )
    if (swap > i) [out[i], out[swap]] = [out[swap]!, out[i]!]
  }

  return out
}

export interface DiscoverySlotPlan {
  /** How many slots of the mix to reserve for artists not yet in the library. */
  count: number
  artists: string[]
}

/**
 * §7.8: "Reserve 15–25% for discovery slots filled from high-weight graph neighbours not
 * yet in the library."
 *
 * Returns the plan only. Whether those become download requests is the caller's call and
 * the owner's setting (`autoDownloadDiscovery`) — this function never acquires anything.
 */
export function planDiscoverySlots(
  mixSize: number,
  ratio: number,
  neighbours: Array<{ artist: string; weight: number }>,
): DiscoverySlotPlan {
  const count = Math.max(0, Math.round(mixSize * Math.min(0.5, Math.max(0, ratio))))
  return {
    count,
    artists: neighbours
      .slice(0, count)
      .map((n) => n.artist),
  }
}
