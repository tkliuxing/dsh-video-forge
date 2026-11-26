/**
 * Narration mechanics: how sentences become requests, and how a request becomes
 * per-sentence audio with audible breaks (docs/TEACH-VIDEO.md §18).
 *
 * The user's listening verdict drove all of this: merged requests sound like one
 * person, but the earlier build cut every tail to a flat 180 ms, so the sentence
 * breaks vanished. These checks pin the four things that fix it — one request per
 * run, boundaries at the next sentence's first word, pauses chosen by punctuation
 * and only ever padded, and an integer speech rate.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cutAudioSegment, probe } from '../src/teach/ffmpeg.ts'
import { MAX_UTTERANCE_CHARS, planSegments, planUtterances, segmentPath, segmentTiming, type TeachPaths } from '../src/teach/pipeline.ts'
import { parseStoryboard, parseTimings, serializeTimings } from '../src/teach/storyboard.ts'
import type { TimedSentence, TimedWord, Timings } from '../src/teach/storyboard.ts'
import {
  assignWordsToSpans,
  joinUtterance,
  normalizeSpeedRatio,
  sentenceEndPauseMs,
  SENTENCE_PAUSE_MS,
  VoiceError,
} from '../src/teach/voice.ts'

const words = (pairs: [string, number, number][]): TimedWord[] => pairs.map(([t, b, e]) => ({ t, b, e }))

describe('pause policy', () => {
  it('reads the pause off the sentence’s own final punctuation', () => {
    expect(sentenceEndPauseMs('先看一个完全平方数的倒数。')).toBe(SENTENCE_PAUSE_MS.sentence)
    expect(sentenceEndPauseMs('它为什么会收敛？')).toBe(SENTENCE_PAUSE_MS.question)
    expect(sentenceEndPauseMs('注意这里！')).toBe(SENTENCE_PAUSE_MS.question)
    expect(sentenceEndPauseMs('因为分母是平方增长，')).toBe(SENTENCE_PAUSE_MS.clause)
    expect(sentenceEndPauseMs('没有标点的一句')).toBe(SENTENCE_PAUSE_MS.none)
  })

  it('orders the pauses the way a speaker would: statement < question, clause < statement', () => {
    expect(SENTENCE_PAUSE_MS.sentence).toBeGreaterThan(SENTENCE_PAUSE_MS.clause)
    expect(SENTENCE_PAUSE_MS.question).toBeGreaterThan(SENTENCE_PAUSE_MS.sentence)
    expect(SENTENCE_PAUSE_MS.none).toBeLessThan(SENTENCE_PAUSE_MS.clause)
  })
})

describe('joining sentences into one request', () => {
  it('separates with a full stop and repairs a missing one, never doubling it', () => {
    const join = joinUtterance(['先看倒数。', '它们加起来', '会收敛吗？'])
    expect(join.parts).toEqual(['先看倒数。', '它们加起来。', '会收敛吗？'])
    expect(join.text).toBe('先看倒数。它们加起来。会收敛吗？')
    expect(join.spans).toEqual([{ start: 0, end: 5 }, { start: 5, end: 11 }, { start: 11, end: 16 }])
  })

  it('keeps a clause-final comma as it is, because that is a clause break, not a sentence', () => {
    const join = joinUtterance(['因为分母是平方增长，', '所以衰减很快。'])
    expect(join.text).toBe('因为分母是平方增长，所以衰减很快。')
    expect(join.parts[0]!.endsWith('，')).toBe(true)
  })

  it('drops blank entries instead of synthesizing whitespace', () => {
    const join = joinUtterance(['好。', '   ', '不好。'])
    expect(join.parts).toEqual(['好。', '不好。'])
  })
})

describe('mapping returned words back to sentences', () => {
  it('assigns by character position, so a merged or re-split answer still lands right', () => {
    const join = joinUtterance(['先看倒数。', '它们加起来。'])
    // The service glued the punctuation onto words; positions still line up.
    const returned = words([['先', 0, 200], ['看', 200, 400], ['倒数。', 400, 900], ['它们', 900, 1200], ['加起来。', 1200, 1700]])
    expect(assignWordsToSpans(returned, join.spans)).toEqual([0, 0, 0, 1, 1])
  })

  // The defect this pins (measured 2026-11-26 on the showcase film): the service
  // returns words with no whitespace while the text sent keeps it, so counting raw
  // characters drifted the cursor one character per space. Everything after the
  // first spaced sentence was cut off by that drift — s04-1's audio ended with the
  // first two characters of s05-1, and s05-1 lost "曲线".
  it('counts characters the service returns, not the whitespace it drops', () => {
    const join = joinUtterance(['这一句交给 Manim 画。', '下一句从这里开始。'])
    // The service returns no spaces at all.
    const returned = words([
      ['这', 0, 100], ['一', 100, 200], ['句', 200, 300], ['交', 300, 400], ['给', 400, 500],
      ['M', 500, 600], ['a', 600, 700], ['n', 700, 800], ['i', 800, 900], ['m', 900, 1000],
      ['画', 1000, 1100], ['。', 1100, 1200],
      ['下', 1300, 1400], ['一', 1400, 1500], ['句', 1500, 1600], ['从', 1600, 1700],
      ['这', 1700, 1800], ['里', 1800, 1900], ['开', 1900, 2000], ['始', 2000, 2100], ['。', 2100, 2200],
    ])
    const assignment = assignWordsToSpans(returned, join.spans)
    expect(assignment.filter(index => index === 0)).toHaveLength(12)
    expect(assignment.filter(index => index === 1)).toHaveLength(9)
    // No word from the second sentence may be charged to the first one.
    expect(assignment[12]).toBe(1)
  })

  it('gives words past the last span to the last sentence rather than to nothing', () => {
    const join = joinUtterance(['好。'])
    const returned = words([['好。', 0, 300], ['　', 300, 350]])
    expect(assignWordsToSpans(returned, join.spans)).toEqual([0, 0])
  })
})

describe('speech rate', () => {
  it('defaults to 1 and accepts whole numbers', () => {
    expect(normalizeSpeedRatio(null)).toBe(1)
    expect(normalizeSpeedRatio(undefined)).toBe(1)
    expect(normalizeSpeedRatio(2)).toBe(2)
  })

  it('refuses a fractional rate locally instead of sending it and reading a Go type error', () => {
    expect(() => normalizeSpeedRatio(1.2)).toThrow(VoiceError)
    expect(() => normalizeSpeedRatio(1.2)).toThrow(/语速只接受整数/)
  })

  it('refuses a fractional speed_ratio in the manuscript, naming the line', () => {
    const text = 'meta:\n  title: t\n  voice:\n    speaker: zh_female_liuchangnv_uranus_bigtts\n    speed_ratio: 1.5\nsegments:\n  - id: s01\n    engine: slides\n    sentences:\n      - { id: a, say: 好。 }\n'
    expect(() => parseStoryboard(text)).toThrow(/line 4: .*whole number/)
  })
})

describe('cutting one sentence out of an utterance', () => {
  const sentence = words([['先', 0, 200], ['看', 200, 400], ['倒数。', 400, 900]])

  it('ends at the next sentence’s first word, not at this sentence’s last word', () => {
    const timing = segmentTiming({ audioDurationMs: 4000, words: sentence, nextStartMs: 1700, endText: '先看倒数。', trimLead: true })
    // Speech ends at 900, the next sentence starts at 1700: the 800 ms gap stays here.
    expect(timing.targetMs).toBe(900 - 0 + Math.max(800, SENTENCE_PAUSE_MS.sentence))
    expect(timing.cutMs).toBe(timing.targetMs)
  })

  it('pads up to the nominal pause when the voice left too little air, and never trims', () => {
    const tight = segmentTiming({ audioDurationMs: 4000, words: sentence, nextStartMs: 1000, endText: '先看倒数。', trimLead: true })
    // Only 100 ms of natural gap; the full stop deserves 400, so the tail is padded.
    expect(tight.cutMs).toBe(1000)
    expect(tight.targetMs).toBe(900 + SENTENCE_PAUSE_MS.sentence)
    expect(tight.targetMs).toBeGreaterThan(tight.cutMs)

    const roomy = segmentTiming({ audioDurationMs: 4000, words: sentence, nextStartMs: 3000, endText: '先看倒数。', trimLead: true })
    // 2100 ms of natural gap is already generous: it is kept, not shortened to 400.
    expect(roomy.targetMs).toBe(900 + 2100)
    expect(roomy.cutMs).toBe(roomy.targetMs)
  })

  it('a single-sentence request keeps its lead-in and its natural tail', () => {
    const late = words([['先', 180, 380], ['看', 380, 580], ['倒数。', 580, 1080]])
    const timing = segmentTiming({ audioDurationMs: 1600, words: late, nextStartMs: null, endText: '先看倒数。', trimLead: false })
    expect(timing.startMs).toBe(0)
    // 520 ms of natural tail beats the 400 ms the punctuation asks for.
    expect(timing.targetMs).toBe(1080 + 520)
    expect(timing.cutMs).toBe(1600)
  })

  it('a merged slice starts at its first word, dropping the previous sentence’s tail', () => {
    const timing = segmentTiming({ audioDurationMs: 4000, words: words([['好', 2100, 2300], ['的。', 2300, 2600]]), nextStartMs: null, endText: '好的。', trimLead: true })
    expect(timing.startMs).toBe(2100)
    expect(timing.targetMs).toBe(2600 - 2100 + Math.max(4000 - 2600, SENTENCE_PAUSE_MS.sentence))
  })
})

describe('grouping sentences into requests', () => {
  const sentences = [
    { id: 'a', say: '第一句。' },
    { id: 'b', say: '第二句。' },
    { id: 'c', say: '第三句。' },
    { id: 'd', say: '第四句。' },
  ]

  it('merges adjacent sentences by default', () => {
    expect(planUtterances(sentences, undefined, 'auto')).toEqual([[0, 1, 2, 3]])
  })

  it('keeps one request per sentence when asked to', () => {
    expect(planUtterances(sentences, undefined, 'none')).toEqual([[0], [1], [2], [3]])
  })

  it('does not merge across a sentence the run is keeping', () => {
    // b is not being re-narrated, so a and c must not share a request: b's audio
    // sits between them in the timeline.
    expect(planUtterances(sentences, ['a', 'c'], 'auto')).toEqual([[0], [2]])
  })

  it('starts a new request instead of sending an unbounded amount of text', () => {
    const long = Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, say: '一'.repeat(Math.floor(MAX_UTTERANCE_CHARS / 3)) }))
    const groups = planUtterances(long, undefined, 'auto')
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) {
      const chars = group.reduce((sum, index) => sum + long[index]!.say.length, 0)
      expect(chars).toBeLessThanOrEqual(MAX_UTTERANCE_CHARS)
    }
    expect(groups.flat()).toEqual([0, 1, 2, 3, 4, 5])
  })
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!hasFfmpeg)('cutting real audio', () => {
  it('cuts at the requested start and pads the tail to the target length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teach-cut-'))
    const input = join(dir, 'tone.wav')
    const output = join(dir, 'cut.mp3')
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=24000', '-ac', '1', input])
    expect(made.status).toBe(0)
    await cutAudioSegment({ input, output, startMs: 500, cutMs: 500, targetMs: 1200 }, {})
    const media = await probe(output)
    // 500 ms of tone plus 700 ms of padded silence.
    expect(Math.abs((media.durationMs ?? 0) - 1200)).toBeLessThan(40)
  }, 30_000)

  it('writes silence only, when the target is longer than what was kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teach-cut2-'))
    const input = join(dir, 'tone.wav')
    const output = join(dir, 'cut.mp3')
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=24000', '-ac', '1', input])
    await writeFile(join(dir, 'note.txt'), 'noop', 'utf8')
    await cutAudioSegment({ input, output, startMs: 0, cutMs: 200, targetMs: 800 }, {})
    const media = await probe(output)
    expect(Math.abs((media.durationMs ?? 0) - 800)).toBeLessThan(40)
  }, 30_000)
})

describe('picture drive mode', () => {
  it('uses cue mode when word timings exist and page mode when they do not', async () => {
    const { deckDriveMode } = await import('../src/teach/pipeline.ts')
    const words = { voice: { provider: 'volcengine', speaker: 'v', speedRatio: null }, sentences: [] }
    const none = { voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' as const }, sentences: [] }
    expect(deckDriveMode(words as never)).toBe('cue')
    expect(deckDriveMode(none as never)).toBe('page')
  })
})

describe('timings round trip through the disk', () => {
  // The defect this pins: `narrateSentences` wrote `sampleRate` and `merge` into
  // timings.json while `parseTimings` refused unknown keys, so every narrate →
  // render round trip failed with "timings has unknown key sampleRate". The tests
  // never saw it because they passed the in-memory object straight to render.
  const wordTimings: Timings = {
    voice: { provider: 'volcengine', speaker: 'v', speedRatio: null, timestamps: 'word' },
    sentences: [{ id: 'a', text: '好。', audio: 'audio/a.mp3', durationMs: 1200, exitMs: 0, words: [{ t: '好。', b: 0, e: 800 }] }],
  }

  it('reads back exactly what narrate wrote, provenance keys included', () => {
    const text = serializeTimings(wordTimings, { sampleRate: 24000, merge: 'auto' })
    expect(JSON.parse(text).sampleRate).toBe(24000)
    expect(JSON.parse(text).merge).toBe('auto')
    // Provenance survives the parser now: the render's `exitMs` ledger rewrites this
    // file, and a key the parser drops is a key that silently disappears from disk.
    expect(parseTimings(text)).toEqual({ ...wordTimings, sampleRate: 24000, merge: 'auto' })
  })

  it('reads back a narration that carries no word timings', () => {
    const none: Timings = {
      voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
      sentences: [{ id: 'a', text: '好。', audio: 'audio/a.wav', durationMs: 1200, exitMs: 0, words: [] }],
    }
    expect(parseTimings(serializeTimings(none, { sampleRate: 24000 }))).toEqual({ ...none, sampleRate: 24000 })
  })
})

describe('planning the picture from what is on disk', () => {
  const paths = (root: string): TeachPaths => ({ root, audio: 'audio', timings: 'timings.json', work: '.dsh-video/teach', segments: '.dsh-video/teach/segments' })
  const sentence = (id: string): TimedSentence => ({ id, text: `${id}。`, audio: `audio/${id}.wav`, durationMs: 1000, exitMs: 0, words: [] })
  const timings = (...ids: string[]): Timings => ({ voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' }, sentences: ids.map(sentence) })

  it('reports the sentences with no picture yet instead of failing a narrowed render', async () => {
    const root = await mkdtemp(join(tmpdir(), 'teach-plan-'))
    const project = paths(root)
    const existing = segmentPath(project, 'a')
    await mkdir(dirname(existing), { recursive: true })
    await writeFile(existing, 'picture', 'utf8')

    // assemble: false, only "b" rendered: a is reused, nothing is missing.
    const narrowed = await planSegments(project, timings('a', 'b'), [{ id: 'b', path: join(root, 'b.mp4'), durationMs: 1000, exitMs: 0, exitTarget: null, frames: 3, beats: [], settle: null, retried: false }], { requireAll: false })
    expect(narrowed.reused).toEqual(['a'])
    expect(narrowed.fresh).toEqual(['b'])
    expect(narrowed.pending).toEqual([])

    // Neither rendered nor on disk: reported, not thrown, when not assembling.
    const partial = await planSegments(project, timings('a', 'c'), [], { requireAll: false })
    expect(partial.pending).toEqual(['c'])
    expect(partial.reused).toEqual(['a'])

    // Assembling the same set is still refused, because a missing segment is a jump.
    await expect(planSegments(project, timings('a', 'c'), [])).rejects.toThrow(/no picture for "c"/)
  })
})

describe('word timings after a merged request', () => {
  // The defect this pins (measured 2026-11-26 on a 15-sentence film narrated with
  // merge: auto): the service times every word against the whole utterance, the
  // per-sentence audio is a slice of it, and the raw offsets were written to
  // timings.json. The next render refused the file ("words ends at 12715 ms, past
  // the audio's 7464 ms") and every at_word cue would have fired late.
  it('rebases a sentence onto its own slice of the utterance', async () => {
    const { rebaseWords } = await import('../src/teach/pipeline.ts')
    const utterance = [
      { t: '幻', b: 6835, e: 6985 },
      { t: '灯', b: 6985, e: 7125 },
      { t: '片。', b: 12235, e: 12715 },
    ]
    expect(rebaseWords(utterance, 6835)).toEqual([
      { t: '幻', b: 0, e: 150 },
      { t: '灯', b: 150, e: 290 },
      { t: '片。', b: 5400, e: 5880 },
    ])
  })

  it('leaves a single-sentence request alone and never writes a zero-length word', async () => {
    const { rebaseWords } = await import('../src/teach/pipeline.ts')
    const words = [{ t: '好。', b: 0, e: 800 }]
    expect(rebaseWords(words, 0)).toEqual(words)
    // A word that starts before the slice clamps to zero but keeps e > b, which is
    // what parseTimings requires.
    expect(rebaseWords([{ t: '好', b: 10, e: 20 }], 50)).toEqual([{ t: '好', b: 0, e: 1 }])
  })
})

describe('the single-track narration contract', () => {
  // docs/TEACH-VIDEO.md §29: one master audio file, each sentence a span of it.
  // The point of the shape is that nothing is cut, so the schema must be able to
  // say "the audio is one file" and nothing else.
  const master = {
    narration: 'audio/narration.mp3',
    merge: 'single',
    voice: { provider: 'volcengine', speaker: 'v', speedRatio: null, timestamps: 'word' as const },
    sentences: [
      { id: 'a', text: '第一句。', beginMs: 0, durationMs: 1200, exitMs: 0, words: [{ t: '第一句。', b: 0, e: 900 }] },
      { id: 'b', text: '第二句。', beginMs: 1200, durationMs: 1000, exitMs: 0, words: [{ t: '第二句。', b: 0, e: 800 }] },
    ],
  }

  it('round-trips, and keeps the master path', async () => {
    const { parseTimings } = await import('../src/teach/storyboard.ts')
    const read = parseTimings(serializeTimings(master as never, { sampleRate: 24000, merge: 'single' }))
    expect(read.narration).toBe('audio/narration.mp3')
    expect(read.sentences.map(s => s.beginMs)).toEqual([0, 1200])
    expect(read.sentences[0]!.audio).toBeUndefined()
  })

  it('refuses two clocks: a master track and a per-sentence file', async () => {
    const { parseTimings } = await import('../src/teach/storyboard.ts')
    const text = JSON.stringify({ ...master, sentences: [{ ...master.sentences[0]!, audio: 'audio/a.mp3' }] })
    expect(() => parseTimings(text)).toThrow(/cannot both name audio/)
  })

  it('refuses beginMs where there is no master track to be a span of', async () => {
    const { parseTimings } = await import('../src/teach/storyboard.ts')
    const legacy = {
      voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
      sentences: [{ id: 'a', text: '好。', audio: 'audio/a.wav', beginMs: 0, durationMs: 900, exitMs: 0, words: [] }],
    }
    expect(() => parseTimings(JSON.stringify(legacy))).toThrow(/beginMs is for a single-track narration/)
  })

  it('requires beginMs for every sentence once a master track is named', async () => {
    const { parseTimings } = await import('../src/teach/storyboard.ts')
    const missing = { ...master, sentences: [{ id: 'a', text: '第一句。', durationMs: 1200, exitMs: 0, words: [{ t: '第一句。', b: 0, e: 900 }] }] }
    expect(() => parseTimings(JSON.stringify(missing))).toThrow(/beginMs must be a whole number/)
  })

  it('refuses spans that do not tile the master', async () => {
    const { parseTimings } = await import('../src/teach/storyboard.ts')
    // A gap of 200 ms between the two spans: the picture would cover 200 ms less than
    // the audio, and everything after the gap drifts against the voice.
    const gapped = { ...master, sentences: [{ ...master.sentences[0]!, durationMs: 1000 }, master.sentences[1]!] }
    expect(() => parseTimings(JSON.stringify(gapped))).toThrow(/must tile the master/)
  })

  it('times the subtitles off the master, not off a running total', async () => {
    const { buildSrt } = await import('../src/teach/subtitles.ts')
    const srt = buildSrt(master as never)
    // Second sentence starts where its span says, not where sentence one ended in
    // some earlier file: 00:00:01,200.
    expect(srt).toContain('00:00:01,200 --> 00:00:02,000')
  })
})
