import { describe, expect, it } from 'vitest'
import { cleanIsrc, isValidIsrc, normalizeIsrc } from '../src/isrc.js'

/**
 * Every junk value below was found in the owner's actual library, where it had merged
 * unrelated songs into a single LibraryTrack because ISRC is tier 1 of the matching
 * cascade. `PMEDIA` alone absorbed 2,585 different songs.
 */

describe('isValidIsrc', () => {
  it('accepts a canonical ISRC', () => {
    expect(isValidIsrc('GBAYE9700263')).toBe(true)
  })

  it('accepts the hyphenated presentation form', () => {
    // Rejecting a correctly-written ISRC would be its own kind of wrong.
    expect(isValidIsrc('BE-C46-14-03118')).toBe(true)
    expect(isValidIsrc('DE-Z20-06-00038')).toBe(true)
    expect(isValidIsrc('NL-C35-13-48006')).toBe(true)
  })

  it('accepts a registrant code containing digits', () => {
    expect(isValidIsrc('USRC17607839')).toBe(true)
    expect(isValidIsrc('FR6V81234567')).toBe(true)
  })

  it('rejects the scene tags that caused the merge', () => {
    for (const junk of ['PMEDIA', 'P.M.E.D.I.A', 'SRC', 'WWW.iM1MUSIC.NET', 'www.viperial.com', 'http:']) {
      expect(isValidIsrc(junk), junk).toBe(false)
    }
  })

  it('rejects catalogue numbers and barcodes', () => {
    for (const junk of ['440 014 979-2', '0888751309128', '82876 55497 2', '487161 2,Col 487161 2']) {
      expect(isValidIsrc(junk), junk).toBe(false)
    }
  })

  it('rejects all-zero placeholders', () => {
    // Structurally these can pass the pattern, and they would merge every file carrying
    // them into one track — the same catastrophe by a different route.
    expect(isValidIsrc('000000000000')).toBe(false)
    expect(isValidIsrc('XX0000000000')).toBe(false)
  })

  it('rejects the wrong length', () => {
    expect(isValidIsrc('GBAYE970026')).toBe(false) // 11
    expect(isValidIsrc('GBAYE97002631')).toBe(false) // 13
  })

  it('rejects a numeric country code', () => {
    expect(isValidIsrc('12AYE9700263')).toBe(false)
  })

  it('rejects letters where digits belong', () => {
    expect(isValidIsrc('GBAYE97002AB')).toBe(false)
  })

  it('rejects null, undefined and empty', () => {
    expect(isValidIsrc(null)).toBe(false)
    expect(isValidIsrc(undefined)).toBe(false)
    expect(isValidIsrc('')).toBe(false)
    expect(isValidIsrc('   ')).toBe(false)
  })
})

describe('normalizeIsrc', () => {
  it('strips presentation characters and upper-cases', () => {
    expect(normalizeIsrc('be-c46-14-03118')).toBe('BEC461403118')
    expect(normalizeIsrc('GB AYE 97 00263')).toBe('GBAYE9700263')
  })
})

describe('cleanIsrc', () => {
  it('returns the storable form for a real ISRC', () => {
    expect(cleanIsrc('be-c46-14-03118')).toBe('BEC461403118')
  })

  it('returns null for junk rather than throwing', () => {
    // A junk ISRC is a normal property of real files, not an error — the file is still
    // perfectly good, it just has one tag that cannot be trusted.
    expect(cleanIsrc('PMEDIA')).toBeNull()
    expect(cleanIsrc(null)).toBeNull()
  })

  it('is idempotent', () => {
    const once = cleanIsrc('BE-C46-14-03118')
    expect(cleanIsrc(once)).toBe(once)
  })
})
