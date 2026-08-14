import { describe, expect, it } from 'vitest'
import {
  hasUnstorableCharacters,
  sanitizeDeep,
  sanitizeText,
  sanitizeTextOrNull,
  sanitizeTextVerbose,
} from '../src/sanitize.js'

const NUL = '\u0000'

describe('sanitizeText', () => {
  it('strips the NUL byte that stopped a full library scan', () => {
    // The actual failure: PostgresError 22021, invalid byte sequence for encoding
    // "UTF8": 0x00 — from one file among 35,000.
    expect(sanitizeText(`Paranoid Android${NUL}`)).toBe('Paranoid Android')
    expect(sanitizeText(`${NUL}${NUL}Creep${NUL}`)).toBe('Creep')
  })

  it('handles a UTF-16 tag misread as UTF-8, where every other byte is a NUL', () => {
    const misread = 'C\u0000r\u0000e\u0000e\u0000p\u0000'
    expect(sanitizeText(misread)).toBe('Creep')
  })

  it('strips other C0 control characters and DEL', () => {
    expect(sanitizeText('a\u0001b\u0007c\u001Fd\u007Fe')).toBe('abcde')
  })

  it('turns line breaks into spaces rather than deleting them', () => {
    // "Artist\nTitle" losing its separator would join two words into one.
    expect(sanitizeText('Artist\nTitle')).toBe('Artist Title')
    expect(sanitizeText('A\r\nB')).toBe('A B')
    expect(sanitizeText('A\tB')).toBe('A B')
  })

  it('strips unpaired surrogates, which UTF-8 cannot encode either', () => {
    expect(sanitizeText('Trunc\uD83D')).toBe('Trunc')
    expect(sanitizeText('\uDE00Lead')).toBe('Lead')
  })

  it('keeps VALID surrogate pairs — emoji in a title are legitimate', () => {
    expect(sanitizeText('Hello 👋 World')).toBe('Hello 👋 World')
  })

  it('leaves ordinary non-ASCII completely alone', () => {
    // The whole point of not reusing the normalizer: mangling "Sigur Rós" into
    // "Sigur R_s" is exactly what makes a library feel broken.
    expect(sanitizeText('Sigur Rós')).toBe('Sigur Rós')
    expect(sanitizeText('До свидания')).toBe('До свидания')
    expect(sanitizeText('Udo Jürgens')).toBe('Udo Jürgens')
    expect(sanitizeText('東京事変')).toBe('東京事変')
  })

  it('collapses the whitespace a removal leaves behind', () => {
    expect(sanitizeText(`A${NUL} ${NUL} B`)).toBe('A B')
  })

  it('trims, because a fixed-width ID3 field is padded', () => {
    expect(sanitizeText('  Title  ')).toBe('Title')
  })

  it('leaves a clean string byte-identical', () => {
    const clean = 'Fontaines D.C. - Boys in the Better Land'
    expect(sanitizeText(clean)).toBe(clean)
  })
})

describe('sanitizeTextVerbose', () => {
  it('reports when nothing had to change', () => {
    expect(sanitizeTextVerbose('Clean')).toEqual({ value: 'Clean', changed: false })
  })

  it('reports when something did, so the scanner can name the file', () => {
    const result = sanitizeTextVerbose(`Dirty${NUL}`)
    expect(result).toEqual({ value: 'Dirty', changed: true })
  })
})

describe('sanitizeTextOrNull', () => {
  it('passes null and undefined straight through', () => {
    expect(sanitizeTextOrNull(null)).toBeNull()
    expect(sanitizeTextOrNull(undefined)).toBeNull()
  })

  it('treats a tag that sanitizes to nothing as absent', () => {
    // A field containing only NULs was never a real value.
    expect(sanitizeTextOrNull(`${NUL}${NUL}`)).toBeNull()
  })
})

describe('sanitizeDeep', () => {
  it('cleans nested strings and reports which keys changed', () => {
    const result = sanitizeDeep({
      title: `Song${NUL}`,
      artist: 'Clean',
      nested: { album: `Album${NUL}` },
    })
    expect(result.value).toEqual({
      title: 'Song',
      artist: 'Clean',
      nested: { album: 'Album' },
    })
    expect(result.changedKeys).toEqual(['title', 'nested.album'])
  })

  it('cleans strings inside arrays', () => {
    const result = sanitizeDeep({ artists: [`A${NUL}`, 'B'] })
    expect(result.value).toEqual({ artists: ['A', 'B'] })
    expect(result.changedKeys).toEqual(['artists[0]'])
  })

  it('preserves non-string types rather than stringifying them', () => {
    // tagsJson holds track/disc numbers and nulls; turning those into strings would
    // change what the quality scorer and the post-processor read back.
    const result = sanitizeDeep({ track: 6, disc: null, ok: true, missing: undefined })
    expect(result.value).toEqual({ track: 6, disc: null, ok: true, missing: undefined })
    expect(result.changedKeys).toEqual([])
  })

  it('cleans object KEYS too — a NUL in a key is equally fatal to jsonb', () => {
    const result = sanitizeDeep({ [`bad${NUL}key`]: 'value' })
    expect(Object.keys(result.value as object)).toEqual(['badkey'])
    expect(result.changedKeys).toContain('badkey (key)')
  })

  it('reports nothing for an already-clean payload', () => {
    const clean = { title: 'Song', track: 1, artists: ['A', 'B'] }
    const result = sanitizeDeep(clean)
    expect(result.value).toEqual(clean)
    expect(result.changedKeys).toEqual([])
  })
})

describe('hasUnstorableCharacters', () => {
  it('detects a NUL', () => {
    expect(hasUnstorableCharacters(`a${NUL}b`)).toBe(true)
  })

  it('detects a lone surrogate', () => {
    expect(hasUnstorableCharacters('a\uD83D')).toBe(true)
  })

  it('is false for clean text, including emoji and non-ASCII', () => {
    expect(hasUnstorableCharacters('Sigur Rós 👋')).toBe(false)
  })

  it('gives the same answer when called twice — the regexes are global', () => {
    // A /g regex carries lastIndex between .test() calls; forgetting to reset it makes
    // every second call lie.
    const dirty = `a${NUL}b`
    expect(hasUnstorableCharacters(dirty)).toBe(true)
    expect(hasUnstorableCharacters(dirty)).toBe(true)
  })
})
