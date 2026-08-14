/**
 * Settings — connections, providers, paths, schedules, diagnostics (PROMPT.md §8).
 *
 * The path verification diagnostic is the most valuable thing on this page: §5 calls
 * path mapping "the single most common failure in this class of app", and the diagnostic
 * is what turns "the playlist is empty in Navidrome" into a specific, actionable answer.
 */

import { prisma } from '@crate/db'
import { BackupPanel } from '../../components/backup-panel'
import { SafetySettings } from '../../components/safety-settings'
import { Connections } from '../../components/connections'
import { PathSettings } from '../../components/path-settings'
import { HarvestPanel } from '../../components/harvest-panel'
import { Panel } from '../../components/ui'

export const dynamic = 'force-dynamic'

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ spotify?: string; as?: string; reason?: string }>
}) {
  const params = await searchParams
  const settingRow = await prisma.setting.findUnique({ where: { key: 'app' } })
  const settings = (settingRow?.value ?? {}) as Record<string, unknown>

  // Result of the OAuth round trip, passed back as query params by the callback.
  const spotifyStatus =
    params.spotify === 'connected'
      ? { state: 'connected' as const, detail: `Spotify connected as ${params.as ?? 'your account'}.` }
      : params.spotify === 'error'
        ? { state: 'error' as const, detail: params.reason ?? 'Could not connect to Spotify.' }
        : undefined

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-20">
      <header>
        <h1 className="font-display text-xl font-bold uppercase tracking-[0.14em] text-ink">
          Settings
        </h1>
      </header>

      <HarvestPanel />

      <PathSettings
        musicRoot={String(settings.musicRoot ?? '/music')}
        mappings={
          Array.isArray(settings.pathMappings)
            ? (settings.pathMappings as Array<{ appPath: string; navidromePath: string }>)
            : []
        }
      />

      <Connections
        spotifyClientId={String(settings.spotifyClientId ?? '')}
        spotifyStatus={spotifyStatus}
      />

      <Panel title="Spotify market">
        <p className="max-w-prose text-sm leading-relaxed text-ink">
          Currently <span className="data">{String(settings.spotifyMarket ?? 'BE')}</span>.
        </p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-muted">
          Spotify removed the markets endpoint and deprecated the country field on your
          profile, but still treats content as unavailable when no market is supplied. So
          this has to be set explicitly rather than detected. If tracks come back looking
          unavailable, this is the first thing to check.
        </p>
      </Panel>

      <Panel title="Safety switches">
        <SafetySettings values={settings as Record<string, unknown>} />
      </Panel>

      <Panel title="Backup and restore">
        <BackupPanel />
      </Panel>
    </div>
  )
}
