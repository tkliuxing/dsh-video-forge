/**
 * A fake online provider, spoken over a real HTTP socket.
 *
 * This exists because the whole plugin is a client of models we cannot call in
 * CI: a fixture that answers on 127.0.0.1 in the *documented shapes* of the two
 * first-period protocols lets the full path — submit, poll, terminal state,
 * artifact download — run as a test, with no key and no network.
 *
 * It can also misbehave on purpose — lose a submit response after creating the
 * task, hold it, or refuse it — so the intent-first submission path (DESIGN §6)
 * is exercised against the failure it exists for.
 *
 * It is deliberately faithful to what the vendors publish (see DESIGN §7.1) and
 * deliberately dumb about everything else. It proves our shape assumptions are
 * self-consistent; it cannot prove a real vendor agrees, and no test here
 * pretends otherwise.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FixtureMode = 'ark' | 'openai-videos'

export interface FixtureOptions {
  /** Which protocol shape to speak. */
  mode: FixtureMode
  /** Polls to answer `running` before the task succeeds. */
  pollsBeforeDone?: number
  /** Fail the task after this many polls instead of succeeding. */
  failAfterPolls?: number
  /** Report the ARK `expired` status instead of `succeeded`. */
  expire?: boolean
  /** Bytes of the artifact body. */
  artifactBytes?: number
  /** Require exactly this bearer token. */
  apiKey?: string
  /**
   * Accept (and create) this many submissions, then destroy the socket instead
   * of answering: the provider has a billable task, the client has no id.
   */
  loseSubmitResponses?: number
  /** Hold every submit response this long, so a caller can abort mid-request. */
  submitDelayMs?: number
  /** Refuse every submission with this HTTP status and an error body; nothing is created. */
  rejectSubmitStatus?: number
}

/** One task the fixture created, as its ARK task list reports it. */
export interface FixtureTask {
  id: string
  model: string | null
  /** Epoch seconds, ARK's unit. */
  createdAt: number
}

export interface FixtureRequest {
  method: string
  path: string
  authorization: string | null
  body: string
}

export interface Fixture {
  url: string
  requests: FixtureRequest[]
  /** Every task the fixture created, including those whose response it lost. */
  created: FixtureTask[]
  close(): Promise<void>
}

/** Start the fixture provider and return its base URL. */
export async function startFixture(options: FixtureOptions): Promise<Fixture> {
  const pollsBeforeDone = options.pollsBeforeDone ?? 1
  const artifact = Buffer.alloc(options.artifactBytes ?? 2048, 7)
  const polls = new Map<string, number>()
  const requests: FixtureRequest[] = []
  const created: FixtureTask[] = []
  let counter = 0
  let lost = 0

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const path = req.url ?? '/'
    requests.push({ method: req.method ?? 'GET', path, authorization: req.headers.authorization ?? null, body })

    const auth = req.headers.authorization ?? null
    if (options.apiKey !== undefined && auth !== `Bearer ${options.apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unauthorized', code: 'unauthorized' } }))
      return
    }

    // Both protocols eventually hand back bytes from somewhere; ARK does it
    // through an absolute artifact URL, so the fixture must serve that too.
    if (req.method === 'GET' && path.startsWith('/artifact/')) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(artifact.byteLength) })
      res.end(artifact)
      return
    }

    if (req.method === 'POST' && options.rejectSubmitStatus !== undefined) {
      res.writeHead(options.rejectSubmitStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'InvalidParameter', message: 'fixture refused the submission' } }))
      return
    }

    if (options.mode === 'ark') {
      await handleArk(req, res, path, body)
      return
    }
    await handleOpenAi(req, res, path, body)
  }

  async function handleArk(req: IncomingMessage, res: ServerResponse, path: string, body: string): Promise<void> {
    if (req.method === 'POST' && path.endsWith('/contents/generations/tasks')) {
      counter += 1
      const id = `cgt-fixture-${counter}`
      polls.set(id, 0)
      created.push({ id, model: modelOf(body), createdAt: Math.floor(Date.now() / 1000) })
      await answerSubmit(res, { id })
      return
    }
    if (req.method === 'GET' && /\/contents\/generations\/tasks(\?.*)?$/.test(path)) {
      // The task list, newest first, in ARK's documented paging shape.
      const query = new URL(path, 'http://fixture').searchParams
      const pageNum = Number(query.get('page_num') ?? '1')
      const pageSize = Number(query.get('page_size') ?? '20')
      const newest = [...created].reverse()
      const page = newest.slice((pageNum - 1) * pageSize, pageNum * pageSize)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        total: newest.length,
        items: page.map(task => ({ id: task.id, model: task.model, status: 'queued', created_at: task.createdAt, updated_at: task.createdAt })),
      }))
      return
    }
    const match = /\/contents\/generations\/tasks\/([^/?]+)$/.exec(path)
    if (match !== null) {
      const id = match[1] ?? ''
      if (req.method === 'DELETE') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const count = (polls.get(id) ?? 0) + 1
      polls.set(id, count)
      const state = stateOf(id, count)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (state === 'succeeded') {
        res.end(JSON.stringify({
          id,
          model: 'doubao-seedance-fixture',
          status: 'succeeded',
          content: { video_url: `${baseUrl()}/artifact/${id}.mp4` },
          usage: { completion_tokens: 1, total_tokens: 1 },
          duration: 5,
          ratio: '16:9',
          resolution: '720p',
        }))
        return
      }
      if (state === 'failed') {
        res.end(JSON.stringify({ id, status: 'failed', error: { code: 'InternalError', message: 'fixture failure' } }))
        return
      }
      res.end(JSON.stringify({ id, status: state }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fixture: no ARK route for ${req.method} ${path}` } }))
    void body
  }

  async function handleOpenAi(req: IncomingMessage, res: ServerResponse, path: string, body: string): Promise<void> {
    if (req.method === 'POST' && /\/videos\/?$/.test(path)) {
      counter += 1
      const id = `video-fixture-${counter}`
      polls.set(id, 0)
      created.push({ id, model: modelOf(body), createdAt: Math.floor(Date.now() / 1000) })
      await answerSubmit(res, { id, status: 'queued' })
      return
    }
    const match = /\/videos\/([^/?]+)(\/content)?$/.exec(path)
    if (match !== null) {
      const id = match[1] ?? ''
      const isContent = match[2] !== undefined
      if (isContent) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(artifact.byteLength) })
        res.end(artifact)
        return
      }
      if (req.method === 'DELETE') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      const count = (polls.get(id) ?? 0) + 1
      polls.set(id, count)
      const state = stateOf(id, count)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (state === 'succeeded') {
        // Deliberately no URL: the OpenAI shape hands back bytes at `…/content`,
        // so this also exercises the adapter's content-endpoint fallback.
        res.end(JSON.stringify({ id, status: 'completed', progress: 100 }))
        return
      }
      if (state === 'failed') {
        res.end(JSON.stringify({ id, status: 'failed', error: { message: 'fixture failure' } }))
        return
      }
      res.end(JSON.stringify({ id, status: 'in_progress', progress: 50 }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `fixture: no OpenAI route for ${req.method} ${path}` } }))
    void body
  }

  /** Answer a submission, after the configured delay — or lose the answer entirely. */
  async function answerSubmit(res: ServerResponse, body: unknown): Promise<void> {
    if (options.submitDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.submitDelayMs))
    if (lost < (options.loseSubmitResponses ?? 0)) {
      lost += 1
      res.socket?.destroy()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  function stateOf(id: string, count: number): string {
    if (options.failAfterPolls !== undefined && count > options.failAfterPolls) return 'failed'
    if (count > pollsBeforeDone) return options.expire === true ? 'expired' : 'succeeded'
    return count === 1 ? 'queued' : 'running'
  }

  function baseUrl(): string {
    const address = server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: baseUrl(),
    requests,
    created,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined || error === null ? resolve() : reject(error)))
    }),
  }
}

function modelOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : null
  } catch {
    return null
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
