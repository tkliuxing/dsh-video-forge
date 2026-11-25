/**
 * A1: the narration is burned into the picture, end to end and without spending
 * anything (docs/TEACH-VIDEO.md §26).
 *
 * The test is gated on an ffmpeg built with libass, because a build without it
 * has no `subtitles` filter at all and the burn cannot happen. Point the test at
 * one with `TEACH_FFMPEG_BIN` (the pipeline's own variable):
 *
 *   TEACH_FFMPEG_BIN=/opt/homebrew/opt/ffmpeg-full/bin pnpm test
 *
 * The narration is synthetic — silent audio of a known length, with a timings
 * file written by hand — because this test is about the product, not about TTS.
 * The deck is white with a pale panel and carries no dark ink of its own, so any
 * dark pixel in a decoded frame is a subtitle and its row range is measurable
 * against the 900–1080 band the route promises.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.ts'
import { SelectionStore } from '../src/selection.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'
import { probeFilter } from '../src/teach/ffmpeg.ts'
import { isMissing } from '../src/teach/rules.ts'
import { registerTeachTools } from '../src/teach/tools.ts'

/** The ffmpeg the pipeline would use here, and whether it can burn subtitles. */
const BIN = (process.env.TEACH_FFMPEG_BIN ?? '').trim()
const MEDIA = BIN === '' ? {} : { ffmpegPath: join(BIN, 'ffmpeg'), ffprobePath: join(BIN, 'ffprobe') }
const SUBTITLES = await probeFilter(MEDIA, 'subtitles')
const CAN_BURN = !isMissing(SUBTITLES)

/** Run the test's own ffmpeg, collecting stdout when asked for it. */
function ffmpegText(args: readonly string[], capture: boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(MEDIA.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(chunks))
      reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

const STORYBOARD = `meta:
  title: 两个字幕测试句
  voice:
    speaker: stella
segments:
  - id: s01
    engine: slides
    deck: slides/s01/index.html
    sentences:
      - id: s01-1
        say: 第一句字幕应当出现在画面底部。
        cues:
          - { fragment: 1, at_progress: 0.5 }
      - id: s01-2
        say: 第二句也应当出现在同一位置。
`

const DECK = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;height:100vh;background:#ffffff}
  #panel{position:absolute;inset:90px;background:#fff8e1}
</style>
<div id="panel"></div>
<script>
window.teachReady = true
window.teachPage = function (index) { document.getElementById('panel').style.opacity = index === 0 ? '1' : '0.99' }
window.teachCue = function (index) {}
</script>`

const TIMINGS = {
  voice: { provider: 'deepseek', speaker: 'stella', speedRatio: null, timestamps: 'none' as const },
  sentences: [
    { id: 's01-1', text: '第一句字幕应当出现在画面底部。', audio: 'audio/s01-1.mp3', durationMs: 2000, words: [] },
    { id: 's01-2', text: '第二句也应当出现在同一位置。', audio: 'audio/s01-2.mp3', durationMs: 2000, words: [] },
  ],
}

const definitions = new Map<string, ToolDefinition>()

const tool = (name: string): ToolDefinition => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`${name} was not registered`)
  return definition
}

interface Harness {
  cwd: string
  exec: ToolRunContext
}

async function harness(files: Record<string, string>): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'teach-burn-'))
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
  const home = await mkdtemp(join(tmpdir(), 'teach-burn-ledger-'))
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
      // The setting the burn reads, so the test exercises the same resolution the
      // settings page writes rather than a test-only shortcut.
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
  const exec = { signal: AbortSignal.timeout(120_000), agent: { id: 'session-burn', session: { header: { cwd } } } } as unknown as ToolRunContext
  return { cwd, exec }
}

/** A silent audio file of the given length, which is the only thing the clock needs. */
async function silentAudio(path: string, durationMs: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await ffmpegText(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=r=24000:cl=mono:d=${(durationMs / 1000).toFixed(3)}`, '-c:a', 'libmp3lame', '-b:a', '192k', path], false)
}

/**
 * Row and column range of the dark pixels in one decoded frame, or null when
 * there are none.
 *
 * "Dark" is any channel under 200, which the deck's own pale panel (255,248,225)
 * is not: the subtitle's black outline is. That is what makes this a measurement
 * of the burn rather than of the slide.
 */
async function inkRows(file: string, atSeconds: number): Promise<{ top: number, bottom: number, left: number, right: number } | null> {
  const raw = await ffmpegText(['-v', 'error', '-ss', String(atSeconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], true)
  const width = 1920
  const height = Math.floor(raw.byteLength / (width * 3))
  let top: number | null = null
  let bottom: number | null = null
  let left: number | null = null
  let right: number | null = null
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      if (raw[offset]! >= 200 && raw[offset + 1]! >= 200 && raw[offset + 2]! >= 200) continue
      if (top === null) top = y
      bottom = y
      left = left === null ? x : Math.min(left, x)
      right = right === null ? x : Math.max(right, x)
    }
  }
  return top === null || bottom === null || left === null || right === null ? null : { top, bottom, left, right }
}

describe.skipIf(!CAN_BURN)(`burned subtitles (${SUBTITLES})`, () => {
  it('burns the cues into the bottom band, and only there', async () => {
    const { cwd, exec } = await harness({
      'storyboard.yaml': STORYBOARD,
      'slides/s01/index.html': DECK,
      'timings.json': JSON.stringify(TIMINGS),
    })
    await silentAudio(join(cwd, 'audio/s01-1.mp3'), 2000)
    await silentAudio(join(cwd, 'audio/s01-2.mp3'), 2000)

    const result = await tool('video_teach_render').execute({}, exec) as { output: string, subtitles: string, message: string }
    expect(result.subtitles.startsWith('burned')).toBe(true)
    expect(result.output).toMatch(/^renders\/teach\/v001\.mp4$/)

    const film = join(cwd, result.output)
    // Sentence 1 runs 0–2000 ms and sentence 2 runs 2000–4000 ms; sample the
    // middle of each so the frame is not a cut.
    const first = await inkRows(film, 1)
    const second = await inkRows(film, 3)
    expect(first, 'the first sentence left no subtitle in the picture').not.toBeNull()
    expect(second, 'the second sentence left no subtitle in the picture').not.toBeNull()
    // The route's own promise: the lines sit in the 900–1080 band of a 1080p
    // frame. The top bound is what protects the picture: a cue that grew upward
    // past row 900 would start covering the slide.
    for (const band of [first!, second!]) {
      expect(band.top).toBeGreaterThan(900)
      expect(band.bottom).toBeLessThanOrEqual(1080)
    }
    // Different text, so the ink is not a frozen frame: the two cues are different
    // numbers of characters, which shows up as a different column extent even when
    // every CJK glyph fills the same vertical box.
    expect(first!.left).not.toBe(second!.left)
  }, 240_000)

  it('assembles without burned-in lines when burn_subtitles is false, and says so', async () => {
    const { cwd, exec } = await harness({
      'storyboard.yaml': STORYBOARD,
      'slides/s01/index.html': DECK,
      'timings.json': JSON.stringify(TIMINGS),
    })
    await silentAudio(join(cwd, 'audio/s01-1.mp3'), 2000)
    await silentAudio(join(cwd, 'audio/s01-2.mp3'), 2000)

    const result = await tool('video_teach_render').execute({ burn_subtitles: false }, exec) as { output: string, subtitles: string }
    expect(result.subtitles).toContain('not burned')
    expect(await inkRows(join(cwd, result.output!), 1)).toBeNull()
  }, 240_000)
})
