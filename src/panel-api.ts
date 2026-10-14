/**
 * The workbench API: what the browser panel calls.
 *
 * The panel cannot invoke host tools — a tool call belongs to an agent turn — so
 * the workbench needs its own surface. It is deliberately thin: every endpoint
 * calls the same `operations.ts` functions the tools call, so a browser submission
 * and a model submission cannot diverge in validation, de-duplication or watching.
 *
 * Two rules this file exists to enforce:
 *
 * - **Never a secret, only a masked tail.** Credential state is reported as
 *   configured / source / `ab…cd`, which is enough to tell two keys apart and not
 *   enough to use one.
 * - **Never a path from the client.** Export takes a target path (the operator
 *   asked for that file), but every *read* path — the artifact bytes — comes from
 *   the ledger in `media-route.ts`, never from a request body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describeProviders, exportArtifact, generate, listTasks, cancelTask, type GenerateInput } from './operations.ts'
import type { VideoForgeRuntime } from './runtime.ts'
import { isTrustedRequest } from './trust.ts'
import { VIDEO_MODES, type VideoMode } from './types.ts'

/** Route prefix for the workbench API family. */
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

function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new RequestError(`${key} must be a boolean`)
  return value
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new RequestError(`${key} must be a number`)
  return value
}

function stringListField(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new RequestError(`${key} must be an array of strings`)
  }
  return value as string[]
}

function modeField(body: Record<string, unknown>, key: string): VideoMode | undefined {
  const value = stringField(body, key)
  if (value === undefined) return undefined
  if (!VIDEO_MODES.includes(value as VideoMode)) throw new RequestError(`${key} must be one of ${VIDEO_MODES.join(', ')}`)
  return value as VideoMode
}

/** Build the handler for the whole family. */
export function panelHandler(runtime: VideoForgeRuntime): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // The harness does not gate plugin routes, so this family decides for itself:
    // loopback or a paired device, nothing else. It reads prompts and spends money.
    if (!isTrustedRequest(runtime.ctx, req)) {
      sendError(res, 403, 'video-forge refuses this request: the workbench API is loopback-only unless the browser is a paired device')
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(PANEL_ROUTE_PREFIX.length).replace(/^\//, '')

    try {
      if (action === 'overview') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed')
        const settings = runtime.settings()
        const list = listTasks(runtime, { limit: 50 })
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
        })
        return
      }

      if (action === 'generate') {
        if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
        const body = await readJsonBody(req)
        const prompt = stringField(body, 'prompt')
        if (prompt === undefined || prompt.trim() === '') throw new RequestError('prompt is required')
        const input: GenerateInput = {
          prompt,
          provider: stringField(body, 'provider'),
          model: stringField(body, 'model'),
          mode: modeField(body, 'mode'),
          firstFrame: stringField(body, 'firstFrame'),
          lastFrame: stringField(body, 'lastFrame'),
          referenceImages: stringListField(body, 'referenceImages'),
          durationSeconds: numberField(body, 'durationSeconds') ?? null,
          resolution: stringField(body, 'resolution'),
          aspectRatio: stringField(body, 'aspectRatio'),
        }
        // No agent owns a browser submission, so the watch starts unowned; the
        // panel is the surface that reports its progress.
        const outcome = await generate(runtime, input, { waitSeconds: 0 })
        sendJson(res, 200, {
          ok: true,
          task: outcome.task,
          jobId: outcome.jobId,
          message: outcome.message,
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

      if (action === 'export') {
        if (req.method !== 'POST') return sendError(res, 405, 'method not allowed')
        const body = await readJsonBody(req)
        const taskId = stringField(body, 'taskId')
        const targetPath = stringField(body, 'targetPath')
        if (taskId === undefined || taskId === '') throw new RequestError('taskId is required')
        if (targetPath === undefined || targetPath === '') throw new RequestError('targetPath is required')
        const outcome = await exportArtifact(runtime, taskId, targetPath, booleanField(body, 'overwrite') === true)
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }

      sendError(res, 404, `unknown workbench action "${action}"`)
    } catch (error: unknown) {
      if (error instanceof RequestError) {
        sendError(res, 400, error.message)
        return
      }
      // A domain error (bad config, provider refusal) is the operator's to read,
      // so it is reported verbatim rather than flattened into "internal error".
      const message = error instanceof Error ? error.message : String(error)
      runtime.logger.warn(`video-forge: workbench ${action} failed: ${message}`)
      sendError(res, 400, message)
    }
  }
}
