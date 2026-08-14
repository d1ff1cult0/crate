/**
 * Runs the path-mapping diagnostic (PROMPT.md §5).
 *
 * This one genuinely belongs in a route handler rather than a Server Action: it writes a
 * probe file and polls Navidrome, and the client needs the structured step list back to
 * render which segment of the mapping is wrong.
 */

import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '@crate/db'
import { SubsonicClient, verifyPaths } from '@crate/integrations'
import { decryptSecret } from '../../../../lib/crypto'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 180

export async function POST() {
  const [settingRow, connection, sampleFile] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'app' } }),
    prisma.connection.findUnique({ where: { provider: 'navidrome' } }),
    prisma.libraryFile.findFirst({ where: { missingSince: null }, select: { path: true } }),
  ])

  const settings = (settingRow?.value ?? {}) as {
    musicRoot?: string
    pathMappings?: Array<{ appPath: string; navidromePath: string }>
  }

  if (!connection?.secretCipher) {
    return Response.json({
      ok: false,
      summary: 'Navidrome is not connected yet. Add its URL and credentials first.',
      steps: [
        {
          name: 'Navidrome connection',
          status: 'failed',
          detail: 'No Navidrome connection is configured.',
          remedy: 'Add the Navidrome base URL, username and password in Connections above.',
        },
      ],
    })
  }

  const creds = JSON.parse(decryptSecret(connection.secretCipher)) as {
    baseUrl: string
    username: string
    password: string
  }

  const musicRoot = process.env.MUSIC_ROOT ?? settings.musicRoot ?? '/music'

  const result = await verifyPaths({
    subsonic: new SubsonicClient(creds),
    mappings: settings.pathMappings ?? [],
    musicRoot,
    sampleFilePath: sampleFile?.path,
    writeProbe: async (relativePath, content) => {
      const absolute = join(musicRoot, relativePath)
      await writeFile(absolute, content, 'utf8')
      return absolute
    },
    deleteProbe: async (absolute) => {
      await unlink(absolute)
    },
  })

  return Response.json(result)
}
