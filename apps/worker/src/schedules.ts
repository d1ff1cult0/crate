/**
 * Scheduled jobs — PROMPT.md §7.10. Every interval is configurable and every job has a
 * manual "run now" from the UI.
 *
 * BullMQ repeatable jobs are keyed by name + pattern, so re-registering on every boot
 * is idempotent rather than duplicating.
 */

import { getQueue, type QueueName } from './lib/queues.js'

interface Schedule {
  queue: QueueName
  name: string
  cron: string
  data?: Record<string, unknown>
  description: string
}

export const SCHEDULES: Schedule[] = [
  {
    queue: 'spotify-sync',
    name: 'sync',
    cron: '0 * * * *',
    description: 'Hourly: own playlists, skipping any whose snapshot_id is unchanged',
  },
  {
    queue: 'library-scan',
    name: 'nightly-scan',
    cron: '0 3 * * *',
    data: { full: false },
    description: 'Nightly incremental library scan',
  },
  {
    queue: 'library-scan',
    name: 'weekly-full-reconcile',
    cron: '0 4 * * 0',
    data: { full: true },
    description: 'Weekly full reconcile, catching anything the incremental scan missed',
  },
  {
    queue: 'fingerprint',
    name: 'fingerprint-sweep',
    cron: '30 * * * *',
    description: 'Hourly batch of outstanding fingerprints, throttled and resumable',
  },
  {
    queue: 'recommend',
    name: 'generate-mixes',
    cron: '0 5 * * *',
    description: 'Daily 05:00: regenerate the six mixes and write playlists',
  },
  {
    queue: 'recommend',
    name: 'release-radar',
    cron: '0 6 * * 1',
    description: 'Weekly: new releases from high-affinity artists via MusicBrainz',
  },
  {
    queue: 'maintenance',
    name: 'trash-retention',
    cron: '0 2 * * *',
    description: 'Daily: purge trash older than N days, only when explicitly enabled',
  },
  {
    queue: 'maintenance',
    name: 'dedupe-scan',
    cron: '0 1 * * 6',
    description: 'Weekly: populate duplicate groups. Never auto-deletes.',
  },
]

export async function registerSchedules(): Promise<void> {
  for (const s of SCHEDULES) {
    await getQueue(s.queue).add(s.name, s.data ?? {}, {
      repeat: { pattern: s.cron },
      jobId: `schedule:${s.name}`,
    })
  }
}

export async function clearSchedules(): Promise<void> {
  for (const s of SCHEDULES) {
    const queue = getQueue(s.queue)
    const repeatables = await queue.getRepeatableJobs()
    for (const r of repeatables) {
      if (r.name === s.name) await queue.removeRepeatableByKey(r.key)
    }
  }
}
