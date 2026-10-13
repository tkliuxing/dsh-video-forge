/**
 * Provider adapters. Each adapter speaks one online protocol and nothing else:
 * it turns a provider-neutral {@link GenerationRequest} into one submit call,
 * reads one poll response, and optionally asks the provider to cancel.
 *
 * Deliberately absent: any local inference path, and any artifact muxing. Every
 * protocol here returns a downloadable MP4 (DESIGN §1, P5).
 */

import type { GenerationRequest, ProviderTaskState } from '../types.ts'

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
}

/** A provider or transport failure with the HTTP status and a bounded body excerpt. */
export class ProviderRequestError extends Error {
  readonly status: number | null
  readonly bodyExcerpt: string | null

  constructor(message: string, options: { status?: number | null; bodyExcerpt?: string | null; cause?: unknown } = {}) {
    super(message)
    this.name = 'ProviderRequestError'
    this.status = options.status ?? null
    this.bodyExcerpt = options.bodyExcerpt ?? null
    if (options.cause !== undefined) this.cause = options.cause
  }
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
    throw new ProviderRequestError(`${init.method} ${url} failed with HTTP ${response.status}`, {
      status: response.status,
      bodyExcerpt: excerpt(text),
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
