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
import { isMissing } from './rules.ts'
import { probeFilter, type MediaTools } from './ffmpeg.ts'
import { discoverTex } from './tex.ts'
import { DEFAULT_VOICE_AUTH_REFS, DEFAULT_VOICE_AUTH_REF, teachSettings, type TeachSettings, type VideoForgeSettings } from '../settings.ts'

/** The teaching paths in effect: settings first, environment second. */
export interface TeachPaths {
  /** The credential reference each voice provider resolves; one name per provider, never a key. */
  voiceAuthRefs: { deepseek: string, volcengine: string }
  /** Directory holding ffmpeg and ffprobe; null means a PATH lookup. */
  ffmpegBinPath: string | null
  pythonPath: string | null
  texBinPath: string | null
  chromiumPath: string | null
}

/**
 * The credential reference a voice provider uses.
 *
 * Each provider has its own name, because a key stored for one product is not a
 * key for the other: DeepSeek answers `DEEPSEEK_API_KEY` as a bearer token,
 * volcengine answers the speech-only `ARK_VOICE_API_KEY` as `X-Api-Key`. The
 * setting for the provider wins when it names something; otherwise the provider's
 * own default applies. An unknown provider gets the voice reference this build
 * has always used, and will fail at narration with that name in the message.
 */
export function voiceAuthRefFor(teach: TeachSettings, provider: string): string {
  const configured = provider === 'deepseek'
    ? teach.voiceAuthRefDeepseek
    : provider === 'volcengine' ? teach.voiceAuthRefVolcengine : ''
  const fallback = DEFAULT_VOICE_AUTH_REFS[provider] ?? DEFAULT_VOICE_AUTH_REF
  const trimmed = configured.trim()
  return trimmed === '' ? fallback : trimmed
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
    voiceAuthRefs: {
      deepseek: voiceAuthRefFor(teach, 'deepseek'),
      volcengine: voiceAuthRefFor(teach, 'volcengine'),
    },
    ffmpegBinPath: pick(teach.ffmpegBinPath, 'TEACH_FFMPEG_BIN'),
    pythonPath: pick(teach.pythonPath, 'TEACH_PYTHON'),
    texBinPath: pick(teach.texBinPath, 'TEACH_TEXBIN'),
    chromiumPath: pick(teach.chromiumPath, 'TEACH_CHROMIUM'),
  }
}

/**
 * The programs the media half of the pipeline runs, resolved the way every other
 * path is resolved: the setting first, then the environment, then PATH.
 *
 * One place builds this so `ffmpeg` is the *same* binary everywhere — the one
 * that gets probed for libass is the one that burns the subtitles. A pipeline
 * that probed PATH's ffmpeg and then encoded with another build would report a
 * capability it does not have.
 */
export function mediaTools(paths: TeachPaths): MediaTools {
  const inside = (name: string): string | undefined => (paths.ffmpegBinPath === null ? undefined : join(paths.ffmpegBinPath, name))
  const ffmpegPath = inside('ffmpeg')
  const ffprobePath = inside('ffprobe')
  return {
    ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
    ...(ffprobePath === undefined ? {} : { ffprobePath }),
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

/**
 * Where one media program is, as a state string the dependency report can show.
 *
 * A configured directory that does not hold the program is reported with the
 * directory named: "missing" alone would send the operator looking at PATH after
 * they had explicitly pointed the setting somewhere else.
 */
async function locateProgram(name: string, binPath: string | null): Promise<string> {
  if (binPath === null) return (await findExecutable(name)) ?? 'missing'
  const candidate = join(binPath, name)
  return (await isExecutable(candidate)) ? candidate : `missing (no ${name} in ${binPath})`
}

/** Whether one exact path is executable. */
export async function isExecutable(path: string): Promise<boolean> {
  return new Promise(resolve => {
    access(path, constants.X_OK, error => { resolve(error === null || error === undefined) })
  })
}

/** Measure what this machine has for the teaching route. */
export async function probeDependencies(settings: VideoForgeSettings): Promise<DependencyProbe> {
  const paths = teachPaths(settings)
  const ffmpeg = await locateProgram('ffmpeg', paths.ffmpegBinPath)
  const ffprobe = await locateProgram('ffprobe', paths.ffmpegBinPath)
  const python = paths.pythonPath ?? await findExecutable('python3')
  const tex = await discoverTex(paths.texBinPath)
  const media = mediaTools(paths)
  return {
    ffmpeg,
    ffprobe,
    // Burning subtitles is the one capability a plain `ffmpeg` on PATH may lack:
    // Homebrew's slim formula ships without libass, so the `subtitles` filter is
    // absent and the filter graph fails at assemble time (measured 2026-11-25).
    subtitles: isMissing(ffmpeg) ? 'unknown (no ffmpeg)' : await probeFilter(media, 'subtitles'),
    chromium: paths.chromiumPath ?? 'playwright default lookup',
    python3: python ?? 'missing',
    manim: python === null ? 'not installed' : await probeManim(python),
    latex: tex.latex ?? 'missing',
    dvisvgm: tex.dvisvgm ?? 'missing',
  }
}
