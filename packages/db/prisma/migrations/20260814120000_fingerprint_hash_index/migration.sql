-- Chromaprint fingerprints cannot live in a btree index.
--
-- A fingerprint for a normal-length track is 1–3 KB of base64. Postgres refuses any
-- btree index entry over 2704 bytes, so `LibraryFile_fingerprint_idx` did not fail when
-- it was created — it failed on every INSERT and UPDATE once real fingerprints started
-- landing, which took the whole fingerprint queue down with it:
--
--   index row size 3480 exceeds btree version 4 maximum 2704 for index
--   "LibraryFile_fingerprint_idx"
--
-- The index only ever answered one question — "is this exact fingerprint already in the
-- library?" — so a fixed-width digest of it answers the same question and indexes fine.
-- The full fingerprint stays in the column: dedupe grouping compares the real values in
-- application code, where there is no size limit and no collision risk at all.
--
-- Additive and non-destructive: no column is dropped and no row is deleted.

DROP INDEX IF EXISTS "LibraryFile_fingerprint_idx";

ALTER TABLE "LibraryFile" ADD COLUMN "fingerprintHash" TEXT;

-- Backfill anything already fingerprinted before this migration. md5() here matches the
-- digest the worker computes, so rows written either side of this migration agree.
UPDATE "LibraryFile"
   SET "fingerprintHash" = md5("fingerprint")
 WHERE "fingerprint" IS NOT NULL;

CREATE INDEX "LibraryFile_fingerprintHash_idx" ON "LibraryFile"("fingerprintHash");
