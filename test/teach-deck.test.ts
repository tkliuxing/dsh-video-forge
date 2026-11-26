import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { deckExists, DECK_ASSETS, escapeHtml, findAssetDirectory, writeDeck } from '../src/teach/deck.ts'
import { planSegments, segmentPath, type TeachPaths } from '../src/teach/pipeline.ts'
import type { Timings } from '../src/teach/storyboard.ts'

const tempDir = async (label: string): Promise<string> => mkdtemp(join(tmpdir(), `teach-${label}-`))

const paths = async (label: string): Promise<TeachPaths> => ({
  root: await tempDir(label),
  audio: 'audio',
  timings: 'timings.json',
  work: '.dsh-video/teach',
  segments: '.dsh-video/teach/segments',
})

const timingsOf = (...ids: string[]): Timings => ({
  voice: { provider: 'volcengine', speaker: 'zh_female_liuchangnv_uranus_bigtts', speedRatio: null },
  sentences: ids.map((id, index) => ({
    id,
    text: `第 ${index + 1} 句。`,
    audio: `audio/${id}.mp3`,
    durationMs: 1000 + index * 250,
    exitMs: 0,
    words: [{ t: '第', b: 0, e: 200 }],
  })),
})

describe('deck scaffolding', () => {
  it('finds the packaged assets from either the source tree or the bundle', () => {
    expect(DECK_ASSETS.endsWith('assets/teach/deck')).toBe(true)
    expect(findAssetDirectory('/nowhere/lib/index.js', 'teach/deck')).toContain('assets/teach/deck')
  })

  it('writes a deck that defines the recorder contract, with reveal.js beside it', async () => {
    const dir = join(await tempDir('deck'), 'slides', 's01')
    const entry = await writeDeck(dir, { title: '部分和为什么收敛到 π²/6', slides: '<section><h1>t</h1></section>' })
    const page = await readFile(entry, 'utf8')
    expect(page).toContain('window.teachCue')
    expect(page).toContain('window.teachPage')
    expect(page).toContain('Reveal.slide(')
    expect(page).toContain('window.teachReady')
    expect(page).toContain('<section><h1>t</h1></section>')
    expect(page).toContain('部分和为什么收敛到 π²/6')
    // The vendored runtime is copied, so the project keeps working when moved.
    expect(await deckExists(dir)).toBe(true)
    expect(await readFile(join(dir, 'reveal.js'), 'utf8')).toContain('Reveal')
    expect(await readFile(join(dir, 'LICENSE'), 'utf8')).toContain('MIT')
  })

  it('escapes the title, which lands in a document rather than in markup', async () => {
    const dir = join(await tempDir('deck-escape'), 'slides', 's01')
    const entry = await writeDeck(dir, { title: 'a<b>&"c"', slides: '' })
    expect(await readFile(entry, 'utf8')).toContain('a&lt;b&gt;&amp;&quot;c&quot;')
    expect(escapeHtml('<')).toBe('&lt;')
  })

  it('refuses to overwrite a hand-edited deck unless asked', async () => {
    const dir = join(await tempDir('deck-exists'), 'slides', 's01')
    await writeDeck(dir, { title: 'first', slides: '' })
    await expect(writeDeck(dir, { title: 'second', slides: '' })).rejects.toThrow(/already exists/)
    await writeDeck(dir, { title: 'second', slides: '' }, true)
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toContain('second')
  })
})

/** Whether this machine can drive the scaffolded deck at all. */
const CAN_DRIVE = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

describe.skipIf(!CAN_DRIVE)('the scaffolded deck, driven like the recorder drives it', () => {
  /** The state of one page: how many of its fragments reveal.js reports as shown. */
  async function driveDeck(): Promise<{ onPageSwitch: number, afterCue1: number, afterCue2: number, idempotent: number }> {
    const dir = join(await tempDir('deck-drive'), 'slides', 's01')
    const slides = [
      '<section><h1>第一页</h1><p class="fragment">一</p><p class="fragment">二</p></section>',
      '<section><h1>第二页</h1><p class="fragment">甲</p><p class="fragment">乙</p><p class="fragment">丙</p></section>',
    ].join('\n')
    const entry = await writeDeck(dir, { title: '驱动测试', slides })
    const browser = await chromium.launch({ args: ['--hide-scrollbars'] })
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
      await page.goto(pathToFileURL(entry).href, { waitUntil: 'load' })
      await page.waitForFunction(() => (globalThis as { teachReady?: boolean }).teachReady === true, undefined, { timeout: 15_000 })
      const shown = () => page.evaluate(() => {
        const reveal = (globalThis as unknown as { Reveal: { getIndices(): { f?: number } } }).Reveal
        return (reveal.getIndices().f ?? -1) + 1
      })
      const cue = (n: number) => page.evaluate(step => (globalThis as unknown as { teachCue(step: number): void }).teachCue(step), n)
      const goPage = (n: number) => page.evaluate(index => (globalThis as unknown as { teachPage(index: number): void }).teachPage(index), n)

      // The recorder's order for a page: switch, (replay `enter`), wait, record.
      await goPage(1)
      const onPageSwitch = await shown()
      await cue(1)
      const afterCue1 = await shown()
      await cue(2)
      const afterCue2 = await shown()
      await cue(1)
      const idempotent = await shown()
      return { onPageSwitch, afterCue1, afterCue2, idempotent }
    } finally {
      await browser.close()
    }
  }

  it('opens a page with none of its beats lit, so the first cue still has somewhere to go', async () => {
    // `Reveal.slide(n, 0, 0)` lit the page's first fragment on the switch, which
    // made the manuscript's first cue a no-op and made `enter: 0` impossible to
    // honour (found 2026-11-25, docs/TEACH-VIDEO.md §25).
    const state = await driveDeck()
    expect(state.onPageSwitch).toBe(0)
    expect(state.afterCue1).toBe(1)
    expect(state.afterCue2).toBe(2)
    expect(state.idempotent).toBe(2)
  })
})

describe('segment planning', () => {
  it('keeps segments already on disk and marks what is fresh', async () => {
    const project = await paths('segments')
    const timings = timingsOf('a', 'b', 'c')
    for (const id of ['a', 'b']) {
      await mkdir(join(project.root, project.work, id), { recursive: true })
      await writeFile(segmentPath(project, id), 'fake mp4')
    }
    const plan = await planSegments(project, timings, [{ id: 'c', path: join(project.root, 'fresh', 'c.mp4'), durationMs: timings.sentences[2]!.durationMs, exitMs: 0, exitTarget: null, frames: 3, beats: [], settle: null, retried: false }])
    expect(plan.segments.map(segment => segment.id)).toEqual(['a', 'b', 'c'])
    expect(plan.reused).toEqual(['a', 'b'])
    expect(plan.fresh).toEqual(['c'])
    expect(plan.segments[2]!.path).toBe(join(project.root, 'fresh', 'c.mp4'))
  })

  it('names the sentences with no picture instead of skipping them', async () => {
    const project = await paths('segments-missing')
    await expect(planSegments(project, timingsOf('a', 'b'))).rejects.toThrow(/"a", "b"/)
  })

  it('keeps timeline order even when only the last sentence was re-rendered', async () => {
    const project = await paths('segments-order')
    const timings = timingsOf('a', 'b')
    for (const id of ['a']) {
      await mkdir(join(project.root, project.work, id), { recursive: true })
      await writeFile(segmentPath(project, id), 'fake')
    }
    const plan = await planSegments(project, timings, [{ id: 'b', path: '/tmp/b.mp4', durationMs: 1250, exitMs: 0, exitTarget: null, frames: 1, beats: [], settle: null, retried: false }])
    expect(plan.segments.map(segment => segment.id)).toEqual(['a', 'b'])
    expect(plan.segments.map(segment => segment.durationMs)).toEqual([1000, 1250])
  })
})
