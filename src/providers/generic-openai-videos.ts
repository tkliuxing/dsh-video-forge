/**
 * `generic-openai-videos` — the OpenAI-Videos-shaped family (`POST /v1/videos`,
 * `GET /v1/videos/{id}`, `…/content`, `DELETE /v1/videos/{id}`), which in
 * practice means relay stations and gateways rather than one vendor.
 *
 * Because a relay's body nesting is not knowable ahead of time, every path and
 * every status word is configuration (DESIGN §7.1). This adapter never guesses
 * a field name: an absent path yields null, and an unrecognized status stays
 * `unknown` instead of being rounded to "running".
 */

import type { EndpointSetting } from '../settings.ts'
import { resolveSize, statusWords, type ModelSetting } from '../settings.ts'
import type { GenerationRequest, ProviderTaskState, ResolvedMaterial } from '../types.ts'
import {
  excerpt,
  normalizeStatus,
  ProviderRequestError,
  requestJson,
  requestRaw,
  type AdapterContext,
  type ProtocolAdapter,
  usageOf,
} from './adapter.ts'
import { fillTemplate, readNumber, readPath, readString } from './dot-path.ts'

export interface OpenAiVideosOptions {
  endpoints: EndpointSetting
  /** Declared geometry, used to render `size` when the provider takes one. */
  model: ModelSetting
}

/** Fill `{id}` in one configured path. */
export function endpointPath(template: string, providerTaskId: string | null): string {
  return fillTemplate(template, providerTaskId === null ? {} : { id: providerTaskId })
}

function absolute(baseUrl: string, path: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return path.startsWith('/') ? `${trimmed}${path}` : `${trimmed}/${path}`
}

/** Decode a `data:` URL into bytes, or null when the material is a remote URL. */
export function bytesOfDataUrl(url: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
  if (match === null) return null
  const [, mime = 'application/octet-stream', base64, payload = ''] = match
  if (base64 === undefined) return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime }
  return { bytes: Uint8Array.from(Buffer.from(payload, 'base64')), mime }
}

/** Body of one create request in its JSON form; exported for tests. */
export function buildOpenAiVideosBody(
  request: GenerationRequest,
  model: ModelSetting,
  size: string | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model, prompt: request.prompt }
  if (request.durationSeconds !== null) body.seconds = String(request.durationSeconds)
  if (size !== null) body.size = size
  // A remote first frame cannot be uploaded as a file here; a relay that accepts
  // a URL passes it through, and one that does not reports it on submit.
  if (request.firstFrame !== null && bytesOfDataUrl(request.firstFrame.url) === null) {
    body.input_reference = request.firstFrame.url
  }
  return body
}

/** Whether this request must be sent as multipart rather than JSON. */
export function needsMultipart(request: GenerationRequest): boolean {
  return request.firstFrame !== null && bytesOfDataUrl(request.firstFrame.url) !== null
}

export function openAiVideosAdapter(options: OpenAiVideosOptions): ProtocolAdapter {
  const { endpoints, model } = options

  return {
    id: 'generic-openai-videos',
    cancelable: true,

    async submit(context: AdapterContext, request: GenerationRequest) {
      const url = absolute(context.baseUrl, endpointPath(endpoints.submit, null))
      let response: unknown
      if (needsMultipart(request) && request.firstFrame !== null) {
        response = await submitMultipart(context, url, request, model, endpoints)
      } else {
        const size = resolveSize(model, request.resolution, request.aspectRatio)
        response = await requestJson(context, url, { method: 'POST', body: buildOpenAiVideosBody(request, model, size) })
      }
      const id = readString(response, endpoints.idPath)
      if (id === null || id === '') {
        throw new ProviderRequestError('generic-openai-videos: the create response carried no task id', {
          bodyExcerpt: excerpt(JSON.stringify(response ?? null)),
        })
      }
      return { providerTaskId: id }
    },

    async query(context: AdapterContext, providerTaskId: string) {
      const url = absolute(context.baseUrl, endpointPath(endpoints.query, providerTaskId))
      const response = await requestJson(context, url, { method: 'GET' })
      return readState(response, endpoints, providerTaskId, context.baseUrl)
    },

    async cancel(context: AdapterContext, providerTaskId: string) {
      const url = absolute(context.baseUrl, endpointPath(endpoints.cancel, providerTaskId))
      const result = await requestRaw(context, url, { method: 'DELETE' })
      return result.status >= 200 && result.status < 300
    },
  }
}

async function submitMultipart(
  context: AdapterContext,
  url: string,
  request: GenerationRequest,
  model: ModelSetting,
  endpoints: EndpointSetting,
): Promise<unknown> {
  const first = request.firstFrame
  if (first === null) throw new ProviderRequestError('generic-openai-videos: multipart submit requires a first frame')
  const decoded = bytesOfDataUrl(first.url)
  if (decoded === null) throw new ProviderRequestError('generic-openai-videos: first frame is not inline bytes')

  const form = new FormData()
  form.set('model', request.model)
  form.set('prompt', request.prompt)
  const size = resolveSize(model, request.resolution, request.aspectRatio)
  if (size !== null) form.set('size', size)
  if (request.durationSeconds !== null) form.set('seconds', String(request.durationSeconds))
  form.set('input_reference', new Blob([decoded.bytes as unknown as BlobPart], { type: decoded.mime }), `input${extensionOf(decoded.mime)}`)

  // `requestRaw` omits content-type on purpose: fetch must set the boundary.
  const result = await requestRaw(context, url, { method: 'POST', body: form })
  if (result.status < 200 || result.status >= 300) {
    throw new ProviderRequestError(`POST ${url} failed with HTTP ${result.status}`, {
      status: result.status,
      bodyExcerpt: excerpt(result.text),
    })
  }
  try {
    return JSON.parse(result.text) as unknown
  } catch {
    throw new ProviderRequestError(`POST ${url} returned a non-JSON body`, { status: result.status, bodyExcerpt: excerpt(result.text) })
  }
  // `endpoints` is threaded through for symmetry with the JSON path; multipart
  // has no per-endpoint extraction, only the shared `idPath` read by the caller.
  void endpoints
}

function extensionOf(mime: string): string {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  return '.jpg'
}

/** Read one query body into provider-neutral state. */
export function readState(body: unknown, endpoints: EndpointSetting, providerTaskId: string, baseUrl: string): ProviderTaskState {
  const raw = readString(body, endpoints.statusPath)
  const normalized = normalizeStatus(raw, {
    queued: statusWords(endpoints.statusQueued),
    running: statusWords(endpoints.statusRunning),
    succeeded: statusWords(endpoints.statusSucceeded),
    failed: statusWords(endpoints.statusFailed),
    cancelled: statusWords(endpoints.statusCancelled),
  })

  const progressRaw = readNumber(body, endpoints.progressPath)
  const progress = progressRaw === null ? null : clamp01(progressRaw > 1 ? progressRaw / 100 : progressRaw)

  const url = readString(body, endpoints.resultUrlPath)
  // A provider that answers with the artifact itself (OpenAI's `…/content`)
  // reports no URL; the content endpoint is then the artifact address.
  const fallback = normalized.status === 'succeeded'
    ? absolute(baseUrl, endpointPath(endpoints.content, providerTaskId))
    : null

  const errorValue = readPath(body, endpoints.errorPath)
  const errorMessage = typeof errorValue === 'string'
    ? errorValue
    : (typeof errorValue === 'object' && errorValue !== null ? readString(errorValue, 'message') : null)

  return {
    status: normalized.status,
    progress,
    videoUrl: url ?? fallback,
    error: normalized.status === 'failed'
      ? { message: errorMessage ?? `task reported status "${raw ?? 'unknown'}"`, code: null }
      : null,
    terminal: normalized.terminal,
    // Gateways differ; keep whatever numbers a `usage` object carries, with no billing basis assumed.
    usage: usageOf(readPath(body, 'usage'), {}),
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
