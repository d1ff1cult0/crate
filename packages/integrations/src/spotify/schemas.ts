/**
 * Zod schemas for Spotify responses.
 *
 * Two rules, both learned from docs/spotify-api-state.md finding J:
 *
 *  1. EVERYTHING optional except the id. Spotify removed a dozen fields in February
 *     2026 and reverted two in March. The docs' own response samples still show fields
 *     that no longer exist. A schema that requires anything beyond the id will throw on
 *     a live response sooner or later, and a harvest that throws mid-run on the last
 *     week of a subscription is unacceptable.
 *
 *  2. `.passthrough()` everywhere, and the untouched payload is persisted to rawJson.
 *     If Spotify adds something back, we keep it without a code change.
 *
 * Old and new field names coexist during the transition, so the readers below accept
 * `items ?? tracks` and `item ?? track`.
 */

import { z } from 'zod'

export const ExternalIdsSchema = z
  .object({
    isrc: z.string().optional(),
    ean: z.string().optional(),
    upc: z.string().optional(),
  })
  .passthrough()

export const ImageSchema = z
  .object({
    url: z.string(),
    height: z.number().nullable().optional(),
    width: z.number().nullable().optional(),
  })
  .passthrough()

export const SimplifiedArtistSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().optional(),
    uri: z.string().optional(),
  })
  .passthrough()

export const SimplifiedAlbumSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().optional(),
    album_type: z.string().optional(),
    release_date: z.string().optional(),
    release_date_precision: z.string().optional(),
    total_tracks: z.number().optional(),
    images: z.array(ImageSchema).optional(),
    artists: z.array(SimplifiedArtistSchema).optional(),
    external_ids: ExternalIdsSchema.optional(),
    uri: z.string().optional(),
  })
  .passthrough()

/**
 * Full track object. Carries `external_ids.isrc` — restored in March 2026 and confirmed
 * staying. This is our tier-1 matching key, so it is read defensively but relied upon.
 */
export const TrackSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().optional(),
    duration_ms: z.number().optional(),
    disc_number: z.number().optional(),
    track_number: z.number().optional(),
    explicit: z.boolean().optional(),
    is_local: z.boolean().optional(),
    artists: z.array(SimplifiedArtistSchema).optional(),
    album: SimplifiedAlbumSchema.optional(),
    external_ids: ExternalIdsSchema.optional(),
    uri: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough()

/**
 * Album tracks are SimplifiedTrackObjects and have NO external_ids at all
 * (spotify-api-state.md finding A). Modelled separately so the absence is explicit in
 * the type system rather than a surprise at runtime.
 */
export const SimplifiedTrackSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().optional(),
    duration_ms: z.number().optional(),
    disc_number: z.number().optional(),
    track_number: z.number().optional(),
    artists: z.array(SimplifiedArtistSchema).optional(),
    uri: z.string().optional(),
  })
  .passthrough()

export const PlaylistOwnerSchema = z
  .object({
    id: z.string().optional(),
    display_name: z.string().nullable().optional(),
    uri: z.string().optional(),
  })
  .passthrough()

/** Accepts both the new `item` and the deprecated `track`. */
export const PlaylistItemSchema = z
  .object({
    added_at: z.string().nullable().optional(),
    is_local: z.boolean().optional(),
    item: TrackSchema.nullable().optional(),
    track: TrackSchema.nullable().optional(),
  })
  .passthrough()

export const PagingSchema = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      href: z.string().optional(),
      items: z.array(item).optional(),
      limit: z.number().optional(),
      next: z.string().nullable().optional(),
      offset: z.number().optional(),
      previous: z.string().nullable().optional(),
      total: z.number().optional(),
    })
    .passthrough()

/**
 * The paging container as it appears INSIDE a playlist object.
 *
 * Deliberately shallow: items are read from `GET /playlists/{id}/items` as their own
 * paginated call, never from the playlist object, so nothing here needs the full
 * TrackObject shape. Nesting `PagingSchema(PlaylistItemSchema)` twice inside
 * `PlaylistSchema` also produced a type large enough that TypeScript refused to
 * serialize it (TS7056) — a real cost for a field only ever tested for presence and
 * `total`.
 */
export const PlaylistTracksRefSchema = z
  .object({
    href: z.string().optional(),
    total: z.number().optional(),
    items: z.array(z.unknown()).optional(),
  })
  .passthrough()

/**
 * The `items` field is ABSENT — not empty — for playlists the user neither owns nor
 * collaborates on. That absence is the detection signal (finding B), so it must be
 * optional here and checked explicitly by the resolver.
 */
export const PlaylistSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    collaborative: z.boolean().optional(),
    public: z.boolean().nullable().optional(),
    snapshot_id: z.string().optional(),
    owner: PlaylistOwnerSchema.optional(),
    images: z.array(ImageSchema).nullable().optional(),
    uri: z.string().optional(),
    items: PlaylistTracksRefSchema.optional(),
    tracks: PlaylistTracksRefSchema.optional(), // deprecated alias
  })
  .passthrough()

/**
 * Current user. `account_id` was added in May 2026 and is what Spotify says to use for
 * linking; `id` is still needed because playlist `owner.id` is an `id`. country/email/
 * product are deprecated and must never be relied on — market comes from settings.
 */
export const CurrentUserSchema = z
  .object({
    id: z.string(),
    account_id: z.string().optional(),
    display_name: z.string().nullable().optional(),
    images: z.array(ImageSchema).optional(),
    uri: z.string().optional(),
  })
  .passthrough()

export const SavedTrackSchema = z
  .object({
    added_at: z.string().optional(),
    track: TrackSchema.nullable().optional(),
    item: TrackSchema.nullable().optional(),
  })
  .passthrough()

export const SavedAlbumSchema = z
  .object({
    added_at: z.string().optional(),
    album: SimplifiedAlbumSchema.nullable().optional(),
    item: SimplifiedAlbumSchema.nullable().optional(),
  })
  .passthrough()

export const ArtistSchema = z
  .object({
    id: z.string().nullable(),
    name: z.string().optional(),
    genres: z.array(z.string()).optional(),
    images: z.array(ImageSchema).optional(),
    uri: z.string().optional(),
  })
  .passthrough()

export const CursorPagingSchema = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item).optional(),
      next: z.string().nullable().optional(),
      cursors: z.object({ after: z.string().optional(), before: z.string().optional() }).passthrough().optional(),
      total: z.number().optional(),
      limit: z.number().optional(),
    })
    .passthrough()

export const FollowedArtistsSchema = z
  .object({ artists: CursorPagingSchema(ArtistSchema).optional() })
  .passthrough()

export const PlayHistorySchema = z
  .object({
    track: TrackSchema.nullable().optional(),
    played_at: z.string().optional(),
    context: z.unknown().optional(),
  })
  .passthrough()

export type SpotifyTrack = z.infer<typeof TrackSchema>
export type SpotifyPlaylist = z.infer<typeof PlaylistSchema>
export type SpotifyCurrentUser = z.infer<typeof CurrentUserSchema>
export type SpotifySimplifiedAlbum = z.infer<typeof SimplifiedAlbumSchema>
export type SpotifyArtist = z.infer<typeof ArtistSchema>

/** Read a paging object under either the new or deprecated field name. */
export function readItems<T>(container: {
  items?: { items?: T[] } | undefined
  tracks?: { items?: T[] } | undefined
}): T[] | undefined {
  const paging = container.items ?? container.tracks
  return paging?.items
}

/** Read the track from a playlist item under either the new or deprecated name. */
export function readTrack(item: {
  item?: SpotifyTrack | null | undefined
  track?: SpotifyTrack | null | undefined
}): SpotifyTrack | null {
  return item.item ?? item.track ?? null
}
