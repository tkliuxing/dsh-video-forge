/**
 * Content-review refusals (DESIGN §16.7): recorded as their own class, and the
 * identical request is never sent again — the verdict would be the same, and
 * it may be billed again. Codes are the vendors' own, from their error-code
 * references as of 2026-10-15.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { Ledger, parseDocument } from '../src/ledger.ts'
import { generate, listTasks } from '../src/operations.ts'
import { moderationOf } from '../src/providers/adapter.ts'
import { arkVideosAdapter } from '../src/providers/ark-seedance.ts'
import { readMinimaxState } from '../src/providers/minimax-video.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { DEFAULT_ENDPOINTS, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import { startInProcessWatch } from '../src/watch.ts'

const MODEL = {
  id: 'doubao-seedance-fixture', label: '', modes: ['t2v'] as const,
  durations: [] as readonly number[], resolutions: [] as readonly string[], aspectRatios: [] as readonly string[], sizes: [] as readonly string[],
  cancelable: true, generateAudio: false, pollIntervalMs: 10,
  frameRoleFirst: 'first_frame', frameRoleLast: 'last_frame', frameRoleReference: 'reference_image',
}

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => fixture.close()))
})

function runtimeFor(fake: Fixture, ledger: Ledger): VideoForgeRuntime {
  const provider: ProviderSetting = { id: 'ark', protocol: 'ark-seedance', baseUrl: `${fake.url}/api/v3`, authRef: '', models: [MODEL], endpoints: DEFAULT_ENDPOINTS }
  const settings: VideoForgeSettings = {
    enabled: true, providers: [provider], defaultProvider: 'ark', defaultModel: '', outputDir: '',
    pollIntervalMs: 10, waitSecondsMax: 600, dedupeWindowSeconds: 1, maxConcurrent: 4, maxTasks: 200, maxGiB: 20, requestTimeoutMs: 30_000,
  }
  return {
    ctx: { get: () => undefined } as unknown as Context,
    ledger,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(ledger.home, 'outputs'),
    outputDirectory: localId => join(ledger.home, 'outputs', localId),
    watchTask: () => null,
    cancels: new Map(),
    watching: new Set(),
    activeCount: () => 0,
  }
}

async function ledgerAt(): Promise<Ledger> {
  const ledger = new Ledger({ path: join(await mkdtemp(join(tmpdir(), 'video-forge-moderation-')), 'tasks.json'), maxTasks: 50, maxGiB: 1 })
  await ledger.load()
  return ledger
}

const posts = (fake: Fixture): number => fake.requests.filter(entry => entry.method === 'POST').length

describe('recognising a content-review refusal', () => {
  it('reads ARK\'s code families, with the side they refused', () => {
    expect(moderationOf('ark-seedance', 'InputTextSensitiveContentDetected')).toBe('input')
    expect(moderationOf('ark-seedance', 'InputImageSensitiveContentDetected.PolicyViolation')).toBe('input')
    expect(moderationOf('ark-seedance', 'SensitiveContentDetected.SevereViolation')).toBe('input')
    expect(moderationOf('ark-seedance', 'InputTextRiskDetection')).toBe('input')
    expect(moderationOf('ark-seedance', 'OutputVideoSensitiveContentDetected')).toBe('output')
    expect(moderationOf('ark-seedance', 'OutputAudioSensitiveContentDetected.PolicyViolation')).toBe('output')
    expect(moderationOf('ark-seedance', 'InvalidParameter')).toBeNull()
    expect(moderationOf('ark-seedance', 'ModelNotOpen')).toBeNull()
  })

  it('reads MiniMax\'s two codes, and nothing else', () => {
    expect(moderationOf('minimax-video', '1026')).toBe('input')
    expect(moderationOf('minimax-video', '1027')).toBe('output')
    expect(moderationOf('minimax-video', '2013')).toBeNull()
    expect(readMinimaxState({ task: { status: 'failed', error: { code: '1027', message: 'output sensitive' } } }).error?.moderation).toBe('output')
  })

  it('takes a gateway\'s moderation-ish code as a refusal on an unknown side', () => {
    expect(moderationOf('generic-openai-videos', 'moderation_blocked')).toBe('unknown')
    expect(moderationOf('generic-openai-videos', 'rate_limit_exceeded')).toBeNull()
  })
})

describe('an input refusal at submit', () => {
  it('is recorded as moderation, refuses the identical request, and lets a changed one through', async () => {
    const fake = await startFixture({ mode: 'ark', rejectSubmitStatus: 400, rejectSubmitCode: 'InputTextSensitiveContentDetected' })
    fixtures.push(fake)
    const ledger = await ledgerAt()
    const runtime = runtimeFor(fake, ledger)

    await expect(generate(runtime, { prompt: 'a prompt the review refuses' })).rejects.toThrow(/InputTextSensitiveContentDetected/)
    const [row] = ledger.list()
    expect(row?.status).toBe('failed')
    expect(row?.error?.moderation).toBe('input')
    expect(listTasks(runtime).tasks[0]?.moderation).toBe('input')

    // Long after the dedupe window, the same request is still not sent again.
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await expect(generate(runtime, { prompt: 'a prompt the review refuses' })).rejects.toThrow(/refused by the provider's content review \(input side\).*change the prompt or the materials/)
    expect(posts(fake)).toBe(1)

    // A rewritten prompt is a different request.
    await expect(generate(runtime, { prompt: 'a calmer prompt' })).rejects.toThrow(/InputTextSensitiveContentDetected/)
    expect(posts(fake)).toBe(2)
  })
})

describe('an output refusal while the task runs', () => {
  it('is recorded as moderation on the output side', async () => {
    const fake = await startFixture({ mode: 'ark', failAfterPolls: 1, failCode: 'OutputVideoSensitiveContentDetected', apiKey: 'k' })
    fixtures.push(fake)
    const ledger = await ledgerAt()
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    const context = { baseUrl: `${fake.url}/api/v3`, apiKey: 'k', fetch, signal: undefined }
    const { providerTaskId } = await adapter.submit(context, {
      model: MODEL.id, prompt: 'x', mode: 't2v', firstFrame: null, lastFrame: null, referenceImages: [],
      durationSeconds: null, resolution: null, aspectRatio: null, generateAudio: null,
    })
    const now = new Date().toISOString()
    const task = await ledger.add({
      localId: 'v-1', provider: 'ark', protocol: 'ark-seedance', model: MODEL.id, providerTaskId, status: 'queued', progress: null,
      submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
      params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [], error: null,
    })
    await startInProcessWatch({
      ledger, adapter, context, task, pollIntervalMs: 10, outputDirectory: join(ledger.home, 'out'),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }).done
    expect(ledger.byId('v-1')?.status).toBe('failed')
    expect(ledger.byId('v-1')?.error).toMatchObject({ code: 'OutputVideoSensitiveContentDetected', moderation: 'output' })
  })
})

describe('reading the ledger', () => {
  it('drops a moderation tag it does not know, keeping the error', () => {
    const now = new Date().toISOString()
    const doc = parseDocument(JSON.stringify({ version: 1, tasks: [{
      localId: 'v-1', provider: 'ark', protocol: 'ark-seedance', model: 'm', providerTaskId: 'cgt-1', status: 'failed', progress: null,
      submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
      params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [], error: { message: 'refused', code: 'X', moderation: 'sideways' },
    }] }))
    expect(doc.tasks[0]?.error).toEqual({ message: 'refused', code: 'X' })
  })
})
