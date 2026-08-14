/**
 * Making real-world tag strings safe to store.
 *
 * A 35,000-track library assembled from rips of every provenance contains tags that no
 * well-formed encoder would produce. One of them stopped a full library scan dead:
 *
 *   invalid byte sequence for encoding "UTF8": 0x00
 *
 * Postgres text and jsonb columns cannot hold a NUL byte at all. Not "should not" — the
 * driver rejects the whole statement, so a single corrupt tag in one file aborts the
 * insert for that file and, depending on where it lands, can look like the scanner
 * failing rather than one bad file.
 *
 * Two classes of problem are handled, and both are real rather than theoretical:
 *
 *  1. **NUL and other C0 control characters.** Usually the tail of a fixed-width ID3
 *     field that was never trimmed, or a UTF-16 tag read as UTF-8 (which turns every
 *     other byte into a NUL).
 *  2. **Unpaired surrogates.** A JavaScript string can hold half of a surrogate pair;
 *     UTF-8 cannot encode one. These arrive from tags written by software that truncated
 *     a string by UTF-16 code unit rather than by code point, and they produce the same
 *     "invalid byte sequence" error from Postgres for a completely different reason.
 *
 * Deliberately NOT a normalizer. This does not case-fold, strip punctuation or touch
 * anything a human would recognise as part of the title — `normalize.ts` does that, and
 * conflating the two would mean "make this storable" quietly also meant "make this
 * different". Sanitizing "Sigur Rós" must return "Sigur Rós".
 */

/** C0 controls and DEL, except tab/newline/carriage return which are handled separately. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** Tab, newline and carriage return: meaningful in text, junk inside a tag field. */
// eslint-disable-next-line no-control-regex
const LINE_BREAKS = /[\t\n\r]+/g

/**
 * A surrogate not paired with its partner. `\uD800-\uDBFF` must be followed by
 * `\uDC00-\uDFFF` and vice versa; anything else cannot be encoded as UTF-8.
 */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export interface SanitizeResult {
  value: string
  /** True when anything was actually removed — worth logging with the file path. */
  changed: boolean
}

/**
 * Strip everything Postgres cannot store, and report whether it had to.
 *
 * The `changed` flag exists so the scanner can name the offending file. A tag quietly
 * repaired is a tag the owner cannot go and fix at the source.
 */
export function sanitizeTextVerbose(input: string): SanitizeResult {
  const cleaned = input
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(LONE_SURROGATES, '')
    // Collapse the whitespace a removal may have left doubled up.
    .replace(/\s{2,}/g, ' ')
    .trim()

  return { value: cleaned, changed: cleaned !== input }
}

/** The common case: just give me something storable. */
export function sanitizeText(input: string): string {
  return sanitizeTextVerbose(input).value
}

/** Null-safe variant, for the many optional tag fields. */
export function sanitizeTextOrNull(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null
  const cleaned = sanitizeText(input)
  return cleaned === '' ? null : cleaned
}

export interface SanitizeObjectResult<T> {
  value: T
  /** Keys whose values were modified, for a log line that says what was wrong. */
  changedKeys: string[]
}

/**
 * Recursively sanitize every string in a plain object or array.
 *
 * Needed for `tagsJson` and `rawJson`: Postgres rejects a NUL inside jsonb just as
 * firmly as in a text column, so a payload stored verbatim is a payload that can fail to
 * store. Keys are sanitized too — a NUL in a key is rarer but equally fatal.
 *
 * Non-string leaves pass through untouched, so numbers, booleans and nulls keep their
 * types rather than being stringified.
 */
export function sanitizeDeep<T>(input: T): SanitizeObjectResult<T> {
  const changedKeys: string[] = []

  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      const result = sanitizeTextVerbose(value)
      if (result.changed) changedKeys.push(path || '(root)')
      return result.value
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, `${path}[${index}]`))
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const cleanKey = sanitizeText(key)
        if (cleanKey !== key) changedKeys.push(`${path ? `${path}.` : ''}${cleanKey} (key)`)
        out[cleanKey] = walk(item, path ? `${path}.${cleanKey}` : cleanKey)
      }
      return out
    }
    return value
  }

  return { value: walk(input, '') as T, changedKeys }
}

/**
 * Does this string contain anything Postgres would refuse?
 *
 * Cheap enough to call before doing the work of sanitizing, and it makes the intent of a
 * guard clause obvious at the call site.
 */
export function hasUnstorableCharacters(input: string): boolean {
  CONTROL_CHARS.lastIndex = 0
  LONE_SURROGATES.lastIndex = 0
  return CONTROL_CHARS.test(input) || LONE_SURROGATES.test(input)
}
