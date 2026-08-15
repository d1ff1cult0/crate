import { prisma } from '@crate/db'
import { YouTubePlaylistImport } from '../../../components/youtube-playlist-import'

export const dynamic = 'force-dynamic'

export default async function YouTubePlaylistPage() {
  const runs = await prisma.importRun.findMany({
    where: { kind: 'YOUTUBE_PLAYLIST' }, orderBy: { createdAt: 'desc' }, take: 25,
  })
  return <div className="mx-auto max-w-5xl space-y-6 pb-20">
    <header>
      <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">YouTube playlist import</h1>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">
        Turn an ordered YouTube music playlist into durable library tracks and one Navidrome-compatible Crate playlist.
      </p>
    </header>
    <YouTubePlaylistImport initialRuns={runs.map((run) => ({
      id: run.id,
      status: run.status as 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED',
      input: run.input,
      playlistName: run.playlistName,
      tracksFound: run.tracksFound,
      tracksNew: run.tracksNew,
      tracksDuplicate: run.tracksDuplicate,
      tracksAvailable: run.tracksAvailable,
      tracksSucceeded: run.tracksSucceeded,
      tracksFailed: run.tracksFailed,
      message: run.message,
      detailJson: run.detailJson as { invalidEntries?: number; errors?: string[] } | null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      progress: run.status === 'SUCCEEDED' ? 100 : 0,
      error: null,
    }))} />
  </div>
}
