/**
 * B12 / D2: the recording contract for motion (docs/TEACH-MOTION.md §5).
 *
 * Two halves, both about the same two optional globals:
 *
 * 1. **The recorder waits as long as the deck says.** `teachPageTransition`
 *    replaces the hard-coded 300 ms. The test records a deck whose page switch
 *    stays visible for 700 ms: with the declaration the first captured frame is
 *    the settled page, without it the first frames are the switch itself. That is
 *    the defect the number exists for — reveal's `fade` is a fixed 0.5 s, so a
 *    300 ms wait starts recording mid-transition and nobody sees it in the file.
 * 2. **The plan warns when a beat has less room than its own motion.**
 *    `teachTransition` is only checked, never driven: `video_teach_plan` compares
 *    it against the gap to the next beat (or to the cut) and names the sentence. A
 *    deck that declares nothing keeps the old, silent behaviour — that is the
 *    whole point of "not declaring means nothing is checked".
 *
 * The plan half is cheap and offline. The recorder half needs a Chromium and
 * ffmpeg, so it is gated on both answering for themselves (AGENTS.md rule 6).
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'
import { lateBeats, recordDeckSegment, type BeatTiming } from '../src/teach/slides.ts'
import { motionFindings, renderSegments, type RenderedSegment, type TeachPaths } from '../src/teach/pipeline.ts'
import { parseStoryboard, type Timings } from '../src/teach/storyboard.ts'
import { registerTeachTools } from '../src/teach/tools.ts'

const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const FFMPEG = BIN === '' ? 'ffmpeg' : join(BIN, 'ffmpeg')
const FFPROBE = BIN === '' ? 'ffprobe' : join(BIN, 'ffprobe')

/** Positive evidence only: both programs have to answer for themselves. */
const CAN_MEDIA = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0
const CAN_RECORD = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

const definitions = new Map<string, ToolDefinition>()

/** A workspace whose deck declares whatever the test asks it to. */
interface Project {
  cwd: string
  exec: ToolRunContext
}

/**
 * A minimal page-mode deck — no reveal.js, because the plan only reads the HTML —
 * with two beats on one page and, optionally, the two declarations this test is
 * about. The tiny white dot keeps the recorder's "did it paint anything" check
 * from calling the deck blank.
 */
function deckHtml(options: { transition?: number, pageTransition?: number, beatMs?: number, slowCueMs?: number } = {}): string {
  const lines = [
    options.transition === undefined ? '' : `  window.teachTransition = ${options.transition}`,
    options.pageTransition === undefined ? '' : `  window.teachPageTransition = ${options.pageTransition}`,
  ].filter(line => line !== '').join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>transition</title>
<style>
  html, body { margin: 0; height: 100%; background: #101010; color: #e8ecf4;
               font-family: "PingFang SC", system-ui, sans-serif }
  section { height: 100vh; position: relative }
  .beat { position: absolute; left: 80px; right: 80px; height: 120px; background: #7aa2f7;
          opacity: .3; transition: opacity ${options.beatMs ?? 480}ms ease }
  .beat.on { opacity: 1 }
  .beat:nth-of-type(1) { top: 160px }
  .beat:nth-of-type(2) { top: 360px }
  .dot { position: absolute; left: 40px; top: 40px; width: 12px; height: 12px; border-radius: 6px;
         background: #ffffff }
</style></head>
<body>
<section data-page="0"><div class="dot"></div>
  <div class="beat" data-beat="1"></div><div class="beat" data-beat="2"></div>
</section>
<script>
${lines}
  const beats = [...document.querySelectorAll('[data-beat]')]
  window.teachCue = function teachCue(step) {
    const until = performance.now() + ${options.slowCueMs ?? 0}
    while (performance.now() < until) { /* a page that blocks its own main thread */ }
    for (const beat of beats) beat.classList.toggle('on', Number(beat.dataset.beat) <= Number(step))
  }
  window.teachPage = function teachPage() {}
  window.teachReady = true
</script>
</body></html>
`
}

/** One sentence with two beats; the second lands at `at` so the room can be dialled. */
function manuscript(at: number): string {
  return `meta:
  title: transition
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 这一句在临近结束的时候才点亮最后一块，余量到底够不够要看后面的数。
        cues:
          - { fragment: 1, at_progress: 0.3 }
          - { fragment: 2, at_progress: ${at} }
`
}

async function project(files: Record<string, string>): Promise<Project> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-transition-'))
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
  const home = await mkdtemp(join(tmpdir(), 'teach-transition-ledger-'))
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
    signal: AbortSignal.timeout(300_000),
    agent: { id: 'session-transition', session: { header: { cwd } } },
  } as unknown as ToolRunContext
  return { cwd, exec }
}

/** The plan's findings, minus the two lines every machine-only run produces. */
async function planWarnings(files: Record<string, string>): Promise<string[]> {
  const { exec } = await project(files)
  const result = await definitions.get('video_teach_plan')!.execute({}, exec) as { warnings: string[] }
  return result.warnings.filter(warning => !warning.startsWith('subtitles will not be burned') && !warning.includes('meta.cover'))
}

/** A timings file for the one sentence, as narration would have written it. */
function timings(durationMs: number): string {
  return JSON.stringify({
    voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
    sentences: [{ id: 's01-1', text: '这一句在临近结束的时候才点亮最后一块，余量到底够不够要看后面的数。', audio: 'audio/s01-1.wav', durationMs, exitMs: 0, words: [] }],
  })
}

/** The late-beat tolerance the recorder exports, restated once for the assertions below. */
const LATE = 120

/** Pixels of an rgb24 frame that are the switch colour rather than the page. */
function redPixels(frame: Buffer): number {
  let red = 0
  for (let at = 0; at + 2 < frame.length; at += 3) {
    if (frame[at]! > 140 && frame[at + 1]! < 90 && frame[at + 2]! < 90) red += 1
  }
  return red
}

/** One frame of a segment, decoded with ffmpeg (needs no Playwright). */
function frame(file: string, edge: 'first' | 'last'): Buffer {
  const seek = edge === 'last' ? ['-sseof', '-0.15'] : ['-ss', '0']
  const result = spawnSync(FFMPEG, ['-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 })
  if (result.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${result.stderr.toString().slice(0, 300)}`)
  return result.stdout
}

describe.skipIf(!CAN_RECORD)('the plan checks a beat against the declared transition', () => {
  it('warns when the last beat has less room before the cut than its motion', async () => {
    const findings = await planWarnings({ 'storyboard.yaml': manuscript(0.95), 'slides/s01/index.html': deckHtml({ transition: 480 }) })
    const finding = findings.find(warning => warning.includes('declares a 480 ms transition'))
    expect(finding).toBeDefined()
    expect(finding).toContain('sentence "s01-1" fires fragment 2')
    expect(finding).toContain('the sentence ends')
    expect(finding).toContain('when the segment is cut')
    // No narration here, so the length is the estimate — and the finding says so
    // rather than presenting a guess as a measurement.
    expect(finding).toContain('estimate from its')
    expect(finding).toContain('characters')
  })

  it('uses the measured narration when there is one, and warns about the next beat instead', async () => {
    // 2600 ms of narration with beats at 30% and 45%: 780 ms and 1170 ms, so the
    // first beat has only 390 ms before the second one starts moving. That is the
    // other flavour of the same finding — the one about overlapping beats rather
    // than about the cut.
    const findings = await planWarnings({
      'storyboard.yaml': manuscript(0.45),
      'slides/s01/index.html': deckHtml({ transition: 480 }),
      'timings.json': timings(2600),
    })
    const finding = findings.find(warning => warning.includes('declares a 480 ms transition'))
    expect(finding).toBeDefined()
    expect(finding).toContain('fragment 1 at 780 ms and fragment 2 follows 390 ms later')
    expect(finding).toContain('when the next beat starts')
    // The measured clock was used, so the estimate caveat must be gone.
    expect(finding?.includes('estimate from')).toBe(false)
  })

  it('says nothing at all when the deck declares no duration', async () => {
    const findings = await planWarnings({ 'storyboard.yaml': manuscript(0.95), 'slides/s01/index.html': deckHtml() })
    expect(findings.some(warning => warning.includes('teachTransition'))).toBe(false)
  })
})

/** A rendered segment with only the fields the motion findings read. */
const rendered = (patch: Partial<RenderedSegment>): RenderedSegment => ({
  id: 's01-1', path: '/nowhere.mp4', durationMs: 1000, exitMs: 0, exitTarget: null, frames: 10, beats: [], settle: null, retried: false, ...patch,
})

const beat = (fragment: number, atMs: number, actualMs: number): BeatTiming => ({ fragment, atMs, actualMs })

describe('what a render says about its beats (late and cut motion)', () => {
  it('calls a beat late only past the tolerance, and names the sentence to re-record', () => {
    expect(lateBeats([beat(1, 1000, 1050)])).toEqual([])
    expect(lateBeats([beat(1, 1000, 1000 + LATE)])).toEqual([])
    expect(lateBeats([beat(1, 1000, 1001 + LATE)])).toHaveLength(1)

    const findings = motionFindings([rendered({ beats: [beat(1, 1000, 2000), beat(2, 2500, 2560)] })])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('sentence "s01-1"')
    expect(findings[0]).toContain('beat 1 landed 1000 ms after it was due')
    expect(findings[0]).toContain('sentences: ["s01-1"]')
  })

  it('says when the retry did not help, instead of asking for the same thing twice', () => {
    const [finding] = motionFindings([rendered({ retried: true, beats: [beat(1, 1000, 3000)] })])
    expect(finding).toContain('stayed late when recorded a second time')
    expect(finding).toContain('the machine was busy, not the manuscript')
  })

  it('reports a segment cut through an animation, and nothing when it finished', () => {
    const cut = motionFindings([rendered({ settle: { status: 'unfinished', changed: 0.011, mean: 1.9, finalFragment: 2 } })])
    expect(cut).toHaveLength(1)
    expect(cut[0]).toContain('not the finished layout')
    expect(cut[0]).toContain('1.1% of its pixels')
    expect(cut[0]).toContain('driven to beat 2')
    expect(motionFindings([rendered({ settle: { status: 'finished', changed: 0, mean: 0.02, finalFragment: 2 } })])).toEqual([])
  })

  it('never lets "not checked" look like "checked and fine"', () => {
    // No beats: nothing to finish, so silence is the honest answer.
    expect(motionFindings([rendered({ settle: { status: 'skipped', reason: 'this sentence fires no beat' } })])).toEqual([])
    // Beats but no check: say so.
    const [finding] = motionFindings([rendered({ beats: [beat(1, 100, 110)], settle: { status: 'skipped', reason: 'ffmpeg exploded' } })])
    expect(finding).toContain('did not run')
    expect(finding).toContain('ffmpeg exploded')
  })
})

describe.skipIf(!CAN_RECORD || !CAN_MEDIA)('the recorder waits as long as the deck says', () => {
  /**
   * Record one short segment of a deck whose page switch is visible for 700 ms,
   * and report how much of the first and last frame is that switch colour.
   *
   * 700 ms sits between the recorder's 300 ms default and the 1000 ms this deck
   * can declare, so the two cases cannot both pass by accident.
   */
  async function record(options: { pageTransition?: number }): Promise<{ first: number, last: number, frames: number }> {
    const root = await mkdtemp(join(tmpdir(), 'teach-transition-record-'))
    const deckPath = join(root, 'slides', 's01', 'index.html')
    await mkdir(join(root, 'slides', 's01'), { recursive: true })
    // The switch colour is added by the harness, so the HTML above stays about the
    // contract and this test about the wait.
    const html = deckHtml(options).replace(
      '  window.teachPage = function teachPage() {}',
      `  window.teachPage = function teachPage() {
    document.body.style.background = '#e01b1b'
    setTimeout(function () { document.body.style.background = '#101010' }, 700)
  }`,
    )
    await writeFile(deckPath, html, 'utf8')
    const segment = await recordDeckSegment({
      deckPath,
      page: 0,
      cues: [],
      durationMs: 900,
      width: 960,
      height: 540,
      fps: 30,
      workDir: join(root, 'work'),
    })
    return { first: redPixels(frame(segment.path, 'first')), last: redPixels(frame(segment.path, 'last')), frames: segment.frames }
  }

  it('starts on the settled page when the deck declares its switch, and mid-switch when it does not', { timeout: 120_000 }, async () => {
    const declared = await record({ pageTransition: 1000 })
    const fallback = await record({})
    expect(declared.frames).toBeGreaterThan(0)
    // The switch is 700 ms; a 1000 ms wait is past it, the 300 ms default is not.
    expect(declared.first).toBe(0)
    expect(fallback.first).toBeGreaterThan(320 * 180 / 2)
    // Both settles into the page by the end, so the difference is the start alone.
    expect(declared.last).toBe(0)
    expect(fallback.last).toBe(0)
  })

  it('records a sentence twice when its beat lands late, then says the retry did not help', { timeout: 180_000 }, async () => {
    // The only honest way to force a late beat: make the deck's own main thread
    // block inside teachCue. Retrying cannot fix this deck, which is exactly the
    // case the report has to describe differently from "record it again".
    const root = await mkdtemp(join(tmpdir(), 'teach-late-'))
    await mkdir(join(root, 'slides', 's01'), { recursive: true })
    await writeFile(join(root, 'slides', 's01', 'index.html'), deckHtml({ slowCueMs: 260 }), 'utf8')
    const paths: TeachPaths = { root, audio: 'audio', timings: 'timings.json', work: '.dsh-video/teach', segments: '.dsh-video/teach/segments' }
    const board = parseStoryboard(`meta:
  title: late
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 这一句的拍子会迟到。
        cues: [{ fragment: 1, at_progress: 0.5 }]
`)
    const timings: Timings = {
      voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
      sentences: [{ id: 's01-1', text: '这一句的拍子会迟到。', audio: 'audio/s01-1.wav', durationMs: 2400, exitMs: 0, words: [] }],
    }
    const rendered = await renderSegments({ board, timings, paths })
    expect(rendered).toHaveLength(1)
    expect(rendered[0]!.retried).toBe(true)
    const [finding] = motionFindings(rendered)
    expect(finding).toContain('sentence "s01-1"')
    expect(finding).toContain('after it was due')
    expect(finding).toContain('stayed late when recorded a second time')
  })

  it('sees whether the last beat finished, by driving the deck to the state it asked for', { timeout: 180_000 }, async () => {
    // Two recordings of the same page: the first cuts 200 ms into a 480 ms fade, the
    // second gives it three seconds of room. Nothing else differs, so `settle` is
    // measuring the ending and not the deck.
    const record = async (durationMs: number) => {
      const root = await mkdtemp(join(tmpdir(), 'teach-settle-'))
      const deckPath = join(root, 'slides', 's01', 'index.html')
      await mkdir(join(root, 'slides', 's01'), { recursive: true })
      await writeFile(deckPath, deckHtml({ transition: 480 }), 'utf8')
      return recordDeckSegment({
        deckPath, page: 0,
        cues: [{ atMs: durationMs === 2600 ? 2400 : 2400, fragment: 1 }],
        durationMs, width: 960, height: 540, fps: 30, workDir: join(root, 'work'),
      })
    }
    const cut = await record(2600)
    const finished = await record(5200)
    expect(cut.beats).toHaveLength(1)
    expect(Math.abs(cut.beats[0]!.actualMs - 2400)).toBeLessThan(200)
    expect(cut.settle.status).toBe('unfinished')
    expect(finished.settle.status).toBe('finished')
    if (cut.settle.status === 'unfinished' && finished.settle.status === 'finished') {
      expect(cut.settle.changed).toBeGreaterThan(0.002)
      expect(finished.settle.changed).toBeLessThan(0.002)
    }
  })
})
