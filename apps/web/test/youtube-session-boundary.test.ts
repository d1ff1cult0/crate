import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('YouTube import session boundary', () => {
  it('uses the common session guard and contains no standalone token workaround', async () => {
    const [route, component, compose, env] = await Promise.all([
      readFile('src/app/api/import/youtube/route.ts', 'utf8'),
      readFile('src/components/youtube-playlist-import.tsx', 'utf8'),
      readFile('../../docker-compose.yml', 'utf8'),
      readFile('../../.env.example', 'utf8'),
    ])
    expect(route).toContain('requireApiSession(request)')
    expect(`${route}${component}${compose}${env}`).not.toContain('CRATE_YOUTUBE_IMPORT_TOKEN')
    expect(component).not.toContain('sessionStorage')
    expect(component).not.toContain('x-crate-youtube-import-token')
  })
})
