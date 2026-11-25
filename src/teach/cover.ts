/**
 * The cover: an authored HTML page, screenshotted by the same Chromium the
 * slides are recorded with.
 *
 * Why a page and not a frame of the film: a cover has to read at 300 px wide in a
 * platform's grid, while a frame of the film is mid-sentence (half a formula on
 * screen, no title) and is usually mid-animation besides. Two shapes are
 * produced because platforms ask for two: 16:9 for the player's own poster and
 * 4:3 for feeds that crop to it. Both are the same page at two viewport sizes,
 * so the author writes the layout once with a media query.
 *
 * The page contract is deliberately thinner than a deck's: no `teachReady`, no
 * `teachCue`. A cover is static, so the recorder waits for fonts and a settle
 * period and screenshots it.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { countFrameColors, type MediaTools } from './ffmpeg.ts'

/** One shape of cover, and the viewport it is rendered at. */
export interface CoverSize {
  /** Named shape; also the filename suffix. */
  id: '16x9' | '4x3'
  width: number
  height: number
}

/**
 * Both shapes the route delivers, at the height the picture already uses.
 *
 * Heights are equal on purpose: 16:9 is 1920×1080 and 4:3 is 1440×1080, so the
 * only thing that changes between them is width, which is what a page's layout
 * has to cope with.
 */
export const COVER_SIZES: readonly CoverSize[] = [
  { id: '16x9', width: 1920, height: 1080 },
  { id: '4x3', width: 1440, height: 1080 },
]

/** The filename stem each shape gets: `v003` → `v003.cover-16x9.png`. */
export function coverFileName(stem: string, size: CoverSize): string {
  return `${stem}.cover-${size.id}.png`
}

/** A cover that could not be produced. */
export class CoverError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'CoverError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export interface RenderCoverOptions {
  /** Absolute path of the cover's HTML file. */
  page: string
  /** Directory for the decoder's scratch file; created if missing. */
  workDir: string
  /** Absolute output path per shape. */
  outputs: readonly { size: CoverSize, path: string }[]
  /** Chromium binary; defaults to Playwright's own lookup. */
  chromiumPath?: string | null
  /** Extra settle time after load, for fonts and a first paint that animates in. */
  settleMs?: number
  signal?: AbortSignal
}

export interface RenderedCover {
  size: CoverSize
  path: string
  /** Distinct colours in the finished PNG; 1 means nothing was drawn. */
  colors: number
}

/**
 * Screenshot one cover page at every requested shape.
 *
 * Each shape gets its own browser context, because the viewport is a context
 * property and a resized page can keep stale layout. The browser itself is
 * launched once: a second launch costs two seconds and buys nothing.
 */
export async function renderCover(options: RenderCoverOptions, tools: MediaTools = {}): Promise<RenderedCover[]> {
  if (options.outputs.length === 0) return []
  await mkdir(options.workDir, { recursive: true })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    browser = await chromium.launch({
      ...(options.chromiumPath === undefined || options.chromiumPath === null ? {} : { executablePath: options.chromiumPath }),
      args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text'],
    })
    const rendered: RenderedCover[] = []
    for (const output of options.outputs) {
      if (options.signal?.aborted === true) throw new CoverError('rendering the cover was cancelled')
      const context = await browser.newContext({
        viewport: { width: output.size.width, height: output.size.height },
        deviceScaleFactor: 1,
        reducedMotion: 'no-preference',
      })
      try {
        const page = await context.newPage()
        await page.goto(pathToFileURL(options.page).href, { waitUntil: 'load' })
        // Webfonts are the usual reason a cover screenshots as blank or reflowed
        // text: `document.fonts.ready` waits for the ones the page actually used.
        await page.evaluate(() => document.fonts.ready.then(() => true))
        const settle = options.settleMs ?? 150
        if (settle > 0) await page.waitForTimeout(settle)
        await page.screenshot({ path: output.path, type: 'png' })
      } finally {
        await context.close().catch(() => {})
      }
      // A flat PNG is a page that drew nothing — a missing stylesheet, a script
      // error, or a layout that only exists under 16:9. Saying so here costs one
      // decode and saves shipping a white square as a cover.
      const colors = await countFrameColors(output.path, {}, tools, options.signal)
      if (colors <= 1) {
        throw new CoverError(`the cover page ${options.page} painted a single flat colour at ${output.size.width}×${output.size.height}; nothing was drawn, so this is not a cover`)
      }
      rendered.push({ size: output.size, path: output.path, colors })
    }
    return rendered
  } catch (error: unknown) {
    if (error instanceof CoverError) throw error
    throw new CoverError(`could not screenshot the cover page (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  } finally {
    await browser?.close().catch(() => {})
  }
}

/** Where a cover lands when export runs: beside the mp4 it belongs to. */
export function coverOutputs(shotDir: string, stem: string): { size: CoverSize, path: string }[] {
  return COVER_SIZES.map(size => ({ size, path: join(shotDir, coverFileName(stem, size)) }))
}
