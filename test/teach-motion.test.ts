/**
 * B10 / B11: the in-page motion library (docs/TEACH-MOTION.md §3–§4).
 *
 * The failure this test exists for is not "the deck threw an error". It is a
 * deck that looks right in a browser and records as a still picture: reveal.css
 * ships `transition: all .2s`, so 200 ms of movement becomes ~6 output frames
 * (reads as a flash), and a deck's own `.reveal .fragment { transition: … }`
 * silently kills every built-in variant's transform. Both are invisible until
 * you count frames.
 *
 * What is measured, per page of `fixtures/teach/motion`:
 *
 * 1. **The picture really moves**: at least five frames across the page differ
 *    visibly from the frame before them, so a 480 ms transition is a transition
 *    and not a jump. The last page of the fixture is the negative control — the
 *    same rows with `--teach-dur: 0ms` — and must stay at one or two such frames.
 * 2. **The last frame is the finished layout**: it has to match the deck driven
 *    to the same page with every beat lit. That proves the beats landed inside
 *    the sentence instead of an animation still running at the cut.
 * 3. **`data-teach-stage` follows the beats** (B11): the morphing element ends
 *    in its step-3 colour, which nothing but `teachCue` can set.
 *
 * Everything runs offline and free: the narration is a hand-written timings file
 * (recording a slide reads `durationMs`, never the audio), and the deck is
 * scaffolded with `writeDeck`, so the asserts exercise the shipped template CSS
 * and the shipped `teachCue` rather than a copy of them.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { chromium, type Browser } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { writeDeck } from '../src/teach/deck.ts'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'
import { registerTeachTools } from '../src/teach/tools.ts'

const FIXTURE = fileURLToPath(new URL('../fixtures/teach/motion/', import.meta.url))

/** Whether this machine can record a slide at all. */
const CAN_RECORD = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const FFMPEG = BIN === '' ? 'ffmpeg' : join(BIN, 'ffmpeg')
const FFPROBE = BIN === '' ? 'ffprobe' : join(BIN, 'ffprobe')

/**
 * Positive evidence only (AGENTS.md hard rule 6): both programs have to answer
 * for themselves. A clean runner ships neither, and reading "cannot tell" as
 * "probably fine" turns the intended skip into a red gate.
 */
const CAN_MEDIA = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0

/** A frame counts as moved when this many pixels changed by more than {@link LEVEL}. */
const MOVED_PIXELS = 200
const LEVEL = 8
/** How many transitional frames a 480–900 ms motion has to leave in a 30 fps cut. */
const MIN_MOVED_FRAMES = 5
/** The `--teach-dur: 0ms` control may produce the cue's own frame, and little else. */
const MAX_CONTROL_FRAMES = 3

const WIDTH = 640
const HEIGHT = 360

const definitions = new Map<string, ToolDefinition>()

const tool = (name: string): ToolDefinition => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

/** The fixture's pages, as `writeDeck` wants them. */
async function sections(): Promise<string> {
  return readFile(join(FIXTURE, 'sections.html'), 'utf8')
}

/** The sentences of the fixture manuscript, so the timings cannot drift from it. */
async function sentenceIds(): Promise<{ id: string, text: string }[]> {
  const yaml = await readFile(join(FIXTURE, 'storyboard.yaml'), 'utf8')
  return [...yaml.matchAll(/- id: (s01-\d+)\n\s+say: (.+)/g)].map(match => ({ id: match[1]!, text: match[2]!.trim() }))
}

interface Harness {
  cwd: string
  exec: ToolRunContext
  deckPath: string
}

/**
 * A workspace holding the fixture: the manuscript, a deck scaffolded from the
 * shipped template plus `sections.html`, and (when asked) a synthetic timing
 * file. Scaffolding instead of copying a finished deck is the point of the test:
 * the CSS under measurement is the template's.
 */
async function harness(options: { timings?: boolean } = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-motion-'))
  await mkdir(join(cwd, 'slides', 's01'), { recursive: true })
  await writeFile(join(cwd, 'storyboard.yaml'), await readFile(join(FIXTURE, 'storyboard.yaml'), 'utf8'), 'utf8')
  const deckPath = await writeDeck(join(cwd, 'slides', 's01'), { title: '页内动效库', slides: await sections() })
  if (options.timings === true) {
    const sentences = await sentenceIds()
    await writeFile(join(cwd, 'timings.json'), JSON.stringify({
      voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
      // 3 s per sentence: a beat at 2/3 lands at 2.01 s, which leaves room for the
      // longest in-page motion of the fixture (the 900 ms counter and draw) to
      // finish before the cut. A shorter sentence would truncate the very thing
      // the last-frame assertion measures.
      sentences: sentences.map(sentence => ({
        id: sentence.id,
        text: sentence.text,
        audio: `audio/${sentence.id}.wav`,
        durationMs: 3000,
        words: [],
      })),
    }), 'utf8')
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
  const home = await mkdtemp(join(tmpdir(), 'teach-motion-ledger-'))
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
  const exec = {
    signal: AbortSignal.timeout(600_000),
    agent: { id: 'session-motion', session: { header: { cwd } } },
  } as unknown as ToolRunContext
  return { cwd, exec, deckPath }
}

/** Run ffmpeg and collect stdout (decoded frames, or a frame's pixels). */
function ffmpegBytes(args: readonly string[]): Promise<Buffer> {
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

/** Decode a file's frames, downscaled, in the given pixel format. */
async function decode(file: string, format: 'gray' | 'rgb24', edge?: 'last'): Promise<Buffer[]> {
  const size = format === 'gray' ? 1 : 3
  const args = [
    '-v', 'error',
    ...(edge === 'last' ? ['-sseof', '-0.2'] : []),
    '-i', file,
    '-vf', `scale=${WIDTH}:${HEIGHT}`,
    ...(edge === 'last' ? ['-frames:v', '1'] : []),
    '-f', 'rawvideo', '-pix_fmt', format, '-',
  ]
  const raw = await ffmpegBytes(args)
  const stride = WIDTH * HEIGHT * size
  const out: Buffer[] = []
  for (let offset = 0; offset + stride <= raw.byteLength; offset += stride) out.push(raw.subarray(offset, offset + stride))
  return out
}

/** One frame of a grayscale decode; throws rather than comparing an empty buffer. */
async function grayFrame(file: string, edge?: 'last'): Promise<Buffer> {
  const list = await decode(file, 'gray', edge)
  const frame = list[0]
  if (frame === undefined) throw new Error(`no frame decoded from ${file}`)
  return frame
}

/** How many pixels of two frames differ by more than {@link LEVEL}. */
function movedPixels(a: Buffer, b: Buffer): number {
  let moved = 0
  for (let at = 0; at < a.length; at += 1) {
    if (Math.abs(a[at]! - b[at]!) > LEVEL) moved += 1
  }
  return moved
}

/** How many frames of a segment differ visibly from their predecessor. */
async function movingFrames(file: string): Promise<number> {
  const list = await decode(file, 'gray')
  let moved = 0
  for (let at = 1; at < list.length; at += 1) {
    if (movedPixels(list[at - 1]!, list[at]!) > MOVED_PIXELS) moved += 1
  }
  return moved
}

/** Mean absolute difference of two frames drawn the same size: "is this the same picture". */
function meanDiff(a: Buffer, b: Buffer): number {
  let total = 0
  for (let at = 0; at < a.length; at += 1) total += Math.abs(a[at]! - b[at]!)
  return total / a.length
}

/** How many pixels of an rgb24 frame sit within `radius` of a colour. */
function colourCount(frame: Buffer, target: readonly [number, number, number], radius = 48): number {
  let count = 0
  for (let at = 0; at + 2 < frame.length; at += 3) {
    const dr = frame[at]! - target[0]
    const dg = frame[at + 1]! - target[1]
    const db = frame[at + 2]! - target[2]
    if (dr * dr + dg * dg + db * db < radius * radius) count += 1
  }
  return count
}

/** The three colours of the stage element, in the fixture's three steps. */
const STEP_ONE: readonly [number, number, number] = [0x6b, 0x72, 0x80]
const STEP_THREE: readonly [number, number, number] = [0xe8, 0x79, 0xf9]

/** Drive the deck to `page` with every beat up to `cue` lit, and screenshot it. */
async function deckShot(browser: Browser, deckPath: string, page: number, cue: number, out: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  try {
    const view = await context.newPage()
    await view.goto(pathToFileURL(deckPath).href, { waitUntil: 'load' })
    await view.waitForFunction(() => (globalThis as { teachReady?: boolean }).teachReady === true, undefined, { timeout: 15_000 })
    await view.evaluate(index => (globalThis as unknown as { teachPage: (n: number) => void }).teachPage(index), page)
    // The page switch fades for 0.5 s in reveal.css; the recorder waits 300 ms
    // before its capture, and the deck is settled by then.
    await view.waitForTimeout(700)
    await view.evaluate(step => (globalThis as unknown as { teachCue: (n: number) => void }).teachCue(step), cue)
    // 1200 ms clears the longest in-page motion of the fixture (the 900 ms counter).
    await view.waitForTimeout(1200)
    await view.screenshot({ path: out })
  } finally {
    await context.close()
  }
}

describe.skipIf(!CAN_RECORD)('the motion fixture in the plan', () => {
  it('passes with nothing to fix, one page per sentence', async () => {
    const { exec } = await harness()
    const result = await tool('video_teach_plan').execute({}, exec) as { warnings: string[], message: string }
    const findings = result.warnings.filter(warning => !warning.startsWith('subtitles will not be burned') && !warning.includes('meta.cover'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('8 deck pages (one per sentence)')
    expect(result.message).toContain('8 page(s) for 8 slides sentence(s)')
  })
})

describe.skipIf(!CAN_RECORD || !CAN_MEDIA)('the motion library in the picture', () => {
  it('moves across the beats, ends on the finished layout, and keeps the 0 ms page a jump', { timeout: 600_000 }, async () => {
    const { cwd, exec, deckPath } = await harness({ timings: true })
    const result = await tool('video_teach_render').execute({ assemble: false }, exec) as { rendered: string[] }
    const ids = (await sentenceIds()).map(sentence => sentence.id)
    expect(result.rendered).toEqual(ids)

    const segment = (id: string): string => join(cwd, '.dsh-video', 'teach', id, 'segment.mp4')
    const findings: string[] = []
    const browser = await chromium.launch({ args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text'] })
    try {
      for (const [page, id] of ids.entries()) {
        const file = segment(id)
        const moved = await movingFrames(file)
        const shot = join(cwd, '.dsh-video', 'teach', id, 'all-beats.png')
        await deckShot(browser, deckPath, page, 2, shot)
        // The segment's last frame has to be the deck's finished state: same page,
        // every beat lit. A motion still running at the cut fails here, and so does
        // a beat that never landed.
        const diff = meanDiff(await grayFrame(file, 'last'), await grayFrame(shot))
        const wanted = page < 7 ? moved >= MIN_MOVED_FRAMES : moved <= MAX_CONTROL_FRAMES
        if (!wanted) findings.push(`${id}: ${moved} moving frame(s) — the ${page < 7 ? 'variant never tweened' : '0 ms control tweened'}`)
        if (diff >= 10) findings.push(`${id}: last frame differs from the fully-lit deck by ${diff.toFixed(1)} — the motion had not finished, or a beat never landed`)
      }

      // B11: the stage element reaches its third colour only if `teachCue` wrote
      // `data-step`. Nothing else in the deck touches that attribute.
      const stage = await decode(segment(ids[6]!), 'rgb24')
      const first = stage[0]
      const last = stage[stage.length - 1]
      if (first === undefined || last === undefined) findings.push('the stage segment decoded to no frames')
      else {
        if (colourCount(first, STEP_ONE) < 100) findings.push(`stage page: the first frame is not in the step-1 colour (${colourCount(first, STEP_ONE)} px)`)
        if (colourCount(last, STEP_THREE) < 100) findings.push(`stage page: the last frame is not in the step-3 colour (${colourCount(last, STEP_THREE)} px)`)
      }
    } finally {
      await browser.close()
    }
    expect(findings).toEqual([])
  })
})
