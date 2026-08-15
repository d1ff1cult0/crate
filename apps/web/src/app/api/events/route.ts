/**
 * SSE progress stream, backed by Redis pub/sub (PROMPT.md §4).
 *
 * A route handler rather than a Server Action, because §11 restricts route handlers to
 * exactly this kind of thing: webhooks, SSE and the OAuth callback.
 *
 * Deployment gotcha, also in CLAUDE.md: the reverse proxy in front of this must have
 * response buffering OFF for /api/events, or progress silently stops working in
 * production while remaining fine locally. `X-Accel-Buffering: no` covers nginx.
 */

import { Redis } from 'ioredis'
import { isUnauthorized, requireApiSession } from '../../../lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const PROGRESS_CHANNEL = 'crate:progress'

export async function GET(request: Request) {
  const session = await requireApiSession(request)
  if (isUnauthorized(session)) return session
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // A subscriber connection cannot issue ordinary commands, so it gets its own.
      const subscriber = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: null,
      })

      let closed = false
      const send = (data: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(data))
        } catch {
          closed = true
        }
      }

      send(': connected\n\n')

      await subscriber.subscribe(PROGRESS_CHANNEL)
      subscriber.on('message', (_channel, message) => {
        send(`data: ${message}\n\n`)
      })

      // Comment frames keep intermediaries from timing the connection out.
      const heartbeat = setInterval(() => send(': keepalive\n\n'), 20_000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        void subscriber.quit()
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      request.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
