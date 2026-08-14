/**
 * Navidrome via the Subsonic API.
 *
 * Auth uses the salted-token scheme (`t` = md5(password + salt)) rather than sending
 * the password in the clear, which Navidrome supports and which keeps the credential
 * out of request logs.
 *
 * Used for: the path-mapping probe (§5), playlist creation so playlists appear without
 * waiting for a filesystem scan (§7.9), and the play-count/star sync that becomes the
 * live taste signal once Spotify is gone (§7.8).
 */

import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

const CLIENT_NAME = 'crate'
const API_VERSION = '1.16.1'

export interface SubsonicConfig {
  baseUrl: string
  username: string
  password: string
  fetchImpl?: typeof fetch
}

const StatusSchema = z
  .object({
    'subsonic-response': z
      .object({
        status: z.string().optional(),
        version: z.string().optional(),
        type: z.string().optional(),
        serverVersion: z.string().optional(),
        error: z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough()

export class SubsonicError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'SubsonicError'
    this.code = code
  }
}

export class SubsonicClient {
  private readonly cfg: SubsonicConfig
  private readonly fetchImpl: typeof fetch

  constructor(cfg: SubsonicConfig) {
    this.cfg = cfg
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  private authParams(): Record<string, string> {
    const salt = randomBytes(8).toString('hex')
    const token = createHash('md5').update(this.cfg.password + salt).digest('hex')
    return {
      u: this.cfg.username,
      t: token,
      s: salt,
      v: API_VERSION,
      c: CLIENT_NAME,
      f: 'json',
    }
  }

  private async call(
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(`${this.cfg.baseUrl.replace(/\/+$/, '')}/rest/${endpoint}`)
    for (const [k, v] of Object.entries(this.authParams())) url.searchParams.set(k, v)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.append(k, String(v))
    }

    const res = await this.fetchImpl(url.toString())
    if (!res.ok) throw new SubsonicError(`${endpoint} returned HTTP ${res.status}`)

    const parsed = StatusSchema.safeParse(await res.json())
    if (!parsed.success) throw new SubsonicError(`${endpoint} returned an unexpected response shape`)

    const body = parsed.data['subsonic-response']
    if (body.status === 'failed') {
      throw new SubsonicError(
        body.error?.message ?? `${endpoint} failed`,
        body.error?.code,
      )
    }
    return body as Record<string, unknown>
  }

  /** Connectivity + credential check. */
  async ping(): Promise<{ ok: boolean; serverVersion?: string; type?: string }> {
    const body = await this.call('ping')
    return {
      ok: body.status === 'ok',
      ...(typeof body.serverVersion === 'string' ? { serverVersion: body.serverVersion } : {}),
      ...(typeof body.type === 'string' ? { type: body.type } : {}),
    }
  }

  async startScan(): Promise<void> {
    await this.call('startScan')
  }

  async getScanStatus(): Promise<{ scanning: boolean; count?: number }> {
    const body = await this.call('getScanStatus')
    const s = body.scanStatus as { scanning?: boolean; count?: number } | undefined
    return { scanning: s?.scanning === true, ...(s?.count !== undefined ? { count: s.count } : {}) }
  }

  async getPlaylists(): Promise<Array<{ id: string; name: string; songCount?: number }>> {
    const body = await this.call('getPlaylists')
    const container = body.playlists as { playlist?: unknown } | undefined
    const list = Array.isArray(container?.playlist) ? container.playlist : []
    return list.map((p) => {
      const pl = p as Record<string, unknown>
      return {
        id: String(pl.id),
        name: String(pl.name ?? ''),
        ...(typeof pl.songCount === 'number' ? { songCount: pl.songCount } : {}),
      }
    })
  }

  async getPlaylist(id: string): Promise<{ id: string; name: string; songCount: number }> {
    const body = await this.call('getPlaylist', { id })
    const p = body.playlist as Record<string, unknown> | undefined
    return {
      id: String(p?.id ?? id),
      name: String(p?.name ?? ''),
      songCount: typeof p?.songCount === 'number' ? p.songCount : 0,
    }
  }

  async createPlaylist(name: string, songIds: string[] = []): Promise<string | null> {
    const body = await this.call('createPlaylist', { name, songId: undefined })
    // Navidrome returns the created playlist; song ids are appended separately because
    // the multi-value songId parameter is awkward to build reliably.
    const p = body.playlist as Record<string, unknown> | undefined
    const id = p?.id !== undefined ? String(p.id) : null
    if (id && songIds.length > 0) await this.updatePlaylist(id, { addSongIds: songIds })
    return id
  }

  async updatePlaylist(
    id: string,
    opts: { name?: string; addSongIds?: string[]; removeIndexes?: number[] },
  ): Promise<void> {
    const params: Record<string, string | number | undefined> = { playlistId: id }
    if (opts.name) params.name = opts.name

    const url = new URL(`${this.cfg.baseUrl.replace(/\/+$/, '')}/rest/updatePlaylist`)
    for (const [k, v] of Object.entries(this.authParams())) url.searchParams.set(k, v)
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    for (const sid of opts.addSongIds ?? []) url.searchParams.append('songIdToAdd', sid)
    for (const idx of opts.removeIndexes ?? []) url.searchParams.append('songIndexToRemove', String(idx))

    const res = await this.fetchImpl(url.toString())
    if (!res.ok) throw new SubsonicError(`updatePlaylist returned HTTP ${res.status}`)
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.call('deletePlaylist', { id })
  }

  /** Search for a song by path fragment or title — used by the path probe. */
  async search(query: string): Promise<Array<{ id: string; title: string; path?: string }>> {
    const body = await this.call('search3', { query, songCount: 20, artistCount: 0, albumCount: 0 })
    const result = body.searchResult3 as { song?: unknown } | undefined
    const songs = Array.isArray(result?.song) ? result.song : []
    return songs.map((s) => {
      const song = s as Record<string, unknown>
      return {
        id: String(song.id),
        title: String(song.title ?? ''),
        ...(typeof song.path === 'string' ? { path: song.path } : {}),
      }
    })
  }

  /** Starred items — a live taste signal after Spotify is gone (§7.8). */
  async getStarred(): Promise<Array<{ id: string; title: string; artist?: string }>> {
    const body = await this.call('getStarred2')
    const starred = body.starred2 as { song?: unknown } | undefined
    const songs = Array.isArray(starred?.song) ? starred.song : []
    return songs.map((s) => {
      const song = s as Record<string, unknown>
      return {
        id: String(song.id),
        title: String(song.title ?? ''),
        ...(typeof song.artist === 'string' ? { artist: song.artist } : {}),
      }
    })
  }

  /** Play counts, walked album by album — the post-Spotify listening signal. */
  async getAlbumList(
    type: 'frequent' | 'recent' | 'newest' = 'frequent',
    size = 500,
    offset = 0,
  ): Promise<Array<{ id: string; name: string; artist?: string; playCount?: number }>> {
    const body = await this.call('getAlbumList2', { type, size, offset })
    const list = body.albumList2 as { album?: unknown } | undefined
    const albums = Array.isArray(list?.album) ? list.album : []
    return albums.map((a) => {
      const al = a as Record<string, unknown>
      return {
        id: String(al.id),
        name: String(al.name ?? ''),
        ...(typeof al.artist === 'string' ? { artist: al.artist } : {}),
        ...(typeof al.playCount === 'number' ? { playCount: al.playCount } : {}),
      }
    })
  }
}
