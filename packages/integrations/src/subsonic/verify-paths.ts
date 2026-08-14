/**
 * "Verify paths" diagnostic — PROMPT.md §5.
 *
 * Writes a probe playlist, triggers a Navidrome scan, polls for completion, then checks
 * whether Navidrome actually resolved the entry. The point is not a pass/fail: it is to
 * report WHICH SEGMENT of the mapping is wrong, because "the playlist is empty" is the
 * single least informative error in this class of app.
 *
 * The static checks run first so obvious misconfiguration is reported instantly rather
 * than after a scan round trip.
 */

import {
  relativeToRoot,
  toNavidromePath,
  validateMappings,
  type PathMapping,
} from '@crate/core'
import type { SubsonicClient } from './client.js'

export type VerifyStepStatus = 'ok' | 'failed' | 'skipped' | 'warning'

export interface VerifyStep {
  name: string
  status: VerifyStepStatus
  detail: string
  /** What to actually do about it. Empty when the step passed. */
  remedy?: string
}

export interface VerifyResult {
  ok: boolean
  steps: VerifyStep[]
  /** The single most useful sentence, for the settings page headline. */
  summary: string
}

export interface VerifyPathsInput {
  subsonic: SubsonicClient
  mappings: PathMapping[]
  musicRoot: string
  /** A real file from the library — the probe is only meaningful with one. */
  sampleFilePath?: string | undefined
  /** Writes the probe playlist to disk. Injected so this stays testable. */
  writeProbe: (relativePath: string, content: string) => Promise<string>
  deleteProbe?: (absolutePath: string) => Promise<void>
  pollIntervalMs?: number
  maxPollMs?: number
  sleep?: (ms: number) => Promise<void>
}

const PROBE_NAME = 'crate-path-probe'

export async function verifyPaths(input: VerifyPathsInput): Promise<VerifyResult> {
  const steps: VerifyStep[] = []
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const push = (s: VerifyStep) => steps.push(s)

  const fail = (summary: string): VerifyResult => ({ ok: false, steps, summary })

  // ── 1. Static mapping validation ──────────────────────────
  const problems = validateMappings(input.mappings, input.sampleFilePath)
  const blocking = problems.filter((p) => p.kind !== 'OVERLAPPING')
  if (blocking.length > 0) {
    for (const p of blocking) {
      push({
        name: 'Path mapping configuration',
        status: 'failed',
        detail: p.message,
        remedy: 'Fix the mapping in Settings → Paths, then run this again.',
      })
    }
    return fail(blocking[0]!.message)
  }
  for (const p of problems) {
    push({ name: 'Path mapping configuration', status: 'warning', detail: p.message })
  }
  if (problems.length === 0) {
    push({
      name: 'Path mapping configuration',
      status: 'ok',
      detail: `${input.mappings.length} mapping(s) configured and internally consistent.`,
    })
  }

  // ── 2. Navidrome reachable ────────────────────────────────
  try {
    const ping = await input.subsonic.ping()
    if (!ping.ok) {
      push({
        name: 'Navidrome connection',
        status: 'failed',
        detail: 'Navidrome answered but reported a failure.',
        remedy: 'Check the username and password in Settings → Connections.',
      })
      return fail('Navidrome rejected the credentials.')
    }
    push({
      name: 'Navidrome connection',
      status: 'ok',
      detail: `Connected to ${ping.type ?? 'server'} ${ping.serverVersion ?? ''}`.trim(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    push({
      name: 'Navidrome connection',
      status: 'failed',
      detail: message,
      remedy: 'Check the base URL is reachable from this container. A URL that works in your browser may not resolve inside Docker.',
    })
    return fail(`Could not reach Navidrome: ${message}`)
  }

  // ── 3. Translate the sample path ──────────────────────────
  if (!input.sampleFilePath) {
    push({
      name: 'Path translation',
      status: 'skipped',
      detail: 'No library file available to probe with. Run a library scan first, then verify again.',
    })
    return { ok: false, steps, summary: 'Scan the library first — the probe needs a real file to test with.' }
  }

  const mapped = toNavidromePath(input.sampleFilePath, input.mappings)
  if (!mapped.mapped) {
    push({
      name: 'Path translation',
      status: 'failed',
      detail: `"${input.sampleFilePath}" matches none of the configured mappings.`,
      remedy: `Add a mapping whose appPath is a prefix of "${input.sampleFilePath}".`,
    })
    return fail('The library path matches no mapping, so Navidrome would never find these files.')
  }

  const mappedRoot = toNavidromePath(input.musicRoot, input.mappings)
  const relative = relativeToRoot(mapped.path, mappedRoot.path)
  if (relative === null) {
    push({
      name: 'Path translation',
      status: 'failed',
      detail: `The file maps to "${mapped.path}", which is outside the mapped music root "${mappedRoot.path}".`,
      remedy: 'The appPath and navidromePath sides of your mapping are inconsistent with MUSIC_ROOT. Check that MUSIC_ROOT sits inside the mapped appPath.',
    })
    return fail('The mapped file falls outside the mapped music root.')
  }

  push({
    name: 'Path translation',
    status: 'ok',
    detail: `${input.sampleFilePath} → ${mapped.path} (relative: ${relative})`,
  })

  // ── 4. Write the probe playlist ───────────────────────────
  const probeFile = `${PROBE_NAME}.m3u8`
  const content = `#EXTM3U\n#PLAYLIST:${PROBE_NAME}\n#EXTINF:-1,Crate - Path probe\n${relative}\n`
  let probeAbsolute: string
  try {
    probeAbsolute = await input.writeProbe(probeFile, content)
    push({
      name: 'Probe playlist written',
      status: 'ok',
      detail: `Wrote ${probeFile} into the music root with one relative entry.`,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    push({
      name: 'Probe playlist written',
      status: 'failed',
      detail: message,
      remedy: 'This app cannot write into MUSIC_ROOT. Check the volume mount is read-write.',
    })
    return fail(`Could not write into the music root: ${message}`)
  }

  // ── 5. Scan and poll ──────────────────────────────────────
  try {
    await input.subsonic.startScan()
    const deadline = Date.now() + (input.maxPollMs ?? 120_000)
    let scanning = true
    while (Date.now() < deadline) {
      await sleep(input.pollIntervalMs ?? 2000)
      const status = await input.subsonic.getScanStatus()
      if (!status.scanning) {
        scanning = false
        break
      }
    }
    if (scanning) {
      push({
        name: 'Navidrome scan',
        status: 'warning',
        detail: 'The scan was still running when the timeout elapsed; the check below may be premature.',
      })
    } else {
      push({ name: 'Navidrome scan', status: 'ok', detail: 'Scan completed.' })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    push({
      name: 'Navidrome scan',
      status: 'failed',
      detail: message,
      remedy: 'The account may lack permission to trigger a scan. In Navidrome this requires an admin user.',
    })
    return fail(`Could not trigger a Navidrome scan: ${message}`)
  }

  // ── 6. Did Navidrome resolve it? ──────────────────────────
  try {
    const playlists = await input.subsonic.getPlaylists()
    const probe = playlists.find((p) => p.name === PROBE_NAME)

    if (!probe) {
      push({
        name: 'Probe resolved',
        status: 'failed',
        detail: 'Navidrome scanned but never picked up the probe playlist.',
        remedy: `Navidrome is not reading the directory this app writes to. This app wrote to "${probeAbsolute}"; confirm that path is inside the folder Navidrome has mounted as its music library.`,
      })
      return fail('Navidrome did not see the probe playlist at all — the two containers are looking at different directories.')
    }

    if ((probe.songCount ?? 0) === 0) {
      push({
        name: 'Probe resolved',
        status: 'failed',
        detail: 'Navidrome found the playlist but could not resolve the track inside it.',
        remedy: `The playlist file is visible but its CONTENTS point somewhere Navidrome cannot follow. The entry was written as "${relative}", relative to "${mappedRoot.path}". Navidrome expects paths relative to its own music folder — adjust the navidromePath side of the mapping so those agree.`,
      })
      return fail('The playlist was found but its track did not resolve — the navidromePath side of the mapping is wrong.')
    }

    push({
      name: 'Probe resolved',
      status: 'ok',
      detail: `Navidrome resolved ${probe.songCount} track from the probe playlist.`,
    })
  } finally {
    // Always clean up, even when a check above failed.
    await input.deleteProbe?.(probeAbsolute).catch(() => undefined)
    try {
      const playlists = await input.subsonic.getPlaylists()
      const probe = playlists.find((p) => p.name === PROBE_NAME)
      if (probe) await input.subsonic.deletePlaylist(probe.id)
    } catch {
      /* cleanup is best-effort */
    }
  }

  return {
    ok: true,
    steps,
    summary: 'Path mapping is correct — Navidrome resolved a real file through the configured mapping.',
  }
}
