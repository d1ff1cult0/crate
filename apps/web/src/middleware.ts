import { NextResponse, type NextRequest } from 'next/server'

// Optimistic navigation only. Every page and API validates the database-backed session.
export function middleware(request: NextRequest) {
  const hasSessionCookie = request.cookies.has('crate.session_token')
    || request.cookies.has('__Secure-crate.session_token')
  if (hasSessionCookie) return NextResponse.next()
  const signIn = new URL('/auth/sign-in', request.url)
  signIn.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(signIn)
}

export const config = {
  matcher: ['/((?!api|auth|_next/static|_next/image|favicon.ico|robots.txt).*)'],
}
