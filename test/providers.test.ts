/**
 * Protocol adapters: the field-by-field contract of the two first-period
 * protocols, plus the settings rules that decide whether a call may go out.
 */

import { describe, expect, it } from 'vitest'
import { fillTemplate, readNumber, readPath, readString } from '../src/providers/dot-path.ts'
import { buildArkBody, readArkState } from '../src/providers/ark-seedance.ts'
import { buildOpenAiVideosBody, endpointPath, readState } from '../src/providers/generic-openai-videos.ts'
import { DEFAULT_ENDPOINTS, assertGeometry, environmentFallbackName, resolveSize, resolveTarget, statusWords, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
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
