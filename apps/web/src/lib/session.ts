import 'server-only'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from './auth'
import { safeReturnTo } from './auth-policy'
import { apiSessionGuard } from './session-guard'

export async function getServerSession() {
  return auth.api.getSession({ headers: await headers() })
}

export async function requireSession(returnTo = '/') {
  const session = await getServerSession()
  if (!session) redirect(`/auth/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`)
  return session
}

export async function requireApiSession(request: Request) {
  const result = await apiSessionGuard(request.headers, (requestHeaders) =>
    auth.api.getSession({ headers: requestHeaders }))
  if (result instanceof Response) return result

  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const expected = (process.env.PUBLIC_URL ?? new URL(request.url).origin).replace(/\/+$/, '')
    const origin = request.headers.get('origin')
    if (!origin || origin !== new URL(expected).origin) {
      return Response.json({ error: 'Invalid request origin' }, { status: 403 })
    }
  }
  return result
}

export function isUnauthorized(result: Awaited<ReturnType<typeof requireApiSession>>): result is Response {
  return result instanceof Response
}
