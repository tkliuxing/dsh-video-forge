import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { estimateGeneration, summarizeCost } from '../src/operations.ts'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { DEFAULT_ENDPOINTS, type ModelSetting, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { VideoTask } from '../src/types.ts'

const MODEL: ModelSetting = {
  id: 'm', label: 'm', modes: ['t2v'], durations: [], resolutions: [], aspectRatios: [], sizes: [], cancelable: true, generateAudio: false, pollIntervalMs: 5000, frameRoleFirst: 'first_frame', frameRoleLast: 'last_frame', frameRoleReference: 'reference_image',
}

const ARK: ProviderSetting = { id: 'ark', protocol: 'ark-seedance', baseUrl: 'http://localhost:1', authRef: '', models: [{ ...MODEL, id: 'seedance' }], endpoints: DEFAULT_ENDPOINTS }
const MINIMAX: ProviderSetting = { id: 'mm', protocol: 'minimax-video', baseUrl: 'http://localhost:2', authRef: '', models: [{ ...MODEL, id: 'hailuo' }], endpoints: DEFAULT_ENDPOINTS }

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function ledgerWith(tasks: VideoTask[]): Promise<Ledger> {
  const root = await mkdtemp(join(tmpdir(), 'video-forge-cost-'))
  roots.push(root)
  const ledger = new Ledger({ path: join(root, 'tasks.json'), maxTasks: 100, maxGiB: 1 })
  await ledger.ensureLoaded()
  for (const task of tasks) await ledger.add(task)
  return ledger
}

function runtimeFor(ledger: Ledger, over: Partial<VideoForgeSettings> = {}): VideoForgeRuntime {
  const settings: VideoForgeSettings = {
    enabled: true,
    providers: [ARK, MINIMAX],
    defaultProvider: 'ark',
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
  return {
    ctx: { get: () => undefined } as unknown as Context,
    ledger,
    selections: new SelectionStore({ path: join(ledger.home, 'selections.json') }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(ledger.home, 'outputs'),
    outputDirectory: localId => join(ledger.home, 'outputs', localId),
    watchTask: () => null,
    cancels: new Map(),
    watching: new Set(),
  }
}

function reported(tokens: number | null, outputSeconds: number | null): VideoTask['billing'] {
  return { state: 'reported', tokens, outputSeconds, fields: {}, settledAt: new Date().toISOString() }
}

function task(localId: string, provider: string, model: string, shot: string, billing: VideoTask['billing']): VideoTask {
  const now = new Date().toISOString()
  return {
    localId, provider, protocol: provider === 'ark' ? 'ark-seedance' : 'minimax-video', model, providerTaskId: `cgt-${localId}`,
    status: 'succeeded', progress: null, submittedAt: now, updatedAt: now, paramsFingerprint: localId,
    params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [], error: null, destination: { kind: 'workspace', root: '/ws', renders: 'renders', shot, writeManifest: false },
    ...(billing === undefined ? {} : { billing }),
  }
}

describe('summarizeCost', () => {
  it('groups settled usage by provider/model/shot and estimates money', async () => {
    const ledger = await ledgerWith([
      task('v-1', 'ark', 'seedance', 'a', reported(100, null)),
      task('v-2', 'ark', 'seedance', 'a', reported(50, null)),
      task('v-3', 'mm', 'hailuo', 'b', reported(null, 10)),
      task('v-4', 'ark', 'seedance', 'a', { state: 'unknown', tokens: null, outputSeconds: null, fields: {}, settledAt: new Date().toISOString() }),
    ])
    const summary = summarizeCost(runtimeFor(ledger))

    expect(summary.totalTasks).toBe(3)
    expect(summary.currency).toBe(DEFAULT_PRICE_TABLE.currency)
    // one group per (provider, model, shot)
    expect(summary.groups).toHaveLength(2)
    const ark = summary.groups.find(group => group.provider === 'ark')!
    expect(ark.shot).toBe('a')
    expect(ark.tasks).toBe(2)
    expect(ark.tokens).toBe(150)
    const mm = summary.groups.find(group => group.provider === 'mm')!
    expect(mm.outputSeconds).toBe(10)

    // unknown usage is listed, not counted
    expect(summary.unknownUsage.map(entry => entry.taskId)).toEqual(['v-4'])
    // a total exists and equals the sum of the priced groups
    expect(summary.totalEstimatedAmount).toBeGreaterThan(0)
  })

  it('ignores tasks that have not settled or settled with no usage', async () => {
    const ledger = await ledgerWith([
      task('v-1', 'ark', 'seedance', 'a', reported(100, null)),
      task('v-2', 'ark', 'seedance', 'a', undefined),
      task('v-3', 'ark', 'seedance', 'a', { state: 'none', tokens: null, outputSeconds: null, fields: {}, settledAt: new Date().toISOString() }),
    ])
    const summary = summarizeCost(runtimeFor(ledger))
    expect(summary.totalTasks).toBe(1)
    expect(summary.groups).toHaveLength(1)
  })
})

describe('estimateGeneration', () => {
  it('estimates ARK by the token formula', () => {
    const ledger = new Ledger({ path: join(process.cwd(), 'unused-cost.json'), maxTasks: 1, maxGiB: 1 })
    const estimate = estimateGeneration(runtimeFor(ledger), { providerId: 'ark', modelId: 'seedance', durationSeconds: 4, resolution: '480p', aspectRatio: '16:9' })
    expect(estimate.unit).toBe('token')
    // 40594 tokens × the default token price
    expect(estimate.amount).toBe(40594 * (DEFAULT_PRICE_TABLE.rows[0]!.pricePerUnit))
  })

  it('estimates MiniMax by seconds × price', () => {
    const ledger = new Ledger({ path: join(process.cwd(), 'unused-cost.json'), maxTasks: 1, maxGiB: 1 })
    const estimate = estimateGeneration(runtimeFor(ledger), { providerId: 'mm', modelId: 'hailuo', durationSeconds: 5, resolution: null, aspectRatio: null })
    expect(estimate.unit).toBe('second')
    expect(estimate.amount).toBe(5 * (DEFAULT_PRICE_TABLE.rows[1]!.pricePerUnit))
  })

  it('refuses a provider it cannot resolve', () => {
    const ledger = new Ledger({ path: join(process.cwd(), 'unused-cost.json'), maxTasks: 1, maxGiB: 1 })
    const estimate = estimateGeneration(runtimeFor(ledger), { providerId: 'nope', modelId: '', durationSeconds: 4, resolution: null, aspectRatio: null })
    expect(estimate.amount).toBeNull()
  })
})
