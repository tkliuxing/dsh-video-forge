import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  allSentences,
  cueOffsetMs,
  parseStoryboard,
  parseTimings,
  reconcileTimings,
  sentenceStartMs,
  StoryboardError,
  totalDurationMs,
} from '../src/teach/storyboard.ts'

const STORYBOARD = `meta:
  title: 为什么 1+1/4+1/9+… = π²/6
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
  video:
    size: [1920, 1080]
    fps: 30
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        say: 先看一个完全平方数的倒数。
        cues:
          - fragment: 1
          - { fragment: 2, at_word: 完全 }
`

const TIMINGS = {
  voice: { provider: 'volcengine', speaker: 'zh_female_liuchangnv_uranus_bigtts', speedRatio: null },
  sentences: [
    {
      id: 's01-1',
      text: '先看一个完全平方数的倒数。',
      audio: 'audio/s01-1.mp3',
      durationMs: 2424,
      words: [
        { t: '先', b: 0, e: 200 },
        { t: '看', b: 200, e: 390 },
        { t: '一', b: 390, e: 470 },
        { t: '个', b: 470, e: 710 },
        { t: '完全', b: 710, e: 1030 },
      ],
    },
  ],
}

describe('storyboard parsing', () => {
  it('reads meta, defaults and cues', () => {
    const board = parseStoryboard(STORYBOARD)
    expect(board.title).toContain('π²/6')
    expect(board.voice?.speaker).toBe('zh_female_liuchangnv_uranus_bigtts')
    expect(board.video).toEqual({ width: 1920, height: 1080, fps: 30 })
    const first = allSentences(board)[0]
    expect(first?.segment.deck).toBe('slides/s01/index.html')
    expect(first?.sentence.say).toBe('先看一个完全平方数的倒数。')
    expect(first?.sentence.cues).toEqual([
      { fragment: 1, atWord: null, atProgress: null },
      { fragment: 2, atWord: '完全', atProgress: null },
    ])
  })

  it('applies the default delivery geometry when meta.video is absent', () => {
    const board = parseStoryboard('meta:\n  title: t\nsegments:\n  - id: s\n    engine: slides\n    sentences:\n      - { id: a, say: 好。 }\n')
    expect(board.video).toEqual({ width: 1920, height: 1080, fps: 30 })
  })

  it('names the line and the key when a sentence has no say', () => {
    const broken = `meta:
  title: t
segments:
  - id: s01
    engine: slides
    sentences:
      - id: s01-1
        cues: []
`
    const error = (() => {
      try {
        parseStoryboard(broken)
        return null
      } catch (caught) {
        return caught as StoryboardError
      }
    })()
    expect(error).toBeInstanceOf(StoryboardError)
    expect(error?.line).toBe(7)
    expect(error?.message).toMatch(/say is required/)
  })

  it('refuses an unknown key inside a section, so a typo cannot silently drop a line', () => {
    const broken = 'meta:\n  title: t\n  tiele: x\nsegments: []\n'
    expect(() => parseStoryboard(broken)).toThrow(/meta has unknown key "tiele"/)
  })

  it('refuses a manim segment without a scene, and a slides segment with one', () => {
    expect(() => parseStoryboard('meta:\n  title: t\nsegments:\n  - id: s\n    engine: manim\n    sentences:\n      - { id: a, say: 好。 }\n')).toThrow(/engine "manim" needs scene/)
    expect(() => parseStoryboard('meta:\n  title: t\nsegments:\n  - id: s\n    engine: slides\n    scene: scenes/s.py\n    sentences:\n      - { id: a, say: 好。 }\n')).toThrow(/a slides segment uses deck/)
  })

  it('refuses a cue naming a word the sentence does not contain', () => {
    const broken = STORYBOARD.replace('at_word: 完全', 'at_word: 收敛')
    expect(() => parseStoryboard(broken)).toThrow(/at_word "收敛" does not appear in the sentence/)
  })

  it('refuses duplicate sentence ids across segments, because they key the audio files', () => {
    const broken = `meta:
  title: t
segments:
  - id: s01
    engine: slides
    sentences:
      - { id: same, say: 一。 }
  - id: s02
    engine: slides
    sentences:
      - { id: same, say: 二。 }
`
    expect(() => parseStoryboard(broken)).toThrow(/sentence id "same" is used twice/)
  })

  it('refuses a path that leaves the workspace', () => {
    const broken = STORYBOARD.replace('engine: slides', 'engine: slides\n    deck: ../outside/index.html')
    expect(() => parseStoryboard(broken)).toThrow(/must stay inside the workspace/)
  })
})

describe('timings parsing', () => {
  it('reads words and keeps whole milliseconds', () => {
    const timings = parseTimings(JSON.stringify(TIMINGS))
    expect(timings.sentences[0]?.durationMs).toBe(2424)
    expect(timings.sentences[0]?.words.map(word => word.b)).toEqual([0, 200, 390, 470, 710])
  })

  it('refuses words that run past the audio', () => {
    const broken = structuredClone(TIMINGS)
    broken.sentences[0]!.words[4]!.e = 9999
    expect(() => parseTimings(JSON.stringify(broken))).toThrow(/past the audio's 2424 ms/)
  })

  it('accepts a narration that explicitly reports no word timings', () => {
    // DeepSeek TTS returns audio only. Saying so is allowed; saying nothing is not,
    // because a silently empty word list would look like a broken request.
    const silent = {
      voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' },
      sentences: [{ id: 's01-1', text: '好。', audio: 'audio/s01-1.wav', durationMs: 900, words: [] }],
    }
    const parsed = parseTimings(JSON.stringify(silent))
    expect(parsed.voice.timestamps).toBe('none')
    expect(parsed.sentences[0]?.words).toEqual([])
    expect(() => cueOffsetMs({ ...parsed.sentences[0]!, words: [] }, { fragment: 1, atWord: '好', atProgress: null })).toThrow(/no word timings/)
  })

  it('refuses a sentence with no word timings, since the picture could not move', () => {
    const broken = structuredClone(TIMINGS)
    broken.sentences[0]!.words = []
    expect(() => parseTimings(JSON.stringify(broken))).toThrow(/cannot drive the picture/)
  })

  it('refuses overlapping words', () => {
    const broken = structuredClone(TIMINGS)
    broken.sentences[0]!.words[1]!.b = 100
    expect(() => parseTimings(JSON.stringify(broken))).toThrow(/starts before the previous word ends/)
  })
})

describe('timing arithmetic', () => {
  const board = parseStoryboard(STORYBOARD)
  const timings = parseTimings(JSON.stringify(TIMINGS))

  it('reports nothing when the two documents agree', () => {
    expect(reconcileTimings(board, timings)).toEqual([])
  })

  it('reports a sentence that was never narrated, and a stale timings entry', () => {
    const stale = structuredClone(timings)
    stale.sentences[0]!.id = 's09-9'
    expect(reconcileTimings(board, stale)).toEqual([
      'sentence "s01-1" has no narration in timings.json',
      'timings.json has "s09-9", which the storyboard no longer contains',
    ])
  })

  it('reports a voice change, which invalidates every offset', () => {
    const other = structuredClone(timings)
    other.voice.speaker = 'zh_male_ruyayichen_uranus_bigtts'
    expect(reconcileTimings(board, other)[0]).toMatch(/narrated with "zh_male_ruyayichen_uranus_bigtts"/)
  })

  it('sums real audio durations, not the last word end', () => {
    expect(totalDurationMs(timings)).toBe(2424)
    expect(sentenceStartMs(timings, 's01-1')).toBe(0)
    expect(() => sentenceStartMs(timings, 'nope')).toThrow(/no sentence "nope"/)
  })

  it('fires a cue on the word that contains the text, punctuation and all', () => {
    const timed = { ...timings.sentences[0]!, words: [{ t: '来，', b: 3320, e: 3540 }] }
    expect(cueOffsetMs(timed, { fragment: 1, atWord: '来', atProgress: null })).toBe(3320)
    // The provider emits one word per Chinese character, so a phrase spans words.
    const perChar = { ...timed, words: [{ t: '先', b: 100, e: 300 }, { t: '看', b: 300, e: 520 }, { t: '一', b: 520, e: 640 }] }
    expect(cueOffsetMs(perChar, { fragment: 1, atWord: '先看', atProgress: null })).toBe(100)
    expect(cueOffsetMs(perChar, { fragment: 1, atWord: '看一', atProgress: null })).toBe(300)
    expect(cueOffsetMs(timed, { fragment: 1, atWord: null, atProgress: null })).toBe(0)
    expect(() => cueOffsetMs(timed, { fragment: 1, atWord: '收敛', atProgress: null })).toThrow(/has no word containing "收敛"/)
  })
})

describe('progress cues (no word timings)', () => {
  const DEEPSEEK = `meta:
  title: t
  voice:
    provider: deepseek
    speaker: stella
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 先看前几项，它们逐项变小。
        cues:
          - { fragment: 1, at_progress: 0.3 }
          - { fragment: 2, at_progress: 0.7 }
`

  it('reads at_progress for a provider without word timings', () => {
    const board = parseStoryboard(DEEPSEEK)
    const cues = board.segments[0]!.sentences[0]!.cues
    expect(cues).toEqual([
      { fragment: 1, atWord: null, atProgress: 0.3 },
      { fragment: 2, atWord: null, atProgress: 0.7 },
    ])
    expect(board.voice).toEqual({ provider: 'deepseek', speaker: 'stella', speedRatio: null })
  })

  it('refuses at_word for DeepSeek and says what to write instead', () => {
    const broken = DEEPSEEK.replace('{ fragment: 1, at_progress: 0.3 }', '{ fragment: 1, at_word: 先看 }')
    expect(() => parseStoryboard(broken)).toThrowError(/at_word needs a provider that reports word timings[\s\S]*at_progress/)
  })

  it('allows at_progress with a provider that does report word timings', () => {
    const volc = DEEPSEEK.replace('provider: deepseek', 'provider: volcengine').replace('speaker: stella', 'speaker: zh_female_liuchangnv_uranus_bigtts')
    expect(parseStoryboard(volc).segments[0]?.sentences[0]?.cues[0]?.atProgress).toBe(0.3)
  })

  it('refuses a progress outside 0–1, and a cue carrying both timings', () => {
    expect(() => parseStoryboard(DEEPSEEK.replace('at_progress: 0.3', 'at_progress: 1.4'))).toThrowError(/between 0 and 1/)
    // Under a provider that has word timings both forms parse, so "both at once"
    // is the failure the author sees.
    const volc = DEEPSEEK.replace('provider: deepseek', 'provider: volcengine').replace('speaker: stella', 'speaker: zh_female_liuchangnv_uranus_bigtts')
    expect(() => parseStoryboard(volc.replace('at_progress: 0.3', 'at_progress: 0.3, at_word: 先看'))).toThrowError(/not both/)
  })

  it('places a progress cue on the measured sentence length', () => {
    const timed = { id: 'a', text: '先看前几项，它们逐项变小。', audio: 'audio/a.wav', durationMs: 4000, words: [] }
    expect(cueOffsetMs(timed, { fragment: 1, atWord: null, atProgress: 0.5 })).toBe(2000)
    expect(cueOffsetMs(timed, { fragment: 1, atWord: null, atProgress: 0 })).toBe(0)
  })

  it('still requires fragments to increase inside one sentence', () => {
    const broken = DEEPSEEK.replace('{ fragment: 2, at_progress: 0.7 }', '{ fragment: 1, at_progress: 0.7 }')
    expect(() => parseStoryboard(broken)).toThrowError(/greater than the previous cue/)
  })
})

describe('the shipped fixtures', () => {
  const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/teach/${name}/storyboard.yaml`, import.meta.url))

  it('parses the cue-driven sample, which declares volcengine for at_word', async () => {
    const board = parseStoryboard(await readFile(fixture('sample'), 'utf8'))
    expect(board.voice?.provider).toBe('volcengine')
    expect(board.segments.flatMap(segment => segment.sentences).some(sentence => sentence.cues.some(cue => cue.atWord !== null))).toBe(true)
  })

  it('parses the page-mode fixture, which uses at_progress under the default provider', async () => {
    const board = parseStoryboard(await readFile(fixture('page-mode'), 'utf8'))
    expect(board.voice?.provider).toBe('deepseek')
    const cues = board.segments.flatMap(segment => segment.sentences).flatMap(sentence => sentence.cues)
    expect(cues.length).toBeGreaterThan(3)
    expect(cues.every(cue => cue.atProgress !== null && cue.atWord === null)).toBe(true)
  })
})
