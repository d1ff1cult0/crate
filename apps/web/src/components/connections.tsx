'use client'

/**
 * Connections editor.
 *
 * Credentials are write-only from the browser's point of view: the API never returns a
 * stored secret, so the fields show whether something is configured, not what it is
 * (§11). Saving verifies the credential where that's cheap, so a typo is caught here.
 */

import { useEffect, useState } from 'react'
import { Badge, Button, Panel, StatusDot } from './ui'

interface ConnectionState {
  provider: string
  enabled: boolean
  displayName: string | null
  lastOkAt: string | null
  lastError: string | null
  hasSecret: boolean
}

interface Field {
  key: string
  label: string
  type?: 'text' | 'password'
  placeholder?: string
}

interface ProviderSpec {
  key: string
  name: string
  note: string
  fields: Field[]
}

const PROVIDERS: ProviderSpec[] = [
  {
    key: 'navidrome',
    name: 'Navidrome',
    note: 'Where playlists are written, and the live listening signal once Spotify is gone. Required.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'http://navidrome:4533' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', type: 'password' },
    ],
  },
  {
    key: 'listenbrainz',
    name: 'ListenBrainz',
    note: 'The strongest similarity source for recommendations, and real collaborative-filtering data. Artist and track similarity need no token at all — leave both fields blank and it still works. A token additionally pulls your own listens into the taste model.',
    fields: [
      { key: 'token', label: 'User token (optional)', type: 'password' },
      { key: 'username', label: 'Username (optional — read from the token)' },
    ],
  },
  {
    key: 'acoustid',
    name: 'AcoustID',
    note: 'Recovers ISRCs and MusicBrainz IDs from fingerprints, without spending any Spotify quota. Optional — everything still works without it, you just get fewer tier-1 matches on files you already own.',
    fields: [{ key: 'apiKey', label: 'API key', type: 'password' }],
  },
  {
    key: 'lidarr',
    name: 'Lidarr',
    note: 'Optional downstream. Full albums are better handed to Lidarr than downloaded track by track.',
    fields: [
      { key: 'baseUrl', label: 'Base URL', placeholder: 'http://lidarr:8686' },
      { key: 'apiKey', label: 'API key', type: 'password' },
    ],
  },
  {
    key: 'ollama',
    name: 'Ollama',
    note: 'Local LLM for the curator module. No cloud dependency.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', placeholder: 'http://localhost:11434' },
      { key: 'model', label: 'Model', placeholder: 'gemma3' },
    ],
  },
]

export function Connections({
  spotifyClientId: initialClientId,
  spotifyStatus,
}: {
  spotifyClientId: string
  spotifyStatus?: { state: 'connected' | 'error'; detail: string } | undefined
}) {
  const [connections, setConnections] = useState<ConnectionState[]>([])
  const [clientId, setClientId] = useState(initialClientId)
  const [clientIdSaved, setClientIdSaved] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = async () => {
    try {
      const res = await fetch('/api/connections')
      if (res.ok) setConnections((await res.json()) as ConnectionState[])
    } catch {
      // Leave the list as-is; the page is still usable.
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const byProvider = new Map(connections.map((c) => [c.provider, c]))

  const saveClientId = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyClientId: clientId.trim() }),
    })
    setClientIdSaved(true)
  }

  const save = async (spec: ProviderSpec) => {
    setBusy(spec.key)
    setErrors((e) => ({ ...e, [spec.key]: '' }))
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: spec.key, ...(drafts[spec.key] ?? {}) }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        setErrors((e) => ({ ...e, [spec.key]: body.error ?? 'Could not save.' }))
      } else {
        setDrafts((d) => ({ ...d, [spec.key]: {} }))
        await load()
      }
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (provider: string) => {
    await fetch(`/api/connections?provider=${provider}`, { method: 'DELETE' })
    await load()
  }

  const spotify = byProvider.get('spotify')

  return (
    <div className="space-y-4">
      <Panel title="Spotify">
        <div className="space-y-4">
          {spotifyStatus && (
            <div
              className={`rounded-[4px] border p-3 text-sm ${
                spotifyStatus.state === 'connected'
                  ? 'border-ok/30 bg-ok/5 text-ok'
                  : 'border-error/30 bg-error/5 text-error'
              }`}
            >
              {spotifyStatus.detail}
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <StatusDot
              tone={spotify?.enabled ? 'ok' : 'idle'}
              label={
                spotify?.enabled
                  ? `Connected as ${spotify.displayName ?? 'unknown'}`
                  : 'Not connected'
              }
            />
            {spotify?.enabled && (
              <Button size="sm" variant="danger" onClick={() => void disconnect('spotify')}>
                Disconnect
              </Button>
            )}
          </div>

          <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
            Create an app at developer.spotify.com, add{' '}
            <span className="data break-all">
              {typeof window !== 'undefined' ? window.location.origin : ''}
              /api/spotify/callback
            </span>{' '}
            as a redirect URI, then paste the client ID here. Crate asks for read-only
            scopes only — it cannot modify your Spotify account.
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 space-y-1">
              <span className="label">Client ID</span>
              <input
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value)
                  setClientIdSaved(false)
                }}
                placeholder="0123456789abcdef0123456789abcdef"
                className="data w-full rounded-[4px] border border-hairline bg-surface px-2.5 py-1.5 text-sm"
              />
            </label>
            <Button size="sm" onClick={saveClientId}>
              {clientIdSaved ? 'Saved' : 'Save'}
            </Button>
            <Button size="sm" variant="primary" disabled={!clientId.trim()}>
              <a href="/api/spotify/authorize">
                {spotify?.enabled ? 'Reconnect' : 'Connect Spotify'}
              </a>
            </Button>
          </div>

          <p className="max-w-prose rounded-[4px] border border-accent/40 bg-accent/5 p-3 text-xs leading-relaxed text-ink">
            Development Mode now requires the app owner to hold active Premium. Yours
            lapses on 1 September 2026, and the connector stops working that day — so
            connect and harvest before then. Everything harvested keeps working
            afterwards.
          </p>
        </div>
      </Panel>

      {PROVIDERS.map((spec) => {
        const conn = byProvider.get(spec.key)
        const draft = drafts[spec.key] ?? {}
        const error = errors[spec.key]

        return (
          <Panel
            key={spec.key}
            title={spec.name}
            action={
              <Badge tone={conn?.enabled && conn.hasSecret ? 'ok' : 'idle'}>
                {conn?.enabled && conn.hasSecret ? 'configured' : 'not configured'}
              </Badge>
            }
          >
            <div className="space-y-3">
              <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{spec.note}</p>

              {conn?.displayName && conn.enabled && (
                <p className="data text-xs text-ok">{conn.displayName}</p>
              )}
              {conn?.lastError && <p className="text-xs text-error">{conn.lastError}</p>}

              <div className="grid gap-2 sm:grid-cols-2">
                {spec.fields.map((field) => (
                  <label key={field.key} className="space-y-1">
                    <span className="label">{field.label}</span>
                    <input
                      type={field.type ?? 'text'}
                      value={draft[field.key] ?? ''}
                      placeholder={
                        conn?.hasSecret && field.type === 'password'
                          ? '•••••••• (stored)'
                          : field.placeholder
                      }
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [spec.key]: { ...(d[spec.key] ?? {}), [field.key]: e.target.value },
                        }))
                      }
                      className="data w-full rounded-[4px] border border-hairline bg-surface px-2.5 py-1.5 text-sm"
                    />
                  </label>
                ))}
              </div>

              {error && <p className="text-xs text-error">{error}</p>}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy === spec.key}
                  onClick={() => void save(spec)}
                >
                  {busy === spec.key ? 'Verifying…' : 'Save and verify'}
                </Button>
                {conn?.enabled && (
                  <Button size="sm" variant="danger" onClick={() => void disconnect(spec.key)}>
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          </Panel>
        )
      })}
    </div>
  )
}
