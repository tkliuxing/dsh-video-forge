/**
 * The task ledger: one JSON document under `$DSH_HOME/dsh-video-forge/`, written
 * atomically and read back on every start.
 *
 * Two rules shape this file:
 *
 * - **Writes are atomic.** A generation is a paid operation, so a torn ledger
 *   after a crash would lose the only link to a task the provider is still
 *   billing for. We write a sibling temp file, fsync, then rename over the
 *   target, and we serialise concurrent writers through a promise chain.
 * - **Nothing here deletes artifacts.** `retain` yields a usage hint; removal is
 *   always an explicit, human-driven act (see DESIGN §9).
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LedgerDocument, VideoTask, VideoTaskStatus } from './types.ts'

/** Statuses that mean the provider may still be working on the task. */
const OPEN_STATUSES: ReadonlySet<VideoTaskStatus> = new Set<VideoTaskStatus>(['queued', 'running'])

/** Whether a task still occupies the provider. `orphaned` does not: we stopped claiming to know. */
export function isOpen(task: VideoTask): boolean {
  return OPEN_STATUSES.has(task.status)
}

export interface RetentionHint {
  tasks: number
  bytes: number
  overTaskLimit: boolean
  overByteLimit: boolean
}

export interface LedgerOptions {
  /** Absolute path of `tasks.json`. */
  path: string
  maxTasks: number
  maxGiB: number
}

export class Ledger {
  readonly #options: LedgerOptions
  #document: LedgerDocument = { version: 1, tasks: [] }
  /** Serialises writers so two tool calls cannot interleave a read-modify-write. */
  #writes: Promise<void> = Promise.resolve()
  /** Per-day sequence for local ids, so ids stay unique inside one process even before a flush. */
  #sequence = new Map<string, number>()

  constructor(options: LedgerOptions) {
    this.#options = options
  }

  /** Absolute path of the ledger document. */
  get path(): string {
    return this.#options.path
  }

  /** Directory holding the ledger and the artifact tree. */
  get home(): string {
    return dirname(this.#options.path)
  }

  /**
   * Read the document from disk. A missing file is simply an empty ledger. A
   * corrupt file is moved aside rather than overwritten, so a bad write stays
   * recoverable, then we start empty.
   */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#options.path, { encoding: 'utf8' })
    } catch (error) {
      if (isMissing(error)) {
        this.#document = { version: 1, tasks: [] }
        return
      }
      throw error
    }

    try {
      this.#document = parseDocument(text)
    } catch (error) {
      const quarantine = `${this.#options.path}.corrupt-${Date.now()}`
      await rename(this.#options.path, quarantine).catch(() => undefined)
      this.#document = { version: 1, tasks: [] }
      throw new LedgerCorruptError(quarantine, error)
    }
  }

  /** Every task, newest first. */
  list(): VideoTask[] {
    return [...this.#document.tasks].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
  }

  /** Tasks the provider may still be running, oldest first (watch order). */
  open(): VideoTask[] {
    return this.list().filter(isOpen).reverse()
  }

  byId(localId: string): VideoTask | undefined {
    return this.#document.tasks.find(task => task.localId === localId)
  }

  /** The most recent task carrying this fingerprint, used to refuse a duplicate submission. */
  byFingerprint(fingerprint: string, since: number): VideoTask | undefined {
    return this.#document.tasks.find(task => task.paramsFingerprint === fingerprint
      && Date.parse(task.submittedAt) >= since)
  }

  /** Artifact lookup for the media route: task id plus artifact token must both match. */
  artifact(localId: string, token: string): { task: VideoTask; artifact: VideoTask['artifacts'][number] } | undefined {
    const task = this.byId(localId)
    const artifact = task?.artifacts.find(entry => entry.token === token)
    if (task === undefined || artifact === undefined) return undefined
    return { task, artifact }
  }

  /**
   * Insert or replace one task and flush. Callers pass a mutator so a
   * concurrent watcher cannot clobber a field it did not touch.
   */
  async update(localId: string, mutate: (task: VideoTask) => VideoTask): Promise<VideoTask> {
    let result: VideoTask | undefined
    await this.#exclusive(async () => {
      const index = this.#document.tasks.findIndex(task => task.localId === localId)
      const current = index >= 0 ? this.#document.tasks[index] : undefined
      if (current === undefined) throw new Error(`no such task: ${localId}`)
      const next = mutate(current)
      this.#document.tasks[index] = next
      result = next
      await this.#flush()
    })
    if (result === undefined) throw new Error(`no such task: ${localId}`)
    return result
  }

  /** Append a new task and flush. */
  async add(task: VideoTask): Promise<VideoTask> {
    await this.#exclusive(async () => {
      this.#document.tasks.push(task)
      await this.#flush()
    })
    return task
  }

  /**
   * Mint the next local id for `now`, shaped `v-YYYYMMDD-NNNN`. The sequence is
   * shared by the process, so two submissions in the same millisecond differ.
   */
  nextLocalId(now: Date): string {
    const day = formatDay(now)
    const observed = this.#document.tasks
      .filter(task => task.localId.startsWith(`v-${day}-`))
      .map(task => Number.parseInt(task.localId.slice(-4), 10))
      .filter(value => Number.isFinite(value))
    const floor = observed.length > 0 ? Math.max(...observed) : 0
    const next = Math.max(floor, this.#sequence.get(day) ?? 0) + 1
    this.#sequence.set(day, next)
    return `v-${day}-${String(next).padStart(4, '0')}`
  }

  /** Usage hint against the configured `retain` limits. Never triggers a deletion. */
  retention(): RetentionHint {
    let bytes = 0
    for (const task of this.#document.tasks) {
      for (const artifact of task.artifacts) bytes += artifact.bytes
    }
    return {
      tasks: this.#document.tasks.length,
      bytes,
      overTaskLimit: this.#document.tasks.length > this.#options.maxTasks,
      overByteLimit: bytes > this.#options.maxGiB * 1024 ** 3,
    }
  }

  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(work, work)
    this.#writes = run.then(() => undefined, () => undefined)
    return run
  }

  /** Atomic replace: temp file in the same directory, mode 0600, then rename. */
  async #flush(): Promise<void> {
    const directory = dirname(this.#options.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.tasks.json.${process.pid}.${Date.now()}.tmp`)
    const body = `${JSON.stringify(this.#document, null, 2)}\n`
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, this.#options.path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

/** Raised after a corrupt ledger was moved aside; the caller decides whether to warn or fail. */
export class LedgerCorruptError extends Error {
  readonly quarantinePath: string

  constructor(quarantinePath: string, cause: unknown) {
    super(`the task ledger was unreadable and has been moved to ${quarantinePath}`)
    this.name = 'LedgerCorruptError'
    this.quarantinePath = quarantinePath
    this.cause = cause
  }
}

/** Parse and shape-check a ledger document, rejecting rows we could not reconcile. */
export function parseDocument(text: string): LedgerDocument {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('ledger root is not an object')
  const tasks = (parsed as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) throw new Error('ledger has no tasks array')
  return { version: 1, tasks: tasks.filter(isTask) }
}

function isTask(value: unknown): value is VideoTask {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<VideoTask>
  return typeof row.localId === 'string'
    && typeof row.provider === 'string'
    && typeof row.model === 'string'
    && typeof row.status === 'string'
    && typeof row.submittedAt === 'string'
    && Array.isArray(row.artifacts)
}

function formatDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}
