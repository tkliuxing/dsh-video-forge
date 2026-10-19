/**
 * The stream route: `GET|HEAD /api/video-forge/stream?path=…[&sessionId=…]`.
 *
 * Why this route exists (M5): the file viewer's mp4 renderer and the video
 * panel both need a `<video src>` that seeks. The harness serves file bytes at
 * `/api/file`, but that route ignores `Range` entirely and caps a response at
 * `attachments.imageLimits.maxImageBytes` (20 MiB by default) — which is smaller
 * than a 1080p clip this plugin generates. Everything else in DSH is Remote or
 * non-ranged, and the plugin's own `/video-forge/media/…` route is keyed by a
 * ledger task id, so it cannot serve a file the ledger does not know.
 *
 * Three properties this file guarantees:
 *
 * 1. **It is the harness's own door, not a new one.** The handler is registered
 *    through `ctx.connection.fetch.register`, so it lives under the page's
 *    authenticated `/api` prefix, is same-origin (no CORS to invent), and the
 *    connection answers 403 for every peer that is not the owner. A path in the
 *    query is therefore no more a privilege than `/api/file` already grants.
 * 2. **Ranges are windowed.** `ctx.fs` reads a byte window, never a stream, so a
 *    `bytes=0-` request for a 40 MiB clip would otherwise buffer all of it. The
 *    body is a `ReadableStream` that pulls one window at a time, so memory stays
 *    bounded whatever the browser asks for — and a seek costs one small read
 *    instead of a whole-file one, which also matters over an SSH workspace.
 * 3. **Only mp4 leaves here.** The renderer this serves declares exactly that
 *    suffix; refusing everything else keeps the route from becoming a general
 *    ranged file reader by accident.
 *
 * The path coming from the browser is the one thing DESIGN §9 refuses for the
 * media route, so the difference is deliberate: that route is reachable through
 * this plugin's own trust fence and therefore may only resolve what the ledger
 * holds, while this one is only reachable by the authenticated owner of the
 * harness's `/api` channel and reads a regular file the same user could already
 * fetch through `/api/file`. Adding ranges grants no reach — see §11.
 *
 * The structural slices below are written against DSH 0.2.1-rc.2
 * (`@deepseek-ai/dsh-client-connection` host half, `@deepseek-ai/dsh-fs`).
 */

import { parseRange } from './media-route.ts'
import { fsErrorCode, type WorkspaceFs, type WorkspaceTarget } from './workspace-fs.ts'

/** Exact path of the route under the page's authenticated `/api` channel. */
export const STREAM_ROUTE_PATH = '/api/video-forge/stream'

/** Suffixes this route serves, without a leading dot, and the media type each one sends. */
export const STREAM_MEDIA_TYPES: Readonly<Record<string, string>> = { mp4: 'video/mp4' }

/** The suffixes this route serves; the renderer declares the same set. */
export const STREAM_SUFFIXES: readonly string[] = Object.keys(STREAM_MEDIA_TYPES)

/** One `readByteRange` call; also the largest a single response body pull buffers. */
export const STREAM_WINDOW_BYTES = 1024 * 1024

/** The slice of a Session this route needs: its workspace root, in the execution world. */
export interface StreamSessions {
  get(id: string): { readonly header?: { readonly cwd?: string | undefined } | undefined } | undefined
}

/** The service this route is mounted through (`@deepseek-ai/dsh-client-connection`, host half). */
export interface StreamConnection {
  readonly fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** The slice of a cordis Context this registration needs (see {@link registerStreamRoute}). */
export interface StreamScope {
  get(name: string): unknown
  effect(factory: () => () => void, label?: string): unknown
}

/** What {@link registerStreamRoute} needs from the plugin. */
export interface StreamRegistration {
  /** The composed execution-world filesystem; resolved per request, because a remote one comes and goes. */
  readonly fs: () => WorkspaceFs | null
  /** Live Sessions, used to resolve a workspace-relative path. */
  readonly sessions: () => StreamSessions | undefined
  /** Told whenever the route is mounted or withdrawn, so the panel API can report it. */
  readonly setRegistered: (registered: boolean) => void
  /** Where a refusal to register is reported. */
  readonly warn: (message: string) => void
}

/**
 * Mount the route on the context that read the connection service.
 *
 * Ownership is the reason this lives in one function: cordis rebinds a service's
 * `ctx` to the context that READ it (the tracker carries `property: 'ctx'`), so
 * `connection.fetch.register` adds its effect to the scope it is read from — the
 * route is withdrawn when that scope disposes, which is what makes a plugin
 * reload leave nothing behind. The `setRegistered` flag is toggled inside the
 * same effect, so "the browser was told a stream route exists" and "a stream
 * route is mounted" cannot drift apart.
 *
 * @param scope - the scope whose lifetime the route shares (an inject scope in the plugin).
 * @param registration - the filesystem, Sessions and callbacks to register with.
 */
export function registerStreamRoute(scope: StreamScope, registration: StreamRegistration): void {
  try {
    scope.effect(() => {
      const connection = scope.get('connection') as StreamConnection | undefined
      if (connection === undefined || typeof connection.fetch?.register !== 'function') return () => undefined
      connection.fetch.register({
        path: STREAM_ROUTE_PATH,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: streamHandler({ fs: registration.fs, sessions: registration.sessions }),
      })
      registration.setRegistered(true)
      return () => { registration.setRegistered(false) }
    }, `video-forge: ${STREAM_ROUTE_PATH}`)
  } catch (error: unknown) {
    // A duplicate registration (two instances of this plugin, or another
    // package holding the path) is an off state: the browser half falls back to
    // the harness's bounded `/api/file`, and the panel says so.
    registration.warn(`could not register ${STREAM_ROUTE_PATH} (${error instanceof Error ? error.message : String(error)}); video preview falls back to /api/file`)
  }
}

/** What the handler reads; each is resolved per request, because a remote workspace's fs comes and goes. */
export interface StreamHost {
  /** The composed execution-world filesystem, or null while a remote one is disconnected. */
  readonly fs: () => WorkspaceFs | null
  /** Live Sessions, used to resolve a workspace-relative path. */
  readonly sessions: () => StreamSessions | undefined
}

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-disposition': 'inline',
  // The same sandbox `/api/file` puts on a file response: these bytes are a
  // user's media, and a browser that ever rendered one as a document would
  // otherwise have a page.
  'content-security-policy': "sandbox; default-src 'none'",
}

function fail(status: number, message: string, method = 'GET'): Response {
  return new Response(method === 'HEAD' ? null : `${message}\n`, {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * The media type a path is served as.
 * @param path - the requested path, absolute or workspace-relative.
 * @returns the media type for a declared video suffix, or undefined for anything else.
 */
export function videoMediaType(path: string): string | undefined {
  const name = path.replaceAll('\\', '/').toLowerCase()
  const suffix = STREAM_SUFFIXES.find(candidate => name.endsWith(`.${candidate}`))
  return suffix === undefined ? undefined : STREAM_MEDIA_TYPES[suffix]
}

/**
 * The HTTP status one filesystem refusal answers with (the map `/api/file` uses).
 * @param code - an `FS_*` code, or null for a failure that is not the filesystem's.
 * @returns the status to answer with.
 */
function statusOfCode(code: string | null): number {
  switch (code) {
    case 'FS_NOT_FOUND': return 404
    case 'FS_NOT_REGULAR_FILE':
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED': return 403
    case 'FS_TOO_LARGE': return 413
    case 'FS_ABORTED': return 499
    default: return 500
  }
}

/**
 * Build the Fetch-shaped handler.
 *
 * A `path` is either absolute in the filesystem's execution world (what the
 * document viewer holds, because it reads it from `stat`) or relative to the
 * workspace of the `sessionId` beside it (what the video panel holds, because a
 * directory listing yields names). A relative path without a session, or one
 * whose session is not loaded, is refused rather than guessed at.
 *
 * @param host - filesystem and Session lookups, resolved per request.
 * @returns the handler to register on the connection.
 */
export function streamHandler(host: StreamHost): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...BASE_HEADERS, allow: 'GET, HEAD' } })
    }

    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    if (path === null || path.trim() === '') return fail(400, 'path is required')
    if (path.includes('\0')) return fail(400, 'path is not a valid path')
    const mediaType = videoMediaType(path)
    if (mediaType === undefined) return fail(415, `only ${STREAM_SUFFIXES.join(', ')} is served here`, request.method)

    const fs = host.fs()
    if (fs === null) return fail(503, 'the filesystem service is not available for this workspace right now')

    let cwd: string | undefined
    const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
    if (!absolute) {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') return fail(409, 'a relative path needs the sessionId whose workspace resolves it')
      const session = host.sessions()?.get(sessionId)
      const root = session?.header?.cwd
      if (root === undefined || root === '') return fail(409, 'that session is not loaded here, so its workspace path cannot be resolved')
      cwd = root
    }

    let target: WorkspaceTarget
    let size: number
    try {
      target = await fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal: request.signal })
      const info = await fs.stat(target, request.signal)
      if (info === undefined) return fail(404, 'not found')
      if (info.type !== 'file') return fail(403, 'not a regular file')
      if (info.size === undefined) return fail(500, 'the file size is unknown, so ranges cannot be served')
      size = info.size
    } catch (error: unknown) {
      // Mirror `/api/file`: answer with the backend's error CODE, never its
      // message. A transport or filesystem message can name host paths and
      // upstream details that are none of the page's business, and the code is
      // what the page can act on anyway. A non-FS error is a host fault (500),
      // not a missing file.
      const code = fsErrorCode(error)
      return fail(statusOfCode(code), code ?? 'the file could not be read', request.method)
    }

    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'content-type': mediaType,
      'accept-ranges': 'bytes',
    }

    const range = parseRange(request.headers.get('range') ?? undefined, size)
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
    }

    // No range header means the whole entity; the body still arrives in windows.
    const start = range === null ? 0 : range.start
    const end = range === null ? Math.max(0, size - 1) : range.end
    const length = size === 0 ? 0 : end - start + 1
    const status = range === null ? 200 : 206

    if (size === 0) {
      return new Response(null, { status, headers: { ...headers, 'content-length': '0' } })
    }

    const responseHeaders: Record<string, string> = {
      ...headers,
      'content-length': String(length),
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    }
    if (request.method === 'HEAD') return new Response(null, { status, headers: responseHeaders })

    return new Response(windowedBody(fs, target, start, length, request.signal), {
      status,
      headers: responseHeaders,
    })
  }
}

/**
 * Stream one byte range as a series of `readByteRange` windows.
 *
 * A read that comes back empty (the file shrank under us) ends the body rather
 * than looping; an error cancels it, which the connection surfaces as a broken
 * response.
 *
 * @param fs - the filesystem to read through.
 * @param target - the file, already resolved and stat'ed.
 * @param start - first byte, 0-based.
 * @param length - how many bytes this response promised.
 * @param signal - aborts with the request.
 * @returns the body to hand the browser.
 */
function windowedBody(
  fs: WorkspaceFs,
  target: WorkspaceTarget,
  start: number,
  length: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = start
  let remaining = length
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0 || signal.aborted) {
        controller.close()
        return
      }
      const want = Math.min(STREAM_WINDOW_BYTES, remaining)
      const bytes = await fs.readByteRange(target, { offset, length: want }, signal)
      if (bytes.byteLength === 0) {
        // The file ended before the promised range did (it shrank under us). A
        // clean close here would be a truncated response the browser believes:
        // fail the body instead, so the player reports a broken source.
        controller.error(new Error('the file is shorter than the range this response promised'))
        return
      }
      // Trust nothing about how much the backend returns beyond "at most `want`".
      const chunk = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes
      offset += chunk.byteLength
      remaining -= chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() {
      // The browser seeks away or closes: nothing to release, since every window
      // read opens and closes its own handle.
    },
  })
}
