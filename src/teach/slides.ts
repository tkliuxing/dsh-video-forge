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

import { cueLandings, cueOpening } from './beats.ts'
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
  /**
   * Which cue step to show, 1-based, as written in `storyboard.yaml`.
   *
   * Page mode numbers beats inside their own page; cue mode numbers them across the
   * whole deck. {@link cueLandings} turns the second kind into the first against a
   * deck that has more than one `<section>`.
   */
  fragment: number
}

/*
 * `cueLandings` / `cueOpening` live in `beats.ts` so the tail-transition planner
 * can resolve a cue number without importing this module (which pulls in
 * playwright-core). Re-exported here because callers of the recorder have always
 * found them beside it — `test/teach-cue-pages.test.ts` is one.
 */
export { cueEndPage, cueLandings, cueOpening, type CueLanding } from './beats.ts'

/** Fragments per page in the live deck, in page order; empty when the deck has no pages to count. */
async function livePageFragments(page: Page): Promise<number[]> {
  return page.evaluate(() => [...document.querySelectorAll('.slides > section')]
    .map(section => section.querySelectorAll('.fragment').length))
}

/**
 * Turn to `target`. Only a cue that actually crosses into another page needs this,
 * so a single-page deck keeps the contract it always had (`teachReady` + `teachCue`).
 */
async function turnPage(page: Page, target: number): Promise<void> {
  await page.evaluate(index => {
    const deck = globalThis as DeckGlobals
    if (typeof deck.teachPage !== 'function') {
      throw new Error('deck is missing window.teachPage(index), which a deck with more than one page needs: cue-mode beats are numbered across the whole deck, so the recorder has to turn the page itself')
    }
    deck.teachPage(index)
  }, target)
}

/** Show `step` beats of the current page; step 0 leaves it dark. */
async function lightBeats(page: Page, step: number): Promise<void> {
  if (step <= 0) return
  await page.evaluate(target => {
    const deck = globalThis as DeckGlobals
    if (typeof deck.teachCue !== 'function') throw new Error('deck is missing window.teachCue(index)')
    deck.teachCue(target)
  }, step)
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
  /**
   * Cue mode: how many beats are already shown when this sentence opens.
   *
   * Resolved from the manuscript (`cueStartFragments`), not from this sentence's own
   * cues, because a sentence that fires no beat has to open on the picture the story
   * arrived at rather than on the deck's first page. Page mode has no use for it: a
   * page there is declared, and `enter` says how much of it is lit.
   */
  startFragment?: number | null
  /** The sentence audio's real duration: the segment is cut to this. */
  durationMs: number
  /**
   * Page mode: record this much of the *next* page after the body ends, so the
   * deck's own transition between the two pages lands inside this segment
   * (docs/TEACH-MOTION.md §6.2).
   *
   * The transition belongs to the earlier sentence's tail on purpose: at the head of
   * a sentence it would put a moving picture in the first frame the sentence is
   * spoken over, which is the one thing the page-mode recorder exists to avoid.
   * `page` and `enter` are the next sentence's opening state, resolved by
   * `exitSlots`, so the seam matches what that sentence will record as its t=0.
   */
  exit?: { page: number, enter: number, ms: number } | null
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
  /** Tail transition recorded after the body, in ms; 0 for a hard cut. */
  exitMs: number
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
    // Cue mode has no declared page, so a deck with several `<section>`s is driven
    // from the beats themselves: the manuscript numbers them across the whole deck
    // and `cueLandings` says which page each number lands on. `startFragment` is how
    // many beats are already shown when this sentence opens (resolved from the
    // manuscript by `cueStartFragments`), which is what stops a late sentence from
    // re-popping every earlier beat — and what gives a sentence with no beat of its
    // own the page it belongs on.
    const pageMode = options.page !== undefined && options.page !== null
    const pages = pageMode ? [] : await livePageFragments(page)
    const landings = pageMode || options.cues.length === 0 ? null : cueLandings(pages, options.cues)
    const opening = pageMode ? null : cueOpening(pages, options.cues, options.startFragment ?? 0)
    let pageNow = 0
    if (options.page !== undefined && options.page !== null) {
      await page.evaluate(index => {
        const deck = globalThis as DeckGlobals
        if (typeof deck.teachPage !== 'function') {
          throw new Error('deck is missing window.teachPage(index), which the page mode needs (see the scaffolded template)')
        }
        deck.teachPage(index)
      }, options.page)
      pageNow = options.page
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
    } else if (opening !== null) {
      // The opening state. Nothing to drive when this is the deck's own first page
      // and it opens dark — the common single-page deck records exactly as before.
      if (opening.page !== 0) {
        await turnPage(page, opening.page)
        await page.waitForTimeout(await pageTransitionMs(page))
      }
      await lightBeats(page, opening.step)
      pageNow = opening.page
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
    for (const [index, cue] of options.cues.entries()) {
      const wait = cue.atMs - (performance.now() - t0)
      if (wait > 0) await page.waitForTimeout(wait)
      // A cue-mode beat may sit on a page the sentence has not been on yet; the page
      // switch belongs to the beat, so it happens at the beat and not before it.
      const landing = landings?.[index] ?? null
      const step = landing?.step ?? cue.fragment
      const switchTo = landing !== null && landing.page !== pageNow ? landing.page : null
      if (switchTo !== null) {
        await turnPage(page, switchTo)
        pageNow = switchTo
      }
      await lightBeats(page, step)
      beats.push({ fragment: cue.fragment, atMs: cue.atMs, actualMs: Math.round(performance.now() - t0) })
    }
    // Hold to the audio's full length; the encoder cuts the tail anyway, but a
    // capture shorter than the audio would leave the last frame frozen mid-cut.
    const holdMs = options.durationMs - (performance.now() - t0)
    if (holdMs > 0) await page.waitForTimeout(holdMs)

    // The body ends here. Remember the frame it was cut on: with a tail transition
    // the segment goes on past this point, and the finished-layout check has to
    // compare against the body, not against the next page.
    const bodyEndFrame = frames.length === 0 ? null : frames[frames.length - 1]!.file
    const exitMs = options.exit === undefined || options.exit === null ? 0 : Math.max(0, Math.round(options.exit.ms))
    if (exitMs > 0) {
      const exit = options.exit!
      await page.evaluate(({ index, step }) => {
        const deck = globalThis as DeckGlobals
        if (typeof deck.teachPage !== 'function') {
          throw new Error('deck is missing window.teachPage(index), which a tail transition needs to turn the page')
        }
        deck.teachPage(index)
        if (step > 0) {
          if (typeof deck.teachCue !== 'function') {
            throw new Error('deck is missing window.teachCue(index), which a tail transition needs to land on the next sentence\'s opening state')
          }
          deck.teachCue(step)
        }
      }, { index: exit.page, step: exit.enter })
      // No wait for `teachPageTransition` here: the deck's page transition *is* the
      // picture this segment was extended for. Waiting it out would record a settled
      // next page and deliver the hard cut the manuscript asked not to have.
      await page.waitForTimeout(exitMs)
    }

    await cdp.send('Page.stopScreencast')
    if (frames.length === 0) throw new DeckRecordError('the screencast produced no frames at all')
    await settleFiles(frames.map(frame => frame.file))

    // Is the last frame the finished layout? The page is still open, so driving it
    // to the state the last beat asked for and screenshotting is free of a second
    // browser launch (docs/TEACH-MOTION.md §15). Skipped when the sentence fires no
    // beat: there is no motion to finish.
    const settle = options.cues.length === 0
      ? { status: 'skipped' as const, reason: 'this sentence fires no beat, so there is no motion to finish' }
      : await finishedLayout(
        page,
        options,
        bodyEndFrame ?? frames[frames.length - 1]!.file,
        tools,
        landings === null ? null : (landings[landings.length - 1]?.step ?? null),
        landings === null ? null : (landings[landings.length - 1]?.page ?? null),
      ).catch((error: unknown) => ({
        status: 'skipped' as const,
        reason: `the finished-layout check could not run (${error instanceof Error ? error.message : String(error)})`,
      }))

    await page.close()
    await context.close()

    const listPath = join(options.workDir, 'frames.txt')
    // The segment is `durationMs + exitMs` long: the tail transition is part of the
    // picture and of nothing else (no narration plays over it).
    const totalMs = options.durationMs + exitMs
    const list = frames
      .map((frame, index) => {
        const next = frames[index + 1]
        const seconds = ((next === undefined ? totalMs : next.atMs) - frame.atMs) / 1000
        return `file '${frame.file.replaceAll("'", "'\\''")}'\nduration ${Math.max(seconds, 0.001).toFixed(4)}`
      })
      .join('\n')
    await writeFile(listPath, `${list}\nfile '${frames[frames.length - 1]!.file}'\n`, 'utf8')

    const path = join(options.workDir, 'segment.mp4')
    await encodeFrames(
      { listPath, output: path, durationMs: totalMs, width: options.width, height: options.height, fps: options.fps },
      tools,
      options.signal,
    )
    return { path, frames: frames.length, media: await probe(path, tools, options.signal), beats, settle, exitMs }
  } catch (error: unknown) {
    if (error instanceof DeckRecordError) throw error
    throw new DeckRecordError(`could not record the deck (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  } finally {
    await browser?.close().catch(() => {})
  }
}


/** One sentence as the continuous recorder needs it: its cues on its own clock. */
export interface RunSentence {
  id: string
  /** Cues relative to this sentence's start, in ms — what `cuesFor()` already gives. */
  cues: readonly { atMs: number, fragment: number }[]
  durationMs: number
}

export interface RecordDeckRunOptions {
  deckPath: string
  /** In timeline order. The run's length is the sum of their durations. */
  sentences: readonly RunSentence[]
  width: number
  height: number
  fps: number
  /** Where one sentence's intermediates live; `segment.mp4` is written inside it. */
  workDirFor: (id: string) => string
  chromiumPath?: string | null
  settleMs?: number
  signal?: AbortSignal
}

/**
 * Record one slides segment as a **single continuous session** (docs/TEACH-VIDEO.md §29.3).
 *
 * The difference from `recordDeckSegment` is the deck's lifetime: it is loaded once,
 * and every sentence in the segment is captured against it. Nothing is re-driven
 * between sentences — cue-mode beats are numbered across the whole deck, so the state
 * the previous sentence left *is* the state the next sentence opens on, and the page
 * turns that belong between two sentences are recorded where they happen instead of
 * being replaced by a hard cut. That is the whole point: with a single master track
 * there are no seams, and with one session there is nothing to cut.
 *
 * Segments stay one file per sentence on disk, so per-sentence re-recording, the
 * `only` narrowing and the per-sentence finished-layout check all keep working.
 * The cost of a retry is different: re-recording one sentence inside an already
 * recorded run means re-driving it to its opening state in a *fresh* page, which can
 * differ from the frame the previous sentence left by a few pixels (reveal lays the
 * stage out on the slide change). A late beat therefore re-runs the whole run.
 *
 * This duplicates the capture plumbing of `recordDeckSegment` on purpose: page mode
 * and the per-sentence cue contract have their own, tested lifecycle, and this
 * contract must not be able to regress them.
 */
export async function recordDeckRun(options: RecordDeckRunOptions, tools: MediaTools = {}): Promise<RecordedSegment[]> {
  const recorded: RecordedSegment[] = []
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

    const firstWorkDir = options.workDirFor(options.sentences[0]!.id)
    await mkdir(firstWorkDir, { recursive: true })
    const probePath = join(firstWorkDir, 'first-frame.png')
    await page.screenshot({ path: probePath })
    const colors = await countFrameColors(probePath, {}, tools, options.signal)
    if (colors <= 1) {
      throw new DeckRecordError(
        `the deck at ${options.deckPath} painted a single flat colour (${colors} distinct colour${colors === 1 ? '' : 's'}); `
        + 'the stage did not lay out, so this segment would be blank. Check that the deck loads its stylesheets and that reveal.js reports ready (window.teachReady).',
      )
    }

    // The beat numbering is the deck's, translated once for the whole run.
    const pages = await livePageFragments(page)
    const allCues = options.sentences.flatMap(sentence => [...sentence.cues])
    const landings = allCues.length === 0 ? null : cueLandings(pages, allCues)
    const cdp: CDPSession = await context.newCDPSession(page)
    let cursor = 0
    // Tracked locally rather than read back from the deck: a page turn only has to
    // happen when the beat's landing says so, and a deck without a `Reveal` global
    // (the template always has one) must not make the recorder guess.
    let pageNow = 0

    for (const sentence of options.sentences) {
      const workDir = options.workDirFor(sentence.id)
      const framesDir = join(workDir, 'frames')
      await mkdir(framesDir, { recursive: true })
      const mine = landings === null ? null : landings.slice(cursor, cursor + sentence.cues.length)
      cursor += sentence.cues.length

      const frames: { file: string, atMs: number }[] = []
      let startedAt: number | null = null
      const onFrame = (event: unknown): void => {
        const frame = event as ScreencastFrame
        const timestamp = typeof frame.metadata.timestamp === 'number' ? frame.metadata.timestamp : Date.now() / 1000
        if (startedAt === null) startedAt = timestamp
        const file = join(framesDir, `f${String(frames.length).padStart(6, '0')}.jpg`)
        frames.push({ file, atMs: Math.max(0, Math.round((timestamp - startedAt) * 1000)) })
        void writeFile(file, Buffer.from(frame.data, 'base64')).catch(() => {})
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      }
      cdp.on('Page.screencastFrame', onFrame)
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: options.width, maxHeight: options.height })

      const readyAt = await waitForFirstFrame(() => frames.length > 0, options.signal)

      // The page this sentence lives on is shown when the sentence *starts*, not when
      // its first beat fires. A cue names a word ("…也怕「画面」和旁白…"), so waiting
      // for it left the previous page on screen for another 0.2–2.8 s while the
      // narration had already moved on — measured on the showcase film, where every
      // sentence's first cue word sat 170–2774 ms in and the subtitle had switched at
      // the sentence's first word (docs/TEACH-VIDEO.md §29.4). Turning here records
      // the deck's own page transition at the boundary, and the beats still land on
      // their words.
      const opening = mine === null || mine.length === 0
        ? null
        : { page: mine[0]!.page, step: Math.max(0, mine[0]!.step - 1) }
      if (opening !== null) {
        if (opening.page !== pageNow) {
          await turnPage(page, opening.page)
          pageNow = opening.page
        }
        // Idempotent in a continuous run: the beats before a first cue are the ones
        // the previous sentence already lit. A sentence whose first cue opens a page
        // has none, and `lightBeats(0)` does nothing.
        if (opening.step > 0) await lightBeats(page, opening.step)
      }

      const beats: BeatTiming[] = []
      for (const [index, cue] of sentence.cues.entries()) {
        const landing = mine?.[index] ?? null
        const waitMs = cue.atMs - (performance.now() - readyAt)
        if (waitMs > 0) await page.waitForTimeout(waitMs)
        if (landing !== null) {
          // The deck's own page transition is the transition here: it starts at the
          // beat that crosses the page and is recorded like any other motion.
          if (landing.page !== pageNow) {
            await turnPage(page, landing.page)
            pageNow = landing.page
          }
          await lightBeats(page, landing.step)
        }
        beats.push({ fragment: cue.fragment, atMs: cue.atMs, actualMs: Math.round(performance.now() - readyAt) })
      }
      const hold = sentence.durationMs - (performance.now() - readyAt)
      if (hold > 0) await page.waitForTimeout(hold)

      const bodyEnd = frames.length === 0 ? null : frames[frames.length - 1]!.file
      await cdp.send('Page.stopScreencast')
      cdp.off('Page.screencastFrame', onFrame)
      if (frames.length === 0) throw new DeckRecordError('the screencast produced no frames at all')
      await settleFiles(frames.map(frame => frame.file))

      const settle = bodyEnd === null
        ? { status: 'skipped' as const, reason: 'the capture produced no frame to compare' }
        : await finishedLayout(
          page,
          { ...options, deckPath: options.deckPath, cues: sentence.cues, durationMs: sentence.durationMs, workDir, width: options.width, height: options.height, fps: options.fps },
          bodyEnd,
          tools,
          mine === null ? null : (mine[mine.length - 1]?.step ?? null),
          mine === null ? null : (mine[mine.length - 1]?.page ?? null),
        ).catch((error: unknown) => ({
          status: 'skipped' as const,
          reason: `the finished-layout check could not run (${error instanceof Error ? error.message : String(error)})`,
        }))

      const listPath = join(workDir, 'frames.txt')
      const totalMs = sentence.durationMs
      const list = frames
        .map((frame, index) => {
          const next = frames[index + 1]
          const seconds = ((next === undefined ? totalMs : next.atMs) - frame.atMs) / 1000
          return `file '${frame.file.replaceAll("'", "'\\''")}'\nduration ${Math.max(seconds, 0.001).toFixed(4)}`
        })
        .join('\n')
      await writeFile(listPath, `${list}\nfile '${frames[frames.length - 1]!.file}'\n`, 'utf8')
      const path = join(workDir, 'segment.mp4')
      await encodeFrames(
        { listPath, output: path, durationMs: totalMs, width: options.width, height: options.height, fps: options.fps },
        tools,
        options.signal,
      )
      recorded.push({ path, frames: frames.length, media: await probe(path, tools, options.signal), beats, settle, exitMs: 0 })
    }
    await page.close()
    await context.close()
    return recorded
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
  /** Cue mode: the beat inside its page, when the caller translated the number. */
  finalStep: number | null = null,
  /**
   * The page the body ended on. Page mode knows it from the manuscript; cue mode
   * only from the last beat's landing, and re-driving page 0 instead reported every
   * body that sits on page 2 or later as "cut through an animation" (measured
   * 2026-11-26: 5.5–7.8% against a 0.2% threshold, on exactly the sentences whose
   * page index was ≥1).
   */
  finalPage: number | null = null,
): Promise<SettleCheck> {
  const finalFragment = finalStep ?? options.cues[options.cues.length - 1]!.fragment
  // With a tail transition the deck is left on the *next* page, so the finished
  // layout of this sentence has to be reproduced. Reproduced, not re-driven: a
  // `teachPage` on the live deck returns to the page but not to the geometry the
  // body was recorded at — reveal only lays the stage out when the slide index
  // actually changes, so page 0 of a session sits a few pixels away from page 0
  // after a switch (measured 2026-11-26: every transitioned segment reported
  // 3–5% "unfinished" against a 0.2% threshold, with all text 15 px lower). A
  // fresh load plus the same `teachPage` reproduces the segment's own t=0 exactly.
  const exitMs = options.exit === undefined || options.exit === null ? 0 : options.exit.ms
  if (exitMs > 0) {
    await page.goto(pathToFileURL(options.deckPath).href, { waitUntil: 'load' })
    await page.waitForFunction(() => (globalThis as DeckGlobals).teachReady === true, undefined, { timeout: 15_000 })
    await page.evaluate(index => {
      const deck = globalThis as DeckGlobals
      if (typeof deck.teachPage === 'function') deck.teachPage(index)
    }, finalPage ?? options.page ?? 0)
  }
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
