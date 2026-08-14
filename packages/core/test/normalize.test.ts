import { describe, expect, it } from 'vitest'
import {
  baseNormalize,
  normalizeArtist,
  normalizeTitle,
  normalizeTrack,
  splitArtistString,
  stripDiacritics,
} from '../src/normalize.js'
import { TITLE_CASES } from './fixtures/tracks.js'

describe('baseNormalize', () => {
  it('lowercases, folds diacritics and collapses whitespace', () => {
    expect(baseNormalize('  Björk   GUÐMUNDSDÓTTIR ')).toBe('bjork gudmundsdottir')
  })

  it('drops a leading "the" so "The Beatles" and "Beatles" agree', () => {
    expect(baseNormalize('The Beatles')).toBe('beatles')
    expect(baseNormalize('Beatles')).toBe('beatles')
  })

  it('normalizes & and + to "and"', () => {
    expect(baseNormalize('Simon & Garfunkel')).toBe('simon and garfunkel')
    expect(baseNormalize('Simon + Garfunkel')).toBe('simon and garfunkel')
    expect(baseNormalize('Simon and Garfunkel')).toBe('simon and garfunkel')
  })

  it('keeps non-Latin scripts', () => {
    expect(baseNormalize('До свидания')).toBe('до свидания')
  })

  it('strips punctuation but not word characters', () => {
    expect(baseNormalize("Don't Stop Me Now!")).toBe('dont stop me now')
  })
})

describe('stripDiacritics', () => {
  it('handles NFKD decomposition', () => {
    expect(stripDiacritics('Sigur Rós')).toBe('Sigur Ros')
    expect(stripDiacritics('Mötley Crüe')).toBe('Motley Crue')
  })
})

describe('normalizeTitle — fixture corpus', () => {
  for (const c of TITLE_CASES) {
    it(`${c.input} → "${c.norm}" (${c.why})`, () => {
      const result = normalizeTitle(c.input)
      expect(result.norm).toBe(c.norm)
      if (c.variants) expect(result.variants).toEqual(c.variants.sort())
      if (c.featured) expect(result.featured.sort()).toEqual([...c.featured].sort())
      if (c.remixer) expect(result.remixer).toBe(c.remixer)
    })
  }
})

describe('normalizeTitle — the noise/variant boundary', () => {
  it('treats a radio edit as noise but a live take as a variant', () => {
    expect(normalizeTitle('Blue Monday - Radio Edit').variants).toEqual([])
    expect(normalizeTitle('Blue Monday - Live in Berlin').variants).toEqual(['LIVE'])
  })

  it('does not mistake a title containing "live" for a live recording', () => {
    const t = normalizeTitle('Live and Let Die')
    expect(t.variants).toEqual([])
    expect(t.norm).toBe('live and let die')
  })

  it('keeps a variant when noise sits alongside it', () => {
    const t = normalizeTitle('Bohemian Rhapsody (Live Aid) - Remastered 2011')
    expect(t.variants).toEqual(['LIVE'])
    expect(t.norm).toBe('bohemian rhapsody')
  })

  it('never returns an empty title when the whole title was a marker word', () => {
    // Erasure have an album called "Live"; a track called "Acoustic" exists too.
    const t = normalizeTitle('Acoustic')
    expect(t.norm).not.toBe('')
  })
})

describe('splitArtistString', () => {
  it('splits on every documented separator', () => {
    expect(splitArtistString('Above & Beyond, Zoë Johnston; Justine Suissa')).toEqual([
      'above',
      'beyond',
      'zoe johnston',
      'justine suissa',
    ])
  })

  it('splits on a spaced x but not on an x inside a word', () => {
    expect(splitArtistString('Skrillex x Diplo')).toEqual(['skrillex', 'diplo'])
    expect(splitArtistString('Sixx:A.M.')).toEqual(['sixx a m'])
  })

  it('treats feat./ft. as a separator', () => {
    expect(splitArtistString('Eminem feat. Dido')).toEqual(['eminem', 'dido'])
    expect(splitArtistString('Rihanna ft. JAY-Z')).toEqual(['rihanna', 'jay z'])
  })
})

describe('normalizeArtist', () => {
  it('produces an order-insensitive normAll', () => {
    const a = normalizeArtist(['Jack White', 'Meg White'])
    const b = normalizeArtist(['Meg White', 'Jack White'])
    expect(a.normAll).toBe(b.normAll)
  })

  it('keeps credit order in artists[]', () => {
    expect(normalizeArtist(['Jack White', 'Meg White']).artists).toEqual([
      'jack white',
      'meg white',
    ])
  })

  it('dedupes a repeated artist', () => {
    expect(normalizeArtist(['Queen', 'Queen']).artists).toEqual(['queen'])
  })
})

describe('normalizeTrack', () => {
  it('folds a title-embedded feat. into the artist list', () => {
    const r = normalizeTrack({ title: 'Stan (feat. Dido)', artists: ['Eminem'] })
    expect(r.title.norm).toBe('stan')
    expect(r.artist.artists).toContain('dido')
    expect(r.artist.artists).toContain('eminem')
  })

  it('reaches the same artist set whichever field the feature was in', () => {
    const inTitle = normalizeTrack({ title: 'Stan (feat. Dido)', artists: ['Eminem'] })
    const inArtist = normalizeTrack({ title: 'Stan', artists: ['Eminem feat. Dido'] })
    expect(inTitle.artist.normAll).toBe(inArtist.artist.normAll)
  })
})
