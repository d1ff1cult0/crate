import { describe, expect, it, vi } from 'vitest'
import type { SubsonicClient } from '../src/subsonic/client.js'
import { verifyPaths } from '../src/subsonic/verify-paths.js'

const MAPPINGS = [{ appPath: '/music', navidromePath: '/data/media' }]

function makeSubsonic(over: Partial<Record<string, unknown>> = {}): SubsonicClient {
  return {
    async ping() {
      return { ok: true, serverVersion: '0.53', type: 'navidrome' }
    },
    async startScan() {},
    async getScanStatus() {
      return { scanning: false }
    },
    async getPlaylists() {
      return [{ id: 'pl1', name: 'crate-path-probe', songCount: 1 }]
    },
    async deletePlaylist() {},
    ...over,
  } as unknown as SubsonicClient
}

const baseInput = {
  mappings: MAPPINGS,
  musicRoot: '/music',
  sampleFilePath: '/music/Radiohead/OK Computer/01 Airbag.flac',
  writeProbe: async (rel: string) => `/music/${rel}`,
  sleep: async () => {},
}

describe('verifyPaths', () => {
  it('passes end to end on a correct configuration', async () => {
    const r = await verifyPaths({ ...baseInput, subsonic: makeSubsonic() })
    expect(r.ok).toBe(true)
    expect(r.steps.every((s) => s.status === 'ok' || s.status === 'warning')).toBe(true)
  })

  it('fails fast when no mappings are configured', async () => {
    const r = await verifyPaths({ ...baseInput, mappings: [], subsonic: makeSubsonic() })
    expect(r.ok).toBe(false)
    expect(r.steps[0]?.name).toBe('Path mapping configuration')
    expect(r.steps[0]?.remedy).toBeTruthy()
  })

  it('does not call Navidrome at all when the static checks fail', async () => {
    const ping = vi.fn()
    await verifyPaths({ ...baseInput, mappings: [], subsonic: makeSubsonic({ ping }) })
    expect(ping).not.toHaveBeenCalled()
  })

  it('reports an unreachable Navidrome with a container-aware remedy', async () => {
    const r = await verifyPaths({
      ...baseInput,
      subsonic: makeSubsonic({
        ping: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('Could not reach Navidrome')
    expect(r.steps.find((s) => s.name === 'Navidrome connection')?.remedy).toMatch(/Docker/)
  })

  it('skips the probe when there is no library file yet, and says why', async () => {
    const r = await verifyPaths({ ...baseInput, sampleFilePath: undefined, subsonic: makeSubsonic() })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/Scan the library first/)
    expect(r.steps.find((s) => s.name === 'Path translation')?.status).toBe('skipped')
  })

  it('identifies an unmapped library path in the static check, before any network call', async () => {
    const ping = vi.fn()
    const r = await verifyPaths({
      ...baseInput,
      sampleFilePath: '/srv/other/a.flac',
      subsonic: makeSubsonic({ ping }),
    })
    expect(r.ok).toBe(false)
    // Caught statically, so it never reaches Navidrome — and the message names the path.
    expect(ping).not.toHaveBeenCalled()
    expect(r.steps.some((s) => s.detail.includes('/srv/other/a.flac'))).toBe(true)
  })

  // ── The two failure modes worth distinguishing ─────────────
  it('distinguishes "Navidrome never saw the playlist" — wrong directory', async () => {
    const r = await verifyPaths({
      ...baseInput,
      subsonic: makeSubsonic({ getPlaylists: async () => [] }),
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/different directories/)
    expect(r.steps.find((s) => s.name === 'Probe resolved')?.remedy).toMatch(/mounted as its music library/)
  })

  it('distinguishes "playlist found but track unresolved" — wrong navidromePath side', async () => {
    const r = await verifyPaths({
      ...baseInput,
      subsonic: makeSubsonic({
        getPlaylists: async () => [{ id: 'pl1', name: 'crate-path-probe', songCount: 0 }],
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/navidromePath side of the mapping is wrong/)
  })

  it('reports a read-only music root rather than failing obscurely', async () => {
    const r = await verifyPaths({
      ...baseInput,
      writeProbe: async () => {
        throw new Error('EACCES: permission denied')
      },
      subsonic: makeSubsonic(),
    })
    expect(r.ok).toBe(false)
    expect(r.steps.find((s) => s.name === 'Probe playlist written')?.remedy).toMatch(/read-write/)
  })

  it('cleans up the probe playlist even when the check fails', async () => {
    const deletePlaylist = vi.fn()
    const deleteProbe = vi.fn(async () => {})
    await verifyPaths({
      ...baseInput,
      deleteProbe,
      subsonic: makeSubsonic({
        getPlaylists: async () => [{ id: 'pl1', name: 'crate-path-probe', songCount: 0 }],
        deletePlaylist,
      }),
    })
    expect(deleteProbe).toHaveBeenCalled()
    expect(deletePlaylist).toHaveBeenCalledWith('pl1')
  })

  it('warns rather than fails when the scan is still running', async () => {
    const r = await verifyPaths({
      ...baseInput,
      maxPollMs: 10,
      pollIntervalMs: 1,
      subsonic: makeSubsonic({ getScanStatus: async () => ({ scanning: true }) }),
    })
    expect(r.steps.find((s) => s.name === 'Navidrome scan')?.status).toBe('warning')
    expect(r.ok).toBe(true)
  })

  it('writes the probe entry as a relative path', async () => {
    let written = ''
    await verifyPaths({
      ...baseInput,
      writeProbe: async (rel, content) => {
        written = content
        return `/music/${rel}`
      },
      subsonic: makeSubsonic(),
    })
    expect(written).toContain('Radiohead/OK Computer/01 Airbag.flac')
    expect(written).not.toContain('/data/media')
    expect(written.startsWith('#EXTM3U')).toBe(true)
  })
})
