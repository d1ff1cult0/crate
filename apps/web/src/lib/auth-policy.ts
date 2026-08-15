export function canBootstrapOwner(userCount: number): boolean {
  return userCount === 0
}

/** Accept only local absolute paths and keep auth pages from becoming redirect loops. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  const path = value.split(/[?#]/, 1)[0]
  if (path === '/auth/sign-in' || path === '/auth/sign-up') return '/'
  return value
}
