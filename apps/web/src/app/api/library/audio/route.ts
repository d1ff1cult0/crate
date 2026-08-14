/**
 * Inline audio preview for the duplicate review (§7.7: "inline audio preview of each
 * candidate").
 *
 * Two safety properties, both load-bearing:
 *
 *  - **Lookup by file id, never by path.** The client never names a path, so there is no
 *    path parameter to traverse. The row's stored path is the only thing that can be read.
 *  - **A containment check anyway.** The resolved path must sit under `MUSIC_ROOT` or
 *    `TRASH_ROOT` — trash included so a file can be auditioned before deciding whether to
 *    undo. Belt and braces: a corrupted row should not turn this into an arbitrary file
 *    reader.
 *
 * Range requests are honoured so seeking in the player does not pull a whole FLAC.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { prisma } from '@crate/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CONTENT_TYPES: Record<string, string> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
}

function isUnder(child: string, parent: string): boolean {
  const p = resolve(parent)
  return child === p || child.startsWith(p + '/')
}

export async function GET(request: Request) {
  const fileId = new URL(request.url).searchParams.get('fileId')
  if (!fileId) return new Response('Missing fileId', { status: 400 })

  const file = await prisma.libraryFile.findUnique({
    where: { id: fileId },
    select: { path: true, format: true },
  })
  if (!file) return new Response('Not found', { status: 404 })

  const settings = await prisma.setting.findUnique({ where: { key: 'app' } })
  const config = (settings?.value ?? {}) as { musicRoot?: string; trashRoot?: string }
  const musicRoot = process.env.MUSIC_ROOT ?? config.musicRoot ?? '/music'
  const trashRoot = process.env.TRASH_ROOT ?? config.trashRoot ?? '/trash'

  const path = resolve(file.path)
  if (!isUnder(path, musicRoot) && !isUnder(path, trashRoot)) {
    return new Response('Refusing to serve a file outside the library roots', { status: 403 })
  }

  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return new Response('File is not on disk', { status: 404 })

  const contentType = CONTENT_TYPES[file.format.toLowerCase()] ?? 'application/octet-stream'
  const range = request.headers.get('range')

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match?.[1] ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : info.size - 1
    if (start >= info.size || end >= info.size || start > end) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${info.size}` },
      })
    }
    const stream = createReadStream(path, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
      },
    })
  }

  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(info.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    },
  })
}
