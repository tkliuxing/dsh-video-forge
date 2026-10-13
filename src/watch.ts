/**
 * The watch: poll one provider task until it settles, then download the artifact.
 *
 * Two design points from DESIGN §6 are load-bearing here:
 *
 * - **The watch owns its cancellation.** Once a job id has been published, a
 *   later `exec.signal` abort only stops that *call* from waiting; the work must
 *   not die with it. The loop therefore reads a task-owned `AbortController`, and
 *   `cancel()` aborts that. `job_kill` stops watching (the provider keeps
 *   working), while `video_cancel` asks the provider to stop — different acts,
 *   reported separately.
 * - **The ledger is the truth, not the job.** Jobs die with the process; the
 *   ledger does not. Every state change is written to disk before it is
 *   announced, so a restart reconciles instead of guessing.
 *
 * The loop is driven by two different hosts, which is why it is separate from
 * either:
 *
 * - {@link startWatch} wraps it in a `ctx.jobs` job so the model can read progress
 *   with `job_output` and be woken on completion. The registry only starts a job
 *   when a controller is reachable from the *owner's* scope, so this mode needs a
 *   live agent — it is what the tools use.
 * - {@link startInProcessWatch} drives the same loop from a timer. Boot-time
 *   reconciliation has no agent and therefore no job it could legally start, and a
 *   restarted task still needs settling — so it runs unowned, reporting through
 *   the log and the ledger, which is what `video_status` reads.
 */

import type { JobHandle, JobHooks, JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-jobs'
import { downloadArtifact } from './download.ts'
import type { Ledger } from './ledger.ts'
import type { AdapterContext, ProtocolAdapter } from './providers/index.ts'
import type { VideoTask } from './types.ts'

declare module '@deepseek-ai/dsh-jobs' {
  /**
   * The job kind this plugin owns. `JobKindMap` is merge-extensible, so a new
   * producer declares its own kind by augmentation and the registry treats it as
   * an ordinary id namespace (`<kind>-N`).
   */
  interface JobKindMap {
    video: 'video'
  }
}

/** Minimal logger surface; the plugin passes `ctx.logger`. */
export interface WatchLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Where a running watch reports its progress. */
export interface WatchReporter {
  /** Append one output line. `stderr` marks a failure the model should read. */
  line(text: string, channel?: 'stdout' | 'stderr'): void
  /** Replace the single live progress line. */
  progress(line: string): void
}

/** Everything the poll loop needs, independent of what drives it. */
export interface WatchCore {
  ledger: Ledger
  adapter: ProtocolAdapter
  context: AdapterContext
  task: VideoTask
  pollIntervalMs: number
  /** Directory this task's artifacts are written into. */
  outputDirectory: string
  logger: WatchLogger
  /** Called after every ledger write, so a caller can refresh its view. */
  onUpdate?: ((task: VideoTask) => void) | undefined
  /** Task-owned cancellation. */
  signal: AbortSignal
}

export interface WatchOptions extends Omit<WatchCore, 'signal'> {
  jobs: JobRegistry
  /** Live agent session id; the registry requires a controller reachable from it. */
  owner: string | undefined
  /** Registers the derived cancel signal; returns a detach function. */
  onCancelReady?: ((localId: string, cancel: () => Promise<boolean>) => () => void) | undefined
}

/** Consecutive transport failures tolerated before the watch gives up. */
const MAX_CONSECUTIVE_FAILURES = 5

/** How often a progress line is appended, as a fraction of the whole. */
const PROGRESS_STEP = 0.05

/** The registry's own owner type, so the optional field is passed exactly. */
type JobOwner = NonNullable<Parameters<JobRegistry['start']>[0]['owner']>

/**
 * Start a job-backed watch. Returns null when the registry refuses to start one
 * (no controller reachable from the owner, or no jobs service at all) — the caller
 * then falls back to {@link startInProcessWatch}, because a paid task must never be
 * left unwatched just because the job surface is unavailable.
 */
export function startWatch(options: WatchOptions): JobId | null {
  const controller = new AbortController()
  const { jobs, owner, adapter, context, task } = options
  const ownership: { owner: JobOwner } | Record<string, never> = owner === undefined ? {} : { owner: owner as JobOwner }

  let jobId: JobId
  try {
    jobId = jobs.start({
      kind: 'video',
      label: `${task.provider}/${task.model} ${task.localId}`,
      ...ownership,
      run: (job: JobHandle): JobHooks => {
        const settle = runCore({ ...options, signal: controller.signal }, {
          line: (text, channel) => job.append(text, channel === undefined ? {} : { channel }),
          progress: line => job.updateProgress(line),
        })
        const detach = options.onCancelReady?.(task.localId, async () => {
          if (controller.signal.aborted) return false
          try {
            const cancelled = await adapter.cancel(context, task.providerTaskId ?? '')
            if (cancelled) controller.abort()
            return cancelled
          } catch (error: unknown) {
            options.logger.warn(`video-forge: provider cancel failed for ${task.localId}: ${String(error)}`)
            return false
          }
        })

        return {
          cancel: (reason?: string) => {
            job.append(`stopped watching ${task.localId}${reason === undefined ? '' : ` (${reason})`}\n`, { channel: 'log' })
            // Stopping the watch is NOT cancelling the provider's work; the ledger
            // keeps the task's real status so a later poll can still find it.
            controller.abort()
          },
          done: settle.finally(() => { detach?.() }),
        }
      },
    })
  } catch (error: unknown) {
    options.logger.warn(`video-forge: no background job for ${task.localId} (${error instanceof Error ? error.message : String(error)}); watching it in-process instead`)
    return null
  }
  return jobId
}

/**
 * Drive the same loop from a timer instead of a job.
 *
 * Used where no agent exists to own a job — boot-time reconciliation. The returned
 * handle stops the loop, and `done` settles once the loop has actually stopped.
 */
export function startInProcessWatch(options: Omit<WatchOptions, 'jobs' | 'owner' | 'onCancelReady'>): { cancel(): void; done: Promise<JobOutcome> } {
  const controller = new AbortController()
  const done = runCore({ ...options, signal: controller.signal }, {
    line: (text, channel) => {
      if (channel === 'stderr') options.logger.warn(`video-forge: ${text.trim()}`)
      else options.logger.info(`video-forge: ${text.trim()}`)
    },
    // Every line already reaches the log; a live progress line has no reader here.
    progress: line => options.logger.info(`video-forge: ${options.task.localId} ${line}`),
  })
  return { cancel: () => controller.abort(), done }
}

/** The loop itself. It settles the ledger before it reports anything. */
async function runCore(core: WatchCore, reporter: WatchReporter): Promise<JobOutcome> {
  const { ledger, adapter, context, task, signal } = core
  let failures = 0
  let lastLine = ''
  let lastProgress = -1

  reporter.line(`watching ${task.provider}/${task.model} task ${task.providerTaskId ?? '(no id)'} as ${task.localId}\n`)

  for (;;) {
    if (signal.aborted) {
      const current = ledger.byId(task.localId)
      return {
        status: 'killed',
        detail: `stopped watching ${task.localId}`,
        result: current === undefined ? '' : describe(current),
      }
    }

    let state
    try {
      state = await adapter.query({ ...context, signal }, task.providerTaskId ?? '')
      failures = 0
    } catch (error: unknown) {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      reporter.line(`poll failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${message}\n`, 'stderr')
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        const updated = await ledger.update(task.localId, current => ({
          ...current,
          status: 'failed',
          error: { message: `polling failed ${failures} times: ${message}`, code: null },
          updatedAt: new Date().toISOString(),
        }))
        core.onUpdate?.(updated)
        reporter.line(`giving up on ${task.localId}\n`, 'stderr')
        return { status: 'failed', detail: message, result: describe(updated) }
      }
      await sleep(backoff(core.pollIntervalMs, failures), signal)
      continue
    }

    const line = `${state.status}${state.progress === null ? '' : ` ${Math.round(state.progress * 100)}%`}`
    if (line !== lastLine || (state.progress !== null && Math.abs(state.progress - lastProgress) >= PROGRESS_STEP)) {
      lastLine = line
      lastProgress = state.progress ?? -1
      reporter.line(`${new Date().toISOString()} ${line}\n`)
      reporter.progress(line)
      const updated = await ledger.update(task.localId, current => ({
        ...current,
        status: statusOf(state.status, current.status),
        progress: state.progress ?? current.progress,
        updatedAt: new Date().toISOString(),
      }))
      core.onUpdate?.(updated)
    }

    if (!state.terminal) {
      await sleep(core.pollIntervalMs, signal)
      continue
    }

    if (state.status === 'succeeded') {
      if (state.videoUrl === null) {
        const updated = await ledger.update(task.localId, current => ({
          ...current,
          status: 'failed',
          error: { message: 'the provider reported success without an artifact URL', code: null },
          updatedAt: new Date().toISOString(),
        }))
        core.onUpdate?.(updated)
        return { status: 'failed', detail: 'no artifact URL', result: describe(updated) }
      }
      try {
        const artifact = await downloadArtifact({
          url: state.videoUrl,
          apiKey: context.apiKey,
          directory: core.outputDirectory,
          localId: task.localId,
          fetch: context.fetch,
          signal,
          mimeHint: 'video/mp4',
        })
        const updated = await ledger.update(task.localId, current => ({
          ...current,
          status: 'succeeded',
          progress: 1,
          artifacts: [...current.artifacts.filter(entry => entry.path !== artifact.path), artifact],
          error: null,
          updatedAt: new Date().toISOString(),
        }))
        core.onUpdate?.(updated)
        reporter.line(`downloaded ${(artifact.bytes / 1024 / 1024).toFixed(1)} MiB to ${artifact.path}\n`)
        return { status: 'completed', result: describe(updated) }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const updated = await ledger.update(task.localId, current => ({
          ...current,
          status: 'failed',
          // The generation itself succeeded; only the download failed. Saying so
          // keeps the model from re-submitting a paid task.
          error: { message: `generation succeeded but the artifact download failed: ${message}`, code: null },
          updatedAt: new Date().toISOString(),
        }))
        core.onUpdate?.(updated)
        reporter.line(`download failed: ${message}\n`, 'stderr')
        return { status: 'failed', detail: message, result: describe(updated) }
      }
    }

    const finalStatus = state.status === 'cancelled' ? 'cancelled' : 'failed'
    const updated = await ledger.update(task.localId, current => ({
      ...current,
      status: finalStatus,
      error: state.error ?? { message: `the provider reported status "${state.status}"`, code: null },
      updatedAt: new Date().toISOString(),
    }))
    core.onUpdate?.(updated)
    reporter.line(`${finalStatus}: ${state.error?.message ?? 'no detail provided'}\n`, 'stderr')
    return { status: 'failed', detail: state.error?.message ?? finalStatus, result: describe(updated) }
  }
}

/** Map a provider status onto a ledger status without ever inventing progress. */
function statusOf(provider: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown', current: VideoTask['status']): VideoTask['status'] {
  switch (provider) {
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'succeeded': return 'succeeded'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    // An unrecognized word must not be rounded up to "running": a task whose body
    // we cannot read is exactly the one worth surfacing as unresolved.
    default: return current
  }
}

/** One line a model can read at a glance. */
export function describe(task: VideoTask): string {
  const artifact = task.artifacts[0]
  const parts = [`${task.localId} ${task.status}`, `${task.provider}/${task.model}`]
  if (task.progress !== null) parts.push(`${Math.round(task.progress * 100)}%`)
  if (artifact !== undefined) parts.push(`${artifact.path} (${(artifact.bytes / 1024 / 1024).toFixed(1)} MiB)`)
  if (task.error !== null) parts.push(task.error.message)
  return `${parts.join(' · ')}\n`
}

function backoff(base: number, attempt: number): number {
  return Math.min(base * 2 ** (attempt - 1), 60_000)
}

/** Sleep that resolves early when the task-owned signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
