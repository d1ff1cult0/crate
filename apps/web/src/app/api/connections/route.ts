/**
 * Save provider credentials.
 *
 * Secrets are encrypted before they touch the database and are NEVER returned by GET —
 * §11: "Never send a provider credential to the client." The editor shows whether a
 * credential is set, not what it is.
 *
 * Each provider is verified at save time where that's cheap, so a typo is caught here
 * rather than three days later inside a failed job.
 */

import { prisma } from '@crate/db'
import { ListenbrainzClient, SubsonicClient } from '@crate/integrations'
import { z } from 'zod'
import { encryptJson } from '../../../lib/crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NavidromeSchema = z.object({
  provider: z.literal('navidrome'),
  baseUrl: z.string().url('Navidrome needs a full URL, e.g. http://navidrome:4533'),
  username: z.string().min(1),
  password: z.string().min(1),
})

/**
 * ListenBrainz. The token is OPTIONAL: artist and recording similarity is open data and
 * needs no auth at all, so the connection is useful with nothing but the box ticked. A
 * token additionally imports the user's own listens into the taste model.
 */
const ListenbrainzSchema = z.object({
  provider: z.literal('listenbrainz'),
  token: z.string().optional(),
  username: z.string().optional(),
})

const AcoustidSchema = z.object({
  provider: z.literal('acoustid'),
  apiKey: z.string().min(1),
})

const LidarrSchema = z.object({
  provider: z.literal('lidarr'),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
})

const OllamaSchema = z.object({
  provider: z.literal('ollama'),
  endpoint: z.string().url(),
  model: z.string().min(1),
})

const BodySchema = z.discriminatedUnion('provider', [
  NavidromeSchema,
  ListenbrainzSchema,
  AcoustidSchema,
  LidarrSchema,
  OllamaSchema,
])

/** Credentials are never returned — only whether each provider is configured. */
export async function GET() {
  const connections = await prisma.connection.findMany({
    select: {
      provider: true,
      enabled: true,
      displayName: true,
      lastOkAt: true,
      lastError: true,
      secretCipher: true,
    },
  })

  return Response.json(
    connections.map((c) => ({
      provider: c.provider,
      enabled: c.enabled,
      displayName: c.displayName,
      lastOkAt: c.lastOkAt,
      lastError: c.lastError,
      hasSecret: Boolean(c.secretCipher),
    })),
  )
}

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'Those details are not valid.' },
      { status: 400 },
    )
  }

  const body = parsed.data
  let displayName: string | null = null
  let verifyError: string | null = null

  // Verify now where it is cheap, so a typo surfaces immediately.
  try {
    if (body.provider === 'navidrome') {
      const ping = await new SubsonicClient({
        baseUrl: body.baseUrl,
        username: body.username,
        password: body.password,
      }).ping()
      if (!ping.ok) verifyError = 'Navidrome rejected those credentials.'
      else displayName = `${ping.type ?? 'navidrome'} ${ping.serverVersion ?? ''}`.trim()
    } else if (body.provider === 'listenbrainz') {
      const client = new ListenbrainzClient({ token: body.token })
      const health = await client.health()
      if (!health.ok) verifyError = health.detail
      else if (body.token) {
        // Derive the username from the token rather than making the owner type it —
        // it is one fewer thing to get wrong, and the listen import needs it exactly
        // right or it silently returns nothing.
        const validated = await client.validateToken()
        if (!validated.valid) verifyError = validated.detail
        else displayName = validated.username ?? body.username ?? null
      } else {
        displayName = body.username ?? null
      }
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // Node's bare "fetch failed" tells the owner nothing. §9: errors say what happened
    // and what to do — and inside Docker an unreachable host is nearly always a URL
    // that works in the browser but not from this container.
    verifyError = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout/i.test(raw)
      ? `Could not reach that address from inside this container (${raw}). A URL that works in your browser is often wrong here — use the Docker service name and internal port, e.g. http://navidrome:4533 rather than a localhost address.`
      : raw
  }

  if (verifyError) {
    return Response.json({ error: verifyError }, { status: 400 })
  }

  const { provider, ...secret } = body

  await prisma.connection.upsert({
    where: { provider },
    create: {
      provider,
      enabled: true,
      displayName,
      secretCipher: encryptJson(secret),
      lastOkAt: new Date(),
      lastError: null,
    },
    update: {
      enabled: true,
      displayName,
      secretCipher: encryptJson(secret),
      lastOkAt: new Date(),
      lastError: null,
    },
  })

  return Response.json({ ok: true, provider, displayName })
}

export async function DELETE(request: Request) {
  const provider = new URL(request.url).searchParams.get('provider')
  if (!provider) return Response.json({ error: 'No provider given' }, { status: 400 })

  await prisma.connection
    .update({
      where: { provider },
      // Disable and clear the secret rather than deleting the row, so history and
      // last-error context survive a reconnect.
      data: { enabled: false, secretCipher: null, lastError: null },
    })
    .catch(() => undefined)

  return Response.json({ ok: true })
}
