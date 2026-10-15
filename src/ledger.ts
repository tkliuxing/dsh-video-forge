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
import { MODERATION_STAGES, NOT_SUBMITTED_CODE, VIDEO_TASK_STATUSES, type LedgerDocument, type TaskBilling, type VideoTask, type VideoTaskStatus } from './types.ts'

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
  /** Settles once the latest {@link load} has, whatever its outcome. */
  #loading: Promise<void> | null = null

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
  load(): Promise<void> {
    const loading = this.#read()
    this.#loading = loading.then(() => undefined, () => undefined)
    return loading
  }

  /**
   * Resolves once a pending {@link load} has settled. The tools are registered
   * before the ledger is read, and a submission against an unread ledger would
   * miss every duplicate it holds — then flush a document without them.
   */
  ready(): Promise<void> {
    return this.#loading ?? Promise.resolve()
  }

  async #read(): Promise<void> {
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

  /** Rows whose create request has no confirmed provider id yet, oldest first (recovery order). */
  unresolved(): VideoTask[] {
    return this.list().filter(task => task.status === 'submitting' || task.status === 'unconfirmed').reverse()
  }

  byId(localId: string): VideoTask | undefined {
    return this.#document.tasks.find(task => task.localId === localId)
  }

  /**
   * The most recent task carrying this fingerprint, used to refuse a duplicate
   * submission. A row whose create request never produced a provider task is
   * skipped: retrying it cannot charge twice. An `unconfirmed` row is *not*
   * skipped — it may well have been charged once already.
   */
  byFingerprint(fingerprint: string, since: number): VideoTask | undefined {
    return this.#document.tasks.find(task => task.paramsFingerprint === fingerprint
      && Date.parse(task.submittedAt) >= since
      && !neverSubmitted(task))
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
      result = next
      // A mutator that returns the row untouched means "nothing to record".
      if (next === current) return
      this.#document.tasks[index] = next
      await this.#flush()
    })
    if (result === undefined) throw new Error(`no such task: ${localId}`)
    return result
  }

  /**
   * Append a new task and flush. `guard` runs inside the writer lock, right
   * before the append, so a check such as "no identical request is in flight"
   * cannot race a concurrent submission between the check and the write.
   */
  async add(task: VideoTask, guard?: () => void): Promise<VideoTask> {
    await this.#exclusive(async () => {
      guard?.()
      this.#document.tasks.push(task)
      try {
        await this.#flush()
      } catch (error) {
        // An append that never reached disk must not linger in memory: it would
        // hold a slot and a fingerprint for a request that was never sent.
        this.#document.tasks = this.#document.tasks.filter(entry => entry !== task)
        throw error
      }
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
    const gated = async (): Promise<T> => {
      await this.ready()
      return work()
    }
    const run = this.#writes.then(gated, gated)
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
  return { version: 1, tasks: tasks.filter(isTask).map(normaliseStatus) }
}

/** Whether a row's create request is known never to have produced a provider task. */
export function neverSubmitted(task: VideoTask): boolean {
  return task.status === 'failed' && task.providerTaskId === null && task.error?.code === NOT_SUBMITTED_CODE
}

/**
 * Keep every row, but never claim more than the row proves. A status word this
 * build does not know (a newer writer) is read as `orphaned`; an open row with no
 * provider id cannot be polled, so it is read as `unconfirmed`. Dropping either
 * would lose the only record of a task that may be billing.
 */
function normaliseStatus(task: VideoTask): VideoTask {
  const providerTaskId = typeof task.providerTaskId === 'string' && task.providerTaskId !== '' ? task.providerTaskId : null
  let status: VideoTaskStatus = VIDEO_TASK_STATUSES.includes(task.status) ? task.status : 'orphaned'
  if ((status === 'queued' || status === 'running') && providerTaskId === null) status = 'unconfirmed'
  // A usage record this build cannot read (hand-edited, or reshaped by a newer
  // writer) is dropped, not trusted: the settlement pass asks the provider again.
  const billingOk = task.billing === undefined || task.billing === null || isBilling(task.billing)
  const error = errorOf(task.error)
  if (status === task.status && providerTaskId === task.providerTaskId && billingOk && error === task.error) return task
  return { ...task, status, providerTaskId, error, ...(billingOk ? {} : { billing: null }) }
}

/**
 * The row's error as this build can use it. A missing or malformed error reads
 * as none — one odd row must never make the whole document unreadable, which
 * would quarantine every paid task in it — and a moderation tag this build does
 * not know is dropped, not guessed at. Returns the same object when it is fine.
 */
function errorOf(value: unknown): VideoTask['error'] {
  if (typeof value !== 'object' || value === null) return null
  const error = value as Partial<NonNullable<VideoTask['error']>>
  if (typeof error.message !== 'string') return null
  const code = typeof error.code === 'string' ? error.code : null
  const moderationOk = error.moderation === undefined || MODERATION_STAGES.includes(error.moderation)
  if (code === error.code && moderationOk) return value as NonNullable<VideoTask['error']>
  return moderationOk && error.moderation !== undefined
    ? { message: error.message, code, moderation: error.moderation }
    : { message: error.message, code }
}

function isBilling(value: unknown): value is TaskBilling {
  if (typeof value !== 'object' || value === null) return false
  const billing = value as Partial<TaskBilling>
  const numberOrNull = (field: unknown): boolean => field === null || (typeof field === 'number' && Number.isFinite(field))
  return (billing.state === 'reported' || billing.state === 'none' || billing.state === 'unknown')
    && numberOrNull(billing.tokens)
    && numberOrNull(billing.outputSeconds)
    && typeof billing.settledAt === 'string'
    && typeof billing.fields === 'object' && billing.fields !== null
    && Object.values(billing.fields).every(field => typeof field === 'number' && Number.isFinite(field))
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
