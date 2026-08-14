/**
 * Typed settings over the Setting key/value table.
 *
 * Everything the owner will want to tune lives here rather than as a constant in code —
 * §11 says the matching weights and scoring thresholds get hand-tuned, and a redeploy
 * per tuning pass would make that miserable.
 */

import { prisma } from '@crate/db'
import { z } from 'zod'

export const PathMappingSchema = z.object({
  appPath: z.string().min(1),
  navidromePath: z.string().min(1),
})

export const SettingsSchema = z.object({
  // ── Paths (§5) ──────────────────────────────────────────
  musicRoot: z.string().default('/music'),
  stagingRoot: z.string().default('/staging'),
  trashRoot: z.string().default('/trash'),
  pathMappings: z.array(PathMappingSchema).default([]),
  playlistTemplate: z.string().default('{albumartist}/{album} ({year})/{disc}-{track:02} {title}.{ext}'),
  m3uAbsolutePaths: z.boolean().default(false),

  // ── Spotify (docs/spotify-api-state.md finding D) ───────
  // No way to read this from the profile any more, and omitting it makes content read
  // as unavailable. Explicit configuration is the only correct answer.
  spotifyMarket: z.string().length(2).default('BE'),
  spotifyClientId: z.string().default(''),
  // Finding A: album tracks carry no ISRC. ON by default because the subscription
  // lapses 2026-09-01 and unspent quota before then is lost, not saved (DECISIONS D1).
  isrcBackfillEnabled: z.boolean().default(true),

  // ── Matching (§7.3) ─────────────────────────────────────
  matchAutoAcceptAt: z.number().min(0).max(1).default(0.9),
  matchReviewFloorAt: z.number().min(0).max(1).default(0.6),
  matchDurationToleranceMs: z.number().int().default(3000),
  matchDurationVetoMs: z.number().int().default(10_000),
  matchVariantPenalty: z.number().min(0).max(1).default(0.3),

  // ── Scanning (§7.4, DECISIONS A8) ───────────────────────
  scanConcurrency: z.number().int().min(1).max(16).default(4),
  fingerprintConcurrency: z.number().int().min(1).max(8).default(2),
  fingerprintEnabled: z.boolean().default(true),

  // ── Dedupe (§7.7) ───────────────────────────────────────
  // Dry run is the default and destructive application stays opt-in (DECISIONS A13).
  dedupeDryRunOnly: z.boolean().default(true),
  dedupeAutoResolveAt: z.number().min(0).max(1).default(0.98),
  trashRetentionDays: z.number().int().default(30),
  trashRetentionEnabled: z.boolean().default(false),

  // ── Recommendations (§7.8) ──────────────────────────────
  affinityHalfLifeDays: z.number().int().default(90),
  mixCount: z.number().int().min(1).max(12).default(6),
  mixSize: z.number().int().default(50),
  mixDiscoveryRatio: z.number().min(0).max(0.5).default(0.2),
  // D7: a PENALTY, not a hard exclusion. Daily Mix works partly because it replays
  // things you like; a hard 14-day ban makes mixes out of what you skipped.
  mixRecencyPenaltyDays: z.number().int().default(14),
  mixRecencyPenaltyWeight: z.number().min(0).max(1).default(0.6),
  mixMaxPerArtist: z.number().int().default(2),
  autoDownloadDiscovery: z.boolean().default(false),

  // ── LLM curator (§7.8) ──────────────────────────────────
  llmEnabled: z.boolean().default(true),
  llmBackend: z.enum(['ollama', 'anthropic']).default('ollama'),
  llmEndpoint: z.string().default('http://localhost:11434'),
  llmModel: z.string().default('gemma3'),
})

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

const SETTINGS_KEY = 'app'

export async function loadSettings(): Promise<Settings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } })
  if (!row) return DEFAULT_SETTINGS
  // Permissive: an unknown or removed key must never stop the app from booting.
  const parsed = SettingsSchema.safeParse(row.value)
  return parsed.success ? parsed.data : DEFAULT_SETTINGS
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = SettingsSchema.parse({ ...current, ...patch })
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next as object },
    update: { value: next as object },
  })
  return next
}
