/**
 * The workbench's transport: a thin client over `/video-forge/api`.
 *
 * URLs are **document-relative** on purpose. The GUI is served with
 * `<base href="./">`, so a relative path resolves against the document's own
 * directory and keeps working when the deployment lives under a sub-path; a
 * leading slash would escape to the origin root. This is the shipped convention
 * (`api/dsh-usage/overview`), and it is why nothing here builds an absolute URL.
 *
 * Every call returns a discriminated result instead of throwing: the panel is a UI,
 * and a rejected fetch must render as a message rather than as a blank crash.
 */

import type { VideoMode } from '../types.ts'

/** One task row as the host projects it. */
export interface PanelTask {
  taskId: string
  provider: string
  model: string
  status: string
  progress: number | null
  mode: VideoMode
  prompt: string
  submittedAt: string
  updatedAt: string
  playUrl: string | null
  artifactPath: string | null
  artifactBytes: number | null
  error: string | null
}

export interface ProviderCapability {
  id: string
  label: string
  modes: readonly string[]
  durations: readonly number[]
  resolutions: readonly string[]
  aspectRatios: readonly string[]
  cancelable: boolean
}

/** One provider with its credential state — configured, source, and a masked tail only. */
export interface PanelProvider {
  id: string
  protocol: string
  baseUrl: string
  authRef: string
  credential: { configured: boolean; source: string | null; masked: string | null; error: string | null }
  models: ProviderCapability[]
}

export interface PanelOverview {
  ok: true
  enabled: boolean
  settings: {
    defaultProvider: string
    defaultModel: string
    maxConcurrent: number
    pollIntervalMs: number
    dedupeWindowSeconds: number
    outputRoot: string
  }
  providers: PanelProvider[]
  tasks: PanelTask[]
  usage: { tasks: number; bytes: number; overTaskLimit: boolean; overByteLimit: boolean }
  active: number
}

export interface SubmitInput {
  prompt: string
  provider?: string
  model?: string
  mode?: VideoMode
  firstFrame?: string
  lastFrame?: string
  referenceImages?: string[]
  durationSeconds?: number | null
  resolution?: string
  aspectRatio?: string
}

/** Either a value or a message the panel can show verbatim. */
export type PanelResult<T> = { ok: true; value: T } | { ok: false; error: string }

const BASE = 'video-forge/api'

/** Resolve one document-relative API endpoint against the document base. */
export function apiUrl(action: string, base?: string): string {
  const root = base ?? (typeof document === 'undefined' ? 'http://localhost/' : document.baseURI)
  return new URL(`${BASE}/${action}`, root).href
}

async function call<T>(action: string, init: RequestInit): Promise<PanelResult<T>> {
  try {
    const response = await fetch(apiUrl(action), {
      // Same-origin: the session cookie and the loopback check both ride along.
      credentials: 'same-origin',
      ...init,
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      return { ok: false, error: `the workbench API answered with a non-JSON body (HTTP ${response.status})` }
    }
    const body = parsed as { ok?: boolean; error?: string }
    if (!response.ok || body.ok === false) {
      return { ok: false, error: body.error ?? `HTTP ${response.status}` }
    }
    return { ok: true, value: parsed as T }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function fetchOverview(): Promise<PanelResult<PanelOverview>> {
  return call<PanelOverview>('overview', { method: 'GET' })
}

export function submitGeneration(input: SubmitInput): Promise<PanelResult<{ task: PanelTask; jobId: string | null; message: string }>> {
  return call('generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function cancelGeneration(taskId: string): Promise<PanelResult<{ cancelled: boolean; message: string; status: string }>> {
  return call('cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId }),
  })
}

export function exportArtifact(taskId: string, targetPath: string, overwrite = false): Promise<PanelResult<{ path: string; bytes: number }>> {
  return call('export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, targetPath, overwrite }),
  })
}
