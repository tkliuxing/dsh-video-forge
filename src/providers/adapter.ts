/**
 * Provider adapters. Each adapter speaks one online protocol and nothing else:
 * it turns a provider-neutral {@link GenerationRequest} into one submit call,
 * reads one poll response, and optionally asks the provider to cancel.
 *
 * Deliberately absent: any local inference path, and any artifact muxing. Every
 * protocol here returns a downloadable MP4 (DESIGN §1, P5).
 */

import type { GenerationRequest, ModerationStage, ProviderTaskState, ProviderTaskSummary, ProviderUsage, VideoTaskError } from '../types.ts'

/** Resolved transport facts for one call. */
export interface AdapterContext {
  baseUrl: string
  /** Resolved credential, or null when the endpoint needs none (a localhost relay). */
  apiKey: string | null
  /** Injected so tests can drive the adapters without a network. */
  fetch: typeof globalThis.fetch
  /** Aborts the in-flight request; never the published task (see DESIGN §6). */
  signal: AbortSignal | undefined
}

/** One online protocol. */
export interface ProtocolAdapter {
  readonly id: string
  /** Whether the provider documents a cancel operation. */
  readonly cancelable: boolean
  submit(context: AdapterContext, request: GenerationRequest): Promise<{ providerTaskId: string }>
  query(context: AdapterContext, providerTaskId: string): Promise<ProviderTaskState>
  /** Ask the provider to stop. Returns false when it refused or does not support it. */
  cancel(context: AdapterContext, providerTaskId: string): Promise<boolean>
  /**
   * List the tasks the provider created inside `[from, to]` (epoch ms), when it
   * documents a task-list endpoint. Absent on protocols that have none: an
   * unconfirmed submission there can only be reported, never recovered.
   */
  listCreated?(context: AdapterContext, window: { from: number; to: number; model: string }): Promise<ProviderTaskSummary[]>
}

/**
 * A provider or transport failure with the HTTP status and a bounded body
 * excerpt. When the body is the provider's own structured error, its code and
 * message are lifted into `providerCode` and into the error message itself:
 * "your account has not activated this model" is the one sentence an operator
 * needs, and every surface — tool result, workbench, ledger — shows the message.
 */
export class ProviderRequestError extends Error {
  readonly status: number | null
  readonly bodyExcerpt: string | null
  readonly providerCode: string | null
  /** The provider's own explanation, when its error body had one. */
  readonly providerMessage: string | null

  constructor(message: string, options: { status?: number | null; bodyExcerpt?: string | null; providerCode?: string | null; providerMessage?: string | null; cause?: unknown } = {}) {
    super(message)
    this.name = 'ProviderRequestError'
    this.status = options.status ?? null
    this.bodyExcerpt = options.bodyExcerpt ?? null
    this.providerCode = options.providerCode ?? null
    this.providerMessage = options.providerMessage ?? null
    if (options.cause !== undefined) this.cause = options.cause
  }
}

/**
 * The provider's own code and message from an error body, if it has the shape of
 * one. Covers what the documented protocols return on a non-2xx answer:
 * `{ error: { code, message } }` (ARK, and MiniMax V2's OpenAI-style
 * `{ type: 'error', error: { type, message } }`) and MiniMax's older
 * `{ base_resp: { status_code, status_msg } }`.
 */
export function providerErrorOf(text: string): { code: string | null; message: string; requestId: string | null } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const nested = record.error
  if (nested !== null && typeof nested === 'object') {
    const error = nested as Record<string, unknown>
    const message = typeof error.message === 'string' ? error.message.trim() : ''
    if (message !== '') return { code: codeOf(error.code) ?? codeOf(error.type), message, requestId: codeOf(record.request_id) }
  }
  const base = record.base_resp
  if (base !== null && typeof base === 'object') {
    const resp = base as Record<string, unknown>
    const message = typeof resp.status_msg === 'string' ? resp.status_msg.trim() : ''
    // status_code 0 is MiniMax's "success"; it explains nothing about a failure.
    if (message !== '' && resp.status_code !== 0) return { code: codeOf(resp.status_code), message, requestId: codeOf(record.request_id) }
  }
  if (typeof record.message === 'string' && record.message.trim() !== '') {
    return { code: codeOf(record.code), message: record.message.trim(), requestId: codeOf(record.request_id) }
  }
  return null
}

/**
 * Read a provider's usage object. Every finite numeric field is kept under its
 * own name; `tokens` and `outputSeconds` are lifted from the fields the protocol
 * documents as its billing basis. An empty or absent object is `null`: MiniMax
 * answers `usage: {}` while a task runs and when it fails.
 */
export function usageOf(value: unknown, basis: { tokens?: string; outputSeconds?: string }): ProviderUsage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const fields: Record<string, number> = {}
  for (const [name, field] of Object.entries(value as Record<string, unknown>)) {
    if (typeof field === 'number' && Number.isFinite(field)) fields[name] = field
  }
  if (Object.keys(fields).length === 0) return null
  return {
    tokens: basis.tokens === undefined ? null : fields[basis.tokens] ?? null,
    outputSeconds: basis.outputSeconds === undefined ? null : fields[basis.outputSeconds] ?? null,
    fields,
  }
}

/**
 * Whether a provider error code is its content review refusing the request, and
 * on which side. Recorded from the vendors' error-code references (2026-10-15):
 *
 * - ARK: `{Input|Output}{Text|Image|Video|Audio}SensitiveContentDetected`, with
 *   `.PolicyViolation` (copyright), `.PrivacyInformation`, `.DeepFake` variants;
 *   `SensitiveContentDetected[.…]` (input text); `…RiskDetection`.
 * - MiniMax: `1026` (input refused), `1027` (output refused).
 * - OpenAI-shaped gateways: no fixed vocabulary; the OpenAI codes
 *   `moderation_blocked` / `content_policy_violation` are taken as a refusal on
 *   an unknown side, and nothing looser (a `moderation_service_unavailable`
 *   is an outage, not a verdict).
 */
export function moderationOf(protocol: string, code: string | null): ModerationStage | null {
  if (code === null) return null
  if (protocol === 'ark-seedance') {
    // Anchored to the documented families: an unrelated code that merely
    // contains one of these words must never block a request for good.
    const side = /^(Input|Output)(Text|Image|Video|Audio)(SensitiveContentDetected|RiskDetection)(\.[A-Za-z]+)?$/.exec(code)
    if (side !== null) return side[1] === 'Output' ? 'output' : 'input'
    return /^SensitiveContentDetected(\.[A-Za-z]+)?$/.test(code) ? 'input' : null
  }
  if (protocol === 'minimax-video') {
    if (code === '1026') return 'input'
    if (code === '1027') return 'output'
    return null
  }
  return /^(moderation_blocked|content_policy_violation)$/i.test(code) ? 'unknown' : null
}

/** A task error, tagged when it is the provider's content review. */
export function taskError(protocol: string, message: string, code: string | null): VideoTaskError {
  const moderation = moderationOf(protocol, code)
  return moderation === null ? { message, code } : { message, code, moderation }
}

function codeOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** Trim a response body so an error message cannot dump a whole page into the transcript. */
export function excerpt(text: string, limit = 400): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/**
 * Issue one JSON request and return the parsed body. Non-2xx responses raise
 * {@link ProviderRequestError} carrying the status and an excerpt, because the
 * model needs to see *why* a paid call failed.
 */
export async function requestJson(
  context: AdapterContext,
  url: string,
  init: { method: string; body?: unknown; accept?: string },
): Promise<unknown> {
  const headers: Record<string, string> = { accept: init.accept ?? 'application/json' }
  if (context.apiKey !== null) headers.authorization = `Bearer ${context.apiKey}`
  let payload: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }

  const response = await context.fetch(url, {
    method: init.method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })

  const text = await response.text()
  if (!response.ok) {
    const provider = providerErrorOf(text)
    // A support ticket asks for the request id; ARK puts it in the message
    // already, MiniMax beside it.
    const requestId = provider?.requestId ?? null
    const tail = requestId === null || provider?.message.includes(requestId) === true ? '' : ` (request_id ${requestId})`
    const said = provider === null ? '' : `: ${provider.code === null ? '' : `${provider.code} — `}${excerpt(provider.message)}${tail}`
    throw new ProviderRequestError(`${init.method} ${url} failed with HTTP ${response.status}${said}`, {
      status: response.status,
      bodyExcerpt: excerpt(text),
      providerCode: provider?.code ?? null,
      providerMessage: provider?.message ?? null,
    })
  }
  if (text.trim() === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProviderRequestError(`${init.method} ${url} returned a non-JSON body`, {
      status: response.status,
      bodyExcerpt: excerpt(text),
    })
  }
}

/** Issue one request whose body is already encoded (multipart uploads, DELETEs). */
export async function requestRaw(
  context: AdapterContext,
  url: string,
  init: { method: string; body?: BodyInit; headers?: Record<string, string> },
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
  if (context.apiKey !== null) headers.authorization = `Bearer ${context.apiKey}`
  const response = await context.fetch(url, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  return { status: response.status, text: await response.text() }
}

/**
 * Normalize a provider's own vocabulary into {@link ProviderTaskState}. Unknown
 * words stay `unknown` rather than being forced into "running": claiming
 * progress we did not observe is how a stuck task looks healthy for an hour.
 */
export function normalizeStatus(
  raw: string | null,
  table: { queued: readonly string[]; running: readonly string[]; succeeded: readonly string[]; failed: readonly string[]; cancelled: readonly string[] },
): { status: ProviderTaskState['status']; terminal: boolean } {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '') return { status: 'unknown', terminal: false }
  if (table.succeeded.includes(value)) return { status: 'succeeded', terminal: true }
  if (table.failed.includes(value)) return { status: 'failed', terminal: true }
  if (table.cancelled.includes(value)) return { status: 'cancelled', terminal: true }
  if (table.running.includes(value)) return { status: 'running', terminal: false }
  if (table.queued.includes(value)) return { status: 'queued', terminal: false }
  return { status: 'unknown', terminal: false }
}
