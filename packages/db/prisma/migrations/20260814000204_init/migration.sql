-- CreateEnum
CREATE TYPE "Source" AS ENUM ('SPOTIFY', 'CSV', 'TEXT', 'GDPR_EXPORT', 'MANUAL', 'GENERATED');

-- CreateEnum
CREATE TYPE "IsrcStatus" AS ENUM ('PRESENT', 'ABSENT', 'BACKFILL_QUEUED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "MatchMethod" AS ENUM ('ISRC', 'MBID', 'FINGERPRINT', 'EXACT_NORM', 'FUZZY', 'MANUAL', 'NONE');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('MATCHED', 'MISSING', 'NEEDS_REVIEW', 'REJECTED', 'DOWNLOADING');

-- CreateEnum
CREATE TYPE "PlaylistKind" AS ENUM ('IMPORTED', 'GENERATED_MIX', 'MANUAL');

-- CreateEnum
CREATE TYPE "DownloadStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'MANUAL_HOLD');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('SPOTIFY_PLAYLIST', 'SPOTIFY_HARVEST', 'GDPR_EXPORT', 'CSV', 'TEXT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'NOT_OWNED');

-- CreateTable
CREATE TABLE "SourcePlaylist" (
    "id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "ownerName" TEXT,
    "ownerId" TEXT,
    "isOwned" BOOLEAN NOT NULL DEFAULT true,
    "isCollaborative" BOOLEAN NOT NULL DEFAULT false,
    "snapshotId" TEXT,
    "imageUrl" TEXT,
    "trackTotal" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "fullReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playlistId" TEXT,

    CONSTRAINT "SourcePlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceTrack" (
    "id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "artists" TEXT[],
    "albumArtist" TEXT,
    "album" TEXT,
    "durationMs" INTEGER,
    "isrc" TEXT,
    "isrcStatus" "IsrcStatus" NOT NULL DEFAULT 'PRESENT',
    "spotifyId" TEXT,
    "mbid" TEXT,
    "year" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawJson" JSONB,
    "normTitle" TEXT NOT NULL,
    "normArtist" TEXT NOT NULL,

    CONSTRAINT "SourceTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcePlaylistItem" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "sourceTrackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3),

    CONSTRAINT "SourcePlaylistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryTrack" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "albumArtist" TEXT,
    "album" TEXT,
    "durationMs" INTEGER,
    "isrc" TEXT,
    "mbid" TEXT,
    "acoustId" TEXT,
    "normTitle" TEXT NOT NULL,
    "normArtist" TEXT NOT NULL,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "lastPlayedAt" TIMESTAMP(3),
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "affinity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibraryTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibraryFile" (
    "id" TEXT NOT NULL,
    "trackId" TEXT,
    "path" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "bitrate" INTEGER,
    "sampleRate" INTEGER,
    "bitDepth" INTEGER,
    "channels" INTEGER,
    "sizeBytes" BIGINT NOT NULL,
    "durationMs" INTEGER,
    "mtime" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT,
    "fingerprint" TEXT,
    "tagsJson" JSONB NOT NULL,
    "qualityScore" INTEGER NOT NULL DEFAULT 0,
    "sourceProvider" TEXT,
    "missingSince" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "sourceTrackId" TEXT NOT NULL,
    "libraryTrackId" TEXT,
    "method" "MatchMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "MatchStatus" NOT NULL,
    "detailJson" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PlaylistKind" NOT NULL,
    "description" TEXT,
    "m3uPath" TEXT,
    "subsonicId" TEXT,
    "autoSync" BOOLEAN NOT NULL DEFAULT true,
    "lastWrittenAt" TIMESTAMP(3),
    "mixConfigJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistItem" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "libraryTrackId" TEXT,
    "sourceTrackId" TEXT,

    CONSTRAINT "PlaylistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadRequest" (
    "id" TEXT NOT NULL,
    "sourceTrackId" TEXT NOT NULL,
    "status" "DownloadStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "resultFileId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownloadRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DownloadAttempt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "candidateJson" JSONB,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DownloadAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateGroup" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DuplicateGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateMember" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "isKeeper" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT,

    CONSTRAINT "DuplicateMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrashOperation" (
    "id" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrashOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListeningEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "trackId" TEXT,
    "artistName" TEXT NOT NULL,
    "trackName" TEXT NOT NULL,
    "playedAt" TIMESTAMP(3) NOT NULL,
    "msPlayed" INTEGER,
    "skipped" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ListeningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistNode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normName" TEXT NOT NULL,
    "mbid" TEXT,
    "inLibrary" BOOLEAN NOT NULL DEFAULT false,
    "affinity" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "ArtistNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistEdge" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ArtistEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mix" (
    "id" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "descriptor" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "playlistId" TEXT,
    "seedJson" JSONB NOT NULL,

    CONSTRAINT "Mix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jobId" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER,
    "payload" JSONB,
    "logsJson" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportStatus" NOT NULL,
    "input" TEXT,
    "playlistName" TEXT,
    "imageUrl" TEXT,
    "tracksFound" INTEGER NOT NULL DEFAULT 0,
    "tracksNew" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "detailJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "accountId" TEXT,
    "externalId" TEXT,
    "displayName" TEXT,
    "secretCipher" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "metaJson" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourcePlaylist_playlistId_key" ON "SourcePlaylist"("playlistId");

-- CreateIndex
CREATE INDEX "SourcePlaylist_lastSyncedAt_idx" ON "SourcePlaylist"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourcePlaylist_source_externalId_key" ON "SourcePlaylist"("source", "externalId");

-- CreateIndex
CREATE INDEX "SourceTrack_isrc_idx" ON "SourceTrack"("isrc");

-- CreateIndex
CREATE INDEX "SourceTrack_normArtist_normTitle_idx" ON "SourceTrack"("normArtist", "normTitle");

-- CreateIndex
CREATE INDEX "SourceTrack_spotifyId_idx" ON "SourceTrack"("spotifyId");

-- CreateIndex
CREATE INDEX "SourceTrack_isrcStatus_idx" ON "SourceTrack"("isrcStatus");

-- CreateIndex
CREATE UNIQUE INDEX "SourceTrack_source_externalId_key" ON "SourceTrack"("source", "externalId");

-- CreateIndex
CREATE INDEX "SourcePlaylistItem_sourceTrackId_idx" ON "SourcePlaylistItem"("sourceTrackId");

-- CreateIndex
CREATE UNIQUE INDEX "SourcePlaylistItem_playlistId_position_key" ON "SourcePlaylistItem"("playlistId", "position");

-- CreateIndex
CREATE INDEX "LibraryTrack_isrc_idx" ON "LibraryTrack"("isrc");

-- CreateIndex
CREATE INDEX "LibraryTrack_mbid_idx" ON "LibraryTrack"("mbid");

-- CreateIndex
CREATE INDEX "LibraryTrack_acoustId_idx" ON "LibraryTrack"("acoustId");

-- CreateIndex
CREATE INDEX "LibraryTrack_normArtist_normTitle_idx" ON "LibraryTrack"("normArtist", "normTitle");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryFile_path_key" ON "LibraryFile"("path");

-- CreateIndex
CREATE INDEX "LibraryFile_contentHash_idx" ON "LibraryFile"("contentHash");

-- CreateIndex
CREATE INDEX "LibraryFile_fingerprint_idx" ON "LibraryFile"("fingerprint");

-- CreateIndex
CREATE INDEX "LibraryFile_trackId_idx" ON "LibraryFile"("trackId");

-- CreateIndex
CREATE INDEX "LibraryFile_missingSince_idx" ON "LibraryFile"("missingSince");

-- CreateIndex
CREATE UNIQUE INDEX "Match_sourceTrackId_key" ON "Match"("sourceTrackId");

-- CreateIndex
CREATE INDEX "Match_status_idx" ON "Match"("status");

-- CreateIndex
CREATE INDEX "Match_confidence_idx" ON "Match"("confidence");

-- CreateIndex
CREATE INDEX "Match_libraryTrackId_idx" ON "Match"("libraryTrackId");

-- CreateIndex
CREATE INDEX "Playlist_kind_idx" ON "Playlist"("kind");

-- CreateIndex
CREATE INDEX "PlaylistItem_libraryTrackId_idx" ON "PlaylistItem"("libraryTrackId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistItem_playlistId_position_key" ON "PlaylistItem"("playlistId", "position");

-- CreateIndex
CREATE INDEX "DownloadRequest_status_priority_idx" ON "DownloadRequest"("status", "priority");

-- CreateIndex
CREATE INDEX "DownloadRequest_sourceTrackId_idx" ON "DownloadRequest"("sourceTrackId");

-- CreateIndex
CREATE INDEX "DownloadAttempt_requestId_idx" ON "DownloadAttempt"("requestId");

-- CreateIndex
CREATE INDEX "DownloadAttempt_provider_query_outcome_createdAt_idx" ON "DownloadAttempt"("provider", "query", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "DuplicateGroup_status_idx" ON "DuplicateGroup"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateMember_groupId_fileId_key" ON "DuplicateMember"("groupId", "fileId");

-- CreateIndex
CREATE INDEX "TrashOperation_createdAt_idx" ON "TrashOperation"("createdAt");

-- CreateIndex
CREATE INDEX "ListeningEvent_playedAt_idx" ON "ListeningEvent"("playedAt");

-- CreateIndex
CREATE INDEX "ListeningEvent_artistName_idx" ON "ListeningEvent"("artistName");

-- CreateIndex
CREATE UNIQUE INDEX "ListeningEvent_source_artistName_trackName_playedAt_key" ON "ListeningEvent"("source", "artistName", "trackName", "playedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistNode_name_key" ON "ArtistNode"("name");

-- CreateIndex
CREATE INDEX "ArtistNode_normName_idx" ON "ArtistNode"("normName");

-- CreateIndex
CREATE INDEX "ArtistNode_affinity_idx" ON "ArtistNode"("affinity");

-- CreateIndex
CREATE INDEX "ArtistEdge_toId_idx" ON "ArtistEdge"("toId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistEdge_fromId_toId_source_key" ON "ArtistEdge"("fromId", "toId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "Mix_slot_key" ON "Mix"("slot");

-- CreateIndex
CREATE INDEX "JobRun_queue_startedAt_idx" ON "JobRun"("queue", "startedAt");

-- CreateIndex
CREATE INDEX "JobRun_status_idx" ON "JobRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_queue_jobId_key" ON "JobRun"("queue", "jobId");

-- CreateIndex
CREATE INDEX "ImportRun_createdAt_idx" ON "ImportRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_provider_key" ON "Connection"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_username_key" ON "AppUser"("username");

-- AddForeignKey
ALTER TABLE "SourcePlaylist" ADD CONSTRAINT "SourcePlaylist_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcePlaylistItem" ADD CONSTRAINT "SourcePlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "SourcePlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcePlaylistItem" ADD CONSTRAINT "SourcePlaylistItem_sourceTrackId_fkey" FOREIGN KEY ("sourceTrackId") REFERENCES "SourceTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryFile" ADD CONSTRAINT "LibraryFile_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "LibraryTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_sourceTrackId_fkey" FOREIGN KEY ("sourceTrackId") REFERENCES "SourceTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_libraryTrackId_fkey" FOREIGN KEY ("libraryTrackId") REFERENCES "LibraryTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_libraryTrackId_fkey" FOREIGN KEY ("libraryTrackId") REFERENCES "LibraryTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_sourceTrackId_fkey" FOREIGN KEY ("sourceTrackId") REFERENCES "SourceTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadRequest" ADD CONSTRAINT "DownloadRequest_sourceTrackId_fkey" FOREIGN KEY ("sourceTrackId") REFERENCES "SourceTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadAttempt" ADD CONSTRAINT "DownloadAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DownloadRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateMember" ADD CONSTRAINT "DuplicateMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DuplicateGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateMember" ADD CONSTRAINT "DuplicateMember_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "LibraryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistEdge" ADD CONSTRAINT "ArtistEdge_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "ArtistNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistEdge" ADD CONSTRAINT "ArtistEdge_toId_fkey" FOREIGN KEY ("toId") REFERENCES "ArtistNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mix" ADD CONSTRAINT "Mix_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;
