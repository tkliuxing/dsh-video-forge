/**
 * Cue mode's beat numbering, resolved against a deck's pages.
 *
 * Cue mode (a voice that reports word timings) numbers beats across the whole
 * deck, while `teachCue` numbers them inside the page it is on; page mode numbers
 * them per page already. Turning the first into the second needs the deck's
 * fragments per page, and two things need that answer: the recorder (which page
 * to be on when a beat fires) and the tail-transition planner (which page and how
 * many beats the *next* sentence opens on).
 *
 * It lives in its own module because the planner must not import the recorder:
 * `slides.ts` pulls in `playwright-core`, and `storyboard.ts` is loaded by every
 * offline test.
 */

/** Where one cue-mode fragment number lands on a multi-page deck. */
export interface CueLanding {
  /** reveal.js horizontal index of the page, 0-based. */
  page: number
  /** Beats lit inside that page, 1-based — what `teachCue` takes. */
  step: number
}

/** The only thing a landing needs from a cue: its number. */
export interface NumberedBeat {
  fragment: number
}

/**
 * Resolve cue-mode fragment numbers onto a deck's pages.
 *
 * Cue mode counts beats across the whole deck (one counter for the film, see
 * `video-teach-storyboard`), while `teachCue` counts inside the page it is on. With
 * one page those are the same number; with several they are not, and a number that
 * is never translated either lands on the wrong beat or is clamped at the first
 * page's last fragment, which is why a multi-page cue-mode deck used to record its
 * first page and nothing else. A number past the last fragment lands on the last
 * beat, matching the template's clamp.
 *
 * `null` when the deck exposes no pages at all (the deck builds its sections in
 * JavaScript): guessing the layout would be worse than keeping the old single-page
 * behaviour, and `video_teach_plan` already says the numbers went unchecked.
 */
export function cueLandings(pageFragments: readonly number[], cues: readonly NumberedBeat[]): CueLanding[] | null {
  if (pageFragments.length === 0) return null
  const total = pageFragments.reduce((sum, count) => sum + count, 0)
  // A deck with pages but no fragments has nothing for a beat to land on: staying
  // on page 0 is what the single-page recorder always did, and clamping to the last
  // page would record that page for the whole film.
  if (total === 0) return cues.map(() => ({ page: 0, step: 0 }))
  const land = (fragment: number): CueLanding => {
    const wanted = Math.max(1, Math.min(Math.round(fragment), total))
    let offset = 0
    for (const [page, count] of pageFragments.entries()) {
      if (count > 0 && wanted <= offset + count) return { page, step: wanted - offset }
      offset += count
    }
    // Past the end (or only empty pages left): the last page that carries a beat.
    for (let page = pageFragments.length - 1; page >= 0; page -= 1) {
      if ((pageFragments[page] ?? 0) > 0) return { page, step: pageFragments[page]! }
    }
    return { page: 0, step: 0 }
  }
  return cues.map(cue => land(cue.fragment))
}

/**
 * The state a cue-mode sentence opens in.
 *
 * Each sentence is its own `page.goto`, so the deck comes up empty and dark. Two
 * different pictures are wanted:
 *
 * - a sentence with cues opens **just before its first one** — on that cue's page,
 *   with the beats before it inside that page already lit. That is the picture the
 *   sentence is talking about, and it is what stops the first cue from re-popping
 *   every earlier beat.
 * - a sentence with no cue of its own opens on **the picture the story arrived at**:
 *   the page holding beat `shown` and that beat lit (`shown` comes from the
 *   manuscript, `cueStartFragments`, because this sentence cannot tell).
 *
 * `null` when the deck exposes no pages; `{ page: 0, step: 0 }` when nothing is shown
 * yet.
 */
export function cueOpening(pageFragments: readonly number[], cues: readonly NumberedBeat[], shown: number): CueLanding | null {
  if (pageFragments.length === 0) return null
  const first = cues[0]
  if (first !== undefined) {
    const landing = cueLandings(pageFragments, [first])?.[0]
    return landing === undefined ? null : { page: landing.page, step: Math.max(0, landing.step - 1) }
  }
  if (shown <= 0) return { page: 0, step: 0 }
  return cueLandings(pageFragments, [{ fragment: shown }])?.[0] ?? null
}

/**
 * The picture a cue-mode sentence's body ends on: the page its last beat landed
 * on, or the page it opened on when it fires no beat at all.
 *
 * A tail transition is only a *page turn* when this differs from where the next
 * sentence opens; otherwise the recorder would sit on one page for the tail and
 * call it a transition.
 */
export function cueEndPage(pageFragments: readonly number[], cues: readonly NumberedBeat[], shown: number): CueLanding | null {
  const last = cues[cues.length - 1]
  if (last !== undefined) return cueLandings(pageFragments, [last])?.[0] ?? null
  return cueOpening(pageFragments, [], shown)
}
