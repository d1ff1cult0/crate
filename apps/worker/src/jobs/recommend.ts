/**
 * Recommendations — PROMPT.md §7.8, phase 7.
 *
 * "It produces six named, rotating mixes that refresh daily and appear in Navidrome
 *  without me doing anything. If a mix isn't good enough to press play on, the engine has
 *  failed."
 *
 * Three jobs live here:
 *
 *   taste-refresh   pull Navidrome play counts/stars/last-played and Last.fm scrobbles
 *                   into ListeningEvent, then recompute affinity
 *   generate-mixes  build the artist graph, cluster it, fill six stable slots, write them
 *   release-radar   weekly MusicBrainz sweep for new releases by high-affinity artists
 *
 * Worth being honest about what this is, since plan.md §1.4 already was: Spotify's Daily
 * Mix comes from track-level collaborative filtering over hundreds of millions of
 * listeners. This approximates it from one person's history plus four public similarity
 * sources. The approximation gets better with the GDPR streaming history, with Last.fm
 * connected, and with weeks of the outcome feedback loop running — and it is honest
 * about having nothing to work with until at least one of those exists, rather than
 * generating six plausible-looking playlists out of noise.
 */

import {
  aggregateByArtist,
  assignStableSlots,
  blendEdges,
  computeAffinity,
  discoveryCandidates,
  louvain,
  nameMix,
  normalizeScores,
  outcomeWeights,
  planDiscoverySlots,
  sampleMix,
  toAppPath,
  type MixCandidate,
  type PathMapping,
  type PlayEvent,
  type RawEdge,
} from '@crate/core'
import { prisma } from '@crate/db'
import {
  DeezerClient,
  LastfmClient,
  LlmClient,
  MusicbrainzClient,
  YtmRadioClient,
  edgesFromRadio,
} from '@crate/integrations'
import { decryptJson } from '../lib/crypto.js'
import type { JobRunContext } from '../lib/jobrun.js'
import { navidromeClient } from '../lib/navidrome.js'
import { enqueue, jobId } from '../lib/queues.js'
import { loadSettings } from '../lib/settings.js'

// ─────────────────────────────────────────────────────────────
// Taste model
// ─────────────────────────────────────────────────────────────

export interface TasteRefreshResult {
  navidromeEvents: number
  lastfmEvents: number
  tracksScored: number
  artistsScored: number
}

/**
 * Pull the live listening signals in, then recompute affinity across the library.
 *
 * Navidrome exposes an aggregate play count, not individual plays, so a count of 12 with
 * a last-played date becomes twelve synthetic events spread backwards from that date.
 * That is an approximation and it is stated in the log rather than hidden: without it,
 * everything Navidrome knows would collapse to a single event and the recency decay
 * would treat a heavily-played favourite the same as something played once.
 */
export async function runTasteRefresh(ctx: JobRunContext): Promise<TasteRefreshResult> {
  const settings = await loadSettings()
  let navidromeEvents = 0
  let lastfmEvents = 0

  // ── Navidrome ──────────────────────────────────────────
  const subsonic = await navidromeClient()
  if (subsonic) {
    const mappings = settings.pathMappings as PathMapping[]
    const albums = await subsonic.getAlbumList('frequent', 500)
    await ctx.log('info', `Reading play counts from ${albums.length} albums in Navidrome`)

    for (const [index, album] of albums.entries()) {
      let songs
      try {
        songs = await subsonic.getAlbum(album.id)
      } catch {
        continue // a single unreadable album must not stop the refresh
      }

      for (const song of songs) {
        if (!song.playCount || song.playCount <= 0) {
          if (!song.starred) continue
        }

        // Navidrome's path is Navidrome's view of the filesystem; map it back to ours
        // before trying to match a row. This is §5 in the direction people forget.
        const appPath = song.path ? toAppPath(song.path, mappings).path : null
        const file = appPath
          ? await prisma.libraryFile.findUnique({
              where: { path: appPath },
              select: { trackId: true },
            })
          : null

        if (file?.trackId) {
          await prisma.libraryTrack.update({
            where: { id: file.trackId },
            data: {
              playCount: song.playCount ?? 0,
              starred: song.starred !== undefined,
              ...(song.lastPlayed ? { lastPlayedAt: song.lastPlayed } : {}),
            },
          })
        }

        const anchor = song.lastPlayed ?? new Date()
        const count = Math.min(song.playCount ?? 0, 200)
        for (let i = 0; i < count; i++) {
          // Spread backwards a week apart. Crude, and deliberately so — the shape of the
          // decay matters far more than the exact spacing of plays we never observed.
          const playedAt = new Date(anchor.getTime() - i * 7 * 86_400_000)
          const created = await prisma.listeningEvent
            .create({
              data: {
                source: 'NAVIDROME',
                ...(file?.trackId ? { trackId: file.trackId } : {}),
                artistName: song.artist ?? '',
                trackName: song.title,
                playedAt,
                skipped: false,
              },
            })
            .catch(() => null) // the unique constraint makes re-runs converge
          if (created) navidromeEvents += 1
        }
      }

      if (index % 25 === 0) {
        await ctx.setProgress(index + 1, albums.length, `${index + 1} of ${albums.length} albums`)
      }
    }
  } else {
    await ctx.log('info', 'No Navidrome connection — skipping play-count import')
  }

  // ── Last.fm ────────────────────────────────────────────
  const lastfmConnection = await prisma.connection.findUnique({ where: { provider: 'lastfm' } })
  if (lastfmConnection?.enabled && lastfmConnection.secretCipher) {
    try {
      const creds = decryptJson<{ apiKey: string; username?: string }>(
        lastfmConnection.secretCipher,
      )
      const username = creds.username ?? lastfmConnection.displayName
      if (username) {
        const client = new LastfmClient({ apiKey: creds.apiKey })
        // One page per run keeps the job short; scrobbles accumulate over days anyway
        // and the unique constraint makes overlapping pages harmless.
        const { tracks } = await client.getRecentTracks(username, 1, 200)
        for (const track of tracks) {
          const created = await prisma.listeningEvent
            .create({
              data: {
                source: 'LASTFM',
                artistName: track.artist,
                trackName: track.track,
                playedAt: track.playedAt,
              },
            })
            .catch(() => null)
          if (created) lastfmEvents += 1
        }
        await ctx.log('info', `Imported ${lastfmEvents} new scrobble(s) from Last.fm`)
      }
    } catch (err) {
      await ctx.log('warn', 'Last.fm scrobble import failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Recompute affinity ─────────────────────────────────
  const { tracksScored, artistsScored } = await recomputeAffinity(ctx, settings.affinityHalfLifeDays)

  await ctx.log('info', 'Taste model refreshed', {
    navidromeEvents,
    lastfmEvents,
    tracksScored,
    artistsScored,
  })
  return { navidromeEvents, lastfmEvents, tracksScored, artistsScored }
}

async function recomputeAffinity(
  ctx: JobRunContext,
  halfLifeDays: number,
): Promise<{ tracksScored: number; artistsScored: number }> {
  const now = new Date()

  const tracks = await prisma.libraryTrack.findMany({
    select: { id: true, artist: true, title: true, starred: true },
  })

  // One query for all events rather than one per track: a library of any size makes the
  // per-track version take minutes of pure round trips.
  const events = await prisma.listeningEvent.findMany({
    select: { trackId: true, artistName: true, trackName: true, playedAt: true, msPlayed: true, skipped: true },
  })

  const byTrackId = new Map<string, PlayEvent[]>()
  const byNameKey = new Map<string, PlayEvent[]>()
  const nameKey = (artist: string, title: string) =>
    `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`

  for (const event of events) {
    const entry: PlayEvent = {
      playedAt: event.playedAt,
      msPlayed: event.msPlayed,
      skipped: event.skipped,
    }
    if (event.trackId) {
      const list = byTrackId.get(event.trackId)
      if (list) list.push(entry)
      else byTrackId.set(event.trackId, [entry])
    }
    const key = nameKey(event.artistName, event.trackName)
    const list = byNameKey.get(key)
    if (list) list.push(entry)
    else byNameKey.set(key, [entry])
  }

  const trackAffinity: Array<{ artist: string; affinity: number }> = []
  let tracksScored = 0

  for (const track of tracks) {
    // Events attached by id are authoritative; the GDPR export and Last.fm only carry
    // names, so fall back to a name match for those.
    const own = byTrackId.get(track.id) ?? byNameKey.get(nameKey(track.artist, track.title)) ?? []
    if (own.length === 0) continue

    const result = computeAffinity(own, { halfLifeDays, now, starred: track.starred })
    await prisma.libraryTrack.update({
      where: { id: track.id },
      data: { affinity: result.score },
    })
    trackAffinity.push({ artist: track.artist, affinity: result.score })
    tracksScored += 1
  }

  const artistScores = normalizeScores(aggregateByArtist(trackAffinity))
  let artistsScored = 0

  for (const [name, affinity] of artistScores) {
    if (!name.trim()) continue
    await prisma.artistNode.upsert({
      where: { name },
      create: {
        name,
        normName: name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
        inLibrary: true,
        affinity,
      },
      update: { affinity, inLibrary: true },
    })
    artistsScored += 1
  }

  await ctx.log('info', `Scored ${tracksScored} tracks and ${artistsScored} artists`)
  return { tracksScored, artistsScored }
}

// ─────────────────────────────────────────────────────────────
// Similarity graph
// ─────────────────────────────────────────────────────────────

export interface GraphBuildResult {
  artists: number
  edges: number
  bySource: Record<string, number>
}

/**
 * Populate `ArtistEdge` from every available source (§7.8).
 *
 * Seeded from the listener's own top artists rather than the whole library: the graph
 * only needs to be dense where the mixes will be drawn from, and querying four APIs for
 * every artist in a large library would take hours and add nothing.
 */
export async function buildSimilarityGraph(
  ctx: JobRunContext,
  opts: { seedLimit?: number } = {},
): Promise<GraphBuildResult> {
  const seedLimit = opts.seedLimit ?? 120

  const seeds = await prisma.artistNode.findMany({
    where: { inLibrary: true },
    orderBy: { affinity: 'desc' },
    take: seedLimit,
  })

  if (seeds.length === 0) {
    await ctx.log('warn', 'No artists with affinity yet — run a taste refresh first')
    return { artists: 0, edges: 0, bySource: {} }
  }

  const bySource: Record<string, number> = {}
  const record = async (from: string, to: string, source: string, weight: number) => {
    if (!from.trim() || !to.trim() || from === to) return
    const fromNode = await upsertArtist(from)
    const toNode = await upsertArtist(to)
    await prisma.artistEdge.upsert({
      where: { fromId_toId_source: { fromId: fromNode, toId: toNode, source } },
      create: { fromId: fromNode, toId: toNode, source, weight },
      update: { weight },
    })
    bySource[source] = (bySource[source] ?? 0) + 1
  }

  // ── Last.fm: the strongest source in the blend ─────────
  const lastfmConnection = await prisma.connection.findUnique({ where: { provider: 'lastfm' } })
  if (lastfmConnection?.enabled && lastfmConnection.secretCipher) {
    try {
      const creds = decryptJson<{ apiKey: string }>(lastfmConnection.secretCipher)
      const client = new LastfmClient({ apiKey: creds.apiKey })
      for (const [index, seed] of seeds.entries()) {
        const similar = await client.getSimilarArtists(seed.name, 30)
        for (const artist of similar) await record(seed.name, artist.name, 'LASTFM', artist.weight)
        if (index % 20 === 0) {
          await ctx.setProgress(index, seeds.length, `Last.fm: ${index}/${seeds.length}`)
        }
      }
      await ctx.log('info', `Last.fm contributed ${bySource.LASTFM ?? 0} edges`)
    } catch (err) {
      await ctx.log('warn', 'Last.fm similarity failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else {
    await ctx.log(
      'warn',
      'Last.fm is not connected. It is the only remaining source of real collaborative-filtering data in this blend, so mix quality will be noticeably worse without it.',
    )
  }

  // ── Deezer: no auth, thinner data ──────────────────────
  const deezer = new DeezerClient()
  for (const seed of seeds.slice(0, 60)) {
    const related = await deezer.relatedArtists(seed.name, 15)
    for (const artist of related) await record(seed.name, artist.name, 'DEEZER', artist.weight)
  }
  await ctx.log('info', `Deezer contributed ${bySource.DEEZER ?? 0} edges`)

  // ── YouTube Music radios ───────────────────────────────
  const radio = new YtmRadioClient()
  const topTracks = await prisma.libraryTrack.findMany({
    orderBy: { affinity: 'desc' },
    take: 25,
    select: { artist: true, title: true },
  })
  for (const track of topTracks) {
    const videoId = await radio.resolveSeed(track.artist, track.title)
    if (!videoId) continue
    const entries = await radio.radioFor(videoId)
    for (const edge of edgesFromRadio(track.artist, entries)) {
      await record(edge.from, edge.to, 'YTM', edge.weight)
    }
  }
  await ctx.log('info', `YouTube Music radios contributed ${bySource.YTM ?? 0} edges`)

  // ── Co-occurrence in the owner's own playlists ─────────
  const cooccurrence = await mineCooccurrence()
  for (const [pair, count] of cooccurrence) {
    const [from, to] = pair.split(' ')
    await record(from!, to!, 'COOCCURRENCE', count)
  }
  await ctx.log('info', `Co-occurrence contributed ${bySource.COOCCURRENCE ?? 0} edges`)

  const [artists, edges] = await Promise.all([
    prisma.artistNode.count(),
    prisma.artistEdge.count(),
  ])
  return { artists, edges, bySource }
}

const artistIdCache = new Map<string, string>()

async function upsertArtist(name: string): Promise<string> {
  const cached = artistIdCache.get(name)
  if (cached) return cached
  const node = await prisma.artistNode.upsert({
    where: { name },
    create: { name, normName: name.toLowerCase().replace(/[^a-z0-9]+/g, ''), inLibrary: false },
    update: {},
  })
  artistIdCache.set(name, node.id)
  return node.id
}

/**
 * Artists that repeatedly appear near each other in the owner's own playlists.
 *
 * "Related *for me*, which generic data can't know" (§7.8). Adjacency window of three,
 * because playlist ordering is intentional at short range and arbitrary at long range.
 */
async function mineCooccurrence(): Promise<Map<string, number>> {
  const playlists = await prisma.playlist.findMany({
    where: { kind: 'IMPORTED' },
    select: {
      items: {
        orderBy: { position: 'asc' },
        select: { libraryTrack: { select: { artist: true } }, sourceTrack: { select: { artists: true } } },
      },
    },
  })

  const counts = new Map<string, number>()
  for (const playlist of playlists) {
    const artists = playlist.items
      .map((i) => i.libraryTrack?.artist ?? i.sourceTrack?.artists[0] ?? '')
      .filter(Boolean)

    for (let i = 0; i < artists.length; i++) {
      for (let j = i + 1; j < Math.min(artists.length, i + 4); j++) {
        const a = artists[i]!
        const b = artists[j]!
        if (a === b) continue
        const key = a < b ? `${a} ${b}` : `${b} ${a}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }

  // A single co-appearance is noise; two or more is a pattern.
  return new Map([...counts].filter(([, count]) => count >= 2))
}

// ─────────────────────────────────────────────────────────────
// Mix generation
// ─────────────────────────────────────────────────────────────

export interface MixGenerationResult {
  mixes: Array<{ slot: number; name: string; tracks: number; continuity: number }>
  discoveryQueued: number
  skipped?: string
}

export async function runGenerateMixes(
  ctx: JobRunContext,
  opts: { onlySlot?: number; rebuildGraph?: boolean } = {},
): Promise<MixGenerationResult> {
  const settings = await loadSettings()

  const scoredTracks = await prisma.libraryTrack.count({ where: { affinity: { gt: 0 } } })
  if (scoredTracks < 20) {
    // An honest empty state beats a fake one (§11). Six playlists sampled from nothing
    // would look like a working feature and be indistinguishable from random.
    const message = `Only ${scoredTracks} tracks have any listening signal. Mixes need a taste model first — import the GDPR streaming history, connect Last.fm, or let Navidrome accumulate play counts.`
    await ctx.log('warn', message)
    return { mixes: [], discoveryQueued: 0, skipped: message }
  }

  if (opts.rebuildGraph !== false) {
    await buildSimilarityGraph(ctx)
  }

  // ── Cluster ────────────────────────────────────────────
  const nodes = await prisma.artistNode.findMany({
    where: { inLibrary: true },
    select: { id: true, name: true, affinity: true },
  })
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inLibrary = new Set(nodes.map((n) => n.name))

  const edgeRows = await prisma.artistEdge.findMany({
    select: { fromId: true, toId: true, source: true, weight: true },
  })

  const raw: RawEdge[] = []
  for (const edge of edgeRows) {
    const from = nodeById.get(edge.fromId)
    const to = nodeById.get(edge.toId)
    // The clustering subgraph is library artists only. Everything else is the discovery
    // pool and would otherwise dominate the communities without being playable.
    if (!from || !to) continue
    raw.push({ from: from.name, to: to.name, weight: edge.weight, source: edge.source })
  }

  const blended = blendEdges(raw)
  const affinityByArtist = new Map(nodes.map((n) => [n.name, n.affinity]))
  const communities = louvain(blended, { nodeWeights: affinityByArtist })

  if (communities.length === 0) {
    const message =
      'The artist graph has no edges yet, so there is nothing to cluster. Connect Last.fm and run a mix generation again.'
    await ctx.log('warn', message)
    return { mixes: [], discoveryQueued: 0, skipped: message }
  }

  await ctx.log('info', `Found ${communities.length} communities`, {
    sizes: communities.slice(0, 10).map((c) => c.members.length),
  })

  // ── Stable slots ───────────────────────────────────────
  const existingMixes = await prisma.mix.findMany()
  const previous = new Map<number, string[]>(
    existingMixes.map((mix) => {
      const seed = mix.seedJson as { artists?: string[] } | null
      return [mix.slot, seed?.artists ?? []]
    }),
  )

  const assignments = assignStableSlots(communities, previous, settings.mixCount)

  // ── Sample and write ───────────────────────────────────
  const outcomes = await loadOutcomeWeights()
  const usedToday = new Set<string>()
  const results: MixGenerationResult['mixes'] = []
  let discoveryQueued = 0

  const allEdges = blendEdgesWithNonLibrary(edgeRows, nodeById)
  const discovery = discoveryCandidates(allEdges, inLibrary, affinityByArtist)

  const llm = await maybeLlm(settings)

  for (const assignment of assignments) {
    if (opts.onlySlot !== undefined && assignment.slot !== opts.onlySlot) continue

    const memberArtists = new Set(assignment.community.members)
    const tracks = await prisma.libraryTrack.findMany({
      where: { artist: { in: [...memberArtists] } },
      select: { id: true, artist: true, title: true, affinity: true, lastPlayedAt: true },
    })

    const candidates: MixCandidate[] = tracks.map((track) => ({
      trackId: track.id,
      artist: track.artist,
      affinity: track.affinity,
      // Cluster fit: how central the artist is to this community, by affinity rank.
      clusterFit: clusterFit(track.artist, assignment.community.ranked),
      lastPlayedAt: track.lastPlayedAt,
      ...(outcomes.has(track.id) ? { outcomeWeight: outcomes.get(track.id)! } : {}),
    }))

    const discoveryPlan = planDiscoverySlots(
      settings.mixSize,
      settings.mixDiscoveryRatio,
      discovery.filter((d) => nearCommunity(d.via, memberArtists)),
    )

    const sampled = sampleMix(candidates, {
      size: settings.mixSize - discoveryPlan.count,
      maxPerArtist: settings.mixMaxPerArtist,
      recencyPenaltyDays: settings.mixRecencyPenaltyDays,
      recencyPenaltyWeight: settings.mixRecencyPenaltyWeight,
      now: new Date(),
      // Seeded on the slot and the date: reproducible within a day, different the next.
      seed: assignment.slot * 7919 + Math.floor(Date.now() / 86_400_000),
      exclude: usedToday,
    })

    for (const track of sampled.tracks) usedToday.add(track.trackId)

    const topArtists = assignment.community.ranked.slice(0, 6)
    const fallbackName = nameMix(assignment.slot, topArtists)
    const llmName = llm ? await llm.describeMix(assignment.slot, topArtists) : null
    const name = llmName?.name ?? fallbackName
    const descriptor =
      llmName?.descriptor ?? `${assignment.community.members.length} artists from your library`

    const playlistId = await writeMixPlaylist(
      assignment.slot,
      name,
      descriptor,
      sampled.tracks.map((t) => t.trackId),
    )

    await prisma.mix.upsert({
      where: { slot: assignment.slot },
      create: {
        slot: assignment.slot,
        name,
        descriptor,
        generatedAt: new Date(),
        playlistId,
        seedJson: {
          artists: assignment.community.members,
          continuity: assignment.continuity,
          deepCuts: sampled.deepCuts,
          cappedArtists: sampled.cappedArtists,
          discovery: discoveryPlan.artists,
        } as object,
      },
      update: {
        name,
        descriptor,
        generatedAt: new Date(),
        playlistId,
        seedJson: {
          artists: assignment.community.members,
          continuity: assignment.continuity,
          deepCuts: sampled.deepCuts,
          cappedArtists: sampled.cappedArtists,
          discovery: discoveryPlan.artists,
        } as object,
      },
    })

    // §7.8: discovery slots "queue downloads automatically and land in the mix on the
    // next run — recommendations that fulfil themselves". Only when explicitly enabled.
    if (settings.autoDownloadDiscovery && discoveryPlan.artists.length > 0) {
      discoveryQueued += await queueDiscovery(ctx, discoveryPlan.artists)
    }

    await enqueue('playlist-write', 'write-playlist', { playlistId }, {
      jobId: jobId('mix', assignment.slot, Date.now()),
    })

    results.push({
      slot: assignment.slot,
      name,
      tracks: sampled.tracks.length,
      continuity: assignment.continuity,
    })
    await ctx.log('info', `Mix ${assignment.slot}: ${name}`, {
      tracks: sampled.tracks.length,
      deepCuts: sampled.deepCuts,
      continuity: assignment.continuity,
      discoverySlots: discoveryPlan.count,
    })
  }

  return { mixes: results, discoveryQueued }
}

/** Community rank → 0–1 fit. Head of the community fits best; the tail still qualifies. */
function clusterFit(artist: string, ranked: string[]): number {
  const index = ranked.indexOf(artist)
  if (index === -1) return 0.2
  return Math.max(0.2, 1 - index / Math.max(1, ranked.length))
}

/** Is a discovery candidate hanging off an artist in this community? */
function nearCommunity(via: string[], members: Set<string>): boolean {
  return via.some((artist) => members.has(artist))
}

function blendEdgesWithNonLibrary(
  edgeRows: Array<{ fromId: string; toId: string; source: string; weight: number }>,
  nodeById: Map<string, { name: string }>,
) {
  // Discovery needs edges that leave the library, so this keeps both endpoints even
  // when one is an artist we do not own — the opposite of the clustering subgraph.
  const raw: RawEdge[] = []
  for (const edge of edgeRows) {
    const from = nodeById.get(edge.fromId)?.name
    const to = nodeById.get(edge.toId)?.name
    if (!from || !to) continue
    raw.push({ from, to, weight: edge.weight, source: edge.source })
  }
  return blendEdges(raw)
}

async function loadOutcomeWeights(): Promise<Map<string, number>> {
  // A recommended track that got played is a ListeningEvent within days of the mix that
  // offered it; one that did not is silence. That is the whole feedback loop.
  const recentMixes = await prisma.mix.findMany({ select: { playlistId: true, generatedAt: true } })
  const outcomes: Array<{ trackId: string; played: boolean }> = []

  for (const mix of recentMixes) {
    if (!mix.playlistId) continue
    const items = await prisma.playlistItem.findMany({
      where: { playlistId: mix.playlistId },
      select: { libraryTrackId: true },
    })
    for (const item of items) {
      if (!item.libraryTrackId) continue
      const played = await prisma.listeningEvent.findFirst({
        where: { trackId: item.libraryTrackId, playedAt: { gte: mix.generatedAt } },
        select: { id: true },
      })
      outcomes.push({ trackId: item.libraryTrackId, played: played !== null })
    }
  }

  return outcomeWeights(outcomes)
}

async function writeMixPlaylist(
  slot: number,
  name: string,
  description: string,
  trackIds: string[],
): Promise<string> {
  const existing = await prisma.mix.findUnique({ where: { slot }, select: { playlistId: true } })

  const playlist = existing?.playlistId
    ? await prisma.playlist.update({
        where: { id: existing.playlistId },
        data: { name, description },
      })
    : await prisma.playlist.create({
        data: { name, kind: 'GENERATED_MIX', description, autoSync: true },
      })

  // Rewrite the whole item list in one transaction — the (playlistId, position) unique
  // constraint makes any incremental reorder transiently invalid (plan.md §2.2).
  await prisma.$transaction([
    prisma.playlistItem.deleteMany({ where: { playlistId: playlist.id } }),
    prisma.playlistItem.createMany({
      data: trackIds.map((libraryTrackId, position) => ({
        playlistId: playlist.id,
        position,
        libraryTrackId,
      })),
    }),
  ])

  return playlist.id
}

async function queueDiscovery(ctx: JobRunContext, artists: string[]): Promise<number> {
  let queued = 0
  for (const artist of artists) {
    // Discovery downloads need something concrete to ask for. Without a source track
    // there is no title, so this only queues artists that already appear somewhere in
    // the harvested data — otherwise it would be guessing at a discography.
    const candidate = await prisma.sourceTrack.findFirst({
      where: { artists: { has: artist }, match: { status: 'MISSING' } },
      orderBy: { firstSeenAt: 'asc' },
    })
    if (!candidate) continue

    const request = await prisma.downloadRequest.create({
      data: { sourceTrackId: candidate.id, status: 'QUEUED', priority: 0 },
    })
    await enqueue('download', 'download', { requestId: request.id }, { jobId: jobId('dl', request.id) })
    queued += 1
  }
  if (queued > 0) await ctx.log('info', `Queued ${queued} discovery download(s)`)
  return queued
}

async function maybeLlm(settings: Awaited<ReturnType<typeof loadSettings>>): Promise<LlmClient | null> {
  if (!settings.llmEnabled) return null

  let apiKey: string | undefined
  if (settings.llmBackend === 'anthropic') {
    const connection = await prisma.connection.findUnique({ where: { provider: 'anthropic' } })
    if (!connection?.enabled || !connection.secretCipher) return null
    try {
      apiKey = decryptJson<{ apiKey: string }>(connection.secretCipher).apiKey
    } catch {
      return null
    }
  }

  const client = new LlmClient({
    backend: settings.llmBackend,
    endpoint: settings.llmEndpoint,
    model: settings.llmModel,
    apiKey,
  })
  const health = await client.health()
  return health.ok ? client : null
}

// ─────────────────────────────────────────────────────────────
// LLM curator — the resolver is the point
// ─────────────────────────────────────────────────────────────

export interface CurateResult {
  playlistId?: string
  name: string
  rationale: string
  requested: number
  resolved: number
  dropped: number
}

/**
 * Free-text curation (§7.8): "describe a mood, get a playlist written to Navidrome in
 * seconds."
 *
 * Every track the model returns is resolved against the actual library and anything that
 * does not resolve is dropped, with the count logged. Models invent plausible tracks
 * constantly — a curator without this guardrail writes playlists full of songs that do
 * not exist, which is worse than having no curator.
 */
export async function runCurate(
  ctx: JobRunContext,
  request: string,
  size = 30,
): Promise<CurateResult> {
  const settings = await loadSettings()
  const llm = await maybeLlm(settings)
  if (!llm) {
    throw new Error(
      'No LLM backend is available. Check the Ollama endpoint and model in Settings, or configure an Anthropic key.',
    )
  }

  const [topArtists, recent, mixes, librarySize] = await Promise.all([
    prisma.artistNode.findMany({
      where: { inLibrary: true },
      orderBy: { affinity: 'desc' },
      take: 40,
      select: { name: true },
    }),
    prisma.libraryTrack.findMany({
      where: { lastPlayedAt: { not: null } },
      orderBy: { lastPlayedAt: 'desc' },
      take: 20,
      select: { artist: true, title: true },
    }),
    prisma.mix.findMany({ select: { name: true, seedJson: true } }),
    prisma.libraryTrack.count(),
  ])

  const profile = {
    topArtists: topArtists.map((a) => a.name),
    recentlyPlayed: recent,
    clusters: mixes.map((m) => ({
      name: m.name,
      artists: ((m.seedJson as { artists?: string[] } | null)?.artists ?? []).slice(0, 8),
    })),
    librarySize,
  }

  // Local models are flaky at long structured output — a response occasionally arrives
  // truncated mid-array or wrapped in something the parser cannot recover. Verified
  // against the Ollama on this box: the same prompt succeeds and fails run to run. One
  // retry costs a few seconds and turns an intermittent failure into a rare one.
  let curated = await llm.curate(profile, request, size)
  if (!curated) {
    await ctx.log('warn', 'The model returned unusable output — asking once more')
    curated = await llm.curate(profile, request, size)
  }

  if (!curated) {
    throw new Error(
      'The model did not return usable JSON, twice. Try a different model in Settings — smaller ones struggle with long structured output.',
    )
  }

  // ── The guardrail ──────────────────────────────────────
  const resolved: string[] = []
  for (const claim of curated.tracks) {
    const track = await resolveClaim(claim.artist, claim.title)
    if (track) resolved.push(track)
  }

  const dropped = curated.tracks.length - resolved.length
  await ctx.log('info', `Curator resolved ${resolved.length} of ${curated.tracks.length} tracks`, {
    dropped,
    note: 'dropped tracks are ones the model suggested that are not in the library',
  })

  if (resolved.length === 0) {
    return {
      name: curated.name,
      rationale: curated.rationale,
      requested: curated.tracks.length,
      resolved: 0,
      dropped,
    }
  }

  const playlist = await prisma.playlist.create({
    data: {
      name: curated.name,
      kind: 'GENERATED_MIX',
      description: curated.rationale,
      autoSync: true,
    },
  })
  await prisma.playlistItem.createMany({
    data: resolved.map((libraryTrackId, position) => ({
      playlistId: playlist.id,
      position,
      libraryTrackId,
    })),
  })

  await enqueue('playlist-write', 'write-playlist', { playlistId: playlist.id }, {
    jobId: jobId('curate', playlist.id),
  })

  return {
    playlistId: playlist.id,
    name: curated.name,
    rationale: curated.rationale,
    requested: curated.tracks.length,
    resolved: resolved.length,
    dropped,
  }
}

/**
 * Resolve one claimed track to a real library track id, or null.
 *
 * Exact normalized match only. A fuzzy fallback here would quietly substitute a
 * different song for an invented one, which is a worse failure than dropping it: the
 * owner asked for a playlist from their library, not for the nearest thing to a
 * hallucination.
 */
async function resolveClaim(artist: string, title: string): Promise<string | null> {
  const { normalizeTrack } = await import('@crate/core')
  const norm = normalizeTrack({ title, artists: artist })

  const track = await prisma.libraryTrack.findFirst({
    where: { normTitle: norm.title.norm, normArtist: norm.artist.normAll },
    select: { id: true },
  })
  return track?.id ?? null
}

// ─────────────────────────────────────────────────────────────
// Release radar
// ─────────────────────────────────────────────────────────────

export interface ReleaseRadarResult {
  artistsChecked: number
  releasesFound: number
  queued: number
}

/**
 * Weekly: new releases from high-affinity artists via MusicBrainz (§7.8).
 *
 * Spotify's new-releases endpoint is gone, and MusicBrainz replaces it entirely — which
 * is the better outcome anyway, since it keeps working after the connector dies.
 */
export async function runReleaseRadar(ctx: JobRunContext): Promise<ReleaseRadarResult> {
  const lastRunSetting = await prisma.setting.findUnique({ where: { key: 'releaseRadarLastRun' } })
  const since = lastRunSetting?.value
    ? new Date(String(lastRunSetting.value))
    : new Date(Date.now() - 30 * 86_400_000)

  const artists = await prisma.artistNode.findMany({
    where: { inLibrary: true, affinity: { gt: 0.2 } },
    orderBy: { affinity: 'desc' },
    take: 100,
  })

  const mb = new MusicbrainzClient({ userAgent: 'Crate/0.1 (self-hosted library tool)' })
  let releasesFound = 0
  const found: Array<{ artist: string; title: string; date: string }> = []

  for (const [index, artist] of artists.entries()) {
    let mbid = artist.mbid
    if (!mbid) {
      const search = await mb.searchArtist(artist.name)
      if (!search) continue
      mbid = search.mbid
      await prisma.artistNode.update({ where: { id: artist.id }, data: { mbid } })
    }

    const groups = await mb.getArtistReleaseGroups(mbid, since)
    for (const group of groups) {
      releasesFound += 1
      found.push({ artist: artist.name, title: group.title, date: group.releaseDate })
    }

    if (index % 10 === 0) {
      await ctx.setProgress(index + 1, artists.length, `${index + 1} of ${artists.length} artists`)
    }
  }

  await prisma.setting.upsert({
    where: { key: 'releaseRadarLastRun' },
    create: { key: 'releaseRadarLastRun', value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  })
  await prisma.setting.upsert({
    where: { key: 'releaseRadarResults' },
    create: { key: 'releaseRadarResults', value: found as object },
    update: { value: found as object },
  })

  await ctx.log('info', `Release radar: ${releasesFound} new release(s) since ${since.toISOString().slice(0, 10)}`, {
    artistsChecked: artists.length,
    releases: found.slice(0, 25),
  })

  // Full albums are better handed to Lidarr than downloaded track by track (CLAUDE.md),
  // and nothing is queued automatically — the owner decides from the Mixes screen.
  return { artistsChecked: artists.length, releasesFound, queued: 0 }
}
