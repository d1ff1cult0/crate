export function resolveAuthSecret(
  env: Partial<Record<'BETTER_AUTH_SECRET' | 'CRATE_SESSION_SECRET' | 'NODE_ENV', string>> = process.env,
): string | undefined {
  const secret = env.BETTER_AUTH_SECRET ?? env.CRATE_SESSION_SECRET
  if (secret) return secret
  if (env.NODE_ENV === 'development') return undefined

  throw new Error('CRATE_SESSION_SECRET is required outside development')
}
