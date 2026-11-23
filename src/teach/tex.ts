/**
 * Finding the two TeX programs Manim shells out to.
 *
 * This lives outside `manim.ts` so a caller that only wants to *report* the TeX
 * state (`video_teach_plan`) does not drag the whole Manim runner into its
 * chunk: `manim.ts` is loaded lazily by the pipeline, and a static import of it
 * from the tools would defeat that split.
 *
 * Manim needs both programs, and on macOS they are routinely split across two
 * installs: BasicTeX (`/Library/TeX/texbin`) ships `latex` but no `dvisvgm`,
 * TinyTeX ships both. A missing `dvisvgm` surfaces mid-render as
 * `latex error converting to dvi`, which is why discovery checks each binary
 * separately and builds a shim directory when they come from different places.
 */

import { access, mkdir, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** What TeX discovery found, and what it could not. */
export interface TexDiscovery {
  /**
   * Directories to prepend to PATH, in order. Empty when nothing was found.
   * Usually one directory; two when `latex` and `dvisvgm` live in different
   * installs (BasicTeX ships no `dvisvgm`, TinyTeX ships both).
   */
  pathPrefixes: string[]
  /** Absolute path of `latex`, when one was found. */
  latex: string | null
  /** Absolute path of `dvisvgm`, when one was found. */
  dvisvgm: string | null
  /** A sentence naming what is missing, or null when both were found. */
  problem: string | null
}

/**
 * Where a TeX installation may put its binaries, most specific first.
 *
 * The plugin setting wins over the environment (DESIGN §23): the settings page is
 * the only place a GUI user can reach, and an environment variable set when the
 * host started cannot be corrected from inside the running process.
 */
export function texCandidateDirs(configured?: string | null): string[] {
  const dirs: string[] = []
  const fromSetting = (configured ?? '').trim()
  if (fromSetting !== '') dirs.push(fromSetting)
  const explicit = (process.env.TEACH_TEXBIN ?? '').trim()
  if (explicit !== '') dirs.push(explicit)
  // BasicTeX on macOS: `latex` only, no `dvisvgm`.
  dirs.push('/Library/TeX/texbin')
  // TinyTeX: both, user-writable, and what the teaching route is tested against.
  dirs.push(join(homedir(), 'Library/TinyTeX/bin/universal-darwin'))
  dirs.push(join(homedir(), '.TinyTeX/bin/universal-darwin'))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir !== '') dirs.push(dir)
  return [...new Set(dirs)]
}

/** Whether `dir/name` exists and is executable. */
export async function executableAt(dir: string, name: string): Promise<string | null> {
  const candidate = join(dir, name)
  try {
    await access(candidate, constants.X_OK)
    return candidate
  } catch {
    return null
  }
}

/**
 * Find `latex` and `dvisvgm`.
 *
 * Manim shells out to both, so a TeX install with only one of them fails
 * mid-render. This looks for each binary separately across the known macOS
 * installs and PATH, and when they come from different installs it builds a
 * shim directory that carries both.
 */
export async function discoverTex(configured?: string | null): Promise<TexDiscovery> {
  const dirs = texCandidateDirs(configured)
  let latex: string | null = null
  let dvisvgm: string | null = null
  let latexDir: string | null = null
  let dvisvgmDir: string | null = null
  for (const dir of dirs) {
    if (latex === null) {
      const found = await executableAt(dir, 'latex')
      if (found !== null) { latex = found; latexDir = dir }
    }
    if (dvisvgm === null) {
      const found = await executableAt(dir, 'dvisvgm')
      if (found !== null) { dvisvgm = found; dvisvgmDir = dir }
    }
    if (latex !== null && dvisvgm !== null && latexDir === dvisvgmDir) {
      return { pathPrefixes: [latexDir!], latex, dvisvgm, problem: null }
    }
  }
  if (latex !== null && dvisvgm !== null) {
    // Split install: put both on PATH through one shim directory.
    const shim = join(tmpdir(), 'dsh-teach-tex-shim')
    await mkdir(shim, { recursive: true })
    await symlink(latex, join(shim, 'latex')).catch(() => undefined)
    await symlink(dvisvgm, join(shim, 'dvisvgm')).catch(() => undefined)
    return { pathPrefixes: [shim], latex, dvisvgm, problem: null }
  }
  const missing = [latex === null ? 'latex' : null, dvisvgm === null ? 'dvisvgm' : null].filter((name): name is string => name !== null)
  return {
    pathPrefixes: [],
    latex,
    dvisvgm,
    problem: `TeX is incomplete for Manim: ${missing.join(' and ')} not found. Manim needs both (latex builds the DVI, dvisvgm turns it into SVG). Install TinyTeX (it ships both) or point TEACH_TEXBIN at a TeX bin directory that has them.`,
  }
}

