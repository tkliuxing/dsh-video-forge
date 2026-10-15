/**
 * Boot-time reconciliation: settle whatever the previous process left behind.
 *
 * Two kinds of row need it, handled in this order:
 *
 * - **Unresolved submissions** (`submitting` / `unconfirmed`): the create request
 *   went out and no provider id came back. Where the protocol documents a task
 *   list (ARK), we look for a task created for the same model around the
 *   submission time; exactly one unclaimed match is adopted and watched. Anything
 *   else — no list, no match, several matches, list unreachable — stays
 *   `unconfirmed` with the reason spelled out. Never a re-submission: that is the
 *   second charge this whole path exists to prevent.
 * - **Open tasks** (`queued` / `running`): ask the provider what happened.
 *
 * A task we could not reattach is `orphaned`, which is not a verdict: as long as
 * the provider still answers queries for it (seven days on both documented
 * protocols) and nothing has been downloaded, it is asked again — at boot and on
 * a timer — because the usual reasons are passing ones: a credential store that
 * had not loaded yet, a network that timed out. Asking costs nothing; giving up
 * on a finished, paid generation costs the whole generation.
 */

import { awaitingBilling, settledBilling, unknownBilling } from './billing.ts'
import { resolveApiKey } from './credentials.ts'
import { downloadArtifact } from './download.ts'
import { isOpen, type Ledger } from './ledger.ts'
import { isSending, unconfirmedMessage } from './operations.ts'
import { adapterFor, type AdapterContext } from './providers/index.ts'
import type { VideoForgeRuntime } from './runtime.ts'
import { resolveTarget, type ModelSetting, type ProviderSetting } from './settings.ts'
import { UNCONFIRMED_CODE, type TaskBilling, type VideoTask } from './types.ts'
import { startInProcessWatch } from './watch.ts'

/** Clock skew tolerated between our submission time and the provider's `created_at`. */
const CLOCK_SKEW_MS = 2 * 60_000

/**
 * How far back a provider still answers for a task: ARK's task list and task
 * query, and MiniMax's query, are all documented as seven days.
 */
const PROVIDER_HORIZON_MS = 7 * 24 * 60 * 60_000

/** How long boot waits for a `credentials` service before reconciling without one. */
export const CREDENTIALS_GRACE_MS = 15_000

/** How often orphaned tasks are asked about again. */
export const ORPHAN_RETRY_MS = 5 * 60_000

/** Runtimes with a reconciliation pass in flight; a pass never overlaps another. */
const inFlight = new WeakSet<VideoForgeRuntime>()

/**
 * Settle everything the previous process left unresolved, open or orphaned.
 *
 * The tools are live while this runs, so the rows to settle are fixed up front:
 * a row this process is sending, or creates later, already has a watch (or a
 * submission) of its own and must not get a second one.
 */
export async function reconcile(runtime: VideoForgeRuntime): Promise<void> {
  if (inFlight.has(runtime)) return
  inFlight.add(runtime)
  try {
    const inherited = new Set(runtime.ledger.list().filter(task => !isSending(task.localId)).map(task => task.localId))
    await recoverUnresolved(runtime, inherited)
    const open = runtime.ledger.open().filter(task => inherited.has(task.localId))
    const orphans = recoverableOrphans(runtime.ledger).filter(task => inherited.has(task.localId))
    if (open.length > 0) runtime.logger.info(`video-forge: reconciling ${open.length} task(s) left by a previous process`)
    if (orphans.length > 0) runtime.logger.info(`video-forge: asking again about ${orphans.length} orphaned task(s)`)
    await reattach(runtime, [...open, ...orphans])
  } finally {
    inFlight.delete(runtime)
  }
}

/** Ask the providers again about every orphaned task they may still know. */
export async function retryOrphans(runtime: VideoForgeRuntime): Promise<void> {
  if (inFlight.has(runtime)) return
  const orphans = recoverableOrphans(runtime.ledger)
  if (orphans.length === 0) return
  inFlight.add(runtime)
  try {
    runtime.logger.info(`video-forge: asking again about ${orphans.length} orphaned task(s)`)
    await reattach(runtime, orphans)
  } finally {
    inFlight.delete(runtime)
  }
}

/** Runtimes with a usage-settlement pass in flight. */
const settling = new WeakSet<VideoForgeRuntime>()

/**
 * Record the usage of every finished task that does not have it yet.
 *
 * Usage only arrives once a task is over, and the providers answer queries for
 * seven days. A task nobody watched to the end — killed watch, orphan, a row from
 * before usage was recorded — would otherwise leave a hole in "how much did this
 * cost". Past the window the usage is recorded as unknown, never as zero.
 */
export async function settleBilling(runtime: VideoForgeRuntime): Promise<void> {
  if (settling.has(runtime)) return
  const owed = runtime.ledger.list().filter(awaitingBilling)
  if (owed.length === 0) return
  settling.add(runtime)
  try {
    const settings = runtime.settings()
    for (const task of owed) {
      const submittedAt = Date.parse(task.submittedAt)
      if (!Number.isFinite(submittedAt) || Date.now() - submittedAt > PROVIDER_HORIZON_MS) {
        await recordBilling(runtime.ledger, task, unknownBilling())
        continue
      }
      // Anything that stops us asking today is retried on the next pass, until
      // the window closes.
      try {
        const { provider, model } = resolveTarget(settings, task.provider, task.model)
        const apiKey = (await resolveApiKey(runtime.ctx, provider)).value
        const context: AdapterContext = { baseUrl: provider.baseUrl, apiKey, fetch, signal: AbortSignal.timeout(20_000) }
        const state = await adapterFor(provider, model).query(context, task.providerTaskId ?? '')
        if (state.terminal) await recordBilling(runtime.ledger, task, settledBilling(state.usage))
      } catch (error: unknown) {
        runtime.logger.warn(`video-forge: usage of ${task.localId} not settled yet: ${messageOf(error)}`)
      }
    }
  } finally {
    settling.delete(runtime)
  }
}

async function recordBilling(ledger: Ledger, task: VideoTask, billing: TaskBilling): Promise<void> {
  await ledger.update(task.localId, current => (awaitingBilling(current) ? { ...current, billing } : current))
}

/**
 * Orphaned tasks worth asking about again: the provider gave us an id, nothing
 * has been downloaded, and the provider still answers queries for it.
 */
export function recoverableOrphans(ledger: Ledger, now = Date.now()): VideoTask[] {
  return ledger.list()
    .filter(task => task.status === 'orphaned'
      && task.providerTaskId !== null
      && task.artifacts.length === 0
      && now - Date.parse(task.submittedAt) <= PROVIDER_HORIZON_MS)
    .reverse()
}

/** The slice of a plugin context boot scheduling needs; a fake in tests. */
export interface ReconcileHost {
  inject: (deps: string[], callback: () => void) => unknown
  effect: (execute: () => () => void, label?: string) => unknown
}

/**
 * Reconcile once the credential store can answer, then keep re-checking orphans.
 *
 * The local credential store publishes `credentials` only after reading its
 * file. A reconciliation started straight from `apply()` therefore found no key
 * for any provider and filed every healthy task as orphaned. So boot waits for
 * the service — or, in a composition without one, for a short grace period —
 * and a credential service that arrives later triggers an immediate re-check.
 */
export function scheduleReconciliation(
  host: ReconcileHost,
  boot: () => Promise<void>,
  retry: () => Promise<void>,
  onError: (error: unknown) => void,
  timing: { graceMs: number; retryMs: number } = { graceMs: CREDENTIALS_GRACE_MS, retryMs: ORPHAN_RETRY_MS },
): void {
  let phase: 'waiting' | 'booting' | 'ready' = 'waiting'
  const start = (): void => {
    if (phase !== 'waiting') return
    phase = 'booting'
    void boot().catch(onError).finally(() => {
      phase = 'ready'
    })
  }
  host.inject(['credentials'], () => {
    if (phase === 'ready') void retry().catch(onError)
    else start()
  })
  host.effect(() => {
    const grace = setTimeout(start, timing.graceMs)
    const timer = setInterval(() => {
      if (phase === 'ready') void retry().catch(onError)
    }, timing.retryMs)
    return () => {
      clearTimeout(grace)
      clearInterval(timer)
    }
  }, 'video-forge: reconcile and re-check orphaned tasks')
}

/** Try to find the provider task behind each submission whose outcome is unknown. */
async function recoverUnresolved(runtime: VideoForgeRuntime, inherited: ReadonlySet<string>): Promise<void> {
  const { ledger, logger } = runtime
  const pending = ledger.unresolved().filter(task => inherited.has(task.localId))
  if (pending.length === 0) return

  const settings = runtime.settings()
  logger.info(`video-forge: ${pending.length} submission(s) left with an unknown outcome; checking what the providers can tell`)

  for (const row of pending) {
    // A row still `submitting` belongs to a process that died mid-request.
    const task = row.status === 'submitting'
      ? await keepUnconfirmed(ledger, row, 'the process stopped while the create request was in flight')
      : row

    let provider: ProviderSetting
    let model: ModelSetting
    try {
      ({ provider, model } = resolveTarget(settings, task.provider, task.model))
    } catch (error: unknown) {
      logger.warn(`video-forge: ${task.localId} stays unconfirmed: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const adapter = adapterFor(provider, model)
    if (adapter.listCreated === undefined) {
      await keepUnconfirmed(ledger, task, `protocol ${provider.protocol} has no task-list endpoint, so this cannot be checked automatically — look for it in the ${provider.id} console`)
      continue
    }
    const submittedAt = Date.parse(task.submittedAt)
    if (!Number.isFinite(submittedAt) || Date.now() - submittedAt > PROVIDER_HORIZON_MS) {
      await keepUnconfirmed(ledger, task, 'it is older than the seven days the provider\'s task list covers — look for it in the provider console')
      continue
    }

    // A task in the list carries no prompt, only a model and a time. If another
    // unresolved row for the same model overlaps this one in time, a match could
    // belong to either; adopting it here could leave the other row reported as
    // "never created" — and re-submitted — while its task is billing.
    const window = windowOf(task, settings.requestTimeoutMs)
    const rivals = pending.filter(other => other.localId !== task.localId
      && other.provider === task.provider
      && other.model === task.model
      && overlaps(window, windowOf(other, settings.requestTimeoutMs)))
    if (rivals.length > 0) {
      await keepUnconfirmed(ledger, task, `other unconfirmed submissions for this model (${rivals.map(other => other.localId).join(', ')}) overlap it in time, so the provider's task list cannot tell them apart — look for them in the provider console`)
      continue
    }

    let apiKey: string | null
    try {
      apiKey = (await resolveApiKey(runtime.ctx, provider)).value
    } catch (error: unknown) {
      await keepUnconfirmed(ledger, task, `the credential for its provider is not available (${messageOf(error)}), so the task list could not be read`)
      continue
    }

    const context: AdapterContext = { baseUrl: provider.baseUrl, apiKey, fetch, signal: AbortSignal.timeout(20_000) }
    let candidates
    try {
      candidates = await adapter.listCreated(context, { ...window, model: model.id })
    } catch (error: unknown) {
      await keepUnconfirmed(ledger, task, `the provider's task list could not be read (${error instanceof Error ? error.message : String(error)})`)
      continue
    }

    // A provider task another row already owns is not this one.
    const claimed = new Set(ledger.list().map(entry => entry.providerTaskId).filter(id => id !== null))
    const unclaimed = candidates.filter(candidate => !claimed.has(candidate.providerTaskId))
    const [match] = unclaimed
    if (unclaimed.length === 1 && match !== undefined) {
      await ledger.update(task.localId, current => (stillUnresolved(current)
        ? {
            ...current,
            providerTaskId: match.providerTaskId,
            status: 'queued',
            error: null,
            updatedAt: new Date().toISOString(),
          }
        : current))
      logger.info(`video-forge: recovered ${task.localId} as provider task ${match.providerTaskId} from the task list`)
      continue
    }
    await keepUnconfirmed(ledger, task, unclaimed.length === 0
      ? 'the provider\'s task list shows no unclaimed task for this model around the submission time, so it was most likely never created'
      : `the provider's task list shows ${unclaimed.length} unclaimed tasks for this model around the submission time (${unclaimed.map(entry => entry.providerTaskId).join(', ')}) and cannot tell which one is this`)
  }
}

/**
 * Reattach to tasks nobody is watching: open rows a previous process left, and
 * orphans worth another question.
 *
 * For each of them, ask the provider what actually happened. A finished task is
 * settled (and its artifact fetched, if the URL is still alive); a still-running
 * task gets a fresh watch; a provider we cannot ask leaves the task `orphaned` —
 * never "probably still running", and never a re-submission, because that would
 * be a second charge for one intent.
 */
async function reattach(runtime: VideoForgeRuntime, tasks: readonly VideoTask[]): Promise<void> {
  const { ledger, logger } = runtime
  if (tasks.length === 0) return
  const settings = runtime.settings()

  for (const task of tasks) {
    let provider: ProviderSetting
    let model: ModelSetting
    try {
      const target = resolveTarget(settings, task.provider, task.model)
      provider = target.provider
      model = target.model
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `no longer configured: ${messageOf(error)}`)
      continue
    }

    const adapter = adapterFor(provider, model)
    let apiKey: string | null
    try {
      apiKey = (await resolveApiKey(runtime.ctx, provider)).value
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `the credential for its provider is not available (${messageOf(error)})`)
      continue
    }

    const context: AdapterContext = { baseUrl: provider.baseUrl, apiKey, fetch, signal: AbortSignal.timeout(20_000) }
    try {
      const state = await adapter.query(context, task.providerTaskId ?? '')
      if (!state.terminal) {
        // Still alive: reattach a watch instead of pretending, and never
        // re-submit. There is no agent at boot, so this runs unowned — a job here
        // would be rejected by the registry, and that is a limitation of the watch
        // surface, not a reason to call a healthy task orphaned.
        let claimed = false
        await ledger.update(task.localId, (current) => {
          if (!reattachable(current)) return current
          claimed = true
          return {
            ...current,
            status: state.status === 'queued' ? 'queued' : 'running',
            error: null,
            updatedAt: new Date().toISOString(),
          }
        })
        const fresh = ledger.byId(task.localId)
        if (claimed && fresh !== undefined) {
          startInProcessWatch({
            ledger,
            adapter,
            context: { ...context, signal: undefined },
            task: fresh,
            pollIntervalMs: model.pollIntervalMs,
            outputDirectory: runtime.outputDirectory(fresh.localId),
            logger,
          })
        }
        logger.info(`video-forge: ${task.localId} is still running at the provider; watching it in the background`)
        continue
      }
      if (state.status === 'succeeded' && state.videoUrl !== null) {
        const artifact = await fetchArtifact(runtime, task, state.videoUrl, apiKey, context)
        await ledger.update(task.localId, current => (reattachable(current)
          ? {
              ...current,
              status: 'succeeded',
              progress: 1,
              artifacts: artifact === null ? current.artifacts : [artifact],
              error: artifact === null ? { message: 'generation succeeded but the artifact could not be retrieved after restart', code: null } : null,
              billing: settledBilling(state.usage),
              updatedAt: new Date().toISOString(),
            }
          : current))
        logger.info(`video-forge: ${task.localId} had already finished; recorded its artifact`)
        continue
      }
      await ledger.update(task.localId, current => (reattachable(current)
        ? {
            ...current,
            status: state.status === 'cancelled' ? 'cancelled' : 'failed',
            error: state.error ?? { message: `the provider reported status "${state.status}" while reconciling`, code: null },
            billing: settledBilling(state.usage),
            updatedAt: new Date().toISOString(),
          }
        : current))
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `the provider could not be reached (${messageOf(error)})`)
    }
  }
}

/** Re-checked inside every write: only a row nobody is watching may be reattached or settled here. */
function reattachable(task: VideoTask): boolean {
  return isOpen(task) || task.status === 'orphaned'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchArtifact(
  runtime: VideoForgeRuntime,
  task: VideoTask,
  url: string,
  apiKey: string | null,
  context: AdapterContext,
): Promise<VideoTask['artifacts'][number] | null> {
  try {
    return await downloadArtifact({
      url,
      apiKey,
      directory: runtime.outputDirectory(task.localId),
      localId: task.localId,
      fetch: context.fetch,
      signal: undefined,
      mimeHint: 'video/mp4',
    })
  } catch (error: unknown) {
    runtime.logger.warn(`video-forge: could not download ${task.localId}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Mark a task orphaned, saying why and whether it will be asked about again.
 * An unchanged verdict is not rewritten, so a timer re-check of a task that is
 * still unreachable does not touch the ledger file.
 */
async function markOrphaned(ledger: Ledger, task: VideoTask, reason: string): Promise<void> {
  const submittedAt = Date.parse(task.submittedAt)
  const retried = task.providerTaskId !== null && Number.isFinite(submittedAt) && Date.now() - submittedAt <= PROVIDER_HORIZON_MS
  const message = retried
    ? `${reason}; asked again automatically every ${ORPHAN_RETRY_MS / 60_000} minutes until ${new Date(submittedAt + PROVIDER_HORIZON_MS).toISOString()} — never re-submitted`
    : `${reason}; never re-submitted`
  await ledger.update(task.localId, (current) => {
    if (!reattachable(current)) return current
    if (current.status === 'orphaned' && current.error?.message === message) return current
    return {
      ...current,
      status: 'orphaned',
      error: { message, code: null },
      updatedAt: new Date().toISOString(),
    }
  })
}

/** Record why a row stays unconfirmed — unless something settled it meanwhile. */
async function keepUnconfirmed(ledger: Ledger, task: VideoTask, detail: string): Promise<VideoTask> {
  return ledger.update(task.localId, current => (stillUnresolved(current)
    ? {
        ...current,
        status: 'unconfirmed',
        error: { message: unconfirmedMessage(detail), code: UNCONFIRMED_CODE },
        updatedAt: new Date().toISOString(),
      }
    : current))
}

/** Re-checked inside every write: reconciliation only ever touches a row nobody else has settled. */
function stillUnresolved(task: VideoTask): boolean {
  return (task.status === 'submitting' || task.status === 'unconfirmed')
    && task.providerTaskId === null
    && !isSending(task.localId)
}

/** When the provider could have created the task, given the timeout the request ran under. */
function windowOf(task: VideoTask, requestTimeoutMs: number): { from: number; to: number } {
  const submittedAt = Date.parse(task.submittedAt)
  return { from: submittedAt - CLOCK_SKEW_MS, to: submittedAt + requestTimeoutMs + CLOCK_SKEW_MS }
}

function overlaps(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return a.from <= b.to && b.from <= a.to
}
