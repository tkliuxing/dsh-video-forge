/**
 * B1: one deck page carries several sentences (`page` / `enter`), the contract
 * in docs/TEACH-VIDEO.md §25 and in the `video-teach-storyboard` /
 * `video-teach-slides` skills.
 *
 * Two halves, both offline and unpaid:
 *
 * - **plan**: the shipped fixture must pass with nothing to fix. "A shared page
 *   is a first-class manuscript" means the plan neither refuses it nor warns that
 *   every sentence needs its own `<section>`.
 * - **render**: the three sentences of that fixture are recorded for real and the
 *   frames are measured. Sentence 2's first frame has to be the frame sentence 1
 *   ended on. That is the only measurement that proves `enter` reached the deck
 *   before the capture started, which is the whole reason the recorder calls
 *   `teachCue(enter)` inside the page-switch wait (src/teach/slides.ts).
 *
 * The narration is synthetic (a timings file written by hand, no audio files):
 * recording a slide does not read the audio, only `durationMs` (the clock).
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { writeDeck } from '../src/teach/deck.ts'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'
import { registerTeachTools } from '../src/teach/tools.ts'

const FIXTURE = fileURLToPath(new URL('../fixtures/teach/shared-page/', import.meta.url))

/** Whether this machine can record a slide at all. */
const CAN_RECORD = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const FFMPEG = BIN === '' ? 'ffmpeg' : join(BIN, 'ffmpeg')

const definitions = new Map<string, ToolDefinition>()

const tool = (name: string): ToolDefinition => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

/** The fixture, as the files a workspace would hold. */
async function fixtureFiles(): Promise<Record<string, string>> {
  return {
    'storyboard.yaml': await readFile(join(FIXTURE, 'storyboard.yaml'), 'utf8'),
    'slides/s01/index.html': await readFile(join(FIXTURE, 'slides/s01/index.html'), 'utf8'),
    'cover/index.html': await readFile(join(FIXTURE, 'cover/index.html'), 'utf8'),
  }
}

interface Harness {
  cwd: string
  exec: ToolRunContext
}

async function harness(files: Record<string, string>): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-shared-page-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), text, 'utf8')
  }
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition); return () => {} } },
    get: (name: string) => {
      if (name === 'fs') return hostWorkspaceFs
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) }
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key', source: 'test' }) }
      return undefined
    },
  } as unknown as Context
  const home = await mkdtemp(join(tmpdir(), 'teach-shared-page-ledger-'))
  const ledger = new Ledger({ path: join(home, 'tasks.json'), maxTasks: 50, maxGiB: 1 })
  await ledger.load()
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
      ...(BIN === '' ? {} : { teach: { ffmpegBinPath: BIN } }),
    }),
    outputRoot: () => join(home, 'outputs'),
    outputDirectory: (id: string) => join(home, 'outputs', id),
    watchTask: () => null,
    cancels: new Map(),
    watching: new Set(),
  } as unknown as VideoForgeRuntime
  definitions.clear()
  registerTeachTools(runtime)
  const exec = { signal: AbortSignal.timeout(180_000), agent: { id: 'session-shared-page', session: { header: { cwd } } } } as unknown as ToolRunContext
  return { cwd, exec }
}

/** Synthetic narration: the clock the recorder cuts each segment to. */
const TIMINGS = {
  voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' as const },
  sentences: [
    { id: 's01-1', text: '三块版面说的是同一件事，所以它们只有一页。', audio: 'audio/s01-1.wav', durationMs: 2400, words: [] },
    { id: 's01-2', text: '第二句进来时第一块已经亮着，画面接着上一句。', audio: 'audio/s01-2.wav', durationMs: 2400, words: [] },
    { id: 's01-3', text: '第三句进来时亮着两块，这一句点亮最后一块。', audio: 'audio/s01-3.wav', durationMs: 2400, words: [] },
  ],
}

/** Run ffmpeg, collecting stdout (the decoded frame). */
function ffmpegFrame(args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(chunks))
      reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

/**
 * How many of the deck's three bands are lit in one frame of a segment.
 *
 * The fixture paints each band as a full-width stripe over a near-black page:
 * a lit band is one of three bright colours, an unlit one is 14% opaque over the
 * background. Sampling the right-hand end of each band keeps the label text out
 * of the reading, so the count is "how much of this page has been revealed" and
 * nothing else.
 */
async function litBands(file: string, edge: 'first' | 'last'): Promise<number> {
  const seek = edge === 'first' ? ['-ss', '0'] : ['-sseof', '-0.2']
  const raw = await ffmpegFrame(['-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  const width = 1920
  const height = Math.floor(raw.byteLength / (width * 3))
  expect(height).toBe(1080)
  let lit = 0
  for (const y of [180, 540, 900]) {
    const offset = (y * width + 1840) * 3
    const brightest = Math.max(raw[offset]!, raw[offset + 1]!, raw[offset + 2]!)
    if (brightest > 128) lit += 1
  }
  return lit
}

describe('a shared page in the plan (page / enter)', () => {
  it('passes the fixture with nothing to fix, and says the three sentences share one page', async () => {
    const { exec } = await harness(await fixtureFiles())
    const result = await tool('video_teach_plan').execute({}, exec) as { warnings: string[], message: string, sentences: unknown[] }
    // Everything machine-specific is filtered out by name: this test is about the
    // manuscript, not about which ffmpeg this host happens to have. What is left is
    // the one page-mode explanation, which is a statement about the manuscript
    // rather than something to fix.
    const findings = result.warnings.filter(warning => !warning.startsWith('subtitles will not be burned'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('1 deck page for 3 sentence(s)')
    expect(findings[0]).toContain('shared where the manuscript says')
    // The two conclusion lines have to agree with that warning: three sentences,
    // one page, and a picture that starts on the page the manuscript gives them.
    expect(result.message).toContain('rhythm: page mode — 1 page(s) for 3 slides sentence(s)')
    expect(result.message).toContain('each sentence starts on its own deck page (or on the page it shares, when the manuscript says page)')
  })

  it('reads a real scaffolded deck as the one page it is, and refuses a page it does not have', async () => {
    // The deck here is what `writeDeck` gives a project, not a hand-written fixture:
    // its script talks about sections and fragments, and a page check that reads that
    // JavaScript as markup counts pages that do not exist. That mistake turned the
    // page-picker checks into a false "1 page(s) are never recorded" warning and let
    // an out-of-range `page` through (found 2026-11-25 by review).
    const shared = `meta:
  title: 一页三句
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 三块版面说的是同一件事，所以它们只有一页。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.4 }]
      - id: s01-2
        say: 第二句进来时第一块已经亮着，画面接着上一句。
        page: 0
        enter: 1
        cues: [{ fragment: 2, at_progress: 0.4 }]
      - id: s01-3
        say: 第三句进来时亮着两块，这一句点亮最后一块。
        page: 0
        enter: 2
        cues: [{ fragment: 3, at_progress: 0.4 }]
`
    const { cwd, exec } = await harness({ 'storyboard.yaml': shared })
    await writeDeck(join(cwd, 'slides', 's01'), {
      title: '一页三句',
      slides: '<section><h1>一页三句</h1><div class="fragment">一</div><div class="fragment">二</div><div class="fragment">三</div></section>',
    })
    const result = await tool('video_teach_plan').execute({}, exec) as { warnings: string[] }
    const findings = result.warnings.filter(warning => !warning.startsWith('subtitles will not be burned') && !warning.includes('meta.cover'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('1 deck page for 3 sentence(s)')
    expect(findings.some(warning => warning.includes('never recorded'))).toBe(false)

    // The same deck cannot hold a second page, so a manuscript that asks for one is
    // refused rather than recorded against the wrong page.
    const moved = shared.replace(/page: 0/g, 'page: 1')
    const second = await harness({ 'storyboard.yaml': moved })
    await writeDeck(join(second.cwd, 'slides', 's01'), {
      title: '一页三句',
      slides: '<section><h1>一页三句</h1><div class="fragment">一</div></section>',
    })
    await expect(tool('video_teach_plan').execute({}, second.exec)).rejects.toThrow(/puts sentence "s01-1" on page 2/)
  })

  it('refuses a second sentence that restarts the beat numbering, before any money is spent', async () => {
    const files = await fixtureFiles()
    files['storyboard.yaml'] = files['storyboard.yaml']!.replace('        cues: [{ fragment: 2, at_progress: 0.4 }]', '        cues: [{ fragment: 1, at_progress: 0.4 }]')
    const { exec } = await harness(files)
    // The sentence names `enter: 1` itself, so the finding says so; a sentence that
    // inherits the state gets the same refusal worded as what the previous one left.
    await expect(tool('video_teach_plan').execute({}, exec)).rejects.toThrow(/"s01-2"[\s\S]*the cue changes nothing/)
  })

  it('keeps the older page-mode fixture plan-clean too, one page per sentence', async () => {
    // The page-mode example declares no `page` at all: its pages must still map
    // one to one, and its deck must still declare the beats as fragments.
    const pageMode = fileURLToPath(new URL('../fixtures/teach/page-mode/', import.meta.url))
    const { exec } = await harness({
      'storyboard.yaml': await readFile(join(pageMode, 'storyboard.yaml'), 'utf8'),
      'slides/s01/index.html': await readFile(join(pageMode, 'slides/s01/index.html'), 'utf8'),
    })
    const result = await tool('video_teach_plan').execute({}, exec) as { warnings: string[] }
    const findings = result.warnings.filter(warning => !warning.startsWith('subtitles will not be burned') && !warning.includes('no meta.cover'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('3 deck pages (one per sentence)')
  })
})

describe.skipIf(!CAN_RECORD)('a shared page in the picture (page / enter)', () => {
  it('opens sentence 2 on exactly the frame sentence 1 ended on', { timeout: 120_000 }, async () => {
    const { cwd, exec } = await harness({ ...(await fixtureFiles()), 'timings.json': JSON.stringify(TIMINGS) })
    const result = await tool('video_teach_render').execute({ assemble: false }, exec) as { rendered: string[], output: string | null }
    expect(result.output).toBeNull()
    expect(result.rendered).toEqual(['s01-1', 's01-2', 's01-3'])

    const segment = (id: string) => join(cwd, '.dsh-video/teach', id, 'segment.mp4')
    // Sentence 1 enters with nothing lit and reveals one band.
    expect(await litBands(segment('s01-1'), 'first')).toBe(0)
    expect(await litBands(segment('s01-1'), 'last')).toBe(1)
    // Sentence 2 inherits that state before its capture starts, then reveals the
    // second band. If `enter` were applied after the capture began, the first
    // frame would show an empty page (0) instead of 1.
    expect(await litBands(segment('s01-2'), 'first')).toBe(1)
    expect(await litBands(segment('s01-2'), 'last')).toBe(2)
    // Sentence 3 does the same with its explicit `enter: 2`.
    expect(await litBands(segment('s01-3'), 'first')).toBe(2)
    expect(await litBands(segment('s01-3'), 'last')).toBe(3)
  })
})
