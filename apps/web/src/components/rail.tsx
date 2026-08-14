'use client'

/**
 * Left rail navigation with uppercase labels and live counts (§9).
 *
 * Screen order follows §8 — the order the owner will actually use them, not
 * alphabetical and not by implementation status.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

interface NavItem {
  href: string
  label: string
  /** Which count from /api/counts to show, when there is one. */
  countKey?: string
}

const NAV: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/import', label: 'Import' },
  { href: '/playlists', label: 'Playlists', countKey: 'playlists' },
  { href: '/queue', label: 'Queue', countKey: 'queue' },
  { href: '/review', label: 'Review', countKey: 'review' },
  { href: '/duplicates', label: 'Duplicates', countKey: 'duplicates' },
  { href: '/mixes', label: 'Mixes' },
  { href: '/library', label: 'Library', countKey: 'library' },
  { href: '/settings', label: 'Settings' },
]

export function Rail() {
  const pathname = usePathname()
  const [counts, setCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/counts')
        if (!res.ok) return
        const data = (await res.json()) as Record<string, number>
        if (!cancelled) setCounts(data)
      } catch {
        // A failed count refresh must never break navigation.
      }
    }
    void load()
    const timer = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <nav
      aria-label="Sections"
      className="shrink-0 border-b border-hairline bg-surface md:min-h-screen md:w-52 md:border-b-0 md:border-r"
    >
      <div className="flex items-baseline gap-2 px-4 py-4 md:px-5">
        <span className="font-display text-base font-bold uppercase tracking-[0.18em] text-ink">
          Crate
        </span>
      </div>

      <ul className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0 md:overflow-visible md:px-2 md:pb-4">
        {NAV.map((item) => {
          const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
          const count = item.countKey ? counts[item.countKey] : undefined
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center justify-between gap-3 whitespace-nowrap rounded-[4px] px-3 py-2 transition-state ${
                  active ? 'bg-recess text-ink' : 'text-ink-muted hover:bg-recess hover:text-ink'
                }`}
              >
                <span className="font-display text-[11px] font-semibold uppercase tracking-[0.09em]">
                  {item.label}
                </span>
                {count !== undefined && count > 0 && (
                  <span className="data text-[11px] text-ink-muted">{count}</span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
