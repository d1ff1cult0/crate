/**
 * The jobs the UI is allowed to start. §7.10: "all with a manual 'run now'."
 *
 * An allow-list rather than free-form queue + name, so the UI cannot be talked into
 * enqueueing something that has no worker — a job with no consumer sits in Redis forever
 * and looks, from the UI, exactly like a job that is taking a long time.
 *
 * Nothing here moves or deletes a file. Applying a dedupe batch stays on the Duplicates
 * screen behind its plan, which is the entire point of the plan.
 *
 * This lives in `lib` rather than beside the route handler because a Next.js route file
 * may only export HTTP methods and a fixed set of config fields — any other export fails
 * the production build.
 */

import type { QueueName } from './queue'

export interface RunnableJob {
  queue: QueueName
  name: string
  data?: Record<string, unknown>
  /** Shown back to the user so a button press has a readable consequence. */
  description: string
}

export const RUNNABLE: Record<string, RunnableJob> = {
  'library-scan': {
    queue: 'library-scan',
    name: 'scan',
    description: 'Scanning the library for new and changed files',
  },
  'library-scan-full': {
    queue: 'library-scan',
    name: 'full-reconcile',
    data: { full: true },
    description: 'Full reconcile — every file re-read, not just changed ones',
  },
  'match-sweep': {
    queue: 'match',
    name: 'match-sweep',
    description: 'Re-matching everything still missing or low-confidence',
  },
  'fingerprint-sweep': {
    queue: 'fingerprint',
    name: 'fingerprint-sweep',
    description: 'Fingerprinting outstanding files and backfilling ISRC/MBID',
  },
  'spotify-sync': {
    queue: 'spotify-sync',
    name: 'sync',
    description: 'Syncing Spotify playlists that have changed',
  },
  'dedupe-scan': {
    queue: 'maintenance',
    name: 'dedupe-scan',
    description: 'Grouping duplicates. Nothing is moved — this only builds the groups',
  },
  'trash-retention': {
    queue: 'maintenance',
    name: 'trash-retention',
    description: 'Purging trash older than the retention window, if retention is on',
  },
  'navidrome-scan': {
    queue: 'maintenance',
    name: 'navidrome-scan',
    description: 'Asking Navidrome to rescan',
  },
  'taste-refresh': {
    queue: 'recommend',
    name: 'taste-refresh',
    description: 'Pulling play counts and scrobbles in, then recomputing affinity',
  },
  'generate-mixes': {
    queue: 'recommend',
    name: 'generate-mixes',
    description: 'Rebuilding the artist graph and regenerating every mix',
  },
  'release-radar': {
    queue: 'recommend',
    name: 'release-radar',
    description: 'Checking MusicBrainz for new releases by artists you play',
  },
  'download-missing': {
    queue: 'download',
    name: 'enqueue-missing',
    description: 'Queueing a download for everything the matcher marked missing',
  },
  'download-retry-abandoned': {
    queue: 'download',
    name: 'enqueue-missing',
    data: { retryAbandoned: true },
    description: 'Retrying tracks no provider could find last time',
  },
  'playlists-write-all': {
    queue: 'playlist-write',
    name: 'write-all',
    description: 'Rewriting every auto-sync playlist, then one Navidrome scan',
  },
}

/** Backup file format version. Bumped when the shape changes incompatibly. */
export const BACKUP_FORMAT = 1
