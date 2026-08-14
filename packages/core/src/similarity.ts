/**
 * String similarity primitives. No dependencies — these are hot paths run across the
 * whole library, and they need to be testable in isolation.
 */

/** Levenshtein distance, O(n*m) time, O(min(n,m)) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Keep the shorter string as the row so the buffer is min(n,m).
  if (a.length > b.length) [a, b] = [b, a]

  let prev = new Array<number>(a.length + 1)
  let curr = new Array<number>(a.length + 1)
  for (let i = 0; i <= a.length; i++) prev[i] = i

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j
    const bj = b.charCodeAt(j - 1)
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1
      curr[i] = Math.min(
        (curr[i - 1] ?? 0) + 1,
        (prev[i] ?? 0) + 1,
        (prev[i - 1] ?? 0) + cost,
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[a.length] ?? 0
}

/** Normalized edit similarity in [0,1]. */
export function ratio(a: string, b: string): number {
  if (!a && !b) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

function tokens(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}

/**
 * Token-set ratio — §7.3 cascade tier 5 uses this at ≥ 0.85 for artists.
 *
 * Compares the shared tokens against each side's remainder, so it is insensitive to
 * word order and to one side carrying extra credited artists. "radiohead" vs
 * "radiohead thom yorke" scores high; "radiohead" vs "coldplay" scores ~0.
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 && tb.size === 0) return 1
  if (ta.size === 0 || tb.size === 0) return 0

  const intersection = [...ta].filter((t) => tb.has(t)).sort()
  const restA = [...ta].filter((t) => !tb.has(t)).sort()
  const restB = [...tb].filter((t) => !ta.has(t)).sort()

  const sorted = intersection.join(' ')
  const combinedA = [sorted, ...restA].join(' ').trim()
  const combinedB = [sorted, ...restB].join(' ').trim()

  return Math.max(
    ratio(sorted, combinedA),
    ratio(sorted, combinedB),
    ratio(combinedA, combinedB),
  )
}

/** Jaccard overlap of token sets. Cheap pre-filter before the costlier ratios. */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 && tb.size === 0) return 1
  const inter = [...ta].filter((t) => tb.has(t)).length
  const union = new Set([...ta, ...tb]).size
  return union === 0 ? 0 : inter / union
}
