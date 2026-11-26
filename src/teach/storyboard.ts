/**
 * The teaching-video manuscript: `storyboard.yaml` and `timings.json`
 * (docs/TEACH-VIDEO.md §5, DESIGN §23).
 *
 * Two documents, one contract. The storyboard is the only thing a person
 * writes: segments, sentences, and where the picture should move. The timings
 * file is what the voice step produces from it — per-sentence audio plus
 * word-level timestamps — and it is the authority for every later step: the
 * recorder advances on those offsets, and the segment length comes from the
 * audio's real duration.
 *
 * Everything here is pure: text in, validated value or a `StoryboardError`
 * naming the YAML path (and the line, when the document came from text) out.
 * The pipeline calls these before it spends a character on TTS or a second on
 * rendering, because both are the expensive half of the loop.
 */

import { cueEndPage, cueOpening } from './beats.ts'
import { parseDocument, YAMLParseError, type Document } from 'yaml'
import { ConfigError } from '../settings.ts'
import { supportsWordTimings } from './voice.ts'

/** Engine that draws one segment. `slides`: a reveal.js deck. `manim`: a Python scene. */
export type SegmentEngine = 'slides' | 'manim'

export const SEGMENT_ENGINES: readonly SegmentEngine[] = ['slides', 'manim']

/**
 * The voice a manuscript uses when it says nothing.
 *
 * DeepSeek is the default because the user's blind listening test on the same
 * script preferred it: sentences were indistinguishable as one speaker, the
 * un-padded joins still sounded natural, and its slower pace suits explanation.
 * The cost is stated where it bites: DeepSeek reports **no word timings**, so the
 * picture can only change between sentences, never on a word
 * (TEACH-VIDEO.md §15, §22). Volcengine stays available for the one thing only
 * it can do — cue-driven fragments on a spoken word.
 */
export const DEFAULT_VOICE_PROVIDER = 'deepseek'

/** Each provider's own default voice, used when `meta.voice.speaker` is absent. */
export const DEFAULT_VOICE_SPEAKER: Readonly<Record<string, string>> = {
  deepseek: 'stella',
}

/** The voice used when the manuscript omits `meta.voice` entirely. */
export const DEFAULT_VOICE: VoiceSpec = { provider: DEFAULT_VOICE_PROVIDER, speaker: DEFAULT_VOICE_SPEAKER[DEFAULT_VOICE_PROVIDER]!, speedRatio: null }

/** A voice setting, resolved from the storyboard and overridable by the manifest. */
export interface VoiceSpec {
  /** Provider id inside the plugin: `deepseek` (default) or `volcengine`. */
  provider: string
  /** Provider-side voice id; DeepSeek has `stella` / `tide`, volcengine its `*_bigtts` ids. */
  speaker: string
  /**
   * Speaking rate multiplier the provider applies. Null leaves the provider's
   * own default alone rather than assuming 1.0 means the same thing everywhere.
   */
  speedRatio: number | null
}

/** Output geometry. Defaults match the delivery spec in TEACH-VIDEO.md §2. */
export interface VideoSpec {
  width: number
  height: number
  fps: number
}

export const DEFAULT_VIDEO: VideoSpec = { width: 1920, height: 1080, fps: 30 }

/**
 * One picture instruction. `fragment` is a reveal.js fragment index; `atWord`
 * names the word in `say` that the fragment is revealed on, so a cue travels
 * with the script instead of with a millisecond that nobody can maintain.
 * Omitting `atWord` means "at the start of the sentence".
 */
export interface Cue {
  fragment: number
  /** The word this fragment fires on. Needs a provider that reports word timings. */
  atWord: string | null
  /**
   * Share of the sentence's audio (0–1) this fragment fires at.
   *
   * The cue timing that works without word timings: a provider that returns audio
   * only (DeepSeek) cannot say when a word is spoken, but the sentence's measured
   * length is known, so an author can place beats by meaning — "the third term
   * appears about a third of the way through". It does not align to syllables,
   * and nothing here claims it does (TEACH-VIDEO.md §21).
   */
  atProgress: number | null
}

/**
 * The tail transition between two sentences (docs/TEACH-MOTION.md §6).
 *
 * The manuscript declares **whether and how long**, never **what**: the shape of a
 * transition (fade / slide / zoom / Auto-Animate) is visual language and belongs
 * to the deck, next to the dim strength and the type scale. Two sources for one
 * decision is how a project ends up with five fade lengths.
 *
 * The transition is recorded at the **end of the earlier sentence**, so the next
 * sentence still starts on a settled page (a transition at the head of a sentence
 * would violate "the first frame is the complete picture", TEACH-VIDEO.md §3).
 */
export interface TransitionSpec {
  /**
   * `deck`: every seam between two pages of the same deck carries a transition.
   * `none`: hard cuts everywhere (the default when `meta.transition` is absent).
   */
  mode: 'deck' | 'none'
  /** How long to record after the sentence's body, in ms. Required with `mode: deck`. */
  durationMs: number
}

/** What a sentence's `transition` key may say. */
export type SentenceTransition = 'none'

/** One spoken line. The sentence is the unit of recording, so it is also the unit of retry. */
export interface Sentence {
  id: string
  /** Exactly what the voice says. Trimmed, and never empty. */
  say: string
  cues: Cue[]
  /**
   * Which deck page this sentence is recorded on (0-based), or null for "its own
   * page" — the sentence's index inside the segment, which is the only page
   * mapping a manuscript without `page` has (docs/TEACH-VIDEO.md §25).
   *
   * Two sentences naming the same page share it: the deck shows one page while
   * several sentences are recorded, so the picture evolves instead of turning.
   */
  page: number | null
  /**
   * How many beats of that page are already lit when the recording starts, or
   * null for "whatever the previous sentence on this page left lit" (0 when this
   * sentence opens the page).
   *
   * Each sentence is a separate page load, so the deck's DOM is empty at t=0 and
   * the enter state has to be replayed by the recorder before the capture starts
   * (src/teach/slides.ts). Writing `enter` out is optional: the derived value is
   * equivalent, and writing it only makes the manuscript readable without
   * simulating it. Writing a value *larger* than the derived one is a deliberate
   * cut at t=0; a smaller one is refused, because a beat would disappear
   * (src/teach/rules.ts `pageFindings`).
   */
  enter: number | null
  /**
   * `none` turns this one sentence's tail back into a hard cut, overriding
   * `meta.transition.mode: deck`.
   *
   * The one legitimate use is a seam that must not be softened — a punchline, or a
   * section boundary inside one deck. There is deliberately no way to pick a
   * *different* transition per sentence: that is the deck's business.
   */
  transition: SentenceTransition | null
}

export interface Segment {
  id: string
  engine: SegmentEngine
  /** reveal.js entry file, workspace-relative; only for `slides`. Defaults to `slides/<id>/index.html`. */
  deck: string | null
  /** Python scene file, workspace-relative; only for `manim`, and required there. */
  scene: string | null
  sentences: Sentence[]
}

export interface Storyboard {
  title: string
  voice: VoiceSpec | null
  video: VideoSpec
  /**
   * The cover page: an HTML file, relative to the project root, that
   * `video_teach_export` screenshots at 16:9 and 4:3.
   *
   * A cover is *authored*, not sampled: a frame of the finished picture is
   * usually mid-sentence and mid-animation, and a thumbnail has to read at
   * 300 px wide. Null means the manuscript declares none, and export says so
   * instead of quietly shipping the film's first frame under a "cover" name.
   */
  cover: string | null
  /** How sentences join (docs/TEACH-MOTION.md §6); null means hard cuts only. */
  transition: TransitionSpec | null
  segments: Segment[]
}

/** One word as the voice returned it: text plus its span inside the sentence audio, in ms. */
export interface TimedWord {
  t: string
  b: number
  e: number
}

/** One sentence after narration: where the audio is, how long it really is, and when each word starts. */
export interface TimedSentence {
  id: string
  text: string
  /**
   * Workspace-relative path of this sentence's own audio file. Absent when the
   * narration is one master track: the sentence then occupies
   * `[beginMs, beginMs + durationMs)` of `Timings.narration` instead of owning a
   * file (2026-11-26, the continuous contract).
   */
  audio?: string
  /**
   * Where this sentence starts inside the master narration, in ms.
   *
   * Only present in the single-track contract. `words` and every cue offset stay
   * relative to the sentence, so all the timing code is unchanged; this number is
   * what turns them absolute when the master track is the clock.
   */
  beginMs?: number
  /** The audio's own duration, from the file — not the last word's end (TEACH-VIDEO.md §10.2). */
  durationMs: number
  /**
   * Milliseconds of tail transition recorded after this sentence's body
   * (docs/TEACH-MOTION.md §6.4), 0 for a hard cut.
   *
   * This is the **picture's** extra length, and the one field the timeline ledger
   * must never omit: the video segment is `durationMs + exitMs` long, the next
   * sentence starts that much later in the picture *and* in the SRT, and the
   * narration keeps only `durationMs` of audio (the transition plays over silence).
   * `narrate` seeds it from the manuscript and `render` writes back what it
   * actually recorded; every other reader only adds.
   */
  exitMs: number
  words: TimedWord[]
}

export interface Timings {
  /**
   * Provenance the voice step writes for a human reading the file: the sample rate the
   * audio was produced at, and whether adjacent sentences were merged into one request.
   * Carried so a rewrite (the render's `exitMs` ledger) does not silently drop them.
   */
  sampleRate?: number
  merge?: string
  /**
   * Workspace-relative path of the one audio track that carries the whole
   * narration, or absent for the per-sentence contract (DeepSeek's, and every
   * project narrated before 2026-11-26).
   *
   * Written by `narrate` when the voice reports word timings: one request for the
   * whole text keeps the prosody continuous, and not cutting the result into
   * per-sentence files removes the step that produced two silent audio defects
   * (docs/TEACH-VIDEO.md §28.4–§28.5). A master track also means the picture must
   * cover it exactly, so `exitMs` is always 0 in this contract.
   */
  narration?: string
  /** Which voice produced these files; a re-narration with another voice invalidates every offset. */
  voice: Pick<VoiceSpec, 'provider' | 'speaker'> & {
    speedRatio: number | null
    /**
     * Whether this narration carries word timings. Default `word`. `none` is a
     * provider that returns audio only (DeepSeek TTS): the file is still the
     * clock for the sentence, but a cue names a word and would be a guess, so the
     * renderer refuses cues instead of inventing their moments.
     */
    timestamps?: 'word' | 'none'
  }
  sentences: TimedSentence[]
}

/** A storyboard or timings document the plugin will not act on. */
export class StoryboardError extends ConfigError {
  /** 1-based line in the source text, when the caller passed text. */
  readonly line: number | null

  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `line ${line}: ${message}`)
    this.name = 'StoryboardError'
    this.line = line
  }
}

/** A sentence longer than this is almost certainly a paragraph pasted into one line. */
export const MAX_SAY_CHARS = 300

/**
 * The bounds of a tail transition's recorded length, in ms
 * (docs/TEACH-MOTION.md §7 rule 1).
 */
export const MIN_EXIT_MS = 100
export const MAX_EXIT_MS = 1200

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Line of the node at `path`, or null when the document did not come from text. */
function lineOf(doc: Document | null, text: string, path: readonly (string | number)[]): number | null {
  if (doc === null) return null
  const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined
  const start = node?.range?.[0]
  if (typeof start !== 'number') return null
  return text.slice(0, start).split('\n').length
}

function at(doc: Document | null, text: string, path: readonly (string | number)[]) {
  const line = lineOf(doc, text, path)
  const where = path.filter(part => typeof part === 'string').join('.')
  return {
    line,
    fail(message: string): never {
      throw new StoryboardError(where === '' ? message : `${where}: ${message}`, line)
    },
  }
}

/** A mapping, or a failure naming the path. Arrays and scalars are refused. */
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoryboardError(`${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

/** Inside a section an unknown key is a typo, and a typo silently ignored is a sentence nobody records. */
function knownKeys(section: Record<string, unknown>, where: string, known: readonly string[], line: number | null): void {
  const unknown = Object.keys(section).filter(key => !known.includes(key))
  if (unknown.length === 0) return
  throw new StoryboardError(
    `${where} has unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map(key => `"${key}"`).join(', ')}; known keys are ${known.join(', ')}`,
    line,
  )
}

function requiredString(value: unknown, fail: (message: string) => never, what = 'must be text'): string {
  if (typeof value !== 'string') fail(what)
  const trimmed = (value as string).trim()
  if (trimmed === '') fail('must not be empty')
  return trimmed
}

function optionalString(value: unknown, fail: (message: string) => never): string | null {
  if (value === undefined || value === null) return null
  return requiredString(value, fail)
}

/** A workspace-relative POSIX path. The storyboard describes the project, so it may not leave it. */
function projectPath(value: unknown, fail: (message: string) => never): string {
  const text = requiredString(value, fail, 'must be a workspace-relative path')
  const normalized = text.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('~')) {
    fail(`must be relative to the workspace, got "${text}"`)
  }
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..')) fail(`must stay inside the workspace, got "${text}"`)
  if (segments.length === 0) fail(`must name a file inside the workspace, got "${text}"`)
  return segments.join('/')
}

function positiveInt(value: unknown, fail: (message: string) => never, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(`${what} must be a positive whole number`)
  return value as number
}

/** A page number or a beat count: zero is meaningful for both, so the floor is 0 rather than 1. */
function nonNegativeInt(value: unknown, fail: (message: string) => never, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${what} must be a whole number of 0 or more`)
  return value as number
}

function parseVoice(value: unknown, doc: Document | null, text: string, path: readonly (string | number)[]): VoiceSpec | null {
  const probe = at(doc, text, path)
  if (value === undefined || value === null) return null
  const raw = record(value, 'voice')
  knownKeys(raw, 'voice', ['provider', 'speaker', 'speed_ratio', 'speedRatio'], probe.line)
  const provider = optionalString(raw.provider, probe.fail) ?? DEFAULT_VOICE_PROVIDER
  // A provider with one or two voices can answer for itself; volcengine's ids are
  // namespace-heavy (`zh_female_…_bigtts`), so naming one stays the author's job.
  const defaultSpeaker = DEFAULT_VOICE_SPEAKER[provider]
  const speaker = raw.speaker === undefined || raw.speaker === null
    ? (defaultSpeaker ?? requiredString(raw.speaker, probe.fail, `must name the ${provider} voice id (this provider has no default)`))
    : requiredString(raw.speaker, probe.fail, 'must not be empty')
  const speedRaw = raw.speed_ratio ?? raw.speedRatio
  let speedRatio: number | null = null
  if (speedRaw !== undefined && speedRaw !== null) {
    // The speech endpoint takes an integer rate (`speech_rate` is int32; 1.2 is
    // rejected with a Go unmarshal error), so the manuscript refuses a fractional
    // one here, where the message can name the line.
    if (typeof speedRaw !== 'number' || !Number.isFinite(speedRaw) || !Number.isInteger(speedRaw)) {
      probe.fail('must be a whole number (speed_ratio is sent as speech_rate, an int32; 1 is the default)')
    }
    if (speedRaw === 0) probe.fail('must not be 0; leave the key out for the default rate of 1')
    speedRatio = speedRaw as number
  }
  return { provider, speaker, speedRatio }
}

function parseVideo(value: unknown, doc: Document | null, text: string, path: readonly (string | number)[]): VideoSpec {
  const probe = at(doc, text, path)
  if (value === undefined || value === null) return { ...DEFAULT_VIDEO }
  const raw = record(value, 'video')
  knownKeys(raw, 'video', ['size', 'fps'], probe.line)
  const spec = { ...DEFAULT_VIDEO }
  const size: unknown = raw.size
  if (size !== undefined && size !== null) {
    if (!Array.isArray(size) || size.length !== 2) probe.fail('must be [width, height]')
    const pair = size as unknown[]
    spec.width = positiveInt(pair[0], probe.fail, 'size[0]')
    spec.height = positiveInt(pair[1], probe.fail, 'size[1]')
    if (spec.width % 2 !== 0 || spec.height % 2 !== 0) probe.fail('width and height must be even (yuv420p needs it)')
  }
  if (raw.fps !== undefined && raw.fps !== null) {
    spec.fps = positiveInt(raw.fps, probe.fail, 'fps')
    if (spec.fps < 1 || spec.fps > 120) probe.fail('fps must be between 1 and 120')
  }
  return spec
}

function parseCues(value: unknown, say: string, provider: string, doc: Document | null, text: string, path: readonly (string | number)[]): Cue[] {
  const probe = at(doc, text, path)
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) probe.fail('must be a list of { fragment, at_word } entries')
  const entries = value as unknown[]
  const cues: Cue[] = []
  entries.forEach((entry, index) => {
    const here = at(doc, text, [...path, index])
    const raw = record(entry, `cues[${index}]`)
    knownKeys(raw, `cues[${index}]`, ['fragment', 'at_word', 'atWord', 'at_progress', 'atProgress'], here.line)
    const fragment = positiveInt(raw.fragment, here.fail, 'fragment')
    if (fragment < 1) here.fail('fragment must be 1 or greater')
    const atWord = optionalString(raw.at_word ?? raw.atWord, here.fail)
    if (atWord !== null && !supportsWordTimings(provider)) {
      // The moment is unknowable here, and a cue is a claim about a moment.
      here.fail(`at_word needs a provider that reports word timings, but meta.voice.provider is "${provider}"; use at_progress (0–1, a share of the sentence's audio) instead, or narrate with volcengine`)
    }
    // A cue that names a word the sentence does not contain is a picture that never moves.
    if (atWord !== null && !say.includes(atWord)) {
      here.fail(`at_word "${atWord}" does not appear in the sentence`)
    }
    const progressRaw = raw.at_progress ?? raw.atProgress
    let atProgress: number | null = null
    if (progressRaw !== undefined && progressRaw !== null) {
      if (typeof progressRaw !== 'number' || !Number.isFinite(progressRaw) || progressRaw < 0 || progressRaw > 1) {
        here.fail('at_progress must be a number between 0 and 1 (a share of the sentence audio)')
      }
      atProgress = progressRaw as number
    }
    if (atWord !== null && atProgress !== null) here.fail('a cue takes at_word or at_progress, not both')
    if (cues.length > 0 && fragment <= cues[cues.length - 1]!.fragment) {
      here.fail(`fragment ${fragment} must be greater than the previous cue's ${cues[cues.length - 1]!.fragment}`)
    }
    cues.push({ fragment, atWord, atProgress })
  })
  return cues
}

/**
 * Parse `meta.transition` (docs/TEACH-MOTION.md §6.6).
 *
 * The duration is refused outside 100–1200 ms rather than clamped: below 100 ms a
 * page switch is over before the recorder can see it (reveal's own `fade` is 500 ms),
 * and above 1200 ms the seam is longer than most sentences and stops reading as a
 * transition and starts reading as a gap. A refusal has a line number; a clamp would
 * leave the author believing the number they wrote.
 */
function parseTransition(value: unknown, doc: Document | null, text: string, path: readonly (string | number)[]): TransitionSpec | null {
  if (value === undefined || value === null) return null
  const here = at(doc, text, path)
  const raw = record(value, 'meta.transition')
  knownKeys(raw, 'meta.transition', ['mode', 'durationMs'], here.line)
  const mode = requiredString(raw.mode, here.fail, 'meta.transition.mode must be "deck" or "none"')
  if (mode !== 'deck' && mode !== 'none') {
    here.fail(`meta.transition.mode must be "deck" or "none", got "${mode}"`)
  }
  if (mode === 'none') {
    if (raw.durationMs !== undefined && raw.durationMs !== null) {
      here.fail('meta.transition.mode is "none", so durationMs means nothing: drop it, or set mode: deck with the duration the deck\'s own transition needs')
    }
    return { mode: 'none', durationMs: 0 }
  }
  const durationMs = positiveInt(raw.durationMs, here.fail, 'meta.transition.durationMs')
  if (durationMs < MIN_EXIT_MS || durationMs > MAX_EXIT_MS) {
    here.fail(`meta.transition.durationMs is ${durationMs}; it must be ${MIN_EXIT_MS}–${MAX_EXIT_MS} ms (a page switch shorter than ${MIN_EXIT_MS} ms is over before it can be recorded, and one longer than ${MAX_EXIT_MS} ms reads as a gap rather than a transition)`)
  }
  return { mode: 'deck', durationMs }
}


export function parseStoryboard(text: string): Storyboard {
  let doc: Document | null = null
  let raw: unknown
  try {
    doc = parseDocument(text)
    if (doc.errors.length > 0) throw doc.errors[0]
    raw = doc.toJS({ maxAliasCount: 20 })
  } catch (error: unknown) {
    const line = error instanceof YAMLParseError ? (error.linePos?.[0]?.line ?? null) : null
    const detail = error instanceof YAMLParseError ? error.message.split('\n', 1)[0] : String(error)
    throw new StoryboardError(`storyboard is not valid YAML (${detail})`, line)
  }
  if (raw === null || raw === undefined) throw new StoryboardError('storyboard is empty')
  const root = record(raw, 'the document')
  knownKeys(root, 'the document', ['meta', 'segments'], null)

  const metaProbe = at(doc, text, ['meta'])
  const meta = record(root.meta ?? {}, 'meta')
  knownKeys(meta, 'meta', ['title', 'voice', 'video', 'cover', 'transition'], metaProbe.line)
  const title = requiredString(meta.title, metaProbe.fail, 'title is required')
  const voice = parseVoice(meta.voice, doc, text, ['meta', 'voice'])
  const video = parseVideo(meta.video, doc, text, ['meta', 'video'])
  const coverProbe = at(doc, text, ['meta', 'cover'])
  const cover = meta.cover === undefined || meta.cover === null
    ? null
    : projectPath(meta.cover, (message: string) => coverProbe.fail(`meta.cover ${message}`))
  const transition = parseTransition(meta.transition, doc, text, ['meta', 'transition'])

  // The cue syntax depends on the voice: `at_word` is only meaningful when the
  // provider reports word timings, so the parser needs the provider before it
  // reads a single cue.
  const voiceProvider = voice?.provider ?? DEFAULT_VOICE_PROVIDER

  const segmentsProbe = at(doc, text, ['segments'])
  if (!Array.isArray(root.segments) || root.segments.length === 0) {
    segmentsProbe.fail('segments must be a non-empty list')
  }
  const segments: Segment[] = []
  const segmentIds = new Set<string>()
  const sentenceIds = new Set<string>()
  ;(root.segments as unknown[]).forEach((entry, index) => {
    const here = at(doc, text, ['segments', index])
    const raw = record(entry, `segments[${index}]`)
    knownKeys(raw, `segments[${index}]`, ['id', 'engine', 'deck', 'scene', 'sentences'], here.line)
    const id = requiredString(raw.id, here.fail)
    if (!SLUG.test(id)) here.fail(`id "${id}" must be letters, digits, "-", "_" or "."`)
    if (segmentIds.has(id)) here.fail(`id "${id}" is used by an earlier segment`)
    segmentIds.add(id)

    const engine = requiredString(raw.engine, here.fail) as SegmentEngine
    if (!SEGMENT_ENGINES.includes(engine)) here.fail(`engine must be one of ${SEGMENT_ENGINES.join(', ')}`)

    let deck: string | null = null
    let scene: string | null = null
    if (engine === 'slides') {
      deck = raw.deck === undefined || raw.deck === null
        ? `slides/${id}/index.html`
        : projectPath(raw.deck, here.fail)
      if (raw.scene !== undefined && raw.scene !== null) here.fail('scene is for engine "manim"; a slides segment uses deck')
    } else {
      if (raw.deck !== undefined && raw.deck !== null) here.fail('deck is for engine "slides"; a manim segment uses scene')
      if (raw.scene === undefined || raw.scene === null) here.fail('engine "manim" needs scene: the Python file to render')
      scene = projectPath(raw.scene, here.fail)
    }

    if (!Array.isArray(raw.sentences) || raw.sentences.length === 0) here.fail('sentences must be a non-empty list')
    const sentences: Sentence[] = []
    ;(raw.sentences as unknown[]).forEach((sentenceEntry, sentenceIndex) => {
      const there = at(doc, text, ['segments', index, 'sentences', sentenceIndex])
      const sentence = record(sentenceEntry, `sentences[${sentenceIndex}]`)
      knownKeys(sentence, `segments[${index}].sentences[${sentenceIndex}]`, ['id', 'say', 'cues', 'page', 'enter', 'transition'], there.line)
      const sentenceId = requiredString(sentence.id, there.fail)
      if (!SLUG.test(sentenceId)) there.fail(`id "${sentenceId}" must be letters, digits, "-", "_" or "."`)
      // Sentence ids are the join key with timings.json and with the audio files, so they are unique document-wide.
      if (sentenceIds.has(sentenceId)) there.fail(`sentence id "${sentenceId}" is used twice`)
      sentenceIds.add(sentenceId)
      const say = requiredString(sentence.say, there.fail, 'say is required')
      if (say.length > MAX_SAY_CHARS) there.fail(`say is ${say.length} characters; keep one sentence under ${MAX_SAY_CHARS}`)
      const cues = parseCues(sentence.cues, say, voiceProvider, doc, text, ['segments', index, 'sentences', sentenceIndex, 'cues'])
      // `page` and `enter` are about which deck page a sentence is recorded on and
      // how it looks at t=0. Both are declared here and judged as a set by
      // `auditManuscript` (the rules need the neighbouring sentences); this parses
      // the shape only, the way it does for every other key (docs/TEACH-VIDEO.md §25).
      const page = sentence.page === undefined || sentence.page === null ? null : nonNegativeInt(sentence.page, there.fail, 'page')
      const enter = sentence.enter === undefined || sentence.enter === null ? null : nonNegativeInt(sentence.enter, there.fail, 'enter')
      if (enter !== null && page === null) {
        there.fail('enter needs page on the same sentence: use page to say which page this sentence is on, or drop enter and let the previous sentence on its page decide what is already lit')
      }
      // Only `none` is allowed: the shape of a transition belongs to the deck, and a
      // per-sentence *shape* would let one manuscript carry five different fades.
      const transitionRaw = sentence.transition
      let sentenceTransition: SentenceTransition | null = null
      if (transitionRaw !== undefined && transitionRaw !== null) {
        if (transitionRaw !== 'none') {
          there.fail(`transition takes only "none" (it turns this sentence's tail transition back into a hard cut); the transition's shape and default duration come from meta.transition and the deck, got ${JSON.stringify(transitionRaw)}`)
        }
        sentenceTransition = 'none'
      }
      sentences.push({ id: sentenceId, say, cues, page, enter, transition: sentenceTransition })
    })
    segments.push({ id, engine, deck, scene, sentences })
  })

  return { title, voice, video, cover, transition, segments }
}

/** Every sentence in document order, which is the order the timeline concatenates them in. */
export function allSentences(storyboard: Storyboard): { segment: Segment, sentence: Sentence }[] {
  return storyboard.segments.flatMap(segment => segment.sentences.map(sentence => ({ segment, sentence })))
}

/** Where one sentence's recording sits: which page is on screen, how much of it is already lit, and how much it leaves lit. */
export interface PageSlot {
  /** 0-based deck page, from `page` or (unshared) the sentence's index inside its segment. */
  page: number
  /** Beats already lit when the capture starts, from `enter` or from the sentence before it on that page. */
  enter: number
  /** Beats lit when the sentence ends: its last beat, or `enter` when it fires none. */
  lit: number
}

/**
 * Resolve `page` / `enter` for every sentence of a segment (page mode only).
 *
 * The derivation is what makes `enter` optional without making it vague: a
 * shared page is a continuous timeline, so a sentence that does not say how it
 * enters inherits the beats the previous sentence on its page left lit — which is
 * what the viewer would have seen had the page never been reloaded. A sentence
 * that opens a page starts unlit (docs/TEACH-VIDEO.md §25.2).
 *
 * Returned per sentence, in manuscript order. Validation is not done here: the
 * rules in src/teach/rules.ts judge the whole set, and doing it twice would print
 * every finding twice.
 */
export function pageSlots(segment: Segment): PageSlot[] {
  const slots: PageSlot[] = []
  let previous: { page: number, lit: number } | null = null
  for (const [index, sentence] of segment.sentences.entries()) {
    const page = sentence.page ?? index
    const lastCue: number | null = sentence.cues.length === 0 ? null : sentence.cues[sentence.cues.length - 1]!.fragment
    const inherited: number = previous !== null && previous.page === page ? previous.lit : 0
    const enter: number = sentence.enter ?? inherited
    // What this sentence leaves lit: its last beat, or whatever `enter` put on
    // screen when it fires no beat of its own.
    const lit: number = lastCue === null ? enter : Math.max(lastCue, enter)
    slots.push({ page, enter, lit })
    previous = { page, lit }
  }
  return slots
}

/**
 * How many beats are already shown when each sentence of a segment starts (cue mode).
 *
 * Cue mode numbers beats across the whole deck, so the state a sentence opens in is
 * a property of the manuscript, not of the deck's layout: everything the sentences
 * before it have shown. A sentence with cues opens just before its first one, which
 * is what lets the recorder light the beats that came earlier instead of replaying
 * them at the first cue. A sentence with no cue of its own opens on the picture the
 * story arrived at — the page it belongs to, with the same beats lit.
 *
 * Page mode ignores this: there a page is declared and `enter` gives the state.
 */
export function cueStartFragments(segment: Segment): Map<string, number> {
  const starts = new Map<string, number>()
  let shown = 0
  for (const sentence of segment.sentences) {
    const first = sentence.cues[0]
    starts.set(sentence.id, first === undefined ? shown : Math.max(0, first.fragment - 1))
    const last = sentence.cues[sentence.cues.length - 1]
    if (last !== undefined) shown = Math.max(shown, last.fragment)
  }
  return starts
}

/** The slot for one sentence of a segment, or null when the sentence is not in it. */
export function pageSlotOf(segment: Segment, id: string): PageSlot | null {
  const index = segment.sentences.findIndex(sentence => sentence.id === id)
  if (index < 0) return null
  return pageSlots(segment)[index] ?? null
}

/** Where one sentence's tail transition lands, or why it was not recorded. */
export interface ExitSlot {
  /** The sentence whose tail carries it. */
  id: string
  /** Milliseconds recorded after this sentence's body; 0 is a hard cut. */
  exitMs: number
  /** The next sentence's opening state: the page and beats the transition lands on. */
  target: { page: number, enter: number } | null
  /**
   * Why a declared transition is not recorded here, or null when nothing was
   * dropped. `by-sentence` is the author's own override and is not a finding;
   * every other value is something the plan says out loud (src/teach/rules.ts).
   * `cue-mode` means the deck's pages could not be counted, not that cue mode
   * refuses transitions: that refusal was lifted on 2026-11-26.
   */
  dropped: 'cue-mode' | 'continuous' | 'by-sentence' | 'segment-end' | 'same-page' | 'manim' | null
}

/**
 * Resolve the tail transition of every sentence (docs/TEACH-MOTION.md §6).
 *
 * The transition belongs to the **tail of the earlier sentence**: it is recorded
 * after that sentence's body, with the deck switched to the next page, so the body
 * still starts on a complete picture and the finished layout still gets its hold.
 * Recording it at the head of the next sentence would put the transition in the
 * first frames of the sentence that is being spoken, which is the one thing the
 * page-mode recorder exists to avoid.
 *
 * A transition is only possible when the next picture is in **the same document**:
 * same segment (so the same deck), same engine, and a *different* page. Everything
 * else is a hard cut, and the reason is returned rather than swallowed — a
 * manuscript that asked for a transition and got a cut must not look like one that
 * got what it asked for.
 *
 * `mode` is the drive mode `timings.json` ended up with, not the provider's
 * intention. The two modes know the next picture differently:
 *
 * - **page mode** reads it off the manuscript (`pageSlots`): one page per sentence,
 *   or the page a shared one names.
 * - **cue mode** derives it from the cues plus the deck's fragments per page, which
 *   is why `pageFragments` is required there. Without it the slot is dropped as
 *   `cue-mode` rather than guessed — a wrong target records a transition onto a
 *   picture the next sentence never opens on, which is worse than a cut.
 */
export function exitSlots(
  board: Storyboard,
  mode: 'page' | 'cue',
  pageFragments: ReadonlyMap<string, readonly number[]> = new Map(),
): Map<string, ExitSlot> {
  const slots = new Map<string, ExitSlot>()
  const spec = board.transition
  const declared = spec !== null && spec.mode === 'deck'
  for (const segment of board.segments) {
    const pages = pageSlots(segment)
    const starts = cueStartFragments(segment)
    const counted = pageFragments.get(segment.id)
    segment.sentences.forEach((sentence, index) => {
      const next = segment.sentences[index + 1]
      const own = pages[index]!
      const nextSlot = next === undefined ? null : pages[index + 1]!
      const slot: ExitSlot = { id: sentence.id, exitMs: 0, target: null, dropped: null }
      if (!declared) {
        slots.set(sentence.id, slot)
        return
      }
      if (segment.engine !== 'slides') slot.dropped = 'manim'
      else if (sentence.transition === 'none') slot.dropped = 'by-sentence'
      else if (nextSlot === null || next === undefined) slot.dropped = 'segment-end'
      else if (mode === 'page') {
        if (nextSlot.page === own.page) slot.dropped = 'same-page'
        else {
          slot.exitMs = spec!.durationMs
          slot.target = { page: nextSlot.page, enter: nextSlot.enter }
        }
      } else {
        const target = counted === undefined ? null : cueOpening(counted, next.cues, starts.get(next.id) ?? 0)
        const end = counted === undefined ? null : cueEndPage(counted, sentence.cues, starts.get(sentence.id) ?? 0)
        if (target === null || end === null) slot.dropped = 'cue-mode'
        else if (target.page === end.page) slot.dropped = 'same-page'
        else {
          slot.exitMs = spec!.durationMs
          slot.target = { page: target.page, enter: target.step }
        }
      }
      slots.set(sentence.id, slot)
    })
  }
  return slots
}

/** How many deck pages a segment's manuscript actually uses, for the plan and the deck check. */
export function pagesUsed(segment: Segment): number {
  return pageSlots(segment).reduce((highest, slot) => Math.max(highest, slot.page + 1), 0)
}

/** Parse and validate `timings.json`, the voice step's output. */
export function parseTimings(text: string): Timings {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    throw new StoryboardError(`timings.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const root = record(raw, 'timings')
  // `sampleRate` and `merge` are provenance the voice step writes for a human
  // reading the file (`narrateSentences`). They are read-only here, but they must
  // be accepted: refusing the very keys the writer emits made every narrate →
  // render round-trip fail with "timings has unknown key sampleRate"
  // (found 2026-11-20 by the page-mode acceptance run).
  knownKeys(root, 'timings', ['voice', 'sentences', 'sampleRate', 'merge', 'narration'], null)
  // The single-track contract (2026-11-26): one audio file for the whole
  // narration, and each sentence a span of it. `audio` per sentence is then a
  // contradiction, not a redundancy — two clocks for one film.
  const master = root.narration === undefined || root.narration === null
    ? null
    : projectPath(root.narration, message => { throw new StoryboardError(`timings.narration ${message}`) })

  const voiceRaw = record(root.voice ?? {}, 'voice')
  const timestamps: 'word' | 'none' = voiceRaw.timestamps === 'none' ? 'none' : 'word'
  const voice = {
    provider: requiredString(voiceRaw.provider ?? 'volcengine', message => { throw new StoryboardError(`voice.${message}`) }),
    speaker: requiredString(voiceRaw.speaker, message => { throw new StoryboardError(`voice.${message}`) }),
    speedRatio: typeof voiceRaw.speedRatio === 'number' ? voiceRaw.speedRatio : null,
    timestamps,
  }

  if (!Array.isArray(root.sentences) || root.sentences.length === 0) {
    throw new StoryboardError('timings.sentences must be a non-empty list')
  }
  const seen = new Set<string>()
  const sentences: TimedSentence[] = []
  ;(root.sentences as unknown[]).forEach((entry, index) => {
    const label = `timings.sentences[${index}]`
    const sentence = record(entry, label)
    knownKeys(sentence, label, ['id', 'text', 'audio', 'beginMs', 'durationMs', 'exitMs', 'words'], null)
    const id = requiredString(sentence.id, message => { throw new StoryboardError(`${label}.${message}`) })
    if (seen.has(id)) throw new StoryboardError(`${label}: id "${id}" appears twice`)
    seen.add(id)

    let audio: string | undefined
    let beginMs: number | undefined
    if (master === null) {
      audio = projectPath(sentence.audio, message => { throw new StoryboardError(`${label}.${message}`) })
      if (sentence.beginMs !== undefined && sentence.beginMs !== null) {
        throw new StoryboardError(`${label}.beginMs is for a single-track narration; this timings file has no narration and gives every sentence its own audio`)
      }
    } else {
      if (sentence.audio !== undefined && sentence.audio !== null) {
        throw new StoryboardError(`${label}.audio and timings.narration cannot both name audio: the master track is the one clock. Drop the per-sentence file, or drop timings.narration`)
      }
      const begin = sentence.beginMs
      if (typeof begin !== 'number' || !Number.isInteger(begin) || begin < 0) {
        throw new StoryboardError(`${label}.beginMs must be a whole number of milliseconds >= 0: where this sentence starts inside the master narration`)
      }
      beginMs = begin
    }
    const durationMs = sentence.durationMs
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new StoryboardError(`${label}.durationMs must be the audio's real duration in milliseconds`)
    }
    // The picture's extra length (docs/TEACH-MOTION.md §6.4). Absent means 0, which
    // is what every timings file written before the field existed says: a hard cut.
    const exitMs = sentence.exitMs === undefined || sentence.exitMs === null
      ? 0
      : sentence.exitMs
    if (typeof exitMs !== 'number' || !Number.isFinite(exitMs) || exitMs < 0 || !Number.isInteger(exitMs)) {
      throw new StoryboardError(`${label}.exitMs must be a whole number of milliseconds, >= 0 (the tail transition recorded after this sentence's body)`)
    }
    if (!Array.isArray(sentence.words)) throw new StoryboardError(`${label}.words must be a list`)
    let previousEnd = 0
    const words: TimedWord[] = (sentence.words as unknown[]).map((wordEntry, wordIndex) => {
      const wordLabel = `${label}.words[${wordIndex}]`
      const word = record(wordEntry, wordLabel)
      knownKeys(word, wordLabel, ['t', 'b', 'e'], null)
      const t = requiredString(word.t, message => { throw new StoryboardError(`${wordLabel}.${message}`) })
      const b = word.b
      const e = word.e
      if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) throw new StoryboardError(`${wordLabel}.b must be milliseconds, >= 0`)
      if (typeof e !== 'number' || !Number.isFinite(e) || e <= b) throw new StoryboardError(`${wordLabel}.e must be after b`)
      if (b < previousEnd - 1) throw new StoryboardError(`${wordLabel}.b starts before the previous word ends`)
      previousEnd = e
      return { t, b, e }
    })
    // Word timings are what a cue fires on. A provider that reports none is
    // allowed to say so (`voice.timestamps: 'none'`); anything else with an empty
    // word list is a narration that cannot drive the picture, which is an error.
    if (words.length === 0 && timestamps !== 'none') {
      throw new StoryboardError(`${label}.words is empty; a sentence with no word timings cannot drive the picture (a provider without timings must record voice.timestamps: none)`)
    }
    const lastEnd = words.length === 0 ? 0 : words[words.length - 1]!.e
    if (lastEnd > durationMs + 1) {
      throw new StoryboardError(`${label}.words ends at ${lastEnd} ms, past the audio's ${durationMs} ms`)
    }
    sentences.push({
      id,
      text: optionalString(sentence.text, message => { throw new StoryboardError(`${label}.${message}`) }) ?? '',
      ...(audio === undefined ? {} : { audio }),
      ...(beginMs === undefined ? {} : { beginMs }),
      durationMs,
      exitMs,
      words,
    })
  })
  // The spans have to tile the master: span 0 starts at 0 and each next span starts
  // where the previous one ended. A gap or an overlap is not a detail — the picture
  // total would stop matching the audio, and every sentence after the edit would drift
  // against the voice. Caught here rather than at assembly, where the symptom is a
  // film whose length disagrees with its own timeline (docs/TEACH-VIDEO.md §29.1).
  if (master !== null) {
    let expected = 0
    for (const sentence of sentences) {
      const begin = sentence.beginMs!
      if (Math.abs(begin - expected) > 1) {
        throw new StoryboardError(
          `timings.sentences "${sentence.id}".beginMs is ${begin} ms but the spans before it end at ${expected} ms: `
          + 'a single-track narration must tile the master with no gap and no overlap. Re-run video_teach_narrate rather than editing the offsets by hand',
        )
      }
      expected = begin + sentence.durationMs
    }
  }

  return {
    ...(typeof root.sampleRate === 'number' ? { sampleRate: root.sampleRate } : {}),
    ...(typeof root.merge === 'string' ? { merge: root.merge } : {}),
    ...(master === null ? {} : { narration: master }),
    voice,
    sentences,
  }
}

/**
 * Write a `timings.json` document: the inverse of {@link parseTimings}.
 *
 * The two live side by side on purpose. The pipeline used to build this object
 * itself while the parser kept a whitelist of keys, and the writer emitted
 * `sampleRate` and `merge` that the parser refused, so every round trip through
 * the disk failed with "timings has unknown key sampleRate" — a defect no test
 * saw, because the pipeline tests handed the in-memory object straight to render
 * without ever reading the file back (found 2026-11-20 by the page-mode
 * acceptance run). Writer and reader in one module, with a round-trip test, is
 * what keeps the next provenance key from doing the same thing.
 */
export function serializeTimings(timings: Timings, provenance: { sampleRate?: number, merge?: string } = {}): string {
  const document = {
    ...(provenance.sampleRate === undefined ? {} : { sampleRate: provenance.sampleRate }),
    ...(provenance.merge === undefined ? {} : { merge: provenance.merge }),
    ...(timings.narration === undefined ? {} : { narration: timings.narration }),
    voice: timings.voice,
    sentences: timings.sentences,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Check that the two documents describe the same sentences.
 *
 * A storyboard line with no timings is a sentence that was never recorded; a
 * timings entry with no storyboard line is a stale file from an earlier draft.
 * Either one silently tolerated produces a video that skips or repeats audio.
 */
export function reconcileTimings(storyboard: Storyboard, timings: Timings): string[] {
  const wanted = allSentences(storyboard).map(({ sentence }) => sentence.id)
  const got = new Set(timings.sentences.map(sentence => sentence.id))
  const problems: string[] = []
  for (const id of wanted) {
    if (!got.has(id)) problems.push(`sentence "${id}" has no narration in timings.json`)
  }
  for (const id of got) {
    if (!wanted.includes(id)) problems.push(`timings.json has "${id}", which the storyboard no longer contains`)
  }
  if (timings.voice.speaker !== (storyboard.voice?.speaker ?? timings.voice.speaker)) {
    problems.push(
      `timings.json was narrated with "${timings.voice.speaker}" but the storyboard asks for "${storyboard.voice?.speaker}"; re-run narration`,
    )
  }
  return problems
}

/** Total length of the narration, in milliseconds: the sum of the real audio durations. */
export function totalDurationMs(timings: Timings): number {
  return timings.sentences.reduce((sum, sentence) => sum + sentence.durationMs, 0)
}

/**
 * Total length of the **picture**, in milliseconds: every sentence plus its tail
 * transition (docs/TEACH-MOTION.md §6.4).
 *
 * The two numbers are deliberately separate. `totalDurationMs` is what the voice
 * cost and what the narration track is long; this one is how long the film is, and
 * it is the number the per-act acceptance compares against ("the act is as long as
 * its timings say"). Any consumer that means the film must use this one.
 */
export function timelineDurationMs(timings: Timings): number {
  return timings.sentences.reduce((sum, sentence) => sum + sentence.durationMs + sentence.exitMs, 0)
}

/** Where a sentence starts in the assembled film, in milliseconds (tail transitions included). */
export function sentenceStartMs(timings: Timings, id: string): number {
  let start = 0
  for (const sentence of timings.sentences) {
    if (sentence.id === id) return start
    start += sentence.durationMs + sentence.exitMs
  }
  throw new StoryboardError(`timings.json has no sentence "${id}"`)
}

/**
 * When a cue fires, in milliseconds from the start of its sentence.
 *
 * `atWord` matches the first word containing that text; the TTS tokenizer glues
 * punctuation to neighbouring words (`"来，"`), so a prefix match is the only
 * shape that survives a script edit.
 */
export function cueOffsetMs(sentence: TimedSentence, cue: Cue): number {
  if (cue.atProgress !== null) {
    // The sentence's own measured length is the clock; the share is the author's
    // reading of when the point is made. Rounded to a millisecond so two compiles
    // of one manuscript produce identical capture timings.
    return Math.round(cue.atProgress * sentence.durationMs)
  }
  const target = cue.atWord
  if (target === null) return 0
  if (sentence.words.length === 0) {
    throw new StoryboardError(`sentence "${sentence.id}" has no word timings, so a cue cannot fire; this narration came from a provider that reports none`)
  }
  const single = sentence.words.find(word => word.t.includes(target))
  if (single !== undefined) return single.b
  // The provider tokenizes Chinese per character, so a manuscript phrase like
  // "先看" is two words. Match a run of consecutive words and fire on its first.
  for (let start = 0; start < sentence.words.length; start += 1) {
    let joined = ''
    const offsets: number[] = []
    for (let end = start; end < Math.min(start + 8, sentence.words.length); end += 1) {
      offsets.push(joined.length)
      joined += sentence.words[end]!.t
      const found = joined.indexOf(target)
      if (found >= 0) {
        // The phrase can begin inside the run rather than at its first word.
        let wordIndex = 0
        for (let index = 0; index < offsets.length; index += 1) {
          if (offsets[index]! <= found) wordIndex = index
        }
        return sentence.words[start + wordIndex]!.b
      }
      if (joined.length > target.length + 8) break
    }
  }
  throw new StoryboardError(`sentence "${sentence.id}" has no word containing "${target}"; cues must name words the voice actually says`)
}
