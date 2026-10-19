/**
 * The stream route's wiring (M5), against the real connection service.
 *
 * The handler's own behaviour is covered next to it; what this file pins down is
 * the part a unit test on the handler cannot: that the exact path is accepted by
 * the connection's route validation, that the owner peer reaches it and the route
 * dispatches, that a duplicate is reported instead of thrown, and that disposing
 * the registering scope withdraws the route and tells the panel API so. That last
 * one is the whole reason the registration is one effect.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { beforeAll, describe, expect, it } from 'vitest'
import { STREAM_ROUTE_PATH, registerStreamRoute, type StreamScope } from '../src/stream-route.ts'
import { hostWorkspaceFs } from '../src/workspace-fs.ts'

let clip: string

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-forge-wiring-'))
  clip = join(root, 'clip.mp4')
  await writeFile(clip, 'tiny-video-bytes')
})

/** Mount a bare connection service (no web server, no auth) and hand back its shared handler. */
async function mounted(): Promise<{
  readonly ctx: Context
  readonly connection: HostConnectionService
  readonly shared: ReturnType<HostConnectionService['createSharedFetchHandler']>
  readonly dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin((pluginCtx) => {
    // The auth object is only read on the web-server path this test never takes.
    new HostConnectionService(pluginCtx, [], {} as never)
  })
  await fiber.await()
  const connection = ctx.get('connection') as HostConnectionService
  return { ctx, connection, shared: connection.createSharedFetchHandler('/api'), dispose: () => fiber.dispose() }
}

/** Mount the registration on a child plugin scope, as the plugin does inside `ctx.inject`. */
async function register(ctx: Context, sink: { flags: boolean[]; warnings: string[] }) {
  const fiber = ctx.plugin((scope) => {
    registerStreamRoute(scope as unknown as StreamScope, {
      fs: () => hostWorkspaceFs,
      sessions: () => undefined,
      setRegistered: (registered) => { sink.flags.push(registered) },
      warn: (message) => { sink.warnings.push(message) },
    })
  })
  await fiber.await()
  return fiber
}

const url = (): string => `http://host${STREAM_ROUTE_PATH}?path=${encodeURIComponent(clip)}`

describe('registerStreamRoute over the real connection', () => {
  it('serves the owner, withdraws on dispose, and reports both', async () => {
    const { ctx, connection, shared, dispose } = await mounted()
    try {
      const sink = { flags: [] as boolean[], warnings: [] as string[] }
      const fiber = await register(ctx, sink)

      const served = await shared.fetch(new Request(url()), connection.browserPeer)
      expect(served.status).toBe(200)
      expect(await served.text()).toBe('tiny-video-bytes')

      await fiber.dispose()
      expect(sink.flags).toEqual([true, false])
      expect(sink.warnings).toEqual([])
      const withdrawn = await shared.fetch(new Request(url()), connection.browserPeer)
      expect(withdrawn.status).toBe(404)
    } finally {
      await dispose()
    }
  })

  it('reports a duplicate registration instead of throwing, and stays off', async () => {
    const { ctx, connection, shared, dispose } = await mounted()
    try {
      // Somebody already holds the path (two instances of this plugin, or another
      // package). That is an off state, not a crash: the browser falls back.
      const holder = connection.fetch.register({
        path: STREAM_ROUTE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => new Response('someone else'),
      })
      const sink = { flags: [] as boolean[], warnings: [] as string[] }
      const fiber = await register(ctx, sink)

      expect(sink.flags).toEqual([])
      expect(sink.warnings).toHaveLength(1)
      expect(sink.warnings[0]).toContain('could not register')
      // The other holder still answers.
      expect(await (await shared.fetch(new Request(url()), connection.browserPeer)).text()).toBe('someone else')

      await fiber.dispose()
      await holder()
    } finally {
      await dispose()
    }
  })
})
