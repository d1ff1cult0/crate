'use client'

/**
 * The switches that decide whether destructive or expensive work may happen.
 *
 * These existed in the settings schema and the API from the start and were exposed
 * *nowhere in the interface*. `dedupeDryRunOnly` defaults to on and blocks every apply,
 * so from the owner's side duplicate deletion simply did nothing and there was no setting
 * to be found — a safety rail that had become a dead end.
 */

import { useState } from 'react'
import { Button, Hairline } from './ui'

interface Toggle {
  key: 'dedupeDryRunOnly' | 'downloadEnabled' | 'trashRetentionEnabled'
  label: string
  detail: string
  /** True when switching it ON is the cautious direction. */
  onIsSafe: boolean
}

const TOGGLES: Toggle[] = [
  {
    key: 'dedupeDryRunOnly',
    label: 'Dry run only for duplicates',
    detail:
      'Blocks per-group deletes and any scheduled resolution — nothing moves, it only reports what it would do. The confirmed “delete all duplicates” action on the Duplicates screen overrides this deliberately, since it states the file count and space before you press it.',
    onIsSafe: true,
  },
  {
    key: 'downloadEnabled',
    label: 'Downloading enabled',
    detail:
      'The master switch for the download queue. With this off, requests still queue but every job returns immediately without contacting a provider — useful while a provider is rate-limiting you.',
    onIsSafe: false,
  },
  {
    key: 'trashRetentionEnabled',
    label: 'Empty the trash automatically',
    detail:
      'When on, the daily retention job permanently deletes trashed files older than the retention window. This is the only thing in Crate that truly deletes, which is why it is off by default.',
    onIsSafe: false,
  },
]

export function SafetySettings({ values }: { values: Record<string, unknown> }) {
  const [state, setState] = useState<Record<string, boolean>>({
    dedupeDryRunOnly: values.dedupeDryRunOnly !== false,
    downloadEnabled: values.downloadEnabled !== false,
    trashRetentionEnabled: values.trashRetentionEnabled === true,
  })
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = async (key: string, value: boolean) => {
    setSaving(key)
    setError(null)
    const previous = state[key]
    setState((s) => ({ ...s, [key]: value }))
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Failed')
    } catch (err) {
      setState((s) => ({ ...s, [key]: previous ?? false }))
      setError(err instanceof Error ? err.message : 'Could not save that.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-4">
      {TOGGLES.map((toggle, i) => {
        const on = state[toggle.key] ?? false
        const cautious = on === toggle.onIsSafe
        return (
          <div key={toggle.key}>
            {i > 0 && <Hairline />}
            <div className="flex flex-wrap items-start justify-between gap-4 pt-3 first:pt-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink">{toggle.label}</span>
                  <span
                    className={`data text-[11px] uppercase tracking-wide ${cautious ? 'text-ink-muted' : 'text-warn'}`}
                  >
                    {on ? 'on' : 'off'}
                  </span>
                </div>
                <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                  {toggle.detail}
                </p>
              </div>
              <Button
                size="sm"
                variant={cautious ? 'secondary' : 'danger'}
                disabled={saving === toggle.key}
                onClick={() => void set(toggle.key, !on)}
              >
                {saving === toggle.key ? 'Saving…' : on ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
          </div>
        )
      })}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  )
}
