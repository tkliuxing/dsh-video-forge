/**
 * Intent-first submission (DESIGN §6): the ledger row is written before the
 * create request, so a lost response, a cancelled call or a crash mid-request
 * can never leave a billed provider task that the ledger does not know about —
 * and therefore can never let the same request through a second time.
 *
 * Driven against the fixture provider over a real socket, through the same
 * `generate` and `reconcile` the plugin runs.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { Ledger, parseDocument } from '../src/ledger.ts'
import { generate, listTasks, SubmissionUnconfirmedError } from '../src/operations.ts'
import { ProviderRequestError } from '../src/providers/adapter.ts'
import { reconcile } from '../src/reconcile.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { DEFAULT_ENDPOINTS, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import { NOT_SUBMITTED_CODE, UNCONFIRMED_CODE, type VideoTask } from '../src/types.ts'

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
  await Promise.all(fixtures.splice(0).map(async fixture => fixture.close()))
})

async function fixture(over: Parameters<typeof startFixture>[0]): Promise<Fixture> {
  const started = await startFixture(over)
  fixtures.push(started)
  return started
}

function arkProvider(fake: Fixture): ProviderSetting {
  return { id: 'ark', protocol: 'ark-seedance', baseUrl: `${fake.url}/api/v3`, authRef: '', models: [MODEL], endpoints: DEFAULT_ENDPOINTS }
}

function minimaxProvider(fake: Fixture): ProviderSetting {
  return { id: 'minimax', protocol: 'minimax-video', baseUrl: fake.url, authRef: '', models: [{ ...MODEL, id: 'MiniMax-H3', cancelable: false }], endpoints: DEFAULT_ENDPOINTS }
}

function settingsWith(provider: ProviderSetting): VideoForgeSettings {
  return {
    enabled: true,
    providers: [provider],
    defaultProvider: provider.id,
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

function runtimeFor(settings: VideoForgeSettings, ledger: Ledger): VideoForgeRuntime {
  return {
    // No credentials service: the fixture is loopback, so the key is legitimately absent.
    ctx: { get: () => undefined } as unknown as Context,
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

async function ledgerAt(path?: string): Promise<Ledger> {
  const target = path ?? join(await mkdtemp(join(tmpdir(), 'video-forge-intent-')), 'tasks.json')
  const ledger = new Ledger({ path: target, maxTasks: 10, maxGiB: 1 })
  await ledger.load()
  return ledger
}

const posts = (fake: Fixture): number => fake.requests.filter(entry => entry.method === 'POST').length

describe('a lost submit response', () => {
  it('leaves an unconfirmed row that refuses the same request again', async () => {
    const fake = await fixture({ mode: 'ark', loseSubmitResponses: 1, pollsBeforeDone: 1000 })
    const ledger = await ledgerAt()
    const runtime = runtimeFor(settingsWith(arkProvider(fake)), ledger)

    const first = generate(runtime, { prompt: 'a fox in snow' })
    await expect(first).rejects.toBeInstanceOf(SubmissionUnconfirmedError)
    await expect(first).rejects.toThrowError(/may already have created and billed/)
    expect(fake.created).toHaveLength(1)

    const [row] = ledger.list()
    expect(row?.status).toBe('unconfirmed')
    expect(row?.providerTaskId).toBeNull()
    expect(row?.error?.code).toBe(UNCONFIRMED_CODE)

    // The retry is stopped before anything leaves the process.
    await expect(generate(runtime, { prompt: 'a fox in snow' })).rejects.toThrowError(/outcome is unknown/)
    expect(posts(fake)).toBe(1)
    expect(fake.created).toHaveLength(1)

    // video_status lists it, and says why it must not be re-submitted.
    const listed = listTasks(runtime).tasks
    expect(listed).toHaveLength(1)
    expect(listed[0]?.status).toBe('unconfirmed')
    expect(listed[0]?.error).toMatch(/may already have created and billed this task — do not re-submit/)
  })
})

describe('cancelling the calling tool', () => {
  it('after the POST went out does not lose the task', async () => {
    const fake = await fixture({ mode: 'ark', submitDelayMs: 300, pollsBeforeDone: 1000 })
    const ledger = await ledgerAt()
    const runtime = runtimeFor(settingsWith(arkProvider(fake)), ledger)
    const call = new AbortController()

    const pending = generate(runtime, { prompt: 'a fox in snow' }, { signal: call.signal })
    await vi.waitFor(() => { expect(posts(fake)).toBe(1) })
    // The intent row exists while the request is still in flight.
    expect(ledger.list()[0]?.status).toBe('submitting')
    call.abort()

    const outcome = await pending
    expect(outcome.task.status).toBe('queued')
    expect(outcome.task.providerTaskId).toBe('cgt-fixture-1')
    expect(ledger.byId(outcome.task.localId)?.providerTaskId).toBe('cgt-fixture-1')
  })

  it('before the POST went out sends nothing and records nothing', async () => {
    const fake = await fixture({ mode: 'ark' })
    const ledger = await ledgerAt()
    const runtime = runtimeFor(settingsWith(arkProvider(fake)), ledger)

    await expect(generate(runtime, { prompt: 'a fox in snow' }, { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(posts(fake)).toBe(0)
    expect(ledger.list()).toHaveLength(0)
  })
})

describe('an explicit refusal', () => {
  it('is recorded as failed, never unconfirmed, and does not block a retry', async () => {
    const fake = await fixture({ mode: 'ark', rejectSubmitStatus: 400 })
    const ledger = await ledgerAt()
    const runtime = runtimeFor(settingsWith(arkProvider(fake)), ledger)

    // The provider's own code and sentence reach the caller, not just the status.
    await expect(generate(runtime, { prompt: 'a fox in snow' })).rejects.toThrow(/HTTP 400: InvalidParameter — fixture refused the submission/)
    const [row] = ledger.list()
    expect(row?.status).toBe('failed')
    expect(row?.error?.code).toBe(NOT_SUBMITTED_CODE)
    expect(row?.error?.message).toMatch(/refused the submission.*HTTP 400: InvalidParameter — fixture refused the submission$/)
    expect(ledger.list().some(task => task.status === 'unconfirmed')).toBe(false)

    // Nothing was created, so the same request may go out again.
    await expect(generate(runtime, { prompt: 'a fox in snow' })).rejects.toBeInstanceOf(ProviderRequestError)
    expect(posts(fake)).toBe(2)
  })
})

describe('a gateway failure', () => {
  it('is unconfirmed, not a refusal: the upstream may have accepted the request', async () => {
    const fake = await fixture({ mode: 'ark', rejectSubmitStatus: 502 })
    const ledger = await ledgerAt()
    const runtime = runtimeFor(settingsWith(arkProvider(fake)), ledger)

    await expect(generate(runtime, { prompt: 'a fox in snow' })).rejects.toBeInstanceOf(SubmissionUnconfirmedError)
    expect(ledger.list()[0]?.status).toBe('unconfirmed')
    await expect(generate(runtime, { prompt: 'a fox in snow' })).rejects.toThrowError(/outcome is unknown/)
    expect(posts(fake)).toBe(1)
  })
})

describe('a submission while the ledger is still loading', () => {
  it('waits for the read, so no earlier row is lost or bypassed', async () => {
    const fake = await fixture({ mode: 'ark', pollsBeforeDone: 1000 })
    const first = await ledgerAt()
    await expect(generate(runtimeFor(settingsWith(arkProvider(fake)), first), { prompt: 'a fox in snow' })).resolves.toBeDefined()

    // A new process: the tools are live before the ledger has been read.
    const second = new Ledger({ path: first.path, maxTasks: 10, maxGiB: 1 })
    const loading = second.load()
    const runtime = runtimeFor(settingsWith(arkProvider(fake)), second)
    await expect(generate(runtime, { prompt: 'a fox in snow' })).rejects.toThrowError(/already tracked/)
    await loading
    await expect(generate(runtime, { prompt: 'a heron at dawn' })).resolves.toBeDefined()

    const reread = await ledgerAt(first.path)
    expect(reread.list()).toHaveLength(2)
    expect(posts(fake)).toBe(2)
  })
})

describe('restart reconciliation', () => {
  it('recovers an ARK task from the task list and watches it to completion', async () => {
    const fake = await fixture({ mode: 'ark', loseSubmitResponses: 1, pollsBeforeDone: 1, artifactBytes: 1024 })
    const before = await ledgerAt()
    await expect(generate(runtimeFor(settingsWith(arkProvider(fake)), before), { prompt: 'a fox in snow' }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmedError)
    const localId = before.list()[0]?.localId ?? ''

    // A new process reads the same ledger.
    const after = await ledgerAt(before.path)
    await reconcile(runtimeFor(settingsWith(arkProvider(fake)), after))

    expect(fake.requests.some(entry => entry.method === 'GET' && /\/contents\/generations\/tasks\?/.test(entry.path))).toBe(true)
    expect(after.byId(localId)?.providerTaskId).toBe('cgt-fixture-1')
    await vi.waitFor(() => { expect(after.byId(localId)?.status).toBe('succeeded') }, { timeout: 5_000 })
    expect(after.byId(localId)?.artifacts[0]?.bytes).toBe(1024)
    // Recovered, never re-submitted.
    expect(posts(fake)).toBe(1)
  })

  it('never attributes a listed task when two unconfirmed rows overlap in time', async () => {
    // Row B's POST created a task; row A's created nothing. Adopting B's task for
    // A would report B as "never created" — and B could then be paid for twice.
    const fake = await fixture({ mode: 'ark', loseSubmitResponses: 1, pollsBeforeDone: 1000 })
    const before = await ledgerAt()
    await expect(generate(runtimeFor(settingsWith(arkProvider(fake)), before), { prompt: 'a heron at dawn' }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmedError)
    const rowB = before.list()[0]
    const earlier = new Date(Date.now() - 1_000).toISOString()
    await before.add({ ...rowB, localId: 'v-20261015-0099', submittedAt: earlier, updatedAt: earlier, paramsFingerprint: 'other' } as VideoTask)

    const after = await ledgerAt(before.path)
    await reconcile(runtimeFor(settingsWith(arkProvider(fake)), after))
    const rows = after.list()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.status).toBe('unconfirmed')
      expect(row.providerTaskId).toBeNull()
      expect(row.error?.message).toMatch(/overlap it in time/)
    }
    expect(posts(fake)).toBe(1)
  })

  it('keeps an ARK row unconfirmed when the list holds more than one candidate', async () => {
    const fake = await fixture({ mode: 'ark', loseSubmitResponses: 1, pollsBeforeDone: 1000 })
    const before = await ledgerAt()
    await expect(generate(runtimeFor(settingsWith(arkProvider(fake)), before), { prompt: 'a fox in snow' }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmedError)
    // Someone else on the same account submits to the same model moments later.
    await fetch(`${fake.url}/api/v3/contents/generations/tasks`, { method: 'POST', body: JSON.stringify({ model: MODEL.id }) })

    const after = await ledgerAt(before.path)
    await reconcile(runtimeFor(settingsWith(arkProvider(fake)), after))
    const [row] = after.list()
    expect(row?.status).toBe('unconfirmed')
    expect(row?.providerTaskId).toBeNull()
    expect(row?.error?.message).toMatch(/2 unclaimed tasks .*cgt-fixture-2, cgt-fixture-1/)
  })

  it('leaves a MiniMax submission unconfirmed: the protocol has no task list', async () => {
    const fake = await fixture({ mode: 'ark' })
    const ledger = await ledgerAt()
    const now = new Date().toISOString()
    // The previous process died with the create request in flight.
    const row: VideoTask = {
      localId: 'v-20261015-0001',
      provider: 'minimax',
      protocol: 'minimax-video',
      model: 'MiniMax-H3',
      providerTaskId: null,
      status: 'submitting',
      progress: null,
      submittedAt: now,
      updatedAt: now,
      paramsFingerprint: 'fp',
      params: { prompt: 'a fox in snow', mode: 't2v', durationSeconds: 6, resolution: '768P', aspectRatio: '16:9', firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [],
      error: null,
    }
    await ledger.add(row)

    await reconcile(runtimeFor(settingsWith(minimaxProvider(fake)), ledger))
    const settled = ledger.byId(row.localId)
    expect(settled?.status).toBe('unconfirmed')
    expect(settled?.providerTaskId).toBeNull()
    expect(settled?.error?.message).toMatch(/no task-list endpoint.*do not re-submit/)
    // Nothing was asked of the provider, and certainly nothing was submitted.
    expect(fake.requests).toHaveLength(0)
  })
})

describe('reading the ledger', () => {
  it('keeps rows it cannot fully trust instead of dropping them', () => {
    const base = {
      provider: 'ark', protocol: 'ark-seedance', model: MODEL.id, progress: null,
      submittedAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
      paramsFingerprint: 'fp', params: {}, artifacts: [], error: null,
    }
    const document = parseDocument(JSON.stringify({
      version: 1,
      tasks: [
        { ...base, localId: 'a', status: 'some-future-status', providerTaskId: 'cgt-1' },
        { ...base, localId: 'b', status: 'queued', providerTaskId: null },
        { ...base, localId: 'c', status: 'unconfirmed', providerTaskId: null },
      ],
    }))
    expect(document.tasks.map(task => [task.localId, task.status])).toEqual([
      ['a', 'orphaned'],
      ['b', 'unconfirmed'],
      ['c', 'unconfirmed'],
    ])
  })
})
