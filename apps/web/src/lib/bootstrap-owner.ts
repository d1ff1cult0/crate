import { prisma } from '@crate/db'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { betterAuth } from 'better-auth/minimal'
import { canBootstrapOwner } from './auth-policy'
import { resolveAuthSecret } from './auth-secret'

export interface BootstrapOwnerInput {
  email: string
  name: string
  password: string
}

export interface BootstrapOwnerDependencies {
  countOwners: () => Promise<number>
  createCredentialUser: (input: BootstrapOwnerInput) => Promise<unknown>
}

export async function bootstrapOwner(
  input: BootstrapOwnerInput,
  dependencies: BootstrapOwnerDependencies,
): Promise<void> {
  if (!canBootstrapOwner(await dependencies.countOwners())) {
    throw new Error('An owner account already exists; bootstrap is permanently disabled.')
  }
  await dependencies.createCredentialUser(input)
}

export async function createOwnerWithBetterAuth(input: BootstrapOwnerInput): Promise<void> {
  // This CLI-only instance is never mounted by Next.js or exported from an HTTP route.
  const bootstrapAuth = betterAuth({
    appName: 'Crate',
    baseURL: 'http://localhost',
    secret: resolveAuthSecret(),
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' && !canBootstrapOwner(await prisma.user.count())) {
          throw new APIError('BAD_REQUEST', { message: 'An owner account already exists' })
        }
      }),
    },
  })
  await bootstrapAuth.api.signUpEmail({ body: input })
}
