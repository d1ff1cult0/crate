/**
 * LLM curator backend. PROMPT.md §7.8.
 *
 * "Configurable backend — Ollama endpoint and model, or an Anthropic API key."
 *
 * Ollama is the default because it is local, on the owner's own GPU, free to call, and
 * survives every external service going away — which is the same principle the rest of
 * this app is built on.
 *
 * The rule that makes this module safe to ship at all:
 *
 *   "Strict JSON output, and every returned track resolved against the actual library
 *    before use. Anything that doesn't resolve is dropped silently, with a count logged.
 *    Models will invent plausible tracks; the resolver is the guardrail, not a nicety."
 *
 * So this file's job is narrow: get JSON out of a model, parse it defensively, and hand
 * back a plain list of *claims*. It deliberately has no idea what is in the library. The
 * resolver that checks those claims lives in the worker, where the database is, and
 * nothing reaches a playlist without passing through it.
 */

import { z } from 'zod'

export type LlmBackend = 'ollama' | 'anthropic'

export interface LlmConfig {
  backend: LlmBackend
  /** Ollama base URL, e.g. http://localhost:11434. Ignored for Anthropic. */
  endpoint?: string
  model: string
  apiKey?: string | undefined
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface LlmTrackClaim {
  artist: string
  title: string
}

export interface CuratedPlaylist {
  name: string
  rationale: string
  tracks: LlmTrackClaim[]
}

/** What we ask the model to return. Permissive on purpose — models drift. */
const CuratedSchema = z.object({
  name: z.string().min(1),
  rationale: z.string().default(''),
  tracks: z
    .array(
      z.object({
        artist: z.string().min(1),
        title: z.string().min(1),
      }),
    )
    .default([]),
})

export interface TasteProfile {
  topArtists: string[]
  recentlyPlayed: Array<{ artist: string; title: string }>
  clusters: Array<{ name: string; artists: string[] }>
  librarySize: number
}

const SYSTEM_PROMPT = `You are a music curator working strictly from one person's own music library.

Rules:
- Only suggest tracks you believe are actually in the described library. Prefer artists named in the profile.
- Never invent a track to fill space. A short, correct playlist beats a long, invented one.
- Reply with JSON only. No prose, no markdown fences, no commentary.

Reply with exactly this shape:
{"name": "...", "rationale": "one or two sentences", "tracks": [{"artist": "...", "title": "..."}]}`

function buildUserPrompt(profile: TasteProfile, request: string, size: number): string {
  const clusters = profile.clusters
    .map((c) => `- ${c.name}: ${c.artists.slice(0, 8).join(', ')}`)
    .join('\n')
  const recent = profile.recentlyPlayed
    .slice(0, 20)
    .map((t) => `${t.artist} — ${t.title}`)
    .join('\n')

  return `Library size: ${profile.librarySize} tracks.

Top artists: ${profile.topArtists.slice(0, 40).join(', ')}

Listening clusters:
${clusters || '(none computed yet)'}

Recently played:
${recent || '(nothing recorded yet)'}

Request: ${request}

Return about ${size} tracks.`
}

/**
 * Pull the first JSON object out of a model response.
 *
 * Models wrap JSON in prose and fences no matter how firmly they are told not to, and a
 * curator that fails because the model said "Here you go!" first would be useless. This
 * is lenient about the wrapper and strict about the contents.
 */
export function extractJson(raw: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced?.[1] ?? raw

  const start = body.indexOf('{')
  if (start === -1) return null

  // Walk to the matching brace rather than taking the last one in the string, which
  // breaks as soon as the model adds a closing remark containing punctuation.
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const char = body[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') inString = !inString
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export class LlmClient {
  private readonly config: LlmConfig
  private readonly fetchImpl: typeof fetch

  constructor(config: LlmConfig) {
    this.config = config
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    if (this.config.backend === 'ollama') {
      try {
        const res = await this.fetchImpl(`${this.endpoint()}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return { ok: false, detail: `Ollama returned ${res.status}` }
        const body = (await res.json()) as { models?: Array<{ name?: string }> }
        const names = (body.models ?? []).map((m) => m.name ?? '')
        const present = names.some((n) => n.startsWith(this.config.model))
        return present
          ? { ok: true, detail: `Ollama has ${this.config.model}` }
          : {
              ok: false,
              detail: `Ollama is reachable but does not have "${this.config.model}". Available: ${names.join(', ') || 'none'}`,
            }
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }

    return this.config.apiKey
      ? { ok: true, detail: 'Anthropic API key present' }
      : { ok: false, detail: 'No Anthropic API key configured' }
  }

  private endpoint(): string {
    return (this.config.endpoint ?? 'http://localhost:11434').replace(/\/+$/, '')
  }

  /** Raw completion. Returns null rather than throwing — the curator is optional. */
  async complete(system: string, user: string): Promise<string | null> {
    const timeoutMs = this.config.timeoutMs ?? 120_000
    try {
      if (this.config.backend === 'ollama') {
        const res = await this.fetchImpl(`${this.endpoint()}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model: this.config.model,
            stream: false,
            // Ollama's JSON mode. Belt and braces with extractJson, because the mode
            // constrains the grammar but not the model's enthusiasm for preamble.
            format: 'json',
            options: { temperature: 0.7 },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
        })
        if (!res.ok) return null
        const body = (await res.json()) as { message?: { content?: string } }
        return body.message?.content ?? null
      }

      if (!this.config.apiKey) return null
      const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 4096,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { content?: Array<{ text?: string }> }
      return body.content?.map((c) => c.text ?? '').join('') ?? null
    } catch {
      return null
    }
  }

  /**
   * Ask for a themed playlist.
   *
   * Returns CLAIMS, not tracks. Every one of them is a guess by a model that has never
   * seen the library, and none of them may be used before the caller resolves it against
   * real rows.
   */
  async curate(
    profile: TasteProfile,
    request: string,
    size = 30,
  ): Promise<CuratedPlaylist | null> {
    const raw = await this.complete(SYSTEM_PROMPT, buildUserPrompt(profile, request, size))
    if (!raw) return null

    const json = extractJson(raw)
    if (!json) return null

    const parsed = CuratedSchema.safeParse(json)
    if (!parsed.success) return null

    return {
      name: parsed.data.name,
      rationale: parsed.data.rationale,
      tracks: parsed.data.tracks,
    }
  }

  /**
   * Name and describe an algorithmic mix "in a way that isn't robotic" (§7.8).
   *
   * Falls back to null on any failure, and the caller keeps the deterministic
   * "Mix 2 — Fontaines D.C., IDLES, Shame and more" name. The LLM is allowed to improve
   * the name; it is never allowed to be the reason a mix has no name.
   */
  async describeMix(
    slot: number,
    artists: string[],
  ): Promise<{ name: string; descriptor: string } | null> {
    const raw = await this.complete(
      'You name music playlists. Reply with JSON only: {"name": "...", "descriptor": "..."}. The name is at most six words and never generic ("Mix 1", "My Playlist" are forbidden). The descriptor is one short sentence.',
      `These artists dominate this playlist: ${artists.slice(0, 12).join(', ')}. Name it.`,
    )
    if (!raw) return null

    const json = extractJson(raw)
    const parsed = z
      .object({ name: z.string().min(1), descriptor: z.string().default('') })
      .safeParse(json)
    if (!parsed.success) return null
    if (/^mix\s*\d*$/i.test(parsed.data.name.trim())) return null // it ignored the rule

    return { name: `Mix ${slot} — ${parsed.data.name}`, descriptor: parsed.data.descriptor }
  }
}
