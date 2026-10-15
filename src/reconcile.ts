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
 */

import { resolveApiKey } from './credentials.ts'
import { downloadArtifact } from './download.ts'
import type { Ledger } from './ledger.ts'
import { isSending, unconfirmedMessage } from './operations.ts'
import { adapterFor, type AdapterContext } from './providers/index.ts'
import type { VideoForgeRuntime } from './runtime.ts'
import { resolveTarget, type ModelSetting, type ProviderSetting } from './settings.ts'
import { UNCONFIRMED_CODE, type VideoTask } from './types.ts'
import { startInProcessWatch } from './watch.ts'

/** Clock skew tolerated between our submission time and the provider's `created_at`. */
const CLOCK_SKEW_MS = 2 * 60_000

/** How far back ARK's task list reaches. */
const LIST_HORIZON_MS = 7 * 24 * 60 * 60_000

/**
 * Settle everything the previous process left unresolved or open.
 *
 * The tools are live while this runs, so the rows to settle are fixed up front:
 * a row this process is sending, or creates later, already has a watch (or a
 * submission) of its own and must not get a second one.
 */
export async function reconcile(runtime: VideoForgeRuntime): Promise<void> {
  const inherited = new Set(runtime.ledger.list().filter(task => !isSending(task.localId)).map(task => task.localId))
  await recoverUnresolved(runtime, inherited)
  await reattachOpen(runtime, inherited)
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
    if (!Number.isFinite(submittedAt) || Date.now() - submittedAt > LIST_HORIZON_MS) {
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
    } catch {
      await keepUnconfirmed(ledger, task, 'the credential for its provider is not available, so the task list could not be read')
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
 * Reattach to tasks the ledger still calls open.
 *
 * For each of them, ask the provider what actually
 * happened. A finished task is settled (and its artifact fetched, if the URL is
 * still alive); a still-running task gets a fresh watch; a provider we cannot
 * reach at all leaves the task `orphaned` — never "probably still running", and
 * never a re-submission, because that would be a second charge for one intent.
 */
async function reattachOpen(runtime: VideoForgeRuntime, inherited: ReadonlySet<string>): Promise<void> {
  const { ledger, logger } = runtime
  const open = ledger.open().filter(task => inherited.has(task.localId))
  if (open.length === 0) return

  const settings = runtime.settings()
  logger.info(`video-forge: reconciling ${open.length} task(s) left by a previous process`)

  for (const task of open) {
    let provider: ProviderSetting
    let model: ModelSetting
    try {
      const target = resolveTarget(settings, task.provider, task.model)
      provider = target.provider
      model = target.model
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `no longer configured: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const adapter = adapterFor(provider, model)
    let apiKey: string | null
    try {
      apiKey = (await resolveApiKey(runtime.ctx, provider)).value
    } catch {
      await markOrphaned(ledger, task, 'the credential for its provider is not available')
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
        await ledger.update(task.localId, current => ({
          ...current,
          status: state.status === 'queued' ? 'queued' : 'running',
          error: null,
          updatedAt: new Date().toISOString(),
        }))
        const fresh = ledger.byId(task.localId)
        if (fresh !== undefined) {
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
        await ledger.update(task.localId, current => ({
          ...current,
          status: 'succeeded',
          progress: 1,
          artifacts: artifact === null ? current.artifacts : [artifact],
          error: artifact === null ? { message: 'generation succeeded but the artifact could not be retrieved after restart', code: null } : null,
          updatedAt: new Date().toISOString(),
        }))
        logger.info(`video-forge: ${task.localId} had already finished; recorded its artifact`)
        continue
      }
      await ledger.update(task.localId, current => ({
        ...current,
        status: state.status === 'cancelled' ? 'cancelled' : 'failed',
        error: state.error ?? { message: `the provider reported status "${state.status}" while reconciling`, code: null },
        updatedAt: new Date().toISOString(),
      }))
    } catch (error: unknown) {
      await markOrphaned(ledger, task, `the provider could not be reached (${error instanceof Error ? error.message : String(error)})`)
    }
  }
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

async function markOrphaned(ledger: Ledger, task: VideoTask, reason: string): Promise<void> {
  await ledger.update(task.localId, current => ({
    ...current,
    status: 'orphaned',
    error: { message: reason, code: null },
    updatedAt: new Date().toISOString(),
  }))
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
