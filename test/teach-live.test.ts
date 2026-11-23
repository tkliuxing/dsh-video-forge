/**
 * The teaching pipeline against the real services (M1 and M2 acceptance).
 *
 * Switched on with `TEACH_VIDEO_LIVE=1`; spends real TTS money (a few sentences)
 * and needs `ffmpeg`, a Playwright Chromium, and — for the Manim leg — a Python
 * with Manim plus a TeX with `dvisvgm`.
 *
 *   TEACH_VIDEO_LIVE=1 ARK_VOICE_API_KEY=… pnpm exec vitest run --config vitest.live.config.ts
 *
 * What it pins is what docs/TEACH-VIDEO.md §9 promises:
 *
 * - M1: one sentence, text to mp4, the picture's length following the audio's
 *   real duration to within one frame (50 ms).
 * - M2: several sentences across two engines, assembled from per-sentence
 *   segments, where re-recording one sentence leaves the other segments on disk
 *   untouched. A failure here is a service or toolchain change, not a fixture
 *   lying.
 */

import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { writeDeck } from '../src/teach/deck.ts'
import { countFrameColors, probe } from '../src/teach/ffmpeg.ts'
import {
  assembleVideo,
  cuesFor,
  narrateSentences,
  planSegments,
  planStoryboard,
  renderSegments,
  segmentPath,
  type TeachPaths,
} from '../src/teach/pipeline.ts'
import { allSentences, parseStoryboard, reconcileTimings, totalDurationMs } from '../src/teach/storyboard.ts'

const LIVE = process.env.TEACH_VIDEO_LIVE === '1'
const KEY = process.env.ARK_VOICE_API_KEY ?? ''
const FIXTURES = fileURLToPath(new URL('../fixtures/teach/', import.meta.url))
const CHROMIUM = process.env.TEACH_CHROMIUM ?? null
const PYTHON = process.env.TEACH_PYTHON ?? '/Users/baihaoran/.local/venvs/teach-video/bin/python3'
const TEXBIN = process.env.TEACH_TEXBIN ?? '/Users/baihaoran/Library/TinyTeX/bin/universal-darwin'

/** Three cues inside one reveal.js slide; each is one `fragment` element. */
const SLIDES = `<section>
  <h1>为什么 1 + 1/4 + 1/9 + … = π²/6</h1>
  <div class="fragment row">1/1²<span class="value">= 1</span></div>
  <div class="fragment row">1/2²<span class="value">= 0.25</span></div>
  <div class="fragment row">1/3²<span class="value">≈ 0.111</span></div>
</section>`

const STORYBOARD = `meta:
  title: 部分和为什么收敛到 π²/6
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 先看前几项完全平方数的倒数。
        cues:
          - { fragment: 1, at_word: 先看 }
          - { fragment: 2, at_word: 倒数 }
      - id: s01-2
        say: 把它们一项项加起来。
        cues:
          - { fragment: 3, at_word: 加起来 }
  - id: s02
    engine: manim
    scene: scenes/s02.py
    sentences:
      - id: s02-1
        say: 把这些部分和画成折线，它会逼近一条水平线。
`

const M1_STORYBOARD = `meta:
  title: 单句最小闭环
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 先看前几项完全平方数的倒数，把它们一项项加起来。
        cues:
          - { fragment: 1, at_word: 先看 }
          - { fragment: 2, at_word: 前几项 }
          - { fragment: 3, at_word: 加起来 }
`

/** A project directory with a scaffolded reveal.js deck and the Manim scene. */
async function project(label: string): Promise<TeachPaths> {
  const root = await mkdtemp(join(tmpdir(), `teach-${label}-`))
  await mkdir(join(root, 'scenes'), { recursive: true })
  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(FIXTURES, 'scenes', 's02.py'), join(root, 'scenes', 's02.py'))
  await writeDeck(join(root, 'slides', 's01'), { title: '部分和', slides: SLIDES })
  return { root, audio: 'audio', timings: 'timings.json', work: '.dsh-video/teach', segments: '.dsh-video/teach/segments' }
}

describe.skipIf(!LIVE)('teaching pipeline, live', () => {
  it('needs a voice credential before it can spend anything', () => {
    expect(KEY, 'set ARK_VOICE_API_KEY').not.toBe('')
  })

  it('plans without touching the network', () => {
    const plan = planStoryboard(parseStoryboard(STORYBOARD))
    expect(plan.sentences.map(sentence => sentence.id)).toEqual(['s01-1', 's01-2', 's02-1'])
    expect(plan.totalChars).toBeGreaterThan(20)
  })

  it('M1: one sentence, narrated, recorded, assembled — picture follows audio', async () => {
    const board = parseStoryboard(M1_STORYBOARD)
    const paths = await project('m1')
    const narrated = await narrateSentences({ board, voice: board.voice!, apiKey: KEY, paths })
    expect(reconcileTimings(board, narrated.timings)).toEqual([])
    const timed = narrated.timings.sentences[0]!
    expect(timed.words.length).toBeGreaterThan(8)

    const rendered = await renderSegments({ board, timings: narrated.timings, paths, chromiumPath: CHROMIUM })
    expect(rendered).toHaveLength(1)
    const segment = await probe(rendered[0]!.path)
    expect(Math.abs((segment.durationMs ?? 0) - timed.durationMs)).toBeLessThan(50)
    expect(segment.fps).toBe(30)
    expect(segment.width).toBe(1920)
    expect(segment.height).toBe(1080)

    const output = join(paths.root, 'renders', 'm1', 'v001.mp4')
    await mkdir(join(paths.root, 'renders', 'm1'), { recursive: true })
    const plan = await planSegments(paths, narrated.timings, rendered)
    const assembled = await assembleVideo({ paths, segments: plan.segments, video: board.video, output })
    const final = await probe(output)
    expect(Math.abs((final.durationMs ?? 0) - totalDurationMs(narrated.timings))).toBeLessThan(50)
    expect(final.hasAudio).toBe(true)
    // Duration alone let a white stage and a black animation both pass (TEACH-VIDEO.md §16).
    expect(await countFrameColors(output, { atSeconds: 1.5 })).toBeGreaterThan(1)
    console.log(`M1 ok: audio ${timed.durationMs} ms → video ${final.durationMs} ms, ${plan.segments.length} segment(s)`)
    expect(assembled.durationMs).toBe(final.durationMs)
  }, 180_000)

  it('M2: re-recording one sentence keeps the others, and the timeline stays whole', async () => {
    const board = parseStoryboard(STORYBOARD)
    const paths = await project('m2')
    const narrated = await narrateSentences({ board, voice: board.voice!, apiKey: KEY, paths })
    expect(reconcileTimings(board, narrated.timings)).toEqual([])
    expect(narrated.timings.sentences.map(sentence => sentence.id)).toEqual(['s01-1', 's01-2', 's02-1'])

    // First pass: the two slide sentences, one call at a time.
    const first = await renderSegments({ board, timings: narrated.timings, paths, chromiumPath: CHROMIUM, only: ['s01-1'] })
    expect(first.map(segment => segment.id)).toEqual(['s01-1'])
    const before = await stat(segmentPath(paths, 's01-1'))
    const second = await renderSegments({ board, timings: narrated.timings, paths, chromiumPath: CHROMIUM, only: ['s01-2'] })
    expect(second.map(segment => segment.id)).toEqual(['s01-2'])

    // Re-recording sentence 2 must not touch sentence 1's segment.
    const after = await stat(segmentPath(paths, 's01-1'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)

    // The manim sentence renders through the other engine and lands at the same path shape.
    const third = await renderSegments({
      board,
      timings: narrated.timings,
      paths,
      only: ['s02-1'],
      tools: { pythonPath: PYTHON, texBinPath: TEXBIN },
    })
    expect(third.map(segment => segment.id)).toEqual(['s02-1'])
    const manimMedia = await probe(segmentPath(paths, 's02-1'))
    const manimTiming = narrated.timings.sentences[2]!
    expect(Math.abs((manimMedia.durationMs ?? 0) - manimTiming.durationMs)).toBeLessThan(50)
    expect(await countFrameColors(segmentPath(paths, 's02-1'), { atSeconds: 2 })).toBeGreaterThan(1)

    const plan = await planSegments(paths, narrated.timings, third)
    expect(plan.segments.map(segment => segment.id)).toEqual(['s01-1', 's01-2', 's02-1'])
    expect(plan.reused).toEqual(['s01-1', 's01-2'])
    expect(plan.fresh).toEqual(['s02-1'])

    const output = join(paths.root, 'renders', 'm2', 'v001.mp4')
    await mkdir(join(paths.root, 'renders', 'm2'), { recursive: true })
    await assembleVideo({ paths, segments: plan.segments, video: board.video, output })
    const final = await probe(output)
    const expected = totalDurationMs(narrated.timings)
    expect(Math.abs((final.durationMs ?? 0) - expected)).toBeLessThan(50)
    expect(final.hasAudio).toBe(true)
    expect(final.width).toBe(1920)
    const info = await stat(output)
    console.log(`M2 ok: ${plan.reused.length} reused + ${plan.fresh.length} fresh, audio ${expected} ms → video ${final.durationMs} ms, ${info.size} bytes`)
  }, 300_000)

  it('drives the cues onto the words they name', () => {
    const board = parseStoryboard(STORYBOARD)
    const sentence = allSentences(board)[0]!.sentence
    const timed = {
      id: sentence.id,
      text: sentence.say,
      audio: 'audio/s01-1.mp3',
      durationMs: 4000,
      words: [
        { t: '先看', b: 120, e: 480 },
        { t: '前几项', b: 900, e: 1400 },
        { t: '倒数', b: 2100, e: 2600 },
      ],
    }
    expect(cuesFor(timed, sentence.cues)).toEqual([
      { atMs: 120, fragment: 1 },
      { atMs: 2100, fragment: 2 },
    ])
  })

  it('refuses to assemble a timeline that is missing a segment', async () => {
    const board = parseStoryboard(STORYBOARD)
    const paths = await project('missing')
    const timings = {
      voice: { provider: 'volcengine', speaker: 'zh_female_liuchangnv_uranus_bigtts', speedRatio: null },
      sentences: [
        { id: 's01-1', text: '一。', audio: 'audio/s01-1.mp3', durationMs: 1000, words: [{ t: '一', b: 0, e: 400 }] },
      ],
    }
    board.segments.length = 0
    await expect(planSegments(paths, timings)).rejects.toThrow(/no picture for "s01-1"/)
  })
})
