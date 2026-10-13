/**
 * End-to-end over the fixture provider: submit → poll → terminal → download,
 * for both first-period protocols.
 *
 * This is the regression net DESIGN §13 asks for: it drives the same adapters,
 * ledger and watch the plugin uses in production, against a socket that answers
 * in the documented vendor shapes. What it does NOT prove is that a real vendor
 * agrees with those shapes — that needs a key, and the milestone note says so.
 */

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobHandle, JobHooks, JobId, JobRegistry, JobSpec } from '@deepseek-ai/dsh-jobs'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { Ledger } from '../src/ledger.ts'
import { arkVideosAdapter } from '../src/providers/ark-seedance.ts'
import { openAiVideosAdapter } from '../src/providers/generic-openai-videos.ts'
import type { AdapterContext, ProtocolAdapter } from '../src/providers/adapter.ts'
import { DEFAULT_ENDPOINTS } from '../src/settings.ts'
import type { GenerationRequest, VideoTask } from '../src/types.ts'
import { startInProcessWatch, startWatch } from '../src/watch.ts'

const MODEL = {
  id: 'doubao-seedance-fixture',
  label: '',
  modes: ['t2v'] as const,
  durations: [] as readonly number[],
  resolutions: [] as readonly string[],
  aspectRatios: [] as readonly string[],
  sizes: [] as readonly string[],
  cancelable: true,
  generateAudio: false,
  pollIntervalMs: 10,
  frameRoleFirst: 'first_frame',
  frameRoleLast: 'last_frame',
  frameRoleReference: 'reference_image',
}

const REQUEST: GenerationRequest = {
  model: MODEL.id,
  prompt: 'a fox in snow',
  mode: 't2v',
  firstFrame: null,
  lastFrame: null,
  referenceImages: [],
  durationSeconds: null,
  resolution: null,
  aspectRatio: null,
  generateAudio: null,
}

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => fixture.close()))
})

/** A registry stub that runs the producer immediately and exposes its hooks. */
function fakeJobs(): { registry: JobRegistry; hooks: JobHooks[]; lines: string[] } {
  const hooks: JobHooks[] = []
  const lines: string[] = []
  let counter = 0
  const registry = {
    start(spec: JobSpec): JobId {
      counter += 1
      const handle = {
        id: `video-${counter}`,
        append: (text: string) => { lines.push(text) },
        updateProgress: () => undefined,
      } as unknown as JobHandle
      hooks.push(spec.run(handle))
      return `video-${counter}` as JobId
    },
  } as unknown as JobRegistry
  return { registry, hooks, lines }
}

async function fixture(over: Parameters<typeof startFixture>[0]): Promise<Fixture> {
  const started = await startFixture(over)
  fixtures.push(started)
  return started
}

async function makeLedger(): Promise<Ledger> {
  const root = await mkdtemp(join(tmpdir(), 'video-forge-e2e-'))
  const ledger = new Ledger({ path: join(root, 'tasks.json'), maxTasks: 10, maxGiB: 1 })
  await ledger.load()
  return ledger
}

function taskRow(localId: string, providerTaskId: string, protocol: string, provider: string): VideoTask {
  return {
    localId,
    provider,
    protocol,
    model: MODEL.id,
    providerTaskId,
    status: 'queued',
    progress: null,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paramsFingerprint: 'fp',
    params: { prompt: REQUEST.prompt, mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [],
    error: null,
  }
}

describe('ARK-shaped provider', () => {
  it('submits with the bearer credential, polls to success, and downloads the artifact', async () => {
    const fake = await fixture({ mode: 'ark', pollsBeforeDone: 1, artifactBytes: 4096, apiKey: 'test-key' })
    const ledger = await makeLedger()
    const adapter: ProtocolAdapter = arkVideosAdapter({
      roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' },
      generateAudio: false,
      watermark: false,
    })
    const context: AdapterContext = { baseUrl: `${fake.url}/api/v3`, apiKey: 'test-key', fetch, signal: undefined }

    const submitted = await adapter.submit(context, REQUEST)
    expect(submitted.providerTaskId).toMatch(/^cgt-fixture-/)
    const create = fake.requests.find(entry => entry.method === 'POST')
    expect(create?.authorization).toBe('Bearer test-key')
    expect(JSON.parse(create?.body ?? '{}')).toMatchObject({ model: MODEL.id, content: [{ type: 'text', text: REQUEST.prompt }] })

    const task = await ledger.add(taskRow('v-20261013-0001', submitted.providerTaskId, 'ark-seedance', 'ark'))
    const jobs = fakeJobs()
    const outputDirectory = join(ledger.home, 'outputs', task.localId)
    startWatch({
      jobs: jobs.registry,
      owner: undefined,
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 10,
      outputDirectory,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const outcome = await jobs.hooks[0]?.done
    expect(outcome?.status).toBe('completed')

    const settled = ledger.byId(task.localId)
    expect(settled?.status).toBe('succeeded')
    expect(settled?.artifacts).toHaveLength(1)
    const artifact = settled?.artifacts[0]
    expect(artifact?.mime).toBe('video/mp4')
    expect(artifact?.token).toMatch(/^[0-9a-f]{32}$/)
    expect((await stat(artifact?.path ?? '')).size).toBe(4096)
    expect(jobs.lines.join('')).toContain('downloaded')
  })

  it('treats the provider\'s expired verdict as a terminal failure, not an endless poll', async () => {
    const fake = await fixture({ mode: 'ark', pollsBeforeDone: 0, expire: true, apiKey: 'test-key' })
    const ledger = await makeLedger()
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    const context: AdapterContext = { baseUrl: `${fake.url}/api/v3`, apiKey: 'test-key', fetch, signal: undefined }
    const submitted = await adapter.submit(context, REQUEST)
    const task = await ledger.add(taskRow('v-20261013-0002', submitted.providerTaskId, 'ark-seedance', 'ark'))
    const jobs = fakeJobs()
    startWatch({
      jobs: jobs.registry,
      owner: undefined,
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 10,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const outcome = await jobs.hooks[0]?.done
    expect(outcome?.status).toBe('failed')
    expect(ledger.byId(task.localId)?.status).toBe('failed')
    expect(ledger.byId(task.localId)?.error?.message).toContain('expired')
  })

  it('forwards a cancel request to the provider', async () => {
    const fake = await fixture({ mode: 'ark', apiKey: 'test-key' })
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    const context: AdapterContext = { baseUrl: `${fake.url}/api/v3`, apiKey: 'test-key', fetch, signal: undefined }
    await expect(adapter.cancel(context, 'cgt-fixture-9')).resolves.toBe(true)
    expect(fake.requests.some(entry => entry.method === 'DELETE')).toBe(true)
  })
})

describe('OpenAI-Videos-shaped provider', () => {
  it('falls back to the content endpoint and downloads through it', async () => {
    const fake = await fixture({ mode: 'openai-videos', pollsBeforeDone: 1, artifactBytes: 1234, apiKey: 'relay-key' })
    const ledger = await makeLedger()
    const adapter = openAiVideosAdapter({ endpoints: DEFAULT_ENDPOINTS, model: { ...MODEL, sizes: [] } })
    const context: AdapterContext = { baseUrl: fake.url, apiKey: 'relay-key', fetch, signal: undefined }

    const submitted = await adapter.submit(context, { ...REQUEST, model: 'sora-fixture' })
    const task = await ledger.add(taskRow('v-20261013-0003', submitted.providerTaskId, 'generic-openai-videos', 'relay'))
    const jobs = fakeJobs()
    startWatch({
      jobs: jobs.registry,
      owner: undefined,
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 10,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const outcome = await jobs.hooks[0]?.done
    expect(outcome?.status).toBe('completed')
    const artifact = ledger.byId(task.localId)?.artifacts[0]
    expect(artifact?.bytes).toBe(1234)
    expect(artifact?.mime).toBe('video/mp4')
    expect(Buffer.from(await readFile(artifact?.path ?? '')).byteLength).toBe(1234)
    // The artifact host is authorized with the same credential as the API.
    const content = fake.requests.find(entry => entry.path.includes('/content'))
    expect(content?.authorization).toBe('Bearer relay-key')
  })

  it('reports a provider failure with its message', async () => {
    const fake = await fixture({ mode: 'openai-videos', failAfterPolls: 0, apiKey: 'relay-key' })
    const ledger = await makeLedger()
    const adapter = openAiVideosAdapter({ endpoints: DEFAULT_ENDPOINTS, model: { ...MODEL, sizes: [] } })
    const context: AdapterContext = { baseUrl: fake.url, apiKey: 'relay-key', fetch, signal: undefined }
    const submitted = await adapter.submit(context, { ...REQUEST, model: 'sora-fixture' })
    const task = await ledger.add(taskRow('v-20261013-0004', submitted.providerTaskId, 'generic-openai-videos', 'relay'))
    const jobs = fakeJobs()
    startWatch({
      jobs: jobs.registry,
      owner: undefined,
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 10,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const outcome = await jobs.hooks[0]?.done
    expect(outcome?.status).toBe('failed')
    expect(ledger.byId(task.localId)?.error?.message).toBe('fixture failure')
  })
})

describe('watch discipline', () => {
  it('stops on kill without claiming the provider stopped', async () => {
    const fake = await fixture({ mode: 'ark', pollsBeforeDone: 1000, apiKey: 'test-key' })
    const ledger = await makeLedger()
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    const context: AdapterContext = { baseUrl: `${fake.url}/api/v3`, apiKey: 'test-key', fetch, signal: undefined }
    const submitted = await adapter.submit(context, REQUEST)
    const task = await ledger.add(taskRow('v-20261013-0005', submitted.providerTaskId, 'ark-seedance', 'ark'))
    const jobs = fakeJobs()
    startWatch({
      jobs: jobs.registry,
      owner: undefined,
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 20,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    await new Promise(resolve => setTimeout(resolve, 60))
    jobs.hooks[0]?.cancel('test kill')
    const outcome = await jobs.hooks[0]?.done
    expect(outcome?.status).toBe('killed')
    // The provider was never told to stop: a kill only ends the watch.
    expect(fake.requests.some(entry => entry.method === 'DELETE')).toBe(false)
    expect(ledger.byId(task.localId)?.status).not.toBe('succeeded')
  })

  it('fails the task after repeated transport failures instead of looping forever', async () => {
    const ledger = await makeLedger()
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    // A port nothing listens on: every poll is a transport error.
    const context: AdapterContext = { baseUrl: 'http://127.0.0.1:1/api/v3', apiKey: 'k', fetch, signal: undefined }
    const task = await ledger.add(taskRow('v-20261013-0006', 'cgt-x', 'ark-seedance', 'ark'))
    const jobs = fakeJobs()
    startWatch({
      jobs: jobs.registry,
      owner: undefined,
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 5,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const outcome = await jobs.hooks[0]?.done
    expect(outcome?.status).toBe('failed')
    expect(ledger.byId(task.localId)?.error?.message).toMatch(/polling failed 5 times/)
  })
})

describe('in-process watch (the boot-reconciliation path)', () => {
  it('settles a task with no agent and no job registry', async () => {
    const fake = await fixture({ mode: 'ark', pollsBeforeDone: 1, artifactBytes: 2048, apiKey: 'test-key' })
    const ledger = await makeLedger()
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    const context: AdapterContext = { baseUrl: `${fake.url}/api/v3`, apiKey: 'test-key', fetch, signal: undefined }
    const submitted = await adapter.submit(context, REQUEST)
    const task = await ledger.add(taskRow('v-20261013-0007', submitted.providerTaskId, 'ark-seedance', 'ark'))

    const watch = startInProcessWatch({
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 10,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })

    const outcome = await watch.done
    expect(outcome.status).toBe('completed')
    const artifact = ledger.byId(task.localId)?.artifacts[0]
    expect(artifact?.bytes).toBe(2048)
    expect((await stat(artifact?.path ?? '')).size).toBe(2048)
  })

  it('stops when cancelled without settling the task as finished', async () => {
    const fake = await fixture({ mode: 'ark', pollsBeforeDone: 1000, apiKey: 'test-key' })
    const ledger = await makeLedger()
    const adapter = arkVideosAdapter({ roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, generateAudio: false, watermark: false })
    const context: AdapterContext = { baseUrl: `${fake.url}/api/v3`, apiKey: 'test-key', fetch, signal: undefined }
    const submitted = await adapter.submit(context, REQUEST)
    const task = await ledger.add(taskRow('v-20261013-0008', submitted.providerTaskId, 'ark-seedance', 'ark'))

    const watch = startInProcessWatch({
      ledger,
      adapter,
      context,
      task,
      pollIntervalMs: 20,
      outputDirectory: join(ledger.home, 'outputs', task.localId),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    watch.cancel()
    const outcome = await watch.done
    expect(outcome.status).toBe('killed')
    expect(ledger.byId(task.localId)?.status).not.toBe('succeeded')
  })
})
