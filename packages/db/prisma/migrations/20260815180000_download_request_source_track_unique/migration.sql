-- Enforce the domain invariant atomically. Prefer an existing RUNNING/QUEUED request
-- so its deterministic BullMQ job remains valid; reattach all audit attempts before
-- removing duplicates. No DownloadAttempt history is discarded.
WITH ranked AS (
  SELECT "id", "sourceTrackId",
         FIRST_VALUE("id") OVER (
           PARTITION BY "sourceTrackId"
           ORDER BY CASE "status" WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 ELSE 2 END,
                    "createdAt", "id"
         ) AS keeper
  FROM "DownloadRequest"
), moved AS (
  UPDATE "DownloadAttempt" a
  SET "requestId" = ranked.keeper
  FROM ranked
  WHERE a."requestId" = ranked."id" AND ranked."id" <> ranked.keeper
  RETURNING a."id"
)
DELETE FROM "DownloadRequest" d
USING ranked
WHERE d."id" = ranked."id" AND ranked."id" <> ranked.keeper;

DROP INDEX IF EXISTS "DownloadRequest_sourceTrackId_idx";
CREATE UNIQUE INDEX "DownloadRequest_sourceTrackId_key" ON "DownloadRequest"("sourceTrackId");
