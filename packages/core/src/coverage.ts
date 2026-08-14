/**
 * Library coverage, computed once so the UI cannot invent its own arithmetic.
 *
 * The Overview used to show "4,277 / 9,119" against "missing 4,757" and a queue of 273,
 * and no combination of those numbers explained the others. Three separate problems:
 *
 *  1. **The parts did not add up to the whole.** Source tracks that had never been
 *     matched at all had no `Match` row, so they appeared in neither the matched nor the
 *     missing figure and silently vanished from the total.
 *  2. **"Missing" and "queueable" are different questions.** Pressing "download all
 *     missing" against 4,701 missing tracks queues far fewer, because a track that
 *     already has a request — succeeded, abandoned, failed, on hold, or already queued —
 *     is not queued again. Nothing said so, which made the button look broken.
 *  3. **Coverage was measured against a compromised denominator.** Recordings merged
 *     under a junk ISRC were invisible to matching, so music the owner already owned was
 *     counted as missing. See `isrc.ts`.
 *
 * Everything below is derived from counts the caller reads straight out of the database.
 * No estimates, and `reconciles` is an explicit assertion that the parts sum to the whole.
 */

export interface MatchCounts {
  matched: number
  missing: number
  needsReview: number
  downloading: number
  rejected: number
  /** Source tracks with no Match row at all — never evaluated. */
  unevaluated: number
}

export interface RequestCounts {
  queued: number
  running: number
  succeeded: number
  failed: number
  abandoned: number
  manualHold: number
}

export interface CoverageInput {
  /** Everything harvested or imported: the universe of tracks the owner wants. */
  sourceTracks: number
  matches: MatchCounts
  requests: RequestCounts
  /** MISSING matches with no DownloadRequest at all — what a queue-all would create. */
  missingWithoutRequest: number
}

export interface Coverage {
  wanted: number
  matched: number
  missing: number
  needsReview: number
  downloading: number
  rejected: number
  unevaluated: number
  /** matched / wanted, 0 when nothing is wanted. */
  ratio: number
  requests: RequestCounts
  /** Total DownloadRequest rows, whatever their state. */
  requestsTotal: number
  /** In flight right now: queued + running. */
  inFlight: number
  /** How many tracks "download all missing" would actually add. */
  queueable: number
  /**
   * Missing tracks that would NOT be queued, and why. The sum of `blocked` equals
   * `missing - queueable`, so the difference is always fully accounted for.
   */
  blocked: {
    total: number
    alreadyRequested: number
  }
  /** True when every source track is accounted for by exactly one match state. */
  reconciles: boolean
}

export function computeCoverage(input: CoverageInput): Coverage {
  const m = input.matches
  const accountedFor =
    m.matched + m.missing + m.needsReview + m.downloading + m.rejected + m.unevaluated

  const requestsTotal =
    input.requests.queued +
    input.requests.running +
    input.requests.succeeded +
    input.requests.failed +
    input.requests.abandoned +
    input.requests.manualHold

  // Clamped: a race between reading the two counts (a download landing mid-page-load)
  // must never produce a negative, which would render as nonsense.
  const queueable = Math.max(0, Math.min(input.missingWithoutRequest, m.missing))
  const alreadyRequested = Math.max(0, m.missing - queueable)

  return {
    wanted: input.sourceTracks,
    matched: m.matched,
    missing: m.missing,
    needsReview: m.needsReview,
    downloading: m.downloading,
    rejected: m.rejected,
    unevaluated: m.unevaluated,
    ratio: input.sourceTracks === 0 ? 0 : m.matched / input.sourceTracks,
    requests: input.requests,
    requestsTotal,
    inFlight: input.requests.queued + input.requests.running,
    queueable,
    blocked: { total: alreadyRequested, alreadyRequested },
    reconciles: accountedFor === input.sourceTracks,
  }
}

/**
 * Plain-English answer to "why did that only queue 273?".
 *
 * Returned rather than hard-coded into the page so the same explanation is available
 * wherever the action is offered, and so it is testable.
 */
export function explainQueueable(coverage: Coverage): string {
  if (coverage.missing === 0) return 'Nothing is missing, so there is nothing to queue.'
  if (coverage.blocked.total === 0) {
    return `All ${coverage.missing.toLocaleString()} missing tracks would be queued.`
  }
  return (
    `${coverage.queueable.toLocaleString()} of ${coverage.missing.toLocaleString()} missing tracks would be queued. ` +
    `The other ${coverage.blocked.total.toLocaleString()} already have a download request — ` +
    `queued, in flight, already downloaded, on hold, or previously failed or abandoned — ` +
    `and are not requested twice. Use the retry action to reconsider the failed and abandoned ones.`
  )
}

/**
 * Library counts, kept separate from coverage because they answer a different question
 * and conflating them is what made the numbers look wrong.
 *
 * `files` is what is on disk. `tracks` is distinct recordings after grouping copies of
 * the same thing. Navidrome counts songs — i.e. **files** — so `files` is the number that
 * should agree with it, and comparing Navidrome's total against `tracks` will always look
 * like a discrepancy when nothing is wrong at all.
 */
export interface LibraryTotals {
  files: number
  tracks: number
  /** Files beyond the first for each recording: extra copies. */
  duplicateFiles: number
}

export function computeLibraryTotals(files: number, tracks: number): LibraryTotals {
  return { files, tracks, duplicateFiles: Math.max(0, files - tracks) }
}
