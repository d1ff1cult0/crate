/**
 * Shared primitives. PROMPT.md §9 — hairlines not shadows, radius ≤ 4px, primary
 * buttons solid ink, amber reserved for things currently happening.
 */

import type { ReactNode } from 'react'

export function Panel({
  title,
  action,
  children,
  className = '',
}: {
  title?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-4 border-b border-hairline px-4 py-2.5">
          <h2 className="label">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  // Solid ink, per §9 — deliberately not the accent, which is reserved for activity.
  primary: 'bg-ink text-surface hover:bg-ink/90 border-ink',
  secondary: 'bg-surface text-ink hover:bg-recess border-hairline',
  danger: 'bg-surface text-error hover:bg-error/5 border-error/40',
  ghost: 'bg-transparent text-ink-muted hover:text-ink hover:bg-recess border-transparent',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  className = '',
  ...props
}: {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const padding = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-[4px] border font-medium transition-state disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_STYLES[variant]} ${padding} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export type StatusTone = 'ok' | 'warn' | 'error' | 'active' | 'idle'

const STATUS_DOT: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-error',
  active: 'bg-accent',
  idle: 'bg-ink-muted/40',
}

export function StatusDot({ tone, label }: { tone: StatusTone; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[tone]}`} aria-hidden />
      {label && <span className="text-sm text-ink">{label}</span>}
    </span>
  )
}

export function Badge({ tone = 'idle', children }: { tone?: StatusTone; children: ReactNode }) {
  const styles: Record<StatusTone, string> = {
    ok: 'border-ok/30 text-ok bg-ok/5',
    warn: 'border-warn/30 text-warn bg-warn/5',
    error: 'border-error/30 text-error bg-error/5',
    active: 'border-accent/40 text-warn bg-accent/10',
    idle: 'border-hairline text-ink-muted bg-recess',
  }
  return (
    <span
      className={`inline-flex items-center rounded-[3px] border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide ${styles[tone]}`}
    >
      {children}
    </span>
  )
}

/**
 * Empty state. §8: "every empty state explaining what to do rather than saying 'no
 * data'". §11: "Don't mock anything into the UI. If a feature isn't built, the screen
 * says so." Both are the same component.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="recess flex flex-col items-start gap-2 rounded-[4px] border border-hairline p-6">
      <h3 className="font-medium text-ink">{title}</h3>
      <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{children}</p>
      {action && <div className="pt-2">{action}</div>}
    </div>
  )
}

/** A number with its label, mono and tabular. The status-board building block. */
export function Readout({
  label,
  value,
  suffix,
  tone,
}: {
  label: string
  value: string | number
  suffix?: string
  tone?: 'ok' | 'warn' | 'error'
}) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'error' ? 'text-error' : 'text-ink'
  return (
    <div className="space-y-1">
      <div className="label">{label}</div>
      <div className={`data text-2xl leading-none ${color}`}>
        {value}
        {suffix && <span className="ml-1 text-sm text-ink-muted">{suffix}</span>}
      </div>
    </div>
  )
}

export function Hairline() {
  return <div className="h-px w-full bg-hairline" />
}
