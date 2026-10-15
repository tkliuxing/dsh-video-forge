/**
 * The provider's API key goes with an artifact download only to the provider's
 * own origin. A vendor CDN or a relay's presigned third-party URL never sees it.
 */

import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { downloadArtifact } from '../src/download.ts'

async function artifactHost(): Promise<{ url: string; seen: IncomingHttpHeaders[]; close: () => Promise<void> }> {
  const seen: IncomingHttpHeaders[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(Buffer.alloc(64))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise(resolve => server.close(() => resolve())) }
}

describe('downloading an artifact', () => {
  it('sends the key to the API origin', async () => {
    const host = await artifactHost()
    try {
      await downloadArtifact({
        url: `${host.url}/v1/videos/1/content`, apiKey: 'sk-test', apiOrigin: `${host.url}/v1`,
        directory: await mkdtemp(join(tmpdir(), 'video-forge-dl-')), localId: 'v-1', fetch,
      })
      expect(host.seen[0]?.authorization).toBe('Bearer sk-test')
    } finally {
      await host.close()
    }
  })

  it('does not send it to another origin, or when the origin is unknown', async () => {
    const host = await artifactHost()
    try {
      for (const apiOrigin of ['https://ark.cn-beijing.volces.com/api/v3', null]) {
        await downloadArtifact({
          url: `${host.url}/bucket/v.mp4?X-Signature=abc`, apiKey: 'sk-test', apiOrigin,
          directory: await mkdtemp(join(tmpdir(), 'video-forge-dl-')), localId: 'v-1', fetch,
        })
      }
      expect(host.seen.map(headers => headers.authorization)).toEqual([undefined, undefined])
    } finally {
      await host.close()
    }
  })
})
