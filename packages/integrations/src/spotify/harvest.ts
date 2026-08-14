/**
 * "Harvest everything" — PROMPT.md §7.1.
 *
 * Pulls the complete account state in one resumable pass and hands every record to a
 * persistence port. Designed to be run before the subscription lapses (2026-09-01), so
 * the priorities are, in order: don't lose data, be resumable, be observable.
 *
 * Ordering is deliberate and is NOT the order the brief lists (see
 * docs/spotify-api-state.md §4.1). Playlists and saved tracks come first because their
 * responses embed FULL track objects with ISRC at no extra request cost. Saved albums
 * come later because their tracks are simplified and carry no ISRC, so each one needs
 * its own request — that work is deferred to the backfill queue rather than allowed to
 * block the cheap, complete data.
 *
 * The orchestrator is pure of I/O beyond the injected client and port, so the whole
 * flow is testable against a fake Spotify.
 */

import {
  PlaylistNotAccessibleError,
  QuotaExceededError,
  type SpotifyClient,
} from './client.js'
import { readItems, readTrack, type SpotifyTrack } from './schemas.js'

export type HarvestStage =
  | 'profile'
  | 'playlists'
  | 'playlist-items'
  | 'saved-tracks'
  | 'saved-albums'
  | 'followed-artists'
  | 'top-items'
  | 'recently-played'

export const HARVEST_STAGES: HarvestStage[] = [
  'profile',
  'playlists',
  'playlist-items',
  'saved-tracks',
  'saved-albums',
  'followed-artists',
  'top-items',
  'recently-played',
]

/** Persisted so an interrupted harvest resumes rather than restarts (§7.1). */
export interface HarvestCheckpoint {
  completedStages: HarvestStage[]
  /** Playlist ids already fully read, for the playlist-items stage. */
  completedPlaylistIds: string[]
  /** Where the current stage got to, when the stage supports it. */
  cursor?: string | undefined
}

export interface NormalizedSourceTrack {
  externalId: string
  title: string
  artists: string[]
  album?: string | undefined
  albumArtist?: string | undefined
  durationMs?: number | undefined
  isrc?: string | undefined
  /** PRESENT when the response embedded an ISRC; ABSENT when it structurally cannot. */
  isrcStatus: 'PRESENT' | 'ABSENT'
  year?: number | undefined
  raw: unknown
}

/** Everything the harvest needs from the outside world. Implemented by the worker. */
export interface HarvestPort {
  saveProfile(profile: { id: string; accountId?: string; displayName?: string }): Promise<void>
  savePlaylist(playlist: {
    externalId: string
    name: string
    ownerId?: string
    ownerName?: string
    isOwned: boolean
    isCollaborative: boolean
    snapshotId?: string
    imageUrl?: string
    trackTotal?: number
  }): Promise<void>
  /** Returns the number of tracks that were new, for the summary. */
  saveTracks(tracks: NormalizedSourceTrack[]): Promise<{ created: number }>
  savePlaylistItems(
    playlistExternalId: string,
    items: Array<{ externalId: string; position: number; addedAt?: Date }>,
  ): Promise<void>
  saveFollowedArtists(artists: Array<{ externalId: string; name: string }>): Promise<void>
  saveTopItems(
    type: 'tracks' | 'artists',
    timeRange: string,
    items: Array<{ externalId: string; name: string; position: number }>,
  ): Promise<void>
  saveListeningEvents(
    events: Array<{ artistName: string; trackName: string; playedAt: Date; externalId?: string }>,
  ): Promise<void>
  /** Queue album-sourced tracks for the one-request-each ISRC backfill (finding A). */
  queueIsrcBackfill(externalIds: string[]): Promise<void>
  saveCheckpoint(cp: HarvestCheckpoint): Promise<void>
  loadCheckpoint(): Promise<HarvestCheckpoint | null>
  onProgress(update: {
    stage: HarvestStage
    message: string
    done: number
    total?: number | undefined
  }): Promise<void> | void
}

export interface HarvestSummary {
  playlists: number
  playlistsNotOwned: number
  uniqueTracks: number
  tracksWithIsrc: number
  tracksAwaitingIsrc: number
  followedArtists: number
  listeningEvents: number
  requests: number
  callsAvoidedByCache: number
  rateLimitHits: number
  stagesCompleted: HarvestStage[]
  interruptedBy?: 'QUOTA_EXCEEDED' | undefined
}

function trackToSource(t: SpotifyTrack, isrcKnownAbsent = false): NormalizedSourceTrack | null {
  if (!t.id) return null // local files have no id and cannot be matched upstream
  const isrc = t.external_ids?.isrc
  const releaseDate = t.album?.release_date
  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : undefined

  return {
    externalId: t.id,
    title: t.name ?? '(unknown title)',
    artists: (t.artists ?? []).map((a) => a.name ?? '').filter(Boolean),
    album: t.album?.name,
    albumArtist: t.album?.artists?.[0]?.name,
    durationMs: t.duration_ms,
    isrc: isrc,
    isrcStatus: isrc ? 'PRESENT' : isrcKnownAbsent ? 'ABSENT' : 'ABSENT',
    year: Number.isFinite(year) ? year : undefined,
    raw: t,
  }
}

/**
 * Caches spotifyId → seen, so a track embedded in a playlist is never re-fetched
 * individually (§7.1). The "calls avoided" counter is surfaced in the summary because
 * the owner explicitly asked to see it.
 */
export class TrackCache {
  private readonly seen = new Set<string>()
  private avoided = 0

  has(id: string): boolean {
    if (this.seen.has(id)) {
      this.avoided += 1
      return true
    }
    return false
  }

  add(id: string): void {
    this.seen.add(id)
  }

  get size(): number {
    return this.seen.size
  }

  get callsAvoided(): number {
    return this.avoided
  }
}

export async function harvestEverything(
  client: SpotifyClient,
  port: HarvestPort,
  opts: { resume?: boolean } = {},
): Promise<HarvestSummary> {
  const checkpoint: HarvestCheckpoint = (opts.resume ? await port.loadCheckpoint() : null) ?? {
    completedStages: [],
    completedPlaylistIds: [],
  }

  const cache = new TrackCache()
  const summary: HarvestSummary = {
    playlists: 0,
    playlistsNotOwned: 0,
    uniqueTracks: 0,
    tracksWithIsrc: 0,
    tracksAwaitingIsrc: 0,
    followedArtists: 0,
    listeningEvents: 0,
    requests: 0,
    callsAvoidedByCache: 0,
    rateLimitHits: 0,
    stagesCompleted: [...checkpoint.completedStages],
  }

  const done = (stage: HarvestStage) => checkpoint.completedStages.includes(stage)
  const complete = async (stage: HarvestStage) => {
    if (!checkpoint.completedStages.includes(stage)) checkpoint.completedStages.push(stage)
    summary.stagesCompleted = [...checkpoint.completedStages]
    await port.saveCheckpoint(checkpoint)
  }

  /** Persist a batch of tracks and keep the ISRC counters honest. */
  const persistTracks = async (tracks: NormalizedSourceTrack[]) => {
    const fresh = tracks.filter((t) => !cache.has(t.externalId))
    for (const t of fresh) cache.add(t.externalId)
    if (fresh.length === 0) return
    const { created } = await port.saveTracks(fresh)
    summary.uniqueTracks += created
    summary.tracksWithIsrc += fresh.filter((t) => t.isrc).length
  }

  let myUserId: string | undefined

  try {
    // ── Profile ──────────────────────────────────────────────
    if (!done('profile')) {
      const me = await client.getCurrentUser()
      myUserId = me.id
      await port.saveProfile({
        id: me.id,
        ...(me.account_id ? { accountId: me.account_id } : {}),
        ...(me.display_name ? { displayName: me.display_name } : {}),
      })
      await port.onProgress({ stage: 'profile', message: `Connected as ${me.display_name ?? me.id}`, done: 1, total: 1 })
      await complete('profile')
    } else {
      myUserId = (await client.getCurrentUser()).id
    }

    // ── Playlists (metadata) ─────────────────────────────────
    const playlistIds: string[] = []
    if (!done('playlists')) {
      let count = 0
      for await (const page of client.getMyPlaylists()) {
        for (const p of page) {
          const ownerId = p.owner?.id
          const isOwned = ownerId !== undefined && ownerId === myUserId
          const isCollaborative = p.collaborative === true
          await port.savePlaylist({
            externalId: p.id,
            name: p.name ?? '(untitled playlist)',
            ...(ownerId ? { ownerId } : {}),
            ...(p.owner?.display_name ? { ownerName: p.owner.display_name } : {}),
            isOwned,
            isCollaborative,
            ...(p.snapshot_id ? { snapshotId: p.snapshot_id } : {}),
            ...(p.images?.[0]?.url ? { imageUrl: p.images[0].url } : {}),
            ...(readItems(p) === undefined && (p.items?.total ?? p.tracks?.total) !== undefined
              ? { trackTotal: p.items?.total ?? p.tracks?.total }
              : {}),
          })
          // Only owned/collaborative playlists can yield contents at all (finding B).
          if (isOwned || isCollaborative) playlistIds.push(p.id)
          else summary.playlistsNotOwned += 1
          count += 1
          summary.playlists += 1
        }
        await port.onProgress({ stage: 'playlists', message: `${count} playlists found`, done: count })
      }
      await complete('playlists')
    }

    // ── Playlist items ───────────────────────────────────────
    if (!done('playlist-items')) {
      const remaining = playlistIds.filter((id) => !checkpoint.completedPlaylistIds.includes(id))
      let i = 0
      for (const id of remaining) {
        i += 1
        try {
          const batch: NormalizedSourceTrack[] = []
          const members: Array<{ externalId: string; position: number; addedAt?: Date }> = []
          let position = 0

          for await (const page of client.getPlaylistItems(id)) {
            for (const item of page) {
              const track = readTrack(item)
              if (!track?.id) {
                position += 1
                continue
              }
              // Playlist items embed FULL track objects with ISRC — this is the cheap,
              // complete data, and it must never trigger an individual fetch.
              const src = trackToSource(track)
              if (src) batch.push(src)
              members.push({
                externalId: track.id,
                position,
                ...(item.added_at ? { addedAt: new Date(item.added_at) } : {}),
              })
              position += 1
            }
          }

          await persistTracks(batch)
          await port.savePlaylistItems(id, members)
          checkpoint.completedPlaylistIds.push(id)
          await port.saveCheckpoint(checkpoint)
          await port.onProgress({
            stage: 'playlist-items',
            message: `${position} tracks from playlist ${i} of ${remaining.length}`,
            done: i,
            total: remaining.length,
          })
        } catch (err) {
          if (err instanceof PlaylistNotAccessibleError) {
            // Shouldn't reach here given the owned/collaborative filter above, but a
            // playlist can change ownership mid-harvest. Skip it, don't fail the run.
            summary.playlistsNotOwned += 1
            checkpoint.completedPlaylistIds.push(id)
            continue
          }
          throw err
        }
      }
      await complete('playlist-items')
    }

    // ── Saved tracks — full objects with ISRC ────────────────
    if (!done('saved-tracks')) {
      let count = 0
      for await (const page of client.getSavedTracks()) {
        const batch: NormalizedSourceTrack[] = []
        for (const saved of page) {
          const track = saved.track ?? saved.item
          if (!track) continue
          const src = trackToSource(track)
          if (src) batch.push(src)
        }
        await persistTracks(batch)
        count += page.length
        await port.onProgress({ stage: 'saved-tracks', message: `${count} liked songs`, done: count })
      }
      await complete('saved-tracks')
    }

    // ── Saved albums — tracks here have NO ISRC (finding A) ──
    if (!done('saved-albums')) {
      let albums = 0
      const needBackfill: string[] = []

      for await (const page of client.getSavedAlbums()) {
        for (const saved of page) {
          const album = saved.album ?? saved.item
          if (!album?.id) continue
          albums += 1

          const batch: NormalizedSourceTrack[] = []
          for await (const trackPage of client.getAlbumTracks(album.id)) {
            for (const t of trackPage) {
              if (!t.id) continue
              if (cache.has(t.id)) continue // already have it in full from a playlist
              const year = album.release_date ? Number(album.release_date.slice(0, 4)) : undefined
              batch.push({
                externalId: t.id,
                title: t.name ?? '(unknown title)',
                artists: (t.artists ?? []).map((a) => a.name ?? '').filter(Boolean),
                album: album.name,
                albumArtist: album.artists?.[0]?.name,
                durationMs: t.duration_ms,
                isrc: undefined,
                // Structurally absent, not merely missing — SimplifiedTrackObject has
                // no external_ids field at all.
                isrcStatus: 'ABSENT',
                year: Number.isFinite(year) ? year : undefined,
                raw: t,
              })
              needBackfill.push(t.id)
            }
          }
          await persistTracks(batch)
        }
        await port.onProgress({ stage: 'saved-albums', message: `${albums} saved albums`, done: albums })
      }

      if (needBackfill.length > 0) {
        await port.queueIsrcBackfill(needBackfill)
        summary.tracksAwaitingIsrc += needBackfill.length
      }
      await complete('saved-albums')
    }

    // ── Followed artists ─────────────────────────────────────
    if (!done('followed-artists')) {
      let count = 0
      for await (const page of client.getFollowedArtists()) {
        const artists = page
          .filter((a) => a.id)
          .map((a) => ({ externalId: a.id!, name: a.name ?? '(unknown artist)' }))
        await port.saveFollowedArtists(artists)
        count += artists.length
        summary.followedArtists += artists.length
        await port.onProgress({ stage: 'followed-artists', message: `${count} followed artists`, done: count })
      }
      await complete('followed-artists')
    }

    // ── Top items, all three time ranges ─────────────────────
    if (!done('top-items')) {
      for (const type of ['tracks', 'artists'] as const) {
        for (const range of ['short_term', 'medium_term', 'long_term'] as const) {
          const items: Array<{ externalId: string; name: string; position: number }> = []
          let position = 0
          for await (const page of client.getTopItems(type, range)) {
            for (const it of page) {
              const entity = it as { id?: string | null; name?: string }
              if (!entity.id) continue
              items.push({ externalId: entity.id, name: entity.name ?? '', position })
              position += 1
              if (type === 'tracks') {
                const src = trackToSource(it as SpotifyTrack)
                if (src) await persistTracks([src])
              }
            }
          }
          await port.saveTopItems(type, range, items)
          await port.onProgress({
            stage: 'top-items',
            message: `top ${type}, ${range.replace('_', ' ')}: ${items.length}`,
            done: items.length,
          })
        }
      }
      await complete('top-items')
    }

    // ── Recently played ──────────────────────────────────────
    if (!done('recently-played')) {
      let count = 0
      for await (const page of client.getRecentlyPlayed()) {
        const events = page
          .map((p) => {
            const t = p.track
            if (!t || !p.played_at) return null
            return {
              artistName: t.artists?.[0]?.name ?? '',
              trackName: t.name ?? '',
              playedAt: new Date(p.played_at),
              ...(t.id ? { externalId: t.id } : {}),
            }
          })
          .filter((e): e is NonNullable<typeof e> => e !== null)

        await port.saveListeningEvents(events)
        count += events.length
        summary.listeningEvents += events.length
        await port.onProgress({ stage: 'recently-played', message: `${count} plays`, done: count })
      }
      await complete('recently-played')
    }
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      // Checkpoint is already saved after every unit of work. Report and stop rather
      // than retrying into a wall (finding C).
      await port.saveCheckpoint(checkpoint)
      summary.interruptedBy = 'QUOTA_EXCEEDED'
      summary.callsAvoidedByCache = cache.callsAvoided
      summary.requests = client.counters.requests
      summary.rateLimitHits = client.counters.rateLimitHits
      return summary
    }
    throw err
  }

  summary.callsAvoidedByCache = cache.callsAvoided
  summary.requests = client.counters.requests
  summary.rateLimitHits = client.counters.rateLimitHits
  return summary
}
