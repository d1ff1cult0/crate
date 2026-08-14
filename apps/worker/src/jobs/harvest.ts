/**
 * The "Harvest everything" job — PROMPT.md §7.1, phase 1.5.
 *
 * This is the only work in the project with a real deadline: the owner's Premium lapses
 * 2026-09-01, after which the Spotify connector stops entirely and everything it could
 * have fetched is unobtainable. Priorities here, in order: don't lose data, be
 * resumable, be observable.
 *
 * The orchestration lives in @crate/integrations (pure, fully tested against a fake
 * Spotify). This file is only the Prisma-backed port plus the queue plumbing.
 */

import { normalizeTrack } from '@crate/core'
import { prisma } from '@crate/db'
import {
  harvestEverything,
  QuotaExceededError,
  SpotifyClient,
  refreshToken as refreshSpotifyToken,
  type HarvestCheckpoint,
  type HarvestPort,
  type HarvestSummary,
  type NormalizedSourceTrack,
} from '@crate/integrations'
import { decryptJson, encryptJson } from '../lib/crypto.js'
import type { JobRunContext } from '../lib/jobrun.js'
import { enqueue, jobId } from '../lib/queues.js'
import { loadSettings } from '../lib/settings.js'

const CHECKPOINT_KEY = 'spotify:harvest:checkpoint'

interface StoredSpotifySecret {
  accessToken: string
  refreshToken?: string
  expiresAt: string
}

/**
 * Token accessor that refreshes on demand. The refresh token is only ever decrypted
 * here in the worker — the web process never sees it (§11).
 */
async function makeTokenProvider(clientId: string) {
  let cached: StoredSpotifySecret | null = null

  const read = async (): Promise<StoredSpotifySecret> => {
    if (cached) return cached
    const conn = await prisma.connection.findUnique({ where: { provider: 'spotify' } })
    if (!conn?.secretCipher) {
      throw new Error('Spotify is not connected. Connect it in Settings before harvesting.')
    }
    cached = decryptJson<StoredSpotifySecret>(conn.secretCipher)
    return cached
  }

  const persist = async (secret: StoredSpotifySecret) => {
    cached = secret
    await prisma.connection.update({
      where: { provider: 'spotify' },
      data: {
        secretCipher: encryptJson(secret),
        expiresAt: new Date(secret.expiresAt),
        lastOkAt: new Date(),
      },
    })
  }

  const refresh = async (): Promise<string | null> => {
    const current = await read()
    if (!current.refreshToken) return null
    const next = await refreshSpotifyToken({ clientId, refreshToken: current.refreshToken })
    await persist({
      accessToken: next.accessToken,
      ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
      expiresAt: next.expiresAt.toISOString(),
    })
    return next.accessToken
  }

  return {
    async getAccessToken(): Promise<string> {
      const current = await read()
      if (new Date(current.expiresAt).getTime() <= Date.now()) {
        const refreshed = await refresh()
        if (refreshed) return refreshed
      }
      return current.accessToken
    },
    onUnauthorized: refresh,
  }
}

/** Prisma-backed implementation of the harvest's persistence port. */
export function createHarvestPort(ctx: JobRunContext): HarvestPort {
  return {
    async saveProfile(profile) {
      await prisma.connection.update({
        where: { provider: 'spotify' },
        data: {
          // account_id is the stable identifier Spotify says to use for linking
          // (May 2026); `id` is kept because playlist owner.id is still an `id`.
          ...(profile.accountId ? { accountId: profile.accountId } : {}),
          externalId: profile.id,
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          lastOkAt: new Date(),
        },
      })
    },

    async savePlaylist(p) {
      await prisma.sourcePlaylist.upsert({
        where: { source_externalId: { source: 'SPOTIFY', externalId: p.externalId } },
        create: {
          source: 'SPOTIFY',
          externalId: p.externalId,
          name: p.name,
          ownerId: p.ownerId ?? null,
          ownerName: p.ownerName ?? null,
          isOwned: p.isOwned,
          isCollaborative: p.isCollaborative,
          snapshotId: p.snapshotId ?? null,
          imageUrl: p.imageUrl ?? null,
          trackTotal: p.trackTotal ?? null,
          lastSyncedAt: new Date(),
        },
        update: {
          name: p.name,
          ownerName: p.ownerName ?? null,
          isOwned: p.isOwned,
          isCollaborative: p.isCollaborative,
          snapshotId: p.snapshotId ?? null,
          imageUrl: p.imageUrl ?? null,
          trackTotal: p.trackTotal ?? null,
          lastSyncedAt: new Date(),
        },
      })
    },

    async saveTracks(tracks: NormalizedSourceTrack[]) {
      if (tracks.length === 0) return { created: 0 }

      const rows = tracks.map((t) => {
        const norm = normalizeTrack({ title: t.title, artists: t.artists })
        return {
          source: 'SPOTIFY' as const,
          externalId: t.externalId,
          spotifyId: t.externalId,
          title: t.title,
          artists: t.artists,
          album: t.album ?? null,
          albumArtist: t.albumArtist ?? null,
          durationMs: t.durationMs ?? null,
          isrc: t.isrc ?? null,
          isrcStatus: t.isrcStatus,
          year: t.year ?? null,
          normTitle: norm.title.norm,
          normArtist: norm.artist.normAll,
          rawJson: t.raw as object,
        }
      })

      // skipDuplicates makes re-running converge instead of erroring (§4 idempotency).
      const result = await prisma.sourceTrack.createMany({ data: rows, skipDuplicates: true })
      return { created: result.count }
    },

    async savePlaylistItems(playlistExternalId, items) {
      const playlist = await prisma.sourcePlaylist.findUnique({
        where: { source_externalId: { source: 'SPOTIFY', externalId: playlistExternalId } },
        select: { id: true },
      })
      if (!playlist) return

      const tracks = await prisma.sourceTrack.findMany({
        where: { source: 'SPOTIFY', externalId: { in: items.map((i) => i.externalId) } },
        select: { id: true, externalId: true },
      })
      const byExternal = new Map(tracks.map((t) => [t.externalId!, t.id]))

      // Positions are rewritten wholesale inside one transaction — the alternative is
      // a shuffle that transiently violates the (playlistId, position) unique
      // constraint. See plan.md §2.2.
      await prisma.$transaction([
        prisma.sourcePlaylistItem.deleteMany({ where: { playlistId: playlist.id } }),
        prisma.sourcePlaylistItem.createMany({
          data: items
            .filter((i) => byExternal.has(i.externalId))
            .map((i) => ({
              playlistId: playlist.id,
              sourceTrackId: byExternal.get(i.externalId)!,
              position: i.position,
              addedAt: i.addedAt ?? null,
            })),
          skipDuplicates: true,
        }),
        prisma.sourcePlaylist.update({
          where: { id: playlist.id },
          data: { fullReadAt: new Date() },
        }),
      ])
    },

    async saveFollowedArtists(artists) {
      for (const a of artists) {
        const normName = normalizeTrack({ title: '', artists: a.name }).artist.normAll
        await prisma.artistNode.upsert({
          where: { name: a.name },
          create: { name: a.name, normName },
          update: { normName },
        })
      }
    },

    async saveTopItems(type, timeRange, items) {
      await prisma.setting.upsert({
        where: { key: `spotify:top:${type}:${timeRange}` },
        create: { key: `spotify:top:${type}:${timeRange}`, value: items as object },
        update: { value: items as object },
      })
    },

    async saveListeningEvents(events) {
      if (events.length === 0) return
      await prisma.listeningEvent.createMany({
        data: events.map((e) => ({
          source: 'SPOTIFY_API',
          artistName: e.artistName,
          trackName: e.trackName,
          playedAt: e.playedAt,
        })),
        // The unique constraint makes repeated recently-played polls converge.
        skipDuplicates: true,
      })
    },

    async queueIsrcBackfill(externalIds) {
      const settings = await loadSettings()
      await prisma.sourceTrack.updateMany({
        where: { source: 'SPOTIFY', externalId: { in: externalIds }, isrcStatus: 'ABSENT' },
        data: { isrcStatus: 'BACKFILL_QUEUED' },
      })

      if (!settings.isrcBackfillEnabled) {
        await ctx.log(
          'info',
          `${externalIds.length} album tracks have no ISRC, but the backfill queue is disabled in settings. Enable it to recover their ISRCs before the subscription lapses.`,
        )
        return
      }

      // Lowest-priority queue, one request each. Deterministic job ids so a re-run
      // converges rather than enqueuing duplicates.
      for (const id of externalIds) {
        await enqueue(
          'spotify-isrc-backfill',
          'backfill-isrc',
          { spotifyId: id },
          { jobId: jobId("isrc", id), priority: 10 },
        )
      }
      await ctx.log('info', `Queued ${externalIds.length} ISRC backfill requests`)
    },

    async saveCheckpoint(cp: HarvestCheckpoint) {
      await prisma.setting.upsert({
        where: { key: CHECKPOINT_KEY },
        create: { key: CHECKPOINT_KEY, value: cp as object },
        update: { value: cp as object },
      })
    },

    async loadCheckpoint() {
      const row = await prisma.setting.findUnique({ where: { key: CHECKPOINT_KEY } })
      return (row?.value as HarvestCheckpoint | undefined) ?? null
    },

    async onProgress(update) {
      await ctx.setProgress(update.done, update.total, `${update.stage}: ${update.message}`)
      await ctx.log('info', update.message, { stage: update.stage })
    },
  }
}

export async function runHarvest(
  ctx: JobRunContext,
  opts: { resume?: boolean } = {},
): Promise<HarvestSummary> {
  const settings = await loadSettings()
  if (!settings.spotifyClientId) {
    throw new Error('No Spotify client ID configured. Add one in Settings → Connections.')
  }

  const tokens = await makeTokenProvider(settings.spotifyClientId)
  const client = new SpotifyClient({
    getAccessToken: tokens.getAccessToken,
    onUnauthorized: tokens.onUnauthorized,
    market: settings.spotifyMarket,
    log: (level, msg, extra) => {
      void ctx.log(level, msg, extra as Record<string, unknown> | undefined)
    },
  })

  const port = createHarvestPort(ctx)

  await ctx.log('info', 'Harvest starting', {
    market: settings.spotifyMarket,
    resume: opts.resume ?? false,
  })

  const summary = await harvestEverything(client, port, opts)

  await ctx.log('info', 'Harvest finished', {
    playlists: summary.playlists,
    uniqueTracks: summary.uniqueTracks,
    tracksWithIsrc: summary.tracksWithIsrc,
    tracksAwaitingIsrc: summary.tracksAwaitingIsrc,
    requests: summary.requests,
    // The counter the owner explicitly asked to see (§7.1).
    callsAvoidedByCache: summary.callsAvoidedByCache,
    rateLimitHits: summary.rateLimitHits,
  })

  // Persist the summary for the "Spotify data secured" screen.
  await prisma.setting.upsert({
    where: { key: 'spotify:harvest:summary' },
    create: { key: 'spotify:harvest:summary', value: { ...summary, at: new Date().toISOString() } as object },
    update: { value: { ...summary, at: new Date().toISOString() } as object },
  })

  if (summary.interruptedBy === 'QUOTA_EXCEEDED') {
    await ctx.pause(
      'Spotify’s quota for this app is used up. Everything fetched so far is saved, and the harvest will resume from its checkpoint automatically.',
    )
    // Resume after an hour rather than hammering the wall.
    await enqueue(
      'spotify-sync',
      'harvest',
      { resume: true },
      { jobId: jobId("harvest-resume", Date.now()), delay: 60 * 60 * 1000 },
    )
  }

  return summary
}

/** Recover ISRC for one album-sourced track. One request each — see finding A. */
export async function runIsrcBackfill(ctx: JobRunContext, spotifyId: string): Promise<void> {
  const settings = await loadSettings()
  if (!settings.spotifyClientId) return

  const tokens = await makeTokenProvider(settings.spotifyClientId)
  const client = new SpotifyClient({
    getAccessToken: tokens.getAccessToken,
    onUnauthorized: tokens.onUnauthorized,
    market: settings.spotifyMarket,
  })

  try {
    const track = await client.getTrack(spotifyId)
    const isrc = track?.external_ids?.isrc

    await prisma.sourceTrack.updateMany({
      where: { source: 'SPOTIFY', externalId: spotifyId },
      data: isrc ? { isrc, isrcStatus: 'PRESENT' } : { isrcStatus: 'UNAVAILABLE' },
    })

    await ctx.log('info', isrc ? `Recovered ISRC for ${spotifyId}` : `Spotify has no ISRC for ${spotifyId}`)
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      // Leave the row QUEUED so it is retried after the quota resets.
      await ctx.pause('Quota exhausted during ISRC backfill; remaining tracks stay queued.')
      return
    }
    throw err
  }
}
