/**
 * Material resolution: turn what the model named into something a provider can
 * actually fetch.
 *
 * Two sources are supported: a file path (read through the host's filesystem
 * service and inlined as a `data:` URL — ARK documents base64 input, and
 * OpenAI's image-to-video takes an upload) and an http(s) URL (passed through).
 * Both carry a digest, which is what makes the duplicate-submission fingerprint
 * sensitive to *which* image was used rather than only to the prompt.
 *
 * A path may be absolute or relative to the session's workspace. A file the user
 * dropped into the chat is not in the workspace: DSH stores it under
 * `$DSH_HOME/attachments` and shows the model its path, and an image is stored
 * without an extension — so a file whose extension says nothing is recognised by
 * its first bytes (DESIGN §17.2).
 *
 * Not supported, deliberately: a bare session attachment id. The attachment
 * store reads an image through a full `ImageAttachmentRef` (id plus verified
 * media type, byte count and dimensions), and a bare id does not carry those.
 * The printed path does the same job (DESIGN §17.5).
 */

import { createHash } from 'node:crypto'
import { isAbsolute, extname } from 'node:path'
import type { MaterialRef, ResolvedMaterial } from './types.ts'
import { fsErrorCode, type WorkspaceFs } from './workspace-fs.ts'

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

/** How many leading bytes {@link sniffMime} needs. */
export const SNIFF_BYTES = 16

/**
 * MIME type from a file's signature, for a path whose extension says nothing —
 * notably DSH's normalized image attachments, stored by digest alone. Only the
 * formats the providers accept are recognised.
 */
export function sniffMime(head: Uint8Array): string | null {
  const at = (offset: number, ...bytes: number[]): boolean => bytes.every((byte, index) => head[offset + index] === byte)
  const ascii = (offset: number, text: string): boolean => at(offset, ...[...text].map(char => char.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(4, 'ftyp')) return ascii(8, 'qt  ') ? 'video/quicktime' : 'video/mp4'
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm'
  return null
}

/** A material problem the model can fix, phrased as what to do instead. */
export class MaterialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MaterialError'
  }
}

export interface ResolveContext {
  /** Where files are read: the host's `ctx.fs`, or a host-local stand-in. */
  fs: WorkspaceFs
  /** The session's workspace folder; relative paths resolve against it. */
  cwd: string | null
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
  if (!isAbsolute(value) && context.cwd === null) {
    throw new MaterialError(`"${value}" is relative and this call has no session workspace to resolve it against; pass an absolute path`)
  }
  const { fs, signal } = context
  const target = await fs.resolve(value, context.cwd === null ? { ...(signal === undefined ? {} : { signal }) } : { cwd: context.cwd, ...(signal === undefined ? {} : { signal }) })
  const info = await fs.stat(target, signal)
  if (info === undefined) {
    throw new MaterialError(`no readable file at ${target.displayPath}; verify the path with the read tool first`)
  }
  if (info.type !== 'file') {
    throw new MaterialError(`${target.displayPath} is not a regular file`)
  }

  const mime = mimeOfPath(value) ?? sniffMime(await fs.readByteRange(target, { offset: 0, length: SNIFF_BYTES }, signal))
  if (mime === null) {
    throw new MaterialError(`${target.displayPath} is neither a recognized image nor video, by extension or by content; supported: ${[...Object.keys(IMAGE_MIME), ...Object.keys(VIDEO_MIME)].join(' ')}`)
  }
  const limit = mime.startsWith('video/') ? MAX_VIDEO_BYTES : (context.maxImageBytes ?? MAX_IMAGE_BYTES)
  const tooLarge = (bytes: number): MaterialError =>
    new MaterialError(`${target.displayPath} is ${(bytes / 1024 / 1024).toFixed(1)} MiB, above the ${(limit / 1024 / 1024).toFixed(0)} MiB limit`)
  if (info.size !== undefined && info.size > limit) throw tooLarge(info.size)

  let bytes: Uint8Array
  try {
    bytes = await fs.readBytes(target, signal, limit)
  } catch (error: unknown) {
    if (fsErrorCode(error) === 'FS_TOO_LARGE') throw tooLarge(info.size ?? limit + 1)
    throw error
  }
  return {
    url: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    digest: `sha256:${sha256(bytes)}`,
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
