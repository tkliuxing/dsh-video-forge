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
import type { VideoArtifact } from './types.ts'

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
  /** Credential for the artifact host; some relays authorize the download too. */
  apiKey: string | null
  /** Destination directory for this task's artifacts. */
  directory: string
  localId: string
  fetch: typeof globalThis.fetch
  signal?: AbortSignal | undefined
  /** Media type the provider declared, used when the response omits one. */
  mimeHint?: string | null
  maxBytes?: number
}

/** Download one artifact and describe it for the ledger. */
export async function downloadArtifact(options: DownloadOptions): Promise<VideoArtifact> {
  const headers: Record<string, string> = {}
  if (options.apiKey !== null) headers.authorization = `Bearer ${options.apiKey}`

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

  return {
    path,
    bytes: body.byteLength,
    mime,
    width: null,
    height: null,
    durationSec: null,
    token: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  }
}

/** Keep only media types we can name an extension for. */
function normalizeMime(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return null
  if (trimmed === 'application/mp4' || trimmed === 'application/octet-stream') return 'video/mp4'
  return trimmed in EXTENSION ? trimmed : null
}
