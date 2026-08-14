import { describe, expect, it } from 'vitest'
import {
  computeCoverage,
  computeLibraryTotals,
  explainQueueable,
  type CoverageInput,
} from '../src/coverage.js'

/** The real numbers from the owner's instance, read out of Postgres. */
const REAL: CoverageInput = {
  sourceTracks: 9119,
  matches: {
    matched: 4333,
    missing: 4701,
    needsReview: 0,
    downloading: 78,
    rejected: 0,
    unevaluated: 7, // source tracks with no Match row at all
  },
  requests: {
    queued: 174,
    running: 5,
    succeeded: 849,
    failed: 303,
    abandoned: 283,
    manualHold: 0,
  },
  missingWithoutRequest: 4017,
}

describe('computeCoverage', () => {
  it('accounts for every source track', () => {
    // The old Overview lost the never-evaluated ones entirely: they had no Match row, so
    // they were in neither the matched nor the missing figure and the parts did not sum
    // to the whole.
    const c = computeCoverage(REAL)
    expect(c.reconciles).toBe(true)
    expect(c.matched + c.missing + c.needsReview + c.downloading + c.rejected + c.unevaluated).toBe(
      c.wanted,
    )
  })

  it('reports a coverage ratio against the full wanted set', () => {
    const c = computeCoverage(REAL)
    expect(c.ratio).toBeCloseTo(4333 / 9119, 6)
  })

  it('separates "missing" from "would actually be queued"', () => {
    // The complaint: pressing download-all-missing queues far fewer than the missing
    // count, with nothing explaining why.
    const c = computeCoverage(REAL)
    expect(c.missing).toBe(4701)
    expect(c.queueable).toBe(4017)
    expect(c.blocked.total).toBe(684)
  })

  it('always fully accounts for the difference', () => {
    const c = computeCoverage(REAL)
    expect(c.queueable + c.blocked.total).toBe(c.missing)
  })

  it('sums request states into a total and an in-flight figure', () => {
    const c = computeCoverage(REAL)
    expect(c.requestsTotal).toBe(174 + 5 + 849 + 303 + 283)
    expect(c.inFlight).toBe(179)
  })

  it('flags a set that does not reconcile rather than hiding it', () => {
    const c = computeCoverage({ ...REAL, sourceTracks: 9999 })
    expect(c.reconciles).toBe(false)
  })

  it('never returns a negative when counts race', () => {
    // Reading the missing count and the without-request count are two queries; a
    // download landing between them must not render as a negative.
    const c = computeCoverage({ ...REAL, missingWithoutRequest: 99999 })
    expect(c.queueable).toBe(c.missing)
    expect(c.blocked.total).toBe(0)
  })

  it('handles an empty instance', () => {
    const c = computeCoverage({
      sourceTracks: 0,
      matches: { matched: 0, missing: 0, needsReview: 0, downloading: 0, rejected: 0, unevaluated: 0 },
      requests: { queued: 0, running: 0, succeeded: 0, failed: 0, abandoned: 0, manualHold: 0 },
      missingWithoutRequest: 0,
    })
    expect(c.ratio).toBe(0)
    expect(c.reconciles).toBe(true)
  })
})

describe('explainQueueable', () => {
  it('explains the shortfall in plain language', () => {
    const text = explainQueueable(computeCoverage(REAL))
    expect(text).toContain('4,017')
    expect(text).toContain('4,701')
    expect(text).toContain('684')
    expect(text).toMatch(/already have a download request/)
  })

  it('says so when everything would be queued', () => {
    const c = computeCoverage({ ...REAL, missingWithoutRequest: 4701 })
    expect(explainQueueable(c)).toMatch(/All 4,701 missing tracks would be queued/)
  })

  it('says so when nothing is missing', () => {
    const c = computeCoverage({
      ...REAL,
      matches: { ...REAL.matches, missing: 0 },
      missingWithoutRequest: 0,
    })
    expect(explainQueueable(c)).toMatch(/Nothing is missing/)
  })
})

describe('computeLibraryTotals', () => {
  it('keeps files and recordings distinct', () => {
    // The reported discrepancy: the UI showed the TRACK count next to Navidrome's SONG
    // count. Navidrome counts songs, i.e. files, so `files` is what should agree with it.
    const t = computeLibraryTotals(36237, 31169)
    expect(t.files).toBe(36237)
    expect(t.tracks).toBe(31169)
    expect(t.duplicateFiles).toBe(5068)
  })

  it('reports no extra copies when every recording has one file', () => {
    expect(computeLibraryTotals(100, 100).duplicateFiles).toBe(0)
  })

  it('never reports negative extra copies', () => {
    expect(computeLibraryTotals(10, 20).duplicateFiles).toBe(0)
  })
})
