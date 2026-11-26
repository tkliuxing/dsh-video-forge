/**
 * B13 / D3: cross-sentence transitions (docs/TEACH-MOTION.md §6, §7).
 *
 * The seam belongs to the *earlier* sentence's tail: the recorder finishes the body,
 * switches the deck's page, and keeps recording, so the deck's own page transition —
 * and with it Auto-Animate — lands in the finished picture. Three things this file
 * pins, in the order the doc claims them:
 *
 * 1. **Who gets a transition.** Same deck, same engine, a different page, and only in
 *    page mode. Everything else is a hard cut with a reason attached, never a silent
 *    degradation.
 * 2. **The account.** A segment is `durationMs + exitMs` long, the timeline says so,
 *    and the SRT and the audio track follow the same number. Every earlier build read
 *    `durationMs` alone, which is why the seam is checked against the assembled film
 *    and not only against the segment files.
 * 3. **The seam is continuous.** The next sentence's first frame is the same picture
 *    the previous segment ended on — the whole point of recording the switch at the
 *    tail. A deck with no transition would pass a "the segment got longer" check, so
 *    the test also asserts that the body's last frame is a *different* page.
 *
 * The unit half runs anywhere. The recording half needs ffmpeg and a Chromium, so it
 * is gated on both answering for themselves (AGENTS.md rule 6).
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { frameDelta, probe } from '../src/teach/ffmpeg.ts'
import { assembleVideo, planSegments, renderSegments, type TeachPaths } from '../src/teach/pipeline.ts'
import { auditDecks, auditManuscript, fragmentVariants, overridesFragmentTransition, type DeckInfo } from '../src/teach/rules.ts'
import { exitSlots, parseStoryboard, parseTimings, serializeTimings, timelineDurationMs, type Timings } from '../src/teach/storyboard.ts'
import { buildSrt } from '../src/teach/subtitles.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', 'fixtures', 'teach', 'transition')

const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const FFMPEG = BIN === '' ? 'ffmpeg' : join(BIN, 'ffmpeg')
const FFPROBE = BIN === '' ? 'ffprobe' : join(BIN, 'ffprobe')
const MEDIA = BIN === '' ? {} : { ffmpegPath: FFMPEG, ffprobePath: FFPROBE }

/** Positive evidence only: both programs have to answer for themselves. */
const CAN_MEDIA = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0
  && spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0
const CAN_RECORD = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

const MANUSCRIPT = `meta:
  title: 跨句转场
  voice:
    speaker: stella
  transition:
    mode: deck
    durationMs: 420
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 第一页讲问题，句子念完之后画面才翻到第二页。
        cues: [{ fragment: 1, at_progress: 0.45 }]
      - id: s01-2
        say: 翻页发生在上一句的尾部，所以这一句一开口就是完整画面。
        cues: [{ fragment: 1, at_progress: 0.5 }]
      - id: s01-3
        say: 最后一句的尾部没有下一句，所以它是硬切收尾。
`

describe('the manuscript decides whether and how long, never what', () => {
  it('parses a declared tail transition and the per-sentence override', () => {
    const board = parseStoryboard(MANUSCRIPT.replace('        say: 最后一句', '        transition: none\n        say: 最后一句'))
    expect(board.transition).toEqual({ mode: 'deck', durationMs: 420 })
    expect(board.segments[0]!.sentences[2]!.transition).toBe('none')
    expect(board.segments[0]!.sentences[0]!.transition).toBeNull()
  })

  it('refuses a duration it would have to guess at', () => {
    expect(() => parseStoryboard(MANUSCRIPT.replace('durationMs: 420', 'durationMs: 50'))).toThrowError(/100–1200/)
    expect(() => parseStoryboard(MANUSCRIPT.replace('durationMs: 420', 'durationMs: 2000'))).toThrowError(/100–1200/)
    // A mode with no duration is not "the default 400": it is an unanswered question.
    expect(() => parseStoryboard(MANUSCRIPT.replace('    durationMs: 420\n', ''))).toThrowError(/durationMs/)
    expect(() => parseStoryboard(MANUSCRIPT.replace('mode: deck', 'mode: none'))).toThrowError(/durationMs means nothing/)
    expect(() => parseStoryboard(MANUSCRIPT.replace('mode: deck', 'mode: slide'))).toThrowError(/"deck" or "none"/)
  })

  it('refuses a per-sentence shape, because that is the deck\'s business', () => {
    expect(() => parseStoryboard(MANUSCRIPT.replace('        say: 最后一句', '        transition: fade\n        say: 最后一句'))).toThrowError(/only "none"/)
  })
})

describe('which seams carry a transition', () => {
  it('gives the first two sentences a 420 ms tail that lands on the next page', () => {
    const board = parseStoryboard(MANUSCRIPT)
    const exits = exitSlots(board, 'page')
    expect(exits.get('s01-1')).toEqual({ id: 's01-1', exitMs: 420, target: { page: 1, enter: 0 }, dropped: null })
    expect(exits.get('s01-2')).toEqual({ id: 's01-2', exitMs: 420, target: { page: 2, enter: 0 }, dropped: null })
    // The last sentence has no next picture: the film ends on it.
    expect(exits.get('s01-3')).toEqual({ id: 's01-3', exitMs: 0, target: null, dropped: 'segment-end' })
  })

  it('drops it where there is no page to turn to, and says why', () => {
    const shared = parseStoryboard(`meta:
  title: shared
  voice:
    speaker: stella
  transition: { mode: deck, durationMs: 420 }
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 第一句开口说同一页上的第一块，画面不翻页。
        page: 0
      - id: s01-2
        say: 第二句接在同一页上，所以这里不会有转场，只有拍子。
        page: 0
`)
    const exits = exitSlots(shared, 'page')
    expect(exits.get('s01-1')).toMatchObject({ exitMs: 0, dropped: 'same-page' })
    expect(exits.get('s01-2')).toMatchObject({ exitMs: 0, dropped: 'segment-end' })
  })

  it('drops it in cue mode, on a manim segment, and where the author says so', () => {
    const board = parseStoryboard(MANUSCRIPT.replace('        say: 最后一句', '        transition: none\n        say: 最后一句'))
    expect(exitSlots(board, 'cue').get('s01-1')).toMatchObject({ exitMs: 0, dropped: 'cue-mode' })
    expect(exitSlots(board, 'page').get('s01-3')).toMatchObject({ exitMs: 0, dropped: 'by-sentence' })

    const manim = parseStoryboard(`meta:
  title: manim
  voice:
    speaker: stella
  transition: { mode: deck, durationMs: 420 }
segments:
  - id: s01
    engine: manim
    scene: scenes/s01.py
    sentences:
      - id: s01-1
        say: 这一段是 Python 画的，没有下一页可以翻。
`)
    expect(exitSlots(manim, 'page').get('s01-1')).toMatchObject({ exitMs: 0, dropped: 'manim' })
  })

  it('records nothing at all when the manuscript asks for nothing', () => {
    const board = parseStoryboard(MANUSCRIPT.replace('  transition:\n    mode: deck\n    durationMs: 420\n', ''))
    expect(board.transition).toBeNull()
    for (const slot of exitSlots(board, 'page').values()) {
      expect(slot.exitMs).toBe(0)
      expect(slot.dropped).toBeNull()
    }
  })
})

describe('what the plan says about the seams', () => {
  const deck = (patch: Partial<DeckInfo> = {}): Map<string, DeckInfo> => new Map([['s01', {
    path: 'slides/s01/index.html',
    fragments: 1,
    pageFragments: [1, 1, 1],
    transitionMs: null,
    pageTransitionMs: null,
    overridesFragmentTransition: false,
    nestedSections: false,
    fragmentVariants: { dim: 0, plain: 0, custom: 0 },
    pageVariants: null,
    hasCue: true,
    hasPage: true,
    hasReady: true,
    ...patch,
  }]])

  it('leaves a page-mode manuscript with meta.transition alone', () => {
    // The negative control for the cue-mode refusal: page mode *is* the route a tail
    // transition was written for, and a manuscript with the default voice must not be
    // refused by the same check.
    const board = parseStoryboard(MANUSCRIPT)
    expect(auditManuscript(board).structural).toEqual([])
  })

  it('refuses a declared transition in cue mode, where the landing state is the deck\'s to work out', () => {
    const board = parseStoryboard(MANUSCRIPT.replace('  voice:\n    speaker: stella', '  voice:\n    provider: volcengine\n    speaker: zh_female_liuchangnv_uranus_bigtts'))
    const audit = auditManuscript(board)
    expect(audit.structural.join(' ')).toContain('meta.transition is set')
    expect(audit.structural.join(' ')).toContain('not knowable from the manuscript')
    expect(audit.structural.join(' ')).toContain('meta.transition.mode: none')
  })

  it('warns when the tail is shorter than the deck\'s own page switch', () => {
    const board = parseStoryboard(MANUSCRIPT)
    const audit = auditDecks(board, deck({ pageTransitionMs: 500 }))
    expect(audit.warnings.join('\n')).toContain('declares window.teachPageTransition = 500')
    expect(audit.warnings.join('\n')).toContain('cuts mid-transition')
  })

  it('warns about the same-page seam, the last segment, and a tail longer than the next line', () => {
    const shared = parseStoryboard(MANUSCRIPT.replace('      - id: s01-2\n        say:', '      - id: s01-2\n        page: 0\n        say:').replace('      - id: s01-3', '      - id: s01-3\n        page: 0'))
    const findings = auditDecks(shared, deck({ pageFragments: [2] })).warnings.join('\n')
    expect(findings).toContain('ends on the same page as')
    expect(findings).toContain('stays a hard cut')

    const twoSegments = parseStoryboard(`${MANUSCRIPT}  - id: s02
    engine: slides
    deck: slides/s02/index.html
    sentences:
      - id: s02-1
        say: 第二段的第一句，前面那段收在硬切上。
`)
    const decks = new Map([...deck(), ['s02', { ...deck().get('s01')!, path: 'slides/s02/index.html' }]] as [string, DeckInfo][])
    expect(auditDecks(twoSegments, decks).warnings.join('\n')).toContain('ends with a hard cut after "s01-3"')

    // A 420 ms tail into a 200 ms line: the transition is longer than what follows.
    const board = parseStoryboard(MANUSCRIPT)
    const short = new Map([['s01-2', { durationMs: 200, cueMs: [], estimated: true }]])
    expect(auditDecks(board, deck(), { beats: short }).warnings.join('\n')).toContain('is only 200 ms long')
  })

  it('finds the two D0 pitfalls in the deck\'s own CSS and markup', () => {
    const overriding = '<style>.reveal .fragment { transition: opacity 180ms ease; }</style>'
    expect(overridesFragmentTransition(overriding)).toBe(true)
    expect(overridesFragmentTransition('<style>.reveal .fragment{color:#fff}</style>')).toBe(false)
    // The shipped template does all three of these, and none of them is the defect:
    // a variant is the author choosing a property, `transition-duration` is the
    // documented way to retime, and a comment that quotes the bad rule is a comment.
    expect(overridesFragmentTransition(`<style>
      .reveal .slides .fragment { transition-duration: var(--teach-dur); }
      .reveal .slides .fragment.dim { transition: opacity var(--teach-dur) ease; }
      /* do not write \`.reveal .fragment { transition: all .2s }\` — it wins */
    </style>`)).toBe(false)
    expect(fragmentVariants('<div class="fragment dim"></div><div class="fragment"></div>')).toEqual({ dim: 1, plain: 1, custom: 0 })

    const board = parseStoryboard(MANUSCRIPT)
    const findings = auditDecks(board, deck({ overridesFragmentTransition: true, fragmentVariants: { dim: 2, plain: 1, custom: 0 } })).warnings.join('\n')
    expect(findings).toContain('collapses into a jump')
    expect(findings).toContain('mixes dimmed and plain reveal-fade fragments on page 1')
  })
})

describe('the timeline account', () => {
  const timings: Timings = {
    voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
    sentences: [
      { id: 'a', text: '第一句。', audio: 'audio/a.wav', durationMs: 2000, exitMs: 420, words: [] },
      { id: 'b', text: '第二句。', audio: 'audio/b.wav', durationMs: 1000, exitMs: 0, words: [] },
    ],
  }

  it('counts the picture, not only the narration', () => {
    expect(timelineDurationMs(timings)).toBe(3420)
    expect(parseTimings(serializeTimings(timings))).toEqual(timings)
  })

  it('starts the second sentence after the first one\'s tail transition', () => {
    const srt = buildSrt(timings)
    expect(srt).toContain('00:00:00,000 --> 00:00:02,000\n第一句。')
    expect(srt).toContain('00:00:02,420 --> 00:00:03,420\n第二句。')
  })

  it('reads a timings file written before the field existed as a hard cut', () => {
    const legacy = JSON.stringify({
      voice: timings.voice,
      sentences: [{ id: 'a', text: '第一句。', audio: 'audio/a.wav', durationMs: 2000, words: [] }],
    })
    expect(parseTimings(legacy).sentences[0]!.exitMs).toBe(0)
  })
})

/**
 * A silent audio file of the given length: the only thing the clock needs.
 *
 * Uncompressed PCM on purpose, and `.wav` to match what page mode writes
 * (`audio/<id>.wav` from the DeepSeek voice). An mp3 in a `.wav` name decodes to more
 * samples than `durationMs` claims — encoder delay and end padding are not in the
 * reported duration — and a length assertion would then be measuring the codec, not
 * the seam.
 */
async function silentAudio(path: string, durationMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono:d=${(durationMs / 1000).toFixed(3)}`, '-c:a', 'pcm_s16le', path])
  if (result.status !== 0) throw new Error(`could not write ${path}: ${result.stderr.toString().slice(0, 200)}`)
}

/** One frame of a video at `seconds`, as a PNG the delta helper can read. */
function grab(file: string, seconds: number, output: string): string {
  const result = spawnSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(seconds), '-i', file, '-frames:v', '1', output])
  if (result.status !== 0) throw new Error(`could not grab a frame of ${file}: ${result.stderr.toString().slice(0, 200)}`)
  return output
}

describe.skipIf(!CAN_MEDIA || !CAN_RECORD)('a tail transition, recorded and assembled', () => {
  /** The fixture copied into a scratch project, with three silent sentences. */
  async function project(): Promise<{ root: string, paths: TeachPaths, timings: Timings, board: ReturnType<typeof parseStoryboard> }> {
    const root = await mkdtemp(join(tmpdir(), 'teach-exit-'))
    await cp(join(FIXTURE, 'slides'), join(root, 'slides'), { recursive: true })
    const board = parseStoryboard(await readFile(join(FIXTURE, 'storyboard.yaml'), 'utf8'))
    const paths: TeachPaths = { root, audio: 'audio', timings: 'timings.json', work: '.dsh-video/teach', segments: '.dsh-video/teach/segments' }
    // The tail is seeded as 0 on purpose: `renderSegments` is the writer of record,
    // and this is what proves the ledger is rewritten with what was recorded.
    const timings: Timings = {
      voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
      sentences: [
        { id: 's01-1', text: board.segments[0]!.sentences[0]!.say, audio: 'audio/s01-1.wav', durationMs: 1800, exitMs: 0, words: [] },
        { id: 's01-2', text: board.segments[0]!.sentences[1]!.say, audio: 'audio/s01-2.wav', durationMs: 1800, exitMs: 0, words: [] },
        { id: 's01-3', text: board.segments[0]!.sentences[2]!.say, audio: 'audio/s01-3.wav', durationMs: 1800, exitMs: 0, words: [] },
      ],
    }
    // The timeline records the audio's *measured* length, the way narration does: a
    // synthetic 1800 ms file decodes a frame longer than 1800, and the film is as
    // long as the longer of picture and narration.
    for (const sentence of timings.sentences) {
      const file = join(root, sentence.audio)
      await silentAudio(file, sentence.durationMs)
      const media = await probe(file, MEDIA)
      if (media.durationMs === null) throw new Error(`ffprobe reported no duration for ${file}`)
      sentence.durationMs = media.durationMs
    }
    return { root, paths, timings, board }
  }

  it('records the switch in the body\'s segment, keeps the seam continuous, and assembles to the timeline', async () => {
    const { root, paths, timings, board } = await project()
    const rendered = await renderSegments({ board, timings, paths, tools: MEDIA })
    expect(rendered.map(segment => segment.exitMs)).toEqual([420, 420, 0])

    // 1. The ledger is the recorded truth, on disk.
    const written = parseTimings(await readFile(join(root, paths.timings), 'utf8'))
    expect(written.sentences.map(sentence => sentence.exitMs)).toEqual([420, 420, 0])

    // 2. A segment is `durationMs + exitMs` long, to within a frame or two.
    const lengths = await Promise.all(rendered.map(segment => probe(segment.path, MEDIA).then(media => media.durationMs)))
    const body = timings.sentences.map(sentence => sentence.durationMs)
    for (const [index, exit] of [420, 420, 0].entries()) {
      expect(Math.abs((lengths[index] ?? 0) - (body[index]! + exit))).toBeLessThan(40)
    }

    // 3. The seam is continuous: segment 2 starts on the picture segment 1 ended on.
    const seam = await frameDelta(
      grab(rendered[0]!.path, (body[0]! + 390) / 1000, join(root, 'end-of-1.png')),
      grab(rendered[1]!.path, 0, join(root, 'start-of-2.png')),
      {}, MEDIA,
    )
    expect(seam.changed).toBeLessThan(0.01)

    // 4. …and the tail really did record the switch, so 3 is not the trivial result
    //    of a deck that never turns a page: the segment's own picture changes
    //    between the end of the body and the end of the tail.
    const tail = await frameDelta(
      grab(rendered[0]!.path, (body[0]! - 40) / 1000, join(root, 'body-of-1.png')),
      grab(rendered[0]!.path, (body[0]! + 390) / 1000, join(root, 'tail-of-1.png')),
      {}, MEDIA,
    )
    expect(tail.changed).toBeGreaterThan(0.03)

    // 5. The film is as long as the timeline says, and the audio follows the same
    //    account: a stale or double-counted tail is hundreds of milliseconds.
    const plan = await planSegments(paths, written, rendered, {}, MEDIA)
    expect(plan.stale).toEqual([])
    const assembled = await assembleVideo({
      paths,
      segments: plan.segments,
      video: board.video,
      output: join(root, 'film.mp4'),
      tools: MEDIA,
    })
    expect(assembled.expectedMs).toBe(body.reduce((sum, value) => sum + value, 0) + 420 * 2)
    expect(Math.abs((assembled.durationMs ?? 0) - assembled.expectedMs)).toBeLessThan(60)
    // The SRT follows the same account: the second line starts after the first
    // sentence's body *and* its tail transition.
    const second = body[0]! + 420
    const stamp = (ms: number): string => `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')} --> `
    expect(buildSrt(written)).toContain(stamp(second))
  }, 300_000)

  it('calls a reused segment whose tail changed since it was recorded stale', async () => {
    const { paths, timings, board } = await project()
    const rendered = await renderSegments({ board, timings, paths, tools: MEDIA })
    // The manuscript stops asking for transitions after the fact: the segments on
    // disk are still 420 ms longer than the ledger now says.
    const edited = parseTimings(await readFile(join(paths.root, paths.timings), 'utf8'))
    edited.sentences[0]!.exitMs = 0
    const plan = await planSegments(paths, edited, rendered.filter(segment => segment.id !== 's01-1'), {}, MEDIA)
    expect(plan.reused).toContain('s01-1')
    expect(plan.stale.join('\n')).toContain('sentence "s01-1"')
    expect(plan.stale.join('\n')).toContain('Re-record it')
  }, 300_000)
})
