'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { authClient } from '../lib/auth-client'
import { safeReturnTo } from '../lib/auth-policy'
import { Button } from './ui'

export function AuthForm({ returnTo = '/' }: { returnTo?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const destination = safeReturnTo(returnTo)
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password })
      if (result.error) {
        setError('The email or password is incorrect.')
        return
      }
      router.replace(destination)
      router.refresh()
    } catch {
      setError('Authentication is temporarily unavailable. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block space-y-1.5">
        <span className="label">Email</span>
        <input required type="email" maxLength={254} autoComplete="email" value={email}
          onChange={(event) => setEmail(event.target.value)} className="data w-full rounded-[4px] border border-hairline bg-surface px-3 py-2 text-sm text-ink" />
      </label>
      <label className="block space-y-1.5">
        <span className="label">Password</span>
        <input required type="password" minLength={12} maxLength={128}
          autoComplete="current-password" value={password}
          onChange={(event) => setPassword(event.target.value)} className="data w-full rounded-[4px] border border-hairline bg-surface px-3 py-2 text-sm text-ink" />
      </label>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      <Button variant="primary" disabled={busy}>
        {busy ? 'Please wait…' : 'Sign in'}
      </Button>
    </form>
  )
}
