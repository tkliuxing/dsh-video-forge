/**
 * What this machine has, without deciding what that means.
 *
 * Kept apart from `tools.ts` so two callers can share one probe: the teaching
 * tools (which judge the result against a manuscript) and the settings overview
 * (which only wants to show the versions it found). Probing means spawning
 * `python -c "import manim"`, so it must not live behind a tool definition.
 *
 * Resolution order is the one the settings page promises: the plugin setting
 * first, then the legacy environment variable, then discovery. The setting has
 * to win — a GUI user cannot change the environment of a host that is already
 * running, which is exactly how a TeX missing from PATH became unfixable from
 * the settings page.
 */

import { access } from 'node:fs'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import type { DependencyProbe } from './rules.ts'
import { discoverTex } from './tex.ts'
import { teachSettings, type VideoForgeSettings } from '../settings.ts'

/** The teaching paths in effect: settings first, environment second. */
export interface TeachPaths {
  voiceAuthRef: string
  pythonPath: string | null
  texBinPath: string | null
  chromiumPath: string | null
}

/** Resolve the four teaching inputs from settings, falling back to the environment. */
export function teachPaths(settings: VideoForgeSettings): TeachPaths {
  const teach = teachSettings(settings)
  const pick = (configured: string, envName: string): string | null => {
    if (configured !== '') return configured
    const ambient = (process.env[envName] ?? '').trim()
    return ambient === '' ? null : ambient
  }
  return {
    voiceAuthRef: teach.voiceAuthRef,
    pythonPath: pick(teach.pythonPath, 'TEACH_PYTHON'),
    texBinPath: pick(teach.texBinPath, 'TEACH_TEXBIN'),
    chromiumPath: pick(teach.chromiumPath, 'TEACH_CHROMIUM'),
  }
}

/** Whether one program is on PATH and executable. */
export async function findExecutable(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    const ok = await new Promise<boolean>(resolve => {
      access(candidate, constants.X_OK, error => { resolve(error === null || error === undefined) })
    })
    if (ok) return candidate
  }
  return null
}

/**
 * Whether the interpreter can actually import Manim.
 *
 * A present `python3` says nothing about whether Manim is installed in it, and
 * the difference matters: `python3 not found` sends the operator to install an
 * interpreter, `manim not installed` sends them to `pip install manim` in the
 * interpreter they already have.
 */
export async function probeManim(python: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(python, ['-c', 'import manim; print(manim.__version__)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve('not installed') })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0 && out.trim() !== '') return resolve(`manim ${out.trim()}`)
      const why = err.trim().split('\n').filter(line => line.trim() !== '').slice(-1)[0]
      resolve(why === undefined ? 'not installed' : `not installed (${why})`)
    })
  })
}

/** Measure what this machine has for the teaching route. */
export async function probeDependencies(settings: VideoForgeSettings): Promise<DependencyProbe> {
  const paths = teachPaths(settings)
  const ffmpeg = await findExecutable('ffmpeg')
  const ffprobe = await findExecutable('ffprobe')
  const python = paths.pythonPath ?? await findExecutable('python3')
  const tex = await discoverTex(paths.texBinPath)
  return {
    ffmpeg: ffmpeg ?? 'missing',
    ffprobe: ffprobe ?? 'missing',
    chromium: paths.chromiumPath ?? 'playwright default lookup',
    python3: python ?? 'missing',
    manim: python === null ? 'not installed' : await probeManim(python),
    latex: tex.latex ?? 'missing',
    dvisvgm: tex.dvisvgm ?? 'missing',
  }
}
