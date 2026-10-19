/**
 * Pure derivations for the video panel (M5).
 *
 * The panel is a list, not a second library: it merges the ledger (what this
 * plugin produced, with prompts, sizes and live progress) with what `renders/`
 * actually holds (so a clip someone copied in, or one from an older profile,
 * still shows up), groups the finished ones by shot, and sinks everything still
 * in flight or failed to the bottom. No React and no I/O here: every rule the
 * panel draws with is testable on its own, and the component only wires data in.
 */

import type { PanelTask } from './panel-api.ts'

/** Which slice of the ledger the panel is showing. */
export type PanelScope = 'workspace' | 'session' | 'all'

/** One `.mp4` found by the workspace scan, workspace-relative with `/` separators. */
export interface PanelFile {
  path: string
  bytes: number | null
}

/** A row's visual tone: what the status dot and the row's emphasis are. */
export type PanelTone = 'ready' | 'active' | 'failed' | 'other'

/** One video in the list, from the ledger, the scan, or both. */
export interface PanelRow {
  /** Stable identity: the task id, or the workspace path for a file-only row. */
  key: string
  kind: 'task' | 'file'
  taskId: string | null
  /** Workspace-relative path with `/` separators; empty only for a task whose artifact is not in the workspace. */
  workspacePath: string
  /** Where the video is, in words, when it is not in the workspace (`$DSH_HOME`, why it landed there). */
  location: string | null
  /**
   * The row's directory, workspace-relative with `/` separators and empty when
   * the video is outside the workspace. Rows group by this, so the header states
   * where the file actually is instead of guessing `renders/<shot>`.
   */
  directory: string
  /** `vNNN` from the filename when it parses, for display and ordering. */
  version: number | null
  /** Task status, or `file` for a row the ledger does not know. */
  status: string
  tone: PanelTone
  progress: number | null
  /** The ledger's Range-capable media URL; null for a file-only row (it plays through the stream route). */
  playUrl: string | null
  bytes: number | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  /** What was requested when nothing came back, for a row that never finished. */
  resolution: string | null
  provider: string
  model: string
  prompt: string
  /** The provider or host error, for a row that failed. */
  error: string | null
  submittedAt: string | null
  sessionId: string | null
}

/** One directory's finished videos. */
export interface PanelGroup {
  directory: string
  rows: PanelRow[]
}

/** Everything one render needs. */
export interface PanelView {
  /** Finished videos, grouped by directory, newest group first. */
  ready: PanelGroup[]
  /** Still in flight, newest first. */
  active: PanelRow[]
  /** Failed or cancelled, newest first. */
  failed: PanelRow[]
  /** Rows matching each scope, for the filter chips. */
  counts: Record<PanelScope, number>
  /** The row to expand on first render: the newest finished video, if any. */
  defaultKey: string | null
  /** Rows hidden only because the host does not list them (see {@link buildPanelView}). */
  scanned: boolean
  /**
   * Whether any row could be attributed to a Session. A host that predates the
   * projection fields sends none, and then the per-session filter can only ever
   * be empty — the panel hides that chip instead of offering a dead control.
   */
  attributable: boolean
}

/** Statuses whose task has no video to play yet. */
const ACTIVE_STATUSES = new Set(['submitting', 'unconfirmed', 'queued', 'running', 'orphaned'])
/** Statuses that ended without a video. */
const FAILED_STATUSES = new Set(['failed', 'cancelled'])

/**
 * The tone a task status draws with.
 * @param status - a ledger status.
 * @returns ready for a finished video, active while the provider may still work, failed otherwise.
 */
export function toneOf(status: string): PanelTone {
  if (status === 'succeeded') return 'ready'
  if (ACTIVE_STATUSES.has(status)) return 'active'
  if (FAILED_STATUSES.has(status)) return 'failed'
  return 'other'
}

/** Every locale key the panel's status chip can need. */
export type PanelStatusKey =
  | 'panel.status.ready'
  | 'panel.status.running'
  | 'panel.status.queued'
  | 'panel.status.submitting'
  | 'panel.status.unconfirmed'
  | 'panel.status.orphaned'
  | 'panel.status.failed'
  | 'panel.status.cancelled'
  | 'panel.status.file'

/**
 * The short label for one row.
 * @param row - the row to label.
 * @returns the locale key, never a sentence (translation happens at render).
 */
export function panelStatusKey(row: PanelRow): PanelStatusKey {
  if (row.kind === 'file') return 'panel.status.file'
  switch (row.status) {
    case 'succeeded': return 'panel.status.ready'
    case 'running': return 'panel.status.running'
    case 'queued': return 'panel.status.queued'
    case 'submitting': return 'panel.status.submitting'
    case 'unconfirmed': return 'panel.status.unconfirmed'
    case 'orphaned': return 'panel.status.orphaned'
    case 'cancelled': return 'panel.status.cancelled'
    default: return 'panel.status.failed'
  }
}

/**
 * The directory a workspace path sits in.
 * @param workspacePath - workspace-relative path with `/` separators.
 * @returns the parent directory ('' for a file at the workspace root), which is
 * what the panel groups by: it is where the file *is*, not where the plugin
 * usually writes it.
 */
export function directoryOf(workspacePath: string): string {
  const cut = workspacePath.lastIndexOf('/')
  return cut <= 0 ? '' : workspacePath.slice(0, cut)
}

/**
 * The `vNNN` version a filename carries.
 * @param workspacePath - workspace-relative path.
 * @returns the number, or null for a name this plugin did not choose.
 */
export function versionOf(workspacePath: string): number | null {
  const name = workspacePath.slice(workspacePath.lastIndexOf('/') + 1)
  const match = /^v(\d+)/.exec(name)
  if (match === null) return null
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) ? value : null
}

/**
 * Project one ledger row.
 *
 * Every ledger row is worth showing, including one that never produced a video:
 * the panel's whole point is that a failed or still-running generation is
 * visible without digging a folded card out of the transcript.
 *
 * @param task - the row as the panel API projected it.
 * @returns the row to render.
 */
export function taskRow(task: PanelTask): PanelRow {
  const workspacePath = task.workspacePath ?? ''
  return {
    key: task.taskId,
    kind: 'task',
    taskId: task.taskId,
    workspacePath,
    location: typeof task.artifactLocation === 'string' ? task.artifactLocation : null,
    directory: directoryOf(workspacePath),
    version: workspacePath === '' ? null : versionOf(workspacePath),
    status: task.status,
    tone: toneOf(task.status),
    progress: typeof task.progress === 'number' ? task.progress : null,
    playUrl: task.playUrl,
    bytes: task.artifactBytes,
    width: task.width ?? null,
    height: task.height ?? null,
    durationSeconds: task.durationSeconds ?? null,
    resolution: task.resolution ?? null,
    provider: task.provider,
    model: task.model,
    prompt: typeof task.prompt === 'string' ? task.prompt : '',
    error: typeof task.error === 'string' && task.error !== '' ? task.error : null,
    submittedAt: typeof task.submittedAt === 'string' ? task.submittedAt : null,
    sessionId: task.sessionId ?? null,
  }
}

/**
 * Project one scanned file as a row.
 * @param file - the workspace-relative path and size, if the listing reported one.
 * @returns the row a file-only entry renders as.
 */
export function fileRow(file: PanelFile): PanelRow {
  return {
    key: `file:${file.path}`,
    kind: 'file',
    taskId: null,
    workspacePath: file.path,
    location: null,
    directory: directoryOf(file.path),
    version: versionOf(file.path),
    status: 'file',
    tone: 'ready',
    progress: null,
    // Played through the stream route: the ledger's media route is keyed by a
    // task id and token this file has neither of.
    playUrl: null,
    bytes: file.bytes,
    width: null,
    height: null,
    durationSeconds: null,
    resolution: null,
    provider: '',
    model: '',
    prompt: '',
    error: null,
    submittedAt: null,
    sessionId: null,
  }
}

/**
 * Merge the ledger with the scan, without listing one video twice.
 *
 * The ledger wins where both know a file: it carries the prompt, the provider
 * and the playable URL. Matching is by workspace-relative path, which is why
 * the host projects `workspacePath` rather than an absolute one.
 *
 * @param tasks - ledger rows from the panel API.
 * @param files - scanned `.mp4`s, workspace-relative.
 * @returns every row, ledger first within each group, plus whether the scan contributed anything.
 */
export function mergeRows(tasks: readonly PanelTask[], files: readonly PanelFile[]): { rows: PanelRow[]; scanned: boolean } {
  const rows: PanelRow[] = []
  const known = new Set<string>()
  for (const task of tasks) {
    const row = taskRow(task)
    if (row.workspacePath !== '') known.add(row.workspacePath)
    rows.push(row)
  }
  let scanned = false
  for (const file of files) {
    if (known.has(file.path)) continue
    scanned = true
    rows.push(fileRow(file))
  }
  return { rows, scanned }
}

/**
 * Whether a row belongs to the current Session's workspace.
 * @param row - the row to test.
 * @param workspaceSessionIds - every Session accounted to the on-screen workspace.
 * @returns true for a scanned file (it is in this workspace by construction) or a task one of those Sessions submitted.
 */
function inWorkspace(row: PanelRow, workspaceSessionIds: ReadonlySet<string>): boolean {
  if (row.kind === 'file') return true
  return row.sessionId !== null && workspaceSessionIds.has(row.sessionId)
}

/**
 * Build one render's view: the scoped rows, grouped and sorted.
 *
 * `session` keeps what the current Session submitted (a scanned file has no
 * attribution, so it is left out); `workspace` keeps what any Session of this
 * workspace submitted plus everything the scan found; `all` keeps everything the
 * host listed. A host that predates the panel's projection fields sends no
 * `sessionId`, and then `workspace` falls back to `all` — showing too much beats
 * showing an empty list on a host this plugin still supports.
 *
 * @param input - ledger rows, scanned files, the chosen scope and the identity of the on-screen Session.
 * @returns the sections and counts the panel draws, and the row to expand first.
 */
export function buildPanelView(input: {
  tasks: readonly PanelTask[]
  files: readonly PanelFile[]
  scope: PanelScope
  sessionId: string
  workspaceSessionIds: readonly string[]
}): PanelView {
  const { rows, scanned } = mergeRows(input.tasks, input.files)
  const workspaceSessionIds = new Set(input.workspaceSessionIds)
  const attributable = rows.some(row => row.sessionId !== null)
  const counts: Record<PanelScope, number> = {
    session: rows.filter(row => row.kind === 'task' && row.sessionId === input.sessionId).length,
    workspace: attributable ? rows.filter(row => inWorkspace(row, workspaceSessionIds)).length : rows.length,
    all: rows.length,
  }
  const scoped = input.scope === 'session'
    ? rows.filter(row => row.kind === 'task' && row.sessionId === input.sessionId)
    : input.scope === 'workspace' && attributable
      ? rows.filter(row => inWorkspace(row, workspaceSessionIds))
      : rows

  // A video that landed outside the workspace (a read-only session, $DSH_HOME)
  // is still a finished video this plugin made: it groups under '' and keeps its
  // description as the subtitle, rather than vanishing from the panel.
  const ready = scoped.filter(row => row.tone === 'ready')
  const active = scoped.filter(row => row.tone === 'active').sort(byRecency)
  const failed = scoped.filter(row => row.tone === 'failed' || (row.tone === 'other' && row.kind === 'task')).sort(byRecency)

  const groups = new Map<string, PanelRow[]>()
  for (const row of ready) {
    const directory = row.directory
    const bucket = groups.get(directory)
    if (bucket === undefined) groups.set(directory, [row])
    else bucket.push(row)
  }
  const readyGroups = [...groups.entries()]
    .map(([directory, groupRows]) => ({ directory, rows: [...groupRows].sort(byVersion) }))
    .sort(byGroupRecency)

  const newestFirst = [...ready].sort((left, right) => byRecency(left, right) || byVersion(left, right))
  return {
    ready: readyGroups,
    active,
    failed,
    counts,
    defaultKey: newestFirst[0]?.key ?? null,
    scanned,
    attributable,
  }
}

/** Newest first, by whatever a row can offer. */
function byRecency(left: PanelRow, right: PanelRow): number {
  return (right.submittedAt ?? '').localeCompare(left.submittedAt ?? '')
}

/** Version first (v003 before v002), then time, then path so the order is total. */
function byVersion(left: PanelRow, right: PanelRow): number {
  if (left.version !== null && right.version !== null && left.version !== right.version) return right.version - left.version
  return byRecency(left, right) || left.workspacePath.localeCompare(right.workspacePath)
}

/**
 * Newest shot group first: the newest timestamp it holds, then the highest
 * version, then the name so the order is total. A scanned file-only group has
 * no timestamp at all and therefore sorts by version alone — which is the
 * generation order, because this plugin hands versions out in that order.
 */
function byGroupRecency(left: PanelGroup, right: PanelGroup): number {
  const newest = (group: PanelGroup): string => group.rows.map(row => row.submittedAt ?? '').sort().reverse()[0] ?? ''
  const version = (group: PanelGroup): number => Math.max(0, ...group.rows.map(row => row.version ?? 0))
  return newest(right).localeCompare(newest(left)) || version(right) - version(left) || left.directory.localeCompare(right.directory)
}

/**
 * The URL a `<video src>` should use for one row.
 *
 * A ledger row has a token URL the media route answers with ranges; anything
 * else goes through the stream route and therefore needs the Session whose
 * workspace resolves the relative path.
 *
 * @param row - the row to play.
 * @param base - the document base, so the URL stays valid under a sub-path.
 * @param sessionId - the Session on screen.
 * @param streamAvailable - whether the host reported its Range-capable route.
 * @returns the URL, or null when this row has no playable source.
 */
export function rowVideoUrl(row: PanelRow, base: string, sessionId: string, streamAvailable: boolean): string | null {
  if (row.playUrl !== null && row.playUrl.trim() !== '') return resolveUrl(row.playUrl, base)
  if (!streamAvailable || row.workspacePath === '') return null
  // The row's own Session resolves the relative path: under "all" it may not be
  // the one on screen, and a Session address reads from *that* session's root.
  const session = row.sessionId ?? sessionId
  const relative = `api/video-forge/stream?path=${encodeURIComponent(row.workspacePath)}&sessionId=${encodeURIComponent(session)}`
  return resolveUrl(relative, base)
}

/**
 * The stream route's URL for one absolute path, used by the document viewer's
 * mp4 renderer (it holds the path `stat` reported, not a workspace-relative one).
 * @param base - the document base.
 * @param absolutePath - the file in the execution world.
 * @param version - the file's freshness token, so a reload fetches again.
 * @returns the URL, or null when the path cannot be encoded.
 */
export function streamUrl(base: string, absolutePath: string, version?: string): string | null {
  const query = `path=${encodeURIComponent(absolutePath)}${version === undefined ? '' : `&v=${encodeURIComponent(version)}`}`
  return resolveUrl(`api/video-forge/stream?${query}`, base)
}

/**
 * The harness's own bounded file URL, for a host with no stream route.
 * @param base - the document base.
 * @param absolutePath - the file in the execution world.
 * @returns the URL, or null when it cannot be encoded.
 */
export function harnessFileUrl(base: string, absolutePath: string, version?: string): string | null {
  const query = `path=${encodeURIComponent(absolutePath)}${version === undefined ? '' : `&v=${encodeURIComponent(version)}`}`
  return resolveUrl(`api/file?${query}`, base)
}

/**
 * The `dsh-resource://file/session/…` address the right Sidebar opens a file by.
 * @param sessionId - the Session whose workspace resolves the path.
 * @param path - absolute or workspace-relative path.
 * @returns the address, every segment component-encoded (`:` kept for drives).
 */
export function fileAddress(sessionId: string, path: string): string {
  const encode = (segment: string): string => encodeURIComponent(segment).replace(/%3A/gi, ':')
  const normalized = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`
}

/** Resolve one document-relative URL, or nothing if it would leave http(s). */
function resolveUrl(url: string, base: string): string | null {
  if (url.trim() === '') return null
  try {
    const resolved = new URL(url, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null
  } catch {
    return null
  }
}

/**
 * A duration as a player writes it (`0:05`, `1:12`).
 * @param seconds - the duration, or null when unknown.
 * @returns the label, or null when there is nothing to say.
 */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const whole = Math.round(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * The technical line under a name: `1344×768 · 0:05 · 1.5 MiB`.
 * @param row - the row.
 * @param bytes - a byte formatter, so this module owns no formatting policy beyond the video's own.
 * @returns the segments that exist, joined; never empty.
 */
export function rowFacts(row: PanelRow, formatBytes: (bytes: number) => string): string {
  const parts: string[] = []
  if (row.width !== null && row.height !== null) parts.push(`${row.width}×${row.height}`)
  else if (row.resolution !== null) parts.push(row.resolution)
  const duration = formatDuration(row.durationSeconds)
  if (duration !== null) parts.push(duration)
  if (row.bytes !== null) parts.push(formatBytes(row.bytes))
  return parts.join(' · ')
}

/**
 * The name a row shows: the file name, which is the version inside its shot.
 * @param row - the row.
 * @returns the file name, or the shot for a row whose path is somehow empty.
 */
export function rowName(row: PanelRow): string {
  if (row.workspacePath === '') return row.taskId ?? ''
  const name = row.workspacePath.slice(row.workspacePath.lastIndexOf('/') + 1)
  return name
}

/**
 * What one renderer parameter says about progress.
 * @param row - an active row.
 * @returns 0..1, or null when the host reported none.
 */
export function rowProgress(row: PanelRow): number | null {
  if (row.progress === null || !Number.isFinite(row.progress)) return null
  return Math.min(1, Math.max(0, row.progress))
}
