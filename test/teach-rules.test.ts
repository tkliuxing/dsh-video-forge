/**
 * The content-and-timeline rules (src/teach/rules.ts).
 *
 * Everything here is offline and pure: a manuscript string in, findings out. The
 * 2026-11-20 sample failed exactly these rules — forty silent seconds of slides,
 * three sentences sharing one Manim scene — and every existing check passed it,
 * because the video was the right length.
 */

import { describe, expect, it } from 'vitest'
import {
  auditDecks,
  auditManuscript,
  CHARS_PER_SECOND,
  countDeckFragments,
  deckPageFragments,
  estimateSentenceSeconds,
  FLAT_FRAME_COLORS,
  judgeSamples,
  MAX_AVERAGE_CUE_GAP_SECONDS,
  sampleTimes,
  type DeckInfo,
} from '../src/teach/rules.ts'
import { parseStoryboard } from '../src/teach/storyboard.ts'

/** A deck with `n` reveal.js fragments, as far as the counter is concerned. */
const deck = (n: number): string => `<section>${Array.from({ length: n }, (_, i) => `<div class="fragment">${i + 1}</div>`).join('')}</section>`

const board = (yaml: string) => parseStoryboard(yaml)

describe('sentence length budget', () => {
  it('warns under 2 s and over 8 s, naming the sentence', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - { id: a, say: 太短。 }
      - id: b
        say: 这一句非常长，长到一句话要讲十几秒，画面只能停在那里，观众会以为卡住了，其实并没有卡住，只是讲得慢而已，所以应该拆开讲。
        cues: [{ fragment: 1, at_word: 这一句 }]
`)
    const audit = auditManuscript(manuscript)
    expect(audit.warnings.some(w => w.includes('"a"') && w.includes('under the 2 s floor'))).toBe(true)
    expect(audit.warnings.some(w => w.includes('"b"') && w.includes('over the 8 s budget'))).toBe(true)
  })

  it('estimates at the measured rate, not a guess', () => {
    expect(CHARS_PER_SECOND).toBe(5)
    expect(estimateSentenceSeconds(20)).toBe(4)
  })
})

describe('every sentence changes one picture', () => {
  it('names a slides sentence with no cue and counts it as silent', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - { id: a, say: 这一句没有任何画面变化，用来测试规则。 }
      - id: b
        say: 这一句有画面变化。
        cues: [{ fragment: 1, at_word: 这一句 }]
`)
    const audit = auditManuscript(manuscript)
    expect(audit.silent).toEqual(['a'])
    expect(audit.warnings.some(w => w.includes('"a"') && w.includes('has no cue'))).toBe(true)
  })

  it('reports two silent sentences in a row, not just each one', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - { id: a, say: 第一句没有画面变化的句子，用来测试连续的情况。 }
      - { id: b, say: 第二句同样没有画面变化，规则应该点名这一对。 }
`)
    const audit = auditManuscript(manuscript)
    expect(audit.warnings.some(w => w.includes('"a" then "b"'))).toBe(true)
  })

  it('reports a cue that does not advance the picture within a segment', () => {
    // The parser enforces increasing fragments inside one sentence; this is the
    // across-sentences case, where a repeated number is accepted but does nothing.
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 第一句推动到第一片。
        cues: [{ fragment: 2, at_word: 第一句 }]
      - id: b
        say: 第二句又推回第二片，画面不会再动。
        cues: [{ fragment: 2, at_word: 第二句 }]
`)
    const audit = auditManuscript(manuscript)
    expect(audit.warnings.some(w => w.includes('"b"') && w.includes('will not move'))).toBe(true)
  })

  it('warns when the average gap between changes is longer than 8 s', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 这一段有三十二个字，大约六点四秒，然后再也没有别的画面变化，总共只有一次变化。
        cues: [{ fragment: 1, at_word: 这一段 }]
      - { id: b, say: 这一段也有三十二个字，大约六点四秒，同样没有画面变化，平均间隔会被拉长很多。 }
`)
    const audit = auditManuscript(manuscript)
    expect(audit.averageCueGapSeconds).toBeGreaterThan(MAX_AVERAGE_CUE_GAP_SECONDS)
    expect(audit.warnings.some(w => w.includes('picture changes every'))).toBe(true)
  })
})

describe('cue numbers against the deck', () => {
  it('counts fragments in the deck HTML', () => {
    expect(countDeckFragments(deck(3))).toBe(3)
    expect(countDeckFragments('<section><p class="fragment fade-up">x</p></section>')).toBe(1)
    expect(countDeckFragments('<section><p>no fragments here</p></section>')).toBeNull()
  })

  it('refuses structurally when a cue names a fragment the deck does not have', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: a
        say: 这一句要求第三片，但 deck 只有两片。
        cues: [{ fragment: 3, at_word: 这一句 }]
`)
    const audit = auditManuscript(manuscript, { deckFragments: new Map([['s01', 2]]) })
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('"a"')
    expect(audit.structural[0]).toContain('has 2 fragments')
  })

  it('does not range-check a deck it did not read', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 没有读到 deck 时不做范围检查。
        cues: [{ fragment: 9, at_word: 没有 }]
`)
    expect(auditManuscript(manuscript).structural).toEqual([])
  })
})

describe('manim scenes', () => {
  it('names every sentence that shares one scene, because the animation repeats', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s02
    engine: manim
    scene: scenes/curve.py
    sentences:
      - { id: m1, say: 第一句用这个场景，画面会重复一次。 }
      - { id: m2, say: 第二句还是这个场景，画面又重复一次。 }
      - { id: m3, say: 第三句仍然用它，一共重复三次。 }
`)
    const audit = auditManuscript(manuscript)
    const sceneWarnings = audit.warnings.filter(w => w.includes('scenes/curve.py'))
    expect(sceneWarnings).toHaveLength(1)
    expect(sceneWarnings[0]).toContain('m1, m2, m3')
    expect(sceneWarnings[0]).toContain('plays 3 times')
  })

  it('stays quiet when each sentence has its own scene', () => {
    const manuscript = board(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s02
    engine: manim
    scene: scenes/a.py
    sentences: [{ id: m1, say: 一个场景一句话，画面不重复。 }]
  - id: s03
    engine: manim
    scene: scenes/b.py
    sentences: [{ id: m2, say: 另一个场景另一句话，也不重复。 }]
`)
    expect(auditManuscript(manuscript).warnings.filter(w => w.includes('plays'))).toEqual([])
  })
})

describe('frame sampling heuristics', () => {
  it('samples inside the sentence, not at its edges, in increasing order', () => {
    const times = sampleTimes(4000)
    expect(times).toHaveLength(4)
    expect(times[0]).toBeGreaterThanOrEqual(400)
    expect(times[times.length - 1]).toBeLessThanOrEqual(3600)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('flags a segment whose every sampled frame is blank', () => {
    const suspect = judgeSamples('a', [{ atMs: 400, colors: 1 }, { atMs: 1200, colors: 1 }, { atMs: 2000, colors: 2 }])
    expect(suspect?.reason).toBe('flat')
    expect(suspect?.detail).toContain('1 distinct colour')
  })

  it('does not call a segment flat for one sparse early frame', () => {
    // Page mode opens on a heading-only frame before the first beat: 57 colours
    // measured on a good page (2026-11-20), 10449 once the beats were in.
    expect(judgeSamples('a', [{ atMs: 400, colors: 57 }, { atMs: 1200, colors: 4569 }, { atMs: 2000, colors: 10449 }])).toBeNull()
  })

  it('flags identical colour counts as possibly frozen', () => {
    const suspect = judgeSamples('a', [{ atMs: 400, colors: 3100 }, { atMs: 1200, colors: 3100 }, { atMs: 2000, colors: 3100 }])
    expect(suspect?.reason).toBe('unchanged')
    expect(suspect?.detail).toContain('3100 colours')
  })

  it('passes a segment whose frames differ', () => {
    expect(judgeSamples('a', [{ atMs: 400, colors: 2100 }, { atMs: 1200, colors: 22486 }, { atMs: 2000, colors: 37073 }])).toBeNull()
  })

  it('keeps the flat threshold below the sparsest real frame measured on 2026-11-20', () => {
    // Real frames counted 57 (a page holding only its heading) to 37073 (a full
    // slide); a blank one counts 1–2.
    expect(FLAT_FRAME_COLORS).toBeLessThan(57)
    expect(FLAT_FRAME_COLORS).toBeGreaterThan(2)
  })
})

describe('progress beats (page mode)', () => {
  const page = (cues: string) => `meta:
  title: t
  voice:
    provider: deepseek
    speaker: stella
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 先看前几项，它们逐项变小，最后停在一个有限的值上。
        cues: ${cues}
`

  it('does not call a page-mode sentence silent when it has no beats', () => {
    const audit = auditManuscript(parseStoryboard(page('[]')))
    expect(audit.silent).toEqual([])
  })

  it('accepts a beat inside the 20–80% window', () => {
    const audit = auditManuscript(parseStoryboard(page('[{ fragment: 1, at_progress: 0.4 }]')))
    expect(audit.warnings.some(w => w.includes('20–80%'))).toBe(false)
  })

  it('warns when a beat sits on the breath at either end', () => {
    const audit = auditManuscript(parseStoryboard(page('[{ fragment: 1, at_progress: 0.05 }, { fragment: 2, at_progress: 0.97 }]')))
    expect(audit.warnings.filter(w => w.includes('20–80%')).length).toBe(2)
  })

  it('warns when one sentence carries more than three beats', () => {
    const cues = '[{ fragment: 1, at_progress: 0.3 }, { fragment: 2, at_progress: 0.45 }, { fragment: 3, at_progress: 0.6 }, { fragment: 4, at_progress: 0.75 }]'
    const audit = auditManuscript(parseStoryboard(page(cues)))
    expect(audit.warnings.some(w => w.includes('more than 3 usually means it covers two ideas'))).toBe(true)
  })
})

describe('sharing a deck page across sentences (page / enter)', () => {
  /** A page-mode manuscript; `sentences` is the YAML body of one segment. */
  const sharedBoard = (sentences: string) => parseStoryboard(`meta:
  title: t
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
${sentences}`)

  const info = (patch: Partial<DeckInfo> = {}): DeckInfo => ({
    path: 'slides/s01/index.html',
    fragments: 3,
    pageFragments: [3],
    hasCue: true,
    hasPage: true,
    hasReady: true,
    ...patch,
  })

  /** Three sentences on one page, numbered 1 / 2 / 3 across it. */
  const SHARED = `      - id: a
        say: 第一句先点亮一块，画面停在这块上。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.4 }]
      - id: b
        say: 第二句进来时第一块已经亮着。
        page: 0
        cues: [{ fragment: 2, at_progress: 0.4 }]
      - id: c
        say: 第三句点亮最后一块就讲完了。
        page: 0
        enter: 2
        cues: [{ fragment: 3, at_progress: 0.4 }]
`

  it('accepts three sentences on one page, in the manuscript and against the deck', () => {
    const board = sharedBoard(SHARED)
    expect(auditManuscript(board)).toEqual({ structural: [], warnings: [], silent: [], averageCueGapSeconds: expect.any(Number) })
    expect(auditDecks(board, new Map([['s01', info()]]))).toEqual({ structural: [], warnings: [] })
  })

  it('refuses numbering that restarts inside one page, naming the cause', () => {
    // §25.5: teachCue is "show up to step k", so a restart re-confirms a lit beat.
    const board = sharedBoard(SHARED.replace('cues: [{ fragment: 2, at_progress: 0.4 }]', 'cues: [{ fragment: 1, at_progress: 0.4 }]'))
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('"b"')
    expect(audit.structural[0]).toContain('already lit')
    expect(audit.structural[0]).toContain('across the whole page')
  })

  it('refuses enter that is not smaller than the sentence\'s first cue', () => {
    const board = sharedBoard(SHARED.replace('enter: 2', 'enter: 3'))
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('"c"')
    expect(audit.structural[0]).toContain('so the cue changes nothing')
    // The repair names the whole legal window for `enter` (>= what the previous
    // sentence left lit, < the first cue), not just "smaller than the cue".
    expect(audit.structural[0]).toContain('Write enter in 2..2')
  })

  it('refuses a page number that goes backwards', () => {
    const board = sharedBoard(`      - id: a
        say: 第一句在第二页上。
        page: 1
        cues: [{ fragment: 1, at_progress: 0.4 }]
      - id: b
        say: 第二句又回到第一页，画面会倒着走。
        page: 0
        cues: [{ fragment: 2, at_progress: 0.4 }]
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('"b"')
    expect(audit.structural[0]).toContain('run backwards')
  })

  it('reports one finding, not two contradictory ones, when enter rewinds and the numbering restarts', () => {
    // Both symptoms have one cause: the beats were not counted across the page.
    const board = sharedBoard(`      - id: a
        say: 第一句点亮两块，画面停在这里。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.3 }, { fragment: 2, at_progress: 0.6 }]
      - id: b
        say: 第二句又从第一块开始数，画面会倒退。
        page: 0
        enter: 1
        cues: [{ fragment: 1, at_progress: 0.4 }]
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('go backwards')
    expect(audit.structural[0]).toContain('no value of enter works')
  })

  it('only recommends a repair that its own rules accept', () => {
    // The previous sentence leaves two beats lit and this one's first cue is 2, so no
    // `enter` can both carry the state and let the cue fire. The finding has to say
    // that, and the repair it names (count across the page, drop enter) must pass.
    const broken = `      - id: a
        say: 第一句点亮两块，画面停在这里。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.3 }, { fragment: 2, at_progress: 0.6 }]
      - id: b
        say: 第二句的第一条 cue 又落在第二拍上。
        page: 0
        enter: 1
        cues: [{ fragment: 2, at_progress: 0.4 }]
`
    const failed = auditManuscript(sharedBoard(broken))
    expect(failed.structural).toHaveLength(1)
    expect(failed.structural[0]).toContain('no value of enter works')
    expect(failed.structural[0]).toContain('at least 3')

    const repaired = `      - id: a
        say: 第一句点亮两块，画面停在这里。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.3 }, { fragment: 2, at_progress: 0.6 }]
      - id: b
        say: 第二句接着第一句的点亮往下数。
        page: 0
        cues: [{ fragment: 3, at_progress: 0.4 }]
`
    expect(auditManuscript(sharedBoard(repaired)).structural).toEqual([])
  })

  it('lets a sentence open its own page with beats already lit, without declaring page everywhere', () => {
    // Naming your own page changes no mapping, so the half-a-map rule does not apply:
    // only a moved page (or a bare `page: i` with nothing to say) makes sharing
    // undecidable. Without this exception the skill's "a page can open pre-lit" would
    // be unreachable for a one-page-per-sentence manuscript.
    const board = sharedBoard(`      - id: a
        say: 这一页一打开就已经亮着一块。
        page: 0
        enter: 1
        cues: [{ fragment: 2, at_progress: 0.4 }]
      - id: b
        say: 第二句自己一页，不需要写 page。
        cues: [{ fragment: 1, at_progress: 0.4 }]
`)
    expect(auditManuscript(board).structural).toEqual([])
    // The page-count checks keep the older behaviour for it: a one-page deck and two
    // sentences is a warning about the second sentence holding the last page, not a
    // refusal naming a sentence that never declared a page.
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: [2] })]]))
    expect(audit.structural).toEqual([])
    expect(audit.warnings.some(line => line.includes('will hold the last page'))).toBe(true)
  })

  it('still refuses a bare page declaration that names only its own position', () => {
    // `page: 0` with no `enter` says nothing at all, and the likely intent is "share
    // page 0" — the half-a-map refusal has to stay for it.
    const board = sharedBoard(`      - id: a
        say: 只给第一句写自己那一页，却没写 enter。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.4 }]
      - id: b
        say: 第二句什么都没写，容易让人以为要共享第一页。
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('declares page on 1 of its 2')
  })

  it('refuses half a page map, because the enter state has no unique answer', () => {
    // The first sentence says nothing about its page; the other two share page 0.
    const board = sharedBoard(`      - id: a
        say: 这一句没有说自己在哪一页上。
        cues: [{ fragment: 1, at_progress: 0.4 }]
      - id: b
        say: 第二句说和第三句共用一页。
        page: 0
        cues: [{ fragment: 2, at_progress: 0.4 }]
      - id: c
        say: 第三句也写在同一页上。
        page: 0
        cues: [{ fragment: 3, at_progress: 0.4 }]
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('declares page on 2 of its 3')
  })

  it('refuses an enter that undoes a beat the previous sentence left lit', () => {
    // The previous sentence ends with two beats lit; this one opens at one, so a
    // beat would visibly disappear at the boundary.
    const board = sharedBoard(`      - id: a
        say: 第一句点亮两块，画面停在这里。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.3 }, { fragment: 2, at_progress: 0.6 }]
      - id: b
        say: 第二句却说只亮着一块，画面会退回去。
        page: 0
        enter: 1
        cues: [{ fragment: 3, at_progress: 0.4 }]
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('"b"')
    expect(audit.structural[0]).toContain('go backwards')
  })

  it('warns when a sentence on a shared page fires no beat, because nothing moves during it', () => {
    const board = sharedBoard(`      - id: a
        say: 第一句点亮一块。
        page: 0
        cues: [{ fragment: 1, at_progress: 0.4 }]
      - id: b
        say: 第二句和第一句共用一页，却没有任何节拍。
        page: 0
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toEqual([])
    expect(audit.silent).toEqual(['b'])
    expect(audit.warnings.some(line => line.includes('"b"') && line.includes('the picture does not change at all during this sentence'))).toBe(true)
  })

  it('refuses a shared-page deck without teachCue when a sentence enters with beats already lit', () => {
    // No cues at all, but `enter: 1` still has to be replayed through teachCue.
    // No cues anywhere: the only thing the recorder has to replay is the page's
    // `enter` state, and that goes through teachCue just the same.
    const board = sharedBoard(`      - id: a
        say: 这一页一打开就已经亮着一块。
        page: 0
        enter: 1
      - id: b
        say: 第二句接着说，但不再点亮新的东西。
        page: 0
        enter: 2
`)
    const audit = auditDecks(board, new Map([['s01', info({ hasCue: false })]]))
    expect(audit.structural.some(line => line.includes('enter') && line.includes('teachCue'))).toBe(true)
  })

  it('says when a cue-driven deck\'s fragment count could not be read, instead of skipping the check', () => {
    const board = parseStoryboard(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 这一句用词级时间戳推画面。
        cues: [{ fragment: 1, at_word: 这一句 }]
`)
    const audit = auditDecks(board, new Map([['s01', info({ fragments: null })]]))
    expect(audit.structural).toEqual([])
    expect(audit.warnings.some(line => line.includes('fragment count could not be read'))).toBe(true)
  })

  it('warns instead of silently skipping page numbers when the deck pages cannot be counted', () => {
    const board = sharedBoard(SHARED)
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: null })]]))
    expect(audit.structural).toEqual([])
    expect(audit.warnings.some(line => line.includes('could not be counted') && line.includes('not checked'))).toBe(true)
  })

  it('says page/enter do nothing when the voice reports word timings', () => {
    // Cue mode never switches pages per sentence, so the two keys are inert.
    const board = parseStoryboard(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 这一句用词级时间戳推画面。
        page: 1
        cues: [{ fragment: 1, at_word: 这一句 }]
`)
    const audit = auditManuscript(board)
    expect(audit.structural).toEqual([])
    expect(audit.warnings.some(line => line.includes('page and enter do nothing here'))).toBe(true)
  })

  it('refuses a sentence whose declared page the deck does not have', () => {
    const board = sharedBoard(SHARED.replace(/page: 0/g, 'page: 3'))
    const audit = auditDecks(board, new Map([['s01', info()]]))
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('"a"')
    expect(audit.structural[0]).toContain('page 4')
  })

  it('warns about deck pages the manuscript never reaches', () => {
    const board = sharedBoard(SHARED)
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: [3, 1, 1] })]]))
    expect(audit.structural).toEqual([])
    expect(audit.warnings.some(line => line.includes('only uses 1'))).toBe(true)
  })

  it('warns when enter claims more of the page than the deck has', () => {
    // The page has two fragments but the manuscript promises it opens with three
    // lit; teachCue clamps at the page end, so the page would open fully revealed.
    const board = sharedBoard(SHARED.replace('enter: 2', 'enter: 3').replace('cues: [{ fragment: 3, at_progress: 0.4 }]', 'cues: [{ fragment: 4, at_progress: 0.4 }]'))
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: [2] })]]))
    expect(audit.structural).toEqual([])
    expect(audit.warnings.some(line => line.includes('"c"') && line.includes('opens fully revealed'))).toBe(true)
  })

  it('checks each shared page\'s own fragment count, not the sentence index', () => {
    // All three sentences are on page 1 of the deck, so the bound to compare
    // against is page 1's fragment count for every cue, not pages 1, 2 and 3.
    const board = sharedBoard(SHARED)
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: [1] })]]))
    expect(audit.warnings.filter(line => line.includes('fires fragment')).length).toBe(2)
    expect(audit.warnings.every(line => !line.includes('page 2'))).toBe(true)
  })
})

describe('deck contract (page mode)', () => {
  /** A manuscript using the default voice, i.e. page mode. */
  const pageBoard = (sentences: string) => parseStoryboard(`meta:
  title: t
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
${sentences}`)

  const info = (patch: Partial<DeckInfo>): DeckInfo => ({
    path: 'slides/s01/index.html',
    fragments: 3,
    pageFragments: [3],
    hasCue: true,
    hasPage: true,
    hasReady: true,
    ...patch,
  })

  it('counts only real markup, so a script or a comment is not a page', () => {
    // The shipped template talks about sections and fragments in its own script; a
    // page check that reads that JavaScript as markup invented a page and made the
    // page-count checks lie on the deck the plugin hands to projects (2026-11-25).
    const html = [
      '<section><div class="fragment">1</div><div class="fragment">2</div></section>',
      '<script>',
      '// One <section> per page; a beat looks like class="fragment".',
      'const example = \'<section><i class="fragment">\'',
      '</script>',
      '<!-- <section>not a page either</section> -->',
    ].join('\n')
    expect(deckPageFragments(html)).toEqual([2])
    expect(countDeckFragments(html)).toBe(2)
  })

  it('splits a deck into pages and counts the fragments inside each', () => {
    const html = '<section><i class="fragment">1</i><i class="fragment">2</i></section><section><i class="fragment">3</i></section>'
    expect(deckPageFragments(html)).toEqual([2, 1])
    expect(deckPageFragments('<main>no sections</main>')).toBeNull()
  })

  it('refuses a page-mode deck that never defines teachPage, before any money is spent', () => {
    const board = pageBoard('      - id: a\n        say: 这一句在页模式下需要 teachPage。\n')
    const audit = auditDecks(board, new Map([['s01', info({ hasPage: false })]]))
    expect(audit.structural).toHaveLength(1)
    expect(audit.structural[0]).toContain('teachPage')
    expect(audit.structural[0]).toContain('volcengine')
  })

  it('does not ask a cue-mode deck for teachPage', () => {
    const board = parseStoryboard(`meta:
  title: t
  voice:
    provider: volcengine
    speaker: zh_female_liuchangnv_uranus_bigtts
segments:
  - id: s01
    engine: slides
    sentences:
      - id: a
        say: 这一句用词级时间戳推画面。
        cues: [{ fragment: 1, at_word: 这一句 }]
`)
    expect(auditDecks(board, new Map([['s01', info({ hasPage: false })]]))).toEqual({ structural: [], warnings: [] })
  })

  it('warns when the deck has fewer pages than the segment has sentences', () => {
    const board = pageBoard('      - id: a\n        say: 第一句占用第一页。\n      - id: b\n        say: 第二句本该有自己的第二页。\n')
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: [1] })]]))
    expect(audit.warnings.some(w => w.includes('"b"') && w.includes('hold the last page'))).toBe(true)
  })

  it('warns when a beat outruns its own page, since teachCue would change slides', () => {
    const board = pageBoard('      - id: a\n        say: 第一页有三个节拍。\n        cues: [{ fragment: 3, at_progress: 0.5 }]\n      - id: b\n        say: 第二页只有一个节拍，编号必须回到 1。\n        cues: [{ fragment: 2, at_progress: 0.5 }]\n')
    const audit = auditDecks(board, new Map([['s01', info({ pageFragments: [3, 1] })]]))
    expect(audit.warnings.some(w => w.includes('"b"') && w.includes('page 2'))).toBe(true)
    expect(audit.warnings.some(w => w.includes('"a"'))).toBe(false)
  })

  it('refuses a deck that never sets teachReady, or that cannot run a cue it is given', () => {
    const board = pageBoard('      - id: a\n        say: 这一句带着一个节拍。\n        cues: [{ fragment: 1, at_progress: 0.5 }]\n')
    const noReady = auditDecks(board, new Map([['s01', info({ hasReady: false })]]))
    expect(noReady.structural.some(line => line.includes('teachReady'))).toBe(true)
    const noCue = auditDecks(board, new Map([['s01', info({ hasCue: false })]]))
    expect(noCue.structural.some(line => line.includes('teachCue'))).toBe(true)
  })

  it('does not complain about page-relative numbering across sentences', () => {
    // Page 1 beat 1, then page 2 beat 1: correct in page mode, and the
    // cross-sentence "picture will not move" rule must not fire.
    const board = pageBoard('      - id: a\n        say: 第一页的第一个节拍。\n        cues: [{ fragment: 1, at_progress: 0.5 }]\n      - id: b\n        say: 第二页也从第一个节拍重新开始。\n        cues: [{ fragment: 1, at_progress: 0.5 }]\n')
    expect(auditManuscript(board, { deckFragments: new Map([['s01', 2]]) }).warnings.some(w => w.includes('will not move'))).toBe(false)
  })
})
