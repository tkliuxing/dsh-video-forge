/**
 * The only place the teaching pipeline runs an external program.
 *
 * ffmpeg and ffprobe do three jobs and are trusted with nothing else: read a
 * file's real duration and geometry, force a constant frame rate onto a
 * recording that was captured at whatever rate the browser felt like, and glue
 * segments together. Both binaries are looked up on `PATH` and can be pointed
 * elsewhere, because a plugin that shells out owes the operator a way to say
 * where the program is (DESIGN §23).
 *
 * Why CFR is not optional: a screencast emits a frame only when the page
 * repaints, so a slide that holds still produces no frames at all. Encoding
 * with `fps=<n>` fills those gaps with repeated frames, which is exactly what a
 * still slide should look like, and `-t <audio>` then cuts the segment to the
 * length the voice actually took.
 */

import { spawn } from 'node:child_process'
import { basename, dirname } from 'node:path'

/** What one media file says about itself. Every field is measured, never assumed. */
export interface MediaProbe {
  /** Duration in whole milliseconds, or null when the container did not report one. */
  durationMs: number | null
  width: number | null
  height: number | null
  /** Frames per second from the container, which for a screencast is the *average*. */
  fps: number | null
  /** Whether the file carries an audio stream at all. */
  hasAudio: boolean
  /** Container and video codec names, as ffprobe reports them. */
  format: string | null
  codec: string | null
}

/** A command that failed, carrying enough of its stderr to be actionable. */
export class MediaError extends Error {
  readonly command: string
  readonly status: number | null
  readonly stderr: string

  constructor(message: string, options: { command: string, status?: number | null, stderr?: string, cause?: unknown }) {
    super(message)
    this.name = 'MediaError'
    this.command = options.command
    this.status = options.status ?? null
    this.stderr = options.stderr ?? ''
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export interface MediaTools {
  /** Defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string
  /** Defaults to `ffprobe` on PATH. */
  ffprobePath?: string
}

const STDERR_TAIL = 4000

/** Run one program to completion, keeping the tail of stderr for the error path. */
function run(command: string, args: readonly string[], signal?: AbortSignal, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...(cwd === undefined ? {} : { cwd }) })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL)
    })
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error: Error) => {
      signal?.removeEventListener('abort', abort)
      reject(new MediaError(`${command} could not start (${error.message}); is it installed and on PATH?`, { command, cause: error }))
    })
    child.on('close', (code: number | null) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) return resolve()
      reject(new MediaError(`${command} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`, { command, status: code, stderr }))
    })
  })
}

interface FfprobeJson {
  streams?: { codec_type?: string, codec_name?: string, width?: number, height?: number, avg_frame_rate?: string, r_frame_rate?: string, duration?: string }[]
  format?: { duration?: string, format_name?: string }
}

/** Parse ffprobe's JSON into the few facts the pipeline needs. */
export function parseProbe(json: string): MediaProbe {
  const parsed = JSON.parse(json) as FfprobeJson
  const video = parsed.streams?.find(stream => stream.codec_type === 'video')
  const audio = parsed.streams?.find(stream => stream.codec_type === 'audio')
  const seconds = Number(parsed.format?.duration ?? video?.duration ?? '')
  const rate = (video?.avg_frame_rate ?? video?.r_frame_rate ?? '').split('/')
  const fps = rate.length === 2 && Number(rate[1]) !== 0 ? Number(rate[0]) / Number(rate[1]) : null
  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    width: typeof video?.width === 'number' ? video.width : null,
    height: typeof video?.height === 'number' ? video.height : null,
    fps: fps !== null && Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null,
    hasAudio: audio !== undefined,
    format: parsed.format?.format_name ?? null,
    codec: video?.codec_name ?? null,
  }
}

/** Measure one file. */
export async function probe(file: string, tools: MediaTools = {}, signal?: AbortSignal): Promise<MediaProbe> {
  const command = tools.ffprobePath ?? 'ffprobe'
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]
  const stdout = await runCapture(command, args, signal)
  try {
    return parseProbe(stdout)
  } catch (error: unknown) {
    throw new MediaError(`${command} returned JSON this build cannot read`, { command, cause: error })
  }
}

/** Run a program and collect stdout, for ffprobe's JSON. */
function runCapture(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL)
    })
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error: Error) => {
      signal?.removeEventListener('abort', abort)
      reject(new MediaError(`${command} could not start (${error.message}); is it installed and on PATH?`, { command, cause: error }))
    })
    child.on('close', (code: number | null) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) return resolve(stdout)
      reject(new MediaError(`${command} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`, { command, status: code, stderr }))
    })
  })
}

export interface CfrOptions {
  input: string
  output: string
  /** Segment length: the sentence audio's real duration. */
  durationMs: number
  width: number
  height: number
  fps: number
  /** Quality knob; 18 is visually lossless for slides and text. */
  crf?: number
}

/**
 * Turn one recording into a constant-frame-rate, silent segment of an exact length.
 *
 * `-t` before the output is a hard cut; `fps` before it fills an idle stretch
 * with repeated frames. `scale` + `setsar` keep every segment byte-identical in
 * geometry so `concat` can copy instead of re-encode.
 */
export async function encodeCfrSegment(options: CfrOptions, tools: MediaTools = {}, signal?: AbortSignal): Promise<void> {
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const seconds = (options.durationMs / 1000).toFixed(3)
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', options.input,
    '-an',
    '-vf', `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${options.fps},tpad=stop_mode=clone:stop_duration=10`,
    '-t', seconds,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    options.output,
  ]
  await run(command, args, signal)
}

/** Write a concat-demuxer list beside the output: the demuxer reads a file, never stdin. */
async function writeConcatList(inputs: readonly string[], output: string): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dirname(output), { recursive: true })
  const listPath = `${output}.concat.txt`
  const list = inputs.map(path => `file '${path.replaceAll("'", "'\\''")}'`).join('\n')
  await writeFile(listPath, `${list}\n`, 'utf8')
  return listPath
}

/** Glue already-identical segments together without re-encoding. */
export async function concatSegments(inputs: readonly string[], output: string, tools: MediaTools = {}, signal?: AbortSignal): Promise<void> {
  if (inputs.length === 0) throw new MediaError('nothing to concatenate', { command: tools.ffmpegPath ?? 'ffmpeg' })
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const listPath = await writeConcatList(inputs, output)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output]
  await run(command, args, signal)
}


export interface MuxOptions {
  video: string
  audio: string
  output: string
  /** Encode the audio track to AAC; `copy` would refuse an mp3-in-mp4 pairing in some builds. */
  audioBitrateKbps?: number
  /**
   * Burn a subtitle file into the picture.
   *
   * This is the one path that re-encodes the video: a filter cannot run on
   * copied frames. It needs an ffmpeg built with libass — without it the
   * `subtitles` filter does not exist at all, which the dependency probe reports
   * before this is ever called (see `probeFilter`).
   */
  subtitles?: BurnSubtitles
}

/** A subtitle file plus the style to render it with. */
export interface BurnSubtitles {
  /** Absolute path of the .srt; its basename is what the filter is given. */
  file: string
  /** `force_style=` value: `FontName=…,Fontsize=…`, without the quotes. */
  forceStyle: string
}

/**
 * Put the narration back on the assembled picture.
 *
 * The audio track is the only thing re-encoded (to AAC); the picture is copied.
 * `-shortest` is deliberately absent: the WAV of the narration and the picture
 * concatenation differ by a few tens of milliseconds (CFR rounding per segment
 * plus AAC's 42.7 ms frame at 24 kHz), and `-shortest` resolves that difference
 * by cutting whichever stream is shorter — measured on the 2026-11-20 sample as
 * a picture trimmed by 34 ms and an audio track 72 ms short of the narration, so
 * the last sentence lost its tail. Without it the file is as long as the longer
 * stream and the shorter one simply ends, which is what narration over picture
 * should do.
 */
export async function muxNarration(options: MuxOptions, tools: MediaTools = {}, signal?: AbortSignal): Promise<void> {
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const burn = options.subtitles === undefined
    ? []
    : [
        '-vf', `subtitles=${basename(options.subtitles.file)}:force_style='${options.subtitles.forceStyle}'`,
        // A burn cannot copy frames, so the picture is encoded here. The settings
        // match the per-segment encode in `encodeCfrSegment`: same preset, same
        // CRF, same pixel format, so the second encode is not noticeably worse.
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      ]
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', options.video,
    '-i', options.audio,
    ...(options.subtitles === undefined ? ['-c:v', 'copy'] : burn),
    '-c:a', 'aac', '-b:a', `${options.audioBitrateKbps ?? 192}k`,
    '-movflags', '+faststart',
    options.output,
  ]
  // The filter is given the subtitle file's basename and run from that file's
  // directory: ffmpeg's filter-graph escaping turns a path with a colon or a
  // quote into a parse error, and no path is short enough to be worth that risk.
  await run(command, args, signal, options.subtitles === undefined ? undefined : dirname(options.subtitles.file))
}

/**
 * Whether this ffmpeg build has one named filter.
 *
 * The distinction matters because a missing filter is not a warning at run time,
 * it is "No such filter: 'subtitles'": the whole mux fails after the segments
 * were already rendered. Asking `-filters` first makes the answer part of the
 * plan, before anything is paid for or rendered.
 */
export async function probeFilter(tools: MediaTools, name: string, signal?: AbortSignal): Promise<string> {
  const command = tools.ffmpegPath ?? 'ffmpeg'
  let listing: string
  try {
    listing = await runCapture(command, ['-hide_banner', '-filters'], signal)
  } catch (error: unknown) {
    return error instanceof MediaError ? `unknown (${error.message})` : 'unknown'
  }
  // `-filters` prints one filter per line as ` <flags> <name> <io> <description>`,
  // name in the second column after the flag cluster.
  const found = listing.split('\n').some(line => line.trim().split(/\s+/)[1] === name)
  return found ? `present (${name}, ${basename(command)})` : `missing (this ffmpeg build has no ${name} filter)`
}

/** Concatenate the per-sentence audio files in the same order the picture is assembled. */
export async function concatAudio(inputs: readonly string[], output: string, tools: MediaTools = {}, signal?: AbortSignal): Promise<void> {
  if (inputs.length === 0) throw new MediaError('nothing to concatenate', { command: tools.ffmpegPath ?? 'ffmpeg' })
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const listPath = await writeConcatList(inputs, output)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'pcm_s16le', output]
  await run(command, args, signal)
}

export interface FramesOptions {
  /** A concat-demuxer list: `file '<jpg>'` plus `duration <seconds>` per frame. */
  listPath: string
  output: string
  /** Segment length: the sentence audio's real duration. */
  durationMs: number
  width: number
  height: number
  fps: number
  crf?: number
}

/**
 * Encode a screencast's frames into a constant-frame-rate segment.
 *
 * A browser paints only when something changes, so the capture has frames at
 * irregular intervals. The concat list holds each frame's duration, and `fps`
 * turns that into a steady 30 fps by repeating the last frame across a hold —
 * which is what a still slide is.
 */
export async function encodeFrames(options: FramesOptions, tools: MediaTools = {}, signal?: AbortSignal): Promise<void> {
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', options.listPath,
    '-vf', `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${options.fps},tpad=stop_mode=clone:stop_duration=10`,
    '-t', (options.durationMs / 1000).toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(options.crf ?? 18), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    options.output,
  ]
  await run(command, args, signal)
}

/**
 * How many distinct colours one frame actually contains.
 *
 * This is the check the first mixed sample needed and did not have: two
 * "succeeded" renders turned out to be a pure white stage and a pure black
 * animation, and nothing but the duration was ever asserted
 * (docs/TEACH-VIDEO.md §16). A flat frame is one colour, however long it is.
 *
 * The frame is decoded through ffmpeg to raw RGB, so this works for a PNG, a
 * JPEG or an mp4 frame alike, and it needs nothing beyond the ffmpeg the
 * pipeline already requires.
 *
 * @param input - any file ffmpeg can decode to one frame.
 * @param options - `atSeconds` seeks first; `maxSamples` bounds the work.
 * @returns the number of distinct RGB triples among the sampled pixels.
 */
export async function countFrameColors(
  input: string,
  options: { atSeconds?: number, maxSamples?: number } = {},
  tools: MediaTools = {},
  signal?: AbortSignal,
): Promise<number> {
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const args = [
    '-v', 'error',
    ...(options.atSeconds === undefined ? [] : ['-ss', String(options.atSeconds)]),
    '-i', input,
    '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]
  const raw = await runCaptureBuffer(command, args, signal)
  if (raw.byteLength < 3) throw new MediaError(`${command} produced no pixels for ${input}`, { command })
  const pixels = Math.floor(raw.byteLength / 3)
  const stride = Math.max(1, Math.ceil(pixels / (options.maxSamples ?? 60_000)))
  const colors = new Set<number>()
  for (let index = 0; index < pixels; index += stride) {
    const offset = index * 3
    colors.add((raw[offset]! << 16) | (raw[offset + 1]! << 8) | raw[offset + 2]!)
  }
  return colors.size
}

/** Run a program and collect stdout as bytes, for raw video. */
function runCaptureBuffer(command: string, args: readonly string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let stderr = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > STDERR_TAIL) stderr = stderr.slice(-STDERR_TAIL)
    })
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error: Error) => {
      signal?.removeEventListener('abort', abort)
      reject(new MediaError(`${command} could not start (${error.message})`, { command, cause: error }))
    })
    child.on('close', (code: number | null) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) return resolve(Buffer.concat(chunks))
      reject(new MediaError(`${command} exited with ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`, { command, status: code, stderr }))
    })
  })
}

export interface AudioCutOptions {
  input: string
  output: string
  /** Where the kept audio starts, in the input's own timeline. */
  startMs: number
  /** Where it ends (before padding): `startMs + cutMs` is the last sample kept. */
  cutMs: number
  /**
   * Final length. Longer than `cutMs` pads with silence; shorter trims. The
   * target is `content + pause`, i.e. the sentence's words plus the break that
   * follows them, which is why a segment can be longer than its speech.
   */
  targetMs: number
  sampleRate?: number
}

/**
 * Cut one sentence out of an utterance and give it a deliberate tail.
 *
 * `atrim` is sample-accurate (input seeking on a compressed file is not), and
 * `apad` supplies the silence the punctuation asked for. Re-encoding is
 * unavoidable here — the audio is being rebuilt, not merely moved — so this
 * always writes mp3 at the pipeline's sample rate rather than copying.
 */
export async function cutAudioSegment(options: AudioCutOptions, tools: MediaTools = {}, signal?: AbortSignal): Promise<void> {
  const command = tools.ffmpegPath ?? 'ffmpeg'
  const start = Math.max(0, options.startMs) / 1000
  const end = Math.max(start, (options.startMs + options.cutMs) / 1000)
  const target = Math.max(0.001, options.targetMs / 1000)
  const rate = options.sampleRate ?? 24_000
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', options.input,
    '-af', `atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=N/SR/TB,apad`,
    '-t', target.toFixed(3),
    '-ar', String(rate), '-ac', '1',
    '-c:a', 'libmp3lame', '-b:a', '192k',
    options.output,
  ]
  await run(command, args, signal)
}
