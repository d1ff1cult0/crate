import { describe, expect, it, vi } from 'vitest'
import { apiSessionGuard } from '../src/lib/session-guard'

describe('API session boundary', () => {
  it('returns a generic JSON 401 when the session is absent', async () => {
    const result = await apiSessionGuard(new Headers(), vi.fn().mockResolvedValue(null))
    expect(result).toBeInstanceOf(Response)
    const response = result as Response
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns the validated session when present', async () => {
    const session = { user: { id: 'owner' }, session: { id: 'session' } }
    expect(await apiSessionGuard(new Headers(), vi.fn().mockResolvedValue(session))).toBe(session)
  })
})
