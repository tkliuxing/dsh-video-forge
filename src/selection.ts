/**
 * The conversation's video target (M6, DESIGN §20): the per-session choice of
 * provider, model and geometry that the composer chip writes and the tools
 * read.
 *
 * Scope is the **conversation**, not the workspace. A new conversation starts
 * on whatever `video-project.yaml` and the plugin settings say, so a choice made
 * for one film does not silently follow the next one. The resolution chain is
 *
 *   tool arguments > this selection > video-project.yaml defaults > plugin settings
 *
 * and every layer that supplies a field is named in the tool result, because a
 * quiet default is exactly how a 10-second shot becomes 5 seconds.
 *
 * The file lives in the plugin's own directory under `$DSH_HOME`
 * (`selections.json`), never in the workspace. That is what keeps DESIGN §16.4
 * true while the browser gains a write: it still submits no generation and
 * writes no workspace file. Losing this file costs one chip selection and
 * nothing else, so a corrupt one is ignored rather than quarantined — but a read
 * that failed for any other reason blocks writing, since overwriting a file we
 * could not read would drop the other conversations' choices.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'

/** The most characters a provider / model / resolution / aspect-ratio id may hold. */
const MAX_ID_LENGTH = 200

/** Conversations retained; the newest by `updatedAt` win and older ones fall off. */
const DEFAULT_MAX_SESSIONS = 200

/** Longest duration a chip may set — the providers' own maxima are far lower. */
const MAX_DURATION_SECONDS = 3600

/** One conversation's choice. `null` in every field means "not chosen here". */
export interface SessionSelection {
  /** Provider id, or null when this conversation chooses none. */
  readonly provider: string | null
  /** Model id inside {@link provider}; null only for a selection no chip wrote. */
  readonly model: string | null
  readonly durationSeconds: number | null
  readonly resolution: string | null
  readonly aspectRatio: string | null
  /** When this choice was last written; also the eviction order for the cap. */
  readonly updatedAt: string
}

/** What a caller may set: everything but the timestamp, which the store stamps. */
export type SelectionInput = Omit<SessionSelection, 'updatedAt'>

/** A malformed selection or session id; the panel API turns it into a 400. */
export class SelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SelectionError'
  }
}

/** Whether a string can be used as a session id key (no whitespace, bounded). */
export function isSessionId(value: string): boolean {
  return value !== '' && value.length <= MAX_ID_LENGTH && !/\s/.test(value)
}

function idOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new SelectionError(`${field} must be a string or null`)
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > MAX_ID_LENGTH) throw new SelectionError(`${field} is longer than ${MAX_ID_LENGTH} characters`)
  return trimmed
}

function durationOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DURATION_SECONDS) {
    throw new SelectionError(`durationSeconds must be a positive number of seconds no greater than ${MAX_DURATION_SECONDS}`)
  }
  return value
}

/**
 * Read a selection out of a request body (or a stored row), refusing what cannot
 * be a real choice. `provider` and `model` travel together: a model id alone is
 * ambiguous across providers, and guessing which provider owns it is how a paid
 * request reaches the wrong endpoint.
 */
export function parseSelectionInput(value: unknown): SelectionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SelectionError('the selection must be a JSON object')
  }
  const body = value as Record<string, unknown>
  const provider = idOrNull(body.provider, 'provider')
  const model = idOrNull(body.model, 'model')
  if (provider === null && model !== null) {
    throw new SelectionError('model names a model inside a provider: send provider as well, or neither')
  }
  return {
    provider,
    model,
    durationSeconds: durationOrNull(body.durationSeconds),
    resolution: idOrNull(body.resolution, 'resolution'),
    aspectRatio: idOrNull(body.aspectRatio, 'aspectRatio'),
  }
}

/** A stored row, or null when the row is not a selection this build understands. */
function parseStoredRow(key: string, value: unknown): { sessionId: string; selection: SessionSelection } | null {
  if (!isSessionId(key)) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  try {
    const input = parseSelectionInput(row)
    const updatedAt = typeof row.updatedAt === 'string' && row.updatedAt !== '' ? row.updatedAt : new Date(0).toISOString()
    return { sessionId: key, selection: { ...input, updatedAt } }
  } catch {
    // One unreadable row must not cost the other conversations their choices.
    return null
  }
}

export interface SelectionStoreOptions {
  /** Absolute path of `selections.json`. */
  path: string
  maxSessions?: number
}

/**
 * The selections on disk, held in memory for the life of the process.
 *
 * Every read and write goes through {@link SelectionStore.load}, so a session
 * whose chip has never been opened costs one `readFile` for the process, not
 * one per tool call.
 */
export class SelectionStore {
  readonly #options: { path: string; maxSessions: number }
  #sessions = new Map<string, SessionSelection>()
  #read: 'unread' | 'reading' | 'read' | 'failed' = 'unread'
  #reading: Promise<void> | null = null
  #readFailure: unknown = null
  /** Serialises writers: two chips (or a chip and a tool) must not interleave a write. */
  #writes: Promise<void> = Promise.resolve()

  constructor(options: SelectionStoreOptions) {
    this.#options = { path: options.path, maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS }
  }

  /** Absolute path of the document. */
  get path(): string {
    return this.#options.path
  }

  /** Apply a live retention limit (a shared store outlives the instance that created it). */
  setMaxSessions(maxSessions: number): void {
    this.#options.maxSessions = maxSessions
  }

  /**
   * Read the document once. A missing file is an empty store; a file that does
   * not parse is an empty store that the next write replaces (a preference is
   * not worth the ledger's quarantine ceremony); any other read failure is
   * remembered and refuses later writes.
   */
  load(): Promise<void> {
    if (this.#read === 'read') return Promise.resolve()
    if (this.#read === 'reading' && this.#reading !== null) return this.#reading
    this.#read = 'reading'
    const reading = this.#readFile().then(
      () => { this.#read = 'read' },
      (error: unknown) => {
        this.#read = 'failed'
        this.#readFailure = error
        throw error
      },
    )
    this.#reading = reading
    // A second caller awaits the same promise, and the settled state is what
    // decides; drop the handle so a re-applied instance can retry a real failure.
    reading.then(() => { this.#reading = null }, () => { this.#reading = null })
    return reading
  }

  /**
   * One conversation's choice, or null when it has none.
   *
   * A document that could not be read answers null instead of throwing: an
   * unreadable preference file must never stop a generation. Callers that want
   * to say so out loud read {@link SelectionStore.readProblem} and mention it.
   */
  async get(sessionId: string): Promise<SessionSelection | null> {
    try {
      await this.load()
    } catch {
      return null
    }
    return this.#sessions.get(sessionId) ?? null
  }

  /** Why the document could not be read, or null when it was read (or is absent). */
  readProblem(): string | null {
    if (this.#read !== 'failed') return null
    return `the video selection file at ${this.#options.path} could not be read (${this.#readFailure instanceof Error ? this.#readFailure.message : String(this.#readFailure)})`
  }

  /** Write one conversation's choice and return what was stored. */
  async set(sessionId: string, input: SelectionInput): Promise<SessionSelection> {
    if (!isSessionId(sessionId)) throw new SelectionError('a session id is required')
    await this.#ensureWritable()
    const selection: SessionSelection = { ...input, updatedAt: new Date().toISOString() }
    await this.#write((sessions) => {
      sessions.set(sessionId, selection)
      this.#evict(sessions)
    })
    return selection
  }

  /** Forget one conversation's choice; returns whether there was one. */
  async clear(sessionId: string): Promise<boolean> {
    if (!isSessionId(sessionId)) throw new SelectionError('a session id is required')
    await this.#ensureWritable()
    if (!this.#sessions.has(sessionId)) return false
    await this.#write((sessions) => { sessions.delete(sessionId) })
    return true
  }

  async #readFile(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.#options.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const sessions = (parsed as { sessions?: unknown }).sessions
    if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return
    for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
      const row = parseStoredRow(key, value)
      if (row !== null) this.#sessions.set(row.sessionId, row.selection)
    }
    this.#evict(this.#sessions)
  }

  /** Keep the newest `maxSessions` choices; nothing else about a selection is worth evicting. */
  #evict(sessions: Map<string, SessionSelection>): void {
    const excess = sessions.size - this.#options.maxSessions
    if (excess <= 0) return
    const oldest = [...sessions.entries()]
      .sort((left, right) => left[1].updatedAt.localeCompare(right[1].updatedAt))
      .slice(0, excess)
    for (const [key] of oldest) sessions.delete(key)
  }

  /**
   * Read the document and refuse to write over one that could not be read. The
   * read error itself is not surfaced: it is remembered by `readProblem`, and the
   * sentence the caller needs is about the document, not about `EISDIR`.
   */
  async #ensureWritable(): Promise<void> {
    try {
      await this.load()
    } catch {
      // The refusal below carries the reason.
    }
    const problem = this.readProblem()
    if (problem !== null) throw new SelectionError(`${problem}; not overwriting it`)
  }

  /**
   * Apply a mutation to a copy, flush the copy, and only then commit it: a failed
   * write leaves memory agreeing with the file on disk.
   */
  async #write(mutate: (sessions: Map<string, SessionSelection>) => void): Promise<void> {
    const flush = async (sessions: Map<string, SessionSelection>): Promise<void> => {
      const next = new Map(sessions)
      mutate(next)
      await this.#flush(next)
      this.#sessions = next
    }
    const run = this.#writes.then(() => flush(this.#sessions))
    this.#writes = run.then(() => undefined, () => undefined)
    return run
  }

  /** Atomic replace: temp file in the same directory, mode 0600, then rename. */
  async #flush(sessions: Map<string, SessionSelection>): Promise<void> {
    const directory = dirname(this.#options.path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.selections.json.${process.pid}.${Date.now()}.tmp`)
    const document = { version: 1, sessions: Object.fromEntries(sessions) }
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, this.#options.path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

/**
 * The store for one file, shared by every plugin instance in this process.
 *
 * cordis re-applies the plugin when `tools` or `webServer` change, and both
 * instances serve the same conversations: two stores on one file would each
 * flush their own copy and the older one would erase the newer one's choices.
 */
export function sharedSelections(options: SelectionStoreOptions): SelectionStore {
  const path = resolvePath(options.path)
  const existing = SHARED_SELECTIONS.get(path)
  if (existing !== undefined) {
    existing.setMaxSessions(options.maxSessions ?? DEFAULT_MAX_SESSIONS)
    return existing
  }
  const store = new SelectionStore({ ...options, path })
  SHARED_SELECTIONS.set(path, store)
  return store
}

const SHARED_SELECTIONS = new Map<string, SelectionStore>()
