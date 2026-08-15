import { YouTubePlaylistImport } from '../../../components/youtube-playlist-import'
import { requireSession } from '../../../lib/session'

export const dynamic = 'force-dynamic'

export default async function YouTubePlaylistPage() {
  await requireSession('/import/youtube')
  return <div className="mx-auto max-w-5xl space-y-6 pb-20">
    <header>
      <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">YouTube playlist import</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">
        Turn an ordered YouTube music playlist into durable library tracks and one Navidrome-compatible Crate playlist.
      </p>
    </header>
    <YouTubePlaylistImport initialRuns={[]} />
  </div>
}
