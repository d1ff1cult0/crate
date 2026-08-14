/**
 * Settings — connections, providers, paths, schedules, diagnostics (PROMPT.md §8).
 *
 * The path verification diagnostic is the most valuable thing on this page: §5 calls
 * path mapping "the single most common failure in this class of app", and the diagnostic
 * is what turns "the playlist is empty in Navidrome" into a specific, actionable answer.
 */

import { prisma } from '@crate/db'
import { PathSettings } from '../../components/path-settings'
import { HarvestPanel } from '../../components/harvest-panel'
import { Badge, Panel, StatusDot } from '../../components/ui'

export const dynamic = 'force-dynamic'

const PROVIDERS = [
  { key: 'spotify', name: 'Spotify', note: 'Read-only. Expires when Premium lapses on 1 Sept 2026.' },
  { key: 'navidrome', name: 'Navidrome', note: 'Where playlists are written. Required.' },
  { key: 'lastfm', name: 'Last.fm', note: 'Similarity data for recommendations. Connect early — it accumulates.' },
  { key: 'acoustid', name: 'AcoustID', note: 'Recovers ISRCs from fingerprints without using Spotify quota.' },
  { key: 'lidarr', name: 'Lidarr', note: 'Optional downstream for full albums.' },
  { key: 'ollama', name: 'Ollama', note: 'Local LLM for the curator module.' },
]

export default async function SettingsPage() {
  const [settingRow, connections] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'app' } }),
    prisma.connection.findMany(),
  ])

  const settings = (settingRow?.value ?? {}) as Record<string, unknown>
  const byProvider = new Map(connections.map((c) => [c.provider, c]))

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

      <Panel title="Connections">
        <ul className="divide-y divide-hairline">
          {PROVIDERS.map((p) => {
            const conn = byProvider.get(p.key)
            return (
              <li key={p.key} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot
                      tone={
                        !conn ? 'idle' : !conn.enabled ? 'idle' : conn.lastError ? 'error' : 'ok'
                      }
                    />
                    <span className="text-sm font-medium text-ink">{p.name}</span>
                    {conn?.displayName && (
                      <span className="data text-xs text-ink-muted">{conn.displayName}</span>
                    )}
                  </div>
                  <p className="mt-0.5 max-w-prose text-xs text-ink-muted">{p.note}</p>
                  {conn?.lastError && (
                    <p className="mt-1 max-w-prose text-xs text-error">{conn.lastError}</p>
                  )}
                </div>
                <Badge tone={conn?.enabled ? 'ok' : 'idle'}>
                  {conn?.enabled ? 'connected' : 'not connected'}
                </Badge>
              </li>
            )
          })}
        </ul>
      </Panel>

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
    </div>
  )
}
