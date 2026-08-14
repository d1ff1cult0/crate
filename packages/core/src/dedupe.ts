/**
 * Duplicate grouping. PROMPT.md §7.7.
 *
 * Passes run most-confident first, and a file already claimed by a stronger pass is
 * never reconsidered by a weaker one.
 *
 * The rule that matters most is the LAST one: same artist+title but duration differing
 * by more than 5s is a VARIANT (live take, remix, extended cut), not a duplicate.
 * These are grouped for visibility but default to keeping both, because auto-deleting
 * someone's live version is how a dedupe tool loses trust permanently — the brief says
 * so explicitly and it is the single most important behaviour in this file.
 */

import { normalizeTrack } from './normalize.js'
import { selectKeeper, type KeeperInput } from './quality.js'

export type GroupReason = 'HASH' | 'FINGERPRINT' | 'ISRC' | 'MBID' | 'FUZZY' | 'VARIANT'

export interface DedupeFile extends KeeperInput {
  id: string
  path: string
  title: string
  artist: string
  album?: string | null
  durationMs?: number | null
  isrc?: string | null
  mbid?: string | null
  contentHash?: string | null
  fingerprint?: string | null
}

export interface DuplicateGroupResult {
  reason: GroupReason
  confidence: number
  /** True for VARIANT groups: shown, but never auto-resolved. */
  variant: boolean
  memberIds: string[]
  keeperId: string | null
  /** Only the attributes that actually differ, for the review UI's diff. */
  differing: string[]
  explanation: string
}

export interface DedupeOptions {
  /** ±ms for tiers 3 and 4. */
  durationToleranceMs: number
  /** Beyond this delta on the same artist+title, it's a variant not a duplicate. */
  variantThresholdMs: number
  /** Groups at or above this confidence may be auto-resolved IF the caller allows it. */
  autoResolveAt: number
}

export const DEDUPE_DEFAULTS: DedupeOptions = {
  durationToleranceMs: 2000,
  variantThresholdMs: 5000,
  autoResolveAt: 0.98,
}

function differingAttributes(files: DedupeFile[]): string[] {
  const out: string[] = []
  const distinct = <T>(vals: T[]) => new Set(vals.map((v) => JSON.stringify(v ?? null))).size > 1
  if (distinct(files.map((f) => f.format?.toLowerCase()))) out.push('format')
  if (distinct(files.map((f) => f.bitrate ?? null))) out.push('bitrate')
  if (distinct(files.map((f) => f.sampleRate ?? null))) out.push('sampleRate')
  if (distinct(files.map((f) => f.bitDepth ?? null))) out.push('bitDepth')
  if (distinct(files.map((f) => f.durationMs ?? null))) out.push('duration')
  if (distinct(files.map((f) => f.album ?? null))) out.push('album')
  if (distinct(files.map((f) => f.hasEmbeddedArt ?? false))) out.push('embeddedArt')
  if (distinct(files.map((f) => f.sourceProvider ?? null))) out.push('source')
  return out
}

function makeGroup(
  files: DedupeFile[],
  reason: GroupReason,
  confidence: number,
  variant: boolean,
  explanation: string,
): DuplicateGroupResult {
  return {
    reason,
    confidence,
    variant,
    memberIds: files.map((f) => f.id),
    // Variants have no keeper — both sides are kept by default.
    keeperId: variant ? null : (selectKeeper(files)?.id ?? null),
    differing: differingAttributes(files),
    explanation,
  }
}

/** Group by a key function, ignoring files already claimed and singleton buckets. */
function groupBy(
  files: DedupeFile[],
  claimed: Set<string>,
  key: (f: DedupeFile) => string | null,
): DedupeFile[][] {
  const buckets = new Map<string, DedupeFile[]>()
  for (const f of files) {
    if (claimed.has(f.id)) continue
    const k = key(f)
    if (!k) continue
    const list = buckets.get(k)
    if (list) list.push(f)
    else buckets.set(k, [f])
  }
  return [...buckets.values()].filter((b) => b.length > 1)
}

function withinTolerance(files: DedupeFile[], toleranceMs: number): boolean {
  const durations = files.map((f) => f.durationMs).filter((d): d is number => d != null)
  if (durations.length < 2) return true
  return Math.max(...durations) - Math.min(...durations) <= toleranceMs
}

export function findDuplicateGroups(
  files: DedupeFile[],
  opts: DedupeOptions = DEDUPE_DEFAULTS,
): DuplicateGroupResult[] {
  const groups: DuplicateGroupResult[] = []
  const claimed = new Set<string>()

  const claim = (g: DuplicateGroupResult) => {
    groups.push(g)
    for (const id of g.memberIds) claimed.add(id)
  }

  // ── Pass 1: identical audio stream hash. Certain.
  for (const bucket of groupBy(files, claimed, (f) => f.contentHash ?? null)) {
    claim(
      makeGroup(
        bucket,
        'HASH',
        1.0,
        false,
        'Identical audio streams — byte-for-byte the same recording, only the container or tags differ.',
      ),
    )
  }

  // ── Pass 2: identical chromaprint. Near-certain; catches re-encodes.
  for (const bucket of groupBy(files, claimed, (f) => f.fingerprint ?? null)) {
    claim(
      makeGroup(
        bucket,
        'FINGERPRINT',
        0.99,
        false,
        'Identical acoustic fingerprint — the same recording encoded differently.',
      ),
    )
  }

  // ── Pass 3: same ISRC or MBID, duration within ±2s.
  for (const bucket of groupBy(files, claimed, (f) =>
    f.isrc ? `isrc:${f.isrc.toUpperCase()}` : null,
  )) {
    if (!withinTolerance(bucket, opts.durationToleranceMs)) continue
    claim(makeGroup(bucket, 'ISRC', 0.97, false, 'Same ISRC and near-identical duration.'))
  }
  for (const bucket of groupBy(files, claimed, (f) => (f.mbid ? `mbid:${f.mbid}` : null))) {
    if (!withinTolerance(bucket, opts.durationToleranceMs)) continue
    claim(
      makeGroup(bucket, 'MBID', 0.96, false, 'Same MusicBrainz recording and near-identical duration.'),
    )
  }

  // ── Passes 4 and 5: normalized artist + title. Duration decides which.
  const normKey = (f: DedupeFile): string => {
    const n = normalizeTrack({ title: f.title, artists: f.artist })
    // Variant markers are part of the key: a live take and a studio take with the same
    // title must not land in the same bucket in the first place.
    return `${n.artist.normAll}|${n.title.norm}|${n.title.variants.join(',')}`
  }

  for (const bucket of groupBy(files, claimed, normKey)) {
    if (withinTolerance(bucket, opts.durationToleranceMs)) {
      claim(
        makeGroup(
          bucket,
          'FUZZY',
          0.85,
          false,
          'Same normalized artist and title, duration within 2s. Likely duplicates — worth a look before applying.',
        ),
      )
    } else if (!withinTolerance(bucket, opts.variantThresholdMs)) {
      // Same name, meaningfully different length → different recording.
      claim(
        makeGroup(
          bucket,
          'VARIANT',
          0.5,
          true,
          'Same artist and title but the durations differ by more than 5s. This is usually a live, extended or remixed take — both are kept unless you say otherwise.',
        ),
      )
    } else {
      // Between 2s and 5s: ambiguous. Group as fuzzy at lower confidence for review.
      claim(
        makeGroup(
          bucket,
          'FUZZY',
          0.7,
          false,
          'Same artist and title, durations differ by 2–5s. Could be a different master or a different take — review before applying.',
        ),
      )
    }
  }

  return groups
}

/** Groups eligible for auto-resolution. Never variants, never below the threshold. */
export function autoResolvable(
  groups: DuplicateGroupResult[],
  opts: DedupeOptions = DEDUPE_DEFAULTS,
): DuplicateGroupResult[] {
  return groups.filter(
    (g) => !g.variant && g.confidence >= opts.autoResolveAt && g.keeperId !== null,
  )
}

export interface TrashPlanEntry {
  fileId: string
  from: string
  to: string
}

/**
 * Plan the moves for a set of groups. Pure — produces the manifest that the worker
 * executes and that Undo replays in reverse. Nothing is moved here.
 *
 * Relative paths under the library root are preserved inside the trash so a restore is
 * unambiguous and two files with the same basename cannot collide.
 */
export function planTrashMoves(
  groups: DuplicateGroupResult[],
  filesById: Map<string, DedupeFile>,
  musicRoot: string,
  trashRoot: string,
): TrashPlanEntry[] {
  const plan: TrashPlanEntry[] = []
  const root = musicRoot.replace(/\/+$/, '')
  const trash = trashRoot.replace(/\/+$/, '')

  for (const g of groups) {
    if (g.variant || !g.keeperId) continue
    for (const id of g.memberIds) {
      if (id === g.keeperId) continue
      const f = filesById.get(id)
      if (!f) continue
      const rel = f.path.startsWith(root + '/') ? f.path.slice(root.length + 1) : f.path.replace(/^\/+/, '')
      plan.push({ fileId: id, from: f.path, to: `${trash}/${rel}` })
    }
  }
  return plan
}
