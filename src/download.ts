/**
 * Artifact download: pull the provider's output into `$DSH_HOME` before its URL
 * expires.
 *
 * Every provider here hands back a short-lived temporary URL (ARK: 24 hours,
 * with a download-count cap on newer models), so "keep the URL" is not an
 * option — the bytes are the artifact. The file lands `0600` inside a `0700`
 * directory, matching DESIGN §9, and each artifact gets its own 128-bit token,
 * which is the only thing besides the task id that authorizes media access.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactFrame, VideoArtifact } from './types.ts'

/** Extension for a media type we are willing to store. */
const EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
}

/** Refuse an implausibly large body rather than filling the disk. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024

/** A download that failed in a way the model should see verbatim. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface DownloadOptions {
  url: string
  /** The provider's API key. Sent only to the provider's own origin (see `apiOrigin`). */
  apiKey: string | null
  /**
   * The provider's API base URL. The key goes with the download only when the
   * artifact is served from that same origin (an OpenAI-shaped `/content`
   * endpoint); a vendor CDN or a relay's presigned third-party URL never sees
   * it — it is not theirs, and S3 refuses a presigned URL that also carries an
   * Authorization header.
   */
  apiOrigin?: string | null
  /** Destination directory for this task's artifacts. */
  directory: string
  localId: string
  fetch: typeof globalThis.fetch
  signal?: AbortSignal | undefined
  /** Media type the provider declared, used when the response omits one. */
  mimeHint?: string | null
  maxBytes?: number
  /** The video's last frame, when the provider returned one; fetched best-effort beside it. */
  lastFrameUrl?: string | null | undefined
}

const FRAME_TIMEOUT_MS = 30_000

/** A last frame is one image; anything near this size is not one. */
const MAX_FRAME_BYTES = 20 * 1024 * 1024

const FRAME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Download one artifact and describe it for the ledger. */
export async function downloadArtifact(options: DownloadOptions): Promise<VideoArtifact> {
  const headers: Record<string, string> = {}
  if (options.apiKey !== null && sameOrigin(options.url, options.apiOrigin ?? null)) headers.authorization = `Bearer ${options.apiKey}`

  const response = await options.fetch(options.url, {
    method: 'GET',
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    throw new DownloadError(`downloading the artifact failed with HTTP ${response.status}`)
  }

  const declared = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() ?? ''
  const mime = normalizeMime(declared) ?? normalizeMime(options.mimeHint ?? '') ?? 'video/mp4'
  const body = new Uint8Array(await response.arrayBuffer())
  const max = options.maxBytes ?? MAX_ARTIFACT_BYTES
  if (body.byteLength > max) {
    throw new DownloadError(`the artifact is ${(body.byteLength / 1024 / 1024).toFixed(1)} MiB, above the ${(max / 1024 / 1024).toFixed(0)} MiB cap`)
  }
  if (body.byteLength === 0) {
    throw new DownloadError('the artifact URL answered with an empty body')
  }

  const extension = EXTENSION[mime] ?? 'mp4'
  await mkdir(options.directory, { recursive: true, mode: 0o700 })
  const path = join(options.directory, `${options.localId}.${extension}`)
  // mode on writeFile is the creation mode; an existing file keeps its own, and
  // this directory is ours, so the file is always created by this call.
  await writeFile(path, body, { mode: 0o600 })

  const lastFrame = options.lastFrameUrl === undefined || options.lastFrameUrl === null
    ? null
    : await downloadFrame(options, options.lastFrameUrl)

  return {
    path,
    bytes: body.byteLength,
    mime,
    width: null,
    height: null,
    durationSec: null,
    token: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
    ...(lastFrame === null ? {} : { lastFrame }),
  }
}

/**
 * The last frame, or null when it cannot be had. Never throws: the video is
 * the paid artifact, and a missing frame only means `from` cannot continue it.
 */
async function downloadFrame(options: DownloadOptions, url: string): Promise<ArtifactFrame | null> {
  try {
    const headers: Record<string, string> = {}
    if (options.apiKey !== null && sameOrigin(url, options.apiOrigin ?? null)) headers.authorization = `Bearer ${options.apiKey}`
    // Its own short deadline: an optional frame must not hold back recording the paid video.
    const deadline = AbortSignal.timeout(FRAME_TIMEOUT_MS)
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline])
    const response = await options.fetch(url, { method: 'GET', headers, signal })
    if (!response.ok) return null
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.byteLength === 0 || body.byteLength > MAX_FRAME_BYTES) return null
    const declared = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
    // ARK documents a JPEG; trust the bytes over a generic header.
    const mime = body[0] === 0xff && body[1] === 0xd8 ? 'image/jpeg'
      : body[0] === 0x89 && body[1] === 0x50 ? 'image/png'
        : Object.hasOwn(FRAME_EXTENSION, declared) ? declared : null
    if (mime === null) return null
    const path = join(options.directory, `${options.localId}.last.${FRAME_EXTENSION[mime] ?? 'jpg'}`)
    await writeFile(path, body, { mode: 0o600 })
    return { path, mime, bytes: body.byteLength }
  } catch {
    return null
  }
}

/** Keep only media types we can name an extension for. */
function normalizeMime(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return null
  if (trimmed === 'application/mp4' || trimmed === 'application/octet-stream') return 'video/mp4'
  return trimmed in EXTENSION ? trimmed : null
}

function sameOrigin(url: string, base: string | null): boolean {
  if (base === null) return false
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}
