import { prisma } from '@crate/db'
import { z } from 'zod'
import { isUnauthorized, requireApiSession } from '../../../lib/session'

export const dynamic = 'force-dynamic'

const PatchSchema = z
  .object({
    pathMappings: z
      .array(z.object({ appPath: z.string(), navidromePath: z.string() }))
      .optional(),
    spotifyMarket: z.string().length(2).optional(),
    // Not a secret — the client ID is public by design in a PKCE flow, so it lives in
    // settings rather than in the encrypted Connection record.
    spotifyClientId: z.string().max(128).optional(),
    isrcBackfillEnabled: z.boolean().optional(),
    matchAutoAcceptAt: z.number().min(0).max(1).optional(),
    matchReviewFloorAt: z.number().min(0).max(1).optional(),
    dedupeDryRunOnly: z.boolean().optional(),
    downloadEnabled: z.boolean().optional(),
    trashRetentionEnabled: z.boolean().optional(),
    trashRetentionDays: z.number().int().min(1).max(3650).optional(),
    mixRecencyPenaltyDays: z.number().int().optional(),
    mixRecencyPenaltyWeight: z.number().min(0).max(1).optional(),
  })
  .strict()

export async function GET(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const row = await prisma.setting.findUnique({ where: { key: 'app' } })
  return Response.json(row?.value ?? {})
}

export async function POST(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? 'Bad request' }, { status: 400 })
  }

  const existing = await prisma.setting.findUnique({ where: { key: 'app' } })
  const merged = { ...((existing?.value as object) ?? {}), ...parsed.data }

  await prisma.setting.upsert({
    where: { key: 'app' },
    create: { key: 'app', value: merged },
    update: { value: merged },
  })

  return Response.json(merged)
}
