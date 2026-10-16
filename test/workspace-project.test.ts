/**
 * M3.2 (DESIGN §17): the workspace is the project. The manifest is read and
 * validated; where the artifact goes is decided before anything is paid for;
 * the finished video lands at `renders/<shot>/vNNN.mp4` with a description
 * file; and the media route plays it only while it is still the file written.
 *
 * Driven against the fixture provider over a real socket, through the same
 * `generate`, watch and delivery the plugin runs, with a host-backed `ctx.fs`.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { deliverArtifact, publish } from '../src/destination.ts'
import { Ledger, parseDocument } from '../src/ledger.ts'
import { mediaHandler } from '../src/media-route.ts'
import { generate, listTasks } from '../src/operations.ts'
import { retryOrphans } from '../src/reconcile.ts'
import { DEFAULT_PATHS, ManifestError, parseManifest, readProject } from '../src/project.ts'
import { adapterFor } from '../src/providers/index.ts'
import { artifactUrl, type VideoForgeRuntime } from '../src/runtime.ts'
import type { SandboxMode, TaskSession } from '../src/session-context.ts'
import { ConfigError, DEFAULT_ENDPOINTS, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { VideoArtifact, VideoTask } from '../src/types.ts'
import { startInProcessWatch } from '../src/watch.ts'
import { hostWorkspaceFs, type WorkspaceFs } from '../src/workspace-fs.ts'

const MODEL = {
  id: 'doubao-seedance-fixture',
  label: '',
  modes: ['t2v', 'i2v'] as const,
  durations: [] as readonly number[],
  resolutions: ['480p', '720p'] as readonly string[],
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

function settingsFor(fake: Fixture): VideoForgeSettings {
  const provider: ProviderSetting = { id: 'ark', protocol: 'ark-seedance', baseUrl: `${fake.url}/api/v3`, authRef: '', models: [MODEL], endpoints: DEFAULT_ENDPOINTS }
  return {
    enabled: true,
    providers: [provider],
    defaultProvider: 'ark',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 10,
    waitSecondsMax: 600,
    dedupeWindowSeconds: 0,
    maxConcurrent: 8,
    maxTasks: 200,
    maxGiB: 20,
    requestTimeoutMs: 30_000,
  }
}

interface Host {
  fs?: WorkspaceFs | undefined
  /** What the sandbox policy answers for a live session; undefined mounts no policy. */
  liveMode?: SandboxMode | undefined
  /** Session ids the host has loaded. */
  live?: string[]
}

function contextFor(host: Host): Context {
  const services: Record<string, unknown> = {
    fs: host.fs,
    sandboxPolicy: host.liveMode === undefined ? undefined : { resolve: () => ({ mode: host.liveMode, workspaceRoot: '/' }) },
    agents: { get: (id: string) => (host.live?.includes(id) === true ? { id, session: { id } } : undefined) },
  }
  return { get: (name: string) => services[name] } as unknown as Context
}

/** A runtime whose watch runs in-process and delivers, as the plugin's does. */
function runtimeFor(settings: VideoForgeSettings, ledger: Ledger, host: Host): VideoForgeRuntime {
  const runtime: VideoForgeRuntime = {
    ctx: contextFor(host),
    ledger,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => settings,
    outputRoot: () => join(ledger.home, 'outputs'),
    outputDirectory: localId => join(ledger.home, 'outputs', localId),
    watchTask: (input) => {
      startInProcessWatch({
        ledger,
        adapter: adapterFor(input.provider, input.model),
        context: { baseUrl: input.baseUrl, apiKey: input.apiKey, fetch, signal: undefined },
        task: input.task,
        pollIntervalMs: 10,
        outputDirectory: runtime.outputDirectory(input.task.localId),
        deliver: (task, artifact, billing) => deliverArtifact(runtime, task, artifact, billing),
        logger: runtime.logger,
      })
      return null
    },
    cancels: new Map(),
    watching: new Set(),
    activeCount: () => 0,
  }
  return runtime
}

async function setup(host: Host = { fs: hostWorkspaceFs }, pollsBeforeDone = 1): Promise<{ fake: Fixture; ledger: Ledger; runtime: VideoForgeRuntime; workspace: string }> {
  const fake = await startFixture({ mode: 'ark', pollsBeforeDone })
  fixtures.push(fake)
  const ledger = new Ledger({ path: join(await mkdtemp(join(tmpdir(), 'video-forge-m32-home-')), 'tasks.json'), maxTasks: 100, maxGiB: 1 })
  await ledger.load()
  const workspace = await mkdtemp(join(tmpdir(), 'video-forge-m32-ws-'))
  return { fake, ledger, runtime: runtimeFor(settingsFor(fake), ledger, host), workspace }
}

const session = (cwd: string, mode: TaskSession['mode'] = 'workspace-write', id = 'session-1'): TaskSession => ({ id, cwd, mode })

async function settled(ledger: Ledger, localId: string): Promise<VideoTask> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const task = ledger.byId(localId)
    // The provider's `succeeded` is recorded before the download; settled means the artifact is in.
    if (task !== undefined && ((task.status === 'succeeded' && task.artifacts.length > 0) || task.status === 'failed' || task.status === 'orphaned')) return task
    if (Date.now() > deadline) throw new Error(`${localId} did not settle: ${JSON.stringify(task)}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const posts = (fake: Fixture): number => fake.requests.filter(entry => entry.method === 'POST').length

describe('the project manifest', () => {
  it('reads defaults, style, characters and directory mappings', () => {
    const manifest = parseManifest([
      'version: 1',
      'defaults: { provider: ark, model: m-1, resolution: 720p, aspect_ratio: "16:9", duration_seconds: 5 }',
      'style: warm film grain',
      'characters:',
      '  alice: { refs: [materials/alice/*.png], description: red scarf }',
      'paths: { renders: out/clips }',
    ].join('\n'))
    expect(manifest.defaults).toEqual({ provider: 'ark', model: 'm-1', resolution: '720p', aspectRatio: '16:9', durationSeconds: 5 })
    expect(manifest.style).toBe('warm film grain')
    expect(manifest.characters).toEqual({ alice: { refs: ['materials/alice/*.png'], description: 'red scarf' } })
    expect(manifest.paths).toEqual({ ...DEFAULT_PATHS, renders: 'out/clips' })
  })

  it('is the default layout when empty', () => {
    expect(parseManifest('').paths).toEqual(DEFAULT_PATHS)
  })

  it('refuses what it cannot use, naming the field', () => {
    expect(() => parseManifest('paths: [')).toThrowError(ManifestError)
    expect(() => parseManifest('version: 2')).toThrowError(/version 2 is not supported/)
    expect(() => parseManifest('paths: { renders: /abs/renders }')).toThrowError(/paths\.renders must be relative/)
    expect(() => parseManifest('paths: { renders: ../outside }')).toThrowError(/paths\.renders must stay inside the workspace/)
    expect(() => parseManifest('paths: { renders: "C:\\\\x" }')).toThrowError(/must be relative/)
    expect(() => parseManifest('defaults: { duration_seconds: -1 }')).toThrowError(/defaults\.duration_seconds must be a positive number/)
    expect(() => parseManifest('characters: { "bad name": {} }')).toThrowError(/character name "bad name"/)
    // It is a configuration error, so callers report it like one.
    expect(() => parseManifest('defaults: 3')).toThrowError(ConfigError)
  })

  it('is read through the filesystem service; a missing file is the default layout', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'video-forge-m32-manifest-'))
    expect(await readProject(hostWorkspaceFs, workspace)).toMatchObject({ exists: false })
    await writeFile(join(workspace, 'video-project.yaml'), 'paths: { renders: clips }\n')
    expect(await readProject(hostWorkspaceFs, workspace)).toMatchObject({ exists: true, manifest: { paths: { renders: 'clips' } } })
  })
})

describe('a generation from a workspace conversation', () => {
  it('lands at renders/<shot>/v001.mp4 with a description file, a manifest and a .gitignore', async () => {
    const { fake, ledger, runtime, workspace } = await setup()
    const outcome = await generate(runtime, { prompt: 'a lighthouse at dusk' }, { session: session(workspace) })
    expect(outcome.task.destination).toEqual({ kind: 'workspace', root: workspace, renders: 'renders', shot: 'untitled', writeManifest: true })

    const task = await settled(ledger, outcome.task.localId)
    expect(task.status).toBe('succeeded')
    const artifact = task.artifacts[0] as VideoArtifact
    const real = await realpath(workspace)
    expect(artifact.path).toBe(join(real, 'renders', 'untitled', 'v001.mp4'))
    expect(artifact.location).toEqual({ kind: 'workspace', root: workspace, relativePath: 'renders/untitled/v001.mp4', shot: 'untitled', version: 1, sidecar: 'renders/untitled/v001.json' })
    expect((await stat(artifact.path)).size).toBe(2048)

    const sidecar = JSON.parse(await readFile(join(workspace, 'renders', 'untitled', 'v001.json'), 'utf8')) as Record<string, unknown>
    expect(sidecar).toMatchObject({ generator: 'dsh-video-forge', file: 'v001.mp4', shot: 'untitled', take: 1, taskId: task.localId, prompt: 'a lighthouse at dusk', provider: 'ark', providerTaskId: task.providerTaskId })
    expect(await readFile(join(workspace, 'renders', '.gitignore'), 'utf8')).toBe('*\n')
    expect(await readFile(join(workspace, 'video-project.yaml'), 'utf8')).toMatch(/^version: 1$/m)

    // video_status tells the model where it is in its own terms.
    expect(listTasks(runtime, { taskId: task.localId }).tasks[0]?.artifactLocation).toBe('renders/untitled/v001.mp4 in the workspace')

    // The download was only a staging copy.
    await expect(stat(join(ledger.home, 'outputs', task.localId, `${task.localId}.mp4`))).rejects.toThrow()
    expect(posts(fake)).toBe(1)
  })

  it('takes the next version, never replaces a file, and leaves a manifest the user wrote alone', async () => {
    const { ledger, runtime, workspace } = await setup()
    const manifest = 'paths:\n  renders: clips\ndefaults:\n  resolution: 720p\n'
    await writeFile(join(workspace, 'video-project.yaml'), manifest)
    await mkdir(join(workspace, 'clips', 'opening'), { recursive: true })
    // A file the user put there by hand is a version number taken.
    await writeFile(join(workspace, 'clips', 'opening', 'v003.mp4'), 'mine')

    const first = await generate(runtime, { prompt: 'shot one', shot: 'opening' }, { session: session(workspace) })
    expect(first.task.destination).toMatchObject({ renders: 'clips', shot: 'opening', writeManifest: false })
    // The manifest's default filled what the request left out.
    expect(first.task.params.resolution).toBe('720p')
    const one = await settled(ledger, first.task.localId)
    expect(one.artifacts[0]?.location).toMatchObject({ relativePath: 'clips/opening/v004.mp4', version: 4 })

    const second = await generate(runtime, { prompt: 'shot one, brighter', shot: 'opening' }, { session: session(workspace) })
    const two = await settled(ledger, second.task.localId)
    expect(two.artifacts[0]?.location).toMatchObject({ relativePath: 'clips/opening/v005.mp4', version: 5 })

    expect(await readFile(join(workspace, 'clips', 'opening', 'v003.mp4'), 'utf8')).toBe('mine')
    expect(await readFile(join(workspace, 'video-project.yaml'), 'utf8')).toBe(manifest)
    await expect(stat(join(workspace, 'clips', '.gitignore'))).rejects.toThrow()
  })

  it('gives concurrent deliveries into one shot distinct versions, and never reissues a deleted one', async () => {
    const { ledger, runtime, workspace } = await setup()
    const outcomes = await Promise.all(['a', 'b', 'c'].map(async prompt => generate(runtime, { prompt, shot: 'race' }, { session: session(workspace) })))
    const tasks = await Promise.all(outcomes.map(async outcome => settled(ledger, outcome.task.localId)))
    const versions = tasks.map(task => (task.artifacts[0]?.location as { version: number }).version).sort()
    expect(versions).toEqual([1, 2, 3])

    // The user deletes the newest take; the next one still gets a fresh number.
    await rm(join(workspace, 'renders', 'race', 'v003.mp4'))
    await rm(join(workspace, 'renders', 'race', 'v003.json'))
    const next = await generate(runtime, { prompt: 'd', shot: 'race' }, { session: session(workspace) })
    expect((await settled(ledger, next.task.localId)).artifacts[0]?.location).toMatchObject({ version: 4 })
  })

  it('refuses a shot name that is not a plain folder name', async () => {
    const { fake, runtime, workspace } = await setup()
    await expect(generate(runtime, { prompt: 'x', shot: '../up' }, { session: session(workspace) })).rejects.toThrowError(/shot "\.\.\/up"/)
    expect(posts(fake)).toBe(0)
  })
})

describe('refused before anything is paid for', () => {
  it('a read-only conversation, or one whose mode the host could not name', async () => {
    const { fake, ledger, runtime, workspace } = await setup()
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace, 'read-only') }))
      .rejects.toThrowError(/read-only mode.*nothing was submitted and nothing was charged/)
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace, 'unknown') }))
      .rejects.toThrowError(/treats it as read-only/)
    expect(posts(fake)).toBe(0)
    expect(ledger.list()).toEqual([])
  })

  it('a workspace this machine cannot write (an SSH workspace)', async () => {
    const remote: WorkspaceFs = { ...hostWorkspaceFs, processPathFromHostPath: () => undefined }
    const { fake, ledger, runtime, workspace } = await setup({ fs: remote })
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) }))
      .rejects.toThrowError(/not on this machine.*nothing was submitted/)
    expect(posts(fake)).toBe(0)
    expect(ledger.list()).toEqual([])
  })

  it('a session call while the filesystem service is away', async () => {
    const { fake, runtime, workspace } = await setup({ fs: undefined })
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) })).rejects.toThrowError(/filesystem service is not available/)
    expect(posts(fake)).toBe(0)
  })

  it('a manifest that does not parse', async () => {
    const { fake, runtime, workspace } = await setup()
    await writeFile(join(workspace, 'video-project.yaml'), 'paths: [\n')
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) })).rejects.toThrowError(/video-project\.yaml: not valid YAML/)
    expect(posts(fake)).toBe(0)
  })

  it('a renders folder that is a symlink out of the workspace, under workspace-write', async () => {
    const { fake, runtime, workspace } = await setup()
    const elsewhere = await mkdtemp(join(tmpdir(), 'video-forge-m32-elsewhere-'))
    await symlink(elsewhere, join(workspace, 'renders'))
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) }))
      .rejects.toThrowError(/renders\/untitled resolves outside the workspace/)
    expect(posts(fake)).toBe(0)
  })

  it('but not under full access, where the user allowed writing anywhere', async () => {
    const { ledger, runtime, workspace } = await setup()
    const elsewhere = await mkdtemp(join(tmpdir(), 'video-forge-m32-elsewhere-'))
    await symlink(elsewhere, join(workspace, 'renders'))
    const outcome = await generate(runtime, { prompt: 'x' }, { session: session(workspace, 'danger-full-access') })
    const task = await settled(ledger, outcome.task.localId)
    expect(task.artifacts[0]?.path).toBe(join(await realpath(elsewhere), 'untitled', 'v001.mp4'))
  })
})

describe('when the workspace cannot take the video after all', () => {
  it('a call no session made keeps it in $DSH_HOME', async () => {
    const { ledger, runtime } = await setup()
    const outcome = await generate(runtime, { prompt: 'from no conversation' })
    const task = await settled(ledger, outcome.task.localId)
    expect(task.artifacts[0]?.path).toBe(join(ledger.home, 'outputs', task.localId, `${task.localId}.mp4`))
    expect(task.artifacts[0]?.location).toEqual({ kind: 'home', reason: 'it was not requested from a workspace conversation' })
    expect(listTasks(runtime, { taskId: task.localId }).tasks[0]?.artifactLocation).toMatch(/kept outside the workspace: it was not requested from a workspace conversation/)
  })

  it('a conversation made read-only after submitting keeps it in $DSH_HOME, saying why', async () => {
    const { ledger, runtime, workspace } = await setup({ fs: hostWorkspaceFs, liveMode: 'read-only', live: ['session-1'] })
    // The task was submitted while the session could write.
    const outcome = await generate(runtime, { prompt: 'tightened later' }, { session: session(workspace) })
    const task = await settled(ledger, outcome.task.localId)
    expect(task.status).toBe('succeeded')
    expect(task.artifacts[0]?.location).toMatchObject({ kind: 'home', reason: expect.stringMatching(/became read-only after the task was submitted/) as unknown })
    expect((await stat(task.artifacts[0]?.path ?? '')).size).toBe(2048)
    await expect(stat(join(workspace, 'renders'))).rejects.toThrow()
  })

  it('a write that fails keeps it in $DSH_HOME, with the failure as the reason', async () => {
    const { ledger, runtime, workspace } = await setup()
    const outcome = await generate(runtime, { prompt: 'blocked' }, { session: session(workspace) })
    await settled(ledger, outcome.task.localId)
    // Between submitting and delivering, something took the place of the shot folder.
    await rm(join(workspace, 'renders'), { recursive: true })
    await writeFile(join(workspace, 'renders'), 'not a folder')
    const staged = join(ledger.home, 'staged.mp4')
    await writeFile(staged, 'bytes')
    const artifact: VideoArtifact = { path: staged, bytes: 5, mime: 'video/mp4', width: null, height: null, durationSec: null, token: 't', createdAt: new Date().toISOString() }
    const delivered = await deliverArtifact(runtime, outcome.task, artifact, null)
    expect(delivered.path).toBe(staged)
    expect(delivered.location).toMatchObject({ kind: 'home', reason: expect.stringMatching(/writing into the workspace failed/) as unknown })
    expect(await readFile(staged, 'utf8')).toBe('bytes')
  })

  it('and a renders path that is a file is refused before submitting', async () => {
    const { fake, runtime, workspace } = await setup()
    await writeFile(join(workspace, 'renders'), 'not a folder')
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) })).rejects.toThrowError(/is in the way of renders\/untitled/)
    expect(posts(fake)).toBe(0)
  })
})

describe('playing a workspace video', () => {
  async function serve(ledger: Ledger): Promise<{ base: string; server: Server }> {
    const server = createServer((req, res) => { void mediaHandler(ledger)(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }
  }

  it('serves it with ranges while it is in place; 410 once moved; 403 once swapped for a link', async () => {
    const { ledger, runtime, workspace } = await setup()
    const outcome = await generate(runtime, { prompt: 'to be played' }, { session: session(workspace) })
    const task = await settled(ledger, outcome.task.localId)
    const artifact = task.artifacts[0] as VideoArtifact
    const { base, server } = await serve(ledger)
    try {
      const url = `${base}${artifactUrl(task, artifact)}`
      const ranged = await fetch(url, { headers: { range: 'bytes=0-9' } })
      expect(ranged.status).toBe(206)
      expect((await ranged.arrayBuffer()).byteLength).toBe(10)

      const elsewhere = await mkdtemp(join(tmpdir(), 'video-forge-m32-swap-'))
      await writeFile(join(elsewhere, 'secret.mp4'), 'not the video')
      await rm(artifact.path)
      await symlink(join(elsewhere, 'secret.mp4'), artifact.path)
      expect((await fetch(url)).status).toBe(403)

      // A directory above it swapped for a link is refused too.
      await rm(artifact.path)
      const shotDir = join(workspace, 'renders', 'untitled')
      await rm(shotDir, { recursive: true })
      await mkdir(join(elsewhere, 'untitled'))
      await writeFile(join(elsewhere, 'untitled', 'v001.mp4'), 'decoy')
      await symlink(join(elsewhere, 'untitled'), shotDir)
      expect((await fetch(url)).status).toBe(403)

      await rm(shotDir)
      const gone = await fetch(url)
      expect(gone.status).toBe(410)
      expect(await gone.text()).toMatch(/moved or deleted/)
    } finally {
      server.close()
    }
  })
})

describe('the stored destination', () => {
  const now = new Date().toISOString()
  const row = (over: Record<string, unknown>): unknown => ({
    localId: 'v-1', provider: 'ark', protocol: 'ark-seedance', model: 'm', providerTaskId: 'cgt-1', status: 'succeeded', progress: 1,
    submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
    params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
    artifacts: [], error: null, ...over,
  })
  const artifact = (location: unknown): unknown => ({ path: '/ws/renders/a/v001.mp4', bytes: 1, mime: 'video/mp4', width: null, height: null, durationSec: null, token: 't', createdAt: now, location })

  it('is kept when well formed; an unreadable one becomes $DSH_HOME, said so; an unreadable location is dropped', () => {
    const good = { kind: 'workspace', root: '/ws', renders: 'renders', shot: 'a', writeManifest: false }
    const place = { kind: 'workspace', root: '/ws', relativePath: 'renders/a/v001.mp4', shot: 'a', version: 1, sidecar: null }
    const doc = parseDocument(JSON.stringify({ version: 1, tasks: [
      row({ destination: good, artifacts: [artifact(place)] }),
      row({ destination: { kind: 'workspace', root: '/ws' }, artifacts: [artifact({ kind: 'workspace', version: 0 })] }),
    ] }))
    expect(doc.tasks[0]?.destination).toEqual(good)
    expect(doc.tasks[0]?.artifacts[0]?.location).toEqual(place)
    expect(doc.tasks[1]?.destination).toEqual({ kind: 'home', reason: 'the recorded destination could not be read' })
    expect(doc.tasks[1]?.artifacts[0]).not.toHaveProperty('location')
  })
})

describe('the default shot folder', () => {
  it('lists only what the plugin wrote', async () => {
    const { ledger, runtime, workspace } = await setup()
    const outcome = await generate(runtime, { prompt: 'tidy' }, { session: session(workspace) })
    await settled(ledger, outcome.task.localId)
    expect((await readdir(join(workspace, 'renders', 'untitled'))).sort()).toEqual(['v001.json', 'v001.last.jpg', 'v001.mp4'])
  })
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3])

describe('review fixes (M3.2 round 1)', () => {
  it('a filesystem without hard links still never replaces a published take', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-forge-m32-nolink-'))
    const noLinks = async (): Promise<void> => { throw Object.assign(new Error('no hard links'), { code: 'EPERM' }) }
    await writeFile(join(dir, 'a.part'), 'A')
    await writeFile(join(dir, 'b.part'), 'B')
    const results = await Promise.all([
      publish(join(dir, 'a.part'), join(dir, 'v001.mp4'), noLinks),
      publish(join(dir, 'b.part'), join(dir, 'v001.mp4'), noLinks),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results[0] === true ? 'A' : 'B'
    expect(await readFile(join(dir, 'v001.mp4'), 'utf8')).toBe(winner)
    // And with real links an existing name is simply refused.
    await writeFile(join(dir, 'c.part'), 'C')
    expect(await publish(join(dir, 'c.part'), join(dir, 'v001.mp4'), link)).toBe(false)
    expect(await readFile(join(dir, 'v001.mp4'), 'utf8')).toBe(winner)
  })

  it('a row whose session record was dropped is never written into the workspace', async () => {
    const { ledger, runtime, workspace } = await setup()
    const outcome = await generate(runtime, { prompt: 'session lost' }, { session: session(workspace) })
    await settled(ledger, outcome.task.localId)
    const { session: _dropped, ...task } = outcome.task
    const staged = join(ledger.home, 'staged.mp4')
    await writeFile(staged, 'bytes')
    const artifact: VideoArtifact = { path: staged, bytes: 5, mime: 'video/mp4', width: null, height: null, durationSec: null, token: 't', createdAt: new Date().toISOString() }
    const delivered = await deliverArtifact(runtime, task, artifact, null)
    expect(delivered.location).toMatchObject({ kind: 'home', reason: expect.stringMatching(/session record could not be read/) as unknown })
  })

  it('a typo inside a manifest section is refused, naming the known keys', () => {
    expect(() => parseManifest('paths: { render: clips }')).toThrowError(/paths has unknown key "render"; known keys are script, storyboard, materials, renders, cache/)
    expect(() => parseManifest('defaults: { duration: 5 }')).toThrowError(/defaults has unknown key "duration"/)
    expect(() => parseManifest('characters: { alice: { ref: [] } }')).toThrowError(/characters\.alice has unknown key "ref"/)
    // New top-level sections from a newer manifest are left alone.
    expect(parseManifest('version: 1\nfuture: {}').paths).toEqual(DEFAULT_PATHS)
  })

  it('a provider or model that came from the manifest is named as such when it is wrong', async () => {
    const { fake, runtime, workspace } = await setup()
    await writeFile(join(workspace, 'video-project.yaml'), 'defaults: { model: no-such-model }\n')
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) })).rejects.toThrowError(/model came from the defaults in video-project\.yaml/)
    expect(posts(fake)).toBe(0)
  })

  it('a dangling link or an unwritable folder in the way is refused before submitting', async () => {
    const { fake, runtime, workspace } = await setup()
    await symlink(join(workspace, 'nowhere'), join(workspace, 'renders'))
    await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) })).rejects.toThrowError(/link to something that does not exist/)
    await rm(join(workspace, 'renders'))
    await mkdir(join(workspace, 'renders'))
    await chmod(join(workspace, 'renders'), 0o555)
    try {
      await expect(generate(runtime, { prompt: 'x' }, { session: session(workspace) })).rejects.toThrowError(/is not writable/)
    } finally {
      await chmod(join(workspace, 'renders'), 0o755)
    }
    expect(posts(fake)).toBe(0)
  })

  it('a finished row whose artifact entry is unreadable is handed back to the retry, not forgotten', () => {
    const now = new Date().toISOString()
    const doc = parseDocument(JSON.stringify({ version: 1, tasks: [{
      localId: 'v-1', provider: 'ark', protocol: 'ark-seedance', model: 'm', providerTaskId: 'cgt-1', status: 'succeeded', progress: 1,
      submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
      params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [{ path: '/ws/renders/a/v001.mp4', bytes: '12', mime: 'video/mp4', token: 't' }], error: null,
      billing: { state: 'reported', tokens: 1, outputSeconds: null, fields: {}, settledAt: now },
    }] }))
    expect(doc.tasks[0]).toMatchObject({ status: 'orphaned', artifacts: [], error: { message: expect.stringMatching(/fetches it again, and it never re-submits it/) as unknown } })
  })

  it('an orphan recovered by the retry is delivered into its workspace too, once', async () => {
    const { fake, ledger, runtime, workspace } = await setup({ fs: hostWorkspaceFs }, 0)
    const created = await fetch(`${fake.url}/api/v3/contents/generations/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL.id }) })
    const providerTaskId = ((await created.json()) as { id: string }).id
    const now = new Date().toISOString()
    await ledger.add({
      localId: 'v-orphan-1', provider: 'ark', protocol: 'ark-seedance', model: MODEL.id, providerTaskId, status: 'orphaned', progress: null,
      submittedAt: now, updatedAt: now, paramsFingerprint: 'fp-orphan',
      params: { prompt: 'recovered', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [], error: { message: 'lost contact', code: null },
      session: session(workspace),
      destination: { kind: 'workspace', root: workspace, renders: 'renders', shot: 'kept', writeManifest: false },
    })
    await Promise.all([retryOrphans(runtime), retryOrphans(runtime)])
    const task = ledger.byId('v-orphan-1')
    expect(task?.status).toBe('succeeded')
    expect(task?.artifacts[0]?.location).toMatchObject({ kind: 'workspace', relativePath: 'renders/kept/v001.mp4' })
    expect((await readdir(join(workspace, 'renders', 'kept'))).sort()).toEqual(['v001.json', 'v001.mp4'])
    await expect(stat(join(ledger.home, 'outputs', 'v-orphan-1'))).rejects.toThrow()
    expect(runtime.watching.has('v-orphan-1')).toBe(false)
  })

  it('a description file names materials relative to the workspace, never by the user\'s home path', async () => {
    const { ledger, runtime, workspace } = await setup()
    await mkdir(join(workspace, 'materials'))
    await writeFile(join(workspace, 'materials', 'cat.png'), PNG)
    const outcome = await generate(runtime, { prompt: 'the cat turns', mode: 'i2v', firstFrame: 'materials/cat.png' }, { session: session(workspace) })
    await settled(ledger, outcome.task.localId)
    const sidecar = JSON.parse(await readFile(join(workspace, 'renders', 'untitled', 'v001.json'), 'utf8')) as { materials: { firstFrame: string } }
    expect(sidecar.materials.firstFrame).toMatch(/^path:materials\/cat\.png#sha256:[0-9a-f]+$/)
  })

  it('a FIFO put in the video\'s place is refused at once, not waited on', async () => {
    const { ledger, runtime, workspace } = await setup()
    const outcome = await generate(runtime, { prompt: 'piped' }, { session: session(workspace) })
    const task = await settled(ledger, outcome.task.localId)
    const artifact = task.artifacts[0] as VideoArtifact
    await rm(artifact.path)
    execFileSync('mkfifo', [artifact.path])
    const server = createServer((req, res) => { void mediaHandler(ledger)(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${artifactUrl(task, artifact)}`, { signal: AbortSignal.timeout(3_000) })
      expect(response.status).toBe(403)
    } finally {
      server.close()
    }
  })
})
