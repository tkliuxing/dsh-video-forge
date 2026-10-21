/**
 * The panel API: what the browser surfaces call — the chat cards (live state and
 * cancel), the progress badge and the configuration card.
 *
 * The conversation is the only place a video is made (DESIGN §16.4): nothing
 * here submits a generation or writes a file. Every endpoint calls the same
 * `operations.ts` functions the tools call.
 *
 * The one write this family has is `selection` (M6): the composer chip stores
 * the conversation's provider/model/geometry choice. It lands in the plugin's
 * own `$DSH_HOME` document — not in a workspace file — which is what keeps the
 * "no workbench" boundary intact.
 *
 * Two rules this file exists to enforce:
 *
 * - **Never a secret, only a masked tail.** Credential state is reported as
 *   configured / source / `ab…cd`, which is enough to tell two keys apart and not
 *   enough to use one.
 * - **Never a path from the client.** Every path — the artifact bytes, whether a
 *   video is still where it was written — comes from the ledger, never from a
 *   request.
 */

import { lstat, realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describeProviders, LedgerUnavailableError, listTasks, cancelTask, requireLedger, selectionView, type TaskRow } from './operations.ts'
import type { VideoForgeRuntime } from './runtime.ts'
import { adapterFor, cancelSupported } from './providers/index.ts'
import { isSessionId, parseSelectionInput, SelectionError } from './selection.ts'
import { ConfigError, resolveTarget } from './settings.ts'
import { isTrustedRequest } from './trust.ts'
import type { VideoTask } from './types.ts'

/** Route prefix for the panel API family. */
export const PANEL_ROUTE_PREFIX = '/video-forge/api'

/** Request bodies are small JSON documents; anything larger is not a real request. */
const MAX_BODY_BYTES = 64 * 1024

/** Raised for a malformed request; the handler turns it into a 400. */
class RequestError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    // The panel is live state; a cached answer would show a stale task list.
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { ok: false, error: message })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new RequestError(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RequestError('request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RequestError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RequestError(`${key} must be a string`)
  return value
}

/** A positive whole number from a query parameter, or undefined when absent. */
function numberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  // Digits only: `Number()` would also accept `1e2`, `0x10`, `+5` and `5.0`.
  if (!/^\d+$/.test(raw.trim())) throw new RequestError('limit must be a positive whole number')
  const value = Number.parseInt(raw.trim(), 10)
  if (value < 1) throw new RequestError('limit must be a positive whole number')
  return value
}

/**
 * What the browser half may rely on from this host (M5).
 *
 * `stream` says the Range-capable media route is registered — the video panel
 * and the file viewer's mp4 renderer use it for anything the ledger does not
 * already serve, and fall back to the harness's `/api/file` (bounded, no ranges)
 * when this host could not register it.
 */
export interface PanelFeatures {
  stream: boolean
}

/** Build the handler for the whole family. */
export function panelHandler(
  runtime: VideoForgeRuntime,
  features: () => PanelFeatures = () => ({ stream: false }),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // The harness does not gate plugin routes, so this family decides for itself:
    // loopback or a paired device, nothing else. It reads prompts and can cancel paid tasks.
    if (!isTrustedRequest(runtime.ctx, req)) {
      sendError(res, 403, 'video-forge refuses this request: its panel API is loopback-only unless the browser is a paired device')
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(PANEL_ROUTE_PREFIX.length).replace(/^\//, '')

    try {
      if (action === 'overview') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed')
        // One task, for a chat card: just its row, whether its video is still
        // there, and the in-flight count — no credential lookups, so a page with
        // many cards stays cheap.
        const taskId = url.searchParams.get('taskId')
        if (taskId !== null) {
          if (taskId.trim() === '') return sendError(res, 400, 'taskId must name one task')
          // Answer from the ledger as read, never from an empty unread document
          // that would call every task unknown (a 404 stops a card for good).
          await requireLedger(runtime)
          let list: ReturnType<typeof listTasks>
          try {
            list = listTasks(runtime, { taskId })
          } catch (error: unknown) {
            if (error instanceof ConfigError) return sendError(res, 404, `no video task ${taskId} in this host's ledger`)
            throw error
          }
          sendJson(res, 200, {
            ok: true,
            tasks: await Promise.all(list.tasks.map(async (row: TaskRow) => ({
              ...row,
              artifactState: await artifactState(runtime.ledger.byId(row.taskId)),
              // So the card offers cancel only where the provider can be asked to stop.
              cancelable: cancelableNow(runtime, row),
            }))),
            active: list.active,
          })
          return
        }
        // The video panel asks for a longer list than a chat card ever needs; the
        // projection still clamps anything past its own cap. Validate the query
        // before touching the ledger, as the `taskId` branch does.
        const limit = numberParam(url.searchParams.get('limit')) ?? 50
        await requireLedger(runtime)
        const settings = runtime.settings()
        const list = listTasks(runtime, { limit })
        sendJson(res, 200, {
          ok: true,
          enabled: settings.enabled,
          settings: {
            defaultProvider: settings.defaultProvider,
            defaultModel: settings.defaultModel,
            maxConcurrent: settings.maxConcurrent,
            pollIntervalMs: settings.pollIntervalMs,
            dedupeWindowSeconds: settings.dedupeWindowSeconds,
            outputRoot: runtime.outputRoot(),
          },
          providers: await describeProviders(runtime),
          tasks: list.tasks,
          usage: list.usage,
          active: list.active,
          /** What this host can do for the browser half (M5): the Range-capable stream route. */
          features: features(),
        })
        return
      }

      if (action === 'cancel') {
        if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
        const body = await readJsonBody(req)
        const taskId = stringField(body, 'taskId')
        if (taskId === undefined || taskId === '') throw new RequestError('taskId is required')
        const outcome = await cancelTask(runtime, taskId)
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }

      // The composer chip's choice for one conversation (M6, DESIGN §20): read,
      // write or forget it. GET also carries the model capability matrix the chip
      // renders from, so a popover needs no second request — and the credential
      // state, which is how a model whose key is missing gets marked as such.
      if (action === 'selection') {
        const session = sessionParam(url)
        const settings = runtime.settings()
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, {
            ok: true,
            session,
            enabled: settings.enabled,
            selection: selectionView(await runtime.selections.get(session)),
            defaults: { provider: settings.defaultProvider, model: settings.defaultModel },
            providers: await describeProviders(runtime),
          })
          return
        }
        if (req.method === 'POST') {
          const saved = await runtime.selections.set(session, parseSelectionInput(await readJsonBody(req)))
          sendJson(res, 200, { ok: true, session, selection: selectionView(saved) })
          return
        }
        if (req.method === 'DELETE') {
          await runtime.selections.clear(session)
          sendJson(res, 200, { ok: true, session, selection: null })
          return
        }
        return sendError(res, 405, 'method not allowed')
      }

      sendError(res, 404, `unknown video-forge action "${action}"`)
    } catch (error: unknown) {
      if (error instanceof RequestError || error instanceof SelectionError) {
        sendError(res, 400, error.message)
        return
      }
      if (error instanceof LedgerUnavailableError) {
        sendError(res, 503, error.message)
        return
      }
      // A domain error (bad config, provider refusal) is the operator's to read,
      // so it is reported verbatim rather than flattened into "internal error".
      const message = error instanceof Error ? error.message : String(error)
      runtime.logger.warn(`video-forge: panel ${action} failed: ${message}`)
      sendError(res, 400, message)
    }
  }
}

/**
 * The conversation a `selection` call is about.
 *
 * The chip always knows its session; a request without one is not a chip, and
 * silently defaulting it would write a choice into a conversation that never
 * made it.
 */
function sessionParam(url: URL): string {
  const raw = url.searchParams.get('session')
  if (raw === null || raw.trim() === '') {
    throw new RequestError('session is required: a selection belongs to one conversation')
  }
  const session = raw.trim()
  if (!isSessionId(session)) {
    throw new RequestError('session must be a session id (no whitespace, at most 200 characters)')
  }
  return session
}

/** Whether `video_cancel` could ask the provider to stop this task (configuration as it is now). */
function cancelableNow(runtime: VideoForgeRuntime, row: TaskRow): boolean {
  try {
    const { provider, model } = resolveTarget(runtime.settings(), row.provider, row.model)
    return cancelSupported(provider, model, adapterFor(provider, model))
  } catch {
    return false
  }
}

/**
 * Whether a task's video is still where it was written: `present`, `missing`
 * (moved, deleted, or replaced by something that is not that file), or null
 * when it has none. A workspace video counts only while its real path is the
 * recorded one, as the media route requires before it plays it.
 */
async function artifactState(task: VideoTask | undefined): Promise<'present' | 'missing' | null> {
  const artifact = task?.artifacts[0]
  if (artifact === undefined) return null
  try {
    if (artifact.location?.kind !== 'workspace') {
      // The plugin's own directory: followed, exactly as the media route opens it.
      return (await stat(artifact.path)).isFile() ? 'present' : 'missing'
    }
    const info = await lstat(artifact.path)
    if (!info.isFile()) return 'missing'
    return (await realpath(artifact.path)) === artifact.path ? 'present' : 'missing'
  } catch {
    return 'missing'
  }
}
