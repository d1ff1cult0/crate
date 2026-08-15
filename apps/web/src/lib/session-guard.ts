export type SessionResult = { user: { id: string }; session: { id: string } }
type SessionGetter<T extends SessionResult> = (headers: Headers) => Promise<T | null>

export async function apiSessionGuard<T extends SessionResult>(
  headers: Headers,
  getSession: SessionGetter<T>,
): Promise<T | Response> {
  const session = await getSession(headers)
  return session ?? Response.json({ error: 'Unauthorized' }, { status: 401 })
}
