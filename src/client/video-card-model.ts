/**
 * Pure derivations for the browser cards.
 *
 * The Web Client never receives `presentCall` / `presentResult`: an atomic card
 * is handed raw wire facts (`argsRaw`, `content`, `isError`, and the persisted
 * `meta` that the host's `output.presentationMeta` produced) and must derive
 * everything itself. These functions do exactly that, with no React and no I/O,
 * and they return `null` rather than throwing when a payload is not what we
 * expect — a malformed or older logged call must fall back to the generic row,
 * never crash a replay.
 */

/** Tool names whose card this plugin owns. */
export const TOOL_NAMES = ['video_generate', 'video_status', 'video_cancel', 'video_export'] as const

export type VideoToolName = typeof TOOL_NAMES[number]

/** The `meta` a generate call persists, narrowed field by field. */
export interface GenerateMeta {
  taskId: string
  provider: string
  model: string
  status: string
  progress: number | null
  artifact: { path: string; url: string; mime: string; bytes: number } | null
}

/** One row of the status list. */
export interface StatusRow {
  taskId: string
  provider: string
  model: string
  status: string
  progress: number | null
  playUrl: string | null
  error: string | null
}

/** Arguments worth showing while a call is still running. */
export interface StartFacts {
  prompt: string | null
  mode: string | null
  taskCount: number
}

/** Parse `argsRaw` into an object, or null when it is not a JSON object. */
export function parseArgs(argsRaw: string): Record<string, unknown> | null {
  if (argsRaw.trim() === '') return null
  try {
    const value: unknown = JSON.parse(argsRaw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Narrow the persisted generate meta. */
export function generateMeta(meta: unknown): GenerateMeta | null {
  const row = objectOf(meta)
  if (row === null) return null
  const taskId = stringOf(row.taskId)
  if (taskId === null) return null
  return {
    taskId,
    provider: stringOf(row.provider) ?? '',
    model: stringOf(row.model) ?? '',
    status: stringOf(row.status) ?? 'unknown',
    progress: numberOf(row.progress),
    artifact: artifactOf(row.artifact),
  }
}

/** Narrow the persisted status-list meta. */
export function statusMeta(meta: unknown): StatusRow[] | null {
  const row = objectOf(meta)
  const tasks = row?.tasks
  if (!Array.isArray(tasks)) return null
  const rows: StatusRow[] = []
  for (const entry of tasks) {
    const item = objectOf(entry)
    const taskId = item === null ? null : stringOf(item.task_id)
    if (item === null || taskId === null) continue
    rows.push({
      taskId,
      provider: stringOf(item.provider) ?? '',
      model: stringOf(item.model) ?? '',
      status: stringOf(item.status) ?? 'unknown',
      progress: numberOf(item.progress),
      playUrl: stringOf(item.play_url),
      error: stringOf(item.error),
    })
  }
  return rows
}

/** Facts for a generate call that has not returned yet. */
export function startFacts(argsRaw: string): StartFacts {
  const args = parseArgs(argsRaw)
  return {
    prompt: args === null ? null : stringOf(args.prompt),
    mode: args === null ? null : stringOf(args.mode),
    taskCount: 0,
  }
}

/** Facts for a `video_status` call in its running phase. */
export function statusStartFacts(argsRaw: string): { taskId: string | null } {
  const args = parseArgs(argsRaw)
  return { taskId: args === null ? null : stringOf(args.task_id) }
}

/** Single-line text from a settled result, when the result is exactly one text block. */
export function resultText(content: readonly { type: string; text?: string }[]): string | null {
  if (content.length !== 1) return null
  const only = content[0]
  return only !== undefined && only.type === 'text' && typeof only.text === 'string' ? only.text : null
}

/**
 * Resolve an artifact URL for a `<video src>`.
 *
 * The host hands back a document-relative path (the GUI is served with
 * `<base href="./">`), so resolve it against the document base the same way the
 * rest of the console does; an http(s) URL is passed through unchanged.
 */
export function resolveMediaUrl(url: string, base: string): string | null {
  if (url.trim() === '') return null
  try {
    const resolved = new URL(url, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null
  } catch {
    return null
  }
}

/** Human-readable byte size for the card. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function artifactOf(value: unknown): GenerateMeta['artifact'] {
  const row = objectOf(value)
  if (row === null) return null
  const url = stringOf(row.url)
  if (url === null) return null
  return {
    path: stringOf(row.path) ?? '',
    url,
    mime: stringOf(row.mime) ?? 'video/mp4',
    bytes: numberOf(row.bytes) ?? 0,
  }
}

/** The raw facts a card may read from its phase block, narrowed defensively. */
export interface BlockFacts {
  phase: 'preparing' | 'start' | 'result'
  /** Dispatched arguments as a raw JSON string; empty while preparing. */
  argsRaw: string
  content: readonly { type: string; text?: string }[]
  isError: boolean
  /** Persisted `output.presentationMeta` value, or undefined. */
  meta: unknown
}

/**
 * Narrow a slot phase block. `ToolResultNode` (a settled result) is
 * discriminated by `kind: 'tool-result'` and carries the call head in `call`;
 * a running call carries `argsRaw` directly.
 */
export function blockFacts(block: unknown): BlockFacts {
  const row = objectOf(block)
  if (row === null) return { phase: 'preparing', argsRaw: '', content: [], isError: false, meta: undefined }

  if (row['kind'] === 'tool-result') {
    const call = objectOf(row['call'])
    const content = Array.isArray(row['content']) ? row['content'] as { type: string; text?: string }[] : []
    return {
      phase: 'result',
      argsRaw: call === null ? '' : stringOf(call['argsRaw']) ?? '',
      content,
      isError: row['isError'] === true,
      meta: row['meta'],
    }
  }

  const phase = row['phase'] === 'start' ? 'start' : 'preparing'
  return {
    phase,
    argsRaw: stringOf(row['argsRaw']) ?? '',
    content: [],
    isError: false,
    meta: undefined,
  }
}

/** Status word to a locale key for its headline. */
export function statusKey(status: string): 'generate.queued' | 'generate.running' | 'generate.failed' | 'generate.cancelled' | 'generate.orphaned' | 'generate.submitting' | 'generate.unconfirmed' {
  switch (status) {
    case 'submitting': return 'generate.submitting'
    case 'unconfirmed': return 'generate.unconfirmed'
    case 'queued': return 'generate.queued'
    case 'failed': return 'generate.failed'
    case 'cancelled': return 'generate.cancelled'
    case 'orphaned': return 'generate.orphaned'
    default: return 'generate.running'
  }
}
