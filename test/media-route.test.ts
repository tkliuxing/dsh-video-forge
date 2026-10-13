/**
 * The media route: range parsing (which nothing in the harness implements), the
 * path shape, and the authorization rule that only a task id plus token pair
 * reaches the filesystem.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Ledger } from '../src/ledger.ts'
import { mediaHandler, mediaSegments, parseRange } from '../src/media-route.ts'
import { MEDIA_ROUTE_PREFIX } from '../src/settings.ts'
import type { VideoTask } from '../src/types.ts'

describe('parseRange', () => {
  it('reads a bounded range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
  })

  it('reads an open-ended range to the last byte', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
  })

  it('clamps an end past the file', () => {
    expect(parseRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('reads a suffix range', () => {
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('reports an unsatisfiable range', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=10-5', 1000)).toBe('unsatisfiable')
  })

  it('ignores a header it cannot use, which means "send the whole entity"', () => {
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=0-1, 5-6', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })
})

describe('mediaSegments', () => {
  it('splits the route and rejects a foreign path', () => {
    expect(mediaSegments(`${MEDIA_ROUTE_PREFIX}/v-1/tok/out.mp4`)).toEqual(['v-1', 'tok', 'out.mp4'])
    expect(mediaSegments(MEDIA_ROUTE_PREFIX)).toBeNull()
    expect(mediaSegments('/other/media/v-1/tok/out.mp4')).toBeNull()
  })

  it('does not allow a traversal segment to escape', () => {
    // The segment stays a literal string; nothing joins it to a path.
    expect(mediaSegments(`${MEDIA_ROUTE_PREFIX}/v-1/tok/..%2F..%2Fetc%2Fpasswd`)).toEqual(['v-1', 'tok', '../../etc/passwd'])
  })
})

describe('media handler over a real socket', () => {
  let server: Server
  let base: string
  let ledger: Ledger
  const body = Buffer.from('0123456789')

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-forge-media-'))
    const artifactPath = join(root, 'clip.mp4')
    await writeFile(artifactPath, body)
    ledger = new Ledger({ path: join(root, 'tasks.json'), maxTasks: 10, maxGiB: 1 })
    await ledger.load()
    const task: VideoTask = {
      localId: 'v-20261013-0001',
      provider: 'ark',
      protocol: 'ark-seedance',
      model: 'm',
      providerTaskId: 'p',
      status: 'succeeded',
      progress: 1,
      submittedAt: '2026-10-13T00:00:00.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
      paramsFingerprint: 'fp',
      params: { prompt: 'p', mode: 't2v', durationSeconds: null, resolution: null, aspectRatio: null, firstFrame: null, lastFrame: null, referenceImages: [] },
      artifacts: [{
        path: artifactPath,
        bytes: body.byteLength,
        mime: 'video/mp4',
        width: null,
        height: null,
        durationSec: null,
        token: 'a'.repeat(32),
        createdAt: '2026-10-13T00:00:00.000Z',
      }],
      error: null,
    }
    await ledger.add(task)

    server = createServer((req, res) => { void mediaHandler(ledger)(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  })

  const url = (task: string, token: string, name = 'clip.mp4'): string => `${base}${MEDIA_ROUTE_PREFIX}/${task}/${token}/${name}`

  it('serves the whole artifact with the hardening headers', async () => {
    const response = await fetch(url('v-20261013-0001', 'a'.repeat(32)))
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body)
  })

  it('answers a byte range with 206 and content-range', async () => {
    const response = await fetch(url('v-20261013-0001', 'a'.repeat(32)), { headers: { range: 'bytes=2-5' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(response.headers.get('content-length')).toBe('4')
    expect(await response.text()).toBe('2345')
  })

  it('answers an unsatisfiable range with 416', async () => {
    const response = await fetch(url('v-20261013-0001', 'a'.repeat(32)), { headers: { range: 'bytes=99-' } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  it('answers HEAD with the headers and no body', async () => {
    const response = await fetch(url('v-20261013-0001', 'a'.repeat(32)), { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('10')
    expect(await response.text()).toBe('')
  })

  it('treats a wrong token, unknown task, or short path as not found', async () => {
    for (const target of [
      url('v-20261013-0001', 'b'.repeat(32)),
      url('v-20261013-9999', 'a'.repeat(32)),
      `${base}${MEDIA_ROUTE_PREFIX}/v-20261013-0001/a`,
    ]) {
      const response = await fetch(target)
      expect(response.status).toBe(404)
    }
  })

  it('refuses a method it does not implement', async () => {
    const response = await fetch(url('v-20261013-0001', 'a'.repeat(32)), { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })
})
