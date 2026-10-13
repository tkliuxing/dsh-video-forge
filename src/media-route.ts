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
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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

    let size: number
    try {
      size = (await stat(hit.artifact.path)).size
    } catch {
      send(res, 404, 'artifact missing on disk')
      return
    }

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
      res.writeHead(416, { ...common, 'content-range': `bytes */${size}` })
      res.end()
      return
    }

    if (range === null) {
      res.writeHead(200, { ...common, 'content-length': String(size) })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      stream(req, res, hit.artifact.path, {})
      return
    }

    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...common,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(length),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    stream(req, res, hit.artifact.path, { start: range.start, end: range.end })
  }
}

function stream(req: IncomingMessage, res: ServerResponse, path: string, range: { start?: number; end?: number }): void {
  const source = createReadStream(path, range)
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
