/**
 * Cue mode over more than one `<section>`.
 *
 * Cue mode numbers beats across the whole deck (one counter for the film), while
 * `teachCue` counts inside the page it is on. With one page those are the same
 * number, which is why the recorder used to drive cue mode without ever turning a
 * page — and why a multi-page cue-mode deck recorded its first page and nothing
 * else. `cueLandings` is the translation, and the opening state of a sentence is
 * that translation minus one beat: the beats before its first cue are already lit,
 * so sentence 9 does not re-pop the eight beats before it.
 *
 * Two halves:
 *
 * - **the arithmetic** runs everywhere: the page a number lands on, the clamp at
 *   the last page, and `null` when the deck exposes no pages to count.
 * - **the picture** needs Chromium and ffmpeg (a clean runner has neither, so it
 *   skips): a two-page deck whose pages are light and dark, recorded sentence by
 *   sentence, has to come back with each sentence starting on the page its first
 *   cue names.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { writeDeck } from '../src/teach/deck.ts'
import { cueLandings, cueOpening, recordDeckSegment, type CueAt } from '../src/teach/slides.ts'

const cue = (fragment: number): CueAt => ({ atMs: 120, fragment })

describe('cue-mode page translation', () => {
  it('leaves a single-page deck exactly as it was', () => {
    expect(cueLandings([4], [cue(1), cue(2), cue(4)])).toEqual([
      { page: 0, step: 1 },
      { page: 0, step: 2 },
      { page: 0, step: 4 },
    ])
  })

  it('spreads one counter across the pages in order', () => {
    // 3 + 2 fragments: numbers 1–3 belong to page 0, 4–5 to page 1.
    expect(cueLandings([3, 2], [cue(1), cue(3), cue(4), cue(5)])).toEqual([
      { page: 0, step: 1 },
      { page: 0, step: 3 },
      { page: 1, step: 1 },
      { page: 1, step: 2 },
    ])
  })

  it('skips a page that carries no fragment', () => {
    expect(cueLandings([0, 2], [cue(1), cue(2)])).toEqual([
      { page: 1, step: 1 },
      { page: 1, step: 2 },
    ])
  })

  it('clamps past the last fragment to the last beat, like the template does', () => {
    expect(cueLandings([2, 1], [cue(9)])).toEqual([{ page: 1, step: 1 }])
    expect(cueLandings([0], [cue(3)])).toEqual([{ page: 0, step: 0 }])
  })

  it('clamps to the last page that carries a beat, not to a trailing empty page', () => {
    expect(cueLandings([2, 0], [cue(3)])).toEqual([{ page: 0, step: 2 }])
  })

  it('answers null when the deck exposes no pages, so the old behaviour stands', () => {
    expect(cueLandings([], [cue(1)])).toBeNull()
  })

  it('opens before its first cue, and on the reached picture when it has none', () => {
    // A sentence with cues: the cue's page, one beat short of the cue itself.
    expect(cueOpening([1, 2], [cue(2)], 0)).toEqual({ page: 1, step: 0 })
    expect(cueOpening([1, 2], [cue(3)], 0)).toEqual({ page: 1, step: 1 })
    // A sentence with no cue: the page holding the beat the story reached, with it lit.
    expect(cueOpening([1, 2], [], 2)).toEqual({ page: 1, step: 1 })
    expect(cueOpening([1, 2], [], 0)).toEqual({ page: 0, step: 0 })
    expect(cueOpening([], [], 2)).toBeNull()
  })
})

/** Whether this machine can record a slide at all. */
const CAN_RECORD = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const FFMPEG = BIN === '' ? 'ffmpeg' : join(BIN, 'ffmpeg')
const FFPROBE = BIN === '' ? 'ffprobe' : join(BIN, 'ffprobe')
/**
 * Positive evidence only (AGENTS.md hard rule 6): a clean runner ships neither
 * program. `ffprobe` is in the gate because the recorder probes the segment it
 * encoded, so "ffmpeg but no ffprobe" has to skip rather than fail.
 */
const CAN_MEDIA = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0

/** Mean of one grayscale frame of a segment: "is this page light or dark". */
async function frameMean(file: string, atSeconds = 0): Promise<number> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(FFMPEG, [
      '-v', 'error',
      ...(atSeconds > 0 ? ['-ss', String(atSeconds)] : []),
      '-i', file,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))))
  })
  if (raw.length === 0) throw new Error(`no frame decoded from ${file}`)
  let total = 0
  for (const value of raw) total += value
  return total / raw.length
}

/**
 * Two pages whose brightness is unmistakable, one fragment each.
 *
 * Brightness is the cheapest thing a frame can prove: page 0 is nearly white, page 1
 * is nearly black, so "which page was on screen" needs no reference screenshot and no
 * absolute threshold (asserted relative to the light page below).
 */
const PAGES = `
<section data-background-color="#f8fafc">
  <h1 style="color:#111">第一页</h1>
  <p class="fragment" style="color:#111">第一拍</p>
</section>
<section data-background-color="#0b1220">
  <h1 style="color:#fff">第二页</h1>
  <p class="fragment" style="color:#fff">第二拍</p>
  <p class="fragment" style="color:#fff">第三拍（全片第 3 号，页内第 2 拍）</p>
</section>`

/** One page with three fragments, for the decks that must not need `teachPage`. */
const ONE_PAGE = `
<section data-background-color="#f8fafc">
  <h1 style="color:#111">只有一页</h1>
  <p class="fragment" style="color:#111">一拍</p>
  <p class="fragment" style="color:#111">二拍</p>
  <p class="fragment" style="color:#111">三拍</p>
</section>`

describe.skipIf(!CAN_RECORD || !CAN_MEDIA)('cue mode drives the pages its beats name', () => {
  const scaffold = async (label: string, slides: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), `teach-${label}-`))
    return writeDeck(join(root, 'slides', 's01'), { title: label, slides })
  }

  const record = async (
    deckPath: string,
    label: string,
    options: { cues: CueAt[], durationMs: number, startFragment?: number },
  ): ReturnType<typeof recordDeckSegment> => recordDeckSegment({
    deckPath,
    cues: options.cues,
    ...(options.startFragment === undefined ? {} : { startFragment: options.startFragment }),
    durationMs: options.durationMs,
    width: 640,
    height: 360,
    fps: 30,
    workDir: join(tmpdir(), `teach-cue-${label}-${Date.now()}`),
  })

  it('starts each sentence on the page of its first cue', async () => {
    const entry = await scaffold('cue-pages', PAGES)
    // Beat 1 is page 0's only fragment; beat 2 is the first fragment of page 1.
    const light = await record(entry, 'light', { cues: [cue(1)], durationMs: 800 })
    const dark = await record(entry, 'dark', { cues: [cue(2)], durationMs: 800 })
    const lightMean = await frameMean(light.path)
    const darkMean = await frameMean(dark.path)
    expect(lightMean).toBeGreaterThan(darkMean + 100)
  }, 120_000)

  it('turns the page at the beat that crosses into the next page', async () => {
    const entry = await scaffold('cue-cross', PAGES)
    const segment = await record(entry, 'cross', { cues: [{ atMs: 120, fragment: 1 }, { atMs: 700, fragment: 2 }], durationMs: 1600 })
    // Before the second beat the film is still on page 0; after it, on page 1.
    const early = await frameMean(segment.path, 0.35)
    const late = await frameMean(segment.path, 1.3)
    expect(early).toBeGreaterThan(late + 100)
    // The finished-layout check has to drive the deck to this page's *own* beat
    // number (1), not to the film-wide one (2): the wrong number lights an extra
    // beat and reports a cut-through-animation that never happened.
    expect(segment.settle.status).toBe('finished')
  }, 120_000)

  it('opens a sentence with no beat of its own on the picture the story reached', async () => {
    const entry = await scaffold('cue-inherit', PAGES)
    // Sentence 2 of a film whose first sentence ended on beat 2 (page 1, lit).
    const inherited = await record(entry, 'inherit', { cues: [], durationMs: 600, startFragment: 2 })
    const first = await record(entry, 'first', { cues: [cue(1)], durationMs: 600 })
    const inheritedMean = await frameMean(inherited.path)
    const firstMean = await frameMean(first.path)
    expect(previousOnPageOne(inheritedMean, firstMean)).toBe(true)
  }, 120_000)

  it('records a single-page cue deck that never defines teachPage', async () => {
    const entry = await scaffold('cue-onepage', ONE_PAGE)
    // The contract before multi-page support: `teachReady` + `teachCue`, nothing else.
    const html = await readFile(entry, 'utf8')
    await writeFile(entry, html.replace(/window\.teachPage = function[\s\S]*?\n}/, '/* no teachPage: one page needs none */'), 'utf8')
    // A late sentence on a single-page deck opens with earlier beats already lit —
    // the state that used to go through `teachPage` and failed on this deck.
    const segment = await record(entry, 'onepage', { cues: [{ atMs: 400, fragment: 2 }], durationMs: 1200 })
    expect(segment.frames).toBeGreaterThan(0)
  }, 120_000)
})

/** The inherited frame is the dark page; the film's first sentence opens on the light one. */
function previousOnPageOne(inherited: number, first: number): boolean {
  return inherited < first - 100
}
