'use client'

/**
 * The curator box (§7.8). One text field, one button.
 *
 * The copy is doing real work here. §7.8 requires that invented tracks are "dropped
 * silently, with a count logged" — silently to the *playlist*, not to the owner. Telling
 * them up front that suggestions are checked against the library, and that anything not
 * there is discarded, is what stops a short playlist reading as a bug.
 */

import { useState } from 'react'
import { Button } from './ui'

const EXAMPLES = [
  'Late-night driving, mostly instrumental',
  'Loud and fast, nothing older than 2015',
  'Sunday morning, nothing with drums',
]

export function CuratorBox({ available }: { available: boolean }) {
  const [value, setValue] = useState('')
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const submit = async () => {
    if (value.trim().length < 3) return
    setState('busy')
    setMessage(null)
    try {
      const res = await fetch('/api/mixes/curate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: value.trim() }),
      })
      const body = (await res.json()) as { message?: string; error?: string }
      if (!res.ok) {
        setState('error')
        setMessage(body.error ?? 'That did not work.')
        return
      }
      setState('done')
      setMessage(body.message ?? 'Queued.')
      setValue('')
    } catch (err) {
      setState('error')
      setMessage(err instanceof Error ? err.message : 'That did not work.')
    }
  }

  if (!available) {
    return (
      <p className="text-sm text-ink-muted">
        The curator needs a local model. Point Settings at your Ollama endpoint and pick a
        model, or add an Anthropic key. Nothing else on this page depends on it.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Describe a mood…"
          className="flex-1 rounded-[4px] border border-hairline bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
        />
        <Button variant="primary" disabled={state === 'busy'} onClick={() => void submit()}>
          {state === 'busy' ? 'Thinking…' : 'Make a playlist'}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setValue(example)}
            className="rounded-[3px] border border-hairline px-2 py-1 text-xs text-ink-muted transition-state hover:text-ink"
          >
            {example}
          </button>
        ))}
      </div>

      {message && (
        <p className={`text-xs ${state === 'error' ? 'text-error' : 'text-ink-muted'}`}>{message}</p>
      )}
    </div>
  )
}
