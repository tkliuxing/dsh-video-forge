/**
 * Orphans are not verdicts (DESIGN §6). A task the boot pass could not
 * reattach — because the credential store had not published yet, or the
 * network timed out — keeps being asked about while the provider still answers
 * for it, and boot itself waits for the credential service before it starts.
 *
 * The first case is the one the 2026-10-15 real-key run hit: a finished,
 * paid MiniMax generation filed as orphaned at restart because
 * `ctx.get('credentials')` was still undefined.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { Ledger } from '../src/ledger.ts'
import { reconcile, recoverableOrphans, retryOrphans, scheduleReconciliation, settleBilling, type ReconcileHost } from '../src/reconcile.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { DEFAULT_ENDPOINTS, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { VideoTask } from '../src/types.ts'

const KEY = 'sk-fixture-orphan'
const REF = 'VIDEO_FORGE_ORPHAN_TEST_KEY'

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

const fixtures: Fixture[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(fixtures.splice(0).map(async fixture => fixture.close()))
})

async function fixture(over: Partial<Parameters<typeof startFixture>[0]> = {}): Promise<Fixture> {
  const started = await startFixture({ mode: 'ark', apiKey: KEY, artifactBytes: 2048, ...over })
  fixtures.push(started)
  return started
}

function settingsFor(fake: Fixture): VideoForgeSettings {
  const provider: ProviderSetting = { id: 'ark', protocol: 'ark-seedance', baseUrl: `${fake.url}/api/v3`, authRef: REF, models: [MODEL], endpoints: DEFAULT_ENDPOINTS }
  return {
    enabled: true,
    providers: [provider],
    defaultProvider: 'ark',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 10,
    waitSecondsMax: 600,
    dedupeWindowSeconds: 120,
    maxConcurrent: 4,
    maxTasks: 200,
    maxGiB: 20,
    requestTimeoutMs: 30_000,
  }
}

/** A runtime whose credential service can be switched on later, as the real store publishes late. */
function runtimeFor(settings: VideoForgeSettings, ledger: Ledger): { runtime: VideoForgeRuntime; publishCredentials: () => void } {
  let published = false
  const credentials = { resolve: async (ref: string) => (ref === REF ? { value: KEY, source: 'file' } : undefined) }
  const runtime: VideoForgeRuntime = {
    ctx: { get: (name: string) => (name === 'credentials' && published ? credentials : undefined) } as unknown as Context,
    ledger,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(ledger.home, 'outputs'),
    outputDirectory: localId => join(ledger.home, 'outputs', localId),
    watchTask: () => null,
    cancels: new Map(),
    activeCount: () => 0,
  }
  return { runtime, publishCredentials: () => { published = true } }
}

async function ledgerAt(): Promise<Ledger> {
  const ledger = new Ledger({ path: join(await mkdtemp(join(tmpdir(), 'video-forge-orphan-')), 'tasks.json'), maxTasks: 50, maxGiB: 1 })
  await ledger.load()
  return ledger
}

/** Create a task at the fixture the way a previous process would have, and return its provider id. */
async function providerTask(fake: Fixture): Promise<string> {
  const response = await fetch(`${fake.url}/api/v3/contents/generations/tasks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL.id }),
  })
  return ((await response.json()) as { id: string }).id
}

function row(over: Partial<VideoTask>): VideoTask {
  const now = new Date().toISOString()
  return {
    localId: 'v-20261015-0011',
    provider: 'ark',
    protocol: 'ark-seedance',
    model: MODEL.id,
    providerTaskId: null,
    status: 'running',
    progress: null,
    submittedAt: now,
    updatedAt: now,
    paramsFingerprint: 'fp',
    params: { prompt: 'a bamboo grove at dawn', mode: 't2v', durationSeconds: 5, resolution: '480p', aspectRatio: '16:9', firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [],
    error: null,
    ...over,
  }
}

const posts = (fake: Fixture): number => fake.requests.filter(entry => entry.method === 'POST').length

describe('a task left open while the credential store is still loading', () => {
  it('is orphaned with the real reason, then recovered with its artifact once the key resolves', async () => {
    const fake = await fixture({ pollsBeforeDone: 0 })
    const id = await providerTask(fake)
    const ledger = await ledgerAt()
    await ledger.add(row({ providerTaskId: id }))
    const { runtime, publishCredentials } = runtimeFor(settingsFor(fake), ledger)

    await reconcile(runtime)
    const orphaned = ledger.byId('v-20261015-0011')
    expect(orphaned?.status).toBe('orphaned')
    expect(orphaned?.error?.message).toMatch(/credential .* not available \(provider "ark" needs the credential VIDEO_FORGE_ORPHAN_TEST_KEY/)
    expect(orphaned?.error?.message).toMatch(/asked again automatically .* never re-submitted/)

    publishCredentials()
    await retryOrphans(runtime)
    const settled = ledger.byId('v-20261015-0011')
    expect(settled?.status).toBe('succeeded')
    expect(settled?.error).toBeNull()
    expect(settled?.artifacts[0]?.bytes).toBe(2048)
    // The previous process's POST is the only one: recovered, never re-submitted.
    expect(posts(fake)).toBe(1)
  })

  it('reattaches a watch when the provider still reports the orphan running', async () => {
    const fake = await fixture({ pollsBeforeDone: 3 })
    const id = await providerTask(fake)
    const ledger = await ledgerAt()
    await ledger.add(row({ providerTaskId: id, status: 'orphaned', error: { message: 'earlier', code: null } }))
    const { runtime, publishCredentials } = runtimeFor(settingsFor(fake), ledger)
    publishCredentials()

    await retryOrphans(runtime)
    // Back under watch, in whatever open state the provider reports.
    expect(['queued', 'running']).toContain(ledger.byId('v-20261015-0011')?.status)
    await vi.waitFor(() => { expect(ledger.byId('v-20261015-0011')?.status).toBe('succeeded') }, { timeout: 5_000 })
    expect(posts(fake)).toBe(1)
  })
})

describe('which orphans are asked about again', () => {
  it('only those with a provider id, no artifact, inside the seven-day query window', async () => {
    const ledger = await ledgerAt()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()
    await ledger.add(row({ localId: 'v-1', status: 'orphaned', providerTaskId: 'cgt-a' }))
    await ledger.add(row({ localId: 'v-2', status: 'orphaned', providerTaskId: null }))
    await ledger.add(row({ localId: 'v-3', status: 'orphaned', providerTaskId: 'cgt-c', submittedAt: old }))
    await ledger.add(row({ localId: 'v-4', status: 'orphaned', providerTaskId: 'cgt-d', artifacts: [{ path: '/x.mp4', bytes: 1, mime: 'video/mp4', width: null, height: null, durationSec: null, token: 't', createdAt: old }] }))
    await ledger.add(row({ localId: 'v-5', status: 'failed', providerTaskId: 'cgt-e' }))
    expect(recoverableOrphans(ledger).map(task => task.localId)).toEqual(['v-1'])
  })

  it('does not rewrite a verdict that has not changed', async () => {
    const fake = await fixture()
    const id = await providerTask(fake)
    const ledger = await ledgerAt()
    await ledger.add(row({ providerTaskId: id }))
    const { runtime } = runtimeFor(settingsFor(fake), ledger)

    await reconcile(runtime)
    const first = ledger.byId('v-20261015-0011')
    await retryOrphans(runtime)
    expect(ledger.byId('v-20261015-0011')).toBe(first)
  })
})

describe('boot scheduling', () => {
  function fakeHost(): { host: ReconcileHost; injected: Array<() => void>; disposers: Array<() => void> } {
    const injected: Array<() => void> = []
    const disposers: Array<() => void> = []
    return {
      host: {
        inject: (_deps, callback) => { injected.push(callback) },
        effect: (execute) => { disposers.push(execute()) },
      },
      injected,
      disposers,
    }
  }

  it('waits for the credential service, boots once, then re-checks orphans on the timer', async () => {
    vi.useFakeTimers()
    const { host, injected, disposers } = fakeHost()
    const boot = vi.fn(async () => undefined)
    const retry = vi.fn(async () => undefined)
    scheduleReconciliation(host, boot, retry, () => undefined, { graceMs: 1_000, retryMs: 5_000 })

    expect(boot).not.toHaveBeenCalled()
    injected[0]?.()
    expect(boot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    // The grace timer finds boot already started and does nothing.
    expect(boot).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(retry).toHaveBeenCalledTimes(1)
    // A credential service that is replaced later asks again at once.
    injected[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(retry).toHaveBeenCalledTimes(2)

    for (const dispose of disposers) dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(retry).toHaveBeenCalledTimes(2)
  })

  it('boots after the grace period in a composition without a credential service', async () => {
    vi.useFakeTimers()
    const { host } = fakeHost()
    const boot = vi.fn(async () => undefined)
    scheduleReconciliation(host, boot, async () => undefined, () => undefined, { graceMs: 1_000, retryMs: 5_000 })
    await vi.advanceTimersByTimeAsync(999)
    expect(boot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(boot).toHaveBeenCalledTimes(1)
  })
})

describe('usage settlement', () => {
  it('asks the provider for a finished task\'s usage and records it once', async () => {
    const fake = await fixture({ pollsBeforeDone: 0 })
    const id = await providerTask(fake)
    const ledger = await ledgerAt()
    // A row settled before usage was recorded.
    await ledger.add(row({ providerTaskId: id, status: 'succeeded' }))
    const { runtime, publishCredentials } = runtimeFor(settingsFor(fake), ledger)
    publishCredentials()

    await settleBilling(runtime)
    expect(ledger.byId('v-20261015-0011')?.billing).toMatchObject({ state: 'reported', tokens: 40594, fields: { completion_tokens: 40594, total_tokens: 40594 } })
    const gets = fake.requests.filter(entry => entry.method === 'GET').length
    await settleBilling(runtime)
    expect(fake.requests.filter(entry => entry.method === 'GET').length).toBe(gets)
  })

  it('records unknown, never zero, once the provider no longer answers for the task', async () => {
    const fake = await fixture()
    const ledger = await ledgerAt()
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString()
    await ledger.add(row({ localId: 'v-old', providerTaskId: 'cgt-gone', status: 'succeeded', submittedAt: old }))
    // Never created at the provider: nothing to settle.
    await ledger.add(row({ localId: 'v-refused', providerTaskId: null, status: 'failed', error: { message: 'refused', code: 'not_submitted' } }))
    const { runtime, publishCredentials } = runtimeFor(settingsFor(fake), ledger)
    publishCredentials()

    await settleBilling(runtime)
    expect(ledger.byId('v-old')?.billing).toMatchObject({ state: 'unknown', tokens: null, outputSeconds: null })
    expect(ledger.byId('v-refused')?.billing ?? null).toBeNull()
    expect(fake.requests).toHaveLength(0)
  })

  it('records it when a watch reattached after restart sees the task finish', async () => {
    const fake = await fixture({ pollsBeforeDone: 0 })
    const id = await providerTask(fake)
    const ledger = await ledgerAt()
    await ledger.add(row({ providerTaskId: id }))
    const { runtime, publishCredentials } = runtimeFor(settingsFor(fake), ledger)
    publishCredentials()

    await reconcile(runtime)
    expect(ledger.byId('v-20261015-0011')?.billing).toMatchObject({ state: 'reported', tokens: 40594 })
  })
})
