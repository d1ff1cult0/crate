export interface DownloadSourceMetadata {
  source: string
  title: string | null
  artists: string[]
  album: string | null
  rawJson: unknown
}

export interface CanonicalYouTubeEligibility {
  eligible: boolean
  error?: string
}

/**
 * YouTube playlist metadata is safe to download only after canonical YTM confirmation.
 * Other sources do not participate in this invariant.
 */
export function canonicalYouTubeEligibility(
  source: DownloadSourceMetadata,
): CanonicalYouTubeEligibility {
  if (source.source !== 'YOUTUBE') return { eligible: true }

  const missing: string[] = []
  if (!source.title?.trim()) missing.push('title')
  if (!source.artists.some((artist) => artist.trim().length > 0)) missing.push('artist')
  if (!source.album?.trim()) missing.push('album')

  const raw = source.rawJson && typeof source.rawJson === 'object' && !Array.isArray(source.rawJson)
    ? source.rawJson as Record<string, unknown>
    : null
  if (
    typeof raw?.crateCanonicalYtmVideoId !== 'string'
    || raw.crateCanonicalYtmVideoId.trim().length === 0
  ) {
    missing.push('rawJson.crateCanonicalYtmVideoId')
  }

  return missing.length === 0
    ? { eligible: true }
    : {
        eligible: false,
        error: `Canonical YouTube metadata required; missing or blank: ${missing.join(', ')}`,
      }
}
