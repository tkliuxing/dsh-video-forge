/**
 * The rules that make "content and timeline work together" checkable
 * (docs/TEACH-VIDEO.md §17).
 *
 * The 2026-11-20 sample exposed the failure mode these rules exist for: a
 * slide deck that froze for forty seconds while the narration kept talking, and
 * a Manim scene reused by three sentences so the same animation played three
 * times. Both were content problems, not rendering bugs, and both were
 * invisible to every check the pipeline had: the video was the right length.
 *
 * The organising principle is one line: **every sentence brings one picture
 * change.** A sentence that changes nothing is either a deliberate hold (say so
 * in the manuscript) or a mistake. Everything below measures that line.
 *
 * Two kinds of finding, deliberately separated:
 *
 * - `structural`: the manuscript cannot be rendered as written (a cue names a
 *   fragment the deck does not have). `video_teach_plan` refuses on these.
 * - `warnings`: the manuscript renders, but its content and its clock fight each
 *   other. These are named per sentence so an author can act on them without
 *   re-reading the whole script.
 *
 * Nothing here is a judgement about taste. A 12-second sentence can be perfect;
 * the rules only say it will hold one picture for 12 seconds, which is the thing
 * worth knowing before paying for narration.
 */

import { DEFAULT_VOICE_PROVIDER, type Storyboard, type Segment } from './storyboard.ts'
import { supportsWordTimings } from './voice.ts'

/**
 * Chinese characters per second, for estimating how long a sentence will be
 * spoken. Measured, not assumed: the 2026-11-20 sample narrated 876 characters
 * in 174.3 s, which is 5.03 characters per second (301 per minute). The plan
 * used to estimate 4/s (240/min) and undershot every projection by a fifth.
 */
export const CHARS_PER_SECOND = 5

/** Beats inside one sentence beyond this usually mean the sentence carries two ideas. */
export const MAX_BEATS_PER_SENTENCE = 3

/** Below this a sentence is gone before the viewer can read what changed. */
export const MIN_SENTENCE_SECONDS = 2

/** Above this one picture has to hold too long; split the line or add a cue. */
export const MAX_SENTENCE_SECONDS = 8

/** The rhythm the slides skill asks for: a picture change every few seconds. */
export const MAX_AVERAGE_CUE_GAP_SECONDS = 8

/**
 * Frame-colour count at or below which a sampled frame counts as "nothing was
 * drawn".
 *
 * Two measurements set it, and the second one lowered it. A real teaching frame
 * is a text slide or a Manim scene: the sparsest frame seen in the 2026-11-20
 * sample was **57** distinct sRGB colours, a page showing only its two-character
 * heading before the first beat fired; a fully blank frame counts 1–2 (the white
 * deck that shipped 116 s of nothing was 1, every pixel 255). An earlier
 * threshold of 64 sat above that 57 and called a perfectly good page "flat"
 * (found by the page-mode acceptance run), so the line moved to 16: eight times a
 * blank frame, well under any frame that drew a glyph.
 */
export const FLAT_FRAME_COLORS = 16

/** Two or more sampled frames with exactly this many colours are reported as "unchanged". */
export const UNCHANGED_FRAME_TOLERANCE = 0

/** A sentence's estimated spoken length, in seconds. */
export function estimateSentenceSeconds(chars: number): number {
  return chars / CHARS_PER_SECOND
}

export interface ManuscriptAudit {
  /** The manuscript cannot be rendered as written; the plan refuses. */
  structural: string[]
  /** It renders, but the content and the clock disagree. Named per sentence. */
  warnings: string[]
  /** Sentences that change no picture at all, in timeline order. */
  silent: string[]
  /** Average seconds between picture changes across the whole film. */
  averageCueGapSeconds: number | null
}

export interface AuditOptions {
  /**
   * How many fragments each slides deck actually has, keyed by segment id. A
   * segment missing from the map was not inspected (no deck read), so its
   * fragments are not range-checked.
   */
  deckFragments?: ReadonlyMap<string, number>
}

/** Which sentences share one Manim scene file, for the "same animation twice" rule. */
function scenesByPath(board: Storyboard): Map<string, { scene: string, sentences: string[], segments: string[] }> {
  const byPath = new Map<string, { scene: string, sentences: string[], segments: string[] }>()
  for (const segment of board.segments) {
    if (segment.engine !== 'manim' || segment.scene === null) continue
    const entry = byPath.get(segment.scene) ?? { scene: segment.scene, sentences: [], segments: [] }
    entry.sentences.push(...segment.sentences.map(sentence => sentence.id))
    entry.segments.push(segment.id)
    byPath.set(segment.scene, entry)
  }
  return byPath
}

/** Sentences in timeline order with their segment and cue count. */
function timeline(board: Storyboard): { id: string, segment: Segment, chars: number, cues: number }[] {
  return board.segments.flatMap(segment => segment.sentences.map(sentence => ({
    id: sentence.id,
    segment,
    chars: sentence.say.length,
    cues: sentence.cues.length,
  })))
}

/**
 * Check a manuscript against the rules.
 *
 * @param board - the parsed manuscript.
 * @param options - deck fragment counts, when the caller read the decks.
 * @returns findings split into structural refusals and per-sentence warnings.
 */
export function auditManuscript(board: Storyboard, options: AuditOptions = {}): ManuscriptAudit {
  const structural: string[] = []
  const warnings: string[] = []
  const silent: string[] = []
  const rows = timeline(board)
  // A provider without word timings drives the deck by page: one page per
  // sentence, with `at_progress` beats inside it. A sentence with no beat is
  // therefore not silent (its page is the picture), and the cue numbers are
  // counted per page rather than across the deck, so the two deck-numbering rules
  // below invert or move to `auditDecks` (docs/TEACH-VIDEO.md §21, §23).
  const wordTimings = supportsWordTimings(board.voice?.provider ?? DEFAULT_VOICE_PROVIDER)

  // --- per-sentence: length budget -----------------------------------------
  for (const row of rows) {
    const seconds = estimateSentenceSeconds(row.chars)
    if (seconds < MIN_SENTENCE_SECONDS) {
      warnings.push(`sentence "${row.id}" is ${row.chars} characters (~${seconds.toFixed(1)} s), under the ${MIN_SENTENCE_SECONDS} s floor: the picture changes before it can be read`)
    }
    if (seconds > MAX_SENTENCE_SECONDS) {
      warnings.push(`sentence "${row.id}" is ${row.chars} characters (~${seconds.toFixed(0)} s), over the ${MAX_SENTENCE_SECONDS} s budget: one picture has to hold that long, so add a cue or split the line`)
    }
  }

  // --- per-sentence: every sentence changes one picture ---------------------
  for (const row of rows) {
    if (wordTimings && row.segment.engine === 'slides' && row.cues === 0) {
      silent.push(row.id)
      warnings.push(`sentence "${row.id}" (slides, ${row.segment.id}) has no cue: the picture does not change at all. Add a cue, or mark the hold deliberately in the manuscript`)
    }
  }

  // --- progress cues: where in the sentence they land, and how many ---------
  for (const segment of board.segments) {
    for (const sentence of segment.sentences) {
      const progress = sentence.cues.filter(cue => cue.atProgress !== null)
      if (progress.length === 0) continue
      for (const cue of progress) {
        const value = cue.atProgress as number
        // 0.2–0.8 keeps a beat away from the breath at either end: at 0.05 the
        // fragment appears before the viewer has heard the setup, at 0.95 it
        // lands after the sentence is effectively over.
        if (value < 0.2 || value > 0.8) {
          warnings.push(`sentence "${sentence.id}" fires fragment ${cue.fragment} at ${(value * 100).toFixed(0)}% of its length; 20–80% is the range where a beat is not swallowed by the breath at either end`)
        }
      }
      // Two or three beats per sentence is a demonstration; more means the
      // sentence carries more than one idea and should be split.
      if (progress.length > MAX_BEATS_PER_SENTENCE) {
        warnings.push(`sentence "${sentence.id}" has ${progress.length} beats inside one sentence; more than ${MAX_BEATS_PER_SENTENCE} usually means it covers two ideas — split the sentence so each one can be paced on its own`)
      }
    }
  }

  // --- structural: a cue must name a fragment the deck actually has ---------
  //
  // Cue mode only. In page mode a fragment number is counted inside its own page
  // (reveal.js numbers fragments per slide, and `teachCue` follows that), so the
  // number to check against is the page's own fragment count, not the deck's
  // total — `auditDecks` does that, because it is the function that reads pages.
  if (wordTimings) {
    for (const segment of board.segments) {
      if (segment.engine !== 'slides') continue
      const total = options.deckFragments?.get(segment.id)
      if (total === undefined) continue
      const cues = segment.sentences.flatMap(sentence => sentence.cues.map(cue => ({ sentence: sentence.id, fragment: cue.fragment })))
      for (const cue of cues) {
        if (cue.fragment > total) {
          structural.push(`sentence "${cue.sentence}" (segment "${segment.id}") fires fragment ${cue.fragment}, but ${segment.deck} has ${total} fragment${total === 1 ? '' : 's'}`)
        }
      }
    }

    // --- rhythm: fragments advance within a segment, and often enough -------
    for (const segment of board.segments) {
      let previous: { sentence: string, fragment: number } | null = null
      for (const sentence of segment.sentences) {
        for (const cue of sentence.cues) {
          if (previous !== null && cue.fragment <= previous.fragment) {
            warnings.push(`sentence "${sentence.id}" (segment "${segment.id}") fires fragment ${cue.fragment}, not after "${previous.sentence}"'s fragment ${previous.fragment}: the picture will not move`)
          }
          previous = { sentence: sentence.id, fragment: cue.fragment }
        }
      }
    }
  }

  const totalCues = rows.reduce((sum, row) => sum + row.cues, 0)
  const totalSeconds = rows.reduce((sum, row) => sum + estimateSentenceSeconds(row.chars), 0)
  const averageCueGapSeconds = totalCues === 0 ? null : totalSeconds / totalCues
  if (averageCueGapSeconds !== null && averageCueGapSeconds > MAX_AVERAGE_CUE_GAP_SECONDS) {
    warnings.push(`picture changes every ${averageCueGapSeconds.toFixed(1)} s on average (${totalCues} cue${totalCues === 1 ? '' : 's'} over ~${totalSeconds.toFixed(0)} s); the target is one every ${MAX_AVERAGE_CUE_GAP_SECONDS} s at most`)
  }
  if (silent.length >= 2) {
    const consecutive = consecutiveIdPairs(rows.map(row => (silent.includes(row.id) ? row.id : null)))
    if (consecutive.length > 0) {
      warnings.push(`sentences ${consecutive.map(pair => `"${pair[0]}" then "${pair[1]}"`).join(', ')} change no picture one after another`)
    }
  }

  // --- manim: one scene, one sentence --------------------------------------
  for (const entry of scenesByPath(board).values()) {
    if (entry.sentences.length > 1) {
      warnings.push(`scene ${entry.scene} is used by ${entry.sentences.length} sentences (${entry.sentences.join(', ')}): the same animation plays ${entry.sentences.length} times. Give each sentence its own scene, or merge the sentences`)
    }
  }

  return { structural, warnings, silent, averageCueGapSeconds }
}

/** Adjacent pairs where both entries carry an id; indices would be useless to a reader. */
function consecutiveIdPairs(ids: readonly (string | null)[]): [string, string][] {
  const pairs: [string, string][] = []
  for (let index = 0; index + 1 < ids.length; index += 1) {
    const left = ids[index]
    const right = ids[index + 1]
    if (left !== null && left !== undefined && right !== null && right !== undefined) pairs.push([left, right])
  }
  return pairs
}

/**
 * How many reveal.js fragments a deck declares.
 *
 * Counting `class="fragment"` in the HTML matches what the cue contract means
 * (src/teach/slides.ts drives `Reveal.nextFragment()`), and it is the number the
 * author has to stay under. A deck that builds fragments in JavaScript is not
 * counted, so an unreadable count is reported as `null` rather than as zero.
 */
export function countDeckFragments(html: string): number | null {
  const matches = html.match(/class\s*=\s*["'][^"']*\bfragment\b[^"']*["']/g)
  return matches === null ? null : matches.length
}

/**
 * Fragments counted inside each top-level `<section>`, in page order.
 *
 * Page mode shows one page per sentence, and `teachCue(n)` counts fragments on
 * the *current* slide, so the number a beat may use is its own page's count, not
 * the deck's total. The split is on `<section …>` opening tags, which is exact
 * for the flat deck both templates produce; a deck that nests sections (a
 * vertical stack) is counted approximately, so the caller reports a mismatch as
 * a warning rather than refusing.
 *
 * `null` means the deck has no `<section>` to split on at all (a deck built in
 * JavaScript), where guessing would be worse than staying quiet.
 */
export function deckPageFragments(html: string): number[] | null {
  const pieces = html.split(/<section\b[^>]*>/i)
  if (pieces.length < 2) return null
  return pieces.slice(1).map(piece => countDeckFragments(piece) ?? 0)
}

/** What a slides deck provides, as far as the manuscript is allowed to rely on it. */
export interface DeckInfo {
  /** The path the manuscript named, for messages. */
  path: string
  /** `class="fragment"` count over the whole deck, or null when the deck builds them in JavaScript. */
  fragments: number | null
  /** Fragments per top-level `<section>`, or null when the deck could not be split into pages. */
  pageFragments: number[] | null
  /** Whether the deck defines the recorder's three globals. */
  hasCue: boolean
  hasPage: boolean
  hasReady: boolean
}

/** A deck finding, in the same two buckets `auditManuscript` uses. */
export interface DeckAudit {
  structural: string[]
  warnings: string[]
}

/**
 * Check each slides deck against what its manuscript will do with it.
 *
 * This exists because the deck contract used to be discovered at render time.
 * The 2026-11-20 page-mode acceptance run lost its narration money twice over: a
 * deck written for cue mode has no `teachPage`, and the recorder only said so
 * after `narrate` had already been paid for; a deck with fewer pages than the
 * segment has sentences showed the last page for every sentence past the end.
 * Both are visible from the HTML alone, so the plan can say them for free.
 */
export function auditDecks(board: Storyboard, decks: ReadonlyMap<string, DeckInfo>): DeckAudit {
  const structural: string[] = []
  const warnings: string[] = []
  const provider = board.voice?.provider ?? DEFAULT_VOICE_PROVIDER
  const pageMode = !supportsWordTimings(provider)

  for (const segment of board.segments) {
    if (segment.engine !== 'slides') continue
    const info = decks.get(segment.id)
    if (info === undefined) continue
    const label = `segment "${segment.id}" (${info.path})`
    if (!info.hasReady) {
      structural.push(`${label} never sets window.teachReady, so the recorder waits 15 s for it and then fails; scaffold the deck from assets/teach/deck/index.html or add the line that sets it`)
    }
    const cues = segment.sentences.reduce((sum, sentence) => sum + sentence.cues.length, 0)
    if (cues > 0 && !info.hasCue) {
      structural.push(`${label} fires ${cues} cue${cues === 1 ? '' : 's'} but does not define window.teachCue(index), so no beat can land; take the template's teachCue or drop the cues`)
    }
    if (pageMode && !info.hasPage) {
      structural.push(`${label} does not define window.teachPage(n), which the page mode needs: voice "${provider}" reports no word timings, so the picture advances one page per sentence. Add the page-mode globals from assets/teach/deck/index.html (one <section> per sentence), or narrate with volcengine for cue-driven fragments`)
    }
    if (!pageMode || info.pageFragments === null) continue

    const pages = info.pageFragments.length
    if (pages < segment.sentences.length) {
      const stranded = segment.sentences.slice(pages).map(sentence => `"${sentence.id}"`)
      warnings.push(`${label} has ${pages} page${pages === 1 ? '' : 's'} but the segment has ${segment.sentences.length} sentence(s); page mode starts one page per sentence, so ${stranded.join(', ')} will hold the last page. Give each sentence its own <section>`)
    }
    segment.sentences.forEach((sentence, page) => {
      const available = info.pageFragments?.[page]
      if (available === undefined) return
      for (const cue of sentence.cues) {
        if (cue.fragment > available) {
          // Per-page numbering is what the shipped template implements (and
          // clamps to, so a bad number no longer walks off the page). A deck that
          // translates the manuscript's numbers itself — the acceptance run wrote
          // one — is legitimate, so this is stated as a mismatch rather than
          // refused.
          warnings.push(`sentence "${sentence.id}" fires fragment ${cue.fragment} on page ${page + 1} of ${info.path}, which has ${available} fragment${available === 1 ? '' : 's'}. The template's teachCue counts inside the page and clamps there, so beats on that page are numbered 1..${available} unless this deck translates the manuscript's numbers itself`)
        }
      }
    })
  }

  return { structural, warnings }
}

export interface FrameSample {
  /** Milliseconds into the segment where the frame was taken. */
  atMs: number
  /** Distinct sRGB colours in that frame. */
  colors: number
}

/** A segment the self-check will not certify, with the reason it was flagged. */
export interface SuspectSegment {
  id: string
  reason: 'flat' | 'unchanged'
  detail: string
  samples: FrameSample[]
}

/**
 * Judge a segment's sampled frames.
 *
 * Two independent heuristics, both reported rather than acted on:
 *
 * - `flat`: **every** sampled frame has ≤ {@link FLAT_FRAME_COLORS} colours, so
 *   the segment never drew anything. This is the shape the 2026-11-20 white
 *   slides had (1 colour, every pixel 255). The test is "every sample", not "any
 *   sample": a page-mode sentence legitimately opens on a heading-only frame and
 *   fills in on its first beat, and one sparse early frame is not a blank
 *   segment (the acceptance run had a 57-colour frame reported as blank).
 * - `unchanged`: every sample has exactly the same colour count. Weak on its
 *   own (a deck legitimately holds a still frame), which is why the reason is
 *   reported and the author decides; a cue that never fired looks like this.
 */
export function judgeSamples(id: string, samples: readonly FrameSample[]): SuspectSegment | null {
  if (samples.length === 0) return null
  const flattest = samples.reduce((low, sample) => (sample.colors < low.colors ? sample : low), samples[0]!)
  if (samples.every(sample => sample.colors <= FLAT_FRAME_COLORS)) {
    return {
      id,
      reason: 'flat',
      detail: `no sampled frame drew anything: the frame at ${(flattest.atMs / 1000).toFixed(1)} s has ${flattest.colors} distinct colour${flattest.colors === 1 ? '' : 's'}`,
      samples: [...samples],
    }
  }
  if (samples.length >= 2 && samples.every(sample => Math.abs(sample.colors - flattest.colors) <= UNCHANGED_FRAME_TOLERANCE)) {
    return {
      id,
      reason: 'unchanged',
      detail: `all ${samples.length} sampled frames have ${flattest.colors} colours; if a cue was supposed to fire here, it did not`,
      samples: [...samples],
    }
  }
  return null
}

/** Where to sample a segment of `durationMs`: inside the sentence, avoiding the first and last tenth. */
export function sampleTimes(durationMs: number, count = 4): number[] {
  const safe = Math.max(200, durationMs)
  return Array.from({ length: count }, (_, index) => Math.round(safe * (0.1 + (0.8 * index) / Math.max(1, count - 1))))
}

/**
 * When a manuscript needs nothing but slides, it must not be held hostage to a
 * Manim installation (docs/TEACH-VIDEO.md §19).
 *
 * A teaching video has two engines and they have very different installation
 * weight: slides need `ffmpeg` plus a Chromium, while `engine: manim` additionally
 * needs a Python carrying Manim, a TeX, and `dvisvgm` (which BasicTeX on macOS
 * does not ship). Reporting those three beside `ffmpeg` in one flat "missing"
 * list made a slides-only project look broken, and the real failure arrived only
 * at render time — after narration had already been paid for.
 *
 * So dependencies are sorted by what they are for, and only what this manuscript
 * actually uses can block it.
 */

/** Which part of the route a program belongs to. */
export type DependencyScope = 'required' | 'slides' | 'manim'

/** The raw probe result; the caller owns how each line was obtained. */
export interface DependencyProbe {
  ffmpeg: string
  ffprobe: string
  /** Chromium path, or a note that Playwright's own lookup will answer. */
  chromium: string
  /** The Python interpreter, or `missing`. */
  python3: string
  /** `manim <version>`, or why not. */
  manim: string
  latex: string
  dvisvgm: string
}

/** One program, judged against this manuscript. */
export interface DependencyFinding {
  name: string
  scope: DependencyScope
  /** `present`, a path, or `missing` / `not installed`. */
  state: string
  /** Whether this particular absence stops this manuscript. */
  blocking: boolean
  /** What to run, shown only when it blocks. */
  install: string | null
}

export interface DependencyAssessment {
  /** Whether any sentence in this manuscript needs Manim. */
  needsManim: boolean
  entries: DependencyFinding[]
  /** Names of the programs whose absence stops this manuscript. */
  blocking: string[]
  /** The refusal to throw, or null when this manuscript can be rendered here. */
  refusal: string | null
  /** One line saying which tiers this manuscript actually needs. */
  summary: string
}

const INSTALL: Record<string, string> = {
  ffmpeg: 'install ffmpeg (macOS: `brew install ffmpeg`; Debian: `apt install ffmpeg`)',
  ffprobe: 'it ships with ffmpeg, so install that (macOS: `brew install ffmpeg`)',
  python3: 'install a Python 3.10+ and put Manim in it: `python3 -m venv ~/.local/venvs/teach-video && ~/.local/venvs/teach-video/bin/pip install manim`, then point TEACH_PYTHON at that interpreter',
  manim: 'install Manim into the interpreter this host uses: `pip install manim` (or set TEACH_PYTHON to a Python that already has it)',
  latex: 'install a TeX (macOS: `brew install --cask basictex`, or TinyTeX) and put its bin on TEACH_TEXBIN',
  dvisvgm: 'BasicTeX ships `latex` but NOT `dvisvgm`, so a basictex-only install fails with "latex error converting to dvi". Use TinyTeX (`curl -sL https://yihui.org/tinytex/install-bin-unix.sh | sh`, binaries in ~/Library/TinyTeX/bin/universal-darwin) or `tlmgr install dvisvgm` on a writable TeX, then point TEACH_TEXBIN at that bin directory',
}

const MISSING = new Set(['missing', 'not installed'])

/** Whether one probed state reads as absent. */
export function isMissing(state: string): boolean {
  const text = state.trim()
  // `not installed (No module named manim)` carries the reason in parentheses, so
  // the test is a prefix rather than a word split.
  return MISSING.has(text) || text.startsWith('not installed')
}

/**
 * Judge a probe against a manuscript.
 *
 * The rule is narrow on purpose: an absent program blocks only when some segment
 * in *this* manuscript would use it. `chromium` never blocks — `playwright-core`
 * is a dependency of the plugin, and the browser is looked up at render time, so
 * its state is a hint rather than a gate.
 */
export function assessDependencies(board: Storyboard, probe: DependencyProbe, only?: readonly string[]): DependencyAssessment {
  const manimSentences = board.segments
    .filter(segment => segment.engine === 'manim')
    .flatMap(segment => segment.sentences.map(sentence => sentence.id))
    // A narrowed render (`sentences: [...]`) that touches only slides must not be
    // refused for a missing Manim: it will not run a scene at all.
    .filter(id => only === undefined || only.includes(id))
  const needsManim = manimSentences.length > 0

  const entries: DependencyFinding[] = []
  const add = (name: keyof DependencyProbe, scope: DependencyScope, state: string): void => {
    const missing = isMissing(state)
    // Only a program this manuscript needs can block: a slides-only project is
    // not asked to install a Python, a TeX or dvisvgm.
    const blocking = missing && (scope === 'required' || (scope === 'manim' && needsManim))
    entries.push({
      name,
      scope,
      state,
      blocking,
      install: blocking ? (INSTALL[name] ?? null) : null,
    })
  }

  add('ffmpeg', 'required', probe.ffmpeg)
  add('ffprobe', 'required', probe.ffprobe)
  add('chromium', 'slides', probe.chromium)
  add('python3', 'manim', probe.python3)
  add('manim', 'manim', probe.manim)
  add('latex', 'manim', probe.latex)
  add('dvisvgm', 'manim', probe.dvisvgm)

  const blocking = entries.filter(entry => entry.blocking).map(entry => entry.name)

  const summary = needsManim
    ? `this manuscript needs Manim (${manimSentences.length} sentence(s): ${manimSentences.join(', ')})`
    : 'this manuscript needs no Manim: every segment is engine: slides, so a Python, a TeX and dvisvgm are not required'

  let refusal: string | null = null
  if (blocking.length > 0) {
    const lines = entries.filter(entry => entry.blocking).map(entry => `  - ${entry.name}: ${entry.install ?? 'install it'}`)
    const because = needsManim && blocking.some(name => ['python3', 'manim', 'latex', 'dvisvgm'].includes(name))
      ? `this manuscript has ${manimSentences.length} sentence(s) with engine: manim (${manimSentences.join(', ')}) and this machine is missing: ${blocking.join(', ')}`
      : `this machine is missing what any render needs: ${blocking.join(', ')}`
    refusal = [
      `cannot render: ${because}.`,
      'Two ways out:',
      ...lines,
      `  - or drop Manim from those sentences: set the segment to engine: slides and remove its scene entry. A slides-only manuscript needs nothing beyond ffmpeg and a Chromium.`,
      'Nothing was narrated or rendered.',
    ].join('\n')
  }

  return { needsManim, entries, blocking, refusal, summary }
}
