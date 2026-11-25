/**
 * A2: the cover is an authored page, screenshotted at both shapes
 * (docs/TEACH-VIDEO.md §26, TODO.md A2).
 *
 * Gated on a launchable Chromium rather than on anything about the narration:
 * a cover does not depend on the film at all. The first launch in this file is
 * the gate (browsers are looked up by `playwright-core`, or by `TEACH_CHROMIUM`
 * through the plugin's setting); `renderCover` launches its own afterwards.
 *
 * The film this test exports beside is rendered by the same code A1 covers, at
 * two synthetic sentences of silent audio, so the whole export path runs for
 * real: `video_teach_render` → `video_teach_export` → two PNGs + the SRT.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'
import { probe } from '../src/teach/ffmpeg.ts'
import { COVER_SIZES } from '../src/teach/cover.ts'
import { registerTeachTools } from '../src/teach/tools.ts'

const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const MEDIA = BIN === '' ? {} : { ffmpegPath: join(BIN, 'ffmpeg'), ffprobePath: join(BIN, 'ffprobe') }

/** Whether this machine can screenshot anything at all. */
const CAN_SHOOT = await chromium.launch({ args: ['--hide-scrollbars'] })
  .then(async browser => { await browser.close(); return true })
  .catch(() => false)

/** Run the test's own ffmpeg, for the synthetic narration. */
function ffmpegText(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(MEDIA.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve()
      reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

const STORYBOARD = `meta:
  title: 封面测试
  cover: cover/index.html
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 封面与成片同版本号。
`

const DECK = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;height:100vh;background:#ffffff}#panel{position:absolute;inset:90px;background:#fff8e1}</style>
<div id="panel"></div>
<script>
window.teachReady = true
window.teachPage = function (index) {}
window.teachCue = function (index) {}
</script>`

/** A cover page that lays out differently at each shape, the way an author would write it. */
const COVER = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:#0f172a;color:#f8fafc;font-family:sans-serif}
  .wrap{display:flex;flex-direction:column;justify-content:center;height:100%;padding:6%}
  h1{font-size:clamp(40px,6vw,90px);margin:0}
  @media (max-aspect-ratio: 4/3) { .wrap { padding: 10% } h1 { font-size: 72px } }
</style>
<div class="wrap"><h1>封面标题</h1><p>副标题：两种画幅同一页</p></div>`

const TIMINGS = {
  voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' as const },
  sentences: [
    { id: 's01-1', text: '封面与成片同版本号。', audio: 'audio/s01-1.mp3', durationMs: 1500, words: [] },
  ],
}

const definitions = new Map<string, ToolDefinition>()

const tool = (name: string): ToolDefinition => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

async function harness(files: Record<string, string>): Promise<{ cwd: string, exec: ToolRunContext }> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-cover-'))
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
  const home = await mkdtemp(join(tmpdir(), 'teach-cover-ledger-'))
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
  const exec = { signal: AbortSignal.timeout(120_000), agent: { id: 'session-cover', session: { header: { cwd } } } } as unknown as ToolRunContext
  return { cwd, exec }
}

describe.skipIf(!CAN_SHOOT)(`covers (chromium: ${CAN_SHOOT ? 'found' : 'missing, so skipped'})`, () => {
  it('writes both covers, at the two shapes the platforms ask for, and the SRT beside them', async () => {
    const { cwd, exec } = await harness({
      'storyboard.yaml': STORYBOARD,
      'slides/s01/index.html': DECK,
      'cover/index.html': COVER,
      'timings.json': JSON.stringify(TIMINGS),
    })
    const audio = join(cwd, 'audio/s01-1.mp3')
    await mkdir(join(audio, '..'), { recursive: true })
    await ffmpegText(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=1.500', '-c:a', 'libmp3lame', '-b:a', '192k', audio])

    await tool('video_teach_render').execute({}, exec)
    const result = await tool('video_teach_export').execute({}, exec) as { covers: string[], srt: string, message: string }
    expect(result.covers).toEqual(['renders/teach/v001.cover-16x9.png', 'renders/teach/v001.cover-4x3.png'])
    for (const [index, relative] of result.covers.entries()) {
      const path = join(cwd, relative)
      expect((await stat(path)).size).toBeGreaterThan(1000)
      const media = await probe(path, MEDIA)
      expect(media.width).toBe(COVER_SIZES[index]!.width)
      expect(media.height).toBe(COVER_SIZES[index]!.height)
    }
    // The SRT is the same text the burn used: one cue per sentence on a provider
    // without word timings.
    const srt = await readFile(join(cwd, result.srt), 'utf8')
    expect(srt).toContain('封面与成片同版本号。')
    expect(srt.trim().split('\n\n')).toHaveLength(1)
  }, 240_000)

  it('produces no cover when the manuscript declares none, and says so', async () => {
    const { cwd, exec } = await harness({
      'storyboard.yaml': STORYBOARD.replace('  cover: cover/index.html\n', ''),
      'slides/s01/index.html': DECK,
      'timings.json': JSON.stringify(TIMINGS),
    })
    const audio = join(cwd, 'audio/s01-1.mp3')
    await mkdir(join(audio, '..'), { recursive: true })
    await ffmpegText(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono:d=1.500', '-c:a', 'libmp3lame', '-b:a', '192k', audio])

    await tool('video_teach_render').execute({}, exec)
    const result = await tool('video_teach_export').execute({}, exec) as { covers: string[], message: string }
    // A frame of the film is not a substitute: nothing is invented.
    expect(result.covers).toEqual([])
    expect(result.message).toContain('no meta.cover')
  }, 240_000)
})
