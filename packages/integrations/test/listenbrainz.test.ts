import { describe, expect, it, vi } from 'vitest'
import {
  ARTIST_ALGORITHM,
  ListenbrainzClient,
  RECORDING_ALGORITHM,
} from '../src/listenbrainz/client.js'

/**
 * Shapes here are copied from real responses captured 2026-08-14, not invented — the
 * whole point of replacing Last.fm was that ListenBrainz's contract is different, and a
 * fixture that agrees with my assumptions rather than the API would test nothing.
 */

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/**
 * A spy with fetch's real signature, so `mock.calls[n]` is typed and the URL and headers
 * can be asserted on. `vi.fn(async () => …)` infers a zero-argument function and loses
 * both.
 */
function spyFetch(handler: () => Response) {
  return vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(handler()),
  )
}

const SIMILAR_ARTISTS = [
  {
    artist_mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
    name: 'Nirvana',
    comment: '1980s–1990s US grunge band',
    type: 'Group',
    gender: null,
    score: 11156,
    reference_mbid: RADIOHEAD,
  },
  {
    artist_mbid: '8bfac288-ccc5-448d-9573-c33ea2aa5c30',
    name: 'Red Hot Chili Peppers',
    comment: '',
    type: 'Group',
    gender: null,
    score: 10587,
    reference_mbid: RADIOHEAD,
  },
]

describe('similarArtists', () => {
  it('parses a real response and orders by the score the API gave', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () => jsonResponse(SIMILAR_ARTISTS)) as unknown as typeof fetch,
    })
    const result = await client.similarArtists(RADIOHEAD)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ name: 'Nirvana', score: 11156 })
    expect(result[0]!.mbid).toBe('5b11f4ce-a62d-471e-81fc-a69a8278c7da')
  })

  it('sends the required algorithm parameter', async () => {
    // Omitting `algorithm` is a 400 with an HTML body, not a default. Verified against
    // the live API — this is the single easiest way to get nothing back.
    const fetchImpl = spyFetch(() => jsonResponse(SIMILAR_ARTISTS))
    const client = new ListenbrainzClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.similarArtists(RADIOHEAD)

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.origin).toBe('https://labs.api.listenbrainz.org')
    expect(url.pathname).toBe('/similar-artists/json')
    expect(url.searchParams.get('artist_mbids')).toBe(RADIOHEAD)
    expect(url.searchParams.get('algorithm')).toBe(ARTIST_ALGORITHM)
  })

  it('drops the reference artist from its own results', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        jsonResponse([
          { artist_mbid: RADIOHEAD, name: 'Radiohead', score: 99999 },
          ...SIMILAR_ARTISTS,
        ])) as unknown as typeof fetch,
    })
    const result = await client.similarArtists(RADIOHEAD)
    expect(result.map((a) => a.mbid)).not.toContain(RADIOHEAD)
  })

  it('returns nothing rather than throwing when the API answers with an HTML error', async () => {
    // A 400 from the Labs API is an HTML page. json() rejects, and that must not
    // propagate — every integration has to be survivable.
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        new Response('<!doctype html><title>400 Bad Request</title>', {
          status: 400,
          headers: { 'Content-Type': 'text/html' },
        })) as unknown as typeof fetch,
    })
    expect(await client.similarArtists(RADIOHEAD)).toEqual([])
  })

  it('survives the service being unreachable', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(await client.similarArtists(RADIOHEAD)).toEqual([])
  })
})

describe('similarRecordings', () => {
  it('parses a real response', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        jsonResponse([
          {
            recording_mbid: '40bd0203-bc3f-4b15-9ab3-ceeb2ef35d7a',
            recording_name: 'Hotel California',
            artist_credit_name: 'Eagles',
            artist_credit_mbids: null,
            release_name: 'Hotel California',
            score: 1169,
          },
        ])) as unknown as typeof fetch,
    })
    const result = await client.similarRecordings('b1a9c0e9-d987-4042-ae91-78d6a3267d69')
    expect(result[0]).toMatchObject({ title: 'Hotel California', artist: 'Eagles', score: 1169 })
    // artist_credit_mbids is legitimately null in real responses.
    expect(result[0]!.artistMbids).toEqual([])
  })

  it('uses the recording algorithm, which differs from the artist one', async () => {
    const fetchImpl = spyFetch(() => jsonResponse([]))
    const client = new ListenbrainzClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.similarRecordings('b1a9c0e9-d987-4042-ae91-78d6a3267d69')

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('algorithm')).toBe(RECORDING_ALGORITHM)
    expect(RECORDING_ALGORITHM).not.toBe(ARTIST_ALGORITHM)
  })
})

describe('listens', () => {
  const payload = {
    payload: {
      count: 1,
      listens: [
        {
          listened_at: 1786657073,
          track_metadata: {
            artist_name: 'Udo Jürgens',
            track_name: 'Griechischer Wein',
            additional_info: {
              artist_mbids: ['20e903b8-4b5f-414a-a467-dd6e46933d3e'],
              recording_mbid: 'c85f1184-9482-4703-a805-b478ebae17c3',
              duration_ms: 245_000,
            },
          },
        },
      ],
    },
  }

  it('reads MBIDs straight off the listen — the thing Last.fm could not do', async () => {
    const client = new ListenbrainzClient({
      token: 't',
      fetchImpl: (async () => jsonResponse(payload)) as unknown as typeof fetch,
    })
    const listens = await client.listens('d1ff1cult')
    expect(listens).toHaveLength(1)
    expect(listens[0]!.artistMbids).toEqual(['20e903b8-4b5f-414a-a467-dd6e46933d3e'])
    expect(listens[0]!.recordingMbid).toBe('c85f1184-9482-4703-a805-b478ebae17c3')
    expect(listens[0]!.playedAt).toEqual(new Date(1786657073 * 1000))
  })

  it('prefers the mapping when the submitter sent an EMPTY artist_mbids array', async () => {
    // The exact shape Navidrome submits, captured from the owner's own history. The
    // submitted array is present but empty and ListenBrainz's mapping holds the real
    // ids — a `??` chain keeps the empty array and loses them, which is what this
    // regression test exists to stop happening again.
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        jsonResponse({
          payload: {
            listens: [
              {
                listened_at: 1786657073,
                track_metadata: {
                  artist_name: 'Udo Jürgens',
                  track_name: 'Griechischer Wein',
                  additional_info: {
                    artist_mbids: [],
                    duration_ms: 245160,
                    submission_client: 'navidrome',
                  },
                  mbid_mapping: {
                    artist_mbids: ['20e903b8-4b5f-414a-a467-dd6e46933d3e'],
                    recording_mbid: 'c85f1184-9482-4703-a805-b478ebae17c3',
                  },
                },
              },
            ],
          },
        })) as unknown as typeof fetch,
    })
    const listens = await client.listens('d1ff1cult')
    expect(listens[0]!.artistMbids).toEqual(['20e903b8-4b5f-414a-a467-dd6e46933d3e'])
    expect(listens[0]!.recordingMbid).toBe('c85f1184-9482-4703-a805-b478ebae17c3')
  })

  it('still prefers submitted MBIDs when there actually are some', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        jsonResponse({
          payload: {
            listens: [
              {
                listened_at: 1,
                track_metadata: {
                  artist_name: 'A',
                  track_name: 'B',
                  additional_info: { artist_mbids: ['submitted'] },
                  mbid_mapping: { artist_mbids: ['guessed'] },
                },
              },
            ],
          },
        })) as unknown as typeof fetch,
    })
    expect((await client.listens('x'))[0]!.artistMbids).toEqual(['submitted'])
  })

  it('falls back to ListenBrainz own mapping when the submitter sent no MBIDs', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        jsonResponse({
          payload: {
            listens: [
              {
                listened_at: 1786657073,
                track_metadata: {
                  artist_name: 'Shame',
                  track_name: 'Concrete',
                  mbid_mapping: { artist_mbids: ['abc'], recording_mbid: 'def' },
                },
              },
            ],
          },
        })) as unknown as typeof fetch,
    })
    const listens = await client.listens('someone')
    expect(listens[0]!.artistMbids).toEqual(['abc'])
    expect(listens[0]!.recordingMbid).toBe('def')
  })

  it('passes min_ts so a sync resumes instead of re-reading history', async () => {
    const fetchImpl = spyFetch(() => jsonResponse(payload))
    const client = new ListenbrainzClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.listens('d1ff1cult', { minTs: 1786657073 })

    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.searchParams.get('min_ts')).toBe('1786657073')
  })

  it('drops listens with no timestamp rather than inventing one', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () =>
        jsonResponse({
          payload: { listens: [{ track_metadata: { artist_name: 'A', track_name: 'B' } }] },
        })) as unknown as typeof fetch,
    })
    expect(await client.listens('someone')).toEqual([])
  })

  it('sends the token when there is one', async () => {
    const fetchImpl = spyFetch(() => jsonResponse(payload))
    const client = new ListenbrainzClient({
      token: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await client.listens('d1ff1cult')

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Token secret-token')
  })

  it('sends no Authorization header when there is no token', async () => {
    const fetchImpl = spyFetch(() => jsonResponse(SIMILAR_ARTISTS))
    const client = new ListenbrainzClient({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.similarArtists(RADIOHEAD)

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('rate limiting', () => {
  it('waits exactly as long as the server asked when the window is exhausted', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve())
    let call = 0
    const client = new ListenbrainzClient({
      sleep,
      fetchImpl: (async () => {
        call += 1
        // First response exhausts the window and says to wait 7 seconds.
        return jsonResponse(SIMILAR_ARTISTS, {
          'x-ratelimit-remaining': call === 1 ? '0' : '29',
          'x-ratelimit-reset-in': '7',
        })
      }) as unknown as typeof fetch,
    })

    await client.similarArtists(RADIOHEAD)
    expect(sleep).not.toHaveBeenCalled() // nothing to wait for yet

    await client.similarArtists(RADIOHEAD)
    // Honours the header rather than guessing with a fixed sleep.
    const waited = sleep.mock.calls[0]![0]
    expect(waited).toBeGreaterThan(6000)
    expect(waited).toBeLessThanOrEqual(7250)
  })

  it('retries a 429 after the interval the server specified', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve())
    let call = 0
    const client = new ListenbrainzClient({
      sleep,
      fetchImpl: (async () => {
        call += 1
        if (call === 1) {
          return new Response('', {
            status: 429,
            headers: { 'x-ratelimit-reset-in': '3', 'x-ratelimit-remaining': '0' },
          })
        }
        return jsonResponse(SIMILAR_ARTISTS)
      }) as unknown as typeof fetch,
    })

    const result = await client.similarArtists(RADIOHEAD)
    expect(result).toHaveLength(2) // the retry succeeded
    expect(sleep).toHaveBeenCalled()
  })
})

describe('validateToken', () => {
  it('reports the username the token belongs to', async () => {
    const client = new ListenbrainzClient({
      token: 't',
      fetchImpl: (async () =>
        jsonResponse({
          code: 200,
          message: 'Token valid.',
          user_name: 'd1ff1cult',
          valid: true,
        })) as unknown as typeof fetch,
    })
    const result = await client.validateToken()
    expect(result.valid).toBe(true)
    expect(result.username).toBe('d1ff1cult')
  })

  it('reports an invalid token without throwing', async () => {
    const client = new ListenbrainzClient({
      token: 'nope',
      fetchImpl: (async () =>
        jsonResponse({ code: 200, message: 'Token invalid.', valid: false })) as unknown as typeof fetch,
    })
    expect((await client.validateToken()).valid).toBe(false)
  })

  it('says so plainly when there is no token at all', async () => {
    const client = new ListenbrainzClient({})
    expect(await client.validateToken()).toEqual({ valid: false, detail: 'No token configured' })
  })
})

describe('health', () => {
  it('passes with no token, because similarity needs none', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () => jsonResponse(SIMILAR_ARTISTS)) as unknown as typeof fetch,
    })
    const health = await client.health()
    expect(health.ok).toBe(true)
    expect(health.detail).toMatch(/No token/)
  })

  it('fails when similarity itself is down', async () => {
    const client = new ListenbrainzClient({
      fetchImpl: (async () => jsonResponse([])) as unknown as typeof fetch,
    })
    expect((await client.health()).ok).toBe(false)
  })

  it('fails when a token is set but rejected', async () => {
    let call = 0
    const client = new ListenbrainzClient({
      token: 'bad',
      fetchImpl: (async () => {
        call += 1
        return call === 1
          ? jsonResponse(SIMILAR_ARTISTS)
          : jsonResponse({ valid: false, message: 'Token invalid.' })
      }) as unknown as typeof fetch,
    })
    const health = await client.health()
    expect(health.ok).toBe(false)
    expect(health.detail).toMatch(/token was rejected/)
  })
})
