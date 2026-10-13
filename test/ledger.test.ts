/**
 * Ledger behaviour: the parts a crash can expose — id minting, atomic replace,
 * corrupt-file quarantine, and the artifact lookup the media route trusts.
 */

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Ledger, LedgerCorruptError, parseDocument } from '../src/ledger.ts'
import type { VideoTask } from '../src/types.ts'

let root: string
let ledger: Ledger

function task(localId: string, over: Partial<VideoTask> = {}): VideoTask {
  return {
    localId,
    provider: 'ark',
    protocol: 'ark-seedance',
    model: 'doubao-seedance-1-0-pro',
    providerTaskId: 'cgt-1',
    status: 'queued',
    progress: null,
    submittedAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    paramsFingerprint: 'fp',
    params: {
      prompt: 'a fox',
      mode: 't2v',
      durationSeconds: null,
      resolution: null,
      aspectRatio: null,
      firstFrame: null,
      lastFrame: null,
      referenceImages: [],
    },
    artifacts: [],
    error: null,
    ...over,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'video-forge-ledger-'))
  ledger = new Ledger({ path: join(root, 'tasks.json'), maxTasks: 2, maxGiB: 1 })
})

afterEach(() => {
  // Temporary trees are per-test and small; the OS reaps them.
})

describe('Ledger', () => {
  it('treats a missing file as an empty ledger', async () => {
    await ledger.load()
    expect(ledger.list()).toEqual([])
    expect(ledger.open()).toEqual([])
  })

  it('mints per-day ids that do not collide within one process', async () => {
    await ledger.load()
    const now = new Date('2026-10-13T10:00:00Z')
    const first = ledger.nextLocalId(now)
    const second = ledger.nextLocalId(now)
    expect(first).toMatch(/^v-20261013-0001$/)
    expect(second).toMatch(/^v-20261013-0002$/)
  })

  it('continues the sequence past ids already on disk', async () => {
    await writeFile(join(root, 'tasks.json'), JSON.stringify({ version: 1, tasks: [task('v-20261013-0042')] }))
    await ledger.load()
    expect(ledger.nextLocalId(new Date('2026-10-13T10:00:00Z'))).toBe('v-20261013-0043')
  })

  it('writes through a temp file and leaves no debris', async () => {
    await ledger.load()
    await ledger.add(task('v-20261013-0001'))
    const entries = await readdir(root)
    expect(entries).toEqual(['tasks.json'])
    expect(JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')).tasks).toHaveLength(1)
  })

  it('quarantines a corrupt file instead of overwriting it', async () => {
    await writeFile(join(root, 'tasks.json'), '{ not json')
    await expect(ledger.load()).rejects.toBeInstanceOf(LedgerCorruptError)
    const entries = await readdir(root)
    expect(entries.some(name => name.startsWith('tasks.json.corrupt-'))).toBe(true)
    expect(ledger.list()).toEqual([])
  })

  it('keeps concurrent updates from interleaving', async () => {
    await ledger.load()
    await ledger.add(task('v-20261013-0001'))
    await Promise.all([
      ledger.update('v-20261013-0001', current => ({ ...current, progress: 0.5 })),
      ledger.update('v-20261013-0001', current => ({ ...current, status: 'running' })),
    ])
    const stored = ledger.byId('v-20261013-0001')
    expect(stored?.status).toBe('running')
    expect(stored?.progress).toBe(0.5)
  })

  it('separates open tasks for reconciliation from finished ones', async () => {
    await ledger.load()
    await ledger.add(task('v-20261013-0001', { status: 'running' }))
    await ledger.add(task('v-20261013-0002', { status: 'succeeded' }))
    await ledger.add(task('v-20261013-0003', { status: 'orphaned' }))
    expect(ledger.open().map(row => row.localId)).toEqual(['v-20261013-0001'])
  })

  it('requires both the task id and the artifact token', async () => {
    await ledger.load()
    await ledger.add(task('v-20261013-0001', {
      artifacts: [{
        path: join(root, 'out.mp4'),
        bytes: 10,
        mime: 'video/mp4',
        width: null,
        height: null,
        durationSec: null,
        token: 'deadbeef',
        createdAt: '2026-10-13T00:00:00.000Z',
      }],
    }))
    expect(ledger.artifact('v-20261013-0001', 'deadbeef')).toBeDefined()
    expect(ledger.artifact('v-20261013-0001', 'wrong')).toBeUndefined()
    expect(ledger.artifact('v-20261013-9999', 'deadbeef')).toBeUndefined()
  })

  it('finds a recent submission by fingerprint inside the window only', async () => {
    await ledger.load()
    await ledger.add(task('v-20261013-0001', { paramsFingerprint: 'abc' }))
    const submittedAt = Date.parse('2026-10-13T00:00:00.000Z')
    expect(ledger.byFingerprint('abc', submittedAt - 1000)).toBeDefined()
    expect(ledger.byFingerprint('abc', submittedAt + 1000)).toBeUndefined()
  })

  it('reports retention pressure without ever deleting', async () => {
    await ledger.load()
    await ledger.add(task('v-20261013-0001'))
    await ledger.add(task('v-20261013-0002'))
    await ledger.add(task('v-20261013-0003'))
    const hint = ledger.retention()
    expect(hint.tasks).toBe(3)
    expect(hint.overTaskLimit).toBe(true)
    expect(ledger.list()).toHaveLength(3)
  })

  it('drops unusable rows but keeps the rest of a damaged document', () => {
    const parsed = parseDocument(JSON.stringify({ version: 1, tasks: [task('ok'), { localId: 42 }, null] }))
    expect(parsed.tasks.map(row => row.localId)).toEqual(['ok'])
  })
})
