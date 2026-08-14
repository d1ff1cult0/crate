import { EmptyState, Panel } from '../../components/ui'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Playlists
        </h1>
      </header>
      <Panel>
        <EmptyState title="Not built yet">
          Imported and generated playlists, coverage per playlist, and a fill-gaps action.
        </EmptyState>
      </Panel>
    </div>
  )
}
