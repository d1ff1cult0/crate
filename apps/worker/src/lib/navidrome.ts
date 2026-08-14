/**
 * Debounced Navidrome rescan. PROMPT.md §7.6 step 7 and CLAUDE.md: "batch a burst of
 * downloads into one scan, never one per file."
 *
 * A trailing debounce, not a leading one. Twenty downloads finishing over two minutes
 * should produce ONE scan after the last of them, not one at the start that misses
 * nineteen files and leaves the library looking incomplete until the nightly run.
 *
 * BullMQ implements it: a delayed job with a fixed id, removed and re-added on each
 * request so the timer restarts. The fixed id also means a worker restart mid-window
 * cannot end up with two pending scans.
 */

import { prisma } from '@crate/db'
import { SubsonicClient } from '@crate/integrations'
import { decryptJson } from './crypto.js'
import type { JobRunContext } from './jobrun.js'
import { getQueue, jobId } from './queues.js'
import { loadSettings } from './settings.js'

export const SCAN_JOB_ID = jobId('navidrome', 'scan', 'debounced')

export interface NavidromeCredentials {
  baseUrl: string
  username: string
  password: string
}

/** The Navidrome connection, or null when it isn't configured. Never throws. */
export async function navidromeClient(): Promise<SubsonicClient | null> {
  const connection = await prisma.connection.findUnique({ where: { provider: 'navidrome' } })
  if (!connection?.enabled || !connection.secretCipher) return null
  try {
    return new SubsonicClient(decryptJson<NavidromeCredentials>(connection.secretCipher))
  } catch {
    return null
  }
}

/**
 * Ask for a scan "soon". Repeated calls inside the window collapse into one.
 *
 * Deliberately silent about a missing Navidrome connection: downloads must work with
 * every integration disconnected, and a warning per file would be noise.
 */
export async function requestNavidromeScan(delayMs?: number): Promise<void> {
  const settings = await loadSettings()
  const delay = delayMs ?? settings.navidromeScanDebounceMs
  const queue = getQueue('maintenance')

  // Restart the timer: remove the pending scan, if any, then re-add it.
  const pending = await queue.getJob(SCAN_JOB_ID)
  if (pending) {
    const state = await pending.getState()
    if (state === 'delayed' || state === 'waiting') await pending.remove().catch(() => undefined)
    // An already-running scan is left alone; the new job queues behind it.
  }

  await queue.add('navidrome-scan', {}, { delay, jobId: SCAN_JOB_ID })
}

export interface ScanTriggerResult {
  triggered: boolean
  detail: string
}

/** Fire the scan itself. Called by the maintenance queue when the debounce expires. */
export async function runNavidromeScan(ctx: JobRunContext): Promise<ScanTriggerResult> {
  const client = await navidromeClient()
  if (!client) {
    await ctx.log('info', 'No Navidrome connection configured — skipping the rescan')
    return { triggered: false, detail: 'not configured' }
  }

  try {
    await client.startScan()
    await ctx.log('info', 'Navidrome scan started')
    return { triggered: true, detail: 'started' }
  } catch (err) {
    // A rescan failure is not a job failure: the files are on disk and Navidrome's own
    // scheduled scan will find them.
    const detail = err instanceof Error ? err.message : String(err)
    await ctx.log('warn', 'Could not start a Navidrome scan; the files are on disk regardless', {
      error: detail,
    })
    return { triggered: false, detail }
  }
}
