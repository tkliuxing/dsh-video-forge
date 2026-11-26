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

import { DEFAULT_VOICE_PROVIDER, exitSlots, pageSlots, type ExitSlot, type Storyboard, type Segment } from './storyboard.ts'
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
 * Findings about a segment that shares one deck page across several sentences
 * (docs/TEACH-VIDEO.md §25, the contract in the `video-teach-storyboard` skill).
 *
 * Only page mode is driven by `page` / `enter`; the caller runs this in page mode
 * alone. Every check here is "the picture would not move as written", which is why
 * they are structural: each can be seen from the manuscript itself, before a single
 * character is narrated. The one page rule that needs no neighbour — an `enter`
 * with no `page` — is refused while parsing, where it has a line number.
 */
function pageFindings(segment: Segment): string[] {
  const findings: string[] = []
  const declared = segment.sentences.filter(sentence => sentence.page !== null).length
  // Half a map is ambiguous unless every declaration is the one harmless kind: a
  // sentence naming **its own** page so it can open pre-lit (`page: i` together with
  // `enter`). That declaration changes no mapping, so it stands alone. Everything
  // else — a page other than its own position, or a bare `page: i` that means
  // nothing — is either sharing or a likely mistake, and sharing is undecidable
  // while some sentences stay silent.
  const harmlessOnly = segment.sentences.every((sentence, index) => sentence.page === null || (sentence.page === index && sentence.enter !== null))
  if (declared > 0 && declared < segment.sentences.length && !harmlessOnly) {
    findings.push(
      `segment "${segment.id}" declares page on ${declared} of its ${segment.sentences.length} sentence(s), and at least one of those declarations either names a page other than the sentence's own position or comes without \`enter\`: which sentence shares a page with which`
      + ' is only decidable when the whole segment says so, because a page\'s enter state is inherited from the sentence before it. Declare page on every sentence of the segment — the one exception is a sentence opening its own page pre-lit, `page: <its position>` with `enter`',
    )
  }
  const slots = pageSlots(segment)
  segment.sentences.forEach((sentence, index) => {
    const slot = slots[index]!
    const before = index === 0 ? null : slots[index - 1]!
    const previous = index === 0 ? null : segment.sentences[index - 1]!.id
    if (before !== null && previous !== null) {
      if (slot.page < before.page) {
        findings.push(`sentence "${sentence.id}" is on page ${slot.page + 1} of segment "${segment.id}", after "${previous}" on page ${before.page + 1}: sentences are recorded in order, so a page number that goes backwards makes the picture run backwards`)
      }
    }
    const first = sentence.cues[0]
    const carries = before !== null && before.page === slot.page
    // What the sentence before this one left on its page. `enter` has to stay at or
    // above this (or the picture rewinds) and below the sentence's first cue (or that
    // cue lands on a beat that is already lit). A repair is only offered when it
    // satisfies both: pointing an author at a fix the next check refuses is worse
    // than saying nothing.
    const previousLit = carries ? before.lit : 0
    const rewinds = sentence.enter !== null && carries && sentence.enter < previousLit
    const cueCollides = first !== undefined && slot.enter >= first.fragment
    const who = previous ?? 'the sentence before it'
    if (rewinds) {
      const ceiling = first === undefined ? null : first.fragment - 1
      const fits = ceiling !== null && ceiling >= previousLit
      findings.push(`sentence "${sentence.id}" enters page ${slot.page + 1} with enter: ${sentence.enter}, but "${who}" left ${previousLit} beat${previousLit === 1 ? '' : 's'} of that page lit: the picture would go backwards at the sentence boundary. ${first === undefined
        ? `Leave enter out so it carries ${previousLit} over, or write at least ${previousLit}`
        : fits
          ? `Leave enter out (it then carries ${previousLit} over) or write anything from ${previousLit} to ${ceiling}; it has to stay below the first cue, fragment ${first.fragment}`
          : `Its first cue is fragment ${first.fragment}, which is not above ${previousLit} either, so no value of enter works: number the beats across the whole page (this cue must be at least ${previousLit + 1}) and leave enter out`}`)
      return
    }
    if (!cueCollides) return
    const lit = `${slot.enter} beat${slot.enter === 1 ? '' : 's'}`
    if (sentence.enter === null) {
      findings.push(`sentence "${sentence.id}" enters page ${slot.page + 1} with ${lit} of it already lit (what "${who}" left there) and its first cue is fragment ${first.fragment}, which is at or below that: the cue would not move the picture. Number the beats across the whole page, so the first cue is at least ${slot.enter + 1}`)
      return
    }
    // `enter` was written; another value may be legal, so name the whole window.
    findings.push(`sentence "${sentence.id}" enters page ${slot.page + 1} with enter: ${slot.enter} but its first cue is fragment ${first.fragment}: that beat is lit before the recording starts, so the cue changes nothing`
      + (previousLit < first.fragment
        ? `. Write enter in ${previousLit}..${first.fragment - 1} (at least what the sentence before it left lit, below the first cue), or number the cue above ${slot.enter}`
        : `. The sentence before it left ${previousLit} beat${previousLit === 1 ? '' : 's'} lit, so no enter value lets this cue fire: number the beats across the whole page, so the first cue is at least ${slot.enter + 1}`))
  })
  return findings
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

  // --- a declared tail transition needs a page to turn to -------------------
  // A transition is recorded by switching the deck's page inside the earlier
  // sentence's segment, so it lands on the state the *next* sentence opens in. In
  // cue mode that state is derived from the deck's own fragment counts at record
  // time, not from the manuscript, so `exitSlots` cannot name a target and the
  // manuscript would get hard cuts with no word about it (docs/TEACH-MOTION.md §7
  // rule 2). Kept a refusal rather than a warning for that reason.
  if (board.transition !== null && board.transition.mode === 'deck' && wordTimings && board.segments.some(segment => segment.engine === 'slides')) {
    structural.push(
      `meta.transition is set, but the voice "${board.voice?.provider ?? DEFAULT_VOICE_PROVIDER}" reports word timings, so the slides run in cue mode. `
      + 'A cue-mode sentence\'s page is worked out from its own beats and the deck\'s fragment counts when it is recorded, so the state a tail transition would have to land on is not knowable from the manuscript. '
      + 'Either set meta.transition.mode: none, or narrate with a provider that reports no word timings (page mode, the DeepSeek route)',
    )
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

  // --- sharing one deck page across several sentences ----------------------
  //
  // `page` / `enter` are the page-mode half of the picture contract (§25): page
  // mode is the only drive mode that switches pages per sentence, so in cue mode
  // the two keys are silently inert. Saying so is cheaper than an author
  // wondering why the manuscript's page numbers did nothing.
  const sharesPages = board.segments.some(segment => segment.sentences.some(sentence => sentence.page !== null))
  if (sharesPages && wordTimings) {
    warnings.push(`the manuscript declares page/enter, but voice "${board.voice?.provider ?? DEFAULT_VOICE_PROVIDER}" reports word timings: the deck is driven by cues, and the page a sentence starts on is worked out from its own beats, so page and enter do nothing here. They only apply when the voice reports no word timings (the default DeepSeek route)`)
  }
  if (!wordTimings) {
    for (const segment of board.segments) {
      if (segment.engine !== 'slides') continue
      structural.push(...pageFindings(segment))
    }
    // Shared pages move the one-picture-change rule: on its own page a sentence
    // without beats still changes the picture (the page switch), but on a shared
    // page it inherits the previous sentence's frame, so nothing moves for its
    // whole length. This is the old silence defect wearing a new shape.
    for (const segment of board.segments) {
      if (segment.engine !== 'slides') continue
      const slots = pageSlots(segment)
      segment.sentences.forEach((sentence, index) => {
        if (sentence.cues.length > 0) return
        const slot = slots[index]!
        const before = index === 0 ? null : slots[index - 1]!
        if (before === null || before.page !== slot.page) return
        // A written `enter` above what the previous sentence left lit is a hard cut
        // at t=0, which is a picture change even without a cue.
        if (slot.enter > before.lit) return
        silent.push(sentence.id)
        warnings.push(`sentence "${sentence.id}" shares page ${slot.page + 1} of segment "${segment.id}" with "${segment.sentences[index - 1]!.id}" and fires no beat: the picture does not change at all during this sentence. Give it a beat (they keep counting up across a shared page), or give it its own page`)
      })
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
  // Cue mode only: there a silent sentence is the surprising case, so two in a row
  // is worth its own line. In page mode the shared-page check above already names
  // each such sentence individually, and repeating it as a pair would report one
  // defect twice.
  if (wordTimings && silent.length >= 2) {
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
 * Counting `class="fragment"` in the markup matches what the cue contract means
 * (src/teach/slides.ts drives `Reveal.nextFragment()`), and it is the number the
 * author has to stay under. Only real markup counts: a script that builds
 * fragments, or a comment that shows one as an example, is not a fragment on
 * screen. A deck that builds its fragments in JavaScript is therefore not
 * counted, and an unreadable count is reported as `null` rather than as zero.
 */
export function countDeckFragments(html: string): number | null {
  const matches = markupOnly(html).match(/class\s*=\s*["'][^"']*\bfragment\b[^"']*["']/g)
  return matches === null ? null : matches.length
}

/**
 * What a deck says about itself, with the parts that are not markup removed.
 *
 * A deck is a document plus the JavaScript that drives it, and both talk about
 * `<section>`. Comments and script/style bodies are not pages, so splitting on
 * their text counts pages that do not exist: the shipped template's own script
 * comment used to make a one-page deck count as two, which turned the page checks
 * into a false "1 page(s) are never recorded" warning and a missed refusal for an
 * out-of-range `page` (found 2026-11-25 by review).
 */
function markupOnly(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
}

/**
 * Fragments counted inside each top-level `<section>`, in page order.
 *
 * Page mode starts the page a sentence names, and `teachCue(n)` counts fragments
 * on the *current* slide, so the number a beat may use is its own page's count,
 * not the deck's total. The split is on `<section …>` opening tags in the markup
 * only (see `markupOnly`), which is exact for the flat deck both templates
 * produce; a deck that nests sections (a vertical stack) is counted
 * approximately, so the caller reports a mismatch as a warning rather than
 * refusing.
 *
 * `null` means the deck has no `<section>` to split on at all (a deck built in
 * JavaScript), where guessing would be worse than staying quiet.
 */
export function deckPageFragments(html: string): number[] | null {
  const pieces = markupOnly(html).split(/<section\b[^>]*>/i)
  if (pieces.length < 2) return null
  return pieces.slice(1).map(piece => countDeckFragments(piece) ?? 0)
}

/**
 * Whether the deck nests `<section>` inside `<section>` (a vertical stack).
 *
 * Both counters work one level deep — the plan splits the markup on `<section>` tags,
 * the recorder queries `.slides > section` — so a stack makes them disagree: the plan
 * sees every nested page, the recorder sees the top-level ones. Telling the author is
 * the only honest option short of implementing stacks, which nothing here needs yet.
 */
export function nestedSections(html: string): boolean {
  return /<section\b[^>]*>(?:(?!<\/section\b)[\s\S])*?<section\b/i.test(markupOnly(html))
}

/**
 * The two visual languages counted per page (top-level `<section>`), in page order.
 *
 * `fragmentVariants` counts the deck, which is the wrong unit for this judgement:
 * two languages inside one page read as two films spliced together, while two pages
 * that each pick one language are a normal deck (a variant library is exactly that).
 * `null` when the deck has no `<section>` to split on, and the caller falls back to
 * the whole-deck count.
 */
export function pageVariants(html: string): { dim: number, plain: number }[] | null {
  const pieces = markupOnly(html).split(/<section\b[^>]*>/i)
  if (pieces.length < 2) return null
  return pieces.slice(1).map(piece => fragmentVariants(piece))
}

/**
 * Whether a deck swallows reveal's fragment transition (docs/TEACH-MOTION.md §3.1).
 *
 * `.reveal .fragment { transition: opacity 180ms }` has the same specificity as
 * reveal.css's own rule and loads later, so it wins and `fade-up`'s translation and
 * `grow`'s scale become instant jumps — with no error anywhere. The check reads the
 * `<style>` bodies, which is where such a rule can live; a deck that injects one
 * from JavaScript is not seen, and that limit is in the skill.
 */
export function overridesFragmentTransition(html: string): boolean {
  // Comments first: the shipped template's own CSS comment quotes
  // `` `.reveal .fragment` … `transition: all .2s` `` while explaining why not to
  // write that rule, and reading it as one is the same mistake `markupOnly` exists
  // to prevent for page markers (`countDeckFragments`).
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(match => (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n')
  // Rule by rule, because the offending selector is a *bare* `.fragment`: a rule
  // that names a variant (`.fragment.dim`, `.fragment.fade-up`, the template's own
  // dimmed language) is the author choosing a property for that variant and is
  // fine. `transition-duration` is not `transition` — the shipped template sets the
  // duration through `--teach-dur`, which is the recommended way (D0, §3.1).
  for (const match of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',')
    const body = match[2] ?? ''
    if (!/(^|;)\s*transition\s*:/.test(body)) continue
    const bare = selectors.some(selector => {
      const text = selector.trim()
      return /\.reveal\b/.test(text) && /\.fragment$/.test(text)
    })
    if (bare) return true
  }
  return false
}

/**
 * How a deck's fragment elements are styled, counted from the markup.
 *
 * The two languages that must not share a segment: `dim` (the whole page is shown
 * and the beat brightens it) and reveal's default fade (the beat appears from
 * nothing). One segment mixing them reads as two different films spliced together,
 * which is a warning and not a refusal — the author may mean it
 * (docs/TEACH-MOTION.md §7 rule 8).
 */
export function fragmentVariants(html: string): { dim: number, plain: number, custom: number } {
  const counts = { dim: 0, plain: 0, custom: 0 }
  for (const match of markupOnly(html).matchAll(/class\s*=\s*["']([^"']*)["']/g)) {
    const classes = (match[1] ?? '').split(/\s+/).filter(name => name !== '')
    if (!classes.includes('fragment')) continue
    if (classes.includes('dim')) counts.dim += 1
    else if (classes.includes('custom')) counts.custom += 1
    else counts.plain += 1
  }
  return counts
}

/** What a slides deck provides, as far as the manuscript is allowed to rely on it. */
export interface DeckInfo {
  /** The path the manuscript named, for messages. */
  path: string
  /** `class="fragment"` count over the whole deck, or null when the deck builds them in JavaScript. */
  fragments: number | null
  /** Fragments per top-level `<section>`, or null when the deck could not be split into pages. */
  pageFragments: number[] | null
  /**
   * `window.teachTransition` as the deck declares it, in ms, or null when it says
   * nothing. Only the plan uses it (D2, docs/TEACH-MOTION.md §5): the recorder
   * fires a beat and lets the CSS play, so it never needs the number.
   */
  transitionMs: number | null
  /**
   * `window.teachPageTransition` as the deck declares it, in ms, or null when it
   * says nothing. A tail transition shorter than this records the switch only part
   * way, which looks like "it slid halfway and cut" (docs/TEACH-MOTION.md §9).
   */
  pageTransitionMs: number | null
  /**
   * Whether the deck's own CSS overrides reveal's fragment transition wholesale
   * (`.reveal .fragment { transition: … }`). That rule has the same specificity as
   * reveal.css and loads later, so it wins and every variant's motion collapses
   * into a jump with no error at all (docs/TEACH-MOTION.md §3.1).
   */
  overridesFragmentTransition: boolean
  /** Fragment elements by visual language: dimmed-until-spoken, plain reveal fade, `custom`. */
  fragmentVariants: { dim: number, plain: number, custom: number }
  /** The same counts per page (top-level `<section>`), or null when the deck has none. */
  pageVariants: { dim: number, plain: number }[] | null
  /**
   * Whether the deck nests `<section>` inside `<section>` (a vertical stack).
   *
   * Both the plan's page counter and the recorder's count one level only, so a stack
   * is counted approximately: the plan sees every nested page, the recorder sees the
   * top-level ones. Said out loud because a cue-mode page drive needs them to agree.
   */
  nestedSections: boolean
  /** Whether the deck defines the recorder's three globals. */
  hasCue: boolean
  hasPage: boolean
  hasReady: boolean
}

/**
 * Where one sentence's beats land on its own clock.
 *
 * The transition check needs "how much room does this beat have before the next
 * beat, or before the cut", which is a question about milliseconds — and only the
 * plan's caller can answer it, because the answer depends on whether a narration
 * exists yet (docs/TEACH-MOTION.md §5).
 */
export interface BeatSchedule {
  /** The sentence's length: the denominator its cues were resolved against. */
  durationMs: number
  /** Each cue's moment in ms, in manuscript order; null when this route cannot say. */
  cueMs: readonly (number | null)[]
  /** True when {@link durationMs} is the characters-over-rate estimate, not a measured narration length. */
  estimated: boolean
}

export interface DeckAuditOptions {
  /** Where each sentence's beats land. Missing sentences are simply not checked. */
  beats?: ReadonlyMap<string, BeatSchedule>
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
export function auditDecks(board: Storyboard, decks: ReadonlyMap<string, DeckInfo>, options: DeckAuditOptions = {}): DeckAudit {
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
    // Cue mode numbers beats across the whole deck, and the "a cue must not run past
    // the deck" check needs that count. An unreadable count is said out loud rather
    // than skipped: silence reads as "checked and fine" (the same rule as `enter`
    // having no `page`).
    if (!pageMode && cues > 0 && info.fragments === null) {
      warnings.push(`${label} has ${cues} cue${cues === 1 ? '' : 's'}, but its fragment count could not be read (the deck builds them in JavaScript), so those numbers were not checked against the deck`)
    }
    // A shared page needs `teachCue` even without a single cue: the recorder
    // replays `enter` through it before the capture starts. Discovering that at
    // render time would be after the narration was paid for, so it is refused here.
    const entersLit = pageMode && pageSlots(segment).some(slot => slot.enter > 0)
    if ((cues > 0 || entersLit) && !info.hasCue) {
      structural.push(cues > 0
        ? `${label} fires ${cues} cue${cues === 1 ? '' : 's'} but does not define window.teachCue(index), so no beat can land; take the template's teachCue or drop the cues`
        : `${label} opens a page with beats already lit (enter), and the recorder replays that state through window.teachCue(index), which this deck does not define; take the template's teachCue, or drop enter so the page opens unlit`)
    }
    if (pageMode && !info.hasPage) {
      structural.push(`${label} does not define window.teachPage(n), which the page mode needs: voice "${provider}" reports no word timings, so the picture advances one page per sentence (or one page shared by several, when the manuscript says page). Add the page-mode globals from assets/teach/deck/index.html (one <section> per page), or narrate with volcengine for cue-driven fragments`)
    }
    // The two D0 pitfalls, visible from the deck's own HTML. They belong here and
    // not with the seam findings: a deck without `meta.transition` has no seam, but
    // it still loses every variant's motion to a wholesale override (D0) and still
    // reads as two films when it mixes the two visual languages (rule 8).
    if (info.overridesFragmentTransition) {
      warnings.push(`${info.path} overrides reveal's fragment transition inside its own <style> (a rule like .reveal .fragment { transition: … }). It has the same specificity as reveal.css and loads later, so it wins: every variant's motion collapses into a jump and nothing reports it. Remove the rule and set --teach-dur on the section instead`)
    }
    const perPage = info.pageVariants ?? [{ dim: info.fragmentVariants.dim, plain: info.fragmentVariants.plain }]
    const mixed = perPage.flatMap((variants, page) => (variants.dim > 0 && variants.plain > 0 ? [page + 1] : []))
    if (mixed.length > 0) {
      const pages = mixed.map(page => `page ${page}`).join(', ')
      warnings.push(`${label} mixes dimmed and plain reveal-fade fragments on ${pages}: dimmed elements are already on screen and plain ones appear from nothing, so on one page it reads as two films. Pick one language for that page`)
    }
    if (info.nestedSections) {
      warnings.push(`${label} nests <section> inside <section> (a vertical stack). Page numbers are counted one level deep by both the plan and the recorder, so a stack is counted approximately; a cue-mode page drive and a declared \`page\` are both worth checking by hand on this deck`)
    }
    // Cue mode numbers beats across the whole deck, so a deck with several pages
    // needs the recorder to turn them; without `teachPage` that only fails once the
    // narration has been paid for (src/teach/slides.ts).
    if (!pageMode && info.pageFragments !== null && info.pageFragments.length > 1 && !info.hasPage) {
      structural.push(`${label} has ${info.pageFragments.length} pages, which cue mode drives from the beats themselves, but it does not define window.teachPage(n): the recorder turns the page at a cue that lands on the next one. Take the template's teachPage and teachCue, or keep this deck to a single <section>`)
    }
    // A page with no fragment can never be reached by a cue-mode number: the counter
    // walks pages that have one. Left unsaid, that page silently never appears.
    if (!pageMode && info.pageFragments !== null && cues > 0) {
      const empty = info.pageFragments.flatMap((count, page) => (count === 0 ? [page + 1] : []))
      if (empty.length > 0) {
        warnings.push(`${label} has ${empty.length} page${empty.length === 1 ? '' : 's'} with no fragment (${empty.map(page => `page ${page}`).join(', ')}): cue-mode beats are numbered by walking pages that carry one, so those pages are never recorded. Give them a fragment, or drop them from the deck`)
      }
    }
    // Cue mode needs the per-page counts at record time to turn pages. When the deck
    // builds its pages in JavaScript the plan cannot see them, and the recorder may
    // find more pages than this check could judge.
    if (!pageMode && info.pageFragments === null && cues > 0) {
      warnings.push(`${label} mixes cue-mode beats with a deck whose pages could not be counted (it builds its <section>s in JavaScript, or has none): whether those beats need window.teachPage(n) was not checked here, and if the deck turns out to have several pages at record time it will be refused then`)
    }
    if (pageMode && info.pageFragments === null && segment.sentences.some(sentence => sentence.page !== null)) {
      // Unknown is not "fine": a deck the counter cannot split into pages (built in
      // JavaScript, or with no `section` at all) leaves every declared page number
      // unchecked, and that is worth one sentence rather than silence.
      warnings.push(`${label} declares page numbers in the manuscript, but its pages could not be counted (the deck builds its sections in JavaScript, or has no <section> for the counter to split on), so those numbers were not checked against the deck`)
    }
    if (!pageMode || info.pageFragments === null) continue

    // Which page each sentence actually lands on. A manuscript that never says
    // `page` maps sentences to pages one to one, which is exactly what `pageSlots`
    // returns for it, so both shapes go through the same checks (§25.6).
    const pages = info.pageFragments.length
    const slots = pageSlots(segment)
    // "Sharing" means a sentence sits on a page that is not its own position. Then the
    // manuscript, not the sentence order, decides which page is recorded, and a page
    // that does not exist is refused. A sentence naming its own page pre-lit changes no
    // mapping, so it keeps the older behaviour below.
    const sharing = segment.sentences.some((sentence, index) => sentence.page !== null && sentence.page !== index)
    const used = slots.reduce((highest, slot) => Math.max(highest, slot.page + 1), 0)
    // A shared page the deck does not have is a page that never shows: the manuscript
    // is refused. Without `page` the mapping is sentence index to page index, which is
    // the older behaviour and only a warning — the template's teachPage clamps, so the
    // sentence holds the last page instead of failing.
    const overrun = sharing ? slots.findIndex(slot => slot.page >= pages) : -1
    if (overrun >= 0) {
      structural.push(`${label} has ${pages} page${pages === 1 ? '' : 's'}, but the manuscript puts sentence "${segment.sentences[overrun]!.id}" on page ${slots[overrun]!.page + 1}. Page mode starts the page a sentence names, so that sentence would hold whatever page the recorder was left on`)
    } else if (sharing && used < pages) {
      warnings.push(`${label} has ${pages} page${pages === 1 ? '' : 's'} but the manuscript only uses ${used}: ${pages - used} page(s) are never recorded. Either drop them from the deck or give the sentences a page that reaches them`)
    } else if (!sharing && pages < segment.sentences.length) {
      const unreached = segment.sentences.slice(pages).map(sentence => `"${sentence.id}"`)
      warnings.push(`${label} has ${pages} page${pages === 1 ? '' : 's'} but the segment has ${segment.sentences.length} sentence(s); page mode starts one page per sentence, so ${unreached.join(', ')} will hold the last page. Give each sentence its own <section>, or share a page by declaring page in the manuscript`)
    }
    segment.sentences.forEach((sentence, index) => {
      const page = slots[index]?.page ?? index
      const available = info.pageFragments?.[page]
      if (available === undefined) return
      // `enter` is a claim about how much of that page is lit, so it is bounded by
      // the page like a cue is. Handing the deck a number past its last fragment
      // opens the page fully revealed, which is a state nobody asked for.
      if (slots[index] !== undefined && slots[index]!.enter > available) {
        warnings.push(`sentence "${sentence.id}" enters page ${page + 1} of ${info.path} with ${slots[index]!.enter} beat${slots[index]!.enter === 1 ? '' : 's'} already lit, but that page has ${available} fragment${available === 1 ? '' : 's'}: the deck clamps at the page end, so the page opens fully revealed`)
      }
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

  warnings.push(...transitionFindings(board, decks, options))
  warnings.push(...seamFindings(board, decks, exitSlots(board, pageMode ? 'page' : 'cue'), options))
  return { structural, warnings }
}

/**
 * Beats whose own motion cannot finish before the next beat or the cut (D2,
 * docs/TEACH-MOTION.md §5).
 *
 * A deck may declare `window.teachTransition`, and only it knows: the number is a
 * property of the visuals, not of the manuscript. Nothing is checked when it stays
 * silent, which is why this cannot refuse — a deck without a declaration records
 * exactly as it did before this rule existed.
 *
 * Why it is a warning rather than a refusal: overlapping beats are a legitimate
 * look (the next item starts moving while the previous one settles). What is not
 * legitimate is a motion still running at the cut, so the message names which of
 * the two situations this is and what to change.
 *
 * The clock is the measured narration when there is one and the characters-over-
 * rate estimate otherwise — and when it is the estimate, the finding says so,
 * because a warning built on a guess must not read like a measurement.
 */
function transitionFindings(board: Storyboard, decks: ReadonlyMap<string, DeckInfo>, options: DeckAuditOptions): string[] {
  const findings: string[] = []
  for (const segment of board.segments) {
    if (segment.engine !== 'slides') continue
    const info = decks.get(segment.id)
    const transition = info?.transitionMs ?? null
    if (info === undefined || transition === null) continue
    for (const sentence of segment.sentences) {
      const schedule = options.beats?.get(sentence.id)
      if (schedule === undefined || sentence.cues.length === 0) continue
      sentence.cues.forEach((cue, index) => {
        const at = schedule.cueMs[index] ?? null
        if (at === null) return
        // The next beat, not the next *known* beat: a null in between means this
        // route cannot place it, and guessing would make the finding unverifiable.
        const following = schedule.cueMs.slice(index + 1)
        const offset = following.findIndex(value => value !== null)
        const next = offset === -1 ? null : following[offset]!
        const room = (next ?? schedule.durationMs) - at
        if (room >= transition) return
        const nextCue = offset === -1 ? null : sentence.cues[index + 1 + offset]
        const clock = schedule.estimated
          ? ` (that length is the estimate from its ${sentence.say.length} characters; video_teach_narrate gives the measured clock)`
          : ''
        findings.push(next === null
          ? `sentence "${sentence.id}" fires fragment ${cue.fragment} at ${at} ms and the sentence ends ${room} ms later, but ${info.path} declares a ${transition} ms transition (window.teachTransition): its motion will still be running when the segment is cut. Fire the last beat earlier, or declare a shorter transition${clock}`
          : `sentence "${sentence.id}" fires fragment ${cue.fragment} at ${at} ms and fragment ${nextCue?.fragment ?? '?'} follows ${room} ms later, but ${info.path} declares a ${transition} ms transition (window.teachTransition): the motion will still be running when the next beat starts. Space the beats further apart, or declare a shorter transition — overlapping is sometimes deliberate, so this is a warning${clock}`)
      })
    }
  }
  return findings
}

/**
 * What the plan can say about the seams (docs/TEACH-MOTION.md §6, §7).
 *
 * Every finding here is about a seam the author *did* ask to soften and did not
 * get, or a duration that cannot finish inside the room it was given. The
 * "everything is a hard cut" case is silent, because that is what a manuscript
 * without `meta.transition` asks for.
 */
function seamFindings(
  board: Storyboard,
  decks: ReadonlyMap<string, DeckInfo>,
  exits: ReadonlyMap<string, ExitSlot>,
  options: DeckAuditOptions,
): string[] {
  const findings: string[] = []
  const spec = board.transition
  if (spec === null || spec.mode !== 'deck') return findings
  const segments = board.segments
  segments.forEach((segment, segmentIndex) => {
    const info = decks.get(segment.id)
    const label = info === undefined ? `segment "${segment.id}"` : `segment "${segment.id}" (${info.path})`
    if (segment.engine !== 'slides') {
      findings.push(`${label} is engine manim, so meta.transition (${spec.durationMs} ms) does not apply to it: a Python scene has its own timeline and no page state to turn from. Its seams stay hard cuts`)
      return
    }
    // Rule 9, not in the D3 table but the risk §9 names: a tail transition shorter
    // than the deck's own page switch records the switch only part way, which reads
    // as "it slid halfway and cut".
    const declared = info?.pageTransitionMs ?? null
    if (declared !== null && spec.durationMs < declared) {
      findings.push(`meta.transition.durationMs is ${spec.durationMs}, but ${info!.path} declares window.teachPageTransition = ${declared}: the page switch will be recorded only ${spec.durationMs} ms in, so the seam cuts mid-transition. Raise it to at least ${declared}, or lower the deck's own transition`)
    }
    segment.sentences.forEach((sentence, index) => {
      const exit = exits.get(sentence.id)
      if (exit === undefined) return
      const next = segment.sentences[index + 1]
      if (exit.dropped === 'same-page' && next !== undefined) {
        findings.push(`sentence "${sentence.id}" ends on the same page as "${next.id}" (both page ${pageSlots(segment)[index]!.page + 1}), so the seam stays a hard cut: there is no page to turn. That is right if the two sentences are meant to share the page — otherwise give "${next.id}" its own page`)
        return
      }
      if (exit.exitMs === 0 || exit.target === null) return
      const schedule = options.beats?.get(next?.id ?? '')
      if (next !== undefined && schedule !== undefined && exit.exitMs > schedule.durationMs) {
        const clock = schedule.estimated ? ' (that length is the estimate from its characters)' : ''
        findings.push(`sentence "${sentence.id}" carries a ${exit.exitMs} ms tail transition, but the sentence after it ("${next.id}") is only ${schedule.durationMs} ms long${clock}: the transition is longer than the line it leads into, so it reads as a pause rather than a move`)
      }
    })
    const last = segment.sentences[segment.sentences.length - 1]
    if (segmentIndex < segments.length - 1 && last !== undefined && exits.get(last.id)?.dropped === 'segment-end') {
      findings.push(`${label} ends with a hard cut after "${last.id}": a tail transition cannot reach the next segment's picture, which is another document. Record the act as one deck if that seam should turn (docs/TEACH-PARALLEL-ACTS.md §7 keeps the seam acceptance)`);
    }
  })
  return findings
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
export type DependencyScope = 'required' | 'slides' | 'subtitles' | 'manim'

/** The raw probe result; the caller owns how each line was obtained. */
export interface DependencyProbe {
  ffmpeg: string
  ffprobe: string
  /**
   * Whether the ffmpeg above carries the `subtitles` filter, i.e. was built with
   * libass.
   *
   * A plain `ffmpeg` on PATH may not: Homebrew's current formula ships without
   * libass and without `drawtext`, so burning fails with "No such filter"
   * (measured 2026-11-25). Never blocking — the picture renders either way, and
   * refusing here would waste narration that was already paid for.
   */
  subtitles: string
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
  subtitles: 'this ffmpeg was built without libass, so the picture is assembled with no burned-in lines and only the external SRT exists. Get a build that has libass (macOS: `brew install ffmpeg-full`, then point the plugin\'s ffmpeg directory setting at /opt/homebrew/opt/ffmpeg-full/bin; Debian: `apt install ffmpeg` already has it) and re-run video_teach_render. Nothing is re-narrated or re-recorded: the segments on disk are reused',
  python3: 'install a Python 3.10+ and put Manim in it: `python3 -m venv ~/.local/venvs/teach-video && ~/.local/venvs/teach-video/bin/pip install manim`, then point TEACH_PYTHON at that interpreter',
  manim: 'install Manim into the interpreter this host uses: `pip install manim` (or set TEACH_PYTHON to a Python that already has it)',
  latex: 'install a TeX (macOS: `brew install --cask basictex`, or TinyTeX) and put its bin on TEACH_TEXBIN',
  dvisvgm: 'BasicTeX ships `latex` but NOT `dvisvgm`, so a basictex-only install fails with "latex error converting to dvi". Use TinyTeX (`curl -sL https://yihui.org/tinytex/install-bin-unix.sh | sh`, binaries in ~/Library/TinyTeX/bin/universal-darwin) or `tlmgr install dvisvgm` on a writable TeX, then point TEACH_TEXBIN at that bin directory',
}

/**
 * What to install for one finding.
 *
 * Exported because a non-blocking absence still deserves its hint: a build
 * without libass does not stop the render, it silently costs the burned-in
 * lines, and the plan says so with the same wording a refusal would use.
 */
export function installHint(name: string): string | null {
  return INSTALL[name] ?? null
}

const MISSING = new Set(['missing', 'not installed'])

/** Whether one probed state reads as absent. */
export function isMissing(state: string): boolean {
  const text = state.trim()
  // `not installed (No module named manim)` carries the reason in parentheses, so
  // the test is a prefix rather than a word split. `missing (no ffmpeg in …)`
  // does the same for a path the operator configured and got wrong.
  return MISSING.has(text) || text.startsWith('not installed') || text.startsWith('missing ')
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
  add('subtitles', 'subtitles', probe.subtitles)
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
