/**
 * Loading the video panel: the ledger through this plugin's own API, and
 * `renders/` through the harness's workspace-file Remote.
 *
 * Two sources, one rule: neither is required for the other. A ledger that cannot
 * be read is an error the panel shows; a workspace that cannot be listed only
 * costs the scanned rows, because the panel's primary content is what this plugin
 * produced. The scan is read through the Session's Remote on purpose — it follows
 * the composed filesystem (an SSH workspace included) and needs no new host
 * endpoint, at the cost of one listing call per shot directory.
 */

import { fetchOverview, type PanelTask } from './panel-api.ts'
import type { PanelFile } from './video-panel-model.ts'

/** The directory the plugin writes into, and the only one the scan reads. */
export const RENDERS_DIRECTORY = 'renders'

/** How many rows one panel load asks the host for; the host clamps this to its own cap. */
export const PANEL_TASK_LIMIT = 200

/** Directories one load will list. Beyond this the scan stops, so a pathological tree cannot stall the panel. */
const MAX_SHOT_DIRECTORIES = 80

/** Files one load keeps. */
const MAX_FILES = 400

/** Listings in flight at once: a wide tree must not mean 80 serial round-trips (an SSH workspace pays for each). */
const LIST_CONCURRENCY = 4

/** One `RemoteResult` frame, as this module reads it. */
interface RemoteResultLike<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** One directory listing, as this module reads it. */
interface DirectoryListingLike {
  readonly entries: readonly { readonly name: string; readonly type: string; readonly size?: number }[]
  /** The host's own cap dropped children from `entries`. */
  readonly truncated?: boolean
}

/** The `remote.workspaceFiles` methods the scan uses. */
export interface WorkspaceFilesRemoteLike {
  list(sessionId: string, path: string, signal?: AbortSignal): Promise<RemoteResultLike<DirectoryListingLike>>
}

/**
 * Why the scan did not produce the whole list, in a form the panel can phrase.
 *
 * `none` is the ordinary case. The rest are deliberately distinct: a missing
 * `renders/` means "nothing generated yet" and deserves no message, while a
 * `renders/` that is a file, a symlink out of the workspace, or a host without
 * the files service are three different things to tell the operator — and a
 * truncated listing must not look complete.
 */
export type ScanProblem =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-directory' }
  | { readonly kind: 'outside' }
  | { readonly kind: 'truncated'; readonly detail: string | null }
  | { readonly kind: 'refused'; readonly detail: string | null }

/** What one load of the panel needs. */
export interface PanelLoad {
  tasks: PanelTask[]
  /** `.mp4` files found under `renders/`, workspace-relative. */
  files: PanelFile[]
  /** Whether the host reported its Range-capable stream route. */
  stream: boolean
  /** Why the scan is short or missing; the ledger rows are shown regardless. */
  scan: ScanProblem
}

/** Where a load gets its two sources. */
export interface PanelDataDeps {
  /** The Session whose workspace is listed; also the Session the panel's URLs name. */
  readonly sessionId: string
  /** The `workspaceFiles` namespace, or undefined when the host does not mount it. */
  readonly remote: WorkspaceFilesRemoteLike | undefined
}

/**
 * Whether a name is a video this panel lists.
 * @param name - a file name from the listing.
 * @returns true for the one suffix the plugin writes.
 */
export function isPanelVideo(name: string): boolean {
  return name.toLowerCase().endsWith('.mp4')
}

/**
 * Read both sources for one render.
 *
 * @param deps - the Session and the Remote face.
 * @param signal - aborts with the tab.
 * @returns the rows' two inputs and whether the stream route exists.
 * @throws when the ledger itself cannot be read; the panel renders that as its error state.
 */
export async function loadPanel(deps: PanelDataDeps, signal: AbortSignal): Promise<PanelLoad> {
  // The signal reaches the ledger request too: a superseded read must not keep a
  // round-trip alive, and a poll must not pile them up.
  const overview = await fetchOverview(PANEL_TASK_LIMIT, signal)
  if (!overview.ok) throw new Error(overview.error)
  const scan = await scanRenders(deps, signal)
  return {
    tasks: overview.value.tasks,
    files: scan.files,
    stream: overview.value.features?.stream === true,
    scan: scan.problem,
  }
}

/**
 * List `renders/` and one level into each shot directory.
 *
 * A missing `renders/` is not an error — a project that has not generated
 * anything yet has none — while any other refusal is reported beside the list
 * rather than replacing it.
 *
 * @param deps - the Session and the Remote face.
 * @param signal - aborts with the tab.
 * @returns the videos found and why the scan stopped, when it did.
 */
export async function scanRenders(deps: PanelDataDeps, signal: AbortSignal): Promise<{ files: PanelFile[]; problem: ScanProblem }> {
  const remote = deps.remote
  if (remote === undefined) return { files: [], problem: { kind: 'unavailable' } }

  const root = await remote.list(deps.sessionId, RENDERS_DIRECTORY, signal)
  if (!root.ok) {
    const code = root.error?.code ?? ''
    // Nothing generated yet: an empty list, not a failure to report.
    if (code === 'workspace-file/not-found' || code === 'FS_NOT_FOUND') return { files: [], problem: { kind: 'none' } }
    if (code === 'workspace-file/not-directory') return { files: [], problem: { kind: 'not-directory' } }
    if (code === 'workspace-file/outside-workspace') return { files: [], problem: { kind: 'outside' } }
    return { files: [], problem: { kind: 'refused', detail: root.error?.message ?? code } }
  }

  const files: PanelFile[] = []
  const shots: string[] = []
  for (const entry of root.value?.entries ?? []) {
    if (entry.type === 'file' && isPanelVideo(entry.name)) {
      files.push({ path: `${RENDERS_DIRECTORY}/${entry.name}`, bytes: entry.size ?? null })
    } else if (entry.type === 'directory') {
      shots.push(entry.name)
    }
  }

  const listed = shots.slice(0, MAX_SHOT_DIRECTORIES)
  let truncated = root.value?.truncated === true || shots.length > listed.length
  const listings = await mapLimit(listed, LIST_CONCURRENCY, async (shot: string) => remote.list(deps.sessionId, `${RENDERS_DIRECTORY}/${shot}`, signal))
  for (const [index, listing] of listings.entries()) {
    // A shot that vanished between the two calls is not worth a message.
    if (!listing.ok) continue
    if (listing.value?.truncated === true) truncated = true
    for (const entry of listing.value?.entries ?? []) {
      if (entry.type === 'file' && isPanelVideo(entry.name)) {
        files.push({ path: `${RENDERS_DIRECTORY}/${listed[index] ?? ''}/${entry.name}`, bytes: entry.size ?? null })
      }
    }
  }

  const kept = files.slice(0, MAX_FILES)
  return {
    files: kept,
    problem: truncated || kept.length < files.length ? { kind: 'truncated', detail: null } : { kind: 'none' },
  }
}

/**
 * Run an async mapper with a fixed number of tasks in flight, preserving order.
 *
 * @param items - the work items, in display order.
 * @param limit - how many may run at once.
 * @param map - the async mapper.
 * @returns results in input order.
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await map(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
