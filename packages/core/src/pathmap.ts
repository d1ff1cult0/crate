/**
 * Path mapping. PROMPT.md §5 — "get this right or nothing works".
 *
 * The path this app sees is not the path Navidrome sees. Every path written into an
 * m3u, or sent to the Subsonic API, goes through here.
 *
 * Two deliberate choices (docs/DECISIONS.md A7):
 *   - Longest appPath wins, so nested mappings behave predictably.
 *   - A path matching NO mapping is returned with `mapped: false` rather than passed
 *     through silently. Silent pass-through is exactly how this fails in production:
 *     everything looks fine until Navidrome shows an empty playlist.
 */

export interface PathMapping {
  appPath: string
  navidromePath: string
}

export interface MappedPath {
  path: string
  mapped: boolean
  /** Which mapping was applied, for the diagnostic to report. */
  via?: PathMapping
}

function stripTrailingSep(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Normalize separators and collapse `//`, without resolving symlinks or `..`. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

function isUnder(child: string, parent: string): boolean {
  const c = normalizePath(child)
  const p = stripTrailingSep(normalizePath(parent))
  return c === p || c.startsWith(p + '/')
}

/** Sort longest-first so the most specific mapping wins. */
export function orderMappings(mappings: PathMapping[]): PathMapping[] {
  return [...mappings].sort(
    (a, b) => normalizePath(b.appPath).length - normalizePath(a.appPath).length,
  )
}

/** app path → the path Navidrome will see. */
export function toNavidromePath(appPath: string, mappings: PathMapping[]): MappedPath {
  const p = normalizePath(appPath)
  for (const m of orderMappings(mappings)) {
    if (isUnder(p, m.appPath)) {
      const rest = p.slice(stripTrailingSep(normalizePath(m.appPath)).length)
      return {
        path: normalizePath(stripTrailingSep(normalizePath(m.navidromePath)) + rest),
        mapped: true,
        via: m,
      }
    }
  }
  return { path: p, mapped: false }
}

/** Navidrome path → the path this app can open. The inverse, for reading back. */
export function toAppPath(navidromePath: string, mappings: PathMapping[]): MappedPath {
  const p = normalizePath(navidromePath)
  const byNavLength = [...mappings].sort(
    (a, b) => normalizePath(b.navidromePath).length - normalizePath(a.navidromePath).length,
  )
  for (const m of byNavLength) {
    if (isUnder(p, m.navidromePath)) {
      const rest = p.slice(stripTrailingSep(normalizePath(m.navidromePath)).length)
      return {
        path: normalizePath(stripTrailingSep(normalizePath(m.appPath)) + rest),
        mapped: true,
        via: m,
      }
    }
  }
  return { path: p, mapped: false }
}

/**
 * Path relative to a root, for m3u entries. §7.9 defaults to relative paths because
 * they are the most reliable for Navidrome. Returns null when the path is outside the
 * root, which is a real error the caller must surface rather than paper over.
 */
export function relativeToRoot(absPath: string, root: string): string | null {
  const p = normalizePath(absPath)
  const r = stripTrailingSep(normalizePath(root))
  if (!isUnder(p, r)) return null
  return p.slice(r.length).replace(/^\//, '')
}

export type MappingProblem =
  | { kind: 'NO_MAPPINGS'; message: string }
  | { kind: 'UNMAPPED_PATH'; message: string; path: string }
  | { kind: 'OVERLAPPING'; message: string; a: PathMapping; b: PathMapping }
  | { kind: 'EMPTY_SEGMENT'; message: string; mapping: PathMapping }

/**
 * Static validation of a mapping set. Runs before the live probe in the "Verify paths"
 * diagnostic so obvious misconfiguration is reported instantly rather than after a
 * Navidrome scan round trip.
 */
export function validateMappings(
  mappings: PathMapping[],
  sampleAppPath?: string,
): MappingProblem[] {
  const problems: MappingProblem[] = []

  if (mappings.length === 0) {
    problems.push({
      kind: 'NO_MAPPINGS',
      message:
        'No path mappings configured. Playlists will be written with this app\'s own paths, which Navidrome almost certainly cannot resolve.',
    })
    return problems
  }

  for (const m of mappings) {
    if (!m.appPath.trim() || !m.navidromePath.trim()) {
      problems.push({
        kind: 'EMPTY_SEGMENT',
        message: `Mapping has an empty side: appPath="${m.appPath}" navidromePath="${m.navidromePath}".`,
        mapping: m,
      })
    }
  }

  // Overlapping appPaths are legal (longest wins) but worth reporting, since an
  // accidental overlap silently reroutes a subtree.
  const ordered = orderMappings(mappings)
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!
      const b = ordered[j]!
      if (isUnder(a.appPath, b.appPath)) {
        problems.push({
          kind: 'OVERLAPPING',
          message: `"${a.appPath}" sits inside "${b.appPath}". The more specific mapping wins — confirm that is what you want.`,
          a,
          b,
        })
      }
    }
  }

  if (sampleAppPath) {
    const res = toNavidromePath(sampleAppPath, mappings)
    if (!res.mapped) {
      problems.push({
        kind: 'UNMAPPED_PATH',
        message: `"${sampleAppPath}" matches none of the configured mappings, so it would be written unchanged. Add a mapping whose appPath is a prefix of it.`,
        path: sampleAppPath,
      })
    }
  }

  return problems
}
