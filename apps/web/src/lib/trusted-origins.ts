type OriginEnvironment = Partial<Record<'PUBLIC_URL' | 'CRATE_TRUSTED_ORIGINS', string>>

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function trustedOrigins(env: OriginEnvironment = {
  PUBLIC_URL: process.env.PUBLIC_URL,
  CRATE_TRUSTED_ORIGINS: process.env.CRATE_TRUSTED_ORIGINS,
}): string[] {
  const configured = [
    env.PUBLIC_URL ?? 'http://localhost:3000',
    ...(env.CRATE_TRUSTED_ORIGINS ?? '').split(','),
  ]

  return [...new Set(configured.flatMap((value) => {
    const origin = normalizedOrigin(value.trim())
    return origin ? [origin] : []
  }))]
}

export function isTrustedMutationOrigin(origin: string | null, allowedOrigins = trustedOrigins()): boolean {
  if (!origin) return false
  const normalized = normalizedOrigin(origin)
  return normalized !== null && allowedOrigins.includes(normalized)
}
