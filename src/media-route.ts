/**
 * The media route: `GET|HEAD /video-forge/media/:localId/:token/:name`.
 *
 * Three properties this file exists to guarantee (DESIGN §9):
 *
 * 1. **The path is never client-controlled.** The only thing a request carries
 *    that reaches the filesystem is a task id plus an artifact token, and both
 *    are looked up in the ledger. `:name` is decoration; traversal is not
 *    merely filtered, it is unrepresentable.
 * 2. **Range / 206 works.** A `<video controls>` element seeks and starts
 *    playback with range requests, and the shipped `/api/file` route ignores
 *    `Range` entirely — hence a dedicated route. Nothing in the harness
 *    implements this, so the parsing below is ours.
 * 3. **Nothing is cacheable or sniffable.** `private, no-store`, `nosniff`, and
 *    a sandbox CSP, because these bytes are a user's generated media.
 *
 * A workspace artifact (DESIGN §17.2) lives where the user can move, delete or
 * replace it. It is served only while its real path is still exactly the path
 * recorded when it was written and it is still a regular file — a symlink put in
 * its place, or in place of a directory above it, is refused rather than
 * followed. A file that is gone answers 410, so a card can say "moved or
 * deleted" instead of showing a broken player.
 */

import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Ledger } from './ledger.ts'
import { MEDIA_ROUTE_PREFIX } from './settings.ts'

/** One parsed `Range` request. */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Parse a single-range `Range` header against a known length.
 *
 * Returns `'unsatisfiable'` for a syntactically valid range that falls outside
 * the file (which owes the client a 416), and null when there is no usable
 * range header (which means "serve the whole entity"). A multi-range request is
 * answered with the whole entity: multipart/byteranges is not worth its
 * complexity for a media element that never asks for it.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const [, rawStart = '', rawEnd = ''] = match

  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const length = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(length) || length <= 0) return 'unsatisfiable'
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number.parseInt(rawStart, 10)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number.parseInt(rawEnd, 10)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/** Split a route pathname into its decoded segments after the prefix. */
export function mediaSegments(pathname: string): string[] | null {
  if (pathname !== MEDIA_ROUTE_PREFIX && !pathname.startsWith(`${MEDIA_ROUTE_PREFIX}/`)) return null
  const rest = pathname.slice(MEDIA_ROUTE_PREFIX.length).replace(/^\//, '')
  if (rest === '') return null
  try {
    return rest.split('/').map(segment => decodeURIComponent(segment))
  } catch {
    return null
  }
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/** Build the route handler. */
export function mediaHandler(ledger: Ledger): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'method not allowed', { allow: 'GET, HEAD' })
      return
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const segments = mediaSegments(pathname)
    if (segments === null || segments.length < 3) {
      send(res, 404, 'not found')
      return
    }
    const [localId, token, ...nameParts] = segments as [string, string, ...string[]]
    const name = nameParts.join('/')

    // The ledger is the only authority: an unknown pair is indistinguishable
    // from a missing file, so a probe learns nothing.
    const hit = ledger.artifact(localId, token)
    if (hit === undefined) {
      send(res, 404, 'not found')
      return
    }

    const opened = hit.artifact.location?.kind === 'workspace'
      ? await openWorkspaceFile(hit.artifact.path)
      : await openFile(hit.artifact.path)
    if (opened === 'gone') {
      send(res, hit.artifact.location?.kind === 'workspace' ? 410 : 404, hit.artifact.location?.kind === 'workspace'
        ? 'the video was moved or deleted from the workspace'
        : 'artifact missing on disk')
      return
    }
    if (opened === 'replaced') {
      send(res, 403, 'the video in the workspace is no longer the file that was written; not following it')
      return
    }
    if (opened === 'unreadable') {
      send(res, 500, 'the video could not be opened')
      return
    }
    const { handle, size } = opened

    const common: Record<string, string> = {
      'content-type': hit.artifact.mime,
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'content-disposition': `inline; filename="${sanitizeFilename(name === '' ? 'video' : name)}"`,
    }

    const range = parseRange(req.headers.range, size)
    if (range === 'unsatisfiable') {
      await handle.close()
      res.writeHead(416, { ...common, 'content-range': `bytes */${size}` })
      res.end()
      return
    }

    if (range === null) {
      res.writeHead(200, { ...common, 'content-length': String(size) })
      if (req.method === 'HEAD') {
        await handle.close()
        res.end()
        return
      }
      stream(req, res, handle, {})
      return
    }

    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...common,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(length),
    })
    if (req.method === 'HEAD') {
      await handle.close()
      res.end()
      return
    }
    stream(req, res, handle, { start: range.start, end: range.end })
  }
}

type Opened = { handle: FileHandle; size: number } | 'gone' | 'replaced' | 'unreadable'

/**
 * Read-only, never following a final symlink, and non-blocking: opening a FIFO
 * put in the video's place would otherwise wait forever and pin a threadpool
 * thread of the whole host. The handle is checked to be a regular file anyway.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** A plugin-owned file under `$DSH_HOME`. */
async function openFile(path: string): Promise<Opened> {
  try {
    const handle = await open(path, (constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)))
    try {
      const info = await handle.stat()
      if (info.isFile()) return { handle, size: info.size }
    } catch {
      // Fall through: close it and refuse.
    }
    await handle.close()
    return 'unreadable'
  } catch {
    return 'gone'
  }
}

/**
 * A workspace artifact, opened only if it is still the file that was written:
 * open first (never following a final symlink), then require that the real path
 * is still the recorded one and names the very file the handle holds. Checking
 * after opening leaves no window in which a swapped path could be read.
 */
async function openWorkspaceFile(path: string): Promise<Opened> {
  let handle: FileHandle
  try {
    handle = await open(path, OPEN_FLAGS)
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone'
    // ELOOP is O_NOFOLLOW meeting a symlink; anything else is a plain failure to open.
    return code === 'ELOOP' || code === 'EMLINK' ? 'replaced' : 'unreadable'
  }
  try {
    const held = await handle.stat()
    const real = await realpath(path)
    const named = await stat(real)
    if (held.isFile() && real === path && named.ino === held.ino && named.dev === held.dev) return { handle, size: held.size }
  } catch {
    // Changed under us: treat like a replacement.
  }
  await handle.close()
  return 'replaced'
}

function stream(req: IncomingMessage, res: ServerResponse, handle: FileHandle, range: { start?: number; end?: number }): void {
  const source = handle.createReadStream({ ...range, autoClose: true })
  // A client that seeks away mid-body leaves the socket half-read; destroy the
  // stream rather than leaking a descriptor per scrub.
  req.on('close', () => source.destroy())
  source.on('error', () => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
  source.pipe(res)
}

/** Keep the download name free of quotes and path separators. */
function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
}
