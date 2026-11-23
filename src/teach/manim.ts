/**
 * The animation half of the picture: run one Manim scene and cut it to the
 * length the narration actually took (docs/TEACH-VIDEO.md §4).
 *
 * Manim is the opposite problem from a slide deck. A deck paints on demand, so
 * the recorder decides when pictures change; a Manim scene declares its own
 * durations and then plays them at its own pace. The scene is therefore *not*
 * trusted to match the audio: whatever it renders is re-timed to the sentence's
 * real duration, and a scene that comes out longer than its line is reported
 * rather than silently cropped mid-animation.
 *
 * One sentence, one scene file, one class. That is what keeps re-recording a
 * line cheap, and it is why the class name is discovered from the file instead
 * of configured: two scene classes in one file is a manuscript mistake, not a
 * feature.
 */

import { access, mkdir, readFile, readdir, symlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import { encodeCfrSegment, probe, type MediaTools } from './ffmpeg.ts'
import { discoverTex, type TexDiscovery } from './tex.ts'

export { discoverTex, type TexDiscovery } from './tex.ts'
import type { TimedSentence } from './storyboard.ts'

/** Where the interpreter and the TeX binaries live, for hosts that keep them off PATH. */
export interface ManimTools {
  /** Python with Manim installed; defaults to `python3`. */
  pythonPath?: string
  /** Directory holding `latex` and `dvisvgm`; prepended to PATH when given. */
  texBinPath?: string
  /**
   * Skip discovery and require both `latex` and `dvisvgm` on `PATH` as it is.
   * Discovery is the default because a TeX install with only one of the two
   * fails mid-render with `latex error converting to dvi`.
   */
  trustPath?: boolean
  /** Quality preset flag; `-r <w>,<h> --fps` overrides the preset anyway. */
  extraArgs?: readonly string[]
}

export interface ManimSegmentOptions {
  /** Absolute path of the scene's `.py` file. */
  scene: string
  /** Directory for the render's intermediate files; created if missing. */
  workDir: string
  timed: TimedSentence
  video: { width: number, height: number, fps: number }
  tools?: MediaTools & ManimTools
  signal?: AbortSignal
}

/** A scene file this build will not run. */
export class ManimError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'ManimError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/** The single `Scene` subclass in a file, which is the scene this build renders. */
export function sceneClassName(source: string): string | null {
  const names = [...source.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((?:[^)]*\b(?:Scene|MovingCameraScene|ThreeDScene)\b[^)]*)\)\s*:/gm)].map(match => match[1]!)
  return names[0] ?? null
}

/**
 * Which directories to put in front of PATH for this render.
 *
 * An explicit `texBinPath` wins; otherwise discovery runs and a missing half is
 * a {@link ManimError} up front rather than a LaTeX failure forty seconds in.
 */
async function resolveTexPrefixes(tools: (MediaTools & ManimTools) | undefined): Promise<string[]> {
  if (tools?.trustPath === true) return []
  const tex = await discoverTex()
  if (tex.problem !== null) throw new ManimError(tex.problem)
  return tex.pathPrefixes
}

/** Run manim for one scene and return the file it wrote. */
async function renderScene(options: ManimSegmentOptions, sceneName: string, mediaDir: string): Promise<string> {
  const python = options.tools?.pythonPath ?? 'python3'
  const env = { ...process.env }
  const prefixes = options.tools?.texBinPath !== undefined
    ? [options.tools.texBinPath]
    : await resolveTexPrefixes(options.tools)
  if (prefixes.length > 0) env.PATH = [...prefixes, env.PATH ?? ''].join(delimiter)
  const args = [
    '-m', 'manim', 'render',
    options.scene,
    sceneName,
    '--media_dir', mediaDir,
    '-r', `${options.video.width},${options.video.height}`,
    '--fps', String(options.video.fps),
    '--disable_caching',
    '--format', 'mp4',
    '-o', 'scene.mp4',
    ...(options.tools?.extraArgs ?? []),
  ]
  await new Promise<void>((resolve, reject) => {
    let stderr = ''
    const child = spawn(python, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    const abort = () => child.kill('SIGKILL')
    options.signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error: Error) => {
      options.signal?.removeEventListener('abort', abort)
      reject(new ManimError(`manim could not start (${error.message}); is "${python} -m manim" installed?`, { cause: error }))
    })
    child.on('close', (code: number | null) => {
      options.signal?.removeEventListener('abort', abort)
      if (code === 0) return resolve()
      const tail = stderr.trim().split('\n').slice(-6).join(' | ')
      reject(new ManimError(`manim exited with ${code}: ${tail}`))
    })
  })
  const videosDir = join(mediaDir, 'videos')
  const found = await findFile(videosDir, 'scene.mp4')
  if (found === null) throw new ManimError(`manim reported success but wrote no scene.mp4 under ${videosDir}`)
  return found
}

/** Depth-first search for one file name; Manim nests output by scene name and quality. */
async function findFile(dir: string, name: string): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const nested = await findFile(path, name)
      if (nested !== null) return nested
    }
  }
  return null
}

/**
 * Render one Manim sentence into a segment of the narration's exact length.
 *
 * The scene's own duration decides nothing. If it is shorter than the audio the
 * segment holds the last frame (the `fps` filter), and if it is longer the cut
 * lands at the audio's end — both reported so the operator can decide whether
 * the animation needs `run_time` changes rather than discovering a truncated
 * animation in the finished video.
 */
export async function manimSegment(options: ManimSegmentOptions): Promise<{ path: string, sceneSeconds: number | null, overrunMs: number }> {
  const source = await readFile(options.scene, 'utf8')
  const sceneName = sceneClassName(source)
  if (sceneName === null) throw new ManimError(`${options.scene} defines no Scene subclass`)
  const mediaDir = join(options.workDir, 'media')
  await mkdir(mediaDir, { recursive: true })
  const rendered = await renderScene(options, sceneName, mediaDir)
  const media = await probe(rendered, options.tools ?? {}, options.signal)
  const output = join(options.workDir, 'segment.mp4')
  await encodeCfrSegment(
    { input: rendered, output, durationMs: options.timed.durationMs, width: options.video.width, height: options.video.height, fps: options.video.fps },
    options.tools ?? {},
    options.signal,
  )
  // Imported lazily above in pipeline.ts, so the module stays cheap to load in tests.
  return { path: output, sceneSeconds: media.durationMs === null ? null : media.durationMs / 1000, overrunMs: Math.max(0, (media.durationMs ?? 0) - options.timed.durationMs) }
}
