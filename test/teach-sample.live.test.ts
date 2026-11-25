/**
 * The mixed sample: slides and Manim in one video, end to end, from the project
 * that ships in `fixtures/teach/sample/` (docs/TEACH-VIDEO.md §9, M5).
 *
 *   TEACH_VIDEO_SAMPLE=1 ARK_VOICE_API_KEY=… pnpm exec vitest run --config vitest.live.config.ts
 *
 * It spends real TTS money and records in real time, so it is the slowest check
 * here. Beyond M1/M2 it proves three things that the earlier version did not:
 *
 * - the sample is a *self-contained project* (manuscript, deck, three Manim
 *   scenes) rendered with no hand-holding;
 * - each engine's picture is actually painted: a white slide stage and a black
 *   animation both passed the old duration-only assertions (TEACH-VIDEO.md §16),
 *   so frames are now sampled and their distinct colour counts asserted;
 * - the Manim half is three scenes, not one animation repeated for a minute.
 */

import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { countFrameColors, probe } from '../src/teach/ffmpeg.ts'
import { assembleVideo, narrateSentences, planSegments, renderSegments, type TeachPaths } from '../src/teach/pipeline.ts'
import { buildSrt } from '../src/teach/subtitles.ts'
import { allSentences, parseStoryboard, reconcileTimings, totalDurationMs } from '../src/teach/storyboard.ts'

const LIVE = process.env.TEACH_VIDEO_SAMPLE === '1'
const KEY = process.env.ARK_VOICE_API_KEY ?? ''
const SAMPLE = fileURLToPath(new URL('../fixtures/teach/sample/', import.meta.url))
const CHROMIUM = process.env.TEACH_CHROMIUM ?? null
const PYTHON = process.env.TEACH_PYTHON ?? '/Users/baihaoran/.local/venvs/teach-video/bin/python3'
/** Left undefined on purpose: the renderer's own TeX discovery must find latex + dvisvgm. */
const TEXBIN = process.env.TEACH_TEXBIN

describe.skipIf(!LIVE)('mixed sample', () => {
  it('renders the shipped project, both engines, and every sampled frame has a picture', async () => {
    expect(KEY, 'set ARK_VOICE_API_KEY').not.toBe('')
    const root = await mkdtemp(join(tmpdir(), 'teach-sample-'))
    await cp(SAMPLE, root, { recursive: true })
    const board = parseStoryboard(await readFile(join(root, 'storyboard.yaml'), 'utf8'))
    const paths: TeachPaths = { root, audio: 'audio', timings: 'timings.json', work: '.dsh-video/teach', segments: '.dsh-video/teach/segments' }

    const narrated = await narrateSentences({ board, voice: board.voice!, apiKey: KEY, paths })
    expect(reconcileTimings(board, narrated.timings)).toEqual([])
    console.log(`sample: ${narrated.timings.sentences.length} sentences, ${narrated.durationMs} ms of narration`)

    const rendered = await renderSegments({
      board,
      timings: narrated.timings,
      paths,
      chromiumPath: CHROMIUM,
      tools: { pythonPath: PYTHON, ...(TEXBIN === undefined ? {} : { texBinPath: TEXBIN }) },
    })
    expect(rendered).toHaveLength(narrated.timings.sentences.length)

    // The Manim half must be three scenes, not one animation replayed nine times.
    const sceneFiles = new Set(board.segments.filter(segment => segment.engine === 'manim').map(segment => segment.scene))
    expect(sceneFiles.size).toBe(3)

    const plan = await planSegments(paths, narrated.timings, rendered)
    const output = join(root, 'renders', 'sample', 'v001.mp4')
    await mkdir(join(root, 'renders', 'sample'), { recursive: true })
    await assembleVideo({ paths, segments: plan.segments, video: board.video, output })
    const final = await probe(output)
    const expected = totalDurationMs(narrated.timings)
    expect(Math.abs((final.durationMs ?? 0) - expected)).toBeLessThan(200)
    expect(final.hasAudio).toBe(true)
    expect(final.width).toBe(1920)

    // Where each engine's sentences sit on the assembled timeline.
    let offset = 0
    const spans: { id: string, engine: string, start: number, end: number }[] = []
    const sentences = allSentences(board)
    for (const [index, timed] of narrated.timings.sentences.entries()) {
      const engine = sentences[index]!.segment.engine
      spans.push({ id: timed.id, engine, start: offset, end: offset + timed.durationMs })
      offset += timed.durationMs
    }
    const slides = spans.filter(span => span.engine === 'slides')
    const manim = spans.filter(span => span.engine === 'manim')
    expect(slides.length).toBeGreaterThan(2)
    expect(manim.length).toBeGreaterThan(2)

    // Three frames from the slide stretch, two from the Manim stretch. A flat
    // frame is one colour; both defects this check exists for were flat.
    const samples = [
      ...slides.filter((_, index) => index === 0 || index === Math.floor(slides.length / 2) || index === slides.length - 1),
      ...manim.filter((_, index) => index === 0 || index === manim.length - 1),
    ]
    const report: { id: string, engine: string, atSeconds: number, colors: number }[] = []
    for (const span of samples) {
      const atSeconds = (span.start + Math.min(1200, (span.end - span.start) / 2)) / 1000
      const colors = await countFrameColors(output, { atSeconds })
      report.push({ id: span.id, engine: span.engine, atSeconds, colors })
      expect(colors, `frame at ${atSeconds.toFixed(1)}s (${span.id}, ${span.engine}) is a single flat colour`).toBeGreaterThan(1)
    }
    console.log(`frame colours: ${JSON.stringify(report)}`)

    // The side products the export tool writes, produced the same way.
    const srt = buildSrt(narrated.timings)
    await writeFile(join(root, 'renders', 'sample', 'v001.srt'), srt, 'utf8')
    expect(srt.split('\n\n').length).toBeGreaterThan(20)
    // Optional publish: makes the acceptance run leave a watchable file behind.
    const publish = process.env.TEACH_SAMPLE_OUT
    if (publish !== undefined && publish !== '') {
      await mkdir(dirname(publish), { recursive: true })
      const { copyFile } = await import('node:fs/promises')
      await copyFile(output, publish)
      await writeFile(publish.replace(/\.mp4$/, '.srt'), srt, 'utf8')
      console.log(`published ${publish}`)
    }
    const info = await stat(output)
    console.log(`sample ok: ${expected} ms narration → ${final.durationMs} ms video, ${(info.size / 1_048_576).toFixed(1)} MB, ${plan.segments.length} segments`)
  }, 900_000)
})
