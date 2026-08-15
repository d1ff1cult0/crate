function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

/** Artifact identity is deliberately independent of mutable/colliding display names. */
export function stablePlaylistBasename(_displayName: string, stableId: string): string {
  return `crate-playlist-${stableHash(stableId)}`
}

export interface YouTubeImportFacts {
  expected: number
  m3uEntries: number
  mappingOmissions: number
  outstanding: number
  failed: number
  invalidEntries: number
  navidromeSync: 'ok' | 'failed' | 'disabled'
}

export function deriveYouTubeImportStatus(facts: YouTubeImportFacts): { status: 'RUNNING' | 'SUCCEEDED' | 'PARTIAL'; message: string } {
  if (facts.outstanding > 0) return { status: 'RUNNING', message: `${facts.m3uEntries} of ${facts.expected} tracks are written; ${facts.outstanding} still queued or running.` }
  const omitted = Math.max(facts.mappingOmissions, facts.expected - facts.m3uEntries)
  const problems = facts.failed + facts.invalidEntries + omitted + (facts.navidromeSync === 'failed' ? 1 : 0)
  if (problems > 0) {
    const reasons = [
      omitted > 0 ? `${omitted} missing from the m3u (check path mappings)` : null,
      facts.failed + facts.invalidEntries > 0 ? `${facts.failed + facts.invalidEntries} track failures` : null,
      facts.navidromeSync === 'failed' ? 'Navidrome sync failed' : null,
    ].filter(Boolean).join('; ')
    return { status: 'PARTIAL', message: `${facts.m3uEntries} of ${facts.expected} tracks are written; ${reasons}.` }
  }
  return { status: 'SUCCEEDED', message: `All ${facts.expected} tracks are written and available.` }
}
