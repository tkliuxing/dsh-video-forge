/**
 * The teaching tool surface, offline: registration, argument and workspace
 * checks, and the plan report. Everything that spends money or spawns a process
 * lives in the live test (test/teach-live.test.ts); here the point is that a
 * call which should be refused never reaches that half.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import { DEFAULT_ENDPOINTS } from '../src/settings.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'
import { registerTeachTools } from '../src/teach/tools.ts'
import { buildSrt } from '../src/teach/subtitles.ts'
import type { Timings } from '../src/teach/storyboard.ts'

const definitions = new Map<string, ToolDefinition>()

interface Harness {
  cwd: string
  exec: ToolRunContext
  /** Change what the fake sandbox reports, or make the credentials service miss. */
  control: { mode: 'workspace-write' | 'read-only' | 'unknown', credentials: boolean, voiceKey: boolean }
}

async function harness(options: { mode?: 'workspace-write' | 'read-only' | 'unknown', credentials?: boolean, voiceKey?: boolean, files?: Record<string, string> } = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-tools-'))
  const control = {
    mode: options.mode ?? 'workspace-write' as const,
    credentials: options.credentials ?? true,
    voiceKey: options.voiceKey ?? true,
  }
  for (const [path, text] of Object.entries(options.files ?? {})) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), text, 'utf8')
  }
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition); return () => {} } },
    get: (name: string) => {
      if (name === 'fs') return hostWorkspaceFs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: control.mode, workspaceRoot: cwd }) }
      if (name === 'credentials') {
        return {
          resolve: async (ref: string) => {
            if (!control.credentials) throw new Error('unknown reference')
            if (!control.voiceKey) return undefined
            if (ref === 'ARK_VOICE_API_KEY') return { value: 'test-voice-key', source: 'test' }
            if (ref === 'DEEPSEEK_API_KEY') return { value: 'test-deepseek-key', source: 'test' }
            return undefined
          },
        }
      }
      return undefined
    },
  } as unknown as Context
  const home = await mkdtemp(join(tmpdir(), 'teach-ledger-'))
  const ledger = new Ledger({ path: join(home, 'tasks.json'), maxTasks: 200, maxGiB: 4 })
  await ledger.load()
  const runtime: VideoForgeRuntime = {
    ctx,
    ledger,
    selections: new SelectionStore({ path: join(home, 'selections.json') }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => ({
      enabled: true,
      providers: [],
      defaultProvider: '',
      defaultModel: '',
      outputDir: '',
      pollIntervalMs: 10,
      waitSecondsMax: 60,
      dedupeWindowSeconds: 120,
      maxConcurrent: 1,
      maxTasks: 200,
      maxGiB: 4,
      requestTimeoutMs: 30_000,
      priceTable: DEFAULT_PRICE_TABLE,
      priceSource: { url: '', refreshHours: 24, info: null },
    } as unknown as ReturnType<VideoForgeRuntime['settings']>),
    outputRoot: () => join(home, 'outputs'),
    outputDirectory: (localId: string) => join(home, 'outputs', localId),
    watchTask: () => null,
    cancels: new Map(),
    watching: new Set(),
  }
  registerTeachTools(runtime)
  const exec = { signal: AbortSignal.timeout(10_000), agent: { id: 'session-teach', session: { header: { cwd } } } } as unknown as ToolRunContext
  return { cwd, exec, control }
}

/**
 * A minimal cue-mode deck: the recorder's globals are what the plan now checks,
 * so a stub without them is refused before anything is spent.
 */
const DECK = '<section><div class="fragment">1</div></section><script>window.teachReady = true; window.teachCue = function (index) {}</script>'

/** The same, plus `teachPage`: what page mode (the default voice) needs. */
const PAGE_DECK = '<section><div class="fragment">1</div></section><script>window.teachReady = true; window.teachCue = function (index) {}; window.teachPage = function (index) {}</script>'

/** A manuscript on the default voice, i.e. one page per sentence. */
const PAGE_MANUSCRIPT = `meta:
  title: 页模式
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        say: 页模式下每句一页，句内按比例分步。
        cues:
          - { fragment: 1, at_progress: 0.5 }
`

const MANUSCRIPT = `meta:
  title: 部分和为什么收敛到 π²/6
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        say: 先看前几项完全平方数的倒数。
        cues:
          - { fragment: 1, at_word: 先看 }
`

const tool = (name: string): ToolDefinition => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

describe('teaching tools registration', () => {
  it('registers exactly the four video_teach_* tools', async () => {
    definitions.clear()
    await harness()
    expect([...definitions.keys()].sort()).toEqual([
      'video_teach_export',
      'video_teach_narrate',
      'video_teach_plan',
      'video_teach_render',
    ])
  })

  it('gives every tool a canonical output schema and a result presenter', async () => {
    definitions.clear()
    await harness()
    for (const name of definitions.keys()) {
      const definition = tool(name)
      expect(definition.output?.schema, `${name} has no output schema`).toBeDefined()
      expect(definition.description.length).toBeGreaterThan(80)
    }
  })
})

describe('video_teach_plan', () => {
  it('reports the sentence list, estimate and tool states without spending anything', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT, 'slides/s01/index.html': DECK } })
    const result = await tool('video_teach_plan').execute({}, exec) as Record<string, unknown>
    expect(result.title).toContain('π²/6')
    expect(result.sentences).toEqual([{ id: 's01-1', segment: 's01', engine: 'slides', chars: 14 }])
    expect(result.total_chars).toBe(14)
    expect(String(result.narration)).toContain('none')
    // The product the plan can report for free: whether this ffmpeg can burn.
    expect(String(result.message)).toContain('subtitles:')
    const dependencies = result.dependencies as { name: string, state: string }[]
    expect(dependencies.map(entry => entry.name)).toContain('ffmpeg')
    expect(dependencies.map(entry => entry.name)).toContain('subtitles')
    expect(dependencies.map(entry => entry.name)).toContain('ARK_VOICE_API_KEY')
  })

  it('reports a deck or scene the manuscript names but the project does not have', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT } })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/s01 \(slides\): slides\/s01\/index\.html/)
  })

  it('resolves deck and scene paths against the manuscript directory, not the workspace root', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'courses/pi/storyboard.yaml': MANUSCRIPT, 'courses/pi/slides/s01/index.html': DECK } })
    const result = await tool('video_teach_plan').execute({ storyboard: 'courses/pi/storyboard.yaml' }, exec) as Record<string, unknown>
    expect(result.title).toContain('π²/6')
  })

  it('names the line and the key of a broken manuscript', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': 'meta:\n  title: t\nsegments: []\n' } })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/line 3/)
  })

  it('says when there is no manuscript at all, instead of inventing one', async () => {
    definitions.clear()
    const { exec } = await harness()
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/no .*storyboard\.yaml in this workspace/)
  })

  it('refuses a cue that names a fragment the deck does not have', async () => {
    definitions.clear()
    const manuscript = MANUSCRIPT.replace('{ fragment: 1, at_word: 先看 }', '{ fragment: 3, at_word: 先看 }')
    const { exec } = await harness({
      files: {
        'storyboard.yaml': manuscript,
        'slides/s01/index.html': '<section><div class="fragment">1</div><div class="fragment">2</div></section><script>window.teachReady = true; window.teachCue = function (index) {}</script>',
      },
    })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/has 2 fragments/)
  })

  it('surfaces content warnings that name the sentence, without refusing', async () => {
    definitions.clear()
    const manuscript = MANUSCRIPT.replace('        cues:\n          - { fragment: 1, at_word: 先看 }\n', '')
    const { exec } = await harness({
      files: {
        'storyboard.yaml': manuscript,
        'slides/s01/index.html': '<section><div class="fragment">1</div></section><script>window.teachReady = true; window.teachCue = function (index) {}</script>',
      },
    })
    const result = await tool('video_teach_plan').execute({}, exec) as { warnings: string[], message: string }
    expect(result.warnings.some(w => w.includes('"s01-1"') && w.includes('has no cue'))).toBe(true)
    expect(result.message).toContain('rhythm:')
  })

  it('names the credential the manuscript actually uses, not the one the settings name', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': PAGE_MANUSCRIPT, 'slides/s01/index.html': PAGE_DECK } })
    const result = await tool('video_teach_plan').execute({}, exec) as { dependencies: { name: string, state: string }[], message: string }
    const names = result.dependencies.map(entry => entry.name)
    expect(names).toContain('DEEPSEEK_API_KEY')
    expect(names).not.toContain('ARK_VOICE_API_KEY')
    expect(result.message).toContain('DEEPSEEK_API_KEY configured')
  })

  it('reports an unresolved credential instead of taking the service call as success', async () => {
    definitions.clear()
    const { exec } = await harness({ voiceKey: false, files: { 'storyboard.yaml': PAGE_MANUSCRIPT, 'slides/s01/index.html': PAGE_DECK } })
    delete process.env.DEEPSEEK_API_KEY
    const result = await tool('video_teach_plan').execute({}, exec) as { dependencies: { name: string, state: string }[], message: string }
    expect(result.dependencies.find(entry => entry.name === 'DEEPSEEK_API_KEY')?.state).toBe('unresolved')
    expect(result.message).toContain('DEEPSEEK_API_KEY unresolved')
  })

  it('refuses a page-mode deck with no teachPage before narrating, naming the two ways out', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': PAGE_MANUSCRIPT, 'slides/s01/index.html': DECK } })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/teachPage[\s\S]*volcengine/)
  })

  it('describes page mode as beats inside a page, not as "nothing changes inside a sentence"', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': PAGE_MANUSCRIPT, 'slides/s01/index.html': PAGE_DECK } })
    const result = await tool('video_teach_plan').execute({}, exec) as { message: string, warnings: string[] }
    expect(result.message).toContain('at_progress')
    expect(result.message).not.toContain('nothing changes inside a sentence')
    expect(result.warnings.some(warning => warning.includes('cannot fire'))).toBe(false)
  })

  it('reports a stale narration when the manuscript no longer matches timings.json', async () => {
    definitions.clear()
    const timings = {
      voice: { provider: 'volcengine', speaker: 'zh_female_liuchangnv_uranus_bigtts', speedRatio: null },
      sentences: [{ id: 'gone', text: '旧句子。', audio: 'audio/gone.mp3', durationMs: 1200, words: [{ t: '旧', b: 0, e: 300 }] }],
    }
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT, 'slides/s01/index.html': DECK, 'timings.json': JSON.stringify(timings) } })
    const result = await tool('video_teach_plan').execute({}, exec) as Record<string, unknown>
    expect(String(result.narration)).toContain('stale')
    expect(String(result.narration)).toContain('gone')
  })
})

describe('workspace and permission refusals', () => {
  it('refuses a read-only conversation before doing any work', async () => {
    definitions.clear()
    const { exec } = await harness({ mode: 'read-only', files: { 'storyboard.yaml': MANUSCRIPT } })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/read-only mode/)
  })

  it('refuses an unknown permission mode rather than assuming writes are allowed', async () => {
    definitions.clear()
    const { exec } = await harness({ mode: 'unknown', files: { 'storyboard.yaml': MANUSCRIPT } })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/treats it as read-only/)
  })

  it('refuses a storyboard path that leaves the workspace', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT } })
    await expect(tool('video_teach_plan').execute({ storyboard: '../elsewhere.yaml' }, exec)).rejects.toThrow(/workspace-relative/)
  })

  it('refuses to narrate without a voice credential, naming the reference to set', async () => {
    definitions.clear()
    const { exec } = await harness({ credentials: false, voiceKey: false, files: { 'storyboard.yaml': MANUSCRIPT } })
    delete process.env.ARK_VOICE_API_KEY
    await expect(tool('video_teach_narrate').execute({}, exec)).rejects.toThrow(/ARK_VOICE_API_KEY/)
  })

  it('refuses to narrate an unknown sentence id', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT } })
    await expect(tool('video_teach_narrate').execute({ sentences: ['s99-9'] }, exec)).rejects.toThrow(/no such sentence: "s99-9"/)
  })

  it('refuses to render before anything was narrated', async () => {
    definitions.clear()
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT } })
    await expect(tool('video_teach_render').execute({}, exec)).rejects.toThrow(/run video_teach_narrate first/)
  })

  it('refuses to export when there is no finished video', async () => {
    definitions.clear()
    const timings = {
      voice: { provider: 'volcengine', speaker: 'zh_female_liuchangnv_uranus_bigtts', speedRatio: null },
      sentences: [{ id: 's01-1', text: '先看前几项完全平方数的倒数。', audio: 'audio/s01-1.mp3', durationMs: 2400, words: [{ t: '先看', b: 0, e: 400 }] }],
    }
    const { exec } = await harness({ files: { 'storyboard.yaml': MANUSCRIPT, 'timings.json': JSON.stringify(timings) } })
    await expect(tool('video_teach_export').execute({}, exec)).rejects.toThrow(/no finished video/)
  })
})

describe('srt building', () => {
  const timings: Timings = {
    voice: { provider: 'volcengine', speaker: 'voice', speedRatio: null },
    sentences: [
      {
        id: 'a',
        text: '第一句。',
        audio: 'audio/a.mp3',
        durationMs: 2000,
        words: [
          { t: '先', b: 0, e: 200 },
          { t: '看', b: 200, e: 400 },
          { t: '第一句', b: 400, e: 900 },
        ],
      },
      {
        id: 'b',
        text: '第二句。',
        audio: 'audio/b.mp3',
        durationMs: 1500,
        words: [{ t: '其', b: 0, e: 250 }, { t: '实', b: 250, e: 500 }],
      },
    ],
  }

  it('times cues from the words and offsets each sentence by the audio before it', () => {
    // A 3-character cue width splits the first sentence after "先看".
    const srt = buildSrt(timings, 3)
    expect(srt).toContain('00:00:00,000 --> 00:00:00,400')
    expect(srt).toContain('00:00:00,400 --> 00:00:00,900')
    // The second sentence starts after the first sentence's real duration (2000 ms).
    expect(srt).toContain('00:00:02,000 --> 00:00:02,500')
    expect(srt).toContain('其实')
    expect(srt.trim().split('\n\n')).toHaveLength(3)
  })
})
