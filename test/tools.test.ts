/**
 * The tool surface: the rules that must hold *before* a paid request goes out,
 * exercised through the registered definitions so the test sees exactly what the
 * model sees.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { Ledger } from '../src/ledger.ts'
import { registerTools } from '../src/tools.ts'
import { DEFAULT_ENDPOINTS, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import type { VideoTask } from '../src/types.ts'

const MODEL = {
  id: 'doubao-seedance-fixture',
  label: '',
  modes: ['t2v', 'i2v', 'flf2v', 's2v'] as const,
  durations: [5],
  resolutions: ['720p'],
  aspectRatios: ['16:9'],
  sizes: [] as readonly string[],
  cancelable: true,
  generateAudio: false,
  pollIntervalMs: 10,
  frameRoleFirst: 'first_frame',
  frameRoleLast: 'last_frame',
  frameRoleReference: 'reference_image',
}

let fixture: Fixture
const definitions = new Map<string, ToolDefinition>()

function settingsWith(provider: ProviderSetting | null, over: Partial<VideoForgeSettings> = {}): VideoForgeSettings {
  return {
    enabled: true,
    providers: provider === null ? [] : [provider],
    defaultProvider: provider?.id ?? '',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 10,
    waitSecondsMax: 600,
    dedupeWindowSeconds: 120,
    maxConcurrent: 1,
    maxTasks: 200,
    maxGiB: 20,
    requestTimeoutMs: 30_000,
    ...over,
  }
}

function runtimeFor(settings: VideoForgeSettings, ledger: Ledger): VideoForgeRuntime {
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition); return () => {} } },
    get: () => undefined,
  } as unknown as Context
  return {
    ctx,
    ledger,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(ledger.home, 'outputs'),
    outputDirectory: localId => join(ledger.home, 'outputs', localId),
    watchTask: () => null,
    cancels: new Map(),
    activeCount: () => 0,
  }
}

const exec = { signal: AbortSignal.timeout(5_000), agent: { id: 'session-test' } } as unknown as ToolRunContext

async function makeLedger(): Promise<Ledger> {
  const root = await mkdtemp(join(tmpdir(), 'video-forge-tools-'))
  const ledger = new Ledger({ path: join(root, 'tasks.json'), maxTasks: 10, maxGiB: 1 })
  await ledger.load()
  return ledger
}

function arkProvider(baseUrl: string, over: Partial<ProviderSetting> = {}): ProviderSetting {
  return { id: 'ark', protocol: 'ark-seedance', baseUrl, authRef: '', models: [MODEL], endpoints: DEFAULT_ENDPOINTS, ...over }
}

function openTask(localId: string): VideoTask {
  return {
    localId,
    provider: 'ark',
    protocol: 'ark-seedance',
    model: MODEL.id,
    providerTaskId: 'cgt-existing',
    status: 'running',
    progress: null,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paramsFingerprint: 'unrelated',
    params: { prompt: 'other', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [],
    error: null,
  }
}

beforeAll(async () => {
  fixture = await startFixture({ mode: 'ark', pollsBeforeDone: 1000 })
  const ledger = await makeLedger()
  registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
})

afterAll(async () => {
  await fixture.close()
})

describe('video_generate', () => {
  const generate = (): ToolDefinition => {
    const definition = definitions.get('video_generate')
    if (definition === undefined) throw new Error('video_generate was not registered')
    return definition
  }

  it('registers all four tools with a canonical output contract', () => {
    expect([...definitions.keys()].sort()).toEqual(['video_cancel', 'video_export', 'video_generate', 'video_status'])
    expect(generate().output.schema).toBeDefined()
    expect(generate().isConcurrencySafe?.({} as never)).toBe(false)
  })

  it('refuses an empty prompt', async () => {
    await expect(generate().execute({ prompt: '   ' }, exec)).rejects.toThrowError(/prompt must not be empty/)
  })

  it('refuses materials in a text-only mode', async () => {
    await expect(generate().execute({ prompt: 'x', mode: 't2v', first_frame: '/tmp/a.png' }, exec))
      .rejects.toThrowError(/takes text only/)
  })

  it('requires the frame a mode declares', async () => {
    await expect(generate().execute({ prompt: 'x', mode: 'i2v' }, exec)).rejects.toThrowError(/requires first_frame/)
    await expect(generate().execute({ prompt: 'x', mode: 'flf2v', first_frame: '/tmp/a.png' }, exec))
      .rejects.toThrowError(/requires both first_frame and last_frame/)
    await expect(generate().execute({ prompt: 'x', mode: 's2v' }, exec)).rejects.toThrowError(/at least one reference_images/)
  })

  it('keeps frame control and reference images mutually exclusive', async () => {
    await expect(generate().execute({ prompt: 'x', mode: 's2v', first_frame: '/tmp/a.png', reference_images: ['/tmp/b.png'] }, exec))
      .rejects.toThrowError(/mutually exclusive/)
    await expect(generate().execute({ prompt: 'x', mode: 'i2v', first_frame: '/tmp/a.png', last_frame: '/tmp/b.png' }, exec))
      .rejects.toThrowError(/only a first frame/)
  })

  it('refuses a relative path before touching the network', async () => {
    await expect(generate().execute({ prompt: 'x', mode: 'i2v', first_frame: 'a.png' }, exec))
      .rejects.toThrowError(/is not absolute/)
  })

  it('refuses a missing file', async () => {
    await expect(generate().execute({ prompt: 'x', mode: 'i2v', first_frame: '/tmp/definitely-not-here-12345.png' }, exec))
      .rejects.toThrowError(/no readable file/)
  })

  it('enforces the declared geometry', async () => {
    await expect(generate().execute({ prompt: 'x', duration_seconds: 7 }, exec))
      .rejects.toThrowError(/allows durations 5/)
    await expect(generate().execute({ prompt: 'x', resolution: '1080p' }, exec))
      .rejects.toThrowError(/allows resolutions 720p/)
  })

  it('names the missing configuration instead of guessing', async () => {
    const ledger = await makeLedger()
    definitions.clear()
    registerTools(runtimeFor(settingsWith(null), ledger))
    const definition = definitions.get('video_generate')
    await expect(definition?.execute({ prompt: 'x' }, exec)).rejects.toThrowError(/no providers configured/)
  })

  it('submits through the provider and records the task', async () => {
    const ledger = await makeLedger()
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const definition = definitions.get('video_generate')
    const value = await definition?.execute({ prompt: 'a fox in snow' }, exec) as {
      kind: string; task_id: string; status: string; job_id: string | null; message: string
    }
    expect(value.kind).toBe('job')
    expect(value.status).toBe('queued')
    expect(value.message).toContain('do not re-submit')
    expect(ledger.byId(value.task_id)?.providerTaskId).toMatch(/^cgt-fixture-/)
  })

  it('refuses a duplicate submission inside the dedupe window and names the existing task', async () => {
    const ledger = await makeLedger()
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const definition = definitions.get('video_generate')
    const first = await definition?.execute({ prompt: 'same prompt' }, exec) as { task_id: string }
    await expect(definition?.execute({ prompt: 'same prompt' }, exec))
      .rejects.toThrowError(new RegExp(`already tracked as ${first.task_id}`))
  })

  it('refuses a submission while the concurrency limit is reached', async () => {
    const ledger = await makeLedger()
    await ledger.add(openTask('v-20261013-0001'))
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`), { maxConcurrent: 1, dedupeWindowSeconds: 0 }), ledger))
    const definition = definitions.get('video_generate')
    await expect(definition?.execute({ prompt: 'another prompt' }, exec))
      .rejects.toThrowError(/already has 1 task\(s\) in flight/)
  })
})

describe('video_status / video_cancel / video_export', () => {
  it('lists tasks with a play URL once an artifact exists', async () => {
    const ledger = await makeLedger()
    const artifactPath = join(ledger.home, 'out.mp4')
    await writeFile(artifactPath, 'video-bytes')
    await ledger.add({
      ...openTask('v-20261013-0001'),
      status: 'succeeded',
      artifacts: [{
        path: artifactPath, bytes: 11, mime: 'video/mp4', width: null, height: null, durationSec: null,
        token: 'f'.repeat(32), createdAt: new Date().toISOString(),
      }],
    })
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const value = await definitions.get('video_status')?.execute({}, exec) as {
      tasks: { task_id: string; status: string; play_url: string | null }[]
      usage: { tasks: number }
    }
    expect(value.tasks).toHaveLength(1)
    expect(value.tasks[0]?.play_url).toBe(`video-forge/media/v-20261013-0001/${'f'.repeat(32)}/out.mp4`)
    expect(value.usage.tasks).toBe(1)
  })

  it('explains an unknown task id', async () => {
    const ledger = await makeLedger()
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    await expect(definitions.get('video_status')?.execute({ task_id: 'nope' }, exec)).rejects.toThrowError(/no video task with id "nope"/)
  })

  it('cancels through the provider and records the outcome', async () => {
    const ledger = await makeLedger()
    await ledger.add(openTask('v-20261013-0002'))
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const value = await definitions.get('video_cancel')?.execute({ task_id: 'v-20261013-0002' }, exec) as {
      cancelled: boolean; status: string
    }
    expect(value.cancelled).toBe(true)
    expect(value.status).toBe('cancelled')
    expect(ledger.byId('v-20261013-0002')?.status).toBe('cancelled')
    expect(fixture.requests.some(entry => entry.method === 'DELETE')).toBe(true)
  })

  it('refuses to export before an artifact exists, and requires an absolute target', async () => {
    const ledger = await makeLedger()
    await ledger.add(openTask('v-20261013-0003'))
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const definition = definitions.get('video_export')
    await expect(definition?.execute({ task_id: 'v-20261013-0003', target_path: '/tmp/x.mp4' }, exec))
      .rejects.toThrowError(/has no artifact to export yet/)

    const artifactPath = join(ledger.home, 'in.mp4')
    await writeFile(artifactPath, 'bytes')
    await ledger.update('v-20261013-0003', current => ({
      ...current,
      status: 'succeeded',
      artifacts: [{
        path: artifactPath, bytes: 5, mime: 'video/mp4', width: null, height: null, durationSec: null,
        token: 'e'.repeat(32), createdAt: new Date().toISOString(),
      }],
    }))
    await expect(definition?.execute({ task_id: 'v-20261013-0003', target_path: 'relative.mp4' }, exec))
      .rejects.toThrowError(/must be absolute/)
  })

  it('exports an existing artifact and refuses to clobber by default', async () => {
    const ledger = await makeLedger()
    const artifactPath = join(ledger.home, 'in.mp4')
    await writeFile(artifactPath, 'bytes')
    await ledger.add({
      ...openTask('v-20261013-0004'),
      status: 'succeeded',
      artifacts: [{
        path: artifactPath, bytes: 5, mime: 'video/mp4', width: null, height: null, durationSec: null,
        token: 'd'.repeat(32), createdAt: new Date().toISOString(),
      }],
    })
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const definition = definitions.get('video_export')
    const target = join(ledger.home, 'exported.mp4')
    const value = await definition?.execute({ task_id: 'v-20261013-0004', target_path: target }, exec) as { path: string; bytes: number }
    expect(value.bytes).toBe(5)
    await expect(definition?.execute({ task_id: 'v-20261013-0004', target_path: target }, exec))
      .rejects.toThrowError(/already exists/)
  })
})
