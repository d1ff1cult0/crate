/**
 * Fixture data for the matching and normalization suites.
 *
 * These are the shapes that actually break naive matchers: five spellings of `feat.`,
 * remaster suffixes in three positions, unicode that NFKD changes the length of,
 * titles that are ONLY a variant word, and pairs that differ solely by duration.
 *
 * When a real-world title breaks matching, add it here first, then fix the code.
 */

export interface TitleCase {
  /** What the tagger/API gave us. */
  input: string
  /** Expected normalized core. */
  norm: string
  /** Expected variant markers, sorted. */
  variants?: string[]
  featured?: string[]
  remixer?: string
  why: string
}

export const TITLE_CASES: TitleCase[] = [
  // ── Noise that must be stripped ────────────────────────────
  {
    input: 'Bohemian Rhapsody - Remastered 2011',
    norm: 'bohemian rhapsody',
    why: 'trailing dash remaster is the single most common Spotify suffix',
  },
  {
    input: 'Come Together (Remastered 2009)',
    norm: 'come together',
    why: 'same thing in brackets',
  },
  {
    input: 'Paranoid Android - 2017 Remaster',
    norm: 'paranoid android',
    why: 'year before the word',
  },
  {
    input: 'Wish You Were Here [Digital Remaster]',
    norm: 'wish you were here',
    why: 'square brackets, no year',
  },
  {
    input: 'Everlong (Deluxe Edition)',
    norm: 'everlong',
    why: 'edition marketing',
  },
  {
    input: 'Blue Monday - Radio Edit',
    norm: 'blue monday',
    why: 'radio edit is a different master of the SAME recording, so it is noise',
  },
  {
    input: 'Karma Police (Album Version)',
    norm: 'karma police',
    why: 'album version is noise',
  },
  {
    input: 'Smells Like Teen Spirit - Single Version',
    norm: 'smells like teen spirit',
    why: 'single version is noise',
  },
  {
    input: "God Only Knows (Mono)",
    norm: 'god only knows',
    why: 'mono/stereo are pressings, not recordings',
  },
  {
    input: 'Song 2 (Explicit)',
    norm: 'song 2',
    why: 'explicit/clean is a content label, not a recording',
  },
  {
    input: 'Creep (Expanded Edition) - Remastered',
    norm: 'creep',
    why: 'two noise markers at once',
  },
  {
    input: 'Teardrop (20th Anniversary Edition)',
    norm: 'teardrop',
    why: 'anniversary edition',
  },

  // ── Variants that must SURVIVE ─────────────────────────────
  {
    input: 'Hurt (Live at Folsom Prison)',
    norm: 'hurt',
    variants: ['LIVE'],
    why: 'live is a different recording — matching it to the studio cut is a WRONG match',
  },
  {
    input: 'Layla - Acoustic',
    norm: 'layla',
    variants: ['ACOUSTIC'],
    why: 'acoustic version is a different recording',
  },
  {
    input: 'Where Is My Mind? (Demo)',
    norm: 'where is my mind',
    variants: ['DEMO'],
    why: 'demo take',
  },
  {
    input: 'Clint Eastwood (Instrumental)',
    norm: 'clint eastwood',
    variants: ['INSTRUMENTAL'],
    why: 'no vocals is emphatically a different recording',
  },
  {
    input: 'Live and Let Die',
    norm: 'live and let die',
    why: 'THE TRAP: "Live" here is part of the title, not a variant marker',
  },
  {
    input: 'Live Forever - Live at Wembley',
    norm: 'live forever',
    variants: ['LIVE'],
    why: 'title starts with Live AND is a live recording',
  },
  {
    input: 'Bohemian Rhapsody (Live Aid) - Remastered',
    norm: 'bohemian rhapsody',
    variants: ['LIVE'],
    why: 'live marker survives while the remaster noise is stripped',
  },

  // ── Remixes ────────────────────────────────────────────────
  {
    input: 'Sandstorm (Darude Remix)',
    norm: 'sandstorm',
    variants: ['REMIX'],
    remixer: 'darude',
    why: 'named remixer extracted',
  },
  {
    input: 'Around the World - Remixed by Masters at Work',
    norm: 'around the world',
    variants: ['REMIX'],
    remixer: 'masters at work',
    why: '"remixed by X" form',
  },
  {
    input: 'Losing It (Fisher Rework)',
    norm: 'losing it',
    variants: ['REMIX'],
    remixer: 'fisher',
    why: 'rework counts as a remix',
  },

  // ── feat. in five formats ──────────────────────────────────
  {
    input: 'Stan (feat. Dido)',
    norm: 'stan',
    featured: ['dido'],
    why: 'feat. with a dot',
  },
  {
    input: 'Crazy In Love feat Jay-Z',
    norm: 'crazy in love',
    featured: ['jay z'],
    why: 'feat with no dot, no brackets',
  },
  {
    input: 'Umbrella [ft. JAY-Z]',
    norm: 'umbrella',
    featured: ['jay z'],
    why: 'ft. in square brackets',
  },
  {
    input: 'Empire State of Mind (Featuring Alicia Keys)',
    norm: 'empire state of mind',
    featured: ['alicia keys'],
    why: 'spelled out',
  },
  {
    input: 'Under Pressure (with David Bowie)',
    norm: 'under pressure',
    featured: ['david bowie'],
    why: '"with" is a feature credit in practice',
  },
  {
    input: 'No Church in the Wild (feat. Frank Ocean & The-Dream)',
    norm: 'no church in the wild',
    featured: ['frank ocean', 'dream'],
    why: 'two featured artists joined by &; "The-Dream" loses its leading "the" like every other artist, which is fine because the same rule applies to the library side',
  },

  // ── Unicode ────────────────────────────────────────────────
  {
    input: 'Björk - Jóga',
    norm: 'bjork joga',
    why: 'diacritics folded via NFKD',
  },
  {
    input: 'Hoppípolla',
    norm: 'hoppipolla',
    why: 'diacritics on a bare title',
  },
  {
    input: 'Guðmundsdóttir',
    norm: 'gudmundsdottir',
    why: 'eth is a distinct letter NFKD will not decompose — needs transliteration',
  },
  {
    input: '‘Heroes’',
    norm: 'heroes',
    why: 'smart quotes folded then stripped as punctuation',
  },
  {
    input: 'Ænima',
    norm: 'aenima',
    why: 'ligature expanded by NFKD',
  },
  {
    input: 'До свидания',
    norm: 'до свидания',
    why: 'non-Latin scripts are preserved, not stripped — \\p{L} keeps them',
  },

  // ── Junk from pasted tracklists ────────────────────────────
  {
    input: '1. Nirvana - Lithium',
    norm: 'nirvana lithium',
    why: 'leading list index removed (the artist split happens elsewhere)',
  },
  {
    input: 'The Beatles',
    norm: 'beatles',
    why: 'leading "the" dropped so "The Beatles" and "Beatles" agree',
  },
]

export interface MatchFixture {
  name: string
  source: {
    id: string
    title: string
    artists: string[]
    durationMs?: number
    isrc?: string | null
    mbid?: string | null
  }
  candidates: Array<{
    id: string
    title: string
    artist: string
    durationMs?: number
    isrc?: string | null
    mbid?: string | null
    fingerprint?: string | null
  }>
  expect: {
    candidateId: string | null
    method: string
    status: string
    minConfidence?: number
    maxConfidence?: number
  }
  why: string
}

export const MATCH_FIXTURES: MatchFixture[] = [
  {
    name: 'ISRC beats everything',
    source: {
      id: 's1',
      title: 'Bohemian Rhapsody - Remastered 2011',
      artists: ['Queen'],
      durationMs: 354000,
      isrc: 'GBUM71029604',
    },
    candidates: [
      { id: 'c1', title: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 355000, isrc: 'GBUM71029604' },
      { id: 'c2', title: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 354000, isrc: null },
    ],
    expect: { candidateId: 'c1', method: 'ISRC', status: 'MATCHED', minConfidence: 1 },
    why: 'ISRC wins even when another candidate has a closer duration',
  },
  {
    name: 'ISRC survives a large duration delta',
    source: { id: 's2', title: 'Set Adrift', artists: ['PM Dawn'], durationMs: 250000, isrc: 'USUM70911111' },
    candidates: [
      { id: 'c1', title: 'Set Adrift', artist: 'PM Dawn', durationMs: 400000, isrc: 'USUM70911111' },
    ],
    expect: { candidateId: 'c1', method: 'ISRC', status: 'MATCHED' },
    why: 'ISRC is exempt from the duration veto — a delta means a bad tag, not a bad match',
  },
  {
    name: 'duration veto kills a non-ISRC match',
    source: { id: 's3', title: 'Kashmir', artists: ['Led Zeppelin'], durationMs: 508000 },
    candidates: [{ id: 'c1', title: 'Kashmir', artist: 'Led Zeppelin', durationMs: 900000 }],
    expect: { candidateId: null, method: 'NONE', status: 'MISSING' },
    why: 'a 6.5 minute difference is a different recording, whatever the title says',
  },
  {
    name: 'live version is not the studio version',
    source: { id: 's4', title: 'Hurt', artists: ['Johnny Cash'], durationMs: 216000 },
    candidates: [
      { id: 'c1', title: 'Hurt (Live at Folsom Prison)', artist: 'Johnny Cash', durationMs: 217000 },
    ],
    expect: { candidateId: 'c1', method: 'EXACT_NORM', status: 'NEEDS_REVIEW', maxConfidence: 0.89 },
    why: 'variant mismatch costs 0.30, dropping it out of auto-accept and into review',
  },
  {
    name: 'feat. in the title does not break the artist match',
    source: { id: 's5', title: 'Stan (feat. Dido)', artists: ['Eminem'], durationMs: 404000 },
    candidates: [{ id: 'c1', title: 'Stan', artist: 'Eminem feat. Dido', durationMs: 404000 }],
    expect: { candidateId: 'c1', method: 'EXACT_NORM', status: 'MATCHED', minConfidence: 0.9 },
    why: 'featured artist normalizes to the same set from either field',
  },
  {
    name: 'remaster suffix does not prevent a match',
    source: { id: 's6', title: 'Come Together - Remastered 2009', artists: ['The Beatles'], durationMs: 259000 },
    candidates: [{ id: 'c1', title: 'Come Together', artist: 'Beatles', durationMs: 260000 }],
    expect: { candidateId: 'c1', method: 'EXACT_NORM', status: 'MATCHED', minConfidence: 0.9 },
    why: 'noise stripped on one side, leading "the" dropped on the other',
  },
  {
    name: 'different artist, same title, stays unmatched',
    source: { id: 's7', title: 'Crazy', artists: ['Gnarls Barkley'], durationMs: 178000 },
    candidates: [{ id: 'c1', title: 'Crazy', artist: 'Patsy Cline', durationMs: 177000 }],
    expect: { candidateId: null, method: 'NONE', status: 'MISSING' },
    why: 'the classic false positive — title and duration agree but it is a different song',
  },
  {
    name: 'remix is flagged rather than silently accepted',
    source: { id: 's8', title: 'Sandstorm', artists: ['Darude'], durationMs: 225000 },
    candidates: [{ id: 'c1', title: 'Sandstorm (Darude Remix)', artist: 'Darude', durationMs: 226000 }],
    expect: { candidateId: 'c1', method: 'EXACT_NORM', status: 'NEEDS_REVIEW' },
    why: 'remix marker on one side only',
  },
  {
    name: 'nothing to match against',
    source: { id: 's9', title: 'Some Obscure B-Side', artists: ['Nobody'], durationMs: 200000 },
    candidates: [],
    expect: { candidateId: null, method: 'NONE', status: 'MISSING' },
    why: 'empty candidate set is the common case for a missing track',
  },
]
