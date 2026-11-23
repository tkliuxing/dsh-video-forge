/**
 * Manim is optional (docs/TEACH-VIDEO.md §19).
 *
 * Two things are pinned here. First the decision itself: what is missing blocks a
 * manuscript only when that manuscript would run it, so a slides-only project is
 * never told to install Python, a TeX or dvisvgm. Second the timing of the
 * refusal: it happens in `video_teach_plan`/`video_teach_render` before anything
 * is rendered, not halfway through a render that already spent its slide work.
 *
 * The probe is injected rather than faked through the environment: no test can
 * uninstall ffmpeg or dvisvgm on demand, and a test that only works on a machine
 * missing those programs would be worthless.
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
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { assessDependencies, isMissing, type DependencyProbe } from '../src/teach/rules.ts'
import { registerTeachTools } from '../src/teach/tools.ts'
import { parseStoryboard } from '../src/teach/storyboard.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'

const SLIDES_ONLY = `meta:
  title: 纯幻灯片
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        say: 先看第一项。
        cues: [{ fragment: 1, at_word: 先看 }]
`

const WITH_MANIM = `meta:
  title: 带动画
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        say: 先看第一项。
        cues: [{ fragment: 1, at_word: 先看 }]
  - id: s02
    engine: manim
    scene: scenes/s02.py
    sentences:
      - id: s02-1
        say: 把它画成折线。
      - id: s02-2
        say: 折线趋近一条水平线。
`

const ALL_PRESENT: DependencyProbe = {
  ffmpeg: '/opt/homebrew/bin/ffmpeg',
  ffprobe: '/opt/homebrew/bin/ffprobe',
  chromium: 'playwright default lookup',
  python3: '/Users/x/.local/venvs/teach-video/bin/python3',
  manim: 'manim 0.22.1',
  latex: '/Library/TeX/texbin/latex',
  dvisvgm: '/Users/x/Library/TinyTeX/bin/universal-darwin/dvisvgm',
}

const NO_MANIM_TOOLS: DependencyProbe = {
  ...ALL_PRESENT,
  python3: 'missing',
  manim: 'not installed',
  latex: 'missing',
  dvisvgm: 'missing',
}

/** A cue-mode deck with the recorder's globals, so the deck audit has nothing to refuse. */
const CUE_DECK = '<section><div class="fragment">a</div></section><script>window.teachReady = true; window.teachCue = function (index) {}</script>'

describe('dependency tiers', () => {
  it('does not block a slides-only manuscript for a missing Manim toolchain', () => {
    const assessment = assessDependencies(parseStoryboard(SLIDES_ONLY), NO_MANIM_TOOLS)
    expect(assessment.needsManim).toBe(false)
    expect(assessment.blocking).toEqual([])
    expect(assessment.refusal).toBeNull()
    expect(assessment.summary).toContain('needs no Manim')
    // The states are still reported, so nobody wonders whether Manim is installed;
    // they are simply not treated as problems for this manuscript.
    const manim = assessment.entries.filter(entry => entry.scope === 'manim')
    expect(manim.map(entry => entry.name)).toEqual(['python3', 'manim', 'latex', 'dvisvgm'])
    expect(manim.every(entry => entry.blocking === false)).toBe(true)
    expect(manim.every(entry => entry.install === null)).toBe(true)
  })

  it('blocks a manuscript with a manim segment, naming only the missing manim programs', () => {
    const assessment = assessDependencies(parseStoryboard(WITH_MANIM), NO_MANIM_TOOLS)
    expect(assessment.needsManim).toBe(true)
    expect(assessment.blocking.sort()).toEqual(['dvisvgm', 'latex', 'manim', 'python3'])
    expect(assessment.summary).toContain('s02-1, s02-2')
    expect(assessment.refusal).not.toBeNull()
    expect(assessment.refusal).toContain('s02-1, s02-2')
  })

  it('distinguishes a missing latex from a missing dvisvgm, and explains the BasicTeX trap', () => {
    const latexOnly = assessDependencies(parseStoryboard(WITH_MANIM), { ...ALL_PRESENT, latex: 'missing' })
    expect(latexOnly.blocking).toEqual(['latex'])
    expect(latexOnly.refusal).toContain('latex: install a TeX')

    const dvisvgmOnly = assessDependencies(parseStoryboard(WITH_MANIM), { ...ALL_PRESENT, dvisvgm: 'missing' })
    expect(dvisvgmOnly.blocking).toEqual(['dvisvgm'])
    expect(dvisvgmOnly.refusal).toContain('BasicTeX ships `latex` but NOT `dvisvgm`')
    expect(dvisvgmOnly.refusal).toContain('TinyTeX')
  })

  it('distinguishes a missing interpreter from an interpreter without Manim', () => {
    const noPython = assessDependencies(parseStoryboard(WITH_MANIM), { ...ALL_PRESENT, python3: 'missing', manim: 'not installed' })
    expect(noPython.blocking).toContain('python3')
    expect(noPython.refusal).toContain('install a Python 3.10+')

    const pythonNoManim = assessDependencies(parseStoryboard(WITH_MANIM), { ...ALL_PRESENT, manim: 'not installed (No module named manim)' })
    expect(pythonNoManim.blocking).toEqual(['manim'])
    expect(pythonNoManim.refusal).toContain('pip install manim')
    expect(pythonNoManim.refusal).not.toContain('install a Python 3.10+')
  })

  it('offers the slides-only way out in every refusal', () => {
    for (const probe of [NO_MANIM_TOOLS, { ...ALL_PRESENT, latex: 'missing' }, { ...ALL_PRESENT, dvisvgm: 'missing' }]) {
      const refusal = assessDependencies(parseStoryboard(WITH_MANIM), probe).refusal
      expect(refusal).toContain('engine: slides')
      expect(refusal).toContain('Nothing was narrated or rendered')
    }
  })

  it('still blocks a render when ffmpeg itself is absent, whatever the engines', () => {
    const assessment = assessDependencies(parseStoryboard(SLIDES_ONLY), { ...ALL_PRESENT, ffmpeg: 'missing' })
    expect(assessment.blocking).toEqual(['ffmpeg'])
    expect(assessment.refusal).toContain('any render needs')
  })

  it('does not block a narrowed render that touches only slides', () => {
    const assessment = assessDependencies(parseStoryboard(WITH_MANIM), NO_MANIM_TOOLS, ['s01-1'])
    expect(assessment.needsManim).toBe(false)
    expect(assessment.blocking).toEqual([])
    expect(assessment.refusal).toBeNull()

    const narrowed = assessDependencies(parseStoryboard(WITH_MANIM), NO_MANIM_TOOLS, ['s02-2'])
    expect(narrowed.needsManim).toBe(true)
    expect(narrowed.refusal).toContain('s02-2')
  })

  it('never blocks on chromium, which is a lookup hint rather than a gate', () => {
    const assessment = assessDependencies(parseStoryboard(SLIDES_ONLY), { ...ALL_PRESENT, chromium: 'missing' })
    expect(assessment.entries.find(entry => entry.name === 'chromium')?.blocking).toBe(false)
    expect(assessment.refusal).toBeNull()
  })

  it('reads "manim 0.22.1" as present and "not installed (…)" as absent', () => {
    expect(isMissing('manim 0.22.1')).toBe(false)
    expect(isMissing('not installed')).toBe(true)
    expect(isMissing('not installed (No module named manim)')).toBe(true)
    expect(isMissing('playwright default lookup')).toBe(false)
    expect(isMissing('missing')).toBe(true)
  })
})

// ---- through the tool surface -------------------------------------------------

const definitions = new Map<string, ToolDefinition>()

async function workspace(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-deps-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), text, 'utf8')
  }
  return cwd
}

async function runtimeFor(cwd: string, probe: DependencyProbe | null): Promise<ToolRunContext> {
  const home = await mkdtemp(join(tmpdir(), 'teach-deps-ledger-'))
  const ledger = new Ledger({ path: join(home, 'tasks.json'), maxTasks: 50, maxGiB: 1 })
  await ledger.load()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition); return () => {} } },
    get: (name: string) => {
      if (name === 'fs') return hostWorkspaceFs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) }
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key', source: 'test' }) }
      return undefined
    },
  } as unknown as Context
  const runtime = {
    ctx,
    ledger,
    selections: new SelectionStore({ path: join(home, 'selections.json') }),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    settings: () => ({
      enabled: true, providers: [], defaultProvider: '', defaultModel: '', outputDir: '',
      pollIntervalMs: 10, waitSecondsMax: 60, dedupeWindowSeconds: 120, maxConcurrent: 1,
      maxTasks: 50, maxGiB: 1, requestTimeoutMs: 30_000, priceTable: DEFAULT_PRICE_TABLE,
      priceSource: { url: '', refreshHours: 24, info: null },
    }),
    outputRoot: () => join(home, 'outputs'),
    outputDirectory: (id: string) => join(home, 'outputs', id),
    watchTask: () => null,
    cancels: new Map(),
    watching: new Set(),
  } as unknown as VideoForgeRuntime
  registerTeachTools(runtime, probe === null ? {} : { probe: async () => probe })
  return { signal: AbortSignal.timeout(10_000), agent: { id: 'session-deps', session: { header: { cwd } } } } as unknown as ToolRunContext
}

const tool = (name: string): ToolDefinition => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

describe('video_teach_plan with optional Manim', () => {
  it('plans a slides-only manuscript on a machine with no Manim at all', async () => {
    definitions.clear()
    const cwd = await workspace({
      'storyboard.yaml': SLIDES_ONLY,
    'slides/s01/index.html': CUE_DECK,
    })
    const exec = await runtimeFor(cwd, NO_MANIM_TOOLS)
    const result = await tool('video_teach_plan').execute({}, exec) as Record<string, unknown>
    expect(result.needs_manim).toBe(false)
    const dependencies = result.dependencies as { name: string, scope: string, blocking: boolean }[]
    expect(dependencies.filter(entry => entry.scope === 'manim').every(entry => entry.blocking === false)).toBe(true)
    expect(String(result.message)).toContain('needs no Manim')
    expect(String(result.message)).not.toContain('missing (not blocking')
  })

  it('refuses a manim manuscript, naming the sentence ids and what to install', async () => {
    definitions.clear()
    const cwd = await workspace({
      'storyboard.yaml': WITH_MANIM,
    'slides/s01/index.html': CUE_DECK,
      'scenes/s02.py': 'from manim import *\nclass A(Scene):\n    pass\n',
    })
    const exec = await runtimeFor(cwd, { ...ALL_PRESENT, dvisvgm: 'missing' })
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/s02-1, s02-2[\s\S]*dvisvgm[\s\S]*TinyTeX[\s\S]*engine: slides/)
  })

  it('refuses rendering for the same reason, before a segment is made', async () => {
    definitions.clear()
    const timings = {
      voice: { provider: 'volcengine', speaker: 'zh_female_liuchangnv_uranus_bigtts', speedRatio: null },
      sentences: [
        { id: 's01-1', text: '先看第一项。', audio: 'audio/s01-1.mp3', durationMs: 1000, words: [{ t: '先看', b: 0, e: 400 }] },
        { id: 's02-1', text: '把它画成折线。', audio: 'audio/s02-1.mp3', durationMs: 1000, words: [{ t: '把', b: 0, e: 300 }] },
        { id: 's02-2', text: '折线趋近一条水平线。', audio: 'audio/s02-2.mp3', durationMs: 1000, words: [{ t: '折', b: 0, e: 300 }] },
      ],
    }
    const cwd = await workspace({
      'storyboard.yaml': WITH_MANIM,
    'slides/s01/index.html': CUE_DECK,
      'scenes/s02.py': 'from manim import *\nclass A(Scene):\n    pass\n',
      'timings.json': JSON.stringify(timings),
    })
    const exec = await runtimeFor(cwd, NO_MANIM_TOOLS)
    await expect(tool('video_teach_render').execute({}, exec)).rejects.toThrow(/cannot render[\s\S]*engine: slides/)
  })
})
