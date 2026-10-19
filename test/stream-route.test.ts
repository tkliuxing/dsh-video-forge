/**
 * The stream route (M5): a Range-capable `<video src>` for anything the ledger
 * does not already serve.
 *
 * The route is Fetch-shaped, so these tests call the handler with a `Request`
 * and read the `Response` — no socket, no connection layer. What they pin down
 * is the behaviour the browser depends on: 206 with a correct `content-range`,
 * 416 for an unsatisfiable one, the body arriving in bounded windows rather than
 * one whole-file read, both path forms (absolute from the document viewer,
 * session-relative from the video panel), and a refusal for everything that is
 * not an mp4.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { STREAM_ROUTE_PATH, STREAM_WINDOW_BYTES, streamHandler, videoMediaType, type StreamHost, type StreamSessions } from '../src/stream-route.ts'
import { hostWorkspaceFs, type WorkspaceFs, type WorkspaceTarget } from '../src/workspace-fs.ts'

/** Larger than one window, so a whole-body read has to loop. */
const SIZE = STREAM_WINDOW_BYTES * 2 + 123

let root: string
let outside: string
let clip: string
let clipBytes: Buffer
let empty: string
let notes: string
let directory: string

/** The ranges one response's body asked the filesystem for. */
let windows: { offset: number; length: number }[] = []

/** A filesystem that records every window read, to prove the body is bounded. */
const counting: WorkspaceFs = {
  resolve: (path, options) => hostWorkspaceFs.resolve(path, options),
  stat: (target, signal) => hostWorkspaceFs.stat(target, signal),
  readBytes: (target, signal, maxBytes) => hostWorkspaceFs.readBytes(target, signal, maxBytes),
  readByteRange: async (target: WorkspaceTarget, range, signal) => {
    windows.push({ ...range })
    return hostWorkspaceFs.readByteRange(target, range, signal)
  },
}

const sessions: StreamSessions = {
  get: id => (id === 'session-a' ? { header: { cwd: root } } : undefined),
}

const host = (fs: WorkspaceFs | null = counting, table: StreamSessions | undefined = sessions): StreamHost => ({
  fs: () => fs,
  sessions: () => table,
})

const handler = streamHandler(host())

/** One request against the route with a query string. */
const call = (query: string, init: RequestInit = {}): Promise<Response> =>
  handler(new Request(`http://127.0.0.1${STREAM_ROUTE_PATH}?${query}`, init))

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'video-forge-stream-'))
  outside = await mkdtemp(join(tmpdir(), 'video-forge-stream-outside-'))
  clip = join(root, 'clip.mp4')
  clipBytes = Buffer.alloc(SIZE)
  for (let index = 0; index < SIZE; index += 1) clipBytes[index] = index % 251
  await writeFile(clip, clipBytes)
  empty = join(root, 'empty.mp4')
  await writeFile(empty, Buffer.alloc(0))
  notes = join(root, 'notes.txt')
  await writeFile(notes, 'not a video')
  directory = join(root, 'shot.mp4')
  await mkdir(directory)
})

describe('videoMediaType', () => {
  it('accepts the declared suffix only, case-insensitively', () => {
    expect(videoMediaType('/a/b/clip.mp4')).toBe('video/mp4')
    expect(videoMediaType('renders/shot/v001.MP4')).toBe('video/mp4')
    expect(videoMediaType('renders/shot/v001.mov')).toBeUndefined()
    expect(videoMediaType('notes.txt')).toBeUndefined()
    expect(videoMediaType('mp4')).toBeUndefined()
  })
})

describe('stream handler', () => {
  beforeEach(() => { windows = [] })

  it('serves a whole absolute path with the streaming headers', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe('inline')
    expect(response.headers.get('content-length')).toBe(String(SIZE))
    expect(Buffer.from(await response.arrayBuffer()).equals(clipBytes)).toBe(true)
    // One window per pull, never the whole file at once.
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.every(entry => entry.length <= STREAM_WINDOW_BYTES)).toBe(true)
    expect(windows[0]?.offset).toBe(0)
  })

  it('answers a byte range with 206 and a correct content-range', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { headers: { range: 'bytes=100-199' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 100-199/${SIZE}`)
    expect(response.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await response.arrayBuffer()).equals(clipBytes.subarray(100, 200))).toBe(true)
  })

  it('streams a range wider than one window without buffering it in one read', async () => {
    const end = STREAM_WINDOW_BYTES * 2 - 1
    const response = await call(`path=${encodeURIComponent(clip)}`, { headers: { range: `bytes=0-${end}` } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe(String(STREAM_WINDOW_BYTES * 2))
    expect(Buffer.from(await response.arrayBuffer()).equals(clipBytes.subarray(0, STREAM_WINDOW_BYTES * 2))).toBe(true)
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.every(entry => entry.length <= STREAM_WINDOW_BYTES)).toBe(true)
  })

  it('reads an open-ended range to the last byte', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { headers: { range: 'bytes=1048576-' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 1048576-${SIZE - 1}/${SIZE}`)
    expect((await response.arrayBuffer()).byteLength).toBe(SIZE - 1048576)
  })

  it('answers an unsatisfiable range with 416 and the entity size', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { headers: { range: `bytes=${SIZE + 10}-` } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${SIZE}`)
  })

  it('treats a range header it cannot use as the whole entity', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { headers: { range: 'bytes=0-1,5-6' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(SIZE))
  })

  it('answers HEAD with the length and no body', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(SIZE))
    expect(await response.text()).toBe('')
  })

  it('serves a session-relative path against that session workspace', async () => {
    const response = await call(`path=${encodeURIComponent('clip.mp4')}&sessionId=session-a`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(clipBytes)).toBe(true)
  })

  it('refuses a relative path without a usable session', async () => {
    for (const query of [
      `path=clip.mp4`,
      `path=clip.mp4&sessionId=`,
      `path=clip.mp4&sessionId=session-unknown`,
    ]) {
      const response = await call(query)
      expect(response.status).toBe(409)
    }
  })

  it('serves an absolute path outside the workspace, as /api/file already does', async () => {
    const other = join(outside, 'other.mp4')
    await writeFile(other, 'tiny')
    const response = await call(`path=${encodeURIComponent(other)}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('tiny')
  })

  it('serves a zero-byte file without hanging', async () => {
    const response = await call(`path=${encodeURIComponent(empty)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('0')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it('refuses anything that is not an mp4', async () => {
    const response = await call(`path=${encodeURIComponent(notes)}`)
    expect(response.status).toBe(415)
  })

  it('refuses a directory, a missing file, and a malformed path', async () => {
    expect((await call(`path=${encodeURIComponent(directory)}`)).status).toBe(403)
    expect((await call(`path=${encodeURIComponent(join(root, 'gone.mp4'))}`)).status).toBe(404)
    expect((await call('path=')).status).toBe(400)
    expect((await call(`path=${encodeURIComponent(join(root, 'cl\u0000ip.mp4'))}`)).status).toBe(400)
  })

  it('refuses a method it does not implement', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })

  it('answers 503 while the workspace filesystem is unavailable', async () => {
    const response = await streamHandler(host(null))(new Request(`http://127.0.0.1${STREAM_ROUTE_PATH}?path=${encodeURIComponent(clip)}`))
    expect(response.status).toBe(503)
  })

  it('maps a backend refusal to its own status rather than a blanket 404', async () => {
    const refusing = (code: string): WorkspaceFs => ({
      ...counting,
      resolve: async () => { throw Object.assign(new Error(code), { code }) },
    })
    const status = async (code: string): Promise<number> => {
      const response = await streamHandler(host(refusing(code)))(new Request(`http://127.0.0.1${STREAM_ROUTE_PATH}?path=${encodeURIComponent(clip)}`))
      return response.status
    }
    expect(await status('FS_SANDBOX_DENIED')).toBe(403)
    expect(await status('FS_PERMISSION_DENIED')).toBe(403)
    expect(await status('FS_TOO_LARGE')).toBe(413)
    expect(await status('FS_NOT_FOUND')).toBe(404)
    expect(await status('FS_ABORTED')).toBe(499)
    // Not a filesystem refusal at all: a host fault, not a missing file.
    expect(await status('ECONNRESET')).toBe(500)
  })

  it('answers with the backend code, never its message', async () => {
    const refusing: WorkspaceFs = {
      ...counting,
      resolve: async () => { throw Object.assign(new Error('/Users/me/secret/project/clip.mp4: EACCES'), { code: 'FS_PERMISSION_DENIED' }) },
    }
    const response = await streamHandler(host(refusing))(new Request(`http://127.0.0.1${STREAM_ROUTE_PATH}?path=${encodeURIComponent(clip)}`))
    expect(response.status).toBe(403)
    const text = await response.text()
    expect(text.trim()).toBe('FS_PERMISSION_DENIED')
    expect(text).not.toContain('/Users/me')
  })

  it('fails the body when the file ends before the promised range', async () => {
    let reads = 0
    const shrinking: WorkspaceFs = {
      ...counting,
      readByteRange: async (target, range, signal) => {
        reads += 1
        // The first window is real; the second finds the file gone short.
        if (reads > 1) return new Uint8Array(0)
        return hostWorkspaceFs.readByteRange(target, range, signal)
      },
    }
    const response = await streamHandler(host(shrinking))(new Request(`http://127.0.0.1${STREAM_ROUTE_PATH}?path=${encodeURIComponent(clip)}`))
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow()
  })

  it('stops reading once the request is aborted', async () => {
    const controller = new AbortController()
    let reads = 0
    const countingAbort: WorkspaceFs = {
      ...counting,
      readByteRange: async (target, range, signal) => {
        reads += 1
        controller.abort()
        return hostWorkspaceFs.readByteRange(target, range, signal)
      },
    }
    const response = await streamHandler(host(countingAbort))(new Request(
      `http://127.0.0.1${STREAM_ROUTE_PATH}?path=${encodeURIComponent(clip)}`,
      { signal: controller.signal },
    ))
    expect(response.status).toBe(200)
    // One window was in flight; the abort ends the body instead of reading on.
    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(reads).toBe(1)
  })

  it('serves a suffix range through the handler too', async () => {
    const response = await call(`path=${encodeURIComponent(clip)}`, { headers: { range: 'bytes=-500' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`)
    expect((await response.arrayBuffer()).byteLength).toBe(500)
  })
})
