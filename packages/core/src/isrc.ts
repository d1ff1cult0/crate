/**
 * ISRC validation.
 *
 * The matching cascade treats ISRC as tier 1 — an exact identity, trusted above
 * everything else. That trust is only warranted if the value actually *is* an ISRC, and
 * in a real library assembled from assorted rips, very often it is not.
 *
 * What this cost in production, before the check existed: `registerFile` resolves a
 * file's `LibraryTrack` by ISRC first, so every file carrying the same junk string
 * collapsed into one track. A scene tagger had written `ISRC=PMEDIA` into 2,585 files,
 * and all 2,585 — completely different songs by different artists — became a single
 * `LibraryTrack` called "Good Day". Fourteen such values absorbed 2,868 files that were
 * really 2,805 distinct recordings.
 *
 * The damage went well beyond a wrong count. Those 2,804 other songs became invisible to
 * matching (one track, one title), so they were reported as missing music the owner
 * already owned — the exact failure the whole app exists to avoid.
 *
 * The real values found in the wild: `PMEDIA`, `P.M.E.D.I.A`, `WWW.iM1MUSIC.NET`, `SRC`,
 * `www.viperial.com`, `http:`, catalogue numbers like `440 014 979-2`, barcodes like
 * `0888751309128`, and `000000000000`.
 *
 * ## The format
 *
 * IFPI defines an ISRC as exactly 12 characters:
 *
 *   CC  RRR  YY  NNNNN
 *   │   │    │   └─ 5-digit designation code
 *   │   │    └───── 2-digit year of reference
 *   │   └────────── 3-character alphanumeric registrant code
 *   └────────────── 2-letter country code
 *
 * It is commonly written with hyphens (`BE-C46-14-03118`) or spaces, which are
 * presentation only — so the value is normalized before it is judged. Rejecting a
 * correctly-hyphenated ISRC would be its own kind of wrong.
 */

/** Strip presentation characters and upper-case. `BE-C46-14-03118` → `BEC461403118`. */
export function normalizeIsrc(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/** 2 letters, 3 alphanumerics, 7 digits — after normalization. */
const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/

/**
 * Is this a structurally valid ISRC?
 *
 * Structure only — it cannot tell you the registrant exists or that the code was ever
 * issued. That is fine: the purpose is to reject values that are obviously not ISRCs at
 * all, and every junk value seen in the wild fails on length or character class long
 * before authenticity becomes a question.
 */
export function isValidIsrc(raw: string | null | undefined): boolean {
  if (!raw) return false
  const normalized = normalizeIsrc(raw)
  if (!ISRC_PATTERN.test(normalized)) return false

  // All-zeros is a placeholder some taggers write instead of leaving the field empty.
  // It is structurally valid and semantically meaningless, and it would merge every
  // file carrying it into one track — the same catastrophe by a different route.
  if (/^[A-Z]{2}0{10}$/.test(normalized) || /^0+$/.test(normalized.slice(2))) return false

  return true
}

/**
 * The storable form of an ISRC, or null when the value is not one.
 *
 * Use this at every boundary where an ISRC enters the system. Returning null rather than
 * throwing is deliberate: a junk ISRC is a normal property of real files, not an error,
 * and the file is still perfectly good — it simply has one tag that cannot be trusted.
 */
export function cleanIsrc(raw: string | null | undefined): string | null {
  if (!isValidIsrc(raw)) return null
  return normalizeIsrc(raw!)
}
