import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { bootstrapOwner } from '../src/lib/bootstrap-owner'
import { canBootstrapOwner, safeReturnTo } from '../src/lib/auth-policy'
import { rejectPublicSignUp } from '../src/lib/public-sign-up'

describe('safeReturnTo', () => {
  it.each(['/library', '/queue?page=2', '/'])('accepts same-origin relative path %s', (value) => {
    expect(safeReturnTo(value)).toBe(value)
  })

  it.each([undefined, '', 'https://evil.example', '//evil.example/path', '/\\evil.example',
    'javascript:alert(1)', 'library', '/auth/sign-in', '/auth/sign-up'])
    ('rejects unsafe or looping return target %s', (value) => {
      expect(safeReturnTo(value)).toBe('/')
    })
})

describe('owner bootstrap policy', () => {
  it('allows bootstrap only while there are no users', () => {
    expect(canBootstrapOwner(0)).toBe(true)
    expect(canBootstrapOwner(1)).toBe(false)
    expect(canBootstrapOwner(2)).toBe(false)
  })

  it('creates only the first owner', async () => {
    let userCount = 0
    const created: string[] = []
    const dependencies = {
      countOwners: async () => userCount,
      createCredentialUser: async ({ email }: { email: string }) => {
        created.push(email)
        userCount++
      },
    }
    const input = { email: 'owner@example.com', name: 'Owner', password: 'long-secure-password' }

    await bootstrapOwner(input, dependencies)
    await expect(bootstrapOwner(input, dependencies)).rejects.toThrow('already exists')
    expect(created).toEqual(['owner@example.com'])
  })

  it('has a database uniqueness gate for concurrent first-user attempts', async () => {
    const migration = await readFile('../../packages/db/prisma/migrations/20260815182000_add_better_auth/migration.sql', 'utf8')
    expect(migration).toContain('CREATE UNIQUE INDEX "user_ownerKey_key"')
  })
})

describe('public signup exposure', () => {
  it('rejects Better Auth email signup unconditionally', () => {
    expect(() => rejectPublicSignUp('/sign-up/email')).toThrow('Not found')
    expect(() => rejectPublicSignUp('/sign-in/email')).not.toThrow()
  })

  it('also enables Better Auth\'s built-in signup disable switch', async () => {
    const authSource = await readFile('src/lib/auth.ts', 'utf8')
    expect(authSource).toContain('disableSignUp: true')
    expect(authSource).toContain('rejectPublicSignUp(ctx.path)')
  })

  it('does not ship a browser signup page', async () => {
    await expect(access('src/app/auth/sign-up/page.tsx')).rejects.toThrow()
    const signIn = await readFile('src/app/auth/sign-in/page.tsx', 'utf8')
    const form = await readFile('src/components/auth-form.tsx', 'utf8')
    expect(signIn).not.toContain('/auth/sign-up')
    expect(form).not.toContain('signUp')
  })
})
