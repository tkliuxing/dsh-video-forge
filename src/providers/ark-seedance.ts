/**
 * 火山方舟 Seedance — `POST/GET/DELETE {base}/contents/generations/tasks`.
 *
 * Shapes verified against the official docs on 2026-10-13 (DESIGN §7.1). ARK
 * names the geometry `ratio`, accepts a local image as a base64 data URL, and
 * reports its own status vocabulary (`succeeded` / `expired` / …), so the
 * mapping below is explicit rather than a guess.
 */

import { readPath, readString } from './dot-path.ts'
import type { GenerationRequest, ProviderTaskState } from '../types.ts'
import {
  excerpt,
  normalizeStatus,
  ProviderRequestError,
  requestJson,
  requestRaw,
  type AdapterContext,
  type ProtocolAdapter,
} from './adapter.ts'

const STATUS_TABLE = {
  queued: ['queued', 'pending'],
  running: ['running', 'in_progress', 'processing', 'generating'],
  succeeded: ['succeeded', 'success', 'completed'],
  // `expired` is ARK's own verdict on a task that outlived its threshold: it is
  // a terminal failure for us, not a task we may keep polling.
  failed: ['failed', 'error', 'expired', 'timeout'],
  cancelled: ['cancelled', 'canceled'],
} as const

/** Role names inside `content[]`. Seedance 1.x/2.x use these; a model may override them. */
export interface ArkRoles {
  first: string
  last: string
  reference: string
}

export interface ArkSeedanceOptions {
  roles: ArkRoles
  /** Whether the request asks for a synchronized audio track when the model can produce one. */
  generateAudio: boolean
  /** Suppress the provider's own watermark unless the operator asks for it. */
  watermark: boolean
}

interface ImageItem {
  type: 'image_url'
  image_url: { url: string }
  role: string
}

/** Build the `content[]` array for one mutually exclusive input scenario. */
export function buildArkContent(request: GenerationRequest, roles: ArkRoles): unknown[] {
  const content: unknown[] = [{ type: 'text', text: request.prompt }]
  const image = (url: string, role: string): ImageItem => ({ type: 'image_url', image_url: { url }, role })

  if (request.mode === 'i2v' || request.mode === 'flf2v') {
    if (request.firstFrame !== null) content.push(image(request.firstFrame.url, roles.first))
    if (request.lastFrame !== null) content.push(image(request.lastFrame.url, roles.last))
    return content
  }
  if (request.mode === 's2v') {
    for (const reference of request.referenceImages) content.push(image(reference.url, roles.reference))
  }
  return content
}

/** Body of one create request; exported so tests can pin the shape without a network. */
export function buildArkBody(request: GenerationRequest, options: ArkSeedanceOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    content: buildArkContent(request, options.roles),
    watermark: options.watermark,
  }
  if (request.durationSeconds !== null) body.duration = request.durationSeconds
  if (request.resolution !== null) body.resolution = request.resolution
  if (request.aspectRatio !== null) body.ratio = request.aspectRatio
  if (request.generateAudio !== null) body.generate_audio = request.generateAudio
  else if (options.generateAudio) body.generate_audio = true
  return body
}

/** Read one query response into provider-neutral state. */
export function readArkState(body: unknown): ProviderTaskState {
  const raw = readString(body, 'status')
  const normalized = normalizeStatus(raw, STATUS_TABLE)
  const errorObject = readPath(body, 'error')
  const errorMessage = typeof errorObject === 'object' && errorObject !== null
    ? stringOf((errorObject as Record<string, unknown>).message)
    : stringOf(errorObject)
  const errorCode = typeof errorObject === 'object' && errorObject !== null
    ? stringOf((errorObject as Record<string, unknown>).code)
    : null
  const videoUrl = readString(body, 'content.video_url')
  return {
    status: normalized.status,
    // ARK publishes no progress field; claiming one would be invented data.
    progress: null,
    videoUrl,
    error: normalized.status === 'failed'
      ? { message: errorMessage ?? `task reported status "${raw ?? 'unknown'}"`, code: errorCode }
      : null,
    terminal: normalized.terminal,
  }
}

export function arkVideosAdapter(options: ArkSeedanceOptions): ProtocolAdapter {
  return {
    id: 'ark-seedance',
    cancelable: true,

    async submit(context: AdapterContext, request: GenerationRequest) {
      const body = buildArkBody(request, options)
      const response = await requestJsonSafe(context, `${trimSlash(context.baseUrl)}/contents/generations/tasks`, body)
      const id = readString(response, 'id')
      if (id === null || id === '') {
        throw new ProviderRequestError('ark-seedance: the create response carried no task id', {
          bodyExcerpt: excerpt(JSON.stringify(response ?? null)),
        })
      }
      return { providerTaskId: id }
    },

    async query(context: AdapterContext, providerTaskId: string) {
      const response = await requestJsonSafe(
        context,
        `${trimSlash(context.baseUrl)}/contents/generations/tasks/${encodeURIComponent(providerTaskId)}`,
        null,
      )
      return readArkState(response)
    },

    async cancel(context: AdapterContext, providerTaskId: string) {
      // ARK can only cancel a task that is still queued; a 2xx is the whole answer.
      const result = await requestRaw(context, `${trimSlash(context.baseUrl)}/contents/generations/tasks/${encodeURIComponent(providerTaskId)}`, {
        method: 'DELETE',
        ...(context.signal === undefined ? {} : {}),
      })
      return result.status >= 200 && result.status < 300
    },
  }
}

async function requestJsonSafe(context: AdapterContext, url: string, body: unknown): Promise<unknown> {
  return requestJson(context, url, body === null ? { method: 'GET' } : { method: 'POST', body })
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function stringOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}
