-- Last.fm → ListenBrainz (docs/DECISIONS.md D8).
--
-- `ArtistEdge.source` and `ListeningEvent.source` are free-text discriminators rather
-- than enums, so this is a data migration, not a schema change. Renaming the values
-- matters because `SOURCE_WEIGHTS` in packages/core/src/graph.ts now blends on
-- 'LISTENBRAINZ' — any row left as 'LASTFM' would fall through to the default weight and
-- quietly contribute at the wrong strength rather than failing visibly.
--
-- Deliberately a RENAME and not a DELETE. Edges harvested from Last.fm are still real
-- similarity data; they are simply relabelled to the source that now occupies that slot
-- in the blend. If the owner prefers a clean slate, deleting them is a one-liner they can
-- run whenever — but throwing away collected data as a side effect of a config change is
-- not a decision a migration should make for them.

UPDATE "ArtistEdge"     SET "source" = 'LISTENBRAINZ' WHERE "source" = 'LASTFM';
UPDATE "ListeningEvent" SET "source" = 'LISTENBRAINZ' WHERE "source" = 'LASTFM';

-- The stored credential shape is different (Last.fm took an API key; ListenBrainz takes
-- an optional user token), so the old row cannot be reinterpreted. Disable it and drop
-- the ciphertext rather than deleting the row, which is what DELETE /api/connections
-- does too — history and last-error context survive a reconnect.
UPDATE "Connection"
   SET "enabled" = false,
       "secretCipher" = NULL,
       "lastError" = 'Replaced by ListenBrainz — reconnect under the new provider.'
 WHERE "provider" = 'lastfm';
