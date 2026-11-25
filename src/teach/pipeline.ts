/**
 * The teaching pipeline: one storyboard in, one narrated video out.
 *
 * Four steps, each one a separate tool call so a failure does not cost the
 * others (docs/TEACH-VIDEO.md §4):
 *
 *   1. plan    — validate, split, estimate. No side effects, no money.
 *   2. narrate — one TTS call per sentence; audio files plus timings.json.
 *   3. render  — one segment per sentence, driven by the word timings.
 *   4. assemble— concatenate the segments, mix the narration, mux.
 *
 * The order is not cosmetic: `timings.json` is written by step 2 and read by
 * step 3, and it is the only clock. A sentence is the unit of retry, so every
 * intermediate file is named by sentence id and a re-run of step 3 can be
 * narrowed to the sentences that changed.
 *
 * Paths here are host-absolute. The caller (a tool) resolves the session's
 * workspace to that path first; nothing in this module guesses where it is.
 */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { concatAudio, concatSegments, cutAudioSegment, encodeCfrSegment, muxNarration, probe, type MediaTools } from './ffmpeg.ts'
import type { ManimTools } from './manim.ts'
import { CHARS_PER_SECOND } from './rules.ts'
import { DEFAULT_SUBTITLE_STYLE, forceStyle, type SubtitleStyle } from './subtitles.ts'
import { DEFAULT_VOICE as DEFAULT_VOICE_PRIVATE } from './storyboard.ts'
import { recordDeckSegment, type CueAt } from './slides.ts'
import {
  allSentences,
  cueOffsetMs,
  pagesUsed,
  pageSlotOf,
  parseTimings,
  serializeTimings,
  totalDurationMs,
  type Cue,
  type Storyboard,
  type TimedSentence,
  type TimedWord,
  type Timings,
  type VoiceSpec,
} from './storyboard.ts'
import { pausePolicyFor, sentenceEndPauseMs, supportsWordTimings, synthesizeDeepseek, synthesizeUtterance, VOICE_SAMPLE_RATE } from './voice.ts'

/** What a run will do, before it does any of it. */
export interface Plan {
  title: string
  sentences: { id: string, segment: string, engine: string, say: string, chars: number }[]
  /** Characters of narration, which is what a TTS bill is computed from. */
  totalChars: number
  /** Rough spoken length at 240 Chinese characters per minute; never a promise. */
  estimatedSeconds: number
  /** Things that will cost a re-run, stated up front rather than discovered mid-render. */
  warnings: string[]
  /** The voice in effect, and whether it can drive a picture inside a sentence. */
  voice: { provider: string, speaker: string, wordTimings: boolean }
}

/**
 * Characters per minute used only for a pre-flight estimate; derived from the
 * measured rate in `rules.ts` so the plan and the per-sentence budget cannot
 * disagree. The 2026-11-20 sample spoke 876 characters in 174.3 s.
 */
const CHARS_PER_MINUTE = CHARS_PER_SECOND * 60

/** Describe the work without doing it. */
export function planStoryboard(board: Storyboard): Plan {
  const sentences = allSentences(board).map(({ segment, sentence }) => ({
    id: sentence.id,
    segment: segment.id,
    engine: segment.engine,
    say: sentence.say,
    chars: sentence.say.length,
  }))
  const totalChars = sentences.reduce((sum, sentence) => sum + sentence.chars, 0)
  const warnings: string[] = []
  if (board.voice === null) warnings.push('meta.voice is missing; the narrator falls back to the manifest and then to a configuration error')
  const longest = sentences.reduce((worst, sentence) => (sentence.chars > worst.chars ? sentence : worst), sentences[0]!)
  if (longest.chars > 120) warnings.push(`sentence "${longest.id}" is ${longest.chars} characters; long lines make one bad syllable cost a whole segment`)
  if (board.segments.some(segment => segment.engine === 'manim')) {
    warnings.push('manim segments compile LaTeX on first use; the first render of a project takes tens of seconds longer')
  }
  const voice = board.voice ?? { provider: DEFAULT_VOICE_PRIVATE.provider, speaker: DEFAULT_VOICE_PRIVATE.speaker, speedRatio: null }
  const wordTimings = supportsWordTimings(voice.provider)
  if (!wordTimings) {
    // Page mode is not a downgrade to "no cues": one page per sentence, and the
    // `at_progress` beats inside a sentence do fire, on shares of the measured
    // length. Saying "the cues cannot fire" here contradicted what the render step
    // then printed for the same run, and an author who believed the warning would
    // delete working beats (found 2026-11-20 by the page-mode acceptance run).
    const slidesSegments = board.segments.filter(segment => segment.engine === 'slides')
    const pages = slidesSegments.reduce((sum, segment) => sum + pagesUsed(segment), 0)
    // Sentences may share a page (§25), so the page count is what the manuscript
    // asks for rather than the sentence count. Telling an author "one page per
    // sentence" over a manuscript that shares pages is the kind of claim this
    // route exists to stop making.
    const sharedPages = slidesSegments.some(segment => segment.sentences.some(sentence => sentence.page !== null))
    if (pages > 0) {
      const count = `${pages} deck page${pages === 1 ? '' : 's'}${sharedPages ? ` for ${slidesSegments.reduce((sum, segment) => sum + segment.sentences.length, 0)} sentence(s), shared where the manuscript says \`page\`` : ' (one per sentence)'}`
      warnings.push(`voice provider "${voice.provider}" reports no word timings: slides run in page mode, ${count}, with \`at_progress\` beats inside a sentence placed by share of the measured length. Nothing is aligned to a spoken word; cue-driven fragments need volcengine`)
    }
  }
  return {
    title: board.title,
    sentences,
    totalChars,
    estimatedSeconds: Math.round((totalChars / CHARS_PER_MINUTE) * 60),
    warnings,
    voice: { provider: voice.provider, speaker: voice.speaker, wordTimings },
  }
}

/** Where each sentence's files live under one project root. */
export interface TeachPaths {
  /** Root of the teaching project (the workspace, or a subfolder of it). */
  root: string
  /** Audio directory, relative to the root. */
  audio: string
  /** Timings file, relative to the root. */
  timings: string
  /** Intermediate captures, relative to the root; safe to delete. */
  work: string
  /** Segment files, relative to the root; safe to delete. */
  segments: string
}

export const DEFAULT_TEACH_PATHS: Omit<TeachPaths, 'root'> = {
  audio: 'audio',
  timings: 'timings.json',
  work: '.dsh-video/teach',
  segments: '.dsh-video/teach/segments',
}

export type NarrationMerge = 'auto' | 'none'

/** Sentences per merged request. Well under the service's own ceiling, and small enough that one bad line does not re-synthesize a whole section. */
export const MAX_UTTERANCE_CHARS = 480

export interface NarrateOptions {
  board: Storyboard
  voice: VoiceSpec
  /** Resolved voice credential. The caller owns where it came from. */
  apiKey: string
  paths: TeachPaths
  tools?: MediaTools
  signal?: AbortSignal
  /** Called after each sentence lands; the tool surfaces it as progress. */
  onSentence?: (id: string, index: number, total: number) => void
  /**
   * Only these sentences are synthesized; the rest keep the narration already in
   * `timings.json`. This is the "one bad line" path: retrying a sentence must not
   * pay for the whole script or move any other sentence's audio.
   */
  only?: readonly string[]
  /**
   * `auto` (default) sends one request per run of adjacent selected sentences,
   * `none` sends one request per sentence.
   *
   * Merging exists because the user's listening test (docs/TEACH-VIDEO.md §18)
   * found separate requests audibly restarting the prosody: same voice, but the
   * tone and energy drift sentence to sentence. One request per utterance keeps
   * them coherent. `none` stays available as the isolation and comparison path.
   */
  merge?: NarrationMerge
}

export interface NarrateResult {
  timings: Timings
  /** Sentences that were synthesized in this run (a narrowed re-run reports only those). */
  narrated: string[]
  /** Milliseconds of narration produced, summed from the files. */
  durationMs: number
  /** How many requests were sent; a merged run sends fewer than it narrates. */
  requests: number
}

/**
 * Group sentence indexes into TTS requests.
 *
 * A group never spans an unselected sentence: the kept sentence's audio sits
 * between the two in the finished timeline, so joining across it would move a
 * boundary the operator did not ask to move. A group also stops at
 * {@link MAX_UTTERANCE_CHARS}, so one long run cannot become a single
 * uninterruptible request.
 */
export function planUtterances(sentences: readonly { id: string, say: string }[], only: readonly string[] | undefined, merge: NarrationMerge): number[][] {
  const selected = sentences.map((_, index) => index).filter(index => only === undefined || only.length === 0 || only.includes(sentences[index]!.id))
  if (merge === 'none') return selected.map(index => [index])
  const groups: number[][] = []
  let current: number[] = []
  let chars = 0
  for (const index of selected) {
    const size = sentences[index]!.say.trim().length
    const adjacent = current.length > 0 && current[current.length - 1] === index - 1
    if (current.length === 0 || (adjacent && chars + size <= MAX_UTTERANCE_CHARS)) {
      current.push(index)
      chars += size
      continue
    }
    groups.push(current)
    current = [index]
    chars = size
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Where one sentence's audio is cut, and how long it has to end up. */
export interface SegmentTiming {
  /** First sample kept, in the utterance's timeline. */
  startMs: number
  /** Samples kept, before padding. */
  cutMs: number
  /** Final length: the words plus the pause the punctuation asked for. */
  targetMs: number
}

/**
 * Compute one sentence's slice out of an utterance.
 *
 * The boundary is the **next sentence's first word**, not this sentence's last
 * word (docs/TEACH-VIDEO.md §18): the gap between them belongs to this sentence,
 * and cutting at the last word is exactly what made every sentence break in the
 * earlier build sound clipped. When the service's own gap is shorter than the
 * punctuation deserves, the slice is padded up to it; when it is longer, it is
 * kept as is. Padding never trims.
 */
export function segmentTiming(options: {
  audioDurationMs: number
  words: readonly TimedWord[]
  /** Next sentence's first word, or null for the last sentence of an utterance. */
  nextStartMs: number | null
  /** The sentence's text, read for its final punctuation. */
  endText: string
  /** Merged slices start at the first word; a single-sentence request keeps its lead-in. */
  trimLead: boolean
}): SegmentTiming {
  const first = options.words[0]
  const last = options.words[options.words.length - 1]
  if (first === undefined || last === undefined) throw new Error('a sentence with no word timings cannot be cut')
  const startMs = options.trimLead ? Math.max(0, first.b) : 0
  const contentEnd = Math.max(startMs, last.e)
  const limit = options.nextStartMs ?? options.audioDurationMs
  const natural = Math.max(0, limit - contentEnd)
  const pause = Math.max(natural, sentenceEndPauseMs(options.endText))
  const cutEnd = Math.min(Math.max(limit, contentEnd), contentEnd + pause)
  return {
    startMs,
    cutMs: Math.max(0, cutEnd - startMs),
    targetMs: Math.max(1, contentEnd - startMs + pause),
  }
}

/**
 * Synthesize the narration and write `timings.json`.
 *
 * Every sentence is one file (`audio/<id>.mp3`) and one entry in the timeline,
 * but not necessarily one request: adjacent selected sentences go out together
 * and are cut apart afterwards, so the prosody runs on across the join while the
 * timeline keeps its per-sentence unit. The cut keeps the natural gap (padded up
 * to the punctuation's nominal pause when the voice was terse), which is what
 * makes a sentence break audible.
 */
export async function narrateSentences(options: NarrateOptions): Promise<NarrateResult> {
  const audioDir = join(options.paths.root, options.paths.audio)
  await mkdir(audioDir, { recursive: true })
  const entries = allSentences(options.board)
  const list = entries.map(entry => entry.sentence)
  const merge: NarrationMerge = options.merge ?? 'auto'
  const only = options.only !== undefined && options.only.length > 0 ? options.only : undefined

  // A narrowed run keeps the sentences it is not re-recording, so their audio and
  // offsets must already exist. Reading them up front makes a missing one a clear
  // error instead of a video that silently loses that sentence.
  let previous: Timings | null = null
  if (only !== undefined) {
    previous = await readTimings(options.paths).catch((error: unknown) => {
      throw new Error(`a narrowed narration run needs an existing ${options.paths.timings} (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  const workDir = join(options.paths.root, options.paths.work, 'utterance')
  await mkdir(workDir, { recursive: true })
  const timed = new Map<string, TimedSentence>()
  const narrated: string[] = []

  // A provider that reports no word timings cannot be sliced by word offset, so
  // it is synthesized sentence by sentence and its timeline is the audio files
  // alone. `merge` is therefore not a choice for it: asking for `auto` is not an
  // error, it simply cannot apply, and saying so beats failing a paid run. The
  // pause policy is `natural` too — the provider's own gaps are kept exactly as
  // produced, because the listening test preferred them to any padded version.
  if (!supportsWordTimings(options.voice.provider)) {
    if (pausePolicyFor(options.voice.provider) !== 'natural') {
      // Defensive: the two functions are one policy, and a provider added later
      // must not land here with a padding rule it never agreed to.
      throw new Error(`provider "${options.voice.provider}" reports no word timings but asks for punctuation padding; the two decisions are inconsistent`)
    }
    for (const entry of entries) {
      if (only !== undefined && !only.includes(entry.sentence.id)) {
        const kept = previous?.sentences.find(item => item.id === entry.sentence.id)
        if (kept === undefined) throw new Error(`sentence "${entry.sentence.id}" was not synthesized and has no narration in ${options.paths.timings}; narrate it too`)
        timed.set(kept.id, kept)
        continue
      }
      const produced = await synthesizeDeepseek({
        text: entry.sentence.say,
        apiKey: options.apiKey,
        ...(options.voice.speaker === '' ? {} : { voiceId: options.voice.speaker }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const relative = `${options.paths.audio}/${entry.sentence.id}.wav`
      const absolute = join(options.paths.root, relative)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, produced.audio)
      const media = await probe(absolute, options.tools ?? {}, options.signal)
      if (media.durationMs === null) throw new Error(`ffprobe reported no duration for ${relative}; the file is unusable`)
      timed.set(entry.sentence.id, {
        id: entry.sentence.id,
        text: entry.sentence.say,
        audio: relative,
        durationMs: media.durationMs,
        words: [],
      })
      narrated.push(entry.sentence.id)
      options.onSentence?.(entry.sentence.id, narrated.length, entries.length)
    }
    const deepseekTimings: Timings = {
      voice: { provider: options.voice.provider, speaker: options.voice.speaker, speedRatio: options.voice.speedRatio, timestamps: 'none' },
      sentences: entries.map(entry => timed.get(entry.sentence.id)).filter((item): item is TimedSentence => item !== undefined),
    }
    const target = join(options.paths.root, options.paths.timings)
    await mkdir(dirname(target), { recursive: true })
    const staging = `${target}.tmp`
    await writeFile(staging, serializeTimings(deepseekTimings, { sampleRate: VOICE_SAMPLE_RATE }), 'utf8')
    await rename(staging, target)
    return { timings: deepseekTimings, narrated, durationMs: totalDurationMs(deepseekTimings), requests: narrated.length }
  }

  const groups = planUtterances(list, only, merge)

  for (const group of groups) {
    const synthesized = await synthesizeUtterance({
      texts: group.map(index => list[index]!.say),
      speaker: options.voice.speaker,
      apiKey: options.apiKey,
      speedRatio: options.voice.speedRatio,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const rawPath = join(workDir, `${list[group[0]!]!.id}.mp3`)
    await writeFile(rawPath, synthesized.audio)
    const raw = await probe(rawPath, options.tools ?? {}, options.signal)
    if (raw.durationMs === null) throw new Error(`ffprobe reported no duration for the utterance of "${list[group[0]!]!.id}"; the audio is unusable`)
    const audioDurationMs = raw.durationMs

    for (let position = 0; position < group.length; position += 1) {
      const index = group[position]!
      const sentence = list[index]!
      const words = synthesized.words.filter((_, wordIndex) => synthesized.groups[wordIndex] === position)
      if (words.length === 0) {
        throw new Error(`sentence "${sentence.id}" came back with no words of its own from a merged request; run with merge: none to synthesize it alone`)
      }
      const nextWords = group.length > position + 1
        ? synthesized.words.filter((_, wordIndex) => synthesized.groups[wordIndex] === position + 1)
        : []
      const timing = segmentTiming({
        audioDurationMs,
        words,
        nextStartMs: merge === 'none' ? null : (nextWords[0]?.b ?? null),
        endText: sentence.say,
        trimLead: merge !== 'none',
      })
      const relative = `${options.paths.audio}/${sentence.id}.mp3`
      const absolute = join(options.paths.root, relative)
      if (merge === 'none' && timing.startMs === 0 && timing.cutMs >= audioDurationMs && timing.targetMs <= audioDurationMs) {
        // Nothing to cut or pad: keep the service's own bytes rather than re-encode.
        await copyFile(rawPath, absolute)
      } else {
        await cutAudioSegment({
          input: rawPath,
          output: absolute,
          startMs: timing.startMs,
          cutMs: timing.cutMs,
          targetMs: timing.targetMs,
          sampleRate: VOICE_SAMPLE_RATE,
        }, options.tools ?? {}, options.signal)
      }
      const media = await probe(absolute, options.tools ?? {}, options.signal)
      timed.set(sentence.id, {
        id: sentence.id,
        text: sentence.say,
        audio: relative,
        durationMs: media.durationMs ?? Math.round(timing.targetMs),
        words,
      })
      narrated.push(sentence.id)
      options.onSentence?.(sentence.id, index, list.length)
    }
  }

  const ordered: TimedSentence[] = []
  for (const { sentence } of entries) {
    const fresh = timed.get(sentence.id)
    if (fresh !== undefined) {
      ordered.push(fresh)
      continue
    }
    const kept = previous?.sentences.find(entry => entry.id === sentence.id)
    if (kept === undefined) throw new Error(`sentence "${sentence.id}" was not synthesized and has no narration in ${options.paths.timings}; narrate it too`)
    ordered.push(kept)
  }

  const timings: Timings = {
    voice: { provider: options.voice.provider, speaker: options.voice.speaker, speedRatio: options.voice.speedRatio },
    sentences: ordered,
  }

  const timingsPath = join(options.paths.root, options.paths.timings)
  await mkdir(dirname(timingsPath), { recursive: true })
  const staging = `${timingsPath}.tmp`
  await writeFile(staging, serializeTimings(timings, { sampleRate: VOICE_SAMPLE_RATE, merge }), 'utf8')
  await rename(staging, timingsPath)

  return { timings, narrated, durationMs: totalDurationMs(timings), requests: groups.length }
}

export interface RenderOptions {
  board: Storyboard
  timings: Timings
  paths: TeachPaths
  /** Chromium binary for slide segments; null uses Playwright's own lookup. */
  chromiumPath?: string | null
  /** ffmpeg/ffprobe, plus the Python and TeX locations a manim segment needs. */
  tools?: MediaTools & ManimTools
  signal?: AbortSignal
  /** Only these sentence ids; omitted means every sentence. */
  only?: readonly string[]
  onSegment?: (id: string, path: string) => void
}

export interface RenderedSegment {
  id: string
  /** Absolute path of the encoded segment. */
  path: string
  durationMs: number
  /** Frames the browser capture produced; a slide with one frame is a slide that never moved. */
  frames: number | null
}

/**
 * How a deck is driven for this narration.
 *
 * `cue` needs word timings: a cue names a word, and a word has a moment. `page`
 * is the honest mode for a provider that reports none — one page per sentence,
 * held for the sentence's measured length. The mode is derived from the timings
 * rather than configured, so a manuscript cannot claim cue control it does not
 * have (docs/TEACH-VIDEO.md §21).
 */
export type DeckDriveMode = 'cue' | 'page'

/** Which drive mode this narration supports. */
export function deckDriveMode(timings: Timings): DeckDriveMode {
  return timings.voice.timestamps === 'none' ? 'page' : 'cue'
}

/** The cues for one sentence, on the sentence's own clock. */
export function cuesFor(sentence: TimedSentence, cues: readonly Cue[]): CueAt[] {
  return cues.map(cue => ({ atMs: cueOffsetMs(sentence, cue), fragment: cue.fragment }))
}

/** Render one segment per sentence. Slides are recorded; manim scenes are run. */
export async function renderSegments(options: RenderOptions): Promise<RenderedSegment[]> {
  const segmentsDir = join(options.paths.root, options.paths.segments)
  await mkdir(segmentsDir, { recursive: true })
  const board = options.board
  const byId = new Map(options.timings.sentences.map(sentence => [sentence.id, sentence]))
  const rendered: RenderedSegment[] = []

  for (const { segment, sentence } of allSentences(board)) {
    if (sentence.id === undefined) continue
    if (options.only !== undefined && !options.only.includes(sentence.id)) continue
    const timed = byId.get(sentence.id)
    if (timed === undefined) throw new Error(`sentence "${sentence.id}" has no narration; run narrate first`)
    const workDir = join(options.paths.root, options.paths.work, sentence.id)

    if (segment.engine === 'manim') {
      if (segment.scene === null) throw new Error(`segment "${segment.id}" has no scene`)
      const { manimSegment } = await import('./manim.ts')
      const result = await manimSegment({
        scene: join(options.paths.root, segment.scene),
        workDir,
        timed,
        video: board.video,
        tools: options.tools ?? {},
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      rendered.push({ id: sentence.id, path: result.path, durationMs: timed.durationMs, frames: null })
      options.onSegment?.(sentence.id, result.path)
      continue
    }

    if (segment.deck === null) throw new Error(`segment "${segment.id}" has no deck`)
    // Page mode numbers pages by the sentence's position inside its segment unless
    // the manuscript says otherwise: `page` lets several sentences share one page,
    // and `enter` says how much of it is already lit when the sentence starts. Both
    // are resolved together by `pageSlots`, because the derived `enter` depends on
    // the sentence before it on the same page (docs/TEACH-VIDEO.md §25).
    const mode = deckDriveMode(options.timings)
    const slot = mode === 'page' ? pageSlotOf(segment, sentence.id) : null
    if (mode === 'page' && slot === null) throw new Error(`sentence "${sentence.id}" is not in segment "${segment.id}"`)
    const recorded = await recordDeckSegment({
      deckPath: join(options.paths.root, segment.deck),
      ...(slot === null ? {} : { page: slot.page, enter: slot.enter }),
      // In page mode the cues are `at_progress` cues resolved against the
      // measured sentence length; in cue mode they are `at_word` cues.
      cues: cuesFor(timed, sentence.cues),
      durationMs: timed.durationMs,
      width: board.video.width,
      height: board.video.height,
      fps: board.video.fps,
      workDir,
      ...(options.chromiumPath === undefined ? {} : { chromiumPath: options.chromiumPath }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, options.tools ?? {})
    rendered.push({ id: sentence.id, path: recorded.path, durationMs: timed.durationMs, frames: recorded.frames })
    options.onSegment?.(sentence.id, recorded.path)
  }
  return rendered
}

/** One segment as the assembler needs it: which sentence it belongs to, and where the file is. */
export interface SegmentRef {
  id: string
  /** Absolute path of the encoded segment. */
  path: string
  durationMs: number
  /** Workspace-relative narration file for this sentence; absent means `audio/<id>.mp3`. */
  audio?: string | null
}

/** Where a sentence's segment lives once rendered, under the project root. */
export function segmentPath(paths: TeachPaths, id: string): string {
  return join(paths.root, paths.work, id, 'segment.mp4')
}

export interface SegmentPlan {
  /** In timeline order — the order the sentences appear in the manuscript. */
  segments: SegmentRef[]
  /** Sentences this call rendered. */
  fresh: string[]
  /** Sentences whose segment was already on disk and was kept. */
  reused: string[]
  /** Sentences with no picture yet; empty unless `requireAll` was turned off. */
  pending: string[]
}

export interface SegmentPlanOptions {
  /**
   * Whether every sentence must already have a picture.
   *
   * True when the segments are about to be assembled. False for a narrowed render
   * that is not assembling yet (`assemble: false`), where "render only the slides
   * now, the Manim sentences later" is a legitimate way to split a long run — the
   * run used to fail with `no picture for "s02-1"` after finishing the work it was
   * asked for (found 2026-11-20 by the page-mode acceptance run).
   */
  requireAll?: boolean
}

/**
 * Work out the segment for every sentence, mixing freshly rendered ones with
 * whatever an earlier run left on disk.
 *
 * This is what makes "re-record only the third sentence" real: narration for
 * every sentence always exists (it is the clock), but the picture is rebuilt or
 * kept per sentence. A missing segment is named rather than silently skipped —
 * a silently skipped sentence would produce a video that jumps.
 */
export async function planSegments(
  paths: TeachPaths,
  timings: Timings,
  rendered: readonly RenderedSegment[] = [],
  options: SegmentPlanOptions = {},
): Promise<SegmentPlan> {
  const requireAll = options.requireAll ?? true
  const fresh = new Map(rendered.map(segment => [segment.id, segment]))
  const segments: SegmentRef[] = []
  const freshIds: string[] = []
  const reusedIds: string[] = []
  const missing: string[] = []
  for (const sentence of timings.sentences) {
    const done = fresh.get(sentence.id)
    if (done !== undefined) {
      segments.push({ id: sentence.id, path: done.path, durationMs: sentence.durationMs, audio: sentence.audio })
      freshIds.push(sentence.id)
      continue
    }
    const path = segmentPath(paths, sentence.id)
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('not a file')
    } catch {
      missing.push(sentence.id)
      continue
    }
    segments.push({ id: sentence.id, path, durationMs: sentence.durationMs, audio: sentence.audio })
    reusedIds.push(sentence.id)
  }
  if (requireAll && missing.length > 0) {
    throw new Error(`no picture for ${missing.map(id => `"${id}"`).join(', ')}; render ${missing.length === 1 ? 'that sentence' : 'those sentences'} first`)
  }
  return { segments, fresh: freshIds, reused: reusedIds, pending: missing }
}

export interface AssembleOptions {
  paths: TeachPaths
  /** Every sentence's segment, in timeline order (see {@link planSegments}). */
  segments: readonly SegmentRef[]
  video: { width: number; height: number; fps: number }
  /** Absolute path of the finished mp4. */
  output: string
  /**
   * The SRT text to burn into the picture, or null to assemble without any
   * burned-in lines.
   *
   * The caller decides, not this function: whether the picture can carry
   * subtitles at all depends on the ffmpeg build (libass), which the dependency
   * probe answers before assembly. Passing null is a decision the tool states in
   * its result — it is never an accident of a filter that happened to be missing.
   */
  subtitles?: { srt: string, style?: SubtitleStyle } | null
  tools?: MediaTools
  signal?: AbortSignal
}

export interface Assembled {
  /** Absolute path of the finished mp4. */
  path: string
  /** Measured duration of the finished file. */
  durationMs: number | null
}

/**
 * Glue the segments and the narration together.
 *
 * The picture is concatenated as a copy (every segment was already encoded to
 * the same geometry and rate), the audio is concatenated as WAV, and the two
 * meet in one final mux. Hard cuts only: a transition between sentences would
 * have to be paid for in timing, and the audio is the clock.
 */
export async function assembleVideo(options: AssembleOptions): Promise<Assembled> {
  const silent = join(options.paths.root, options.paths.work, 'picture.mp4')
  const narration = join(options.paths.root, options.paths.work, 'narration.wav')
  await mkdir(dirname(silent), { recursive: true })
  await concatSegments(options.segments.map(segment => segment.path), silent, options.tools ?? {}, options.signal)
  const audioFiles = options.segments.map(segment => join(options.paths.root, segment.audio ?? audioRelativeFor(options.paths, segment.id)))
  await concatAudio(audioFiles, narration, options.tools ?? {}, options.signal)
  // The SRT is written next to the intermediate picture, not next to the
  // finished mp4: at this point the mp4 is still a staging file in the renders
  // folder, and `video_teach_export` owns the published `.srt`. Both are built by
  // `buildSrt` from the same timings, so the two never disagree by a cue.
  let burn: { file: string, forceStyle: string } | undefined
  if (options.subtitles !== undefined && options.subtitles !== null) {
    const srtFile = join(options.paths.root, options.paths.work, 'burn.srt')
    await writeFile(srtFile, options.subtitles.srt, 'utf8')
    burn = { file: srtFile, forceStyle: forceStyle(options.subtitles.style ?? DEFAULT_SUBTITLE_STYLE) }
  }
  await muxNarration({ video: silent, audio: narration, output: options.output, ...(burn === undefined ? {} : { subtitles: burn }) }, options.tools ?? {}, options.signal)
  const media = await probe(options.output, options.tools ?? {}, options.signal)
  return { path: options.output, durationMs: media.durationMs }
}

/** `audio/<id>.mp3`, the convention `narrateSentences` writes. */
function audioRelativeFor(paths: TeachPaths, id: string): string {
  return `${paths.audio}/${id}.mp3`
}

/** Read `timings.json` from a project root; throws {@link StoryboardError} on a bad file. */
export async function readTimings(paths: TeachPaths): Promise<Timings> {
  const text = await readFile(join(paths.root, paths.timings), 'utf8')
  return parseTimings(text)
}

/** Re-encode a segment to the project's geometry when a source file has the wrong rate or size. */
export async function normalizeSegment(
  input: string,
  output: string,
  durationMs: number,
  video: { width: number, height: number, fps: number },
  tools: MediaTools = {},
  signal?: AbortSignal,
): Promise<void> {
  await encodeCfrSegment({ input, output, durationMs, width: video.width, height: video.height, fps: video.fps }, tools, signal)
}
