import { describe, expect, it } from 'vitest'
import { deriveYouTubeImportStatus, stablePlaylistBasename } from '../src/youtube-import.js'

describe('stablePlaylistBasename', () => {
  it('keeps colliding titles distinct by stable playlist identity', () => {
    expect(stablePlaylistBasename('Road Trip', 'playlist-a')).not.toBe(
      stablePlaylistBasename('Road Trip', 'playlist-b'),
    )
  })

  it('keeps sanitization collisions distinct', () => {
    expect(stablePlaylistBasename('AC/DC', 'playlist-a')).not.toBe(
      stablePlaylistBasename('AC:DC', 'playlist-b'),
    )
  })

  it('is deterministic for the same stable identity when a title changes', () => {
    expect(stablePlaylistBasename('Old title', 'playlist-a')).toBe(
      stablePlaylistBasename('New title', 'playlist-a'),
    )
  })
})

describe('deriveYouTubeImportStatus', () => {
  it('is partial when matched tracks were omitted from the m3u', () => {
    expect(deriveYouTubeImportStatus({ expected: 3, m3uEntries: 2, mappingOmissions: 1, outstanding: 0, failed: 0, invalidEntries: 0, navidromeSync: 'ok' }).status).toBe('PARTIAL')
  })

  it('is partial when Navidrome sync fails', () => {
    expect(deriveYouTubeImportStatus({ expected: 2, m3uEntries: 2, mappingOmissions: 0, outstanding: 0, failed: 0, invalidEntries: 0, navidromeSync: 'failed' }).status).toBe('PARTIAL')
  })

  it('only succeeds when every expected entry was written and synced', () => {
    expect(deriveYouTubeImportStatus({ expected: 2, m3uEntries: 2, mappingOmissions: 0, outstanding: 0, failed: 0, invalidEntries: 0, navidromeSync: 'ok' }).status).toBe('SUCCEEDED')
  })
})
