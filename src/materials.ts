/**
 * Material resolution: turn what the model named into something a provider can
 * actually fetch.
 *
 * Two sources are supported in this milestone: an absolute workspace path (read
 * and inlined as a `data:` URL — ARK documents base64 input, and OpenAI's
 * image-to-video takes an upload) and an http(s) URL (passed through). Both
 * carry a digest, which is what makes the duplicate-submission fingerprint
 * sensitive to *which* image was used rather than only to the prompt.
 *
 * Not supported yet, deliberately: a bare session attachment id. The attachment
 * store reads an image through a full `ImageAttachmentRef` (id plus verified
 * media type, byte count and dimensions), and a bare id does not carry those, so
 * accepting one would mean guessing. The tools say so instead of half-working.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, extname } from 'node:path'
import type { MaterialRef, ResolvedMaterial } from './types.ts'

/** Upload caps, from DESIGN §4. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

/** MIME type for a path's extension, or null when we cannot vouch for it. */
export function mimeOfPath(path: string): string | null {
  const extension = extname(path).toLowerCase()
  return IMAGE_MIME[extension] ?? VIDEO_MIME[extension] ?? null
}

/** A material problem the model can fix, phrased as what to do instead. */
export class MaterialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MaterialError'
  }
}

export interface ResolveContext {
  /** Session workspace root; used only to explain why a relative path was refused. */
  workspaceRoot: string | null
  maxImageBytes?: number
  signal?: AbortSignal | undefined
}

/** Resolve one material reference. */
export async function resolveMaterial(ref: MaterialRef, context: ResolveContext): Promise<ResolvedMaterial> {
  if (ref.kind === 'url') return resolveUrl(ref.value)
  if (ref.kind === 'attachment') {
    throw new MaterialError(
      `attachment ids are not accepted yet (${ref.value}); pass an absolute file path or an http(s) URL instead`,
    )
  }
  return resolvePath(ref.value, context)
}

function resolveUrl(value: string): ResolvedMaterial {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new MaterialError(`"${value}" is not a URL; pass an absolute file path or an http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MaterialError(`only http(s) URLs are accepted, got ${parsed.protocol}//`)
  }
  return { url: value, digest: `url:${sha256(value)}`, bytes: null, mime: null }
}

async function resolvePath(value: string, context: ResolveContext): Promise<ResolvedMaterial> {
  if (!isAbsolute(value)) {
    const where = context.workspaceRoot === null ? 'the session workspace' : context.workspaceRoot
    throw new MaterialError(`"${value}" is not absolute; resolve it against ${where} first (the read tool reports existing files)`)
  }

  let size: number
  try {
    size = (await stat(value)).size
  } catch {
    throw new MaterialError(`no readable file at ${value}; verify the path with the read tool first`)
  }

  const mime = mimeOfPath(value)
  const isVideo = mime !== null && mime.startsWith('video/')
  const limit = isVideo ? MAX_VIDEO_BYTES : (context.maxImageBytes ?? MAX_IMAGE_BYTES)
  if (size > limit) {
    throw new MaterialError(`${value} is ${(size / 1024 / 1024).toFixed(1)} MiB, above the ${(limit / 1024 / 1024).toFixed(0)} MiB limit`)
  }
  if (mime === null) {
    throw new MaterialError(`${value} has no recognized image or video extension; supported: ${[...Object.keys(IMAGE_MIME), ...Object.keys(VIDEO_MIME)].join(' ')}`)
  }

  const bytes = await readFile(value, context.signal === undefined ? {} : { signal: context.signal })
  const digest = `sha256:${sha256(bytes)}`
  return {
    url: `data:${mime};base64,${bytes.toString('base64')}`,
    digest,
    bytes: bytes.byteLength,
    mime,
  }
}

/** Short, prompt-free descriptor stored in the ledger (never the bytes). */
export function describeMaterial(ref: MaterialRef, resolved: ResolvedMaterial): string {
  if (ref.kind === 'url') return `url:${ref.value}`
  if (ref.kind === 'attachment') return `attachment:${ref.value}`
  return `path:${ref.value}#${resolved.digest.slice(0, 19)}`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
