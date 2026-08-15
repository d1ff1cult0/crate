import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(resolve(process.cwd(), '../../packages/db/prisma/migrations/20260815180000_download_request_source_track_unique/migration.sql'), 'utf8')

describe('DownloadRequest dedupe migration', () => {
  it('keeps pending job identity, reattaches attempts, then enforces uniqueness', () => {
    expect(sql).toMatch(/WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1/)
    expect(sql.indexOf('UPDATE "DownloadAttempt"')).toBeLessThan(sql.indexOf('DELETE FROM "DownloadRequest"'))
    expect(sql).toContain('CREATE UNIQUE INDEX "DownloadRequest_sourceTrackId_key"')
  })
})
