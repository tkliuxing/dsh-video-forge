/**
 * The voice step: one sentence of text in, one audio file plus word-level
 * timing out (docs/TEACH-VIDEO.md §10.2, DESIGN §23).
 *
 * Verified against the live endpoint on 2026-11-20, with the shapes pinned in
 * TEACH-VIDEO.md §10.2:
 *
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   X-Api-Key: <ARK_VOICE_API_KEY>
 *   X-Api-Resource-Id: seed-tts-2.0
 *
 * The response is NDJSON. Audio arrives as base64 in `data`; a sentence entry
 * carries `words[]` with `startTime`/`endTime` in **seconds**, but only when
 * the request asks for subtitles (`enable_subtitle: true`, a boolean — a number
 * is rejected by the service). Three quirks the service actually exhibits, all
 * observed, all handled here rather than by the caller:
 *
 * - One entry carries the *accumulated* text of everything so far with an empty
 *   `words[]`. Keeping it would shift the whole timeline, so empty entries are
 *   dropped.
 * - Punctuation is glued to neighbouring words (`"来，"`), so a word is not a
 *   character and character indices are not a clock.
 * - The audio has a tail of silence (≈0.49 s on a 6.7 s sample), so the segment
 *   length must come from the file's own duration, never from the last word.
 *
 * Nothing here reads the configuration or the filesystem: the caller passes the
 * key, and writing the audio is the pipeline's job.
 */

import { excerpt } from '../providers/adapter.ts'
import type { TimedWord } from './storyboard.ts'

/** The speech endpoint; deliberately not the Ark video host. */
export const VOICE_BASE_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/** Resource id for the 2.0 voice family. 1.0 (mars) voices need a different one. */
export const VOICE_RESOURCE_ID = 'seed-tts-2.0'

/** Sample rate the pipeline asks for; 24 kHz is what the 2.0 voices emit natively. */
export const VOICE_SAMPLE_RATE = 24_000

/** A request the plugin will not send. */
export class VoiceError extends Error {
  /** The service's own code (`45000010`, `55000000`, …), when it answered with one. */
  readonly code: number | null
  /** The service's request id, for a support ticket. */
  readonly logId: string | null

  constructor(message: string, options: { code?: number | null; logId?: string | null; cause?: unknown } = {}) {
    super(message)
    this.name = 'VoiceError'
    this.code = options.code ?? null
    this.logId = options.logId ?? null
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export interface SynthesizeOptions {
  text: string
  speaker: string
  /** Resolved credential; the caller owns where it came from (env or the credentials service). */
  apiKey: string
  /** Null keeps the provider's own default. The service takes a multiplier, not a percentage. */
  speedRatio?: number | null
  /** Overridable for a gateway running on another host; the default is the documented endpoint. */
  baseUrl?: string
  signal?: AbortSignal
}

export interface SynthesizedSentence {
  text: string
  words: TimedWord[]
}

/** What a voice provider can tell us about its own audio. */
export type TimestampCapability = 'word' | 'none'

export interface Synthesized {
  /** The audio bytes exactly as the service returned them (mp3 at {@link VOICE_SAMPLE_RATE}). */
  audio: Uint8Array
  /** Sentences with word timings, in the order the service reported them. */
  sentences: SynthesizedSentence[]
  /** Word timings flattened across sentences; what the recorder advances on. */
  words: TimedWord[]
  /** Provider usage for the settlement record, when it reported any. */
  usage: Record<string, number> | null
  /** The service's request id, when the response headers carried one. */
  logId: string | null
  /**
   * Whether the provider reported word timings. `none` means the caller must not
   * pretend it knows when a word is spoken: cues cannot fire, because a cue is a
   * claim about a moment.
   */
  timestamps: TimestampCapability
}

/** One line of the NDJSON response, as far as this module relies on it. */
export interface VoiceLine {
  code?: number
  message?: string
  data?: string
  usage?: Record<string, number>
  reqid?: string
  sentence?: { text?: string; words?: { word?: string; startTime?: number; endTime?: number; confidence?: number }[] }
}

const TERMINAL_CODE = 20000000
const OK_CODES = new Set([0, TERMINAL_CODE])

/**
 * Nominal pause after a sentence, chosen by the punctuation that ends it.
 *
 * These are what `narrateSentences` pads to when the service's own gap is
 * shorter (docs/TEACH-VIDEO.md §18): the user listened to a per-sentence cut and
 * heard the gaps disappear, because an earlier build normalised every tail to a
 * flat 180 ms. A sentence break should sound like one, so padding only ever
 * adds — it never trims what the voice already produced.
 */
export const SENTENCE_PAUSE_MS = {
  /** `。` — the ordinary end of a statement. */
  sentence: 400,
  /** `？` and `！` — a beat longer, they carry more weight. */
  question: 480,
  /** `，` `、` `；` `：` — a clause inside a sentence. */
  clause: 170,
  /** No terminal punctuation: the shortest break that still separates two utterances. */
  none: 120,
} as const

/**
 * Whether a provider reports word-level timings at all.
 *
 * This is a capability, not a quality setting: DeepSeek's documented response is
 * audio only, so a cue (which names a word) cannot be honoured there. Volcengine
 * reports `sentence.words[]` when asked for subtitles.
 */
export function supportsWordTimings(provider: string): boolean {
  return provider !== 'deepseek'
}

/**
 * How the gaps a provider already produced are treated when sentences are joined.
 *
 * `natural` keeps them exactly as they came out; `punctuation` may only extend
 * them up to the punctuation's nominal length. DeepSeek is `natural` because the
 * user's listening test found its own joins the most natural of every variant
 * tried, including a padded one (TEACH-VIDEO.md §21): padding it made the pace
 * feel rushed rather than better. Volcengine is `punctuation` because its
 * per-sentence gaps arrived short and clipped-sounding (§18). The policy lives in
 * code rather than in a document so the two providers cannot silently drift.
 */
export type PausePolicy = 'natural' | 'punctuation'

/** The pause policy for one provider. */
export function pausePolicyFor(provider: string): PausePolicy {
  return supportsWordTimings(provider) ? 'punctuation' : 'natural'
}

/** The nominal pause for a sentence, from its own final punctuation. */
export function sentenceEndPauseMs(text: string): number {
  const trimmed = text.trimEnd()
  if (trimmed === '') return SENTENCE_PAUSE_MS.none
  const last = trimmed.slice(-1)
  if (last === '。' || last === '.') return SENTENCE_PAUSE_MS.sentence
  if (last === '？' || last === '?' || last === '！' || last === '!') return SENTENCE_PAUSE_MS.question
  if ('，,、；;：:'.includes(last)) return SENTENCE_PAUSE_MS.clause
  return SENTENCE_PAUSE_MS.none
}

/** Characters that already end an utterance; joining does not add another. */
const TERMINALS = '。．.！!？?，,、；;：:'

export interface UtteranceJoin {
  /** Exactly what was sent as `req_params.text`. */
  text: string
  /** Character range of each input text inside {@link text}, in order. */
  spans: { start: number; end: number }[]
  /** The inputs after punctuation repair, in order. */
  parts: string[]
}

/**
 * Join sentences into one request body.
 *
 * Sentences are separated by a full stop, never by a comma and never by a bare
 * newline: the service decides its pauses from punctuation, so a comma between
 * sentences buys a clause-length breath where a sentence-length one is wanted.
 * Trailing punctuation is repaired rather than duplicated (`好。` + `下一句` must
 * not become `好。。下一句`).
 */
export function joinUtterance(texts: readonly string[]): UtteranceJoin {
  const parts: string[] = []
  const spans: { start: number; end: number }[] = []
  let cursor = 0
  for (const raw of texts) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const part = TERMINALS.includes(trimmed.slice(-1)) ? trimmed : `${trimmed}。`
    spans.push({ start: cursor, end: cursor + part.length })
    parts.push(part)
    cursor += part.length
  }
  return { text: parts.join(''), spans, parts }
}

/**
 * Which input sentence each returned word belongs to.
 *
 * The service splits on punctuation and may merge or re-split, so the mapping is
 * by character position: each word occupies the next `word.t.length` characters
 * of the text that was sent, and the span it lands in is its sentence. Words
 * running past the last span (the service adding a space, say) belong to the
 * last sentence rather than to nothing.
 */
export function assignWordsToSpans(words: readonly TimedWord[], spans: readonly { start: number; end: number }[]): number[] {
  if (spans.length === 0) return words.map(() => 0)
  const assignment: number[] = []
  let cursor = 0
  for (const word of words) {
    let index = spans.findIndex(span => cursor < span.end)
    if (index < 0) index = spans.length - 1
    assignment.push(index)
    cursor += word.t.length
  }
  return assignment
}

/**
 * The speech endpoint takes an integer rate (probe 2026-11-20: `1.2` is rejected
 * with `cannot unmarshal number 1.2 into … speech_rate of type int32`). Refusing
 * it here means the operator reads a sentence they can act on instead of a Go
 * type error.
 */
export function normalizeSpeedRatio(value: number | null | undefined): number {
  if (value === null || value === undefined) return 1
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new VoiceError(`语速只接受整数（speech_rate 是 int32，默认 1），收到 ${value}；把 meta.voice.speed_ratio 改成整数，或删掉它用默认值`)
  }
  return value
}

/**
 * Fold one NDJSON line into the result being accumulated.
 *
 * Exported so the fixtures can pin the three quirks (empty accumulated entry,
 * glued punctuation, rounding to whole milliseconds) without a network call.
 */
export function foldVoiceLine(line: VoiceLine, into: { audio: Uint8Array[], sentences: SynthesizedSentence[], usage: Record<string, number> | null }): void {
  if (typeof line.code === 'number' && !OK_CODES.has(line.code)) {
    throw new VoiceError(`voice synthesis failed: ${line.message ?? 'no message'}${line.reqid === undefined ? '' : ` (reqid ${line.reqid})`}`, { code: line.code })
  }
  if (typeof line.data === 'string' && line.data !== '') {
    into.audio.push(new Uint8Array(Buffer.from(line.data, 'base64')))
  }
  if (line.usage !== undefined && line.usage !== null) into.usage = line.usage

  const sentence = line.sentence
  if (sentence === undefined) return
  const wordsRaw = Array.isArray(sentence.words) ? sentence.words : []
  // The cumulative entry: text yes, words no. Dropping it is what keeps the
  // timeline aligned with the audio instead of restarting at every sentence.
  if (wordsRaw.length === 0) return
  const words: TimedWord[] = wordsRaw.map(word => ({
    t: typeof word.word === 'string' ? word.word : '',
    b: Math.round((word.startTime ?? 0) * 1000),
    e: Math.round((word.endTime ?? 0) * 1000),
  }))
  into.sentences.push({ text: sentence.text ?? words.map(word => word.t).join(''), words })
}

/** Split NDJSON text into parsed lines, refusing anything that is not JSON. */
export function parseVoiceBody(body: string): VoiceLine[] {
  const lines: VoiceLine[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    try {
      lines.push(JSON.parse(line) as VoiceLine)
    } catch (error: unknown) {
      throw new VoiceError(`voice response had a line that is not JSON (${excerpt(line, 120)})`, { cause: error })
    }
  }
  return lines
}

/** Assemble the whole NDJSON body into one result. */
export function assembleVoiceBody(body: string, logId: string | null = null): Synthesized {
  const into: { audio: Uint8Array[], sentences: SynthesizedSentence[], usage: Record<string, number> | null } = {
    audio: [],
    sentences: [],
    usage: null,
  }
  for (const line of parseVoiceBody(body)) foldVoiceLine(line, into)
  const bytes = into.audio.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const audio = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of into.audio) {
    audio.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (audio.byteLength === 0) throw new VoiceError('voice response carried no audio', { logId })
  if (into.sentences.length === 0) throw new VoiceError('voice response carried no word timings; the request needs audio_params.enable_subtitle', { logId })
  const words = into.sentences.flatMap(sentence => sentence.words)
  return { audio, sentences: into.sentences, words, usage: into.usage, logId, timestamps: 'word' }
}

/** Synthesize one sentence. Throws {@link VoiceError}; never retries — callers pace and retry deliberately. */
export async function synthesizeSentence(options: SynthesizeOptions): Promise<Synthesized> {
  const text = options.text.trim()
  if (text === '') throw new VoiceError('cannot synthesize empty text')
  if (options.apiKey.trim() === '') throw new VoiceError('no voice credential: set ARK_VOICE_API_KEY')

  const rate = normalizeSpeedRatio(options.speedRatio)
  const audioParams: Record<string, unknown> = {
    format: 'mp3',
    sample_rate: VOICE_SAMPLE_RATE,
    // This boolean is the whole reason word timings exist; a number is rejected
    // with a Go unmarshal error, which is how the shape was found.
    enable_subtitle: true,
    // Always sent, never left to the service default: a rate that varies per
    // request is one of the ways consecutive sentences stop sounding alike.
    speech_rate: rate,
  }

  const body = JSON.stringify({ req_params: { text, speaker: options.speaker, audio_params: audioParams } })
  let response: Response
  try {
    response = await fetch(options.baseUrl ?? VOICE_BASE_URL, {
      method: 'POST',
      headers: {
        'X-Api-Key': options.apiKey,
        'X-Api-Resource-Id': VOICE_RESOURCE_ID,
        'Content-Type': 'application/json',
      },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error: unknown) {
    throw new VoiceError(`voice request failed (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }

  const logId = response.headers.get('x-tt-logid')
  const raw = await response.text()
  if (!response.ok) {
    throw new VoiceError(`voice endpoint answered ${response.status}${raw === '' ? '' : `: ${excerpt(raw, 300)}`}`, { logId })
  }
  return assembleVoiceBody(raw, logId)
}

export interface SynthesizeUtteranceOptions extends Omit<SynthesizeOptions, 'text'> {
  /** One request for all of them, joined by sentence punctuation. */
  texts: readonly string[]
}

export interface SynthesizedUtterance extends Synthesized {
  join: UtteranceJoin
  /** For each word in `words`, the index of the input text it belongs to. */
  groups: number[]
}

/**
 * Synthesize several sentences in one request.
 *
 * This is the default path (docs/TEACH-VIDEO.md §18): the user's listening test
 * found the merged version noticeably more coherent than separate requests,
 * because every request restarts the prosody. The price is re-work granularity —
 * re-recording one sentence re-synthesizes the whole utterance — and that trade
 * is stated in `video-teach-iterate`.
 */
export async function synthesizeUtterance(options: SynthesizeUtteranceOptions): Promise<SynthesizedUtterance> {
  const join = joinUtterance(options.texts)
  if (join.parts.length === 0) throw new VoiceError('cannot synthesize empty text')
  const synthesized = await synthesizeSentence({ ...options, text: join.text })
  return { ...synthesized, join, groups: assignWordsToSpans(synthesized.words, join.spans) }
}

/** DeepSeek's official speech endpoint (api-docs.deepseek.com, /v1/tools/tts). */
export const DEEPSEEK_TTS_URL = 'https://api.deepseek.com/v1/tools/tts'

/** The voices DeepSeek documents: one female, one male. */
export const DEEPSEEK_VOICES = ['stella', 'tide'] as const

export interface DeepseekOptions {
  text: string
  apiKey: string
  /** `stella` (default) or `tide`. */
  voiceId?: string
  baseUrl?: string
  signal?: AbortSignal
}

/**
 * Synthesize one sentence with DeepSeek.
 *
 * The documented response is audio only — `audio/wav` (24 kHz, mono, 16-bit) or
 * raw PCM — and the guide lists no timestamp, subtitle or speech-rate parameter.
 * So this provider reports `timestamps: 'none'`: the narration is usable, the
 * cue-driven picture is not, and pretending otherwise would put fragments on
 * invented moments.
 *
 * Cost, for the record: ¥3 per 10,000 billed characters (¥1.5 while discounted),
 * and a Chinese character counts as two, so a Chinese script costs twice the
 * headline rate. There is also no speed control at all.
 */
export async function synthesizeDeepseek(options: DeepseekOptions): Promise<Synthesized> {
  const text = options.text.trim()
  if (text === '') throw new VoiceError('cannot synthesize empty text')
  if (options.apiKey.trim() === '') throw new VoiceError('no voice credential: set DEEPSEEK_API_KEY')
  const body = JSON.stringify({
    text,
    ...(options.voiceId === undefined || options.voiceId === '' ? {} : { voice_id: options.voiceId }),
    format: 'wav',
    filter_markdown: true,
  })
  let response: Response
  try {
    response = await fetch(options.baseUrl ?? DEEPSEEK_TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error: unknown) {
    throw new VoiceError(`DeepSeek TTS request failed (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  const logId = response.headers.get('x-ds-trace-id') ?? response.headers.get('x-request-id')
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new VoiceError(`DeepSeek TTS answered ${response.status}${detail === '' ? '' : `: ${excerpt(detail, 300)}`}`, { logId })
  }
  const audio = new Uint8Array(await response.arrayBuffer())
  if (audio.byteLength === 0) throw new VoiceError('DeepSeek TTS returned no audio', { logId })
  return {
    audio,
    sentences: [{ text, words: [] }],
    words: [],
    usage: null,
    logId,
    timestamps: 'none',
  }
}
