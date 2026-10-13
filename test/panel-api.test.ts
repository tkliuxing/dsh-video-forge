/**
 * The workbench API over a real socket, plus the trust fence in front of it.
 *
 * The fence is the part worth testing hardest: without it, anything that can reach
 * the port can read task prompts and spend money.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { Ledger } from '../src/ledger.ts'
import { PANEL_ROUTE_PREFIX, panelHandler } from '../src/panel-api.ts'
import { isIPv4Loopback, isLoopbackAddress, isLoopbackHostname, isTrustedRequest } from '../src/trust.ts'
import { DEFAULT_ENDPOINTS, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import type { VideoTask } from '../src/types.ts'

const MODEL = {
  id: 'doubao-seedance-fixture',
  label: 'Fixture Seedance',
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
let server: Server
let base: string
let runtime: VideoForgeRuntime
let ledger: Ledger

function settingsFor(baseUrl: string): VideoForgeSettings {
  const provider: ProviderSetting = {
    id: 'fixture',
    protocol: 'ark-seedance',
    baseUrl,
    authRef: '',
    models: [MODEL],
    endpoints: DEFAULT_ENDPOINTS,
  }
  return {
    enabled: true,
    providers: [provider],
    defaultProvider: 'fixture',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 10,
    waitSecondsMax: 600,
    dedupeWindowSeconds: 0,
    maxConcurrent: 1,
    maxTasks: 200,
    maxGiB: 20,
    requestTimeoutMs: 30_000,
  }
}

function taskRow(localId: string): VideoTask {
  return {
    localId,
    provider: 'fixture',
    protocol: 'ark-seedance',
    model: MODEL.id,
    providerTaskId: 'cgt-existing',
    status: 'running',
    progress: null,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    paramsFingerprint: 'x',
    params: { prompt: 'an existing job', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [],
    error: null,
  }
}

beforeAll(async () => {
  fixture = await startFixture({ mode: 'ark', pollsBeforeDone: 1, artifactBytes: 4096 })
  const root = await mkdtemp(join(tmpdir(), 'video-forge-panel-'))
  ledger = new Ledger({ path: join(root, 'tasks.json'), maxTasks: 10, maxGiB: 1 })
  await ledger.load()
  const settings = settingsFor(`${fixture.url}/api/v3`)
  runtime = {
    ctx: { get: () => undefined } as unknown as Context,
    ledger,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(root, 'outputs'),
    outputDirectory: localId => join(root, 'outputs', localId),
    // No jobs service in this stub: submissions are watched in-process, which is
    // also what a browser submission does (it has no agent to own a job).
    watchTask: () => null,
    cancels: new Map(),
    activeCount: () => 0,
  }
  server = createServer((req, res) => { void panelHandler(runtime)(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  await fixture.close()
})

const post = (action: string, body: unknown): Promise<Response> =>
  fetch(`${base}${PANEL_ROUTE_PREFIX}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('trust fence', () => {
  it('classifies addresses', () => {
    expect(isIPv4Loopback('127.0.0.1')).toBe(true)
    expect(isIPv4Loopback('127.9.9.9')).toBe(true)
    expect(isIPv4Loopback('128.0.0.1')).toBe(false)
    expect(isIPv4Loopback('127.0.0')).toBe(false)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('10.0.0.7')).toBe(false)
  })

  it('admits loopback and refuses an unpaired LAN browser', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const loopback = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }
    const lan = { socket: { remoteAddress: '10.0.0.5' }, headers: { host: '10.0.0.5:3080' } }
    const spoofed = { socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1:3080' } }
    expect(isTrustedRequest(ctx, loopback as never)).toBe(true)
    expect(isTrustedRequest(ctx, lan as never)).toBe(false)
    // A forwarded-looking Host header cannot promote a remote socket.
    expect(isTrustedRequest(ctx, spoofed as never)).toBe(false)
  })

  it('refuses a cross-site request even from loopback', () => {
    const ctx = { get: () => undefined } as unknown as Context
    const crossSite = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    }
    expect(isTrustedRequest(ctx, crossSite as never)).toBe(false)
  })

  it('admits a paired device when the pairing service answers', () => {
    const ctx = {
      get: () => ({ isPairedDevice: () => true }),
    } as unknown as Context
    const paired = { socket: { remoteAddress: '10.0.0.5' }, headers: { host: '10.0.0.5:3080' } }
    expect(isTrustedRequest(ctx, paired as never)).toBe(true)
  })

  it('refuses a remote request when the pairing service says no', () => {
    const ctx = { get: () => ({ isPairedDevice: () => false }) } as unknown as Context
    const remote = { socket: { remoteAddress: '10.0.0.5' }, headers: { host: '10.0.0.5:3080' } }
    expect(isTrustedRequest(ctx, remote as never)).toBe(false)
  })
})

describe('workbench API', () => {
  it('answers an overview with providers, tasks and a masked credential', async () => {
    const response = await fetch(`${base}${PANEL_ROUTE_PREFIX}/overview`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      ok: boolean
      providers: { id: string; credential: { configured: boolean; source: string | null; masked: string | null } }[]
      tasks: unknown[]
      usage: { tasks: number }
      active: number
    }
    expect(body.ok).toBe(true)
    expect(body.providers[0]?.id).toBe('fixture')
    // Loopback with no authRef is legitimately keyless, and no secret ever appears.
    expect(body.providers[0]?.credential).toEqual({ configured: true, source: 'none-loopback', masked: null, error: null })
    expect(Array.isArray(body.tasks)).toBe(true)
  })

  it('never leaks a credential value, only a masked tail', async () => {
    const keyed = { ...settingsFor(`${fixture.url}/api/v3`) }
    keyed.providers = [{ ...keyed.providers[0]!, authRef: 'ARK_API_KEY' }]
    const scoped: VideoForgeRuntime = { ...runtime, settings: () => keyed }
    process.env['ARK_API_KEY'] = 'sk-abcdefghijklmnop-1234'
    const scopedServer = createServer((req, res) => { void panelHandler(scoped)(req, res) })
    await new Promise<void>(resolve => scopedServer.listen(0, '127.0.0.1', resolve))
    const port = (scopedServer.address() as AddressInfo).port
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}${PANEL_ROUTE_PREFIX}/overview`)).json() as {
        providers: { credential: { masked: string | null; source: string | null } }[]
      }
      expect(body.providers[0]?.credential.masked).toBe('sk…1234')
      expect(JSON.stringify(body)).not.toContain('abcdefghijklmnop')
      expect(body.providers[0]?.credential.source).toBe('process-env')
    } finally {
      delete process.env['ARK_API_KEY']
      await new Promise<void>(resolve => { scopedServer.close(() => resolve()) })
    }
  })

  it('submits a generation through the same path the tools use', async () => {
    const before = fixture.requests.filter(entry => entry.method === 'POST').length
    const response = await post('generate', { prompt: 'a fox in snow' })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; task: { localId: string; status: string }; message: string }
    expect(body.ok).toBe(true)
    expect(body.task.status).toBe('queued')
    expect(body.message).toContain('do not re-submit')
    expect(fixture.requests.filter(entry => entry.method === 'POST').length).toBe(before + 1)
    expect(ledger.byId(body.task.localId)?.providerTaskId).toMatch(/^cgt-fixture-/)
  })

  it('rejects a malformed submission with a reason', async () => {
    expect((await post('generate', {})).status).toBe(400)
    expect(await (await post('generate', {})).json()).toMatchObject({ ok: false })
    const wrongType = await post('generate', { prompt: 'x', mode: 'nope' })
    expect(wrongType.status).toBe(400)
    expect((await wrongType.json() as { error: string }).error).toMatch(/mode must be one of/)
  })

  it('refuses a body that is not a JSON object', async () => {
    const response = await fetch(`${base}${PANEL_ROUTE_PREFIX}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    })
    expect(response.status).toBe(400)
  })

  it('reports an unknown action as 404 and a wrong method as 405', async () => {
    expect((await fetch(`${base}${PANEL_ROUTE_PREFIX}/nope`)).status).toBe(404)
    expect((await fetch(`${base}${PANEL_ROUTE_PREFIX}/generate`)).status).toBe(405)
  })

  it('cancels through the provider and exports an artifact', async () => {
    fixture.requests.length = 0
    const cancel = await post('cancel', { taskId: (await ledger.list())[0]?.localId })
    expect(cancel.status).toBe(200)

    // Seed a finished task with a real artifact, then export it.
    const artifactPath = join(ledger.home, 'clip.mp4')
    await writeFile(artifactPath, 'video-bytes')
    const seeded = await ledger.add(taskRow('v-20261013-0500'))
    await ledger.update(seeded.localId, current => ({
      ...current,
      status: 'succeeded',
      artifacts: [{
        path: artifactPath, bytes: 11, mime: 'video/mp4', width: null, height: null, durationSec: null,
        token: 'a'.repeat(32), createdAt: new Date().toISOString(),
      }],
    }))
    const target = join(ledger.home, 'exported.mp4')
    const exported = await post('export', { taskId: seeded.localId, targetPath: target })
    expect(exported.status).toBe(200)
    expect((await exported.json() as { bytes: number }).bytes).toBe(11)
    expect((await stat(target)).size).toBe(11)

    // A second export refuses to clobber, and a relative path is refused outright.
    expect((await post('export', { taskId: seeded.localId, targetPath: target })).status).toBe(400)
    expect((await post('export', { taskId: seeded.localId, targetPath: 'relative.mp4' })).status).toBe(400)
  })

  it('refuses a request from a remote socket with 403', async () => {
    const handler = panelHandler(runtime)
    const response = await new Promise<{ status: number; body: string }>((resolve) => {
      const fake = {
        method: 'GET',
        url: `${PANEL_ROUTE_PREFIX}/overview`,
        headers: { host: '10.0.0.5:3080' },
        socket: { remoteAddress: '10.0.0.5' },
      }
      const sink = {
        statusCode: 0,
        writeHead(status: number) { sink.statusCode = status; return sink },
        end(text?: string) { resolve({ status: sink.statusCode, body: text ?? '' }) },
        setHeader() { return sink },
      }
      void handler(fake as never, sink as never)
    })
    expect(response.status).toBe(403)
    expect(response.body).toContain('loopback-only')
  })
})
