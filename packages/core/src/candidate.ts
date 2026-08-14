/**
 * Candidate scoring before download. PROMPT.md §7.5.
 *
 * This is the single most damaging failure mode in the app: a wrong track that lands,
 * gets tagged, and enters the library looking legitimate. YouTube in particular is
 * adversarial here — search "artist - title" and you get karaoke versions, sped-up
 * edits, ten-hour loops and lyric videos ahead of the actual song.
 *
 * So the rules are deliberately harsh:
 *   - duration more than 2× the target is a HARD REJECT, no score, no appeal
 *   - junk markers the source does not have are heavily penalised
 *   - a variant mismatch (live/acoustic/remix on one side only) is penalised the same
 *     way the matching cascade penalises it, because it is the same mistake
 *
 * Every candidate keeps its reasons, and §7.5 requires the scored list to be logged on
 * every attempt — when a wrong track wins, the log has to show why.
 */

import { normalizeTrack, type VariantMarker } from './normalize.js'
import { tokenSetRatio } from './similarity.js'

export interface ScoreTarget {
  title: string
  artists: string[]
  durationMs?: number | null
  album?: string | null
}

export interface ScoreCandidate {
  id: string
  title: string
  artist: string
  album?: string | null
  durationMs?: number | null
  format?: string | null
  bitrate?: number | null
}

export interface ScoredCandidate {
  id: string
  score: number
  rejected: boolean
  reasons: string[]
}

export interface CandidateScoringOptions {
  /** Accept when duration is within this of the target. */
  durationToleranceMs: number
  /** Minimum acceptable bitrate for lossy formats, kbps. 0 disables the check. */
  minBitrateKbps: number
  /** Below this score a candidate is not worth downloading. */
  acceptFloor: number
  /** Below this artist similarity, a candidate takes a heavy penalty. */
  artistPlausibilityFloor: number
}

export const CANDIDATE_DEFAULTS: CandidateScoringOptions = {
  durationToleranceMs: 5000,
  minBitrateKbps: 0,
  acceptFloor: 0.5,
  artistPlausibilityFloor: 0.3,
}

/**
 * Junk markers. These appear in the CANDIDATE and, when the source has no matching
 * marker, indicate the wrong recording entirely. Weight is how much each costs.
 */
const JUNK_MARKERS: Array<{ re: RegExp; penalty: number; label: string }> = [
  { re: /\bkaraoke\b/i, penalty: 1.0, label: 'karaoke' },
  { re: /\binstrumental\b/i, penalty: 0.6, label: 'instrumental' },
  { re: /\bcover\b/i, penalty: 0.6, label: 'cover' },
  { re: /\bsped\s*up\b/i, penalty: 0.8, label: 'sped up' },
  { re: /\bslowed\b/i, penalty: 0.8, label: 'slowed' },
  { re: /\bnightcore\b/i, penalty: 1.0, label: 'nightcore' },
  { re: /\b8d\b/i, penalty: 0.8, label: '8D' },
  { re: /\breverb(ed)?\b/i, penalty: 0.6, label: 'reverb' },
  { re: /\blyrics?\b/i, penalty: 0.4, label: 'lyrics video' },
  { re: /\blive\b/i, penalty: 0.5, label: 'live' },
  { re: /\bremix\b/i, penalty: 0.5, label: 'remix' },
  { re: /\bcompilation|\bmix\s*\d*\s*hours?\b|\bfull\s+album\b/i, penalty: 1.0, label: 'compilation' },
  { re: /\bloop(ed)?\b/i, penalty: 1.0, label: 'loop' },
]

function variantSet(markers: VariantMarker[]): Set<string> {
  return new Set(markers.map((m) => m.toLowerCase()))
}

export function scoreCandidate(
  target: ScoreTarget,
  candidate: ScoreCandidate,
  opts: CandidateScoringOptions = CANDIDATE_DEFAULTS,
): ScoredCandidate {
  const reasons: string[] = []

  const targetNorm = normalizeTrack({ title: target.title, artists: target.artists })
  const candNorm = normalizeTrack({ title: candidate.title, artists: candidate.artist })

  // ── Hard rejects ─────────────────────────────────────────
  if (target.durationMs && candidate.durationMs) {
    if (candidate.durationMs > target.durationMs * 2) {
      return {
        id: candidate.id,
        score: 0,
        rejected: true,
        reasons: [
          `REJECTED: ${Math.round(candidate.durationMs / 1000)}s is more than twice the target ${Math.round(target.durationMs / 1000)}s — almost certainly a compilation, a loop or the wrong upload`,
        ],
      }
    }
    // Absurdly short is equally wrong: a preview clip or a broken upload.
    if (candidate.durationMs < target.durationMs * 0.5) {
      return {
        id: candidate.id,
        score: 0,
        rejected: true,
        reasons: [
          `REJECTED: ${Math.round(candidate.durationMs / 1000)}s is less than half the target — a clip or a truncated upload`,
        ],
      }
    }
  }

  if (opts.minBitrateKbps > 0 && candidate.bitrate) {
    const kbps = candidate.bitrate > 10000 ? candidate.bitrate / 1000 : candidate.bitrate
    if (kbps < opts.minBitrateKbps) {
      return {
        id: candidate.id,
        score: 0,
        rejected: true,
        reasons: [`REJECTED: ${Math.round(kbps)}kbps is below the ${opts.minBitrateKbps}kbps minimum`],
      }
    }
  }

  // ── Similarity ───────────────────────────────────────────
  const titleRatio = tokenSetRatio(targetNorm.title.norm, candNorm.title.norm)
  const artistRatio = tokenSetRatio(targetNorm.artist.normAll, candNorm.artist.normAll)

  // Title and artist carry the weight; nothing else can rescue a bad match on these.
  let score = titleRatio * 0.45 + artistRatio * 0.35
  reasons.push(`title ${titleRatio.toFixed(2)}, artist ${artistRatio.toFixed(2)}`)

  // A matching title with a completely unrelated artist is the wrong track, however
  // good everything else looks — it is how cover bands and re-recordings win searches.
  // This is a heavy penalty rather than a hard reject because provider metadata is
  // often loose (YouTube gives channel names like "Radiohead - Topic"), so a genuine
  // result with an odd artist string can still recover on duration and album.
  if (artistRatio < opts.artistPlausibilityFloor) {
    score -= 0.45
    reasons.push(
      `artist "${candidate.artist}" does not resemble "${target.artists.join(', ')}": -0.45`,
    )
  }

  // ── Duration ─────────────────────────────────────────────
  if (target.durationMs && candidate.durationMs) {
    const delta = Math.abs(target.durationMs - candidate.durationMs)
    if (delta <= opts.durationToleranceMs) {
      score += 0.2
      reasons.push(`duration within ${(delta / 1000).toFixed(1)}s`)
    } else {
      // Taper rather than cliff: 6s off is suspicious, 30s off is disqualifying.
      const penalty = Math.min(0.35, (delta - opts.durationToleranceMs) / 60_000)
      score -= penalty
      reasons.push(`duration off by ${(delta / 1000).toFixed(1)}s: -${penalty.toFixed(2)}`)
    }
  } else {
    reasons.push('no duration to compare')
  }

  // ── Album agreement is a mild positive signal ────────────
  if (target.album && candidate.album) {
    const albumRatio = tokenSetRatio(
      normalizeTrack({ title: target.album, artists: [] }).title.norm,
      normalizeTrack({ title: candidate.album, artists: [] }).title.norm,
    )
    if (albumRatio > 0.8) {
      score += 0.1
      reasons.push('album matches')
    }
  }

  // ── Junk markers the source does not share ───────────────
  const targetVariants = variantSet(targetNorm.title.variants)
  const haystack = `${candidate.title} ${candidate.album ?? ''}`

  for (const marker of JUNK_MARKERS) {
    if (!marker.re.test(haystack)) continue
    // If the source ALSO wants this (searching for a live version), it is not junk.
    const sourceWantsIt =
      targetVariants.has(marker.label.toUpperCase()) ||
      marker.re.test(`${target.title} ${target.album ?? ''}`)
    if (sourceWantsIt) {
      reasons.push(`"${marker.label}" present on both sides — not penalised`)
      continue
    }
    score -= marker.penalty
    reasons.push(`"${marker.label}" not wanted: -${marker.penalty.toFixed(2)}`)
  }

  const finalScore = Math.max(0, Math.min(1, score))
  return {
    id: candidate.id,
    score: Number(finalScore.toFixed(4)),
    rejected: finalScore < opts.acceptFloor,
    reasons,
  }
}

/** Score a whole result set, best first. Rejected candidates are kept for the log. */
export function rankCandidates(
  target: ScoreTarget,
  candidates: ScoreCandidate[],
  opts: CandidateScoringOptions = CANDIDATE_DEFAULTS,
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(target, c, opts))
    .sort((a, b) => Number(a.rejected) - Number(b.rejected) || b.score - a.score)
}

/** The one to download, or null when nothing cleared the floor. */
export function pickBestCandidate(
  target: ScoreTarget,
  candidates: ScoreCandidate[],
  opts: CandidateScoringOptions = CANDIDATE_DEFAULTS,
): ScoredCandidate | null {
  const ranked = rankCandidates(target, candidates, opts)
  const best = ranked[0]
  return best && !best.rejected ? best : null
}
