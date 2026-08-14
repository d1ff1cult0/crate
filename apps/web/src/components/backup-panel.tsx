'use client'

/**
 * Backup and restore controls (phase 8).
 *
 * The copy carries a warning the UI cannot enforce: the encryption key lives in the
 * environment, not in the backup, so a backup restored without it comes back with every
 * credential unreadable. Saying that here — next to the download button, where it is
 * actually relevant — is the difference between a working backup and one that only looks
 * like a backup.
 */

import { useRef, useState } from 'react'
import { Button, Hairline } from './ui'

export function BackupPanel() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const restore = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('Choose a backup file first.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const form = new FormData()
      form.set('backup', file)
      form.set('confirm', confirm)
      const res = await fetch('/api/backup', { method: 'POST', body: form })
      const body = (await res.json()) as { message?: string; error?: string }
      if (!res.ok) setError(body.error ?? 'That did not work.')
      else {
        setMessage(body.message ?? 'Restore queued.')
        setConfirm('')
        if (fileRef.current) fileRef.current.value = ''
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          A backup carries everything harvested from Spotify, every match decision you
          made, your listening history and the artist graph. Job logs and download
          attempts are left out — they are the bulkiest tables and worth nothing a week
          later.
        </p>
        <div className="flex flex-wrap gap-2">
          <a href="/api/backup" download>
            <Button variant="primary" size="sm">
              Download full backup
            </Button>
          </a>
          <a href="/api/backup?scope=essential" download>
            <Button size="sm">Download without the library index</Button>
          </a>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-warn">
          Credentials are included as ciphertext, not plaintext. They are only readable
          with the same <span className="data">CRATE_ENCRYPTION_KEY</span> this instance
          runs on — back that key up separately, or the connections in the file are
          unrecoverable.
        </p>
      </div>

      <Hairline />

      <div className="space-y-2">
        <h3 className="label">Restore</h3>
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          Rows are matched by id and overwritten. Anything in the database that is not in
          the backup is left alone — this merges, it does not wipe. Re-running the same
          file twice does the same thing as running it once.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-[3px] file:border file:border-hairline file:bg-surface file:px-2.5 file:py-1 file:text-sm file:text-ink"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type REPLACE to confirm"
            className="rounded-[4px] border border-hairline bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
          />
          <Button variant="danger" size="sm" disabled={busy || confirm !== 'REPLACE'} onClick={() => void restore()}>
            {busy ? 'Queueing…' : 'Restore'}
          </Button>
        </div>
        {message && <p className="text-xs text-ink-muted">{message}</p>}
        {error && <p className="text-xs text-error">{error}</p>}
      </div>
    </div>
  )
}
