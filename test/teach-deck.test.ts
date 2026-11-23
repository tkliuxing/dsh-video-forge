import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('segment planning', () => {
  it('keeps segments already on disk and marks what is fresh', async () => {
    const project = await paths('segments')
    const timings = timingsOf('a', 'b', 'c')
    for (const id of ['a', 'b']) {
      await mkdir(join(project.root, project.work, id), { recursive: true })
      await writeFile(segmentPath(project, id), 'fake mp4')
    }
    const plan = await planSegments(project, timings, [{ id: 'c', path: join(project.root, 'fresh', 'c.mp4'), durationMs: timings.sentences[2]!.durationMs, frames: 3 }])
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
    const plan = await planSegments(project, timings, [{ id: 'b', path: '/tmp/b.mp4', durationMs: 1250, frames: 1 }])
    expect(plan.segments.map(segment => segment.id)).toEqual(['a', 'b'])
    expect(plan.segments.map(segment => segment.durationMs)).toEqual([1000, 1250])
  })
})
