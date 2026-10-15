/**
 * M3.1 (DESIGN §17): the session a task came from is recorded; materials are
 * read through the host's filesystem service and recognised by their bytes when
 * their name says nothing; the live-watch table is shared per ledger file.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/ledger.ts'
import { MaterialError, resolveMaterial, sniffMime } from '../src/materials.ts'
import { watchTableFor } from '../src/runtime.ts'
import { sessionContextOf } from '../src/session-context.ts'
import type { WorkspaceFs, WorkspaceTarget } from '../src/workspace-fs.ts'
import { workspaceFsOf } from '../src/workspace-fs.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3])
const ascii = (text: string): number[] => [...text].map(char => char.charCodeAt(0))

describe('recognising a file by its first bytes', () => {
  it('knows the formats the providers accept, and nothing else', () => {
    expect(sniffMime(PNG)).toBe('image/png')
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg')
    expect(sniffMime(Uint8Array.from(ascii('GIF89a......')))).toBe('image/gif')
    expect(sniffMime(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8 ')]))).toBe('image/webp')
    expect(sniffMime(Uint8Array.from([0, 0, 0, 0x20, ...ascii('ftypisom'), 0, 0, 0, 0]))).toBe('video/mp4')
    expect(sniffMime(Uint8Array.from([0, 0, 0, 0x14, ...ascii('ftypqt  '), 0, 0, 0, 0]))).toBe('video/quicktime')
    expect(sniffMime(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]))).toBe('video/webm')
    expect(sniffMime(Uint8Array.from(ascii('%PDF-1.7 hello')))).toBeNull()
    expect(sniffMime(new Uint8Array(0))).toBeNull()
  })
})

describe('a material path', () => {
  const hostFs = workspaceFsOf({ get: () => undefined } as unknown as Context, false)

  it('with no extension, as DSH stores a dropped image, is read by its signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-attach-'))
    // `$DSH_HOME/attachments/v1/objects/<ab>/<sha256>`: no extension at all.
    const path = join(dir, 'ab12cd34')
    await writeFile(path, PNG)
    const resolved = await resolveMaterial({ kind: 'path', value: path }, { fs: hostFs, cwd: null })
    expect(resolved.mime).toBe('image/png')
    expect(resolved.url.startsWith('data:image/png;base64,')).toBe(true)
    expect(resolved.bytes).toBe(PNG.byteLength)
  })

  it('that is neither an image nor a video, by name or by content, is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-attach-'))
    await writeFile(join(dir, 'notes'), 'just text')
    await expect(resolveMaterial({ kind: 'path', value: join(dir, 'notes') }, { fs: hostFs, cwd: null }))
      .rejects.toThrow(/neither a recognized image nor video/)
  })

  it('is read through the host filesystem service, relative to the session workspace', async () => {
    const calls: string[] = []
    const target: WorkspaceTarget = { targetKey: 'k', displayPath: '/ws/project/materials/cat' }
    const fs: WorkspaceFs = {
      resolve: async (path, options) => { calls.push(`resolve ${path} cwd=${options?.cwd ?? '-'}`); return target },
      stat: async () => ({ type: 'file', size: PNG.byteLength }),
      readByteRange: async (_t, range) => { calls.push(`range ${range.offset}+${range.length}`); return PNG.subarray(0, range.length) },
      readBytes: async (_t, _s, max) => { calls.push(`bytes max=${max}`); return PNG },
    }
    const resolved = await resolveMaterial({ kind: 'path', value: 'materials/cat' }, { fs, cwd: '/ws/project' })
    expect(resolved.mime).toBe('image/png')
    expect(calls).toEqual(['resolve materials/cat cwd=/ws/project', 'range 0+16', `bytes max=${20 * 1024 * 1024}`])
  })

  it('reports a missing file, a directory, and an oversized file as things the model can fix', async () => {
    const target: WorkspaceTarget = { targetKey: 'k', displayPath: '/ws/x.png' }
    const base: WorkspaceFs = {
      resolve: async () => target,
      stat: async () => undefined,
      readByteRange: async () => PNG,
      readBytes: async () => PNG,
    }
    await expect(resolveMaterial({ kind: 'path', value: '/ws/x.png' }, { fs: base, cwd: null })).rejects.toThrow(/no readable file at \/ws\/x\.png/)
    await expect(resolveMaterial({ kind: 'path', value: '/ws/x.png' }, { fs: { ...base, stat: async () => ({ type: 'directory' }) }, cwd: null }))
      .rejects.toThrow(/not a regular file/)
    // A backend that cannot report a size enforces the cap on read instead.
    const capped: WorkspaceFs = {
      ...base,
      stat: async () => ({ type: 'file' }),
      readBytes: async () => { throw Object.assign(new Error('too big'), { code: 'FS_TOO_LARGE' }) },
    }
    const error = await resolveMaterial({ kind: 'path', value: '/ws/x.png' }, { fs: capped, cwd: null }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MaterialError)
    expect(String(error)).toMatch(/above the 20 MiB limit/)
  })
})

describe('the calling session', () => {
  const agent = { id: 'sess-1', session: { header: { cwd: '/ws/project' } } }

  it('is captured with the permission mode the host resolves for it', () => {
    const seen: unknown[] = []
    const ctx = {
      get: (name: string) => (name === 'sandboxPolicy'
        ? { resolve: (request: { session?: unknown }) => { seen.push(request.session); return { mode: 'workspace-write', workspaceRoot: '/ws/project' } } }
        : undefined),
    } as unknown as Context
    expect(sessionContextOf(ctx, agent)).toEqual({ id: 'sess-1', cwd: '/ws/project', mode: 'workspace-write' })
    expect(seen).toEqual([agent.session])
  })

  it('has no mode when no sandbox policy is mounted, and is absent when no session called', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(sessionContextOf(ctx, agent)).toEqual({ id: 'sess-1', cwd: '/ws/project', mode: null })
    expect(sessionContextOf(ctx, undefined)).toBeNull()
  })
})

describe('a stored session record', () => {
  const now = new Date().toISOString()
  const row = (session: unknown): unknown => ({
    localId: 'v-1', provider: 'ark', protocol: 'ark-seedance', model: 'm', providerTaskId: 'cgt-1', status: 'running', progress: null,
    submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
    params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [], error: null, session,
  })

  it('is kept when it is well formed, cleaned when a field is unknown, and dropped when it has no id', () => {
    const doc = parseDocument(JSON.stringify({ version: 1, tasks: [
      row({ id: 's', cwd: '/ws', mode: 'read-only' }),
      row({ id: 's', cwd: '/ws', mode: 'sideways' }),
      row({ cwd: '/ws', mode: 'read-only' }),
    ] }))
    expect(doc.tasks.map(task => task.session ?? null)).toEqual([
      { id: 's', cwd: '/ws', mode: 'read-only' },
      { id: 's', cwd: '/ws', mode: 'unknown' },
      null,
    ])
  })
})

describe('a session call without the host filesystem service', () => {
  it('is refused rather than read on this machine, where a remote workspace does not live', async () => {
    const fs = workspaceFsOf({ get: () => undefined } as unknown as Context, true)
    expect(fs).toBeNull()
    await expect(resolveMaterial({ kind: 'path', value: '/home/me/shots/a.png' }, { fs, cwd: '/home/me' }))
      .rejects.toThrow(/workspace filesystem is not available right now/)
  })

  it('maps a backend failure on the path to something the model can act on', async () => {
    const fs: WorkspaceFs = {
      resolve: async () => { throw Object.assign(new Error('a path segment is a file'), { code: 'FS_NOT_FOUND' }) },
      stat: async () => undefined,
      readByteRange: async () => PNG,
      readBytes: async () => PNG,
    }
    const error = await resolveMaterial({ kind: 'path', value: 'a.png/b.png' }, { fs, cwd: '/ws' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MaterialError)
    expect(String(error)).toMatch(/cannot read "a\.png\/b\.png": a path segment is a file/)
  })

  it('fingerprints a relative path by the file it names, not by its spelling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-loc-'))
    await writeFile(join(dir, 'a.png'), PNG)
    const fs = workspaceFsOf({ get: () => undefined } as unknown as Context, false)
    const relative = await resolveMaterial({ kind: 'path', value: './a.png' }, { fs, cwd: dir })
    const absolute = await resolveMaterial({ kind: 'path', value: join(dir, 'a.png') }, { fs, cwd: dir })
    expect(relative.location).toBe(absolute.location)
  })
})

describe('the ISO base media signature', () => {
  it('is a video only for video brands; HEIC, AVIF and M4A are not', () => {
    const box = (brand: string): Uint8Array => Uint8Array.from([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0])
    expect(sniffMime(box('mp42'))).toBe('video/mp4')
    expect(sniffMime(box('avc1'))).toBe('video/mp4')
    expect(sniffMime(box('heic'))).toBeNull()
    expect(sniffMime(box('mif1'))).toBeNull()
    expect(sniffMime(box('avif'))).toBeNull()
    expect(sniffMime(box('M4A '))).toBeNull()
  })
})

describe('a sandbox policy that cannot answer', () => {
  it('records the mode as unknown, never as unfenced', () => {
    const ctx = { get: (name: string) => (name === 'sandboxPolicy' ? { resolve: () => { throw new Error('projection not registered') } } : undefined) } as unknown as Context
    expect(sessionContextOf(ctx, { id: 's', session: { header: { cwd: '/ws' } } })?.mode).toBe('unknown')
  })
})

describe('the live-watch table', () => {
  it('is one table per ledger file for the whole process, so a re-applied plugin sees the old watches', () => {
    const first = watchTableFor('/home/a/tasks.json')
    first.add('v-1')
    expect(watchTableFor('/home/a/tasks.json')).toBe(first)
    expect(watchTableFor('/home/a/tasks.json').has('v-1')).toBe(true)
    expect(watchTableFor('/home/b/tasks.json').has('v-1')).toBe(false)
    // Two spellings of one file share one table.
    expect(watchTableFor('/home/a/../a/tasks.json')).toBe(first)
    first.delete('v-1')
  })
})

describe('the ledger for one file', () => {
  it('is one object for the whole process, so two plugin instances never flush over each other', async () => {
    const { sharedLedger } = await import('../src/ledger.ts')
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-shared-'))
    const first = sharedLedger({ path: join(dir, 'tasks.json'), maxTasks: 10, maxGiB: 1 })
    const second = sharedLedger({ path: join(dir, '.', 'tasks.json'), maxTasks: 20, maxGiB: 2 })
    expect(second).toBe(first)
  })

  it('never writes over the file before a read has succeeded, even when the first holder never loaded it', async () => {
    const { sharedLedger } = await import('../src/ledger.ts')
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-shared-'))
    const path = join(dir, 'tasks.json')
    const now = new Date().toISOString()
    const existing = {
      localId: 'v-paid', provider: 'ark', protocol: 'ark-seedance', model: 'm', providerTaskId: 'cgt-1', status: 'running', progress: null,
      submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
      params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [], error: null,
    }
    await writeFile(path, JSON.stringify({ version: 1, tasks: [existing] }))
    // The first plugin instance failed before loading; a re-applied one gets the same object.
    sharedLedger({ path, maxTasks: 10, maxGiB: 1 })
    const ledger = sharedLedger({ path, maxTasks: 10, maxGiB: 1 })
    await expect(ledger.add({ ...existing, localId: 'v-new' } as never)).rejects.toThrow(/not loaded \(it was never read\); not writing over it/)
    // Loading through the shared object keeps every recorded task.
    await ledger.ensureLoaded()
    await ledger.add({ ...existing, localId: 'v-new' } as never)
    const { readFile } = await import('node:fs/promises')
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { tasks: { localId: string }[] }
    expect(onDisk.tasks.map(task => task.localId).sort()).toEqual(['v-new', 'v-paid'])
  })

  it('retries a failed read instead of trusting an empty document', async () => {
    const { Ledger } = await import('../src/ledger.ts')
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-shared-'))
    // A directory where the file should be: the read fails with EISDIR, not "missing".
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, 'tasks.json'))
    const ledger = new Ledger({ path: join(dir, 'tasks.json'), maxTasks: 10, maxGiB: 1 })
    await expect(ledger.ensureLoaded()).rejects.toThrow()
    await expect(ledger.update('v-1', task => task)).rejects.toThrow(/reading it failed/)
  })
})
