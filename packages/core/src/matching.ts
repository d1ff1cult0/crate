/**
 * The matching cascade. PROMPT.md §7.3.
 *
 * Pure functions over plain data — no DB, no network. The caller supplies a candidate
 * set (normally narrowed by an index lookup on isrc / mbid / normArtist+normTitle) and
 * gets back a decision with its reasoning attached, which is persisted to
 * Match.detailJson so a wrong match can be explained three days later.
 *
 * Tiers, first hit wins:
 *   1. ISRC exact                                      1.00
 *   2. MusicBrainz recording ID                        0.98
 *   3. Chromaprint/AcoustID fingerprint                0.95
 *   4. norm artist + title + duration ±3s              0.90
 *   5. norm title + duration ±3s + artist tokens ≥0.85 0.75
 *   6. anything below                                  <0.75 → NEEDS_REVIEW
 *
 * Guard rails, applied after tier selection:
 *   - duration off by more than ±10s VETOES any non-ISRC match
 *   - variant markers disagreeing (live/acoustic/remix on one side only) costs 0.30
 *
 * The weights and thresholds are all in MATCH_DEFAULTS and surfaced as settings —
 * §11 says these get tuned by hand, so nothing here is a magic number in-place.
 */

import { normalizeTrack, type NormalizedTitle, type VariantMarker } from './normalize.js'
import { tokenSetRatio } from './similarity.js'

export type MatchMethod =
  | 'ISRC'
  | 'MBID'
  | 'FINGERPRINT'
  | 'EXACT_NORM'
  | 'FUZZY'
  | 'MANUAL'
  | 'NONE'

export type MatchStatus = 'MATCHED' | 'MISSING' | 'NEEDS_REVIEW' | 'REJECTED' | 'DOWNLOADING'

export interface MatchDefaults {
  /** ≥ this auto-accepts without review. */
  autoAcceptAt: number
  /** ≥ this (and < autoAcceptAt) goes to the review queue; below is treated as missing. */
  reviewFloorAt: number
  /** Duration tolerance for tiers 4 and 5, ms. */
  durationToleranceMs: number
  /** Beyond this, any non-ISRC match is vetoed outright, ms. */
  durationVetoMs: number
  /** Confidence cost when variant markers disagree. */
  variantMismatchPenalty: number
  /** Minimum artist token-set ratio for tier 5. */
  artistTokenFloor: number
  /**
   * Below this artist agreement, a pair is not a candidate at all regardless of how
   * well the titles agree. Stops common titles pairing unrelated artists.
   */
  artistPlausibilityFloor: number
}

export const MATCH_DEFAULTS: MatchDefaults = {
  autoAcceptAt: 0.9,
  reviewFloorAt: 0.6,
  durationToleranceMs: 3000,
  durationVetoMs: 10000,
  variantMismatchPenalty: 0.3,
  artistTokenFloor: 0.85,
  artistPlausibilityFloor: 0.3,
}

/** A track we want, from any source. */
export interface MatchSource {
  id: string
  title: string
  artists: string[]
  durationMs?: number | null
  isrc?: string | null
  mbid?: string | null
}

/** A track we already have. */
export interface MatchCandidate {
  id: string
  title: string
  artist: string
  durationMs?: number | null
  isrc?: string | null
  mbid?: string | null
  acoustId?: string | null
  fingerprint?: string | null
}

export interface MatchEvidence {
  method: MatchMethod
  /** Confidence before guard rails. */
  baseConfidence: number
  /** Confidence after guard rails — this is what is persisted. */
  confidence: number
  durationDeltaMs?: number
  artistTokenRatio?: number
  titleRatio?: number
  sourceVariants: VariantMarker[]
  candidateVariants: VariantMarker[]
  /** Human-readable reasons, shown in the review queue. */
  notes: string[]
}

export interface MatchResult {
  sourceId: string
  candidateId: string | null
  method: MatchMethod
  confidence: number
  status: MatchStatus
  evidence: MatchEvidence | null
  /** Runners-up, best first — the review queue offers these as alternatives. */
  alternatives: Array<{ candidateId: string; confidence: number; method: MatchMethod }>
}

const TIER_CONFIDENCE = {
  ISRC: 1.0,
  MBID: 0.98,
  FINGERPRINT: 0.95,
  EXACT_NORM: 0.9,
  FUZZY_TITLE: 0.75,
} as const

function normalizeIsrc(v: string | null | undefined): string | null {
  if (!v) return null
  const s = v.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  // ISRC is CC-XXX-YY-NNNNN → 12 chars. Anything else is junk from a bad tagger.
  return s.length === 12 ? s : null
}

function variantsDisagree(a: VariantMarker[], b: VariantMarker[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return true
  for (const v of sa) if (!sb.has(v)) return true
  return false
}

function describeVariantDelta(a: VariantMarker[], b: VariantMarker[]): string {
  const sa = new Set(a)
  const sb = new Set(b)
  const onlySource = [...sa].filter((v) => !sb.has(v))
  const onlyCandidate = [...sb].filter((v) => !sa.has(v))
  const bits: string[] = []
  if (onlySource.length) bits.push(`source is ${onlySource.join('+').toLowerCase()}`)
  if (onlyCandidate.length) bits.push(`library copy is ${onlyCandidate.join('+').toLowerCase()}`)
  return bits.join(', ')
}

interface Scored {
  candidate: MatchCandidate
  method: MatchMethod
  base: number
  evidence: MatchEvidence
}

function scorePair(
  source: MatchSource,
  sourceNorm: { title: NormalizedTitle; artist: { norm: string; normAll: string } },
  candidate: MatchCandidate,
  cfg: MatchDefaults,
): Scored | null {
  const candNorm = normalizeTrack({ title: candidate.title, artists: candidate.artist })

  const notes: string[] = []
  const durationDeltaMs =
    source.durationMs != null && candidate.durationMs != null
      ? Math.abs(source.durationMs - candidate.durationMs)
      : undefined

  const evidenceBase = {
    sourceVariants: sourceNorm.title.variants,
    candidateVariants: candNorm.title.variants,
    ...(durationDeltaMs !== undefined ? { durationDeltaMs } : {}),
  }

  // ── Tier 1: ISRC. The only tier immune to the duration veto — if two recordings
  // share an ISRC they ARE the same recording, and a duration delta means someone's
  // tag is wrong, not that the match is wrong.
  const sIsrc = normalizeIsrc(source.isrc)
  const cIsrc = normalizeIsrc(candidate.isrc)
  if (sIsrc && cIsrc && sIsrc === cIsrc) {
    return {
      candidate,
      method: 'ISRC',
      base: TIER_CONFIDENCE.ISRC,
      evidence: {
        ...evidenceBase,
        method: 'ISRC',
        baseConfidence: TIER_CONFIDENCE.ISRC,
        confidence: TIER_CONFIDENCE.ISRC,
        notes: [`ISRC ${sIsrc} on both sides`],
      },
    }
  }

  // ── Tier 2: MusicBrainz recording ID
  if (source.mbid && candidate.mbid && source.mbid === candidate.mbid) {
    return {
      candidate,
      method: 'MBID',
      base: TIER_CONFIDENCE.MBID,
      evidence: {
        ...evidenceBase,
        method: 'MBID',
        baseConfidence: TIER_CONFIDENCE.MBID,
        confidence: TIER_CONFIDENCE.MBID,
        notes: [`MusicBrainz recording ${source.mbid}`],
      },
    }
  }

  // ── Tier 3: fingerprint. Catches re-encodes at different bitrates.
  // (Source-side fingerprints only exist for tracks we downloaded ourselves; for
  // Spotify sources this tier is normally skipped.)
  if (candidate.fingerprint && (source as { fingerprint?: string }).fingerprint) {
    if (candidate.fingerprint === (source as { fingerprint?: string }).fingerprint) {
      return {
        candidate,
        method: 'FINGERPRINT',
        base: TIER_CONFIDENCE.FINGERPRINT,
        evidence: {
          ...evidenceBase,
          method: 'FINGERPRINT',
          baseConfidence: TIER_CONFIDENCE.FINGERPRINT,
          confidence: TIER_CONFIDENCE.FINGERPRINT,
          notes: ['identical chromaprint'],
        },
      }
    }
  }

  const titleEqual = sourceNorm.title.norm === candNorm.title.norm
  const artistRatio = tokenSetRatio(sourceNorm.artist.normAll, candNorm.artist.normAll)
  const titleRatio = tokenSetRatio(sourceNorm.title.norm, candNorm.title.norm)
  const durationOk =
    durationDeltaMs !== undefined && durationDeltaMs <= cfg.durationToleranceMs

  // ── Tier 4: exact normalized artist + title, duration within tolerance
  const artistEqual =
    sourceNorm.artist.normAll === candNorm.artist.normAll ||
    sourceNorm.artist.norm === candNorm.artist.norm
  if (titleEqual && artistEqual && durationOk) {
    notes.push(`normalized title and artist match, duration within ${durationDeltaMs}ms`)
    return {
      candidate,
      method: 'EXACT_NORM',
      base: TIER_CONFIDENCE.EXACT_NORM,
      evidence: {
        ...evidenceBase,
        method: 'EXACT_NORM',
        baseConfidence: TIER_CONFIDENCE.EXACT_NORM,
        confidence: TIER_CONFIDENCE.EXACT_NORM,
        artistTokenRatio: artistRatio,
        titleRatio,
        notes,
      },
    }
  }

  // ── Tier 5: title exact + duration ok + artist token-set above floor
  if (titleEqual && durationOk && artistRatio >= cfg.artistTokenFloor) {
    notes.push(`title matches, artist token overlap ${artistRatio.toFixed(2)}`)
    return {
      candidate,
      method: 'FUZZY',
      base: TIER_CONFIDENCE.FUZZY_TITLE,
      evidence: {
        ...evidenceBase,
        method: 'FUZZY',
        baseConfidence: TIER_CONFIDENCE.FUZZY_TITLE,
        confidence: TIER_CONFIDENCE.FUZZY_TITLE,
        artistTokenRatio: artistRatio,
        titleRatio,
        notes,
      },
    }
  }

  // ── Tier 6: everything else.
  //
  // Artist agreement is a GATE, not just a weighted term. Without this, an exact title
  // match alone reaches the review threshold — so every common title ("Crazy", "Home",
  // "Alive") pairs the wrong artists together and floods the review queue with pairs no
  // human would ever accept. Below the floor it is not a candidate at any confidence.
  if (artistRatio < cfg.artistPlausibilityFloor) return null

  // 50/50 so neither field can carry a match on its own.
  const blended = titleRatio * 0.5 + artistRatio * 0.5
  if (blended <= 0.4) return null // not worth carrying as an alternative

  notes.push(
    `fuzzy: title ${titleRatio.toFixed(2)}, artist ${artistRatio.toFixed(2)}`,
  )
  if (durationDeltaMs === undefined) notes.push('no duration on one side')

  const base = Math.min(blended, TIER_CONFIDENCE.FUZZY_TITLE - 0.01)
  return {
    candidate,
    method: 'FUZZY',
    base,
    evidence: {
      ...evidenceBase,
      method: 'FUZZY',
      baseConfidence: base,
      confidence: base,
      artistTokenRatio: artistRatio,
      titleRatio,
      notes,
    },
  }
}

/** Apply the guard rails from §7.3 to a tier result. Returns the adjusted evidence. */
function applyGuardRails(
  scored: Scored,
  cfg: MatchDefaults,
): { confidence: number; evidence: MatchEvidence; vetoed: boolean } {
  const ev = { ...scored.evidence, notes: [...scored.evidence.notes] }
  let confidence = scored.base

  // Duration veto — everything except ISRC.
  if (
    scored.method !== 'ISRC' &&
    ev.durationDeltaMs !== undefined &&
    ev.durationDeltaMs > cfg.durationVetoMs
  ) {
    ev.notes.push(
      `VETOED: duration differs by ${(ev.durationDeltaMs / 1000).toFixed(1)}s, over the ${cfg.durationVetoMs / 1000}s limit`,
    )
    return { confidence: 0, evidence: { ...ev, confidence: 0 }, vetoed: true }
  }

  // Variant disagreement — a live/acoustic/remix marker on one side only.
  if (variantsDisagree(ev.sourceVariants, ev.candidateVariants)) {
    confidence = Math.max(0, confidence - cfg.variantMismatchPenalty)
    ev.notes.push(
      `variant mismatch (${describeVariantDelta(ev.sourceVariants, ev.candidateVariants)}): -${cfg.variantMismatchPenalty}`,
    )
  }

  return { confidence, evidence: { ...ev, confidence }, vetoed: false }
}

function statusFor(confidence: number, cfg: MatchDefaults): MatchStatus {
  if (confidence >= cfg.autoAcceptAt) return 'MATCHED'
  if (confidence >= cfg.reviewFloorAt) return 'NEEDS_REVIEW'
  return 'MISSING'
}

/**
 * Match one source track against a candidate set.
 * Candidates should already be narrowed by index lookup; this ranks what it's given.
 */
export function matchTrack(
  source: MatchSource,
  candidates: MatchCandidate[],
  cfg: MatchDefaults = MATCH_DEFAULTS,
): MatchResult {
  const sourceNorm = normalizeTrack({ title: source.title, artists: source.artists })

  const scored: Array<{ scored: Scored; confidence: number; evidence: MatchEvidence }> = []
  for (const candidate of candidates) {
    const s = scorePair(source, sourceNorm, candidate, cfg)
    if (!s) continue
    const { confidence, evidence, vetoed } = applyGuardRails(s, cfg)
    if (vetoed) continue
    scored.push({ scored: s, confidence, evidence })
  }

  if (scored.length === 0) {
    return {
      sourceId: source.id,
      candidateId: null,
      method: 'NONE',
      confidence: 0,
      status: 'MISSING',
      evidence: null,
      alternatives: [],
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence)
  const best = scored[0]!

  return {
    sourceId: source.id,
    candidateId: best.scored.candidate.id,
    method: best.scored.method,
    confidence: Number(best.confidence.toFixed(4)),
    status: statusFor(best.confidence, cfg),
    evidence: best.evidence,
    alternatives: scored.slice(1, 6).map((s) => ({
      candidateId: s.scored.candidate.id,
      confidence: Number(s.confidence.toFixed(4)),
      method: s.scored.method,
    })),
  }
}
