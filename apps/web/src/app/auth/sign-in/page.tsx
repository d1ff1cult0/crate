import { redirect } from 'next/navigation'
import { AuthForm } from '../../../components/auth-form'
import { Panel } from '../../../components/ui'
import { safeReturnTo } from '../../../lib/auth-policy'
import { getServerSession } from '../../../lib/session'

export const dynamic = 'force-dynamic'

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  if (await getServerSession()) redirect('/')
  const { returnTo } = await searchParams
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center">
      <Panel>
        <div className="mb-6">
          <div className="label">Private library console</div>
          <h1 className="mt-2 font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">Sign in to Crate</h1>
        </div>
        <AuthForm returnTo={safeReturnTo(returnTo)} />
      </Panel>
    </div>
  )
}
