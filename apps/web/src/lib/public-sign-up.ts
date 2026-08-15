import { APIError } from 'better-auth/api'

/** The Internet-facing auth handler must never be usable to provision an account. */
export function rejectPublicSignUp(path: string): void {
  if (path === '/sign-up/email') {
    throw new APIError('NOT_FOUND', { message: 'Not found' })
  }
}
