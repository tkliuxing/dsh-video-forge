/**
 * The slide half of the picture: drive a reveal.js deck on a clock and record it.
 *
 * Two rules decide everything here (docs/TEACH-VIDEO.md §4):
 *
 * 1. **The audio is the clock.** The recorder never plays sound; it advances the
 *    deck to the offsets that `timings.json` says the words happen at. The
 *    narration is mixed in later, so the recording process and the audio
 *    playback cannot drift against each other.
 * 2. **One sentence, one recording.** Each sentence gets its own capture and its
 *    own segment, so a drift can only spoil one line and re-recording a line
 *    costs one line.
 *
 * Frames come from CDP's `Page.startScreencast`, which the page drives: it emits
 * a frame when the page repaints and nothing during a hold. Those frames are
 * turned into a constant-frame-rate segment by `ffmpeg.encodeFrames`, which is
 * why an idle slide still produces 30 fps of picture.
 *
 * The deck contract is three globals — `window.teachCue(index)`,
 * `window.teachPage(index)` and `window.teachReady` — plus two optional ones that
 * say how long the deck's own motion takes (`teachPageTransition`,
 * `teachTransition`; docs/TEACH-MOTION.md §5). Keeping it that small is
 * deliberate: a deck can be plain reveal.js with a few lines of glue, and this
 * module never needs to know how the deck is built.
 *
 * What was recorded is measured, not assumed: every beat's real moment and the
 * segment's last frame against the finished page. Both failures they catch — a
 * beat that landed late, an animation cut at the ending — are invisible in a
 * still frame and were shipped once (§15).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { countFrameColors, encodeFrames, frameDelta, probe, type MediaProbe, type MediaTools } from './ffmpeg.ts'

/**
 * The globals a deck must expose.
 *
 * Two drive modes, one deck:
 *
 * - `teachCue(n)` — show cue step n inside the current page. Both modes use it:
 *   in cue mode a cue names a spoken word, in page mode an `at_progress` share of
 *   the sentence's own length.
 * - `teachPage(n)` — show page n. Page mode (a provider with no word timings,
 *   DeepSeek by default) starts one page per sentence, then fires the sentence's
 *   beats inside that page.
 *
 * `teachReady` is required by both.
 */
export interface DeckGlobals {
  teachReady?: boolean
  teachCue?: (index: number) => void
  teachPage?: (index: number) => void
  /**
   * How long this deck's own page switch takes, in ms (docs/TEACH-MOTION.md §5).
   *
   * Optional, and the only global here the recorder reads as data: only the deck
   * knows which reveal transition it uses, and `transition: 'fade'` is a fixed
   * 0.5 s in reveal.css whatever `transitionSpeed` says. Waiting less than that
   * starts the capture mid-transition. Omitting it keeps {@link PAGE_TRANSITION_MS}.
   */
  teachPageTransition?: number
  /**
   * How long one in-page beat's transition takes, in ms.
   *
   * The recorder never needs it — a beat is fired at its offset and the CSS plays
   * itself — but saying it out loud is what lets `video_teach_plan` warn when a
   * beat has less room than its own motion (src/teach/rules.ts).
   */
  teachTransition?: number
}

/** One reveal.js fragment advance, at a moment measured from the sentence's start. */
export interface CueAt {
  /** Milliseconds from the start of the sentence audio. */
  atMs: number
  /** Which cue step to show, counted inside the current page (1-based, as in storyboard.yaml). */
  fragment: number
}

/**
 * How long to let a page switch finish before the capture starts, in ms, when the
 * deck declares no `window.teachPageTransition`.
 *
 * The scaffolded template animates a page change (`transitionSpeed: 'fast'`,
 * about 200 ms), so starting the screencast immediately would record the tail of
 * that transition. t=0 of the segment is the first frame *after* this wait, so
 * the value costs nothing in timing. It is only a default: a deck that knows its
 * own transition (reveal's `fade` is a fixed 0.5 s) declares the real number
 * (docs/TEACH-MOTION.md §5).
 */
const PAGE_TRANSITION_MS = 300

export interface RecordDeckOptions {
  /** Absolute path of the deck's HTML entry. */
  deckPath: string
  /**
   * Page mode: show this page (0-based, reveal.js horizontal index) first, then
   * the cues run inside it. Set when the narration has no word timings, where a
   * page belongs to a sentence and the cues are timed by `at_progress` rather
   * than by a word.
   */
  page?: number | null
  /**
   * Page mode, shared pages: how many beats of that page are already lit when this
   * sentence's capture starts (the manuscript's `enter`, resolved by
   * `pageSlots` in src/teach/storyboard.ts).
   *
   * Each sentence is its own `page.goto`, so the deck comes up empty; without this
   * the second sentence of a shared page would open with every beat dark and the
   * first card would appear to flash on twice. It is applied inside the page-switch
   * wait, i.e. before a single frame is captured, so t=0 already shows it.
   */
  enter?: number | null
  /** Cue mode: fragment advances on measured word moments. Empty in page mode. */
  cues: readonly CueAt[]
  /** The sentence audio's real duration: the segment is cut to this. */
  durationMs: number
  width: number
  height: number
  fps: number
  /** Directory for the capture's intermediate files; created if missing. */
  workDir: string
  /** Chromium binary; defaults to Playwright's own lookup. */
  chromiumPath?: string | null
  /** Extra settle time after navigation, for fonts and typeset math. */
  settleMs?: number
  signal?: AbortSignal
}

/** One beat as it was asked for and as it happened, in ms from the segment's first frame. */
export interface BeatTiming {
  /** The cue step the manuscript asked for. */
  fragment: number
  /** When the cue was due: `at_progress` or `at_word` resolved against the audio. */
  atMs: number
  /** When the deck was actually told to step. */
  actualMs: number
}

/**
 * Whether the last captured frame is the deck driven to the end of the sentence.
 *
 * `unfinished` is the failure a still frame cannot show: a beat that fired too
 * late, or a motion longer than the room left after it, leaves the segment cut
 * through the middle of an animation. `skipped` carries its own reason, because
 * "not checked" and "checked and fine" must never look the same.
 */
export type SettleCheck =
  | { status: 'finished' | 'unfinished', changed: number, mean: number, finalFragment: number }
  | { status: 'skipped', reason: string }

export interface RecordedSegment {
  /** The encoded, silent, constant-frame-rate mp4. */
  path: string
  /** Frame count the capture produced; useful when a deck turned out to be static. */
  frames: number
  /** What the encoder says the segment is, measured after the fact. */
  media: MediaProbe
  /** Every beat of this sentence, intended and actual (empty when it fires none). */
  beats: readonly BeatTiming[]
  /** Whether the segment ends on the finished layout. */
  settle: SettleCheck
}

/**
 * A beat this many ms behind its cue is reported late.
 *
 * Four output frames at 30 fps. Below that the beat is simply a frame or two off,
 * which nobody can see; at a second and a half (the 2026-11-25 incident that
 * added this check) the animation is cut through the middle.
 */
export const LATE_BEAT_MS = 120

/** Share of pixels that may differ between the last frame and the finished page. */
export const SETTLE_CHANGED = 0.002

/** How long to give the in-page motion before screenshotting the finished page: min, max, default, slack. */
const SETTLE_MIN_MS = 300
const SETTLE_MAX_MS = 3000
const SETTLE_DEFAULT_MS = 700
const SETTLE_SLACK_MS = 200

/** The beats of one capture that landed too late to finish, in manuscript order. */
export function lateBeats(beats: readonly BeatTiming[], toleranceMs = LATE_BEAT_MS): BeatTiming[] {
  return beats.filter(beat => beat.actualMs - beat.atMs > toleranceMs)
}

/** A capture that could not be produced. */
export class DeckRecordError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'DeckRecordError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

interface ScreencastFrame {
  data: string
  metadata: { timestamp?: number }
  sessionId: number
}

/** Find the first installed Playwright Chromium, for hosts that have the browser cache but not a `playwright` install. */
export function bookmarkedChromiumPath(cacheRoot: string): string[] {
  return [join(cacheRoot, 'chromium-1243', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')]
}

/**
 * Record one sentence of a deck.
 *
 * The capture is driven from the same offsets the words carry: at each cue the
 * deck steps one fragment, and the segment is cut to `durationMs` afterwards.
 */
export async function recordDeckSegment(options: RecordDeckOptions, tools: MediaTools = {}): Promise<RecordedSegment> {
  await mkdir(options.workDir, { recursive: true })
  const framesDir = join(options.workDir, 'frames')
  await mkdir(framesDir, { recursive: true })

  let browser: Browser | null = null
  try {
    browser = await chromium.launch({
      ...(options.chromiumPath === undefined || options.chromiumPath === null ? {} : { executablePath: options.chromiumPath }),
      args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--disable-lcd-text'],
    })
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
      reducedMotion: 'no-preference',
    })
    const page = await context.newPage()
    await page.goto(pathToFileURL(options.deckPath).href, { waitUntil: 'load' })
    await page.waitForFunction(() => (globalThis as DeckGlobals).teachReady === true, undefined, { timeout: 15_000 })
    if (options.settleMs !== undefined && options.settleMs > 0) await page.waitForTimeout(options.settleMs)

    // Self-check before a single frame is recorded: a deck that never laid out
    // paints one flat colour (the white canvas, with white text on it), and a
    // recording of that is a white segment with narration over it. The first
    // mixed sample shipped 116 s of exactly that because only the duration was
    // ever asserted (docs/TEACH-VIDEO.md §16).
    const probePath = join(options.workDir, 'first-frame.png')
    await page.screenshot({ path: probePath })
    const colors = await countFrameColors(probePath, {}, tools, options.signal)
    if (colors <= 1) {
      throw new DeckRecordError(
        `the deck at ${options.deckPath} painted a single flat colour (${colors} distinct colour${colors === 1 ? '' : 's'}); `
        + 'the stage did not lay out, so this segment would be blank. Check that the deck loads its stylesheets and that reveal.js reports ready (window.teachReady).',
      )
    }

    // Page mode switches the page BEFORE the capture starts. Starting the
    // screencast first shipped one frame of the deck's first page at the head of
    // every sentence but the first (measured 2026-11-20: the opening frame of
    // s01-5 was pixel-identical to the opening frame of s01-1), which reads as a
    // flash of the cover slide between sentences. The switch is also given time to
    // finish its transition, so t=0 is the settled page; the capture clock starts
    // at the first frame afterwards, so the settle never shortens the segment.
    if (options.page !== undefined && options.page !== null) {
      await page.evaluate(index => {
        const deck = globalThis as DeckGlobals
        if (typeof deck.teachPage !== 'function') {
          throw new Error('deck is missing window.teachPage(index), which the page mode needs (see the scaffolded template)')
        }
        deck.teachPage(index)
      }, options.page)
      // Shared page: replay the beats the previous sentence on this page left lit,
      // before the transition wait and therefore before the capture starts. The
      // order (page, then the beats, then the wait) is the contract: doing it after
      // the wait would record the empty page first.
      const enter = options.enter ?? 0
      if (enter > 0) {
        await page.evaluate(step => {
          const deck = globalThis as DeckGlobals
          if (typeof deck.teachCue !== 'function') {
            throw new Error('deck is missing window.teachCue(index), which is how the recorder replays a page\'s already-lit beats (enter) before the capture starts')
          }
          deck.teachCue(step)
        }, enter)
      }
      await page.waitForTimeout(await pageTransitionMs(page))
    }

    const cdp: CDPSession = await context.newCDPSession(page)
    const frames: { file: string, atMs: number }[] = []
    let startedAt: number | null = null

    cdp.on('Page.screencastFrame', (event: unknown) => {
      const frame = event as ScreencastFrame
      const timestamp = typeof frame.metadata.timestamp === 'number' ? frame.metadata.timestamp : Date.now() / 1000
      if (startedAt === null) startedAt = timestamp
      const file = join(framesDir, `f${String(frames.length).padStart(6, '0')}.jpg`)
      // `metadata.timestamp` is `MonotonicTime` in **seconds** (epoch-based, e.g.
      // 1795167705.32). Keeping the difference as-is produced "milliseconds" of
      // 0–5 for a four-second capture, so every frame's duration collapsed to
      // ~1 ms and the segment showed only its last frame for the whole sentence:
      // the picture never moved inside a sentence, on either drive mode
      // (found 2026-11-20 by the page-mode acceptance run; the frames are correct,
      // their clock was not).
      frames.push({ file, atMs: Math.max(0, Math.round((timestamp - startedAt) * 1000)) })
      void writeFile(file, Buffer.from(frame.data, 'base64')).catch(() => {})
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    })

    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: options.width, maxHeight: options.height })

    // The cue clock starts at the first painted frame, so t=0 of the segment is
    // the deck's state at the moment the sentence starts — the page switch in page
    // mode has already happened by here.
    //
    // `performance.now()`, not `Date.now()`: the interval between here and the last
    // beat is three to eight seconds of wall clock, and one of the two can be
    // stepped by the system time daemon while the other cannot. A backwards step
    // used to stretch the wait and record the last beat after the cut.
    const t0 = await waitForFirstFrame(() => frames.length > 0, options.signal)
    // Beats run on the sentence's own clock in both modes: in page mode they are
    // `at_progress` cues (resolved to milliseconds against the measured length),
    // in cue mode `at_word` ones. `teachCue(n)` counts fragments inside the current
    // page, so a page-mode manuscript numbers its beats per page.
    //
    // Each beat's real moment is kept. The wait is a timer in this process plus a
    // round trip to the browser, so it can fire late for reasons the recorder
    // cannot control (a stalled event loop, a busy compositor); nothing else in
    // the pipeline would notice, and the film would ship with an animation cut
    // through the middle (docs/TEACH-MOTION.md §15).
    const beats: BeatTiming[] = []
    for (const cue of options.cues) {
      const wait = cue.atMs - (performance.now() - t0)
      if (wait > 0) await page.waitForTimeout(wait)
      await page.evaluate(index => {
        const deck = globalThis as DeckGlobals
        if (typeof deck.teachCue !== 'function') throw new Error('deck is missing window.teachCue(index)')
        deck.teachCue(index)
      }, cue.fragment)
      beats.push({ fragment: cue.fragment, atMs: cue.atMs, actualMs: Math.round(performance.now() - t0) })
    }
    // Hold to the audio's full length; the encoder cuts the tail anyway, but a
    // capture shorter than the audio would leave the last frame frozen mid-cut.
    const holdMs = options.durationMs - (performance.now() - t0)
    if (holdMs > 0) await page.waitForTimeout(holdMs)

    await cdp.send('Page.stopScreencast')
    if (frames.length === 0) throw new DeckRecordError('the screencast produced no frames at all')
    await settleFiles(frames.map(frame => frame.file))

    // Is the last frame the finished layout? The page is still open, so driving it
    // to the state the last beat asked for and screenshotting is free of a second
    // browser launch (docs/TEACH-MOTION.md §15). Skipped when the sentence fires no
    // beat: there is no motion to finish.
    const settle = options.cues.length === 0
      ? { status: 'skipped' as const, reason: 'this sentence fires no beat, so there is no motion to finish' }
      : await finishedLayout(page, options, frames[frames.length - 1]!.file, tools).catch((error: unknown) => ({
        status: 'skipped' as const,
        reason: `the finished-layout check could not run (${error instanceof Error ? error.message : String(error)})`,
      }))

    await page.close()
    await context.close()

    const listPath = join(options.workDir, 'frames.txt')
    const list = frames
      .map((frame, index) => {
        const next = frames[index + 1]
        const seconds = ((next === undefined ? options.durationMs : next.atMs) - frame.atMs) / 1000
        return `file '${frame.file.replaceAll("'", "'\\''")}'\nduration ${Math.max(seconds, 0.001).toFixed(4)}`
      })
      .join('\n')
    await writeFile(listPath, `${list}\nfile '${frames[frames.length - 1]!.file}'\n`, 'utf8')

    const path = join(options.workDir, 'segment.mp4')
    await encodeFrames(
      { listPath, output: path, durationMs: options.durationMs, width: options.width, height: options.height, fps: options.fps },
      tools,
      options.signal,
    )
    return { path, frames: frames.length, media: await probe(path, tools, options.signal), beats, settle }
  } catch (error: unknown) {
    if (error instanceof DeckRecordError) throw error
    throw new DeckRecordError(`could not record the deck (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  } finally {
    await browser?.close().catch(() => {})
  }
}

/**
 * Drive the deck to the state the last beat asked for and compare it with the
 * frame the segment was cut on.
 *
 * The room a beat has is knowable in advance (the plan checks it when the deck
 * declares `teachTransition`); whether the beat *actually* landed in time is only
 * knowable after the capture, and it is the difference between "the last item
 * faded in" and "we recorded a quarter of the fade and cut". Thresholds are
 * measured (docs/TEACH-MOTION.md §15): a segment whose motion finished differs
 * from the finished page on 0.0% of pixels at 640×360, one whose last beat was
 * still fading differs on 1.1%, and the 2026-11-25 late take differed on 11%.
 */
async function finishedLayout(
  page: Page,
  options: RecordDeckOptions,
  lastFrame: string,
  tools: MediaTools,
): Promise<SettleCheck> {
  const finalFragment = options.cues[options.cues.length - 1]!.fragment
  const declared = await page.evaluate(() => {
    const value = (globalThis as DeckGlobals).teachTransition
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  })
  const wait = Math.min(SETTLE_MAX_MS, Math.max(SETTLE_MIN_MS, declared ?? SETTLE_DEFAULT_MS)) + SETTLE_SLACK_MS
  await page.evaluate(step => {
    const deck = globalThis as DeckGlobals
    if (typeof deck.teachCue !== 'function') throw new Error('deck is missing window.teachCue(index)')
    deck.teachCue(step)
  }, finalFragment)
  await page.waitForTimeout(wait)
  const shot = join(options.workDir, 'settled.png')
  await page.screenshot({ path: shot })
  const delta = await frameDelta(lastFrame, shot, {}, tools, options.signal)
  return {
    status: delta.changed <= SETTLE_CHANGED ? 'finished' : 'unfinished',
    changed: delta.changed,
    mean: delta.mean,
    finalFragment,
  }
}

/**
 * How long this deck's page switch takes, in ms: what the deck declares, or the
 * default when it declares nothing usable.
 *
 * Read from the live page rather than parsed out of the HTML, because a deck may
 * compute the value while it initialises, and this is the same object the
 * recorder drives. A non-numeric or non-positive declaration is ignored rather
 * than trusted: a `teachPageTransition = '500'` typo must not swallow the wait
 * and record the transition itself (docs/TEACH-MOTION.md §5).
 */
async function pageTransitionMs(page: Page): Promise<number> {
  const declared = await page.evaluate(() => {
    const value = (globalThis as DeckGlobals).teachPageTransition
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  })
  return declared ?? PAGE_TRANSITION_MS
}

/** Wait until `ready()` holds, polling briefly; the capture cannot start without a first frame. */
async function waitForFirstFrame(ready: () => boolean, signal?: AbortSignal): Promise<number> {
  // `performance.now()`: this value is the zero of the segment's cue clock, so it
  // has to be on the monotonic clock `recordDeckSegment` measures beats with.
  const startedAt = performance.now()
  while (!ready()) {
    if (signal?.aborted === true) throw new DeckRecordError('recording was cancelled')
    if (performance.now() - startedAt > 10_000) throw new DeckRecordError('the deck painted no frame within 10 s')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return performance.now()
}

/** Wait until every frame file has been written; the event handler writes them asynchronously. */
async function settleFiles(paths: readonly string[]): Promise<void> {
  const { stat } = await import('node:fs/promises')
  for (const path of paths) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const info = await stat(path)
        if (info.size > 0) break
      } catch {
        // not yet
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
