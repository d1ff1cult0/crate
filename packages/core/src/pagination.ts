/**
 * Server-side pagination.
 *
 * The screens that list things — Duplicates, Review, Queue — were fetching up to 200 rows
 * and rendering the length of that slice as if it were the total. On a library with
 * thousands of rows that is not a slow page, it is a **misleading** one: "200 duplicate
 * groups" when there are 3,000 is a wrong number, not a truncated one.
 *
 * So the count and the page are separate queries, and the total is always the real total.
 * Kept pure and shared so every screen paginates identically and the arithmetic — which
 * is where off-by-ones live — is tested once.
 */

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

export interface PageRequest {
  page: number
  pageSize: number
}

/**
 * Parse and clamp untrusted paging input.
 *
 * Everything here is a defence against a hand-edited query string: page 0, page -1,
 * pageSize 100000, `?page=banana`. Each would otherwise reach Prisma as a negative
 * `skip` or an unbounded `take`.
 */
export function parsePageRequest(
  params: { page?: string | number | null; pageSize?: string | number | null },
  defaults: { pageSize?: number } = {},
): PageRequest {
  const rawPage = Number(params.page ?? 1)
  const rawSize = Number(params.pageSize ?? defaults.pageSize ?? DEFAULT_PAGE_SIZE)

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1
  const pageSize =
    Number.isFinite(rawSize) && rawSize >= 1
      ? Math.min(MAX_PAGE_SIZE, Math.floor(rawSize))
      : (defaults.pageSize ?? DEFAULT_PAGE_SIZE)

  return { page, pageSize }
}

export interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
  skip: number
  take: number
  hasPrev: boolean
  hasNext: boolean
  /** 1-based index of the first row on this page; 0 when there are no rows. */
  from: number
  /** 1-based index of the last row on this page; 0 when there are no rows. */
  to: number
}

/**
 * Work out the window for a page, given the real total.
 *
 * A page beyond the end is clamped to the last page rather than returning nothing:
 * deleting the only row on page 12 should not leave the reader staring at an empty
 * screen that still says "Page 12 of 11".
 */
export function paginate(request: PageRequest, total: number): Pagination {
  const pageSize = Math.max(1, request.pageSize)
  const safeTotal = Math.max(0, total)
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize))
  const page = Math.min(Math.max(1, request.page), totalPages)

  const skip = (page - 1) * pageSize
  const rowsOnPage = Math.max(0, Math.min(pageSize, safeTotal - skip))

  return {
    page,
    pageSize,
    total: safeTotal,
    totalPages,
    skip,
    take: pageSize,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    from: rowsOnPage === 0 ? 0 : skip + 1,
    to: rowsOnPage === 0 ? 0 : skip + rowsOnPage,
  }
}

/** "Showing 51–100 of 3,412" — the honest version of a page-sized counter. */
export function describeRange(pagination: Pagination, noun = 'item', plural?: string): string {
  // `plural` exists because appending "s" is wrong often enough to matter — "match"
  // becomes "matches", and "51 matchs" undermines every other number on the page.
  const plurals = plural ?? `${noun}s`
  if (pagination.total === 0) return `No ${plurals}`
  const word = pagination.total === 1 ? noun : plurals
  return `Showing ${pagination.from.toLocaleString()}–${pagination.to.toLocaleString()} of ${pagination.total.toLocaleString()} ${word}`
}
