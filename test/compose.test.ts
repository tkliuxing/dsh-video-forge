/**
 * M3.3 (DESIGN §17): `video_generate` shapes the request itself — `from`
 * continues a take from its last frame (ARK `return_last_frame`), registered
 * characters bring their descriptions and reference images, and the project
 * style is added to every prompt. Driven against the fixture provider over a
 * real socket, through `generate`, the watch and delivery.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { startFixture, type Fixture } from '../fixtures/provider.ts'
import { deliverArtifact } from '../src/destination.ts'
import { Ledger, parseDocument } from '../src/ledger.ts'
import { downloadArtifact } from '../src/download.ts'
import { describeSetup, generate } from '../src/operations.ts'
import { buildArkBody, readArkState } from '../src/providers/ark-seedance.ts'
import { adapterFor } from '../src/providers/index.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import type { TaskSession } from '../src/session-context.ts'
import { DEFAULT_ENDPOINTS, type ModelSetting, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoArtifact, VideoTask } from '../src/types.ts'
import { startInProcessWatch } from '../src/watch.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'

const MODEL: ModelSetting = {
  id: 'doubao-seedance-fixture',
  label: '',
  modes: ['t2v', 'i2v', 'flf2v', 's2v'],
  durations: [],
  resolutions: [],
  aspectRatios: [],
  sizes: [],
  cancelable: true,
  generateAudio: false,
  pollIntervalMs: 10,
  frameRoleFirst: 'first_frame',
  frameRoleLast: 'last_frame',
  frameRoleReference: 'reference_image',
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3])

const fixtures: Fixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async fixture => fixture.close()))
})

function settingsFor(fake: Fixture, model: ModelSetting = MODEL): VideoForgeSettings {
  const provider: ProviderSetting = { id: 'ark', protocol: 'ark-seedance', baseUrl: `${fake.url}/api/v3`, authRef: '', models: [model], endpoints: DEFAULT_ENDPOINTS }
  return {
    enabled: true, providers: [provider], defaultProvider: 'ark', defaultModel: '', outputDir: '', pollIntervalMs: 10,
    waitSecondsMax: 600, dedupeWindowSeconds: 0, maxConcurrent: 8, maxTasks: 200, maxGiB: 20, requestTimeoutMs: 30_000, priceTable: DEFAULT_PRICE_TABLE,
  }
}

function runtimeFor(settings: VideoForgeSettings, ledger: Ledger): VideoForgeRuntime {
  const runtime: VideoForgeRuntime = {
    ctx: { get: (name: string) => (name === 'fs' ? hostWorkspaceFs : undefined) } as unknown as Context,
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
  }
  return runtime
}

async function setup(model: ModelSetting = MODEL, fixtureOptions: Partial<Parameters<typeof startFixture>[0]> = {}): Promise<{ fake: Fixture; ledger: Ledger; runtime: VideoForgeRuntime; workspace: string; session: TaskSession }> {
  const fake = await startFixture({ mode: 'ark', pollsBeforeDone: 1, ...fixtureOptions })
  fixtures.push(fake)
  const ledger = new Ledger({ path: join(await mkdtemp(join(tmpdir(), 'video-forge-m33-home-')), 'tasks.json'), maxTasks: 100, maxGiB: 1 })
  await ledger.load()
  const workspace = await mkdtemp(join(tmpdir(), 'video-forge-m33-ws-'))
  return { fake, ledger, runtime: runtimeFor(settingsFor(fake, model), ledger), workspace, session: { id: 'session-1', cwd: workspace, mode: 'workspace-write' } }
}

async function settled(ledger: Ledger, localId: string): Promise<VideoTask> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const task = ledger.byId(localId)
    if (task !== undefined && ((task.status === 'succeeded' && task.artifacts.length > 0) || task.status === 'failed' || task.status === 'orphaned')) return task
    if (Date.now() > deadline) throw new Error(`${localId} did not settle: ${JSON.stringify(task)}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The create bodies the fixture received, in order. */
function submissions(fake: Fixture): { content: { type: string; text?: string; role?: string; image_url?: { url: string } }[]; return_last_frame?: boolean }[] {
  return fake.requests.filter(entry => entry.method === 'POST').map(entry => JSON.parse(entry.body) as never)
}

describe('ARK last frames', () => {
  it('are always asked for, and read only from a finished task', () => {
    const body = buildArkBody({ model: 'm', prompt: 'p', mode: 't2v', firstFrame: null, lastFrame: null, referenceImages: [], durationSeconds: null, resolution: null, aspectRatio: null, generateAudio: null }, { roles: { first: 'first_frame', last: 'last_frame', reference: 'reference_image' }, watermark: false, generateAudio: false })
    expect(body.return_last_frame).toBe(true)
    expect(readArkState({ status: 'succeeded', content: { video_url: 'https://v', last_frame_url: 'https://f' } }).lastFrameUrl).toBe('https://f')
    expect(readArkState({ status: 'running', content: { last_frame_url: 'https://f' } }).lastFrameUrl).toBeNull()
  })

  it('land beside the take as vNNN.last.jpg and are named in its description file', async () => {
    const { ledger, runtime, workspace, session } = await setup()
    const outcome = await generate(runtime, { prompt: 'a door opens', shot: 'door' }, { session })
    const task = await settled(ledger, outcome.task.localId)
    expect(task.artifacts[0]?.lastFrame).toMatchObject({ mime: 'image/jpeg', path: expect.stringMatching(/renders\/door\/v001\.last\.jpg$/) as unknown })
    const sidecar = JSON.parse(await readFile(join(workspace, 'renders', 'door', 'v001.json'), 'utf8')) as { lastFrame: string; from: unknown }
    expect(sidecar.lastFrame).toBe('v001.last.jpg')
    expect(sidecar.from).toBeNull()
  })
})

describe('from: continuing a take', () => {
  it('sends the last frame as the first frame, in the same shot, by task id or by path', async () => {
    const { fake, ledger, runtime, workspace, session } = await setup()
    const first = await settled(ledger, (await generate(runtime, { prompt: 'a door opens', shot: 'door' }, { session })).task.localId)

    const byId = await generate(runtime, { prompt: 'she walks through', from: first.localId }, { session })
    expect(byId.task.params).toMatchObject({ mode: 'i2v', from: first.localId, firstFrame: expect.stringMatching(/^path:.*v001\.last\.jpg#sha256:/) as unknown })
    expect(byId.task.destination).toMatchObject({ shot: 'door' })
    const sent = submissions(fake)[1]
    expect(sent?.content.find(part => part.role === 'first_frame')?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true)
    const second = await settled(ledger, byId.task.localId)
    expect(second.artifacts[0]?.location).toMatchObject({ relativePath: 'renders/door/v002.mp4' })
    const sidecar = JSON.parse(await readFile(join(workspace, 'renders', 'door', 'v002.json'), 'utf8')) as { from: string }
    expect(sidecar.from).toBe(first.localId)

    // The video's path works as well, and a named shot wins over the inherited one.
    const byPath = await generate(runtime, { prompt: 'the hall beyond', from: 'renders/door/v002.mp4', shot: 'hall' }, { session })
    expect(byPath.task.params.from).toBe(second.localId)
    expect(byPath.task.destination).toMatchObject({ shot: 'hall' })
  })

  it('refuses what it cannot continue, before anything is sent', async () => {
    const { fake, ledger, runtime, session } = await setup()
    const first = await settled(ledger, (await generate(runtime, { prompt: 'a door opens' }, { session })).task.localId)
    const posts = (): number => fake.requests.filter(entry => entry.method === 'POST').length
    const before = posts()

    await expect(generate(runtime, { prompt: 'x', from: first.localId, firstFrame: 'a.png' }, { session })).rejects.toThrowError(/do not also pass first_frame/)
    await expect(generate(runtime, { prompt: 'x', from: first.localId, mode: 't2v' }, { session })).rejects.toThrowError(/needs mode i2v/)
    await expect(generate(runtime, { prompt: 'x', from: 'v-nope' }, { session })).rejects.toThrowError(/from must name an earlier take/)

    const now = new Date().toISOString()
    const { lastFrame: _frame, ...done } = first.artifacts[0] as VideoArtifact
    await ledger.add({ ...first, localId: 'v-mm-1', provider: 'minimax', protocol: 'minimax-video', paramsFingerprint: 'mm', submittedAt: now, artifacts: [{ ...done, token: 'a'.repeat(32) }] })
    await expect(generate(runtime, { prompt: 'x', from: 'v-mm-1' }, { session })).rejects.toThrowError(/does not return the video's last frame/)
    await ledger.add({ ...first, localId: 'v-old-1', paramsFingerprint: 'old', submittedAt: now, artifacts: [{ ...done, token: 'b'.repeat(32) }] })
    await expect(generate(runtime, { prompt: 'x', from: 'v-old-1' }, { session })).rejects.toThrowError(/has no recorded last frame/)
    await ledger.add({ ...first, localId: 'v-run-1', status: 'running', paramsFingerprint: 'run', submittedAt: now, artifacts: [] })
    await expect(generate(runtime, { prompt: 'x', from: 'v-run-1' }, { session })).rejects.toThrowError(/only a finished take can be continued/)

    expect(posts()).toBe(before)
  })
})

describe('characters and the project style', () => {
  async function project(workspace: string): Promise<void> {
    await mkdir(join(workspace, 'materials', 'alice'), { recursive: true })
    await writeFile(join(workspace, 'materials', 'alice', 'front.png'), PNG)
    await writeFile(join(workspace, 'materials', 'alice', 'side.png'), PNG)
    await writeFile(join(workspace, 'materials', 'alice', 'notes.txt'), 'not a ref')
    await writeFile(join(workspace, 'video-project.yaml'), [
      'style: warm film grain',
      'characters:',
      '  alice: { refs: [materials/alice/*.png], description: "red scarf, short black hair" }',
      '  bob: { description: "tall, grey coat" }',
      '  ghost: { refs: [materials/ghost/*.png] }',
    ].join('\n'))
  }

  it('bring descriptions and reference images; the style goes into every prompt', async () => {
    const { fake, runtime, workspace, session } = await setup()
    await project(workspace)
    const outcome = await generate(runtime, { prompt: 'alice waves', characters: ['alice', 'bob'] }, { session })
    expect(outcome.task.params).toMatchObject({ prompt: 'alice waves', mode: 's2v', characters: ['alice', 'bob'], style: 'warm film grain' })
    expect(outcome.task.params.sentPrompt).toBe('alice waves\n\nCharacters:\n- alice: red scarf, short black hair\n- bob: tall, grey coat\n\nStyle: warm film grain')
    expect(outcome.task.params.referenceImages).toEqual([
      expect.stringMatching(/^path:materials\/alice\/front\.png#|front\.png#/) as unknown,
      expect.stringMatching(/side\.png#/) as unknown,
    ])
    const sent = submissions(fake)[0]
    expect(sent?.content[0]?.text).toBe(outcome.task.params.sentPrompt)
    expect(sent?.content.filter(part => part.role === 'reference_image')).toHaveLength(2)

    // Without characters the style alone is added.
    const plain = await generate(runtime, { prompt: 'an empty street' }, { session })
    expect(plain.task.params.sentPrompt).toBe('an empty street\n\nStyle: warm film grain')
  })

  it('in a mode without reference images, send only the descriptions and say so', async () => {
    const { fake, runtime, workspace, session } = await setup()
    await project(workspace)
    const outcome = await generate(runtime, { prompt: 'alice waves', mode: 't2v', characters: ['alice'] }, { session })
    expect(outcome.message).toMatch(/reference images of alice were not sent: mode t2v takes no reference images/)
    expect(submissions(fake)[0]?.content.filter(part => part.role === 'reference_image')).toHaveLength(0)
  })

  it('refuse an unknown name, a pattern that matches nothing, and a model without s2v', async () => {
    const { fake, runtime, workspace, session } = await setup({ ...MODEL, modes: ['t2v', 'i2v'] })
    await project(workspace)
    await expect(generate(runtime, { prompt: 'x', characters: ['carol'] }, { session })).rejects.toThrowError(/no character "carol" in video-project\.yaml; registered: alice, bob, ghost/)
    await expect(generate(runtime, { prompt: 'x', characters: ['ghost'] }, { session })).rejects.toThrowError(/characters\.ghost\.refs: "materials\/ghost\/\*\.png" matches no file/)
    await expect(generate(runtime, { prompt: 'x', characters: ['alice'] }, { session })).rejects.toThrowError(/need mode s2v, which model "doubao-seedance-fixture" does not support; pass mode t2v/)
    // A character with no references needs no s2v.
    await expect(generate(runtime, { prompt: 'x', characters: ['bob'] }, { session })).resolves.toBeDefined()
    expect(fake.requests.filter(entry => entry.method === 'POST')).toHaveLength(1)
  })

  it('need a workspace', async () => {
    const { runtime } = await setup()
    await expect(generate(runtime, { prompt: 'x', characters: ['alice'] })).rejects.toThrowError(/this call has no workspace/)
  })
})

describe('the setup as video_status reports it', () => {
  it('names a broken manifest instead of failing', async () => {
    const { runtime, workspace, session } = await setup()
    await writeFile(join(workspace, 'video-project.yaml'), 'paths: { render: x }\n')
    const status = await describeSetup(runtime, session)
    expect(status.workspace).toMatchObject({ state: 'invalid-manifest', problem: expect.stringMatching(/paths has unknown key "render"/) as unknown })
    expect(status.providers[0]).toMatchObject({ id: 'ark', key: 'not required', continuable: true })
    expect((await describeSetup(runtime, null)).workspace.state).toBe('none')
  })
})

describe('review fixes (M3.3 round 1)', () => {
  it('an empty prompt is refused even when a style or characters would pad it', async () => {
    const { fake, runtime, workspace, session } = await setup()
    await writeFile(join(workspace, 'video-project.yaml'), 'style: warm film grain\ncharacters: { bob: { description: tall } }\n')
    await expect(generate(runtime, { prompt: '   ' }, { session })).rejects.toThrowError(/prompt must not be empty/)
    await expect(generate(runtime, { prompt: '', characters: ['bob'] }, { session })).rejects.toThrowError(/prompt must not be empty/)
    expect(fake.requests.filter(entry => entry.method === 'POST')).toHaveLength(0)
  })

  it('a glob skips hidden files, ignores case, merges with references given by hand, and is capped', async () => {
    const { fake, runtime, workspace, session } = await setup()
    const dir = join(workspace, 'materials', 'alice')
    await mkdir(dir, { recursive: true })
    for (const name of ['front.png', 'BACK.PNG', '._front.png', '.DS_Store']) await writeFile(join(dir, name), PNG)
    await writeFile(join(workspace, 'video-project.yaml'), 'characters: { alice: { refs: [materials/alice/*.png] }, crowd: { refs: [materials/crowd/*.png] } }\n')
    const outcome = await generate(runtime, { prompt: 'alice', mode: 's2v', referenceImages: ['materials/alice/front.png'], characters: ['alice'] }, { session })
    expect(outcome.task.params.referenceImages).toHaveLength(2)
    expect(outcome.task.params.referenceImages.join(' ')).toMatch(/BACK\.PNG/)
    expect(outcome.task.params.referenceImages.join(' ')).not.toMatch(/\._front/)

    await mkdir(join(workspace, 'materials', 'crowd'))
    for (let index = 0; index < 10; index += 1) await writeFile(join(workspace, 'materials', 'crowd', `p${index}.png`), PNG)
    const posts = fake.requests.filter(entry => entry.method === 'POST').length
    await expect(generate(runtime, { prompt: 'a crowd', characters: ['crowd'] }, { session })).rejects.toThrowError(/would send 10 reference images; providers take only a few \(at most 9\)/)
    // In a mode that sends no references the count does not matter.
    await expect(generate(runtime, { prompt: 'a crowd, described', mode: 't2v', characters: ['crowd'] }, { session })).resolves.toBeDefined()
    expect(fake.requests.filter(entry => entry.method === 'POST')).toHaveLength(posts + 1)
  })

  it('from with last_frame is flf2v; from with characters keeps i2v and says the references stayed home', async () => {
    const { fake, ledger, runtime, workspace, session } = await setup()
    await mkdir(join(workspace, 'materials', 'alice'), { recursive: true })
    await writeFile(join(workspace, 'materials', 'alice', 'front.png'), PNG)
    await writeFile(join(workspace, 'video-project.yaml'), 'characters: { alice: { refs: [materials/alice/front.png], description: red scarf } }\n')
    const first = await settled(ledger, (await generate(runtime, { prompt: 'a door opens' }, { session })).task.localId)

    const both = await generate(runtime, { prompt: 'to the window', from: first.localId, lastFrame: 'materials/alice/front.png' }, { session })
    expect(both.task.params.mode).toBe('flf2v')

    const withAlice = await generate(runtime, { prompt: 'alice steps in', from: first.localId, characters: ['alice'] }, { session })
    expect(withAlice.task.params.mode).toBe('i2v')
    expect(withAlice.message).toMatch(/reference images of alice were not sent: mode i2v/)
    expect(withAlice.task.params.sentPrompt).toMatch(/- alice: red scarf/)
    const sent = JSON.parse(fake.requests.filter(entry => entry.method === 'POST').at(-1)?.body ?? '{}') as { content: { role?: string }[] }
    expect(sent.content.filter(part => part.role === 'reference_image')).toHaveLength(0)
  })

  it('a model that does not know return_last_frame still gets the video, asked once more without it', async () => {
    const { fake, ledger, runtime, session } = await setup(MODEL, { rejectLastFrame: true })
    const outcome = await generate(runtime, { prompt: 'an old model' }, { session })
    const task = await settled(ledger, outcome.task.localId)
    expect(task.status).toBe('succeeded')
    expect(task.artifacts[0]?.lastFrame).toBeUndefined()
    const bodies = fake.requests.filter(entry => entry.method === 'POST').map(entry => JSON.parse(entry.body) as Record<string, unknown>)
    expect(bodies.map(body => 'return_last_frame' in body)).toEqual([true, false])
    expect(fake.created).toHaveLength(1)
  })

  it('a frame that is not an image is dropped and the video kept', async () => {
    const fake = await startFixture({ mode: 'ark' })
    fixtures.push(fake)
    const directory = await mkdtemp(join(tmpdir(), 'video-forge-m33-frame-'))
    // The fixture's artifact route serves video bytes, not an image.
    const artifact = await downloadArtifact({ url: `${fake.url}/artifact/a.mp4`, apiKey: null, directory, localId: 'v-f', fetch, lastFrameUrl: `${fake.url}/artifact/b.mp4` })
    expect(artifact.bytes).toBe(2048)
    expect(artifact.lastFrame).toBeUndefined()
    const missing = await downloadArtifact({ url: `${fake.url}/artifact/a.mp4`, apiKey: null, directory, localId: 'v-g', fetch, lastFrameUrl: 'http://127.0.0.1:1/nothing.jpg' })
    expect(missing.lastFrame).toBeUndefined()
  })

  it('a stored last frame the ledger cannot read is dropped, the row kept', () => {
    const now = new Date().toISOString()
    const doc = parseDocument(JSON.stringify({ version: 1, tasks: [{
      localId: 'v-1', provider: 'ark', protocol: 'ark-seedance', model: 'm', providerTaskId: 'cgt-1', status: 'succeeded', progress: 1,
      submittedAt: now, updatedAt: now, paramsFingerprint: 'fp',
      params: { prompt: 'x', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [{ path: '/ws/v001.mp4', bytes: 1, mime: 'video/mp4', token: 't', createdAt: now, lastFrame: { path: 7 } }], error: null,
    }] }))
    expect(doc.tasks[0]?.status).toBe('succeeded')
    expect(doc.tasks[0]?.artifacts[0]?.path).toBe('/ws/v001.mp4')
    expect(doc.tasks[0]?.artifacts[0]).not.toHaveProperty('lastFrame')
  })

  it('a character name that is an Object prototype member is just unknown', async () => {
    const { runtime, workspace, session } = await setup()
    await writeFile(join(workspace, 'video-project.yaml'), 'characters: { bob: { description: tall } }\n')
    await expect(generate(runtime, { prompt: 'x', characters: ['constructor'] }, { session })).rejects.toThrowError(/no character "constructor"/)
  })
})
