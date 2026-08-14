/**
 * Track/artist normalization. PROMPT.md §7.3.
 *
 * The single most important distinction in this file:
 *
 *   NOISE      — "remastered 2011", "deluxe edition", "radio edit". Different pressing
 *                of the SAME recording. Strip it; it must not affect matching.
 *   VARIANT    — "live", "acoustic", "demo", "instrumental", "remix". A DIFFERENT
 *                recording that happens to share a title. Extract and KEEP it, because
 *                matching a studio track to its live version is a wrong match, not a
 *                near-miss. §7.3 drops confidence by 0.3 when these disagree.
 *   FEATURING  — "feat. X". Neither: it's artist information that happens to live in
 *                the title field. Extract it into the artist list.
 *
 * Getting the noise/variant boundary wrong in either direction is the difference
 * between the app feeling magic and feeling infuriating, so both lists are explicit
 * and both are tested. Tune the lists here; the cascade in matching.ts reads them.
 */

export type VariantMarker =
  | 'LIVE'
  | 'ACOUSTIC'
  | 'DEMO'
  | 'INSTRUMENTAL'
  | 'REMIX'
  | 'COVER'
  | 'KARAOKE'
  | 'REPRISE'
  | 'EDIT_VARIANT'

export interface NormalizedTitle {
  /** Normalized core title with noise, variants and featuring removed. */
  norm: string
  /** Recording-identifying markers found. Order-independent; compare as a set. */
  variants: VariantMarker[]
  /** Remixer name when a "X remix" was found, normalized. */
  remixer?: string
  /** Artists extracted from a "feat." in the title. */
  featured: string[]
  raw: string
}

export interface NormalizedArtist {
  /** Normalized primary artist — first in the credit order. */
  norm: string
  /** All credited artists in order, normalized. */
  artists: string[]
  /** Normalized join of every artist, sorted — for order-insensitive comparison. */
  normAll: string
  raw: string
}

/**
 * Letters NFKD does NOT decompose, because they are distinct letters rather than a
 * base plus a combining mark. Without this, "Ænima" stays "ænima" and "Guðmundsdóttir"
 * keeps its eth — both then fail to match a library tagged with the ASCII spelling,
 * which is how these are usually filed.
 */
const TRANSLITERATE: Record<string, string> = {
  æ: 'ae', Æ: 'ae',
  œ: 'oe', Œ: 'oe',
  ø: 'o', Ø: 'o',
  ð: 'd', Ð: 'd',
  þ: 'th', Þ: 'th',
  ß: 'ss',
  ł: 'l', Ł: 'l',
  đ: 'd', Đ: 'd',
  ħ: 'h', Ħ: 'h',
  ŧ: 't', Ŧ: 't',
  ı: 'i', İ: 'i',
  ŋ: 'n', Ŋ: 'n',
}

/**
 * Noise: pressing/edition/marketing junk. Stripped entirely.
 *
 * ORDER MATTERS — most specific first. "Digital Remaster" must be consumed whole,
 * because the generic remaster pattern would otherwise eat "Remaster" and strand
 * "Digital" in the title.
 */
const NOISE_PATTERNS: RegExp[] = [
  /\bdigital\s+re-?master(?:ed|s)?\b/,
  /\b\d{4}\s+re-?master(?:ed|s)?(?:\s+(?:version|edition))?\b/,
  /\bre-?master(?:ed|s)?(?:\s+(?:version|edition))?(?:\s+\d{4})?\b/,
  /\bsuper\s+deluxe(?:\s+(?:edition|version))?\b/,
  /\bdeluxe(?:\s+(?:edition|version))?\b/,
  /\bexpanded(?:\s+(?:edition|version))?\b/,
  /\b(?:\d+(?:st|nd|rd|th)\s+)?anniversary(?:\s+(?:edition|version))?\b/,
  /\bradio\s+edit\b/,
  /\bsingle\s+(?:version|edit)\b/,
  /\balbum\s+version\b/,
  /\boriginal\s+(?:mix|version)\b/,
  /\bnew\s+stereo\s+mix\b/,
  /\bmono(?:\s+version)?\b/,
  /\bstereo(?:\s+version)?\b/,
  /\bbonus\s+track\b/,
  /\bexplicit(?:\s+version)?\b/,
  /\bclean(?:\s+version)?\b/,
  /\bfrom\s+the\s+motion\s+picture\b/,
  /\bofficial\s+(?:audio|video|music\s+video)\b/,
  /\bhd\b/,
  /\bhq\b/,
]

/**
 * Variants: markers identifying a DIFFERENT recording.
 *
 * `coreSafe: false` means the bare word must NOT be treated as a marker when it appears
 * in the core title — "Live and Let Die" and "Cover Me" are titles, not annotations.
 * In the core, those only count with a qualifier ("Live at Wembley"). Inside brackets
 * or after a dash the bare word is reliable, because that is where annotations live.
 */
const VARIANT_PATTERNS: Array<{
  marker: VariantMarker
  /** Matches anywhere, including a bare mention. Used for annotations. */
  loose: RegExp
  /** Matches only qualified forms. Used for the core title. */
  strict?: RegExp
}> = [
  {
    marker: 'LIVE',
    loose: /\blive\b(?:\s+(?:at|in|from|on)\b[^)\]]*)?/,
    strict: /\blive\s+(?:at|in|from|on)\b[^)\]]*/,
  },
  { marker: 'ACOUSTIC', loose: /\bacoustic(?:\s+version)?\b/, strict: /\bacoustic\s+version\b/ },
  { marker: 'DEMO', loose: /\bdemo(?:\s+version)?\b/, strict: /\bdemo\s+version\b/ },
  { marker: 'INSTRUMENTAL', loose: /\binstrumental\b/, strict: /\binstrumental\s+version\b/ },
  { marker: 'KARAOKE', loose: /\bkaraoke(?:\s+version)?\b/ },
  { marker: 'COVER', loose: /\bcover(?:\s+version)?\b/, strict: /\bcover\s+version\b/ },
  { marker: 'REPRISE', loose: /\breprise\b/, strict: /\breprise\b/ },
  // After the noise pass, so "radio edit" is already gone: a surviving named edit
  // ("Sped Up", "Nightcore") really does identify a different recording.
  { marker: 'EDIT_VARIANT', loose: /\b(?:sped\s*up|slowed|nightcore|8d|reverb)\b/ },
]

/**
 * Remix forms. Capture classes allow hyphens so "The-Dream" and "Jay-Z" survive;
 * they stop at a SPACED dash, which is the annotation separator.
 */
const REMIX_PATTERNS: RegExp[] = [
  /\bremix(?:ed)?\s+by\s+(.+?)(?=\s+[-–—]\s+|$)/i,
  /\b(.+?)\s+(?:remix|rmx|rework|bootleg|flip|vip\s+mix)\b/i,
  /\bremix\b/i,
]

/** Capture stops at a spaced dash, not at any dash — hyphenated names must survive. */
const FEAT_RE = /\b(?:feat\.?|ft\.?|featuring|w\/|with)\s+(.+?)(?=\s+[-–—]\s+|[)\]}]|$)/i

/** Artist-list separators. `x` only when space-delimited, so "Sixx" survives. */
const ARTIST_SPLIT_RE =
  /\s*(?:,|;|\/|\||&|\+|\bx\b|\bvs\.?\b|\band\b|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/gi

/** Residue that is never real title content once its noise marker has been stripped. */
const RESIDUE = new Set([
  'version', 'edition', 'edit', 'mix', 'remaster', 'remastered', 'digital', 'the',
  'a', 'an', 'and', 'of', 'from', 'at', 'in', 'on', 'with', 'aid', 'session',
  'sessions', 'take', 'takes', 'recording', 'audio', 'video', 'track', 'feat', 'ft',
])

/** Unicode punctuation → ASCII. Smart quotes and dash variants break exact matching. */
export function asciiFold(input: string): string {
  return input
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[   ​‌‍﻿]/g, ' ')
    .replace(/…/g, '...')
}

/** NFKD, strip combining marks, then transliterate the letters NFKD leaves alone. */
export function stripDiacritics(input: string): string {
  const decomposed = input.normalize('NFKD').replace(/\p{Diacritic}/gu, '')
  let out = ''
  for (const ch of decomposed) out += TRANSLITERATE[ch] ?? ch
  return out
}

/** Final pass: lowercase, drop punctuation, collapse whitespace, drop leading "the". */
export function baseNormalize(input: string, opts: { stripLeadingThe?: boolean } = {}): string {
  let s = stripDiacritics(asciiFold(input)).toLowerCase()
  s = s.replace(/&/g, ' and ').replace(/\+/g, ' and ')
  // Apostrophes are ELIDED, not spaced: "don't" → "dont", matching how taggers differ.
  s = s.replace(/['’`]/g, '')
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (opts.stripLeadingThe !== false) s = s.replace(/^the\s+/, '')
  return s.replace(/\s+/g, ' ').trim()
}

/** Bracketed segments plus trailing " - <segment>", which carry the same annotations. */
function splitAnnotations(title: string): { core: string; annotations: string[] } {
  const annotations: string[] = []
  let core = title

  let prev: string
  do {
    prev = core
    core = core.replace(/[([{]([^)\]}]*)[)\]}]/g, (_m, inner: string) => {
      annotations.push(inner)
      return ' '
    })
  } while (core !== prev)

  // Only split on a SPACED dash, so hyphenated titles ("Ob-La-Di") stay intact.
  const dashParts = core.split(/\s+[-–—]\s+/)
  if (dashParts.length > 1) {
    core = dashParts[0] ?? core
    annotations.push(...dashParts.slice(1))
  }

  return { core: core.trim(), annotations }
}

function stripNoise(text: string): string {
  let out = text
  let prev: string
  // Repeat to a fixed point: "(Expanded Edition) - Remastered" needs two passes.
  do {
    prev = out
    for (const re of NOISE_PATTERNS) {
      out = out.replace(new RegExp(re.source, 'gi'), ' ')
    }
  } while (out !== prev)
  return out
}

function extractFeatured(text: string): { rest: string; featured: string[] } {
  const featured: string[] = []
  let rest = text
  let guard = 0
  while (guard++ < 5) {
    const m = new RegExp(FEAT_RE.source, 'i').exec(rest)
    if (!m || m[1] === undefined) break
    for (const n of splitArtistString(m[1])) featured.push(n)
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)
  }
  return { rest, featured }
}

/** Try every remix form. Returns the remixer when one was named. */
function extractRemix(text: string): { rest: string; found: boolean; remixer?: string } {
  for (const re of REMIX_PATTERNS) {
    const local = new RegExp(re.source, 'i')
    const m = local.exec(text)
    if (!m) continue
    const who = m[1]?.trim()
    const rest = text.replace(local, ' ')
    if (who) {
      const n = baseNormalize(who)
      if (n && n !== 'remix') return { rest, found: true, remixer: n }
    }
    return { rest, found: true }
  }
  return { rest: text, found: false }
}

/** Keep an annotation remnant only if it still holds a real content word. */
function hasContentWord(text: string): boolean {
  const words = baseNormalize(text).split(/\s+/).filter(Boolean)
  return words.some((w) => !RESIDUE.has(w) && !/^\d{1,4}$/.test(w))
}

export function normalizeTitle(rawTitle: string): NormalizedTitle {
  const raw = rawTitle
  const variants = new Set<VariantMarker>()
  let remixer: string | undefined

  const { core, annotations } = splitAnnotations(asciiFold(rawTitle))

  const coreFeat = extractFeatured(core)
  let workingCore = coreFeat.rest
  const featured = [...coreFeat.featured]

  const keptAnnotations: string[] = []

  for (const annotationRaw of annotations) {
    let ann = annotationRaw
    let annotationIsDescriptive = false

    const af = extractFeatured(ann)
    ann = af.rest
    featured.push(...af.featured)
    if (af.featured.length > 0) annotationIsDescriptive = true

    // Remix before noise — "remix" must not be eaten by an "original mix" strip.
    const rx = extractRemix(ann)
    if (rx.found) {
      variants.add('REMIX')
      if (!remixer && rx.remixer) remixer = rx.remixer
      ann = rx.rest
      annotationIsDescriptive = true
    }

    ann = stripNoise(ann)

    // In an annotation the bare marker is reliable — that is what annotations are for.
    for (const { marker, loose } of VARIANT_PATTERNS) {
      const local = new RegExp(loose.source, 'gi')
      if (local.test(ann)) {
        variants.add(marker)
        ann = ann.replace(new RegExp(loose.source, 'gi'), ' ')
        annotationIsDescriptive = true
      }
    }

    // An annotation that described the recording is consumed whole. "(Live Aid)" and
    // "(Acoustic Session)" are descriptions, and their leftovers are not title content.
    if (annotationIsDescriptive) continue

    if (hasContentWord(ann)) keptAnnotations.push(ann.trim())
  }

  // ── Same passes over the core, with the STRICT variant forms.
  const rxCore = extractRemix(workingCore)
  if (rxCore.found) {
    variants.add('REMIX')
    if (!remixer && rxCore.remixer) remixer = rxCore.remixer
    workingCore = rxCore.rest
  }

  workingCore = stripNoise(workingCore)

  for (const { marker, loose, strict } of VARIANT_PATTERNS) {
    // No strict form means the word is unambiguous enough to trust anywhere.
    const pattern = strict ?? loose
    const local = new RegExp(pattern.source, 'gi')
    if (local.test(workingCore)) {
      variants.add(marker)
      workingCore = workingCore.replace(new RegExp(pattern.source, 'gi'), ' ')
    }
  }

  // Leading track numbers from pasted tracklists: "1. ", "01 - ", "1) "
  workingCore = workingCore.replace(/^\s*\d{1,3}\s*[.)\-–—]\s*/, '')

  let norm = baseNormalize([workingCore, ...keptAnnotations].join(' '))

  // If stripping left nothing, the annotation WAS the title ("Live" by Erasure).
  if (!norm) {
    const fallback = splitAnnotations(asciiFold(rawTitle))
    norm = baseNormalize(fallback.core) || baseNormalize(rawTitle)
  }

  return {
    norm,
    variants: [...variants].sort(),
    ...(remixer ? { remixer } : {}),
    featured: [...new Set(featured)],
    raw,
  }
}

/** Split a multi-artist credit string into an ordered, normalized list. */
export function splitArtistString(input: string): string[] {
  const folded = asciiFold(input)
  return folded
    .split(ARTIST_SPLIT_RE)
    .map((a) => baseNormalize(a))
    .filter((a) => a.length > 0)
}

export function normalizeArtist(rawArtist: string | string[]): NormalizedArtist {
  const raw = Array.isArray(rawArtist) ? rawArtist.join(', ') : rawArtist
  const artists = Array.isArray(rawArtist)
    ? rawArtist.flatMap((a) => splitArtistString(a))
    : splitArtistString(rawArtist)

  const unique = [...new Set(artists)]
  return {
    norm: unique[0] ?? '',
    artists: unique,
    normAll: [...unique].sort().join(' '),
    raw,
  }
}

/**
 * Convenience: normalize a whole track in one call, folding any title-embedded
 * "feat." artists into the artist list where they belong.
 */
export function normalizeTrack(input: { title: string; artists: string | string[] }): {
  title: NormalizedTitle
  artist: NormalizedArtist
} {
  const title = normalizeTitle(input.title)
  const baseArtist = normalizeArtist(input.artists)

  const merged = [...new Set([...baseArtist.artists, ...title.featured])]
  return {
    title,
    artist: {
      norm: baseArtist.norm || (merged[0] ?? ''),
      artists: merged,
      normAll: [...merged].sort().join(' '),
      raw: baseArtist.raw,
    },
  }
}
