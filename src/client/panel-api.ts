/**
 * The browser surfaces' transport: a thin client over `/video-forge/api` — one
 * task for a chat card, cancelling it, and the overview the configuration card
 * and the badge read.
 *
 * URLs are **document-relative** on purpose. The GUI is served with
 * `<base href="./">`, so a relative path resolves against the document's own
 * directory and keeps working when the deployment lives under a sub-path; a
 * leading slash would escape to the origin root. This is the shipped convention
 * (`api/dsh-usage/overview`), and it is why nothing here builds an absolute URL.
 *
 * Every call returns a discriminated result instead of throwing: these are UIs,
 * and a rejected fetch must render as a message rather than as a blank crash.
 */

import type { VideoMode } from '../types.ts'

/**
 * One task row as the host projects it: a mirror of `TaskRow` in
 * `src/operations.ts`, which is the single projection both halves read. Keep the
 * two in step; the panel's optional fields are optional here only because a host
 * older than M5 omits them.
 */
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
  /** Where the video is, in words (workspace-relative, or why it is outside). */
  artifactLocation: string | null
  artifactBytes: number | null
  /**
   * The video panel's fields (added in M5). Optional because the browser half
   * must keep working against a host that predates them: the panel then groups
   * by what it can see instead of failing to render.
   */
  sessionId?: string | null
  /** Workspace-relative artifact path; the key the panel dedupes a directory listing against. */
  workspacePath?: string | null
  shot?: string | null
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
  resolution?: string | null
  aspectRatio?: string | null
  error: string | null
  /** Set when the provider's content review refused the task. */
  moderation?: string | null
}

/** One task as a chat card polls it: the row plus whether its video is still there. */
export interface LiveTask extends PanelTask {
  artifactState: 'present' | 'missing' | null
  /** Whether the provider can be asked to stop it; absent from an older host. */
  cancelable?: boolean
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
  /** Host capabilities, absent on a host that predates M5. */
  features?: { stream?: boolean }
}

/** Either a value or a message the UI can show verbatim (with the HTTP status, when there was an answer). */
export type PanelResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number }

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
      return { ok: false, error: `the video-forge panel API answered with a non-JSON body (HTTP ${response.status})`, status: response.status }
    }
    const body = parsed as { ok?: boolean; error?: string }
    if (!response.ok || body.ok === false) {
      return { ok: false, error: body.error ?? `HTTP ${response.status}`, status: response.status }
    }
    return { ok: true, value: parsed as T }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The whole ledger, newest first.
 * @param limit - rows to ask for; the host caps it. The panel asks for the full
 * retention window because a project's history is the point of the list.
 * @returns the overview, or the message to show.
 */
export function fetchOverview(limit?: number): Promise<PanelResult<PanelOverview>> {
  const query = limit === undefined ? '' : `?limit=${String(limit)}`
  return call<PanelOverview>(`overview${query}`, { method: 'GET' })
}

/** One task, for a chat card; light (no credential lookups). */
export async function fetchTask(taskId: string): Promise<PanelResult<{ task: LiveTask | null; active: number }>> {
  const result = await call<{ tasks?: unknown; active?: unknown }>(`overview?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' })
  if (!result.ok) return result
  const tasks = result.value.tasks
  if (!Array.isArray(tasks)) return { ok: false, error: 'the video-forge panel API answered without a task list' }
  // Only the row asked for: a host that ignored the filter must not put another task's video on this card.
  const task = (tasks as LiveTask[]).find(entry => typeof entry === 'object' && entry !== null && entry.taskId === taskId) ?? null
  return { ok: true, value: { task, active: typeof result.value.active === 'number' ? result.value.active : 0 } }
}

export function cancelGeneration(taskId: string): Promise<PanelResult<{ cancelled: boolean; message: string; status: string }>> {
  return call('cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId }),
  })
}
