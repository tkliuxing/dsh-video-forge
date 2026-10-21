/**
 * The operations behind the model tools and the panel API.
 *
 * Validate, de-duplicate, submit, watch and cancel live here once — two copies
 * of a paid side effect drift, and the one that drifts is always the quieter
 * one — and `tools.ts` / `panel-api.ts` are thin adapters over them. Only the
 * tools submit (DESIGN §16.4); the panel API reads and cancels.
 *
 * Everything is expressed against {@link VideoForgeRuntime}, so an operation never
 * needs to know whether a model or a browser asked for it.
 */

import { createHash } from 'node:crypto'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { maskSecret, resolveApiKey } from './credentials.ts'
import { describeMaterial, resolveMaterial } from './materials.ts'
import { moderationOf, ProviderRequestError } from './providers/adapter.ts'
import { adapterFor, cancelSupported, returnsLastFrame, type AdapterContext } from './providers/index.ts'
import { estimateArkTokens, estimateCost, unitPrice, type PriceUnit } from './prices.ts'
import { artifactUrl, type VideoForgeRuntime } from './runtime.ts'
import { assertGeometry, ConfigError, resolveTarget, supportsMode, type ModelSetting, type ProviderSetting } from './settings.ts'
import {
  NOT_SUBMITTED_CODE,
  UNCONFIRMED_CODE,
  type GenerationRequest,
  type ResolvedMaterial,
  type VideoArtifact,
  type ModerationStage,
  type TaskBilling,
  type VideoMode,
  type VideoTask,
} from './types.ts'
import { describe } from './watch.ts'
import { compose } from './compose.ts'
import { describeLocation, planDestination, workspaceRefusal } from './destination.ts'
import { LedgerCorruptError } from './ledger.ts'
import { DEFAULT_SHOT, isShotName, MANIFEST_FILE, ManifestError, readProject, type ProjectState } from './project.ts'
import type { SessionSelection } from './selection.ts'
import type { TaskSession } from './session-context.ts'
import { workspaceFsOf } from './workspace-fs.ts'

/** Statuses that mean the provider may still be working on the task. */
const OPEN = new Set<VideoTask['status']>(['queued', 'running'])

/**
 * Statuses that hold a concurrency slot: the open ones plus a create request
 * still in flight. `unconfirmed` does not — on a protocol with no task list it
 * can never be resolved, and must not wedge the limit forever.
 */
const IN_FLIGHT = new Set<VideoTask['status']>(['submitting', 'queued', 'running'])

/** What one generation is asked for, before validation. */
export interface GenerateInput {
  prompt: string
  provider?: string | undefined
  model?: string | undefined
  mode?: VideoMode | undefined
  firstFrame?: string | undefined
  lastFrame?: string | undefined
  referenceImages?: string[] | undefined
  durationSeconds?: number | null | undefined
  resolution?: string | undefined
  aspectRatio?: string | undefined
  /** Shot (directory under `renders/`) the artifact belongs to; defaults to the continued take's, else `untitled`. */
  shot?: string | undefined
  /** Continue an earlier take (task id or video path): its last frame becomes the first frame. */
  from?: string | undefined
  /** Characters registered in `video-project.yaml` to keep consistent. */
  characters?: string[] | undefined
}

export interface GenerateOutcome {
  task: VideoTask
  /** Present when a job is watching it; null when it is watched in-process. */
  jobId: JobId | null
  artifact: VideoArtifact | null
  kind: 'job' | 'done'
  /** One line a caller can render or hand to a model. */
  message: string
}

export interface OperationOptions {
  /** Calling session id, when there is one. */
  owner?: string | undefined
  /** The calling session's id, workspace and permission mode; recorded with the task. */
  session?: TaskSession | null
  signal?: AbortSignal | undefined
  /** Bounded wait for a finished artifact; 0 returns as soon as it is submitted. */
  waitSeconds?: number
}

/** Validate, de-duplicate, submit and start watching. */
export async function generate(
  runtime: VideoForgeRuntime,
  input: GenerateInput,
  options: OperationOptions = {},
): Promise<GenerateOutcome> {
  const settings = runtime.settings()
  if (!settings.enabled) {
    throw new ConfigError('video-forge is disabled in its settings; enable it before generating')
  }
  // Duplicate checks, `from` and the task id all read the ledger, so it must
  // have been read from disk — retried here if the boot read failed.
  await requireLedger(runtime)

  const session = options.session ?? null
  const requestedShot = blankToNull(input.shot)
  if (requestedShot !== null && !isShotName(requestedShot)) {
    throw new ConfigError(`shot "${requestedShot}" must be letters, digits, "-", "_" or "." (it names a folder under renders/)`)
  }

  // The workspace's manifest, read before anything else is decided: its
  // defaults fill what the request leaves out, and its paths say where the
  // artifact goes. One that does not parse stops the request here, unpaid.
  const project = await readSessionProject(runtime, session, options.signal)
  // `from`, characters and the project style, applied by the tool itself.
  const composition = await compose(runtime, input, project, session, options.signal)
  const shot = requestedShot ?? composition.inheritedShot ?? DEFAULT_SHOT
  // DESIGN §20: the conversation's own choice (the composer chip) outranks the
  // workspace manifest, and the tool's arguments outrank both. Filled in that
  // order, so a field a higher layer set is never overwritten by a lower one.
  const chosen = withSessionSelection(composition.input, session === null ? null : await runtime.selections.get(session.id))
  const applied = withProjectDefaults(chosen.input, project)
  const filled = mergeFilled(chosen, applied)
  const chipNote = selectionProblem(runtime, session)
  const destination = await planDestination(runtime.ctx, session, project, shot)

  let target: ReturnType<typeof resolveTarget>
  try {
    target = resolveTarget(settings, filled.input.provider ?? null, filled.input.model ?? null)
  } catch (error: unknown) {
    if (error instanceof ConfigError && filled.target !== null) {
      throw new ConfigError(`${error.message} (provider and model came from ${defaultSourceText(filled.target)})`)
    }
    throw error
  }
  const { provider, model } = target
  const request = normaliseRequest(filled.input)
  if (composition.impliedS2v && !supportsMode(model, 's2v')) {
    throw new ConfigError(`the characters' reference images need mode s2v, which model "${model.id}" does not support; pass mode t2v to send only their descriptions, or choose a model with s2v`)
  }
  if (!supportsMode(model, request.mode)) {
    throw new ConfigError(`model "${model.id}" does not declare mode ${request.mode}; it supports ${model.modes.join('/')}`)
  }
  try {
    assertGeometry(model, {
      durationSeconds: request.durationSeconds,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
    })
  } catch (error: unknown) {
    const clause = fieldsClause(filled.fields)
    if (error instanceof ConfigError && clause !== null) {
      throw new ConfigError(`${error.message} (${clause})`)
    }
    throw error
  }

  const resolved = await resolveMaterials(runtime, request, options.signal, session)
  const generation: GenerationRequest = {
    model: model.id,
    prompt: request.prompt,
    mode: request.mode,
    firstFrame: resolved.firstFrame,
    lastFrame: resolved.lastFrame,
    referenceImages: resolved.referenceImages,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    generateAudio: model.generateAudio ? true : null,
  }

  // The shot is deliberately not part of the fingerprint: the same inputs for
  // another shot are the same paid generation, and a content-review refusal of
  // these inputs must not be sidestepped by naming a different folder.
  const fingerprint = fingerprintOf(provider.id, model.id, generation, request.descriptors)
  refuseDuplicate(runtime, fingerprint)
  refuseOverConcurrency(runtime, settings.maxConcurrent)

  const credential = await resolveApiKey(runtime.ctx, provider)
  const adapter = adapterFor(provider, model)

  // The last point at which this call may still be cancelled: nothing has left
  // the process yet. Past here the create request is the provider's to answer.
  options.signal?.throwIfAborted()

  // Intent first (DESIGN §6): the ledger row exists before the POST does, so a
  // lost response, a timeout or a crash mid-request still leaves a record that
  // blocks a duplicate submission and is reported by video_status.
  const now = new Date()
  const intent: VideoTask = {
    localId: runtime.ledger.nextLocalId(now),
    provider: provider.id,
    protocol: provider.protocol,
    model: model.id,
    ...(session === null ? {} : { session }),
    destination,
    providerTaskId: null,
    status: 'submitting',
    progress: null,
    submittedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    paramsFingerprint: fingerprint,
    params: {
      prompt: input.prompt,
      ...(composition.sentPrompt === input.prompt ? {} : { sentPrompt: composition.sentPrompt }),
      ...(composition.style === null ? {} : { style: composition.style }),
      ...(composition.characters.length === 0 ? {} : { characters: composition.characters }),
      ...(composition.from === null ? {} : { from: composition.from }),
      mode: request.mode,
      durationSeconds: request.durationSeconds,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      firstFrame: request.descriptors.firstFrame,
      lastFrame: request.descriptors.lastFrame,
      referenceImages: request.descriptors.referenceImages,
    },
    artifacts: [],
    error: null,
  }
  // Marked as this process's own before the row exists, so boot reconciliation
  // can never take it for one a dead process left behind.
  SENDING.add(intent.localId)
  let task: VideoTask
  try {
    await runtime.ledger.add(intent, () => {
      refuseDuplicate(runtime, fingerprint)
      refuseOverConcurrency(runtime, settings.maxConcurrent)
    })
    task = await submitIntent(runtime, intent, generation, adapter, {
      baseUrl: provider.baseUrl,
      apiKey: credential.value,
      timeoutMs: settings.requestTimeoutMs,
    })
  } finally {
    SENDING.delete(intent.localId)
  }
  runtime.logger.info(`video-forge: submitted ${task.localId} to ${provider.id}/${model.id} as ${task.providerTaskId ?? '(no id)'}`)

  const jobId = runtime.watchTask({
    task,
    provider,
    model,
    apiKey: credential.value,
    baseUrl: provider.baseUrl,
    owner: options.owner,
  })

  const waitSeconds = Math.max(0, Math.min(options.waitSeconds ?? 0, settings.waitSecondsMax))
  if (waitSeconds > 0 && jobId !== null) await waitForTerminal(runtime, task.localId, waitSeconds * 1000)

  const final = runtime.ledger.byId(task.localId) ?? task
  const artifact = final.artifacts[0] ?? null
  const done = final.status === 'succeeded' && artifact !== null
  const chipLine = chipContribution(chosen, provider, model, request)
  return {
    task: final,
    jobId: done ? null : jobId,
    artifact,
    kind: done ? 'done' : 'job',
    message: [
      done
        ? `finished ${final.localId}: ${artifact.bytes} bytes at ${describeLocation(artifact)}`
        : final.status === 'failed' || final.status === 'cancelled'
          ? describe(final).trim()
          : `submitted ${final.localId} (${provider.id}/${model.id})${destination.kind === 'workspace' ? ` for ${destination.renders}/${destination.shot}/` : ''}; track it with video_status — do not re-submit`,
      ...composition.notes,
      ...(chipLine === null ? [] : [chipLine]),
      ...(chipNote === null ? [] : [chipNote]),
    ].join('; '),
  }
}

/**
 * Raised when the create request went out but its outcome is unknown. The
 * ledger already holds the row as `unconfirmed`; the message says so, because
 * the one wrong reaction to it — submitting again — is a second charge.
 */
export class SubmissionUnconfirmedError extends Error {
  readonly taskId: string

  constructor(taskId: string, message: string) {
    super(message)
    this.name = 'SubmissionUnconfirmedError'
    this.taskId = taskId
  }
}

/** What video_status shows for an unconfirmed row, ahead of the transport detail. */
export function unconfirmedMessage(detail: string): string {
  return `the submission's outcome is unknown (${detail}): the provider may already have created and billed this task — do not re-submit it`
}

/** Rows whose create request this process is sending right now. */
const SENDING = new Set<string>()

/**
 * Whether this process is still sending the create request for a row. Boot
 * reconciliation must not mistake such a row for one a dead process left behind:
 * the tools are live before the ledger has finished loading.
 */
export function isSending(localId: string): boolean {
  return SENDING.has(localId)
}

/**
 * Whether an HTTP status says only that *something between us and the provider*
 * gave up — a timeout or a gateway failure. The upstream may still have accepted
 * the request, so such an answer is no proof that nothing was created. A 4xx or
 * a plain 500 is the provider's own refusal.
 */
function ambiguousHttp(status: number): boolean {
  return status === 408 || status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 599)
}

/**
 * Send the create request for an intent row and settle the row with whatever
 * is known afterwards. The request deliberately ignores the calling tool's
 * abort signal — once it has left, aborting it only discards the answer, not
 * the task — and is bounded by `requestTimeoutMs` instead.
 */
async function submitIntent(
  runtime: VideoForgeRuntime,
  intent: VideoTask,
  generation: GenerationRequest,
  adapter: ReturnType<typeof adapterFor>,
  transport: { baseUrl: string; apiKey: string | null; timeoutMs: number },
): Promise<VideoTask> {
  let sent = false
  const context: AdapterContext = {
    baseUrl: transport.baseUrl,
    apiKey: transport.apiKey,
    fetch: (input, init) => {
      sent = true
      return fetch(input, init)
    },
    signal: AbortSignal.timeout(transport.timeoutMs),
  }

  let submitted: { providerTaskId: string }
  try {
    submitted = await adapter.submit(context, generation)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    // A structured provider error is already in the message; only a body we
    // could not read is worth appending raw.
    const detail = error instanceof ProviderRequestError && error.providerMessage === null && error.bodyExcerpt !== null
      ? `${message}: ${error.bodyExcerpt}`
      : message
    const refused = !sent
      || (error instanceof ProviderRequestError && error.status !== null && error.status >= 400 && !ambiguousHttp(error.status))
    if (refused) {
      // ARK reviews the inputs at submit time and answers 400 with its own code.
      const moderation = error instanceof ProviderRequestError ? moderationOf(intent.protocol, error.providerCode) : null
      await runtime.ledger.update(intent.localId, current => ({
        ...current,
        status: 'failed',
        error: {
          message: sent ? `the provider refused the submission: ${detail}` : `nothing was sent: ${detail}`,
          code: NOT_SUBMITTED_CODE,
          ...(moderation === null ? {} : { moderation }),
        },
        updatedAt: new Date().toISOString(),
      }))
      throw error
    }
    await runtime.ledger.update(intent.localId, current => ({
      ...current,
      status: 'unconfirmed',
      error: { message: unconfirmedMessage(detail), code: UNCONFIRMED_CODE },
      updatedAt: new Date().toISOString(),
    }))
    runtime.logger.warn(`video-forge: ${intent.localId} submission outcome unknown: ${detail}`)
    throw new SubmissionUnconfirmedError(
      intent.localId,
      `${intent.localId}: ${unconfirmedMessage(detail)}. Check video_status with task_id ${intent.localId}.`,
    )
  }

  return runtime.ledger.update(intent.localId, current => ({
    ...current,
    providerTaskId: submitted.providerTaskId,
    status: 'queued',
    error: null,
    updatedAt: new Date().toISOString(),
  }))
}

export interface CancelOutcome {
  taskId: string
  cancelled: boolean
  providerSupported: boolean
  status: VideoTask['status']
  message: string
}

/** Ask the provider to stop one task. */
export async function cancelTask(
  runtime: VideoForgeRuntime,
  taskId: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<CancelOutcome> {
  const task = runtime.ledger.byId(taskId)
  if (task === undefined) throw new ConfigError(`no video task with id "${taskId}"; call video_status to list recent tasks`)

  const settings = runtime.settings()
  const { provider, model } = resolveTarget(settings, task.provider, task.model)
  const adapter = adapterFor(provider, model)
  const supported = cancelSupported(provider, model, adapter)

  if (task.status === 'submitting' || task.status === 'unconfirmed') {
    return {
      taskId: task.localId,
      cancelled: false,
      providerSupported: supported,
      status: task.status,
      message: `${task.localId} has no confirmed provider task id (${task.status}), so there is nothing to address a cancellation to; if the provider did create it, it keeps running and may be billed`,
    }
  }
  if (task.status !== 'queued' && task.status !== 'running') {
    return {
      taskId: task.localId,
      cancelled: false,
      providerSupported: supported,
      status: task.status,
      message: task.status === 'orphaned'
        // Not "nothing to cancel": the provider may still be running and billing it.
        ? `${task.localId} is orphaned: the plugin lost track of whether the provider is still working on it, so a cancellation is not sent blind (on a finished ARK task it would delete the record). The plugin keeps asking about it; check video_status, and cancel once it shows queued or running`
        : `${task.localId} is already ${task.status}; nothing to cancel`,
    }
  }
  if (!supported || task.providerTaskId === null) {
    return {
      taskId: task.localId,
      cancelled: false,
      providerSupported: false,
      status: task.status,
      message: `provider ${provider.id} does not document cancellation for ${model.id}; the task keeps running and may still be billed`,
    }
  }

  const credential = await resolveApiKey(runtime.ctx, provider)
  const context: AdapterContext = { baseUrl: provider.baseUrl, apiKey: credential.value, fetch, signal: options.signal }
  const accepted = await adapter.cancel(context, task.providerTaskId)
  let status: VideoTask['status'] = task.status
  let finishedAs: string | null = null
  if (!accepted) {
    // A refusal usually means the task has moved past the cancellable stage
    // since the last poll (ARK answered 409 RunningTaskDeletion a tenth of a
    // second after reporting it queued). Say where it actually is; a query is free.
    try {
      const state = await adapter.query(context, task.providerTaskId)
      if (state.status === 'queued' || state.status === 'running') status = state.status
      else if (state.terminal) finishedAs = state.status
    } catch {
      // Keep the ledger's view; the watch reports the next state anyway.
    }
  }
  if (accepted) {
    // Stop watching too: leaving a watcher on a cancelled task would keep polling
    // a provider that has already been told to stop.
    await runtime.cancels.get(task.localId)?.()
    await runtime.ledger.update(task.localId, current => ({
      ...current,
      status: 'cancelled',
      // The caller asked for this and holds the answer: no notice on top.
      quiet: true,
      updatedAt: new Date().toISOString(),
    }))
  }
  return {
    taskId: task.localId,
    cancelled: accepted,
    providerSupported: true,
    status: accepted ? 'cancelled' : status,
    message: accepted
      ? `the provider accepted the cancellation of ${task.localId}`
      : finishedAs !== null
        ? `the provider refused to cancel ${task.localId}: it has already ${finishedAs}; the watch records the outcome`
        : `the provider refused to cancel ${task.localId} (it may be past the cancellable stage); it keeps running`,
  }
}

/** One task row as either surface renders it. */
export interface TaskRow {
  taskId: string
  provider: string
  model: string
  status: VideoTask['status']
  progress: number | null
  mode: VideoMode
  prompt: string
  submittedAt: string
  updatedAt: string
  playUrl: string | null
  artifactPath: string | null
  /** Where the artifact is, for a reader: workspace-relative, or the path and why it is outside. */
  artifactLocation: string | null
  artifactBytes: number | null
  /**
   * The Session that submitted the task (M5). Null for a call no session made
   * and for rows written before the field existed; the video panel groups by it
   * because the tab it renders in belongs to one Session.
   */
  sessionId: string | null
  /**
   * The artifact's workspace-relative path (`renders/<shot>/vNNN.mp4`, POSIX
   * separators), or null when the video is not in the workspace. This — not the
   * absolute path — is what the panel matches a directory listing against.
   */
  workspacePath: string | null
  /** The `renders/` shot the artifact belongs to, when it landed in a workspace. */
  shot: string | null
  /** The video's own duration and pixel size, when the provider reported them. */
  durationSeconds: number | null
  width: number | null
  height: number | null
  /** What was requested (`1080p`), which can differ from what came back. */
  resolution: string | null
  /** Requested aspect ratio, when one was chosen. */
  aspectRatio: string | null
  error: string | null
  /** Provider-reported usage once settled; null while the task runs or before anyone asked. */
  billing: TaskBilling | null
  /** Set when the provider's content review refused the task, and on which side. */
  moderation: ModerationStage | null
}

export interface TaskList {
  tasks: TaskRow[]
  usage: { tasks: number; bytes: number; overTaskLimit: boolean; overByteLimit: boolean }
  active: number
}

/**
 * The ledger, read from disk (a failed read is tried again). A corrupt file was
 * already moved aside and counts as read. Anything else refuses the call before
 * it does anything, and says that nothing was submitted.
 */
export async function requireLedger(runtime: VideoForgeRuntime): Promise<void> {
  try {
    await runtime.ledger.ensureLoaded()
  } catch (error: unknown) {
    if (error instanceof LedgerCorruptError) return
    throw new LedgerUnavailableError(`the task ledger could not be read (${error instanceof Error ? error.message : String(error)}); nothing was submitted — try again in a moment`)
  }
}

/** The ledger is not readable right now; the panel answers 503 so the cards keep asking. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

/** Cap on one task list; the panel's `limit` is clamped to it. */
export const MAX_TASK_ROWS = 200

/** Rows `video_status` will list in one call: enough for a session's work, small enough to read into a context. */
export const TOOL_TASK_ROWS = 50

/** Project the ledger into rows. */
export function listTasks(runtime: VideoForgeRuntime, options: { taskId?: string | undefined; limit?: number | undefined } = {}): TaskList {
  const limit = Math.max(1, Math.min(options.limit ?? 10, MAX_TASK_ROWS))
  const all = runtime.ledger.list()
  const selected = options.taskId === undefined || options.taskId === ''
    ? all.slice(0, limit)
    : all.filter(task => task.localId === options.taskId)
  if (options.taskId !== undefined && options.taskId !== '' && selected.length === 0) {
    throw new ConfigError(`no video task with id "${options.taskId}"; list tasks instead`)
  }
  const retention = runtime.ledger.retention()
  return {
    tasks: selected.map(task => {
      const artifact = task.artifacts[0]
      const located = artifact?.location
      const inWorkspace = located?.kind === 'workspace' ? located : null
      return {
        taskId: task.localId,
        provider: task.provider,
        model: task.model,
        status: task.status,
        progress: task.progress,
        mode: task.params.mode,
        prompt: task.params.prompt,
        submittedAt: task.submittedAt,
        updatedAt: task.updatedAt,
        playUrl: artifact === undefined ? null : artifactUrl(task, artifact),
        artifactPath: artifact?.path ?? null,
        artifactLocation: artifact === undefined ? null : describeLocation(artifact),
        artifactBytes: artifact?.bytes ?? null,
        sessionId: task.session?.id ?? null,
        workspacePath: inWorkspace?.relativePath ?? null,
        shot: inWorkspace?.shot ?? null,
        // What came back wins over what was asked: a 1080p request may return
        // 1344×768, and the panel shows the video, not the request.
        durationSeconds: artifact?.durationSec ?? task.params.durationSeconds ?? null,
        width: artifact?.width ?? null,
        height: artifact?.height ?? null,
        resolution: task.params.resolution,
        aspectRatio: task.params.aspectRatio,
        error: task.error === null ? null : task.error.message,
        billing: task.billing ?? null,
        moderation: task.error?.moderation ?? null,
      }
    }),
    usage: {
      tasks: retention.tasks,
      bytes: retention.bytes,
      overTaskLimit: retention.overTaskLimit,
      overByteLimit: retention.overByteLimit,
    },
    active: all.filter(task => IN_FLIGHT.has(task.status)).length,
  }
}

/** What `video_status` with no task id tells the model about the setup (DESIGN §16.3). */
export interface SetupStatus {
  enabled: boolean
  defaultProvider: string | null
  defaultModel: string | null
  /**
   * What this conversation's composer chip chose (M6, DESIGN §20), or null when
   * it chose nothing — then the arguments, `video-project.yaml` and the plugin
   * settings decide, in that order.
   */
  selection: {
    provider: string | null
    model: string | null
    durationSeconds: number | null
    resolution: string | null
    aspectRatio: string | null
  } | null
  providers: {
    id: string
    protocol: string
    /** `set`: a key resolves; `not required`: a loopback provider with none; `missing`: see `keyProblem`. */
    key: 'set' | 'not required' | 'missing'
    keyProblem: string | null
    /** Whether its takes can be continued with `from` (the provider returns the last frame). */
    continuable: boolean
    models: ProviderStatus['models']
  }[]
  workspace: {
    /** `none`: no workspace conversation; `unavailable`: the filesystem service is away. */
    state: 'none' | 'unavailable' | 'default-layout' | 'manifest' | 'invalid-manifest'
    folder: string | null
    /** The conversation's permission mode; `read-only` refuses generation before anything is paid. */
    mode: string | null
    renders: string | null
    characters: string[]
    style: boolean
    problem: string | null
  }
}

class WorkspaceRefusal extends Error {}

/** The setup as the model needs it to act: providers, keys, models, and this workspace. */
export async function describeSetup(runtime: VideoForgeRuntime, session: TaskSession | null, signal?: AbortSignal): Promise<SetupStatus> {
  const settings = runtime.settings()
  const providers = (await describeProviders(runtime)).map(provider => ({
    id: provider.id,
    protocol: provider.protocol,
    key: provider.credential.configured ? (provider.credential.masked === null ? 'not required' as const : 'set' as const) : 'missing' as const,
    keyProblem: provider.credential.error,
    continuable: returnsLastFrame(provider.protocol),
    models: provider.models,
  }))

  const workspace: SetupStatus['workspace'] = {
    state: 'none',
    folder: session?.cwd ?? null,
    mode: session?.mode ?? null,
    renders: null,
    characters: [],
    style: false,
    problem: null,
  }
  if (session !== null && session.cwd !== null) {
    const fs = workspaceFsOf(runtime.ctx, true)
    if (fs === null) {
      workspace.state = 'unavailable'
      workspace.problem = 'the host filesystem service is not available'
    } else {
      try {
        const refusal = await workspaceRefusal(fs, session.cwd)
        if (refusal !== null) throw new WorkspaceRefusal(refusal)
        const project = await readProject(fs, session.cwd, signal)
        workspace.state = project.exists ? 'manifest' : 'default-layout'
        workspace.renders = project.manifest.paths.renders
        workspace.characters = Object.keys(project.manifest.characters)
        workspace.style = project.manifest.style !== null
      } catch (error: unknown) {
        workspace.state = error instanceof ManifestError && error.kind === 'invalid' ? 'invalid-manifest' : 'unavailable'
        workspace.problem = error instanceof Error ? error.message : String(error)
      }
    }
  }

  return {
    enabled: settings.enabled,
    defaultProvider: settings.defaultProvider === '' ? null : settings.defaultProvider,
    defaultModel: settings.defaultModel === '' ? null : settings.defaultModel,
    selection: session === null ? null : selectionView(await runtime.selections.get(session.id)),
    providers,
    workspace,
  }
}

/** The chip's choice as `video_status` reports it: no timestamp, and null when it chose nothing. */
export function selectionView(selection: SessionSelection | null): SetupStatus['selection'] {
  if (selection === null) return null
  return {
    provider: selection.provider,
    model: selection.model,
    durationSeconds: selection.durationSeconds,
    resolution: selection.resolution,
    aspectRatio: selection.aspectRatio,
  }
}

/** One settled task group in the cost summary, keyed by provider + model + shot. */
export interface CostGroup {
  provider: string
  model: string
  shot: string | null
  tasks: number
  /** Summed billable tokens (ARK), 0 when nothing reported. */
  tokens: number
  /** Summed billed output seconds (MiniMax), 0 when nothing reported. */
  outputSeconds: number
  /** Estimated money for this group, or null when no price row covers it. */
  estimatedAmount: number | null
}

/** The "how much has this cost" answer (DESIGN §16.5), usage × the editable price table. */
export interface CostSummary {
  currency: string
  pricedAt: string
  source: string
  note: string
  groups: CostGroup[]
  unknownUsage: { taskId: string; provider: string; model: string }[]
  totalTasks: number
  totalEstimatedAmount: number | null
}

/** The shot a task belongs to, for grouping the summary; null when unknown (pre-M3 rows, kept-at-home). */
function shotOfTask(task: VideoTask): string | null {
  if (task.destination !== undefined && task.destination.kind === 'workspace') return task.destination.shot
  const location = task.artifacts[0]?.location
  if (location !== undefined && location.kind === 'workspace') return location.shot
  return null
}

/** Summarize settled usage and its estimated cost across the ledger, grouped by provider/model/shot. */
export function summarizeCost(runtime: VideoForgeRuntime, options: { since?: string } = {}): CostSummary {
  const settings = runtime.settings()
  const table = settings.priceTable
  const groups = new Map<string, CostGroup & { _amount: number }>()
  const unknownUsage: CostSummary['unknownUsage'] = []
  let totalTasks = 0

  for (const task of runtime.ledger.list()) {
    if (options.since !== undefined && task.submittedAt < options.since) continue
    const billing = task.billing
    if (billing === undefined || billing === null) continue
    if (billing.state === 'unknown') {
      unknownUsage.push({ taskId: task.localId, provider: task.provider, model: task.model })
      continue
    }
    if (billing.state === 'none') continue
    const shot = shotOfTask(task)
    const key = `${task.provider}\u0000${task.model}\u0000${shot ?? ''}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { provider: task.provider, model: task.model, shot, tasks: 0, tokens: 0, outputSeconds: 0, estimatedAmount: 0, _amount: 0 }
      groups.set(key, group)
    }
    group.tasks++
    totalTasks++
    if (billing.tokens !== null) group.tokens += billing.tokens
    if (billing.outputSeconds !== null) group.outputSeconds += billing.outputSeconds
    const estimate = estimateCost(table, billing, task.provider, task.model)
    if (estimate !== null) group._amount += estimate.amount
  }

  let total = 0
  const resultGroups = [...groups.values()]
    .map(({ _amount, ...group }) => {
      total += _amount
      return { ...group, estimatedAmount: group.tokens > 0 || group.outputSeconds > 0 ? _amount : null }
    })
    .sort((left, right) => (right.estimatedAmount ?? 0) - (left.estimatedAmount ?? 0) || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))

  return {
    currency: table.currency,
    pricedAt: table.pricedAt,
    source: table.source,
    note: 'estimate only — the provider bill is authoritative',
    groups: resultGroups,
    unknownUsage,
    totalTasks,
    totalEstimatedAmount: total > 0 ? total : null,
  }
}

/** A pre-submit cost estimate for a request, never a submission (DESIGN §16.5). */
export interface GenerationEstimate {
  amount: number | null
  unit: PriceUnit | null
  currency: string
  pricedAt: string
  note: string
}

/**
 * Estimate what a generation would cost, without submitting anything.
 *
 * `selection` is the conversation's chip (M6): it supplies only what the request
 * leaves out, exactly as {@link generate} resolves the same chain, so the
 * estimate priced here is the request that would actually be sent.
 */
export function estimateGeneration(
  runtime: VideoForgeRuntime,
  request: { providerId: string | null; modelId: string | null; durationSeconds: number | null; resolution: string | null; aspectRatio: string | null },
  selection: SessionSelection | null = null,
): GenerationEstimate {
  const settings = runtime.settings()
  const table = settings.priceTable
  const fromChip: string[] = []
  // Provider and model travel as a pair: a model the chip chose must not be
  // paired with a provider the caller named.
  let providerId = request.providerId
  let modelId = request.modelId
  if (providerId === null && selection !== null && selection.provider !== null) {
    providerId = selection.provider
    modelId = selection.model
    fromChip.push(selection.model === null ? selection.provider : `${selection.provider}/${selection.model}`)
  }
  let durationSeconds = request.durationSeconds
  if (durationSeconds === null && selection !== null && selection.durationSeconds !== null) {
    durationSeconds = selection.durationSeconds
    fromChip.push(`${selection.durationSeconds}s`)
  }
  let resolution = request.resolution
  if (resolution === null && selection !== null && selection.resolution !== null) {
    resolution = selection.resolution
    fromChip.push(selection.resolution)
  }
  let aspectRatio = request.aspectRatio
  if (aspectRatio === null && selection !== null && selection.aspectRatio !== null) {
    aspectRatio = selection.aspectRatio
    fromChip.push(selection.aspectRatio)
  }
  const tail = `estimate only (${table.currency}, prices as of ${table.pricedAt})${fromChip.length === 0 ? '' : ` — ${fromChip.join(', ')} from the video chip in this conversation`} — the provider bill is authoritative`
  let target: { provider: ProviderSetting; model: ModelSetting }
  try {
    target = resolveTarget(settings, providerId, modelId)
  } catch (error) {
    return { amount: null, unit: null, currency: table.currency, pricedAt: table.pricedAt, note: error instanceof Error ? error.message : String(error) }
  }
  const { provider, model } = target
  if (provider.protocol === 'ark-seedance') {
    const tokens = estimateArkTokens(resolution, aspectRatio, durationSeconds)
    if (tokens === null) {
      return { amount: null, unit: 'token', currency: table.currency, pricedAt: table.pricedAt, note: `cannot estimate ARK tokens for ${resolution ?? '?'}/${aspectRatio ?? '?'} — only 16:9, 9:16 and 1:1 at 480p/720p/1080p/4k are estimated; ${tail}` }
    }
    const price = unitPrice(table, provider.id, model.id, 'token')
    if (price === null) return { amount: null, unit: 'token', currency: table.currency, pricedAt: table.pricedAt, note: `no token price row for ${provider.id}/${model.id}; ${tail}` }
    return { amount: tokens * price, unit: 'token', currency: table.currency, pricedAt: table.pricedAt, note: `≈${tokens} tokens × ${price} ${table.currency}/token; ${tail}` }
  }
  if (provider.protocol === 'minimax-video') {
    if (durationSeconds === null) {
      return { amount: null, unit: 'second', currency: table.currency, pricedAt: table.pricedAt, note: `a duration_seconds is required to estimate MiniMax; ${tail}` }
    }
    const price = unitPrice(table, provider.id, model.id, 'second')
    if (price === null) return { amount: null, unit: 'second', currency: table.currency, pricedAt: table.pricedAt, note: `no second price row for ${provider.id}/${model.id}; ${tail}` }
    return { amount: durationSeconds * price, unit: 'second', currency: table.currency, pricedAt: table.pricedAt, note: `${durationSeconds}s × ${price} ${table.currency}/s; ${tail}` }
  }
  return { amount: null, unit: null, currency: table.currency, pricedAt: table.pricedAt, note: `no estimate for protocol ${provider.protocol}; ${tail}` }
}

/** One provider as the configuration card shows it: capability plus credential state, never a secret. */
export interface ProviderStatus {
  id: string
  protocol: string
  baseUrl: string
  authRef: string
  credential: { configured: boolean; source: string | null; masked: string | null; error: string | null }
  models: {
    id: string
    label: string
    modes: readonly string[]
    durations: readonly number[]
    resolutions: readonly string[]
    aspectRatios: readonly string[]
    cancelable: boolean
  }[]
}

/** Describe the configured providers, including whether each credential resolves. */
export async function describeProviders(runtime: VideoForgeRuntime): Promise<ProviderStatus[]> {
  const settings = runtime.settings()
  const rows: ProviderStatus[] = []
  for (const provider of settings.providers) {
    rows.push({
      id: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      authRef: provider.authRef,
      credential: await credentialStatus(runtime, provider),
      models: provider.models.map(model => ({
        id: model.id,
        label: model.label === '' ? model.id : model.label,
        modes: model.modes,
        durations: model.durations,
        resolutions: model.resolutions,
        aspectRatios: model.aspectRatios,
        cancelable: model.cancelable,
      })),
    })
  }
  return rows
}

async function credentialStatus(
  runtime: VideoForgeRuntime,
  provider: ProviderSetting,
): Promise<ProviderStatus['credential']> {
  try {
    const lookup = await resolveApiKey(runtime.ctx, provider)
    if (lookup.value === null) return { configured: true, source: lookup.source, masked: null, error: null }
    // Only a short tail is ever shown; the value itself stays in the host process.
    return { configured: true, source: lookup.source, masked: maskSecret(lookup.value), error: null }
  } catch (error: unknown) {
    return { configured: false, source: null, masked: null, error: error instanceof Error ? error.message : String(error) }
  }
}

interface NormalisedRequest {
  prompt: string
  mode: VideoMode
  durationSeconds: number | null
  resolution: string | null
  aspectRatio: string | null
  firstFrame: string | null
  lastFrame: string | null
  referenceImages: string[]
  descriptors: { firstFrame: string | null; lastFrame: string | null; referenceImages: string[] }
}

/** Enforce the mutually exclusive input scenarios before anything is sent. */
export function normaliseRequest(input: GenerateInput): NormalisedRequest {
  const mode = input.mode ?? 't2v'
  const first = blankToNull(input.firstFrame)
  const last = blankToNull(input.lastFrame)
  const references = (input.referenceImages ?? []).map(value => value.trim()).filter(value => value !== '')
  if (input.prompt.trim() === '') throw new ConfigError('prompt must not be empty')

  if (mode === 't2v' && (first !== null || last !== null || references.length > 0)) {
    throw new ConfigError('mode t2v takes text only; choose i2v (first_frame), flf2v (first_frame + last_frame) or s2v (reference_images) to send images')
  }
  if (mode === 'i2v') {
    if (first === null) throw new ConfigError('mode i2v requires first_frame')
    if (last !== null) throw new ConfigError('mode i2v takes only a first frame; use flf2v for a first and last frame')
    if (references.length > 0) throw new ConfigError('first_frame and reference_images are mutually exclusive; use mode s2v for references')
  }
  if (mode === 'flf2v') {
    if (first === null || last === null) throw new ConfigError('mode flf2v requires both first_frame and last_frame')
    if (references.length > 0) throw new ConfigError('first_frame/last_frame and reference_images are mutually exclusive')
  }
  if (mode === 's2v') {
    if (references.length === 0) throw new ConfigError('mode s2v requires at least one reference_images entry')
    if (first !== null || last !== null) throw new ConfigError('first_frame/last_frame and reference_images are mutually exclusive; use mode i2v or flf2v')
  }

  return {
    prompt: input.prompt,
    mode,
    durationSeconds: input.durationSeconds ?? null,
    resolution: blankToNull(input.resolution),
    aspectRatio: blankToNull(input.aspectRatio),
    firstFrame: first,
    lastFrame: last,
    referenceImages: references,
    descriptors: { firstFrame: null, lastFrame: null, referenceImages: [] },
  }
}

async function resolveMaterials(
  runtime: VideoForgeRuntime,
  request: NormalisedRequest,
  signal: AbortSignal | undefined,
  session: TaskSession | null,
): Promise<{ firstFrame: ResolvedMaterial | null; lastFrame: ResolvedMaterial | null; referenceImages: ResolvedMaterial[] }> {
  const context = { fs: workspaceFsOf(runtime.ctx, session !== null), cwd: session?.cwd ?? null, signal }
  const classify = (value: string): 'path' | 'url' =>
    (value.startsWith('http://') || value.startsWith('https://') ? 'url' : 'path')

  const one = async (value: string): Promise<{ resolved: ResolvedMaterial; descriptor: string }> => {
    const kind = classify(value)
    const resolved = await resolveMaterial({ kind, value }, context)
    return { resolved, descriptor: describeMaterial({ kind, value }, resolved) }
  }

  const first = request.firstFrame === null ? null : await one(request.firstFrame)
  const last = request.lastFrame === null ? null : await one(request.lastFrame)
  const references: ResolvedMaterial[] = []
  for (const value of request.referenceImages) {
    const entry = await one(value)
    references.push(entry.resolved)
    request.descriptors.referenceImages.push(entry.descriptor)
  }
  request.descriptors.firstFrame = first?.descriptor ?? null
  request.descriptors.lastFrame = last?.descriptor ?? null
  return {
    firstFrame: first?.resolved ?? null,
    lastFrame: last?.resolved ?? null,
    referenceImages: references,
  }
}

/** Canonical fingerprint: the prompt plus the exact inputs, so different images differ. */
function fingerprintOf(
  providerId: string,
  modelId: string,
  request: GenerationRequest,
  descriptors: NormalisedRequest['descriptors'],
): string {
  const canonical = JSON.stringify({
    provider: providerId,
    model: modelId,
    prompt: request.prompt,
    mode: request.mode,
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    firstFrame: descriptors.firstFrame,
    lastFrame: descriptors.lastFrame,
    referenceImages: descriptors.referenceImages,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function refuseDuplicate(runtime: VideoForgeRuntime, fingerprint: string): void {
  // Outside any dedupe window: the provider's content review already refused
  // these exact inputs, and asking again only buys the same verdict — possibly
  // at a price. Only the input side is a verdict on the request itself; an
  // output refusal judged one random sample, and a re-roll may pass, so those
  // are held back by the ordinary dedupe window only. A changed prompt or
  // material is a different request.
  const refused = runtime.ledger.list().find(task => task.paramsFingerprint === fingerprint && task.error?.moderation === 'input')
  if (refused !== undefined) {
    throw new ConfigError(
      `the provider's content review refused the inputs of this exact request as ${refused.localId} on ${refused.submittedAt}: ${refused.error?.message ?? ''} — sending it again gets the same verdict; change the prompt or the materials instead${refused.params.sentPrompt === undefined ? '' : ' (the text sent also included the project style or character descriptions from video-project.yaml, which may be what was refused)'}`,
    )
  }
  const window = runtime.settings().dedupeWindowSeconds
  if (window <= 0) return
  const existing = runtime.ledger.byFingerprint(fingerprint, Date.now() - window * 1000)
  if (existing === undefined) return
  if (existing.status === 'submitting' || existing.status === 'unconfirmed') {
    throw new ConfigError(
      `an identical request is already tracked as ${existing.localId} (${existing.status}): its submission's outcome is unknown and the provider may already have created and billed it; check video_status with that id — re-submitting risks paying twice`,
    )
  }
  throw new ConfigError(
    `an identical request is already tracked as ${existing.localId} (${existing.status}); check video_status with that id instead of re-submitting — a repeated submission is a repeated charge`,
  )
}

function refuseOverConcurrency(runtime: VideoForgeRuntime, maxConcurrent: number): void {
  const open = runtime.ledger.list().filter(task => IN_FLIGHT.has(task.status))
  if (open.length < maxConcurrent) return
  throw new ConfigError(
    `video-forge already has ${open.length} task(s) in flight (limit maxConcurrent=${maxConcurrent}): ${open.map(task => task.localId).join(', ')}; wait for one to finish, or cancel it with video_cancel`,
  )
}

async function waitForTerminal(runtime: VideoForgeRuntime, localId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = runtime.ledger.byId(localId)
    if (task === undefined || !OPEN.has(task.status)) return
    if (Date.now() >= deadline) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

/** The workspace's project state, or null for a call with no workspace. */
async function readSessionProject(
  runtime: VideoForgeRuntime,
  session: TaskSession | null,
  signal: AbortSignal | undefined,
): Promise<ProjectState | null> {
  if (session === null || session.cwd === null) return null
  const fs = workspaceFsOf(runtime.ctx, true)
  if (fs === null) {
    throw new ConfigError('the host filesystem service is not available (a remote workspace may be reconnecting); nothing was submitted — try again in a moment')
  }
  return readProject(fs, session.cwd, signal)
}

/**
 * Which layer supplied a field the request left out (DESIGN §20). Every layer
 * below the arguments is named in a refusal, because a default that no one
 * mentions is how a 10-second shot quietly becomes 5 seconds.
 */
export type DefaultSource = 'conversation' | 'manifest'

/** The geometry a layer may fill in, and the request fields they live in. */
type GeometryField = 'duration_seconds' | 'resolution' | 'aspect_ratio'

/** One layer's contribution: the input after it, and what it supplied. */
interface Filled {
  input: GenerateInput
  /** Set when this layer supplied the provider/model pair. */
  target: DefaultSource | null
  /** The geometry fields this layer supplied, each with the layer that did. */
  fields: Partial<Record<GeometryField, DefaultSource>>
}

/**
 * Fill what the request leaves out from the conversation's own choice — the
 * composer chip (M6). Provider and model travel as a pair, and only when the
 * request names neither: a model the chip chose must not be paired with a
 * provider the model passed as an argument.
 */
export function withSessionSelection(input: GenerateInput, selection: SessionSelection | null): Filled {
  if (selection === null) return { input, target: null, fields: {} }
  const next: GenerateInput = { ...input }
  const fields: Filled['fields'] = {}
  let target: DefaultSource | null = null
  if (blankToNull(input.provider) === null && blankToNull(input.model) === null && selection.provider !== null) {
    next.provider = selection.provider
    if (selection.model !== null) next.model = selection.model
    target = 'conversation'
  }
  if (blankToNull(input.resolution) === null && selection.resolution !== null) {
    next.resolution = selection.resolution
    fields.resolution = 'conversation'
  }
  if (blankToNull(input.aspectRatio) === null && selection.aspectRatio !== null) {
    next.aspectRatio = selection.aspectRatio
    fields.aspect_ratio = 'conversation'
  }
  if ((input.durationSeconds === undefined || input.durationSeconds === null) && selection.durationSeconds !== null) {
    next.durationSeconds = selection.durationSeconds
    fields.duration_seconds = 'conversation'
  }
  return { input: next, target, fields }
}

/**
 * Fill what the request leaves out from the manifest's defaults. Same pairing
 * rule as above: a model id from the manifest must not be paired with a
 * provider the request chose.
 */
export function withProjectDefaults(input: GenerateInput, project: ProjectState | null): Filled {
  if (project === null) return { input, target: null, fields: {} }
  const defaults = project.manifest.defaults
  const fields: Filled['fields'] = {}
  const next: GenerateInput = { ...input }
  let target: DefaultSource | null = null
  if (blankToNull(input.provider) === null && blankToNull(input.model) === null) {
    if (defaults.provider !== null) next.provider = defaults.provider
    if (defaults.model !== null) next.model = defaults.model
    if (defaults.provider !== null || defaults.model !== null) target = 'manifest'
  }
  if (blankToNull(input.resolution) === null && defaults.resolution !== null) {
    next.resolution = defaults.resolution
    fields.resolution = 'manifest'
  }
  if (blankToNull(input.aspectRatio) === null && defaults.aspectRatio !== null) {
    next.aspectRatio = defaults.aspectRatio
    fields.aspect_ratio = 'manifest'
  }
  if ((input.durationSeconds === undefined || input.durationSeconds === null) && defaults.durationSeconds !== null) {
    next.durationSeconds = defaults.durationSeconds
    fields.duration_seconds = 'manifest'
  }
  return { input: next, target, fields }
}

/**
 * Combine the layers, which were applied in order: the earlier layer's input is
 * already in the later layer's, so only the attributions need merging, and the
 * higher layer wins one.
 */
export function mergeFilled(first: Filled, ...rest: Filled[]): Filled {
  let target: DefaultSource | null = first.target
  let fields: Filled['fields'] = first.fields
  let input: GenerateInput = first.input
  for (const layer of rest) {
    input = layer.input
    target = target ?? layer.target
    fields = { ...layer.fields, ...fields }
  }
  return { input, target, fields }
}

/** How a layer reads inside a refusal: the thing the user would go and change. */
export function defaultSourceText(source: DefaultSource): string {
  return source === 'conversation' ? 'the video chip in this conversation' : `the defaults in ${MANIFEST_FILE}`
}

/** Name every filled geometry field with the layer that supplied it, or null when none was filled. */
export function fieldsClause(fields: Filled['fields']): string | null {
  const groups = new Map<DefaultSource, string[]>()
  for (const [field, source] of Object.entries(fields) as [GeometryField, DefaultSource][]) {
    const names = groups.get(source) ?? []
    names.push(field)
    groups.set(source, names)
  }
  if (groups.size === 0) return null
  return [...groups.entries()]
    .map(([source, names]) => `${names.join(', ')} came from ${defaultSourceText(source)}`)
    .join('; ')
}

/**
 * What the video chip contributed to this request, as one clause of the tool
 * result. The model is the reader: it must be able to tell that a value came
 * from somewhere other than its own arguments, or it will keep composing takes
 * against a duration the user set in the composer.
 */
export function chipContribution(
  chosen: Filled,
  provider: ProviderSetting,
  model: ModelSetting,
  request: NormalisedRequest,
): string | null {
  const parts: string[] = []
  if (chosen.target === 'conversation') parts.push(`${provider.id}/${model.id}`)
  if (chosen.fields.duration_seconds === 'conversation' && request.durationSeconds !== null) parts.push(`${request.durationSeconds}s`)
  if (chosen.fields.resolution === 'conversation' && request.resolution !== null) parts.push(request.resolution)
  if (chosen.fields.aspect_ratio === 'conversation' && request.aspectRatio !== null) parts.push(request.aspectRatio)
  if (parts.length === 0) return null
  return `the video chip in this conversation set ${parts.join(', ')} — pass provider/model/duration_seconds/resolution/aspect_ratio explicitly to override it for one take`
}

/** A note when the conversation's choice could not be read at all, or null. */
function selectionProblem(runtime: VideoForgeRuntime, session: TaskSession | null): string | null {
  if (session === null) return null
  const problem = runtime.selections.readProblem()
  return problem === null ? null : `${problem}: this take used the arguments, then video-project.yaml, then the plugin settings`
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) return null
  return value.trim() === '' ? null : value
}

export type { ModelSetting }
