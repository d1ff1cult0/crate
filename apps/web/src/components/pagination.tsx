/**
 * Pager shared by Duplicates, Review and Queue.
 *
 * Deliberately shows "Page 3 of 69" and "Showing 101–150 of 3,412" rather than the size
 * of the current slice. The screens previously fetched up to 200 rows and rendered that
 * length as the total, which is not a truncated number but a wrong one.
 *
 * Links rather than buttons: paging is a navigation, so it belongs in the URL. That makes
 * a page shareable, survives a refresh, and lets the browser's back button do the obvious
 * thing — none of which is true of paging held in component state.
 */

import Link from 'next/link'
import type { Pagination } from '@crate/core'
import { Button } from './ui'

export function Pager({
  pagination,
  basePath,
  noun = 'item',
  plural,
  extraParams,
}: {
  pagination: Pagination
  basePath: string
  noun?: string
  /** Supply when appending "s" is wrong — "match" → "matches", not "matchs". */
  plural?: string
  /** Preserved across page changes, e.g. a filter. */
  extraParams?: Record<string, string>
}) {
  const href = (page: number): string => {
    const params = new URLSearchParams({ ...extraParams, page: String(page) })
    if (pagination.pageSize !== 50) params.set('pageSize', String(pagination.pageSize))
    return `${basePath}?${params.toString()}`
  }

  const plurals = plural ?? `${noun}s`
  const range =
    pagination.total === 0
      ? `No ${plurals}`
      : `Showing ${pagination.from.toLocaleString()}–${pagination.to.toLocaleString()} of ${pagination.total.toLocaleString()} ${pagination.total === 1 ? noun : plurals}`

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
      <span className="data text-xs text-ink-muted">{range}</span>

      <div className="flex items-center gap-2">
        <span className="data text-xs text-ink-muted">
          Page {pagination.page.toLocaleString()} of {pagination.totalPages.toLocaleString()}
        </span>

        {pagination.hasPrev ? (
          <Link href={href(pagination.page - 1)} prefetch={false}>
            <Button size="sm">← Prev</Button>
          </Link>
        ) : (
          <Button size="sm" disabled>
            ← Prev
          </Button>
        )}

        {pagination.hasNext ? (
          <Link href={href(pagination.page + 1)} prefetch={false}>
            <Button size="sm">Next →</Button>
          </Link>
        ) : (
          <Button size="sm" disabled>
            Next →
          </Button>
        )}
      </div>
    </div>
  )
}
