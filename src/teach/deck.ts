/**
 * Scaffolding a slide deck a person can edit.
 *
 * A teaching project's slide segment is a reveal.js document plus three small
 * files. Shipping those files inside the package (they are vendored under
 * `assets/teach/deck/`, MIT, licence kept beside them) is what lets a project be
 * opened, edited and re-recorded without a network fetch or a Node install in
 * the deck folder.
 *
 * The deck's contract with the recorder is two globals — `teachCue(index)` and
 * `teachReady` — and nothing else (src/teach/slides.ts). A deck written by a
 * person that defines those two works exactly like the scaffolded one.
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The packaged deck assets: reveal.js, its stylesheet, the theme, the template.
 *
 * Resolved by walking up to the package root rather than by a fixed `../`,
 * because the same file is `src/teach/deck.ts` in tests and folded into
 * `lib/index.js` by the bundler. The walk finds `assets/teach/deck` from either.
 */
export const DECK_ASSETS = findAssetDirectory(fileURLToPath(import.meta.url), 'teach/deck')

/** Nearest ancestor of `fromFile` that carries `assets/<sub>`; falls back to the sibling layout. */
export function findAssetDirectory(fromFile: string, sub: string): string {
  let dir = dirname(fromFile)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'assets', sub)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return join(dirname(fromFile), '..', 'assets', sub)
}

/** Files copied beside every scaffolded deck, in the order they are listed. */
const DECK_FILES = ['reveal.js', 'reveal.css', 'theme.css', 'LICENSE'] as const

export interface DeckScaffoldOptions {
  /** Deck title, also the page title. */
  title: string
  /**
   * The `<section>` elements that make up the deck, as reveal.js expects them.
   * Kept as text so a scaffold can be built from a storyboard or typed by hand.
   */
  slides: string
}

/** A deck directory that cannot be written. */
export class DeckScaffoldError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'DeckScaffoldError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** Whether a deck already exists at `dir` (its entry file present). */
export async function deckExists(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, 'index.html'))
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * Write a runnable reveal.js deck into `dir`.
 *
 * The vendored files are copied rather than linked so the project stays
 * self-contained: moving the folder must not break the recording, and a deck is
 * edited far more often than it is re-scaffolded. Existing files are overwritten
 * only when `overwrite` is set, because a deck is a manuscript — losing hand
 * edits to a re-scaffold would be the worst failure mode this module has.
 */
export async function writeDeck(dir: string, options: DeckScaffoldOptions, overwrite = false): Promise<string> {
  const entry = join(dir, 'index.html')
  if (!overwrite && await deckExists(dir)) {
    throw new DeckScaffoldError(`${entry} already exists; pass overwrite to replace a hand-edited deck`)
  }
  try {
    await mkdir(dir, { recursive: true })
    for (const file of DECK_FILES) await copyFile(join(DECK_ASSETS, file), join(dir, file))
    const template = await readFile(join(DECK_ASSETS, 'index.html'), 'utf8')
    const page = template
      .replaceAll('{{TITLE}}', escapeHtml(options.title))
      .replace('{{SLIDES}}', options.slides)
    await writeFile(entry, page, 'utf8')
    return entry
  } catch (error: unknown) {
    if (error instanceof DeckScaffoldError) throw error
    throw new DeckScaffoldError(`could not scaffold a deck in ${dir} (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
}

/** Minimal HTML escaping: the title lands in a document, not in markup. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
