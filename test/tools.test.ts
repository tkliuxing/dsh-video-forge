/**
 * The tool surface: the rules that must hold *before* a paid request goes out,
 * exercised through the registered definitions so the test sees exactly what the
 * model sees.
 */

import { mkdtempSync } from 'node:fs'
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
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import type { VideoTask } from '../src/types.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'

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
    priceTable: DEFAULT_PRICE_TABLE,
    ...over,
  }
}

function runtimeFor(settings: VideoForgeSettings, ledger: Ledger): VideoForgeRuntime {
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition); return () => {} } },
    // The host's filesystem service, served by the host-local implementation.
    get: (name: string) => (name === 'fs' ? hostWorkspaceFs : undefined),
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
    watching: new Set(),
  }
}

// A workspace of its own: a session call now writes its artifact into it.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'video-forge-tools-ws-'))
const exec = { signal: AbortSignal.timeout(5_000), agent: { id: 'session-test', session: { header: { cwd: WORKSPACE } } } } as unknown as ToolRunContext

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

  it('registers the three tools with a canonical output contract; video_export is gone', () => {
    expect([...definitions.keys()].sort()).toEqual(['video_cancel', 'video_generate', 'video_status'])
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

  it('resolves a relative path against the session workspace, before touching the network', async () => {
    const postsBefore = fixture.requests.filter(entry => entry.method === 'POST').length
    await expect(generate().execute({ prompt: 'x', mode: 'i2v', first_frame: 'not-here-12345.png' }, exec))
      .rejects.toThrowError(new RegExp(`no readable file at ${join(WORKSPACE, 'not-here-12345.png').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    // A call no session made has no workspace to resolve against.
    const sessionless = { signal: AbortSignal.timeout(5_000) } as unknown as ToolRunContext
    await expect(generate().execute({ prompt: 'x', mode: 'i2v', first_frame: 'a.png' }, sessionless))
      .rejects.toThrowError(/relative and this call has no session workspace/)
    expect(fixture.requests.filter(entry => entry.method === 'POST')).toHaveLength(postsBefore)
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
    // The calling session is recorded with the task (no sandbox policy mounted here).
    expect(ledger.byId(value.task_id)?.session).toEqual({ id: 'session-test', cwd: WORKSPACE, mode: null })
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

describe('video_status / video_cancel', () => {
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
      billing: { state: 'reported', tokens: 40594, outputSeconds: null, fields: { completion_tokens: 40594, total_tokens: 40594 }, settledAt: new Date().toISOString() },
    })
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const value = await definitions.get('video_status')?.execute({}, exec) as {
      tasks: { task_id: string; status: string; play_url: string | null; billing: { state: string; tokens: number | null } | null }[]
      usage: { tasks: number }
    }
    expect(value.tasks).toHaveLength(1)
    expect(value.tasks[0]?.play_url).toBe(`video-forge/media/v-20261013-0001/${'f'.repeat(32)}/out.mp4`)
    // Usage, never money: the provider's own numbers, passed through.
    expect(value.tasks[0]?.billing).toMatchObject({ state: 'reported', tokens: 40594 })
    expect(value.usage.tasks).toBe(1)
  })

  it('reports the setup when asked without a task id, and only then', async () => {
    const ledger = await makeLedger()
    await ledger.add(openTask('v-20261013-0009'))
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const status = definitions.get('video_status')
    const value = await status?.execute({}, exec) as { setup: Record<string, unknown> | null }
    expect(value.setup).toMatchObject({
      enabled: true,
      default_provider: 'ark',
      providers: [{ id: 'ark', protocol: 'ark-seedance', key: 'not required', key_problem: null, continuable: true, models: [{ id: MODEL.id }] }],
      workspace: { state: 'default-layout', folder: WORKSPACE, mode: null, renders: 'renders', characters: [], style: false, problem: null },
    })
    const text = (status?.output.render?.({}, value as never) as { text: string }[])[0]?.text ?? ''
    expect(text).toMatch(/provider ark \(default\) \[ark-seedance\], key not required, takes can be continued with from/)
    expect(text).toMatch(/no video-project\.yaml yet \(default layout\)/)
    const one = await status?.execute({ task_id: 'v-20261013-0009' }, exec) as { setup: unknown }
    expect(one.setup).toBeNull()
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

  it('reports where a task actually is when the provider refuses the cancel', async () => {
    // The ledger's last poll said queued; the provider has moved on and answers 409.
    const id = 'cgt-moved-on'
    await fetch(`${fixture.url}/api/v3/contents/generations/tasks/${id}`)
    await fetch(`${fixture.url}/api/v3/contents/generations/tasks/${id}`)
    const ledger = await makeLedger()
    await ledger.add({ ...openTask('v-20261015-0016'), providerTaskId: id, status: 'queued' })
    definitions.clear()
    registerTools(runtimeFor(settingsWith(arkProvider(`${fixture.url}/api/v3`)), ledger))
    const value = await definitions.get('video_cancel')?.execute({ task_id: 'v-20261015-0016' }, exec) as {
      cancelled: boolean; status: string
    }
    expect(value.cancelled).toBe(false)
    expect(value.status).toBe('running')
  })
})
