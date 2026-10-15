/**
 * Protocol adapters: the field-by-field contract of the two first-period
 * protocols, plus the settings rules that decide whether a call may go out.
 */

import { describe, expect, it } from 'vitest'
import { fillTemplate, readNumber, readPath, readString } from '../src/providers/dot-path.ts'
import { providerErrorOf } from '../src/providers/adapter.ts'
import { buildArkBody, readArkState } from '../src/providers/ark-seedance.ts'
import { buildOpenAiVideosBody, endpointPath, readState } from '../src/providers/generic-openai-videos.ts'
import { buildMinimaxBody, minimaxVideoAdapter, readMinimaxState } from '../src/providers/minimax-video.ts'
import { ConfigError, DEFAULT_ENDPOINTS, assertGeometry, environmentFallbackName, resolveSize, resolveTarget, statusWords, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { GenerationRequest } from '../src/types.ts'

const MODEL = {
  id: 'doubao-seedance-1-0-pro',
  label: '',
  modes: ['t2v', 'i2v'] as const,
  durations: [5, 10],
  resolutions: ['720p'],
  aspectRatios: ['16:9'],
  sizes: [] as readonly string[],
  cancelable: true,
  generateAudio: false,
  pollIntervalMs: 5000,
  frameRoleFirst: 'first_frame',
  frameRoleLast: 'last_frame',
  frameRoleReference: 'reference_image',
}

const REQUEST: GenerationRequest = {
  model: MODEL.id,
  prompt: 'a fox in snow',
  mode: 'i2v',
  firstFrame: { url: 'data:image/png;base64,AAAA', digest: 'sha256:x', bytes: 3, mime: 'image/png' },
  lastFrame: null,
  referenceImages: [],
  durationSeconds: 5,
  resolution: '720p',
  aspectRatio: '16:9',
  generateAudio: null,
}

describe('dot-path', () => {
  it('reads nested objects and array indexes', () => {
    const body = { data: [{ url: 'https://x/y.mp4' }], output: { task_status: 'SUCCEEDED' } }
    expect(readPath(body, 'data.0.url')).toBe('https://x/y.mp4')
    expect(readString(body, 'output.task_status')).toBe('SUCCEEDED')
  })

  it('returns undefined instead of throwing on a changed shape', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined()
    expect(readString(null, 'a')).toBeNull()
    expect(readNumber({ p: 'not a number' }, 'p')).toBeNull()
  })

  it('reads percentages and numeric strings', () => {
    expect(readNumber({ p: '42%' }, 'p')).toBeCloseTo(0.42)
    expect(readNumber({ p: '0.5' }, 'p')).toBe(0.5)
    expect(readNumber({ p: 30 }, 'p')).toBe(30)
  })

  it('fills templates and leaves unknown placeholders visible', () => {
    expect(endpointPath('/videos/{id}/content', 'abc')).toBe('/videos/abc/content')
    expect(fillTemplate('/videos/{id}/{other}', { id: 'a' })).toBe('/videos/a/{other}')
  })
})

describe('ark-seedance', () => {
  it('builds content[] with the documented roles', () => {
    const body = buildArkBody(REQUEST, { roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: true, watermark: false })
    expect(body.model).toBe(MODEL.id)
    expect(body.duration).toBe(5)
    expect(body.resolution).toBe('720p')
    expect(body.ratio).toBe('16:9')
    expect(body.watermark).toBe(false)
    expect(body.generate_audio).toBe(true)
    expect(body.content).toEqual([
      { type: 'text', text: 'a fox in snow' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, role: 'first_frame' },
    ])
  })

  it('maps the provider vocabulary, including expired as a terminal failure', () => {
    expect(readArkState({ status: 'succeeded', content: { video_url: 'https://x/y.mp4' } })).toMatchObject({
      status: 'succeeded', terminal: true, videoUrl: 'https://x/y.mp4',
    })
    expect(readArkState({ status: 'running' })).toMatchObject({ status: 'running', terminal: false })
    expect(readArkState({ status: 'expired' })).toMatchObject({ status: 'failed', terminal: true })
    expect(readArkState({ status: 'failed', error: { code: 'X', message: 'boom' } }).error).toEqual({ code: 'X', message: 'boom' })
  })

  it('never invents progress the provider does not report', () => {
    expect(readArkState({ status: 'running' }).progress).toBeNull()
  })

  it('keeps an unrecognized status unresolved', () => {
    expect(readArkState({ status: 'weird' })).toMatchObject({ status: 'unknown', terminal: false })
  })
})

describe('minimax-video', () => {
  const OPTIONS = { roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, watermark: false }
  const MINIMAX: GenerationRequest = { ...REQUEST, model: 'MiniMax-H3', resolution: '768P' }

  it('builds the Seedance-shaped content[] with MiniMax\'s own field names', () => {
    const body = buildMinimaxBody(MINIMAX, OPTIONS)
    expect(body).toEqual({
      model: 'MiniMax-H3',
      content: [
        { type: 'text', text: 'a fox in snow' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, role: 'first_frame' },
      ],
      resolution: '768P',
      duration: 5,
      ratio: '16:9',
      aigc_watermark: false,
    })
    // No audio switch is documented, so none is sent.
    expect(body).not.toHaveProperty('generate_audio')
  })

  it('sends reference images for s2v and leaves the ratio out when none is asked for', () => {
    const reference = { url: 'https://x/ref.png', digest: 'sha256:r', bytes: null, mime: null }
    const body = buildMinimaxBody({ ...MINIMAX, mode: 's2v', firstFrame: null, referenceImages: [reference], aspectRatio: null }, OPTIONS)
    expect(body.content).toEqual([
      { type: 'text', text: 'a fox in snow' },
      { type: 'image_url', image_url: { url: 'https://x/ref.png' }, role: 'reference_image' },
    ])
    expect(body).not.toHaveProperty('ratio')
  })

  it('refuses a request missing what MiniMax requires, before any call', () => {
    expect(() => buildMinimaxBody({ ...MINIMAX, durationSeconds: null }, OPTIONS)).toThrowError(ConfigError)
    expect(() => buildMinimaxBody({ ...MINIMAX, resolution: null }, OPTIONS)).toThrowError(/requires resolution/)
    const textOnly = { ...MINIMAX, mode: 't2v' as const, firstFrame: null }
    expect(() => buildMinimaxBody({ ...textOnly, aspectRatio: null }, OPTIONS)).toThrowError(/concrete aspect_ratio/)
    expect(() => buildMinimaxBody({ ...textOnly, aspectRatio: 'adaptive' }, OPTIONS)).toThrowError(/adaptive is refused/)
    expect(buildMinimaxBody({ ...textOnly, aspectRatio: '9:16' }, OPTIONS).ratio).toBe('9:16')
  })

  it('reads the state nested under task', () => {
    expect(readMinimaxState({ task: { id: '1', status: 'succeeded', content: { url: 'https://x/y.mp4' } } })).toEqual({
      status: 'succeeded', progress: null, videoUrl: 'https://x/y.mp4', error: null, terminal: true, usage: null,
    })
    expect(readMinimaxState({ task: { status: 'queued' } })).toMatchObject({ status: 'queued', terminal: false })
    expect(readMinimaxState({ task: { status: 'cancelled' } })).toMatchObject({ status: 'cancelled', terminal: true })
    expect(readMinimaxState({ task: { status: 'failed', error: { code: '1026', message: 'video description contains sensitive content' } } }).error)
      .toEqual({ code: '1026', message: 'video description contains sensitive content', moderation: 'input' })
    expect(readMinimaxState({ task: { status: 'weird' } })).toMatchObject({ status: 'unknown', terminal: false })
  })

  it('submits to /v2/video_generation and queries by task_id', async () => {
    const calls: { url: string; method: string; body: unknown; auth: string | undefined }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>
      calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? null : JSON.parse(init.body as string), auth: headers.authorization })
      const payload = init.method === 'POST' ? { task_id: '424010985738629' } : { task: { id: '424010985738629', status: 'running' } }
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const adapter = minimaxVideoAdapter(OPTIONS)
    const context = { baseUrl: 'https://api.minimax.cn/', apiKey: 'k', fetch, signal: undefined }

    expect(await adapter.submit(context, MINIMAX)).toEqual({ providerTaskId: '424010985738629' })
    expect(await adapter.query(context, '424010985738629')).toMatchObject({ status: 'running' })
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.minimax.cn/v2/video_generation',
      'GET https://api.minimax.cn/v2/query/video_generation/424010985738629',
    ])
    expect(calls[0]?.auth).toBe('Bearer k')
    expect(calls[0]?.body).toMatchObject({ model: 'MiniMax-H3', resolution: '768P' })
  })

  it('documents no cancel, so it never sends one', async () => {
    const adapter = minimaxVideoAdapter(OPTIONS)
    expect(adapter.cancelable).toBe(false)
    const fetch = (() => { throw new Error('no request expected') }) as unknown as typeof globalThis.fetch
    expect(await adapter.cancel({ baseUrl: 'https://api.minimax.cn', apiKey: 'k', fetch, signal: undefined }, '1')).toBe(false)
  })
})

describe('generic-openai-videos', () => {
  it('sends the OpenAI request fields', () => {
    const body = buildOpenAiVideosBody({ ...REQUEST, firstFrame: null, mode: 't2v' }, { ...MODEL, sizes: ['1280x720'] }, '1280x720')
    expect(body).toEqual({ model: MODEL.id, prompt: 'a fox in snow', seconds: '5', size: '1280x720' })
  })

  it('reads status, progress and a nested result URL from configured paths', () => {
    const endpoints = { ...DEFAULT_ENDPOINTS, resultUrlPath: 'data.0.url' }
    const state = readState({ status: 'completed', progress: 100, data: [{ url: 'https://x/y.mp4' }] }, endpoints, 'id1', 'https://relay')
    expect(state).toMatchObject({ status: 'succeeded', terminal: true, videoUrl: 'https://x/y.mp4', progress: 1 })
  })

  it('falls back to the content endpoint when the body carries no URL', () => {
    const state = readState({ status: 'completed' }, DEFAULT_ENDPOINTS, 'id1', 'https://relay/v1')
    expect(state.videoUrl).toBe('https://relay/v1/videos/id1/content')
  })

  it('surfaces the configured error message', () => {
    const state = readState({ status: 'failed', error: { message: 'bad prompt' } }, DEFAULT_ENDPOINTS, 'id1', 'https://relay')
    expect(state.error?.message).toBe('bad prompt')
    expect(state.terminal).toBe(true)
  })
})

describe('settings rules', () => {
  const provider: ProviderSetting = {
    id: 'ark',
    protocol: 'ark-seedance',
    baseUrl: 'https://ark.example/api/v3',
    authRef: 'ARK_API_KEY',
    models: [MODEL],
    endpoints: DEFAULT_ENDPOINTS,
  }
  const settings: VideoForgeSettings = {
    enabled: true,
    providers: [provider],
    defaultProvider: 'ark',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 5000,
    waitSecondsMax: 600,
    dedupeWindowSeconds: 120,
    maxConcurrent: 1,
    maxTasks: 200,
    maxGiB: 20,
    requestTimeoutMs: 120000,
  }

  it('resolves provider::model references', () => {
    expect(resolveTarget(settings, 'ark::doubao-seedance-1-0-pro', null).model.id).toBe(MODEL.id)
    expect(resolveTarget(settings, null, null).provider.id).toBe('ark')
  })

  it('names the configured providers when the reference is unknown', () => {
    expect(() => resolveTarget(settings, 'nope', null)).toThrowError(/unknown provider "nope"; configured providers: ark/)
  })

  it('explains an empty provider list instead of guessing', () => {
    expect(() => resolveTarget({ ...settings, providers: [] }, null, null)).toThrowError(/no providers configured/)
  })

  it('enforces the declared geometry', () => {
    expect(() => assertGeometry(MODEL, { durationSeconds: 7, resolution: null, aspectRatio: null })).toThrowError(/allows durations 5\/10/)
    expect(() => assertGeometry(MODEL, { durationSeconds: 5, resolution: '480p', aspectRatio: null })).toThrowError(/allows resolutions 720p/)
    expect(() => assertGeometry(MODEL, { durationSeconds: 5, resolution: null, aspectRatio: null })).not.toThrow()
  })

  it('maps resolution and aspect ratio onto a literal size, refusing ambiguity', () => {
    const sized = { ...MODEL, sizes: ['1280x720', '720x1280'] }
    expect(resolveSize(sized, '720p', '16:9')).toBe('1280x720')
    expect(resolveSize({ ...MODEL, sizes: [] }, '720p', '16:9')).toBeNull()
    expect(() => resolveSize(sized, null, null)).toThrowError(/needs an unambiguous size/)
  })

  it('splits status word lists', () => {
    expect(statusWords(' queued, Pending ,')).toEqual(['queued', 'pending'])
  })

  it('derives the environment fallback name', () => {
    expect(environmentFallbackName('ark')).toBe('ARK_API_KEY')
    expect(environmentFallbackName('my-relay.cn')).toBe('MY_RELAY_CN_API_KEY')
  })
})

describe('provider error bodies', () => {
  // Shapes recorded from the real endpoints on 2026-10-15 (account id and request id redacted).
  it('lifts ARK\'s code and sentence', () => {
    const body = JSON.stringify({ error: { code: 'ModelNotOpen', message: 'Your account <redacted> has not activated the model doubao-seedance-2-0-fast-260128. Please activate the model service in the Ark Console.', param: '', type: 'Not Found' } })
    expect(providerErrorOf(body)).toEqual({ code: 'ModelNotOpen', message: expect.stringMatching(/has not activated the model/), requestId: null })
  })

  it('lifts ARK\'s parameter error', () => {
    const body = JSON.stringify({ error: { code: 'InvalidParameter', message: 'The parameter `content[1].image_url` specified in the request is not valid: resource not found.', param: 'content[1].image_url', type: 'BadRequest' } })
    expect(providerErrorOf(body)?.code).toBe('InvalidParameter')
  })

  it('falls back to the error type for MiniMax\'s OpenAI-style body, and reads base_resp', () => {
    expect(providerErrorOf(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'resolution is required', http_code: 400 } })))
      .toEqual({ code: 'invalid_request_error', message: 'resolution is required', requestId: null })
    expect(providerErrorOf(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'authentication failed' } })))
      .toEqual({ code: '1004', message: 'authentication failed', requestId: null })
    // status_code 0 is MiniMax's "success" and explains nothing.
    expect(providerErrorOf(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' } }))).toBeNull()
    // The request id a support ticket needs is kept.
    expect(providerErrorOf(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad ratio' }, request_id: 'req-123' }))?.requestId).toBe('req-123')
  })

  it('returns null for anything that is not a structured error', () => {
    expect(providerErrorOf('<html>502 Bad Gateway</html>')).toBeNull()
    expect(providerErrorOf(JSON.stringify({ id: 'cgt-1' }))).toBeNull()
    expect(providerErrorOf(JSON.stringify({ error: { code: 'X' } }))).toBeNull()
  })
})

describe('provider usage', () => {
  // Shapes recorded from the real endpoints on 2026-10-15.
  it('reads ARK tokens as the billing basis', () => {
    const state = readArkState({ id: 'cgt-1', status: 'succeeded', content: { video_url: 'https://x/y.mp4' }, usage: { completion_tokens: 40594, total_tokens: 40594 } })
    expect(state.usage).toEqual({ tokens: 40594, outputSeconds: null, fields: { completion_tokens: 40594, total_tokens: 40594 } })
    expect(readArkState({ id: 'cgt-1', status: 'running' }).usage).toBeNull()
  })

  it('reads MiniMax output seconds, and treats its empty usage object as none', () => {
    const done = readMinimaxState({ task: { id: '1', status: 'succeeded', content: { url: 'https://x/y.mp4' }, usage: { total_seconds: 5, input_seconds: 0, output_seconds: 5, input_image_count: 2 } } })
    expect(done.usage).toEqual({ tokens: null, outputSeconds: 5, fields: { total_seconds: 5, input_seconds: 0, output_seconds: 5, input_image_count: 2 } })
    expect(readMinimaxState({ task: { id: '1', status: 'running', usage: {} } }).usage).toBeNull()
    expect(readMinimaxState({ task: { id: '1', status: 'failed', error: { code: '2013', message: 'media not found' }, usage: {} } }).usage).toBeNull()
  })
})
