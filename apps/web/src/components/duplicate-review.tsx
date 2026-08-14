'use client'

/**
 * Duplicate review. PROMPT.md §7.7.
 *
 * "Grouped rows, keeper preselected and highlighted, inline audio preview of each
 *  candidate, a diff of the differing attributes only, `A` to accept a group, `Shift+A`
 *  to accept all groups above a confidence threshold."
 *
 * The trust rules are visible in the interface, not just enforced underneath:
 *
 *  - A variant group renders as *kept*, with no accept control at all. There is no key,
 *    no button and no bulk action that resolves one. §7.7 is explicit that auto-deleting
 *    a live version is how a dedupe tool loses trust permanently, so the UI does not
 *    offer the mistake.
 *  - Nothing moves on `A`. Accepting stages a group; a single deliberate Apply moves the
 *    staged set, and until then the screen is a plan.
 *  - The plan is always shown before the apply — file paths and megabytes, not a count.
 */

import { useCallback, useEffect, useState } from 'react'
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

const REASON_COPY: Record<string, string> = {
  HASH: 'Identical audio streams — byte-for-byte the same recording, only the container or tags differ.',
  FINGERPRINT: 'Identical acoustic fingerprint — the same recording encoded differently.',
  ISRC: 'Same ISRC and near-identical duration.',
  MBID: 'Same MusicBrainz recording and near-identical duration.',
  FUZZY: 'Same normalized artist and title with a close duration. Worth a look before applying.',
  VARIANT:
    'Same artist and title but the durations differ by more than 5s — usually a live, extended or remixed take. Both files are kept.',
}

function megabytes(bytes: string): string {
  return (Number(bytes) / 1_048_576).toFixed(1)
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
}: {
  groups: DuplicateGroupView[]
  operations: TrashOperationView[]
  dryRunOnly: boolean
}) {
  const [staged, setStaged] = useState<Set<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  const [plan, setPlan] = useState<null | {
    filesToMove: number
    bytes: string
    plan: Array<{ groupId: string; keeper: string | null; wouldMove: Array<{ path: string; sizeBytes: string }> }>
  }>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // Variants are not selectable anywhere, including here.
  const resolvable = groups.filter((g) => !g.variant)

  const toggle = useCallback((groupId: string) => {
    setStaged((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const stageAllAbove = useCallback(
    (threshold: number) => {
      setStaged(new Set(resolvable.filter((g) => g.confidence >= threshold).map((g) => g.id)))
    },
    [resolvable],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return
      }
      if (event.key === 'A' && event.shiftKey) {
        event.preventDefault()
        stageAllAbove(0.95)
        setMessage('Staged every group at 0.95 confidence or above. Variants are excluded.')
        return
      }
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault()
        const group = resolvable[cursor]
        if (group) toggle(group.id)
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
  }, [cursor, resolvable, stageAllAbove, toggle])

  const post = async (body: unknown) => {
    const res = await fetch('/api/duplicates/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Failed')
    return res.json()
  }

  const showPlan = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = (await post({ action: 'plan', groupIds: [...staged] })) as typeof plan
      setPlan(result)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not build the plan.')
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    setBusy(true)
    try {
      await post({ action: 'apply', groupIds: [...staged] })
      setMessage(
        'Queued. The worker is moving those files to the trash now — watch the activity drawer, and use Undo below if it looks wrong.',
      )
      setPlan(null)
      setStaged(new Set())
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not apply.')
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

  if (groups.length === 0) {
    return (
      <Panel title="Duplicate groups">
        <EmptyState title="No duplicate groups yet">
          Run a duplicate scan to group the library by identical audio, fingerprint, ISRC
          and normalized title. Nothing is ever moved by the scan itself — it only builds
          the groups for you to look at.
        </EmptyState>
      </Panel>
    )
  }

  return (
    <div className="space-y-6">
      <Panel
        title={`${resolvable.length} resolvable group${resolvable.length === 1 ? '' : 's'}`}
        action={
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={() => stageAllAbove(0.95)}>
              Stage ≥ 0.95
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStaged(new Set())}>
              Clear
            </Button>
          </div>
        }
      >
        <p className="mb-4 text-xs text-ink-muted">
          <kbd className="data">j</kbd>/<kbd className="data">k</kbd> to move,{' '}
          <kbd className="data">A</kbd> to stage a group,{' '}
          <kbd className="data">Shift+A</kbd> to stage everything above 0.95. Staging moves
          nothing — you review the plan first.
        </p>

        <ul className="divide-y divide-hairline">
          {groups.map((group) => {
            const index = resolvable.indexOf(group)
            const focused = index >= 0 && index === cursor
            const isStaged = staged.has(group.id)

            return (
              <li
                key={group.id}
                className={`py-3 first:pt-0 last:pb-0 ${focused ? 'ring-1 ring-ink/20' : ''}`}
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

                <p className="mt-1.5 text-xs text-ink-muted">
                  {REASON_COPY[group.reason] ?? ''}
                </p>

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
                      {file.isKeeper && !group.variant && <Badge tone="ok">keeper</Badge>}
                      {group.variant && <Badge tone="warn">kept</Badge>}
                      <span className="data text-ink">{file.format}</span>
                      <span className="data text-ink-muted">
                        {file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : '—'}
                      </span>
                      <span className="data text-ink-muted">{seconds(file.durationMs)}</span>
                      <span className="data text-ink-muted">{megabytes(file.sizeBytes)} MB</span>
                      <span className="data text-ink-muted">q{file.qualityScore}</span>
                      {file.sourceProvider && (
                        <span className="data text-ink-muted">{file.sourceProvider}</span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-ink-muted" title={file.path}>
                        {file.path}
                      </span>
                      {/* Inline preview (§7.7). Served by the API, which reads only
                          under MUSIC_ROOT. */}
                      {/* `preload="none"` matters: a group of six FLACs would otherwise
                          start six range requests the moment the row renders. */}
                      <audio
                        controls
                        preload="none"
                        src={`/api/library/audio?fileId=${file.id}`}
                        className="h-7 w-full max-w-[16rem] sm:w-auto"
                      />
                      {!group.variant && !file.isKeeper && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void post({ action: 'keeper', groupId: group.id, fileId: file.id }).then(
                              () => window.location.reload(),
                            )
                          }
                        >
                          Keep this one
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>

                <div className="mt-2 flex items-center gap-2">
                  {group.variant ? (
                    <span className="text-xs text-warn">
                      Kept as a variant. There is no accept action for these — including
                      under &ldquo;stage all&rdquo;.
                    </span>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant={isStaged ? 'primary' : 'secondary'}
                        onClick={() => toggle(group.id)}
                      >
                        {isStaged ? 'Staged' : 'Stage'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void post({ action: 'ignore', groupId: group.id }).then(() =>
                            window.location.reload(),
                          )
                        }
                      >
                        Keep both
                      </Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </Panel>

      {staged.size > 0 && (
        <Panel title={`${staged.size} group${staged.size === 1 ? '' : 's'} staged`}>
          {!plan ? (
            <div className="flex items-center gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void showPlan()}>
                {busy ? 'Building…' : 'Show me exactly what would move'}
              </Button>
              <span className="text-xs text-ink-muted">Nothing has moved yet.</span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-ink">
                <span className="data">{plan.filesToMove}</span> file
                {plan.filesToMove === 1 ? '' : 's'} would move to the trash, freeing{' '}
                <span className="data">{megabytes(plan.bytes)} MB</span>. Nothing is deleted —
                every file lands in TRASH_ROOT with a manifest and can be restored.
              </div>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {plan.plan.flatMap((g) =>
                  g.wouldMove.map((f) => (
                    <li key={f.path} className="data truncate text-xs text-ink-muted">
                      → {f.path}
                    </li>
                  )),
                )}
              </ul>
              <Hairline />
              {dryRunOnly ? (
                <p className="text-xs text-warn">
                  &ldquo;Dry run only&rdquo; is on in Settings, so applying is blocked. That
                  is the default and it is deliberate — turn it off when you trust the plan.
                </p>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="danger" disabled={busy} onClick={() => void apply()}>
                    {busy ? 'Queueing…' : `Move ${plan.filesToMove} file(s) to trash`}
                  </Button>
                  <Button variant="ghost" onClick={() => setPlan(null)}>
                    Back
                  </Button>
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

      {message && (
        <Panel>
          <p className="text-sm text-ink">{message}</p>
        </Panel>
      )}

      <Panel title="Trash operations">
        {operations.length === 0 ? (
          <EmptyState title="Nothing has been moved to the trash">
            When you apply a group, the files land in TRASH_ROOT and the operation appears
            here with a working Undo. Nothing in this app ever deletes a library file.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-hairline">
            {operations.map((operation) => (
              <li key={operation.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-ink">{operation.reason}</div>
                  <div className="data text-xs text-ink-muted">
                    {operation.fileCount} files · {megabytes(operation.bytes)} MB ·{' '}
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
    </div>
  )
}
