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
import { CHARS_PER_SECOND, deckPageFragments } from './rules.ts'
import { DEFAULT_SUBTITLE_STYLE, forceStyle, type SubtitleStyle } from './subtitles.ts'
import { DEFAULT_VOICE as DEFAULT_VOICE_PRIVATE } from './storyboard.ts'
import { lateBeats, recordDeckSegment, type BeatTiming, type CueAt, type SettleCheck } from './slides.ts'
import {
  allSentences,
  cueOffsetMs,
  exitSlots,
  cueStartFragments,
  pageSlots,
  pagesUsed,
  parseTimings,
  serializeTimings,
  timelineDurationMs,
  totalDurationMs,
  type Cue,
  type Sentence,
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

/**
 * How far a reused segment may differ from the timeline before it is called stale,
 * in ms. One output frame at 30 fps: the encoder's own rounding is a frame or two,
 * a changed tail transition is hundreds.
 */
const STALE_SEGMENT_MS = 34

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
/**
 * Move one sentence's word timings onto its own audio's clock.
 *
 * A merged request's words are timed against the whole utterance — that is what
 * the service reports — while each sentence's file is a slice of it starting at
 * `segmentTiming().startMs`. Storing the raw offsets made every `at_word` cue
 * fire late by the length of everything before it, and the "words end past the
 * audio" guard in `parseTimings` rejected the file on the next render
 * (`words ends at 12715 ms, past the audio's 7464 ms`, measured 2026-11-26).
 */
export function rebaseWords(words: readonly TimedWord[], startMs: number): TimedWord[] {
  if (startMs <= 0) return [...words]
  return words.map(word => {
    const begin = Math.max(0, word.b - startMs)
    // A word that began before the slice would otherwise clamp to a zero-length
    // span; `e > b` is what the parser requires.
    return { t: word.t, b: begin, e: Math.max(begin + 1, word.e - startMs) }
  })
}

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
 * Fragments per page for every slides deck the manuscript names.
 *
 * Only cue mode needs this: a tail transition there lands on the state the next
 * sentence opens in, and that state is a beat number resolved against the deck's
 * pages. A deck that cannot be split into pages is left out, and `exitSlots` then
 * drops the transition with `cue-mode` rather than guessing a page.
 */
export async function deckPageCounts(board: Storyboard, root: string): Promise<Map<string, number[]>> {
  const counts = new Map<string, number[]>()
  for (const segment of board.segments) {
    if (segment.engine !== 'slides' || segment.deck === null) continue
    const html = await readFile(join(root, ...segment.deck.split('/')), 'utf8').catch(() => null)
    if (html === null) continue
    const pages = deckPageFragments(html)
    if (pages !== null && pages.length > 0) counts.set(segment.id, pages)
  }
  return counts
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
/**
 * Synthesise the whole narration as **one master track** and record each sentence as
 * a span of it (`beginMs` + `durationMs`), with words kept relative to the span.
 *
 * This is the continuous contract (docs/TEACH-VIDEO.md §29). Two things follow from
 * it, and both are the point:
 *
 * 1. **The audio is never cut.** A per-sentence file exists because the picture is
 *    recorded per sentence; the cut itself is a guess at where one sentence's sound
 *    ends, and both audio defects of 2026-11-26 lived in exactly that guess. With a
 *    master track the film mixes the whole thing in one go.
 * 2. **The spans partition the master**, so the picture can cover it exactly: span 0
 *    starts at 0, span i ends where span i+1 starts, and the last span runs to the
 *    end of the track. `exitMs` is therefore 0 everywhere — there is no seam for a
 *    tail transition to sit in.
 *
 * A single-track narration cannot re-record a subset: the request is the whole text,
 * so `sentences: [...]` is refused here rather than paying for a second master that
 * would move every offset.
 */
async function narrateSingleTrack(options: NarrateOptions, list: readonly Sentence[]): Promise<NarrateResult> {
  const only = options.only !== undefined && options.only.length > 0 ? options.only : undefined
  if (only !== undefined && only.length < list.length) {
    throw new Error(
      'this voice reports word timings, so narration is one master track for the whole text: `sentences` cannot re-record a subset. '
      + 'Run video_teach_narrate without `sentences`, or narrate with merge: none to get one file per sentence',
    )
  }
  const workDir = join(options.paths.root, options.paths.work)
  const audioDir = join(options.paths.root, options.paths.audio)
  await mkdir(workDir, { recursive: true })
  await mkdir(audioDir, { recursive: true })

  const groups = planUtterances(list, undefined, 'auto')
  const chunks: string[] = []
  const absolute = new Map<string, TimedWord[]>()
  let cursorMs = 0

  for (const group of groups) {
    const synthesized = await synthesizeUtterance({
      texts: group.map(index => list[index]!.say),
      speaker: options.voice.speaker,
      apiKey: options.apiKey,
      speedRatio: options.voice.speedRatio,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const chunk = join(workDir, `narrate-${list[group[0]!]!.id}.mp3`)
    await writeFile(chunk, synthesized.audio)
    const media = await probe(chunk, options.tools ?? {}, options.signal)
    if (media.durationMs === null) throw new Error(`ffprobe reported no duration for the utterance of "${list[group[0]!]!.id}"; the audio is unusable`)

    for (const [position, index] of group.entries()) {
      const words = synthesized.words
        .filter((_, wordIndex) => synthesized.groups[wordIndex] === position)
        .map(word => ({ t: word.t, b: word.b + cursorMs, e: word.e + cursorMs }))
      if (words.length === 0) {
        throw new Error(`sentence "${list[index]!.id}" came back with no words of its own from a merged request; narrate with merge: none to synthesise it alone`)
      }
      absolute.set(list[index]!.id, words)
    }
    chunks.push(chunk)
    cursorMs += media.durationMs
  }

  const relative = `${options.paths.audio}/narration.mp3`
  const master = join(options.paths.root, relative)
  if (chunks.length === 1) await copyFile(chunks[0]!, master)
  else await concatAudio(chunks, master, options.tools ?? {}, options.signal)
  const masterMedia = await probe(master, options.tools ?? {}, options.signal)
  if (masterMedia.durationMs === null) throw new Error('ffprobe reported no duration for the master narration')

  // One boundary per gap, taken from the same pause policy the per-sentence cut
  // used: keep the natural gap, pad it up to the punctuation's nominal pause when
  // the voice was terse, and never let a boundary land before the last word.
  const sentences: TimedSentence[] = []
  let boundary = 0
  for (const [index, sentence] of list.entries()) {
    const words = absolute.get(sentence.id)!
    const begin = boundary
    const lastEnd = words[words.length - 1]!.e
    let end: number
    if (index + 1 < list.length) {
      const nextFirst = absolute.get(list[index + 1]!.id)![0]!.b
      const natural = Math.max(0, nextFirst - lastEnd)
      const pause = Math.max(natural, sentenceEndPauseMs(sentence.say))
      end = Math.min(Math.max(nextFirst, lastEnd), lastEnd + pause)
    } else {
      // The last sentence owns the tail of the track: no picture is cut short by a
      // fraction of a second, and the film ends where the audio does.
      end = masterMedia.durationMs
    }
    const durationMs = Math.max(1, Math.round(end - begin))
    sentences.push({
      id: sentence.id,
      text: sentence.say,
      beginMs: Math.round(begin),
      durationMs,
      exitMs: 0,
      words: words.map(word => ({
        t: word.t,
        b: Math.max(0, Math.round(word.b - begin)),
        e: Math.max(1, Math.round(word.e - begin)),
      })),
    })
    boundary = end
    options.onSentence?.(sentence.id, index, list.length)
  }

  const timings: Timings = {
    ...(options.paths.audio === DEFAULT_TEACH_PATHS.audio ? {} : {}),
    narration: relative,
    merge: 'single',
    voice: { provider: options.voice.provider, speaker: options.voice.speaker, speedRatio: options.voice.speedRatio },
    sentences,
  }
  const timingsPath = join(options.paths.root, options.paths.timings)
  const staging = `${timingsPath}.tmp`
  await writeFile(staging, serializeTimings(timings, { sampleRate: VOICE_SAMPLE_RATE, merge: 'single' }), 'utf8')
  await rename(staging, timingsPath)
  return {
    timings,
    narrated: list.map(sentence => sentence.id),
    durationMs: sentences.reduce((sum, sentence) => sum + sentence.durationMs, 0),
    requests: groups.length,
  }
}

export async function narrateSentences(options: NarrateOptions): Promise<NarrateResult> {
  const audioDir = join(options.paths.root, options.paths.audio)
  await mkdir(audioDir, { recursive: true })
  const entries = allSentences(options.board)
  const list = entries.map(entry => entry.sentence)
  const merge: NarrationMerge = options.merge ?? 'auto'
  const only = options.only !== undefined && options.only.length > 0 ? options.only : undefined
  // The tail transition is a picture decision, not a voice one, but the timeline is
  // the one ledger everything reads afterwards (docs/TEACH-MOTION.md §6.4), so it is
  // seeded here from the manuscript: a project narrated but not yet rendered already
  // carries the right numbers, and a narrowed re-narration does not zero the
  // sentences it kept. The drive mode decides *how* the next picture is found:
  // page mode reads it off the manuscript, cue mode resolves it against the deck.
  const driveMode = supportsWordTimings(options.voice.provider) ? 'cue' as const : 'page' as const
  const picture = exitSlots(options.board, driveMode, driveMode === 'cue' ? await deckPageCounts(options.board, options.paths.root) : new Map())

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
        exitMs: picture.get(entry.sentence.id)?.exitMs ?? 0,
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

  // Two contracts behind one command (docs/TEACH-VIDEO.md §29):
  //
  // - `merge: auto` with a voice that reports word timings → **one master track**.
  //   One request for the whole text keeps the prosody continuous, and *not*
  //   cutting it into per-sentence files removes the step that produced two silent
  //   audio defects (§28.4, §28.5): a cut boundary is only as good as the word
  //   timings that produce it, and no cut is exactly right.
  // - `merge: none` → one request and one file per sentence, the isolation path.
  //   Also the only shape a provider without word timings can produce.
  if (supportsWordTimings(options.voice.provider) && merge !== 'none') {
    return narrateSingleTrack(options, list)
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
        // In cue mode the next sentence's opening page is derived from its own beats
        // and the deck's fragments per page; `exitSlots` did that work above with the
        // same numbers the recorder will see (docs/TEACH-MOTION.md §7 rule 2 was
        // lifted 2026-11-26: the landing is knowable, so the seam can turn).
        exitMs: picture.get(sentence.id)?.exitMs ?? 0,
        words: rebaseWords(words, timing.startMs),
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
  /** The sentence's own length: the audio's duration, without the tail transition. */
  durationMs: number
  /** Tail transition recorded after the body, in ms; 0 for a hard cut. */
  exitMs: number
  /** Where that transition lands (the next sentence's opening page and beats), or null. */
  exitTarget: { page: number, enter: number } | null
  /** Frames the browser capture produced; a slide with one frame is a slide that never moved. */
  frames: number | null
  /** When each beat was asked for and when it happened (slides only; empty otherwise). */
  beats: readonly BeatTiming[]
  /** Whether the segment ends on the finished layout (slides only; null for Manim). */
  settle: SettleCheck | null
  /**
   * True when a late beat was caught and the sentence was recorded again.
   *
   * A beat that lands 1.8 s late is not a manuscript mistake — it is the host
   * hesitating — so the retry runs the same request a second time rather than
   * asking the author to notice (docs/TEACH-MOTION.md §15).
   */
  retried: boolean
  /**
   * Manim only: how far the scene ran past the sentence's narration, in ms. The picture
   * is cut at the narration's end, so a positive number means the animation was still
   * going (`overrunMs`, reported by `video_teach_render`).
   */
  overrunMs?: number
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
  const driveMode = deckDriveMode(options.timings)
  // A single master track has no seams: the picture is one continuous recording per
  // segment, so a tail transition has nowhere to sit and `exitMs` is 0 by
  // construction (docs/TEACH-VIDEO.md §29). Zeroing here rather than in `exitSlots`
  // keeps the manuscript check honest: the plan still says the manuscript declared
  // transitions, and the render says it did not record any.
  const exits = options.timings.narration === undefined
    ? exitSlots(board, driveMode, driveMode === 'cue' ? await deckPageCounts(board, options.paths.root) : new Map())
    : new Map([...exitSlots(board, 'page').keys()].map(id => [id, { id, exitMs: 0, target: null, dropped: 'continuous' as const }]))

  // The continuous contract records a whole slides segment in one session, so the
  // per-sentence loop below cannot do the work: build every run first, then hand the
  // sentences their segments out of it (docs/TEACH-VIDEO.md §29.3).
  const continuous = options.timings.narration !== undefined
  const runOutputs = new Map<string, RenderedSegment>()
  const widened: string[] = []
  if (continuous) {
    const { recordDeckRun } = await import('./slides.ts')
    for (const segment of board.segments) {
      if (segment.engine !== 'slides' || segment.deck === null) continue
      const wanted = options.only === undefined
        ? segment.sentences
        : segment.sentences.filter(sentence => options.only!.includes(sentence.id))
      if (wanted.length === 0) continue
      // `sentences: [...]` narrows a re-record, not a recording session: half a run
      // would start mid-story on a fresh deck. The whole segment is re-recorded and
      // the extra ids are reported through the ordinary `fresh` list.
      const picked = wanted.length === segment.sentences.length ? wanted : segment.sentences
      if (picked !== wanted) widened.push(...segment.sentences.filter(sentence => !wanted.some(entry => entry.id === sentence.id)).map(sentence => sentence.id))
      const run = picked.map(sentence => {
        const timed = byId.get(sentence.id)
        if (timed === undefined) throw new Error(`sentence "${sentence.id}" has no narration; run narrate first`)
        return { id: sentence.id, durationMs: timed.durationMs, cues: cuesFor(timed, sentence.cues) }
      })
      const deckPath = join(options.paths.root, segment.deck)
      const workDirFor = (id: string): string => join(options.paths.root, options.paths.work, id)
      const args = {
        deckPath,
        sentences: run,
        width: board.video.width,
        height: board.video.height,
        fps: board.video.fps,
        workDirFor,
        ...(options.chromiumPath === undefined ? {} : { chromiumPath: options.chromiumPath }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }
      let recorded = await recordDeckRun(args, options.tools ?? {})
      // A late beat is the host hesitating, not a manuscript mistake — but inside a
      // run there is no clean way to redo one sentence (a fresh page sits a few
      // pixels off the frame the previous sentence left), so the whole segment is
      // recorded again. That is the price of the continuous contract.
      const late = recorded.some(segmentOut => lateBeats(segmentOut.beats).length > 0)
      const retried = late
      if (late) recorded = await recordDeckRun(args, options.tools ?? {})
      for (const [index, sentence] of picked.entries()) {
        const timedSentence = byId.get(sentence.id)!
        const out = recorded[index]!
        const stillLate = lateBeats(out.beats)
        runOutputs.set(sentence.id, {
          id: sentence.id,
          path: out.path,
          durationMs: timedSentence.durationMs,
          exitMs: 0,
          exitTarget: null,
          frames: out.frames,
          beats: out.beats,
          settle: out.settle,
          retried,
          ...(stillLate.length === 0 ? {} : { lateBeats: stillLate }),
        })
        options.onSegment?.(sentence.id, out.path)
      }
    }
  }

  for (const { segment, sentence } of allSentences(board)) {
    if (sentence.id === undefined) continue
    if (options.only !== undefined && !options.only.includes(sentence.id) && !widened.includes(sentence.id)) continue
    const timed = byId.get(sentence.id)
    if (timed === undefined) throw new Error(`sentence "${sentence.id}" has no narration; run narrate first`)
    const workDir = join(options.paths.root, options.paths.work, sentence.id)
    if (continuous && segment.engine === 'slides') {
      const out = runOutputs.get(sentence.id)
      if (out !== undefined) rendered.push(out)
      continue
    }

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
      // Manim has no beats to be late or a deck state to compare: its scene is a
      // single timeline, and running short of it is the scene's own `run_time`.
      rendered.push({
        id: sentence.id,
        path: result.path,
        durationMs: timed.durationMs,
        exitMs: 0,
        exitTarget: null,
        frames: null,
        beats: [],
        settle: null,
        retried: false,
        // The scene ran past the narration and was cut at the sentence's end. It is
        // measured by `manimSegment` and used to be dropped on the floor, while the
        // skill promised the overrun would be reported (2026-11-26 audit).
        ...(result.overrunMs > 0 ? { overrunMs: result.overrunMs } : {}),
      })
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
    const slots = mode === 'page' ? pageSlots(segment) : null
    // Cue mode: how much of the film is already on screen when this sentence starts,
    // resolved from the manuscript (docs/TEACH-VIDEO.md §27).
    const starts = mode === 'cue' ? cueStartFragments(segment) : null
    const index = segment.sentences.findIndex(entry => entry.id === sentence.id)
    const slot = slots === null ? null : slots[index] ?? null
    if (mode === 'page' && slot === null) throw new Error(`sentence "${sentence.id}" is not in segment "${segment.id}"`)
    // The tail transition (docs/TEACH-MOTION.md §6): one slot per sentence, resolved
    // from the manuscript alone so a narrowed render and a full one agree.
    const exit = exits.get(sentence.id) ?? null
    const request = {
      deckPath: join(options.paths.root, segment.deck),
      ...(slot === null ? {} : { page: slot.page, enter: slot.enter }),
      ...(starts === null ? {} : { startFragment: starts.get(sentence.id) ?? 0 }),
      ...(exit === null || exit.exitMs === 0 || exit.target === null ? {} : { exit: { ...exit.target, ms: exit.exitMs } }),
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
    } as const
    let recorded = await recordDeckSegment(request, options.tools ?? {})
    // One retry, not a loop: the late beat was a hiccup in this machine, not a
    // property of the manuscript, and a second hiccup is worth reporting rather
    // than hiding behind a third attempt.
    const retried = lateBeats(recorded.beats).length > 0
    if (retried) recorded = await recordDeckSegment(request, options.tools ?? {})
    rendered.push({
      id: sentence.id,
      path: recorded.path,
      durationMs: timed.durationMs,
      exitMs: recorded.exitMs,
      exitTarget: exit?.target ?? null,
      frames: recorded.frames,
      beats: recorded.beats,
      settle: recorded.settle,
      retried,
    })
    options.onSegment?.(sentence.id, recorded.path)
  }
  // The timeline is the one ledger the assembly, the SRT and the per-act check all
  // read (docs/TEACH-MOTION.md §6.4), and this is the only place that knows what a
  // segment actually carries. What was recorded wins over what the manuscript asked
  // for: a segment re-recorded after `meta.transition` changed moves the ledger
  // with it, and a segment that was *not* re-recorded keeps the number it was
  // recorded with, which is what makes a stale tail visible at assembly.
  if (rendered.length > 0) await writeExitLedger(options, rendered)
  return rendered
}

/**
 * Write the recorded tail transitions back into `timings.json`.
 *
 * Every other reader (assembly, `buildSrt`, the per-act collect script) adds
 * `durationMs + exitMs`; a ledger that says 0 while the segment on disk is 400 ms
 * longer shifts every sentence after it by 400 ms — audio against picture, and the
 * SRT against both. Read-modify-write with the same staging-and-rename the voice
 * step uses, so a crash cannot leave half a timeline behind.
 */
async function writeExitLedger(options: RenderOptions, rendered: readonly RenderedSegment[]): Promise<void> {
  const recorded = new Map(rendered.map(segment => [segment.id, segment.exitMs]))
  const sentences = options.timings.sentences.map(sentence => {
    const exitMs = recorded.get(sentence.id)
    return exitMs === undefined || exitMs === sentence.exitMs ? sentence : { ...sentence, exitMs }
  })
  if (sentences.every((sentence, index) => sentence === options.timings.sentences[index])) return
  const target = join(options.paths.root, options.paths.timings)
  await mkdir(dirname(target), { recursive: true })
  const staging = `${target}.tmp`
  await writeFile(staging, serializeTimings({ ...options.timings, sentences }, {
    ...(options.timings.sampleRate === undefined ? {} : { sampleRate: options.timings.sampleRate }),
    ...(options.timings.merge === undefined ? {} : { merge: options.timings.merge }),
  }), 'utf8')
  await rename(staging, target)
  options.timings.sentences = sentences
}

/**
 * What a render has to report about the beats it just recorded.
 *
 * Two failures, both invisible in a still frame and both fatal to the picture
 * (docs/TEACH-MOTION.md §15): a beat that landed after it was due, and a segment
 * that ends before its last motion does. The first is the machine hesitating, so
 * `renderSegments` already tried again; the second is the manuscript asking for
 * more time than it left, which the plan warns about when the deck declares
 * `teachTransition` and which no retry can fix.
 *
 * A check that could not run is reported too: "not checked" and "checked and
 * fine" must not look the same.
 */
export function motionFindings(rendered: readonly RenderedSegment[]): string[] {
  const findings: string[] = []
  for (const segment of rendered) {
    const late = lateBeats(segment.beats)
    if (late.length > 0) {
      const behind = late.map(beat => `beat ${beat.fragment} landed ${beat.actualMs - beat.atMs} ms after it was due`).join('; ')
      findings.push(segment.retried
        ? `sentence "${segment.id}": ${behind}, and it stayed late when recorded a second time — the machine was busy, not the manuscript. Record that sentence once more: video_teach_render sentences: ["${segment.id}"]`
        : `sentence "${segment.id}": ${behind} — the motion after it is cut. Record that sentence again: video_teach_render sentences: ["${segment.id}"]`)
    }
    if (segment.settle?.status === 'unfinished') {
      findings.push(`sentence "${segment.id}": its last frame is not the finished layout (${(segment.settle.changed * 100).toFixed(1)}% of its pixels differ from the deck driven to beat ${segment.settle.finalFragment} of that page), so the segment is cut through an animation. Move that beat earlier, or declare a shorter teachTransition`)
    } else if (segment.settle?.status === 'skipped' && segment.beats.length > 0) {
      findings.push(`sentence "${segment.id}": the finished-layout check did not run (${segment.settle.reason})`)
    }
    if (segment.overrunMs !== undefined && segment.overrunMs > 0) {
      findings.push(`sentence "${segment.id}": the scene runs ${segment.overrunMs} ms past the narration and is cut at the sentence's end. Shorten the scene's run_time, or lengthen the line`)
    }
  }
  return findings
}

/** One segment as the assembler needs it: which sentence it belongs to, and where the file is. */
export interface SegmentRef {
  id: string
  /** Absolute path of the encoded segment. */
  path: string
  /** The sentence's own length; the file is `durationMs + exitMs` long. */
  durationMs: number
  /** Tail transition the timeline says this segment carries, in ms. */
  exitMs: number
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
  /** Reused segments whose measured length disagrees with the timeline (stale tails). */
  stale: string[]
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
  tools: MediaTools = {},
): Promise<SegmentPlan> {
  const requireAll = options.requireAll ?? true
  const fresh = new Map(rendered.map(segment => [segment.id, segment]))
  const segments: SegmentRef[] = []
  const freshIds: string[] = []
  const reusedIds: string[] = []
  const missing: string[] = []
  const stale: string[] = []
  for (const sentence of timings.sentences) {
    const done = fresh.get(sentence.id)
    if (done !== undefined) {
      segments.push({ id: sentence.id, path: done.path, durationMs: sentence.durationMs, exitMs: done.exitMs, audio: sentence.audio ?? null })
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
    // A reused segment is trusted only after it is measured: the ledger says how
    // long the picture should be, and a segment recorded before the last
    // `meta.transition` change is a different length. One probe per sentence is
    // cheaper than an assembly that is 400 ms out from the second sentence on.
    const expected = sentence.durationMs + sentence.exitMs
    const measured = await probe(path, tools).then(media => media.durationMs).catch(() => null)
    if (measured !== null && Math.abs(measured - expected) > STALE_SEGMENT_MS) {
      stale.push(`sentence "${sentence.id}": the segment on disk is ${measured} ms but the timeline says ${expected} ms (${sentence.durationMs} + ${sentence.exitMs} of tail transition) — it was recorded before the manuscript changed. Re-record it: video_teach_render sentences: ["${sentence.id}"]`)
    }
    segments.push({ id: sentence.id, path, durationMs: sentence.durationMs, exitMs: sentence.exitMs, audio: sentence.audio ?? null })
    reusedIds.push(sentence.id)
  }
  if (requireAll && missing.length > 0) {
    throw new Error(`no picture for ${missing.map(id => `"${id}"`).join(', ')}; render ${missing.length === 1 ? 'that sentence' : 'those sentences'} first`)
  }
  return { segments, fresh: freshIds, reused: reusedIds, pending: missing, stale }
}

export interface AssembleOptions {
  /**
   * Workspace-relative path of the master narration, when the project uses the
   * single-track contract. Absent means the per-sentence files are concatenated
   * (DeepSeek's contract, and every project narrated before 2026-11-26).
   */
  narration?: string | null
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
  /**
   * What the timeline says the film should be: `Σ(durationMs + exitMs)`.
   *
   * The one number a stale tail transition moves, so the caller compares it with
   * `durationMs` and names the disagreement instead of shipping a film that is
   * silently 400 ms out (docs/TEACH-MOTION.md §6.4).
   */
  expectedMs: number
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
  await mkdir(dirname(silent), { recursive: true })
  await concatSegments(options.segments.map(segment => segment.path), silent, options.tools ?? {}, options.signal)
  let narration: string
  if (options.narration !== undefined && options.narration !== null) {
    // The single-track contract (docs/TEACH-VIDEO.md §29): one file carries the whole
    // narration and the spans partition it, so the picture already covers it exactly.
    // There is nothing to concatenate and no tail-transition silence to insert —
    // `exitMs` is 0 throughout, which is what "no seam" means on the audio side.
    narration = join(options.paths.root, ...options.narration.split('/'))
  } else {
    const audioFiles = options.segments.map(segment => join(options.paths.root, segment.audio ?? audioRelativeFor(options.paths, segment.id)))
    narration = join(options.paths.root, options.paths.work, 'narration.wav')
    // The silence that goes with each tail transition: the picture segment is
    // `durationMs + exitMs` long, so the track that runs underneath it must be too
    // (docs/TEACH-MOTION.md §6.3).
    await concatAudio(audioFiles, narration, options.tools ?? {}, options.signal, options.segments.map(segment => segment.exitMs))
  }
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
  const expectedMs = options.segments.reduce((sum, segment) => sum + segment.durationMs + segment.exitMs, 0)
  return { path: options.output, durationMs: media.durationMs, expectedMs }
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
