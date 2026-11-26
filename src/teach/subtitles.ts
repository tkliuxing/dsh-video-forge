/**
 * The subtitle side of the picture: SRT cues from the word timings, and the style
 * the burn-in renders them with.
 *
 * Two products come from one function here on purpose. The external `.srt` that
 * `video_teach_export` writes and the cues burned into `renders/<shot>/vNNN.mp4`
 * are the *same text*: an SRT the platform can read and a picture that already
 * carries the lines must not disagree about a single cue boundary, and the only
 * way to be sure of that is to build it once.
 *
 * The cue content is the narration, which the author wrote and paid to record.
 * That is what makes burning subtitles legitimate on this route: DESIGN §1 rules
 * out *auto-generated* captions (a second model guessing at what was said), not
 * the author's own lines.
 */

import type { Timings } from './storyboard.ts'

/**
 * How the burn-in looks.
 *
 * Sizes are ASS units, not pixels: libass scales the style from its PlayResY to
 * the frame, and the SRT→ASS conversion ffmpeg performs uses a 288-unit-tall
 * canvas. A 1080p frame therefore multiplies every value here by 1080/288 = 3.75,
 * which is why the numbers look small.
 *
 * Measured on 2026-11-25 against a real burn (ffmpeg-full 9.1, libass, fontconfig
 * resolving `PingFang SC` to Hiragino Sans GB), by decoding the burned frame to
 * raw RGB and scanning rows:
 *
 * - one line (`fontSize 18`, `marginV 12`, `outline 1.5`): glyph rows 969–1032,
 *   63 px tall, inside the 900–1080 band this route promises;
 * - a 45-character cue wraps to two lines: rows 911–1023, so the block still
 *   starts inside the band. A third line would start above row 900 — which the
 *   §17 sentence budget (≈32 characters in 8 s) already rules out;
 * - `outline 2.5` swallowed the stroke ends of thin CJK glyphs at this size,
 *   which is why it is 1.5.
 */
export interface SubtitleStyle {
  /**
   * Font family, resolved by fontconfig. A CJK family is required: ffmpeg's
   * default (Arial-like) has no Chinese glyphs and renders boxes instead.
   */
  fontName: string
  /** Line height in ASS units (×3.75 at 1080p, so 18 is a 67 px line). */
  fontSize: number
  /** Distance from the frame's bottom edge to the line, in ASS units. */
  marginV: number
  /** Outline width in ASS units; the outline is what keeps white text readable on a white slide. */
  outline: number
}

/** A CJK family that exists on each platform, used when the operator names none. */
const PLATFORM_FONT: Readonly<Record<string, string>> = {
  darwin: 'PingFang SC',
  win32: 'Microsoft YaHei',
  linux: 'Noto Sans CJK SC',
}

/**
 * The family to burn with.
 *
 * `TEACH_SUBTITLE_FONT` wins: the platform default is a best guess about a
 * machine, and an operator whose fontconfig lacks that family deserves a way to
 * say so without editing the plugin. A missing family is not silent either —
 * libass falls back, and the frame check in the live test would show the wrong
 * glyphs.
 */
export const DEFAULT_SUBTITLE_FONT = (process.env.TEACH_SUBTITLE_FONT ?? '').trim() || PLATFORM_FONT[process.platform] || 'sans-serif'

/** The style a burn uses when the caller names none. */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontName: DEFAULT_SUBTITLE_FONT,
  fontSize: 18,
  marginV: 12,
  outline: 1.5,
}

/**
 * The `force_style=` value for one style.
 *
 * Alignment 2 is bottom-centre, and the outline is opaque black: subtitles sit on
 * slides that are mostly white, where white text without an outline disappears.
 */
export function forceStyle(style: SubtitleStyle = DEFAULT_SUBTITLE_STYLE): string {
  return [
    'Alignment=2',
    'BorderStyle=1',
    `FontName=${style.fontName}`,
    `Fontsize=${style.fontSize}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'Shadow=0',
    `Outline=${style.outline}`,
    `MarginV=${style.marginV}`,
    'MarginL=80',
    'MarginR=80',
  ].join(',')
}

/**
 * SRT cues from the word timings, wrapped at a readable width and timed by the words.
 *
 * A provider that reports word timings gets cues that follow the words; one that
 * does not (DeepSeek, the default) gets one cue per sentence, which is the
 * largest honest unit. The cue width is characters, not seconds: 18 Chinese
 * characters is about what fits on two lines at this font size.
 */
export function buildSrt(timings: Timings, maxChars = 18): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const stamp = (ms: number): string => {
    const clamped = Math.max(0, Math.round(ms))
    return `${pad(Math.floor(clamped / 3_600_000), 2)}:${pad(Math.floor((clamped % 3_600_000) / 60_000), 2)}:${pad(Math.floor((clamped % 60_000) / 1000), 2)},${pad(clamped % 1000, 3)}`
  }
  const cues: { start: number, end: number, text: string }[] = []
  let offset = 0
  for (const sentence of timings.sentences) {
    // Two clocks, one code path: the per-sentence contract counts offsets forward
    // (each sentence's file follows the last one plus its tail transition), while a
    // single master track says where every sentence starts outright
    // (docs/TEACH-VIDEO.md §29).
    if (sentence.beginMs !== undefined) offset = sentence.beginMs
    let current: { start: number, end: number, text: string } | null = null
    for (const word of sentence.words) {
      if (current === null) {
        current = { start: offset + word.b, end: offset + word.e, text: word.t }
        continue
      }
      if (current.text.length + word.t.length > maxChars) {
        cues.push(current)
        current = { start: offset + word.b, end: offset + word.e, text: word.t }
        continue
      }
      current.text += word.t
      current.end = offset + word.e
    }
    if (current !== null) cues.push(current)
    // A provider without word timings (DeepSeek, the default) still has one
    // thing worth subtitling: the sentence itself. Without this branch the SRT
    // came out empty on the default route while the tool reported it as
    // "word-timed" (found 2026-11-20 by the page-mode acceptance run).
    if (sentence.words.length === 0 && sentence.text !== '') {
      cues.push({ start: offset, end: offset + sentence.durationMs, text: sentence.text })
    }
    // The picture segment is `durationMs + exitMs` long and the tail transition
    // plays over silence, so the next sentence — in the film and in the SRT — starts
    // after both (docs/TEACH-MOTION.md §6.4). A cue never runs into that silence:
    // the last word of a sentence ends before the body is cut.
    offset += sentence.durationMs + sentence.exitMs
  }
  return `${cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n')}\n`
}
