/**
 * A teaching render in the ledger (TEACH-VIDEO.md §8, plan A).
 *
 * The row exists for one reason: the video panel lists the ledger, not the
 * folder. These checks pin both halves — that the row carries what the panel
 * reads, and that nothing written for a provider task is applied to it.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.ts'
import { cancelTask, listTasks, recordLocalRender, summarizeCost } from '../src/operations.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_ENDPOINTS, type VideoForgeSettings } from '../src/settings.ts'
import { isLocalRender } from '../src/types.ts'

async function runtime(): Promise<{ runtime: VideoForgeRuntime, home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'teach-ledger-'))
  const ledger = new Ledger({ path: join(home, 'tasks.json'), maxTasks: 100, maxGiB: 1 })
  await ledger.load()
  const settings = {
    enabled: true,
    providers: [],
    defaultProvider: '',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 10,
    waitSecondsMax: 60,
    dedupeWindowSeconds: 120,
    maxConcurrent: 1,
    maxTasks: 100,
    maxGiB: 1,
    requestTimeoutMs: 30_000,
    priceTable: DEFAULT_PRICE_TABLE,
    priceSource: { url: '', refreshHours: 24, info: null },
  } as unknown as VideoForgeSettings
  const ctx = { get: () => undefined } as unknown as Context
  const value: VideoForgeRuntime = {
    ctx,
    ledger,
    selections: new SelectionStore({ path: join(home, 'selections.json') }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(home, 'outputs'),
    outputDirectory: (id: string) => join(home, 'outputs', id),
    watchTask: () => null,
    cancels: new Map(),
    watching: new Set(),
  }
  return { runtime: value, home }
}

const SESSION = { id: 'session-teach', cwd: '/tmp/workspace', mode: 'workspace-write' as const }

const INPUT = {
  title: '部分和为什么收敛到 π²/6',
  storyboard: 'storyboard.yaml',
  session: SESSION,
  relativePath: 'renders/teach/v001.mp4',
  shot: 'teach',
  version: 1,
  absolutePath: '/tmp/workspace/renders/teach/v001.mp4',
  bytes: 186_961,
  durationMs: 8400,
  width: 1920,
  height: 1080,
  sidecar: 'renders/teach/v001.json',
}

describe('recording a teaching render', () => {
  it('writes a row the panel can list, marked as local with a workspace path', async () => {
    const { runtime: forge } = await runtime()
    const task = await recordLocalRender(forge, INPUT)

    expect(task.origin).toBe('local')
    expect(task.localId).toMatch(/^v-\d{8}-\d{4}$/)
    expect(task.provider).toBe('local')
    expect(task.model).toBe('teach-video')
    expect(task.providerTaskId).toBeNull()
    expect(task.status).toBe('succeeded')
    expect(task.session?.id).toBe('session-teach')
    expect(isLocalRender(task)).toBe(true)

    const list = listTasks(forge, { limit: 10 })
    expect(list.tasks).toHaveLength(1)
    const row = list.tasks[0]!
    expect(row.origin).toBe('local')
    expect(row.workspacePath).toBe('renders/teach/v001.mp4')
    expect(row.shot).toBe('teach')
    expect(row.durationSeconds).toBe(8.4)
    expect(row.width).toBe(1920)
    expect(row.height).toBe(1080)
    expect(row.artifactBytes).toBe(186_961)
    // A play URL is what the panel's preview uses; it comes from the ledger, never from the client.
    expect(row.playUrl).toContain('video-forge')
    expect(row.prompt).toBe('部分和为什么收敛到 π²/6')
  })

  it('gives every render its own id, because two renders are two files', async () => {
    const { runtime: forge } = await runtime()
    const first = await recordLocalRender(forge, INPUT)
    const second = await recordLocalRender(forge, { ...INPUT, relativePath: 'renders/teach/v002.mp4', version: 2 })
    expect(first.localId).not.toBe(second.localId)
    expect(listTasks(forge, { limit: 10 }).tasks).toHaveLength(2)
  })

  it('refuses to cancel one, because nothing was submitted anywhere', async () => {
    const { runtime: forge } = await runtime()
    const task = await recordLocalRender(forge, INPUT)
    await expect(cancelTask(forge, task.localId)).rejects.toThrow(/locally rendered video/)
  })

  it('contributes no cost, since no provider was asked', async () => {
    const { runtime: forge } = await runtime()
    await recordLocalRender(forge, INPUT)
    const cost = summarizeCost(forge)
    expect(cost.unknownUsage).toEqual([])
    expect(cost.groups).toEqual([])
  })

  it('keeps provider rows defaulted to provider when origin is absent', async () => {
    const { runtime: forge } = await runtime()
    const task = await recordLocalRender(forge, INPUT)
    expect(task.origin).toBe('local')
    // A row written before the field existed reads as a provider row, not as local.
    const { origin: _origin, ...legacy } = task
    expect(isLocalRender(legacy)).toBe(false)
    expect(listTasks(forge, { limit: 10 }).tasks.some(row => row.origin === 'provider')).toBe(false)
  })

  it('does not extend the plugin-side byte budget with a workspace video', async () => {
    const { runtime: forge } = await runtime()
    await recordLocalRender(forge, INPUT)
    // The file belongs to the user's workspace, so it is not the plugin's storage.
    expect(listTasks(forge, { limit: 10 }).usage.bytes).toBe(0)
  })
})

// Keeps the unused-import guard honest if DEFAULT_ENDPOINTS stops being needed here.
void DEFAULT_ENDPOINTS
