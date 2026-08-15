import 'server-only'
import { prisma } from '@crate/db'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { createAuthMiddleware } from 'better-auth/api'
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal'
import { resolveAuthSecret } from './auth-secret'
import { rejectPublicSignUp } from './public-sign-up'

function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
}

const authOptions: BetterAuthOptions = {
  appName: 'Crate',
  baseURL: publicUrl(),
  secret: resolveAuthSecret(),
  trustedOrigins: [publicUrl()],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: false,
  },
  advanced: {
    useSecureCookies: publicUrl().startsWith('https://'),
    cookiePrefix: 'crate',
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      rejectPublicSignUp(ctx.path)
    }),
  },
}

export const auth: ReturnType<typeof betterAuth> = betterAuth(authOptions)
