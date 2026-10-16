/**
 * Live task state for the chat cards (DESIGN §16.4, §17.2).
 *
 * A tool card's props freeze when the result is recorded, so a card that should
 * show a generation advancing reads it from here instead: one observable source
 * per task id, kept by the plugin, polled from the panel API's single-task
 * overview. The ledger is the authority — job ids are reused after a restart
 * and are never used here.
 *
 * Polling is reference-counted and lazy. A source starts asking when its first
 * card subscribes and stops when the last one leaves; it asks once for a task
 * that has already settled (a reloaded page still learns that a video was moved
 * or deleted), and keeps asking only while the task can still change. History
 * full of finished videos therefore costs one request per card, not a stream.
 */

import { cancelGeneration, fetchTask, type LiveTask, type PanelResult } from './panel-api.ts'

/** What a card renders: the latest row, or why there is none. */
export interface LiveSnapshot {
  task: LiveTask | null
  /** The last poll's failure, while it lasts; the previous row is kept. */
  error: string | null
  /** True once one answer (row or error) has arrived. */
  loaded: boolean
  /**
   * Asking again cannot help: the panel API refused this browser (403) or this
   * host's ledger has no such task (404, a transcript from another profile).
   * The card then keeps showing what the call returned.
   */
  stopped: boolean
}

/** The observable shape a card subscribes to (`useSyncExternalStore`). */
export interface LiveSource {
  getSnapshot(): LiveSnapshot
  subscribe(listener: () => void): () => void
}

export interface CancelOutcome {
  ok: boolean
  message: string
}

/** The face injected into the generate card. */
export interface LiveTasks {
  /** The source for one task; the same object for the same id. */
  source(taskId: string): LiveSource
  /** Ask the provider to cancel, then refresh that task at once. */
  cancel(taskId: string): Promise<CancelOutcome>
}

/** Statuses after which nothing about the task changes on its own. */
const SETTLED = new Set(['succeeded', 'failed', 'cancelled'])

/** Statuses that are being worked on now, and worth a quick poll. */
const MOVING = new Set(['submitting', 'queued', 'running'])

export interface LiveTasksOptions {
  /** Poll interval while the task is moving. */
  fastMs?: number
  /** Poll interval while it waits on the host's own retries (`orphaned`, `unconfirmed`). */
  slowMs?: number
  fetchTask?: typeof fetchTask
  cancelTask?: (taskId: string) => Promise<PanelResult<{ cancelled: boolean; message: string; status: string }>>
}

const INITIAL: LiveSnapshot = { task: null, error: null, loaded: false, stopped: false }

/** HTTP answers that will not change by asking again. */
const PERMANENT = new Set([403, 404])

/** What a disposed store hands out: nothing, quietly. */
const INERT: LiveSource = { getSnapshot: () => INITIAL, subscribe: () => () => undefined }

export function createLiveTasks(options: LiveTasksOptions = {}): LiveTasks & { dispose(): void } {
  const fastMs = options.fastMs ?? 3000
  const slowMs = options.slowMs ?? 30_000
  const read = options.fetchTask ?? fetchTask
  const cancelRemote = options.cancelTask ?? cancelGeneration

  interface Entry {
    source: LiveSource
    snapshot: LiveSnapshot
    listeners: Set<() => void>
    timer: ReturnType<typeof setTimeout> | undefined
    inFlight: boolean
    /** A refresh asked for while a poll was in flight (after a cancel): run it next. */
    again: boolean
  }
  const entries = new Map<string, Entry>()
  let disposed = false

  const publish = (entry: Entry, next: LiveSnapshot): void => {
    entry.snapshot = next
    for (const listener of [...entry.listeners]) listener()
  }

  const schedule = (taskId: string, entry: Entry): void => {
    if (disposed || entry.listeners.size === 0 || entry.timer !== undefined || entry.snapshot.stopped) return
    const status = entry.snapshot.task?.status
    // No answer yet, or an error: keep trying at the slow pace.
    if (status !== undefined && SETTLED.has(status) && entry.snapshot.error === null) return
    const delay = status !== undefined && MOVING.has(status) && entry.snapshot.error === null ? fastMs : slowMs
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      void poll(taskId, entry)
    }, delay)
  }

  const poll = async (taskId: string, entry: Entry): Promise<void> => {
    if (disposed) return
    if (entry.inFlight) {
      // This answer may predate what the caller just did; ask once more after it.
      entry.again = true
      return
    }
    entry.inFlight = true
    try {
      const result = await read(taskId)
      if (result.ok) publish(entry, { task: result.value.task, error: null, loaded: true, stopped: false })
      else {
        const stopped = result.status !== undefined && PERMANENT.has(result.status)
        publish(entry, { task: entry.snapshot.task, error: stopped ? null : result.error, loaded: true, stopped })
      }
    } catch (error: unknown) {
      publish(entry, { task: entry.snapshot.task, error: error instanceof Error ? error.message : String(error), loaded: true, stopped: false })
    } finally {
      entry.inFlight = false
    }
    if (entry.again && !disposed) {
      entry.again = false
      void poll(taskId, entry)
      return
    }
    schedule(taskId, entry)
  }

  const entryFor = (taskId: string): Entry => {
    const existing = entries.get(taskId)
    if (existing !== undefined) return existing
    const entry: Entry = {
      snapshot: INITIAL,
      listeners: new Set(),
      timer: undefined,
      inFlight: false,
      again: false,
      source: {
        getSnapshot: () => entry.snapshot,
        subscribe: (listener) => {
          entry.listeners.add(listener)
          // The first subscriber starts the polling; a later one shares it.
          if (entry.listeners.size === 1 && entry.timer === undefined && !entry.inFlight) void poll(taskId, entry)
          return () => {
            entry.listeners.delete(listener)
            if (entry.listeners.size === 0 && entry.timer !== undefined) {
              clearTimeout(entry.timer)
              entry.timer = undefined
            }
          }
        },
      },
    }
    entries.set(taskId, entry)
    return entry
  }

  return {
    source: taskId => (disposed ? INERT : entryFor(taskId).source),
    async cancel(taskId) {
      if (disposed) return { ok: false, message: 'the video-forge client was unloaded' }
      const result = await cancelRemote(taskId)
      const entry = entries.get(taskId)
      if (entry !== undefined) {
        if (entry.timer !== undefined) {
          clearTimeout(entry.timer)
          entry.timer = undefined
        }
        void poll(taskId, entry)
      }
      return result.ok ? { ok: result.value.cancelled, message: result.value.message } : { ok: false, message: result.error }
    },
    dispose() {
      disposed = true
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        entry.timer = undefined
        entry.listeners.clear()
      }
      entries.clear()
    },
  }
}
