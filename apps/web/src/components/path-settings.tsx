'use client'

/**
 * Path mapping plus the "Verify paths" diagnostic (PROMPT.md §5).
 *
 * The diagnostic reports which SEGMENT of the mapping is wrong, not just pass/fail —
 * that distinction is the whole reason it exists.
 */

import { useState } from 'react'
import { Button, EmptyState, Panel } from './ui'

interface Mapping {
  appPath: string
  navidromePath: string
}

interface VerifyStep {
  name: string
  status: 'ok' | 'failed' | 'skipped' | 'warning'
  detail: string
  remedy?: string
}

interface VerifyResult {
  ok: boolean
  steps: VerifyStep[]
  summary: string
}

const STATUS_MARK: Record<VerifyStep['status'], { symbol: string; className: string }> = {
  ok: { symbol: '✓', className: 'text-ok' },
  failed: { symbol: '✕', className: 'text-error' },
  warning: { symbol: '!', className: 'text-warn' },
  skipped: { symbol: '–', className: 'text-ink-muted' },
}

export function PathSettings({
  musicRoot,
  mappings: initial,
}: {
  musicRoot: string
  mappings: Mapping[]
}) {
  const [mappings, setMappings] = useState<Mapping[]>(
    initial.length > 0 ? initial : [{ appPath: musicRoot, navidromePath: '' }],
  )
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [saved, setSaved] = useState(false)

  const update = (i: number, field: keyof Mapping, value: string) => {
    setMappings((m) => m.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)))
    setSaved(false)
  }

  const save = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pathMappings: mappings }),
    })
    setSaved(true)
  }

  const verify = async () => {
    setVerifying(true)
    setResult(null)
    try {
      const res = await fetch('/api/settings/verify-paths', { method: 'POST' })
      setResult((await res.json()) as VerifyResult)
    } catch (err) {
      setResult({
        ok: false,
        summary: err instanceof Error ? err.message : 'Verification could not run.',
        steps: [],
      })
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Panel
      title="Paths"
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={save}>
            {saved ? 'Saved' : 'Save'}
          </Button>
          <Button size="sm" variant="primary" onClick={verify} disabled={verifying}>
            {verifying ? 'Verifying…' : 'Verify paths'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
          The path Crate sees is not the path Navidrome sees. Map one to the other here,
          then verify — the check writes a probe playlist, triggers a scan, and reports
          exactly which side of the mapping is wrong if Navidrome cannot resolve it.
        </p>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <span className="label">Crate sees</span>
            <span className="label">Navidrome sees</span>
          </div>
          {mappings.map((m, i) => (
            <div key={i} className="grid grid-cols-2 gap-3">
              <input
                value={m.appPath}
                onChange={(e) => update(i, 'appPath', e.target.value)}
                placeholder="/music"
                className="data rounded-[4px] border border-hairline bg-surface px-2.5 py-1.5 text-sm"
              />
              <input
                value={m.navidromePath}
                onChange={(e) => update(i, 'navidromePath', e.target.value)}
                placeholder="/data/media"
                className="data rounded-[4px] border border-hairline bg-surface px-2.5 py-1.5 text-sm"
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMappings((m) => [...m, { appPath: '', navidromePath: '' }])}
          >
            Add mapping
          </Button>
        </div>

        {result && (
          <div
            className={`rounded-[4px] border p-3 ${
              result.ok ? 'border-ok/30 bg-ok/5' : 'border-error/30 bg-error/5'
            }`}
          >
            <p className={`text-sm font-medium ${result.ok ? 'text-ok' : 'text-error'}`}>
              {result.summary}
            </p>
            {result.steps.length > 0 && (
              <ul className="mt-3 space-y-2">
                {result.steps.map((step, i) => {
                  const mark = STATUS_MARK[step.status]
                  return (
                    <li key={i} className="flex gap-2.5">
                      <span className={`data shrink-0 ${mark.className}`}>{mark.symbol}</span>
                      <div className="min-w-0">
                        <div className="text-sm text-ink">{step.name}</div>
                        <div className="text-xs text-ink-muted">{step.detail}</div>
                        {step.remedy && (
                          <div className="mt-1 text-xs text-ink">{step.remedy}</div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {!result && mappings.every((m) => !m.navidromePath) && (
          <EmptyState title="Not configured yet">
            Until a mapping exists, playlists are written with Crate&rsquo;s own paths,
            which Navidrome almost certainly cannot resolve. Fill in what Navidrome sees
            as its music folder and run the verification.
          </EmptyState>
        )}
      </div>
    </Panel>
  )
}
