import { describe, expect, it } from 'vitest'
import { LlmClient, extractJson } from '../src/llm/client.js'

/**
 * These test the guardrail, not the model. §7.8 is explicit that "models will invent
 * plausible tracks; the resolver is the guardrail, not a nicety" — and the resolver only
 * gets a chance to run if the response can be parsed at all. Every case below is a real
 * shape a local model produces.
 */
describe('extractJson', () => {
  it('reads a bare JSON object', () => {
    expect(extractJson('{"name":"A","tracks":[]}')).toEqual({ name: 'A', tracks: [] })
  })

  it('reads JSON out of a fenced block', () => {
    const raw = '```json\n{"name":"A","tracks":[]}\n```'
    expect(extractJson(raw)).toEqual({ name: 'A', tracks: [] })
  })

  it('reads JSON out of an unlabelled fence', () => {
    expect(extractJson('```\n{"name":"A"}\n```')).toEqual({ name: 'A' })
  })

  it('ignores preamble however firmly the model was told not to add any', () => {
    expect(extractJson('Sure! Here you go:\n\n{"name":"A"}')).toEqual({ name: 'A' })
  })

  it('stops at the matching brace rather than the last one in the string', () => {
    // The closing remark contains a brace. Taking the last "}" in the response would
    // produce something unparseable and lose an otherwise perfectly good playlist.
    const raw = '{"name":"A","tracks":[]} Hope that helps! {enjoy}'
    expect(extractJson(raw)).toEqual({ name: 'A', tracks: [] })
  })

  it('handles braces inside string values', () => {
    const raw = '{"name":"Set {1}","rationale":"uses } and { characters"}'
    expect(extractJson(raw)).toEqual({ name: 'Set {1}', rationale: 'uses } and { characters' })
  })

  it('handles escaped quotes inside string values', () => {
    const raw = '{"name":"She said \\"hi\\"","tracks":[]}'
    expect(extractJson(raw)).toEqual({ name: 'She said "hi"', tracks: [] })
  })

  it('returns null for a response truncated mid-object', () => {
    // Verified against the local model: long structured output occasionally arrives cut
    // off. Returning null here is what triggers the single retry in the curator job.
    expect(extractJson('{"name":"A","tracks":[{"artist":"X","tit')).toBeNull()
  })

  it('returns null when there is no JSON at all', () => {
    expect(extractJson("I'm sorry, I can't help with that.")).toBeNull()
  })
})

/** A stub backend, so the client's own behaviour is testable without a model. */
function stubFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
}

const PROFILE = {
  topArtists: ['IDLES'],
  recentlyPlayed: [{ artist: 'IDLES', title: 'Danny Nedelko' }],
  clusters: [],
  librarySize: 100,
}

describe('LlmClient.curate', () => {
  it('returns claims when the model behaves', async () => {
    const client = new LlmClient({
      backend: 'ollama',
      model: 'test',
      fetchImpl: stubFetch({
        message: {
          content: '{"name":"Loud","rationale":"because","tracks":[{"artist":"IDLES","title":"Danny Nedelko"}]}',
        },
      }),
    })
    const result = await client.curate(PROFILE, 'loud things')
    expect(result?.name).toBe('Loud')
    expect(result?.tracks).toEqual([{ artist: 'IDLES', title: 'Danny Nedelko' }])
  })

  it('drops malformed track entries rather than failing the whole playlist', async () => {
    const client = new LlmClient({
      backend: 'ollama',
      model: 'test',
      fetchImpl: stubFetch({
        message: {
          content:
            '{"name":"Loud","tracks":[{"artist":"IDLES","title":"Danny Nedelko"},{"artist":"","title":""}]}',
        },
      }),
    })
    // Zod rejects the empty entry, which takes the whole parse with it — and returning
    // null is correct: a response the schema cannot vouch for is not usable, and the
    // curator retries rather than writing half a playlist it does not trust.
    expect(await client.curate(PROFILE, 'loud things')).toBeNull()
  })

  it('returns null rather than throwing when the backend is down', async () => {
    const client = new LlmClient({
      backend: 'ollama',
      model: 'test',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(await client.curate(PROFILE, 'anything')).toBeNull()
  })

  it('reports a missing model rather than claiming to be healthy', async () => {
    const client = new LlmClient({
      backend: 'ollama',
      model: 'not-installed',
      fetchImpl: stubFetch({ models: [{ name: 'something-else' }] }),
    })
    const health = await client.health()
    expect(health.ok).toBe(false)
    expect(health.detail).toContain('not-installed')
  })
})

describe('LlmClient.describeMix', () => {
  it('rejects a generic name and lets the caller keep the deterministic one', async () => {
    const client = new LlmClient({
      backend: 'ollama',
      model: 'test',
      fetchImpl: stubFetch({ message: { content: '{"name":"Mix 1","descriptor":"songs"}' } }),
    })
    expect(await client.describeMix(1, ['IDLES'])).toBeNull()
  })

  it('accepts a real name and prefixes the slot', async () => {
    const client = new LlmClient({
      backend: 'ollama',
      model: 'test',
      fetchImpl: stubFetch({
        message: { content: '{"name":"Shouting Into Concrete","descriptor":"Loud British guitars."}' },
      }),
    })
    const result = await client.describeMix(2, ['IDLES'])
    expect(result?.name).toBe('Mix 2 — Shouting Into Concrete')
  })
})
