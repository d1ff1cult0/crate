import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  describeRange,
  paginate,
  parsePageRequest,
} from '../src/pagination.js'

describe('parsePageRequest', () => {
  it('defaults to page 1 at 50 per page', () => {
    expect(parsePageRequest({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE })
  })

  it('reads numeric strings from a query string', () => {
    expect(parsePageRequest({ page: '3', pageSize: '25' })).toEqual({ page: 3, pageSize: 25 })
  })

  it('clamps a hand-edited page to 1 rather than producing a negative skip', () => {
    expect(parsePageRequest({ page: '0' }).page).toBe(1)
    expect(parsePageRequest({ page: '-5' }).page).toBe(1)
    expect(parsePageRequest({ page: 'banana' }).page).toBe(1)
  })

  it('caps pageSize so a query string cannot ask for the whole table', () => {
    expect(parsePageRequest({ pageSize: '100000' }).pageSize).toBe(MAX_PAGE_SIZE)
  })

  it('rejects a nonsense pageSize back to the default', () => {
    expect(parsePageRequest({ pageSize: '0' }).pageSize).toBe(DEFAULT_PAGE_SIZE)
    expect(parsePageRequest({ pageSize: 'lots' }).pageSize).toBe(DEFAULT_PAGE_SIZE)
  })

  it('floors fractional input', () => {
    expect(parsePageRequest({ page: '2.9', pageSize: '10.7' })).toEqual({ page: 2, pageSize: 10 })
  })
})

describe('paginate', () => {
  it('computes the first page of a large set', () => {
    const p = paginate({ page: 1, pageSize: 50 }, 3412)
    expect(p).toMatchObject({
      page: 1, totalPages: 69, skip: 0, take: 50, hasPrev: false, hasNext: true, from: 1, to: 50,
    })
  })

  it('computes a middle page', () => {
    const p = paginate({ page: 2, pageSize: 50 }, 3412)
    expect(p).toMatchObject({ skip: 50, from: 51, to: 100, hasPrev: true, hasNext: true })
  })

  it('computes a partial last page', () => {
    const p = paginate({ page: 69, pageSize: 50 }, 3412)
    // 3412 = 68 full pages (3400) + 12
    expect(p).toMatchObject({ page: 69, skip: 3400, from: 3401, to: 3412, hasNext: false })
  })

  it('clamps a page past the end to the last page', () => {
    // Deleting the only row on page 12 must not leave "Page 12 of 11" and an empty list.
    const p = paginate({ page: 999, pageSize: 50 }, 120)
    expect(p.page).toBe(3)
    expect(p.hasNext).toBe(false)
    expect(p.to).toBe(120)
  })

  it('handles an empty set without claiming page 0 of 0', () => {
    const p = paginate({ page: 1, pageSize: 50 }, 0)
    expect(p).toMatchObject({ page: 1, totalPages: 1, from: 0, to: 0, hasPrev: false, hasNext: false })
  })

  it('handles exactly one full page', () => {
    const p = paginate({ page: 1, pageSize: 50 }, 50)
    expect(p).toMatchObject({ totalPages: 1, from: 1, to: 50, hasNext: false })
  })

  it('handles one row', () => {
    expect(paginate({ page: 1, pageSize: 50 }, 1)).toMatchObject({ from: 1, to: 1, totalPages: 1 })
  })

  it('never produces a negative skip or take', () => {
    for (const total of [0, 1, 49, 50, 51, 3412]) {
      for (const page of [1, 2, 1000]) {
        const p = paginate({ page, pageSize: 50 }, total)
        expect(p.skip).toBeGreaterThanOrEqual(0)
        expect(p.take).toBeGreaterThan(0)
        expect(p.to).toBeLessThanOrEqual(total)
      }
    }
  })

  it('reports the REAL total, not the size of the page', () => {
    // The bug this replaces: 200 rows fetched, "200" rendered as the total.
    const p = paginate({ page: 1, pageSize: 50 }, 3412)
    expect(p.total).toBe(3412)
    expect(p.total).not.toBe(p.take)
  })
})

describe('describeRange', () => {
  it('describes a window honestly', () => {
    expect(describeRange(paginate({ page: 2, pageSize: 50 }, 3412), 'group')).toBe(
      'Showing 51–100 of 3,412 groups',
    )
  })

  it('says so when there is nothing', () => {
    expect(describeRange(paginate({ page: 1, pageSize: 50 }, 0), 'group')).toBe('No groups')
  })

  it('does not pluralise a single item', () => {
    expect(describeRange(paginate({ page: 1, pageSize: 50 }, 1), 'group')).toBe(
      'Showing 1–1 of 1 group',
    )
  })
})
