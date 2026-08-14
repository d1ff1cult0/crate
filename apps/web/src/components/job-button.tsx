'use client'

/**
 * "Run now" for any scheduled job (§7.10).
 *
 * Reports what it queued rather than just going quiet: the work happens in the worker
 * and the button press has no visible effect for a second or two, so saying which job
 * started is the difference between "it works" and "did that do anything?".
 */

import { useState } from 'react'
import { Button } from './ui'

export function JobButton({
  job,
  label,
  variant = 'secondary',
  size = 'sm',
}: {
  job: string
  label: string
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [detail, setDetail] = useState<string | null>(null)

  const run = async () => {
    setState('busy')
    setDetail(null)
    try {
      const res = await fetch('/api/jobs/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job }),
      })
      const body = (await res.json()) as { description?: string; error?: string }
      if (!res.ok) {
        setState('error')
        setDetail(body.error ?? 'That did not work.')
        return
      }
      setState('done')
      setDetail(body.description ?? null)
    } catch (err) {
      setState('error')
      setDetail(err instanceof Error ? err.message : 'That did not work.')
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant={variant} size={size} disabled={state === 'busy'} onClick={() => void run()}>
        {state === 'busy' ? 'Queueing…' : state === 'done' ? 'Queued' : label}
      </Button>
      {detail && (
        <span className={`max-w-xs text-right text-xs ${state === 'error' ? 'text-error' : 'text-ink-muted'}`}>
          {detail}
        </span>
      )}
    </div>
  )
}
