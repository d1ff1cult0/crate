import { describe, expect, it } from 'vitest'
import { pathVerificationState, type PathMapping } from '../src/lib/setup-state'

/**
 * The bug this covers: "Verify paths" reported every step green in Settings, and the
 * setup wizard went on showing the step as outstanding forever, because nothing wrote
 * the result down.
 */

const MAPPINGS: PathMapping[] = [{ appPath: '/music', navidromePath: '/music' }]

describe('pathVerificationState', () => {
  it('is "never" when the diagnostic has not run', () => {
    expect(pathVerificationState(null, MAPPINGS)).toEqual({ status: 'never' })
    expect(pathVerificationState(undefined, MAPPINGS)).toEqual({ status: 'never' })
  })

  it('is "verified" after a pass over the mappings currently configured', () => {
    const state = pathVerificationState(
      { ok: true, at: '2026-08-14T10:00:00.000Z', mappings: MAPPINGS },
      MAPPINGS,
    )
    expect(state.status).toBe('verified')
    expect(state).toHaveProperty('at')
  })

  it('is "failed" when the last run did not pass', () => {
    const state = pathVerificationState(
      { ok: false, at: '2026-08-14T10:00:00.000Z', mappings: MAPPINGS },
      MAPPINGS,
    )
    expect(state.status).toBe('failed')
  })

  it('goes "stale" when a mapping is edited after a pass', () => {
    // The important one. A pass vouches for the configuration it tested and nothing
    // else — inheriting it across an edit would claim something untrue about the single
    // setting most likely to be silently wrong.
    const state = pathVerificationState(
      { ok: true, at: '2026-08-14T10:00:00.000Z', mappings: MAPPINGS },
      [{ appPath: '/music', navidromePath: '/data/music' }],
    )
    expect(state.status).toBe('stale')
  })

  it('goes stale when a mapping is added', () => {
    const state = pathVerificationState(
      { ok: true, at: '2026-08-14T10:00:00.000Z', mappings: MAPPINGS },
      [...MAPPINGS, { appPath: '/extra', navidromePath: '/extra' }],
    )
    expect(state.status).toBe('stale')
  })

  it('goes stale when a mapping is removed', () => {
    const state = pathVerificationState(
      {
        ok: true,
        at: '2026-08-14T10:00:00.000Z',
        mappings: [...MAPPINGS, { appPath: '/extra', navidromePath: '/extra' }],
      },
      MAPPINGS,
    )
    expect(state.status).toBe('stale')
  })

  it('stays verified when the mappings are merely reordered', () => {
    // Order carries no meaning — longest-prefix wins at lookup time — so reordering
    // must not invalidate a genuine pass.
    const a: PathMapping = { appPath: '/music', navidromePath: '/music' }
    const b: PathMapping = { appPath: '/extra', navidromePath: '/extra' }
    const state = pathVerificationState(
      { ok: true, at: '2026-08-14T10:00:00.000Z', mappings: [a, b] },
      [b, a],
    )
    expect(state.status).toBe('verified')
  })

  it('treats a record with no mappings and none configured as verified', () => {
    const state = pathVerificationState({ ok: true, at: '2026-08-14T10:00:00.000Z', mappings: [] }, [])
    expect(state.status).toBe('verified')
  })

  it('falls back to "never" on a corrupt record rather than throwing', () => {
    expect(pathVerificationState({ ok: true, at: 'not-a-date', mappings: [] }, []).status).toBe('never')
    expect(pathVerificationState({ nonsense: true }, []).status).toBe('never')
    expect(pathVerificationState('a string', []).status).toBe('never')
  })
})
