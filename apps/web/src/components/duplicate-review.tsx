'use client'

/**
 * Duplicate review. PROMPT.md §7.7, revised on the owner's instruction.
 *
 * The original flow was stage → plan → apply. That was the right default for a tool
 * nobody trusted yet, and the wrong shape for someone who has since looked at the groups
 * and wants three thousand obvious duplicates gone. It is replaced by **one confirmed
 * action**: delete everything at or above 0.95 confidence, with the file count and the
 * space stated before the button does anything.
 *
 * What did NOT change, because it is what makes the action safe to offer at all:
 *
 *  - **"Delete" means moved to `TRASH_ROOT` with a manifest.** The move is a rename, so
 *    it is exactly as fast as unlinking, and it stays fully undoable from this screen.
 *    Unlinking outright would buy nothing and forfeit the audit trail.
 *  - **Variants are never touched.** Same artist and title with durations more than 5s
 *    apart is a live or remixed take. There is no key, no button and no bulk action that
 *    resolves one, and the threshold cannot reach them.
 *  - **0.95 excludes everything decided by name similarity.** It sits above the FUZZY
 *    tiers and below HASH, FINGERPRINT, ISRC and MBID, so a bulk delete only ever removes
 *    copies proven identical by audio, fingerprint or a shared identifier.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { SegmentedMeter } from './meter'
import { Badge, Button, EmptyState, Hairline, Panel } from './ui'

export interface DuplicateFile {
  id: string
  path: string
  format: string
  bitrate: number | null
  sampleRate: number | null
  durationMs: number | null
  sizeBytes: string
  qualityScore: number
  isKeeper: boolean
  sourceProvider: string | null
}

export interface DuplicateGroupView {
  id: string
  reason: string
  confidence: number
  variant: boolean
  title: string
  artist: string
  files: DuplicateFile[]
  differing: string[]
}

export interface TrashOperationView {
  id: string
  fileCount: number
  bytes: string
  reason: string
  createdAt: string
  undoneAt: string | null
}

export interface BulkDeleteSummary {
  minConfidence: number
  groups: number
  files: number
  bytes: string
}

const REASON_COPY: Record<string, string> = {
  HASH: 'Identical audio streams — byte-for-byte the same recording, only the container or tags differ.',
  FINGERPRINT: 'Identical acoustic fingerprint — the same recording encoded differently.',
  ISRC: 'Same ISRC and near-identical duration.',
  MBID: 'Same MusicBrainz recording and near-identical duration.',
  FUZZY: 'Same normalized artist and title with a close duration. Worth a look before deleting.',
  VARIANT:
    'Same artist and title but the durations differ by more than 5s — usually a live, extended or remixed take. Both files are kept.',
}

function megabytes(bytes: string): string {
  return (Number(bytes) / 1_048_576).toFixed(1)
}

function gigabytes(bytes: string): string {
  return (Number(bytes) / 1_073_741_824).toFixed(2)
}

function seconds(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function DuplicateReview({
  groups,
  operations,
  dryRunOnly,
  bulkDelete,
  pager,
}: {
  groups: DuplicateGroupView[]
  operations: TrashOperationView[]
  dryRunOnly: boolean
  bulkDelete: BulkDeleteSummary
  pager?: ReactNode
}) {
  const [cursor, setCursor] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [resolved, setResolved] = useState<Set<string>>(new Set())

  // Variants are not selectable anywhere, including here.
  const resolvable = groups.filter((g) => !g.variant)

  const post = useCallback(async (body: unknown) => {
    const res = await fetch('/api/duplicates/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Failed')
    return res.json()
  }, [])

  /** Resolve one group now. Recoverable, so it does not need its own confirmation. */
  const deleteGroup = useCallback(
    async (groupId: string) => {
      setBusy(true)
      setMessage(null)
      try {
        await post({ action: 'apply', groupIds: [groupId] })
        setResolved((r) => new Set(r).add(groupId))
        setMessage('Queued. Those files move to the trash and can be restored below.')
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Could not delete that group.')
      } finally {
        setBusy(false)
      }
    },
    [post],
  )

  const keepBoth = useCallback(
    async (groupId: string) => {
      setBusy(true)
      try {
        await post({ action: 'ignore', groupId })
        setResolved((r) => new Set(r).add(groupId))
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Could not update that group.')
      } finally {
        setBusy(false)
      }
    },
    [post],
  )

  const runBulkDelete = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await post({
        action: 'bulk-delete',
        minConfidence: bulkDelete.minConfidence,
        confirm: 'DELETE',
      })
      setConfirming(false)
      setConfirmText('')
      setMessage(
        `Deleting ${bulkDelete.files.toLocaleString()} file(s). Watch the activity drawer — every one lands in the trash with a manifest, and the operation appears below with an Undo.`,
      )
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not start the deletion.')
    } finally {
      setBusy(false)
    }
  }

  const undo = async (operationId: string) => {
    setBusy(true)
    try {
      await post({ action: 'undo', operationId })
      setMessage('Queued a restore. Every file in that operation goes back where it was.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not undo.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((c) => Math.min(resolvable.length - 1, c + 1))
      }
      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((c) => Math.max(0, c - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resolvable.length])

  return (
    <div className="space-y-6">
      {/* ── The one action ───────────────────────────────── */}
      <Panel title={`Delete duplicates at ${bulkDelete.minConfidence} confidence or above`}>
        {bulkDelete.files === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing currently qualifies. Only groups proven identical by audio hash,
            acoustic fingerprint, ISRC or MusicBrainz id reach {bulkDelete.minConfidence} —
            anything matched on name similarity alone stays below it, and variants are
            excluded entirely.
          </p>
        ) : !confirming ? (
          <div className="space-y-3">
            <p className="max-w-prose text-sm leading-relaxed text-ink">
              <span className="data">{bulkDelete.files.toLocaleString()}</span> files across{' '}
              <span className="data">{bulkDelete.groups.toLocaleString()}</span> groups,
              freeing <span className="data">{gigabytes(bulkDelete.bytes)} GB</span>. One
              copy of every recording is kept — the highest quality one.
            </p>
            <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
              At {bulkDelete.minConfidence} and above, a group means identical audio,
              an identical acoustic fingerprint, or a shared ISRC/MusicBrainz id with a
              near-identical duration. Nothing matched on name similarity is included, and
              live or remixed variants are never touched.
            </p>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete {bulkDelete.files.toLocaleString()} duplicate files…
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-[4px] border border-error/40 bg-error/5 p-3">
              <p className="text-sm font-medium text-ink">
                Delete {bulkDelete.files.toLocaleString()} files, freeing{' '}
                {gigabytes(bulkDelete.bytes)} GB?
              </p>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
                <li>· One copy of each of the {bulkDelete.groups.toLocaleString()} recordings is kept.</li>
                <li>· Files move to TRASH_ROOT with a JSON manifest — this is undoable from the list below.</li>
                <li>· The trash retention job clears them permanently later, if you enable it.</li>
                <li>· Live and remixed variants are excluded and will not be touched.</li>
              </ul>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type DELETE to confirm"
                className="rounded-[4px] border border-hairline bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-ink focus:outline-none"
              />
              <Button
                variant="danger"
                disabled={busy || confirmText !== 'DELETE'}
                onClick={() => void runBulkDelete()}
              >
                {busy ? 'Starting…' : 'Delete them'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirming(false)
                  setConfirmText('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {dryRunOnly && (
          <p className="mt-3 max-w-prose text-xs leading-relaxed text-ink-muted">
            Note: &ldquo;dry run only&rdquo; is on in Settings, which blocks the scheduled
            and per-group paths. This confirmed action overrides it deliberately — you have
            been told exactly what it will do.
          </p>
        )}
      </Panel>

      {message && (
        <Panel>
          <p className="text-sm text-ink">{message}</p>
        </Panel>
      )}

      {/* ── The groups themselves ─────────────────────────── */}
      <Panel title="Groups">
        {groups.length === 0 ? (
          <EmptyState title="No duplicate groups on this page">
            Run a duplicate scan to group the library by identical audio, fingerprint, ISRC
            and normalized title.
          </EmptyState>
        ) : (
          <>
            <p className="mb-4 text-xs text-ink-muted">
              <kbd className="data">j</kbd>/<kbd className="data">k</kbd> to move. Deleting
              a single group is immediate and undoable — the files go to the trash.
            </p>

            <ul className="divide-y divide-hairline">
              {groups.map((group) => {
                const index = resolvable.indexOf(group)
                const focused = index >= 0 && index === cursor
                const done = resolved.has(group.id)

                return (
                  <li
                    key={group.id}
                    className={`py-3 first:pt-0 last:pb-0 ${focused ? 'ring-1 ring-ink/20' : ''} ${done ? 'opacity-40' : ''}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-ink">{group.title}</div>
                        <div className="truncate text-xs text-ink-muted">{group.artist}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={group.variant ? 'warn' : group.confidence >= 0.95 ? 'ok' : 'idle'}>
                          {group.reason}
                        </Badge>
                        <SegmentedMeter
                          value={group.confidence}
                          segments={10}
                          size="sm"
                          tone={group.variant ? 'warn' : 'ok'}
                          className="w-20"
                          aria-label="confidence"
                        />
                        <span className="data text-xs text-ink-muted">
                          {group.confidence.toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <p className="mt-1.5 text-xs text-ink-muted">{REASON_COPY[group.reason] ?? ''}</p>

                    {group.differing.length > 0 && (
                      <p className="mt-1 text-xs text-ink-muted">
                        Differs by: <span className="data">{group.differing.join(', ')}</span>
                      </p>
                    )}

                    <ul className="mt-2 space-y-1">
                      {group.files.map((file) => (
                        <li
                          key={file.id}
                          className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[3px] px-2 py-1.5 text-xs ${
                            file.isKeeper && !group.variant ? 'bg-ok/5 ring-1 ring-ok/20' : 'bg-recess'
                          }`}
                        >
                          {file.isKeeper && !group.variant && <Badge tone="ok">keeping</Badge>}
                          {!file.isKeeper && !group.variant && <Badge tone="error">deleting</Badge>}
                          {group.variant && <Badge tone="warn">kept</Badge>}
                          <span className="data text-ink">{file.format}</span>
                          <span className="data text-ink-muted">
                            {file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : '—'}
                          </span>
                          <span className="data text-ink-muted">{seconds(file.durationMs)}</span>
                          <span className="data text-ink-muted">{megabytes(file.sizeBytes)} MB</span>
                          <span className="data text-ink-muted">q{file.qualityScore}</span>
                          <span className="min-w-0 flex-1 truncate text-ink-muted" title={file.path}>
                            {file.path}
                          </span>
                          {/* preload="none": a page of 50 groups must not start 150 range
                              requests the moment it renders. */}
                          <audio
                            controls
                            preload="none"
                            src={`/api/library/audio?fileId=${file.id}`}
                            className="h-7 w-full max-w-[16rem] sm:w-auto"
                          />
                        </li>
                      ))}
                    </ul>

                    <div className="mt-2 flex items-center gap-2">
                      {group.variant ? (
                        <span className="text-xs text-warn">
                          Kept as a variant. There is no delete action for these, at any
                          confidence threshold.
                        </span>
                      ) : done ? (
                        <span className="text-xs text-ink-muted">Done.</span>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void deleteGroup(group.id)}
                          >
                            Delete {group.files.filter((f) => !f.isKeeper).length} file
                            {group.files.filter((f) => !f.isKeeper).length === 1 ? '' : 's'}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void keepBoth(group.id)}>
                            Keep both
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>

            {pager && <div className="pt-3">{pager}</div>}
          </>
        )}
      </Panel>

      <Panel title="Trash operations">
        {operations.length === 0 ? (
          <EmptyState title="Nothing has been moved to the trash">
            When you delete a group, the files land in TRASH_ROOT and the operation appears
            here with a working Undo. Nothing in this app ever unlinks a library file.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hairline">
            {operations.map((operation) => (
              <li key={operation.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-ink">{operation.reason}</div>
                  <div className="data text-xs text-ink-muted">
                    {operation.fileCount.toLocaleString()} files · {megabytes(operation.bytes)} MB ·{' '}
                    {new Date(operation.createdAt).toLocaleString()}
                  </div>
                </div>
                {operation.undoneAt ? (
                  <Badge tone="idle">undone</Badge>
                ) : (
                  <Button size="sm" disabled={busy} onClick={() => void undo(operation.id)}>
                    Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Hairline />
    </div>
  )
}
