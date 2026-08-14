import { prisma } from '@crate/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const PatchSchema = z
  .object({
    pathMappings: z
      .array(z.object({ appPath: z.string(), navidromePath: z.string() }))
      .optional(),
    spotifyMarket: z.string().length(2).optional(),
    isrcBackfillEnabled: z.boolean().optional(),
    matchAutoAcceptAt: z.number().min(0).max(1).optional(),
    matchReviewFloorAt: z.number().min(0).max(1).optional(),
    dedupeDryRunOnly: z.boolean().optional(),
    mixRecencyPenaltyDays: z.number().int().optional(),
    mixRecencyPenaltyWeight: z.number().min(0).max(1).optional(),
  })
  .strict()

export async function GET() {
  const row = await prisma.setting.findUnique({ where: { key: 'app' } })
  return Response.json(row?.value ?? {})
}

export async function POST(request: Request) {
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
