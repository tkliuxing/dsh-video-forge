/**
 * The runtime object the tools share: one place that turns a task row into the
 * URLs and paths everything else needs, so no tool re-derives them.
 */

import { join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { Ledger } from './ledger.ts'
import { HOME_DIRECTORY, MEDIA_ROUTE_PREFIX, type ModelSetting, type ProviderSetting, type VideoForgeSettings } from './settings.ts'
import type { VideoArtifact, VideoTask } from './types.ts'
import type { WatchLogger } from './watch.ts'

export interface VideoForgeRuntime {
  readonly ctx: Context
  readonly ledger: Ledger
  readonly logger: WatchLogger
  /** Current plain config snapshot; re-read per operation so live edits apply. */
  settings(): VideoForgeSettings
  /** Artifact root, honouring `outputDir`. */
  outputRoot(): string
  /** Per-task artifact directory. */
  outputDirectory(localId: string): string
  /** Start watching a task; returns null when no job registry is available. */
  watchTask(input: {
    task: VideoTask
    provider: ProviderSetting
    model: ModelSetting
    apiKey: string | null
    baseUrl: string
    /** Calling session id; a job with no live owner is allowed but cannot wake a session. */
    owner?: string | undefined
  }): JobId | null
  /** Cancel handles registered by watches, keyed by local task id. */
  readonly cancels: Map<string, () => Promise<boolean>>
  /**
   * Local ids with a live watch in this process. Reconciliation and the orphan
   * retry skip them: a second watch on one row downloads the same artifact twice
   * into one path and replaces the token the first one already handed out.
   */
  readonly watching: Set<string>
}

/** Absolute path of the plugin's home under `$DSH_HOME`. */
export function pluginHome(home: string): string {
  return join(home, HOME_DIRECTORY)
}

/**
 * The media URL for one artifact, **document-relative** (no leading slash).
 *
 * The GUI is served with `<base href="./">`, so a relative URL resolves against
 * the document's own directory and survives a sub-path deployment; an absolute
 * one would escape to the origin root. This is the shipped convention
 * (`api/dsh-usage/overview`), and the browser card resolves it the same way
 * before handing it to `<video src>`.
 */
export function artifactUrl(task: VideoTask, artifact: VideoArtifact): string {
  const name = artifact.path.split('/').pop() ?? 'video.mp4'
  return `${MEDIA_ROUTE_PREFIX.replace(/^\//, '')}/${task.localId}/${artifact.token}/${name}`
}

/**
 * The live-watch table for one ledger file, shared by every plugin instance in
 * this process. cordis re-applies the plugin when `tools` or `webServer` change,
 * and the previous instance's watches keep running for a while; a per-instance
 * table would let the new instance's boot pass reattach those rows a second time.
 */
export function watchTableFor(ledgerPath: string): Set<string> {
  // Keyed like `sharedLedger`: two spellings of one file must share one table.
  const key = resolvePath(ledgerPath)
  let table = WATCH_TABLES.get(key)
  if (table === undefined) {
    table = new Set()
    WATCH_TABLES.set(key, table)
  }
  return table
}

const WATCH_TABLES = new Map<string, Set<string>>()

/**
 * The live watch jobs for one ledger file (job id → task), shared like the
 * watch table: a re-applied instance must still recognise a kill of a watch
 * the previous instance started.
 */
export function jobTableFor(ledgerPath: string): Map<string, string> {
  const key = resolvePath(ledgerPath)
  let table = JOB_TABLES.get(key)
  if (table === undefined) {
    table = new Map()
    JOB_TABLES.set(key, table)
  }
  return table
}

const JOB_TABLES = new Map<string, Map<string, string>>()
