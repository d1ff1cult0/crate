/**
 * Segmented meter — the signature element (PROMPT.md §9).
 *
 * "Progress, library coverage, provider health, and match confidence all render as
 * segmented LED-style ladders rather than smooth bars — discrete blocks with a lit/unlit
 * state. Use it consistently everywhere something has a level, and it becomes the thing
 * the app is recognized by."
 *
 * So this is the ONLY level display in the app. Nothing else draws a bar.
 *
 * Tone rules follow §9's colour discipline: amber means "currently happening", and an
 * idle screen should therefore carry almost none of it.
 */

export type MeterTone = 'active' | 'ok' | 'warn' | 'error' | 'neutral'

const TONE_LIT: Record<MeterTone, string> = {
  active: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-error',
  neutral: 'bg-ink',
}

export interface SegmentedMeterProps {
  /** 0–1. Values outside are clamped. */
  value: number
  segments?: number
  tone?: MeterTone
  /** Height of each segment. */
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
}

export function SegmentedMeter({
  value,
  segments = 20,
  tone = 'neutral',
  size = 'md',
  className = '',
  'aria-label': ariaLabel,
}: SegmentedMeterProps) {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const lit = Math.round(clamped * segments)
  const height = size === 'sm' ? 'h-2' : 'h-3.5'

  return (
    <div
      className={`flex gap-px ${className}`}
      role="meter"
      aria-valuenow={Math.round(clamped * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel ?? 'level'}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`${height} flex-1 transition-state ${
            i < lit ? TONE_LIT[tone] : 'bg-hairline/60'
          }`}
        />
      ))}
    </div>
  )
}

/** Meter plus its readout — the common pairing, kept consistent across screens. */
export function MeterRow({
  label,
  value,
  detail,
  tone = 'neutral',
  segments,
}: {
  label: string
  value: number
  detail: string
  tone?: MeterTone
  segments?: number
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="label">{label}</span>
        <span className="data text-sm text-ink">{detail}</span>
      </div>
      <SegmentedMeter value={value} tone={tone} segments={segments} aria-label={label} />
    </div>
  )
}

/**
 * Confidence rendered as a short ladder — used in the review queue where a full-width
 * meter would dominate a dense table row.
 */
export function ConfidenceMeter({ confidence }: { confidence: number }) {
  const tone: MeterTone = confidence >= 0.9 ? 'ok' : confidence >= 0.6 ? 'warn' : 'error'
  return (
    <div className="flex items-center gap-2">
      <SegmentedMeter value={confidence} segments={10} tone={tone} size="sm" className="w-20" />
      <span className="data text-xs text-ink-muted">{confidence.toFixed(2)}</span>
    </div>
  )
}
