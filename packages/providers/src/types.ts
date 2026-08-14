/**
 * The download provider interface. PROMPT.md §7.5.
 *
 * One interface, several adapters, ordered by priority, each with independent
 * concurrency and rate limits so one provider being throttled cannot stall the rest.
 *
 * Every adapter is optional and the app must work with only the last one enabled — so
 * nothing outside this package may assume a specific provider exists.
 */

export interface TrackQuery {
  title: string
  artists: string[]
  album?: string | undefined
  durationMs?: number | undefined
  isrc?: string | undefined
  year?: number | undefined
}

export interface Candidate {
  /** Provider-specific handle used to fetch it. */
  id: string
  title: string
  artist: string
  album?: string | undefined
  durationMs?: number | undefined
  format?: string | undefined
  bitrate?: number | undefined
  /** Free-form provider detail, logged verbatim on every attempt (§7.5). */
  detail?: Record<string, unknown> | undefined
  /** Filled in by scoreCandidate; not set by the adapter. */
  score?: number
  scoreReasons?: string[]
}

export interface Progress {
  receivedBytes?: number
  totalBytes?: number
  percent?: number
  message?: string
}

export interface DownloadedFile {
  path: string
  format: string
  sizeBytes: number
  durationMs?: number
}

export interface HealthStatus {
  ok: boolean
  detail: string
}

export interface ProviderConfig {
  enabled: boolean
  priority: number
  concurrency: number
  rateLimit: { requests: number; per: number }
}

export interface DownloadProvider {
  readonly name: string
  readonly config: ProviderConfig
  /** True when the adapter has everything it needs (binaries, credentials). */
  health(): Promise<HealthStatus>
  search(query: TrackQuery): Promise<Candidate[]>
  download(
    candidate: Candidate,
    destinationDir: string,
    onProgress: (p: Progress) => void,
  ): Promise<DownloadedFile>
}

export type AttemptOutcome =
  | 'SUCCESS'
  | 'NO_RESULTS'
  | 'REJECTED_QUALITY'
  | 'ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
