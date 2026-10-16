/**
 * Telling a conversation that a task it started has finished, after a restart
 * (DESIGN §17.2, §17.3 M3.5).
 *
 * A task the model submitted is watched by a job, and `tool-jobs` wakes the
 * session when that job settles. A task taken over by boot reconciliation or
 * by the orphan retry has no job — there was no agent to own one — so without
 * this module its completion would only be visible to someone who thought to
 * ask `video_status`. Now that the conversation is the only surface, that is a
 * finished, paid video nobody hears about.
 *
 * Which tasks: those the takeover path settled (`takenOverAt`), finished
 * (succeeded, failed, cancelled), submitted from a session, not yet notified
 * (`notifiedAt`), and not deliberately let go: a killed watch (the model's
 * `job_kill`, a stop from the UI, an archived session) or an accepted cancel
 * marks the task `quiet` (see {@link quietOnKill}).
 *
 * How: the `dsh-schedule` pattern. Outside any initiator,
 * `sessionController.resolveAgent` returns the session's agent (resuming it if
 * it is not loaded); an idle agent is woken with `followup`, a busy one gets the
 * notice in its inbox with `inject`; then the session is flushed. `notifiedAt`
 * is written only after the flush succeeded: delivery is at least once (a crash
 * between the two repeats the notice) rather than possibly never. A session
 * that cannot take it is retried on the orphan timer, and given up after a few
 * passes with the reason recorded.
 */

import { randomUUID } from 'node:crypto'
import type { Ledger } from './ledger.ts'
import type { VideoForgeRuntime } from './runtime.ts'
import type { VideoTask } from './types.ts'
import { describeLocation } from './destination.ts'
import type { WatchLogger } from './watch.ts'

/** The message source this plugin declares for its notices (`MessageSourceMap` is merge-extensible). */
export const NOTICE_SOURCE_KIND = 'video-forge'

/** Delivery attempts (one per retry pass) before a notice is given up. */
export const MAX_NOTICE_ATTEMPTS = 3

/** DSH bounds a notice's one-line summary (`CONTEXT_SUMMARY_MAX_CHARS`). */
const SUMMARY_MAX_CHARS = 120

const FINISHED = new Set<VideoTask['status']>(['succeeded', 'failed', 'cancelled'])

/** The slices of the DSH services used here. */
interface AgentLike {
  readonly status?: string
  readonly session: unknown
  followup(message: unknown): void
  inject(message: unknown): void
}
interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<{ agent: AgentLike } | { error: { message?: string } }>
}
interface AgentsLike {
  withoutInitiator<T>(operation: () => T): T
}
interface SessionsLike {
  flush(session: unknown): Promise<boolean>
}

/** The three host services a notice travels through. */
export interface NoticeHost {
  sessionController: SessionControllerLike
  agents: AgentsLike
  sessions: SessionsLike
}

/**
 * Where the plugin keeps the services once the host has them up. The session
 * controller comes up after boot reconciliation may already have run, so it is
 * awaited through `ctx.inject` (see `index.ts`), not read once with `ctx.get`.
 */
const HOSTS = new WeakMap<object, NoticeHost>()

/** Make (or, with undefined, withdraw) the notice services for a runtime. */
export function setNoticeHost(runtime: VideoForgeRuntime, host: NoticeHost | undefined): void {
  if (host === undefined) HOSTS.delete(runtime)
  else HOSTS.set(runtime, host)
}

/** The services, from `setNoticeHost` or — for a composition that injects them directly — `ctx.get`. */
function noticeHostOf(runtime: VideoForgeRuntime): NoticeHost | undefined {
  const registered = HOSTS.get(runtime)
  if (registered !== undefined) return registered
  const sessionController = runtime.ctx.get('sessionController' as never) as SessionControllerLike | undefined
  const agents = runtime.ctx.get('agents' as never) as AgentsLike | undefined
  const sessions = runtime.ctx.get('sessions' as never) as SessionsLike | undefined
  return sessionController === undefined || agents === undefined || sessions === undefined ? undefined : { sessionController, agents, sessions }
}

/** Whether a task is owed a notice now. */
export function owesNotice(task: VideoTask): boolean {
  return task.takenOverAt !== undefined
    && FINISHED.has(task.status)
    && task.session !== undefined
    && task.notifiedAt === undefined
    && task.noticeAbandoned === undefined
    && task.quiet !== true
}

/** Notices being delivered right now, so overlapping passes do not send one twice. */
const delivering = new Set<string>()

/** Deliver every notice owed. Never throws; failures are logged and retried later. */
export async function deliverNotices(runtime: VideoForgeRuntime): Promise<void> {
  const host = noticeHostOf(runtime)
  // Not up yet (or not in this composition): the notices wait; that is no
  // failed attempt, and the services' arrival delivers them.
  if (host === undefined) return
  for (const listed of runtime.ledger.list().filter(owesNotice)) {
    if (delivering.has(listed.localId)) continue
    delivering.add(listed.localId)
    try {
      // The list was taken before earlier deliveries in this pass awaited; an
      // overlapping pass may have settled this row since. Decide on the row now.
      const task = runtime.ledger.byId(listed.localId)
      if (task === undefined || !owesNotice(task) || attemptedRecently(task)) continue
      await deliverOne(runtime, host, task)
    } catch (error: unknown) {
      runtime.logger.warn(`video-forge: notice for ${listed.localId} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      delivering.delete(listed.localId)
    }
  }
}

/**
 * Attempts are paced, not counted per call: boot runs several passes within
 * seconds (the boot pass, the services' arrival, each reattached watch ending),
 * and a passing failure then must not use up every attempt at once.
 */
export const NOTICE_RETRY_MS = 4 * 60_000

function attemptedRecently(task: VideoTask): boolean {
  if (task.noticeLastAttemptAt === undefined) return false
  const since = Date.now() - Date.parse(task.noticeLastAttemptAt)
  // A time in the future (the clock was set back) is stale, not "just now".
  return since >= 0 && since < NOTICE_RETRY_MS
}

/** Bounds one host call, so a session that never answers cannot hold the plugin's passes. */
export const NOTICE_CALL_TIMEOUT_MS = 60_000

function bounded<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${what} did not answer within ${NOTICE_CALL_TIMEOUT_MS / 1000} s`)) }, NOTICE_CALL_TIMEOUT_MS)
    timer.unref?.()
  })
  return Promise.race([work, deadline]).finally(() => { clearTimeout(timer) })
}

async function deliverOne(runtime: VideoForgeRuntime, host: NoticeHost, task: VideoTask): Promise<void> {
  const { ledger, logger } = runtime
  const sessionId = task.session?.id
  if (sessionId === undefined) return
  const { sessionController: controller, agents, sessions } = host

  const failure = await Promise.resolve().then(async () => agents.withoutInitiator(async (): Promise<string | null> => {
      const resolved = await bounded(controller.resolveAgent(sessionId), 'resuming the session')
      if ('error' in resolved) return resolved.error.message ?? 'the session could not be resumed'
      const current = ledger.byId(task.localId) ?? task
      const message = noticeMessage(current)
      // Idle: wake it, or the notice waits for a turn that may never come.
      // Busy: its next step reads the inbox anyway.
      if (resolved.agent.status === 'idle') resolved.agent.followup(message)
      else resolved.agent.inject(message)
      const flushed = await bounded(sessions.flush(resolved.agent.session), 'saving the session log')
      return flushed ? null : 'the session log did not acknowledge the notice'
    })).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

  if (failure === null) {
    await ledger.update(task.localId, (current) => {
      const { noticeError: _cleared, ...rest } = current
      return { ...rest, notifiedAt: new Date().toISOString() }
    })
    logger.info(`video-forge: told session ${sessionId} that ${task.localId} is ${task.status}`)
    return
  }
  let attempts = 0
  await ledger.update(task.localId, (current) => {
    attempts = (current.noticeAttempts ?? 0) + 1
    return {
      ...current,
      noticeAttempts: attempts,
      noticeError: failure,
      noticeLastAttemptAt: new Date().toISOString(),
      ...(attempts >= MAX_NOTICE_ATTEMPTS ? { noticeAbandoned: failure } : {}),
    }
  })
  logger.warn(`video-forge: could not tell session ${sessionId} about ${task.localId} (${failure})${attempts >= MAX_NOTICE_ATTEMPTS ? '; giving up' : '; will try again'}`)
}

/** The notice as a user-role message from this plugin, the shape `createUserMessage` builds. */
export function noticeMessage(task: VideoTask): Record<string, unknown> {
  const artifact = task.artifacts[0]
  const facts = [`${task.localId} ${task.status}`, `${task.provider}/${task.model}`]
  if (artifact !== undefined) facts.push(describeLocation(artifact))
  // Provider text is data, not this message's own words: quoted and bounded.
  const providerSaid = task.error === null ? null : `provider said: ${JSON.stringify(task.error.message.replace(/\s+/g, ' ').slice(0, 300))}`
  const text = [
    `[video-forge] A video task this conversation started was settled by the plugin after it lost track of it (a restart or lost contact), so no background job reported it:`,
    facts.join(' · '),
    ...(providerSaid === null ? [] : [providerSaid]),
    task.status === 'succeeded'
      ? 'The video is ready; tell the user where it is if they are waiting for it. Do not submit it again.'
      : 'Check video_status with this task id before doing anything else; do not submit the same request again without the user.',
  ].join('\n')
  const summary = `video ${task.localId} ${task.status}`
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary: summary.length <= SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` },
  })
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

/**
 * A job-event listener that marks a task `quiet` when the job watching it was
 * killed (settle cause `kill`) — the model's `job_kill`, the user stopping it
 * from the UI, or its session being archived — and forgets the job otherwise.
 * Wider than `tool-jobs`, which stays silent only for the model's own kill: any
 * of these is a choice to stop following the task, and archiving especially
 * must not be answered by resuming the session later. A teardown (restart) is
 * not a kill. `jobTasks` maps the plugin's live watch jobs to their tasks.
 */
export function quietOnKill(
  ledger: Ledger,
  jobTasks: Map<string, string>,
  logger: WatchLogger,
): (event: { readonly type: string; readonly cause?: string; readonly job?: { readonly id: string } }) => void {
  return (event) => {
    if (event.type !== 'settled' || event.job === undefined) return
    const localId = jobTasks.get(event.job.id)
    if (localId === undefined) return
    jobTasks.delete(event.job.id)
    if (event.cause !== 'kill') return
    // Whatever the row became meanwhile — an aborted download leaves it orphaned,
    // and the retry would later finish it — it was let go; only a notice already
    // sent makes the mark moot.
    void ledger.update(localId, current => (current.notifiedAt === undefined && current.quiet !== true ? { ...current, quiet: true } : current))
      .catch((error: unknown) => { logger.warn(`video-forge: could not record that ${localId}'s watch was stopped: ${error instanceof Error ? error.message : String(error)}`) })
  }
}
