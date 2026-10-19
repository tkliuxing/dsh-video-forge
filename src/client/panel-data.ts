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

/** Shot directories one load will list. Beyond this the scan stops, so a pathological tree cannot stall the panel. */
const MAX_SHOT_DIRECTORIES = 80

/** Files one load keeps. */
const MAX_FILES = 400

/** One `RemoteResult` frame, as this module reads it. */
interface RemoteResultLike<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** One directory listing, as this module reads it. */
interface DirectoryListingLike {
  readonly entries: readonly { readonly name: string; readonly type: string; readonly size?: number }[]
}

/** The `remote.workspaceFiles` methods the scan uses. */
export interface WorkspaceFilesRemoteLike {
  list(sessionId: string, path: string, signal?: AbortSignal): Promise<RemoteResultLike<DirectoryListingLike>>
}

/** What one load of the panel needs. */
export interface PanelLoad {
  tasks: PanelTask[]
  /** `.mp4` files found under `renders/`, workspace-relative. */
  files: PanelFile[]
  /** Whether the host reported its Range-capable stream route. */
  stream: boolean
  /** Why the directory scan failed, when it did; the ledger rows are still shown. */
  scanError: string | null
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
  const overview = await fetchOverview(PANEL_TASK_LIMIT)
  if (!overview.ok) throw new Error(overview.error)
  const scan = await scanRenders(deps, signal)
  return {
    tasks: overview.value.tasks,
    files: scan.files,
    stream: overview.value.features?.stream === true,
    scanError: scan.error,
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
export async function scanRenders(deps: PanelDataDeps, signal: AbortSignal): Promise<{ files: PanelFile[]; error: string | null }> {
  const remote = deps.remote
  if (remote === undefined) return { files: [], error: 'the workspace file service is not loaded' }

  const root = await remote.list(deps.sessionId, RENDERS_DIRECTORY, signal)
  if (!root.ok) {
    const code = root.error?.code ?? ''
    // Nothing generated yet: an empty list, not a failure to report.
    if (code === 'workspace-file/not-found' || code === 'FS_NOT_FOUND') return { files: [], error: null }
    return { files: [], error: root.error?.message ?? code }
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

  for (const shot of shots.slice(0, MAX_SHOT_DIRECTORIES)) {
    if (files.length >= MAX_FILES) break
    const listing = await remote.list(deps.sessionId, `${RENDERS_DIRECTORY}/${shot}`, signal)
    // A shot that vanished between the two calls is not worth a message.
    if (!listing.ok) continue
    for (const entry of listing.value?.entries ?? []) {
      if (files.length >= MAX_FILES) break
      if (entry.type === 'file' && isPanelVideo(entry.name)) {
        files.push({ path: `${RENDERS_DIRECTORY}/${shot}/${entry.name}`, bytes: entry.size ?? null })
      }
    }
  }

  return { files, error: null }
}
