import { describe, expect, it } from 'vitest'
import {
  bullPriority,
  downloadJobId,
  isPendingState,
  planQueueReconciliation,
  type QueueJobState,
  type ReconcilableRequest,
} from '../src/download-queue.js'

/**
 * The production defect this covers: 168 DownloadRequest rows sat at QUEUED with nothing
 * in Redis — no jobs, no attempts, no job runs, and no errors, because nothing had
 * failed. The work had never been asked for.
 */

const req = (over: Partial<ReconcilableRequest> & { id: string }): ReconcilableRequest => ({
  status: 'QUEUED',
  priority: 0,
  ...over,
})

describe('downloadJobId', () => {
  it('is deterministic, so double-enqueueing is a no-op rather than a duplicate', () => {
    expect(downloadJobId('abc')).toBe(downloadJobId('abc'))
  })

  it('never contains a colon — BullMQ rejects those outright (DECISIONS A19)', () => {
    expect(downloadJobId('a:b c')).not.toContain(':')
  })
})

describe('isPendingState', () => {
  it('treats every state that will still run as pending', () => {
    for (const state of [
      'waiting',
      'waiting-children',
      'prioritized',
      'active',
      'delayed',
      'paused',
    ] as const) {
      expect(isPendingState(state)).toBe(true)
    }
  })

  it('counts "prioritized" as pending — download jobs always carry a priority', () => {
    // Verified against real BullMQ: a job added with a priority reports state
    // "prioritized", never "waiting", and is counted separately from `wait`. Treating it
    // as finished made every reconcile remove and re-add every healthy job, forever.
    expect(isPendingState('prioritized')).toBe(true)
  })

  it('treats finished states as NOT pending — they occupy the id but will never run', () => {
    // This is the distinction the whole fix rests on. A completed job blocks add() just
    // as effectively as a waiting one, but nothing is going to execute it.
    expect(isPendingState('completed')).toBe(false)
    expect(isPendingState('failed')).toBe(false)
  })
})

describe('planQueueReconciliation', () => {
  it('enqueues a QUEUED request that has no job at all — the production bug', () => {
    const plan = planQueueReconciliation([req({ id: 'r1' })], new Map())
    expect(plan.enqueue).toBe(1)
    expect(plan.actions[0]).toMatchObject({ action: 'enqueue', requestId: 'r1' })
  })

  it('reproduces the exact production shape: 168 orphans, nothing in Redis', () => {
    const requests = Array.from({ length: 168 }, (_, i) => req({ id: `r${i}` }))
    const plan = planQueueReconciliation(requests, new Map())
    expect(plan.enqueue).toBe(168)
    expect(plan.skip).toBe(0)
    expect(plan.replace).toBe(0)
  })

  it('leaves a request alone when a pending job already exists', () => {
    const states = new Map<string, QueueJobState>([[downloadJobId('r1'), 'waiting']])
    const plan = planQueueReconciliation([req({ id: 'r1' })], states)
    expect(plan.skip).toBe(1)
    expect(plan.enqueue).toBe(0)
  })

  it('leaves a PRIORITIZED job alone — the state every real download job is in', () => {
    const states = new Map<string, QueueJobState>([[downloadJobId('r1'), 'prioritized']])
    const plan = planQueueReconciliation([req({ id: 'r1', priority: 3 })], states)
    expect(plan.skip).toBe(1)
    expect(plan.replace).toBe(0)
    expect(plan.enqueue).toBe(0)
  })

  it('leaves an ACTIVE job alone — re-adding would fight a download in flight', () => {
    const states = new Map<string, QueueJobState>([[downloadJobId('r1'), 'active']])
    expect(planQueueReconciliation([req({ id: 'r1' })], states).skip).toBe(1)
  })

  it('REPLACES when a completed job still occupies the id', () => {
    // Verified against real BullMQ: add() with an id held by a completed job returns the
    // old job, adds nothing, and reports no error. Without removing it first, recovery
    // silently does nothing — the same invisible failure all over again.
    const states = new Map<string, QueueJobState>([[downloadJobId('r1'), 'completed']])
    const plan = planQueueReconciliation([req({ id: 'r1' })], states)
    expect(plan.replace).toBe(1)
    expect(plan.actions[0]).toMatchObject({ action: 'replace', staleState: 'completed' })
  })

  it('replaces a failed job too', () => {
    const states = new Map<string, QueueJobState>([[downloadJobId('r1'), 'failed']])
    expect(planQueueReconciliation([req({ id: 'r1' })], states).replace).toBe(1)
  })

  it('rescues a RUNNING request orphaned by a worker that died mid-flight', () => {
    // Nobody would think to look for these: the row says RUNNING, so it reads as
    // healthy, but no job exists and it will never move again.
    const plan = planQueueReconciliation([req({ id: 'r1', status: 'RUNNING' })], new Map())
    expect(plan.enqueue).toBe(1)
  })

  it('ignores statuses that are not supposed to have a job behind them', () => {
    const requests = [
      req({ id: 'a', status: 'SUCCEEDED' }),
      req({ id: 'b', status: 'ABANDONED' }),
      req({ id: 'c', status: 'MANUAL_HOLD' }),
      req({ id: 'd', status: 'FAILED' }),
    ]
    expect(planQueueReconciliation(requests, new Map()).actions).toHaveLength(0)
  })

  it('handles a realistic mixture in one pass', () => {
    const states = new Map<string, QueueJobState>([
      [downloadJobId('pending'), 'waiting'],
      [downloadJobId('stale'), 'completed'],
    ])
    const plan = planQueueReconciliation(
      [
        req({ id: 'orphan' }),
        req({ id: 'pending' }),
        req({ id: 'stale' }),
        req({ id: 'done', status: 'SUCCEEDED' }),
      ],
      states,
    )
    expect({ enqueue: plan.enqueue, replace: plan.replace, skip: plan.skip }).toEqual({
      enqueue: 1,
      replace: 1,
      skip: 1,
    })
  })

  it('is idempotent: running it against its own result changes nothing', () => {
    const requests = [req({ id: 'r1' }), req({ id: 'r2' })]
    const first = planQueueReconciliation(requests, new Map())
    expect(first.enqueue).toBe(2)

    // Everything it added is now prioritized — the state BullMQ actually puts a
    // priority-carrying job into, which is what these jobs always are.
    const after = new Map<string, QueueJobState>(
      first.actions.map((a) => [a.jobId, 'prioritized' as QueueJobState]),
    )
    const second = planQueueReconciliation(requests, after)
    expect(second.enqueue).toBe(0)
    expect(second.replace).toBe(0)
    expect(second.skip).toBe(2)
  })
})

describe('bullPriority', () => {
  it('inverts our scale — BullMQ runs LOWER numbers sooner', () => {
    // DownloadRequest.priority counts playlist memberships, so higher is more wanted.
    expect(bullPriority(10)).toBeLessThan(bullPriority(1))
  })

  it('never returns 0, which BullMQ treats as "no priority" rather than "most urgent"', () => {
    expect(bullPriority(100)).toBeGreaterThanOrEqual(1)
    expect(bullPriority(9999)).toBeGreaterThanOrEqual(1)
  })

  it('stays within a sane band', () => {
    expect(bullPriority(-9999)).toBeLessThanOrEqual(1000)
  })
})
