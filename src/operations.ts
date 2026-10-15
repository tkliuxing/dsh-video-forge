/**
 * The operations behind both surfaces.
 *
 * The model tools and the workbench panel must not each own a copy of "validate,
 * de-duplicate, submit, watch" — two implementations of a paid side effect drift,
 * and the one that drifts is always the quieter one. So the whole submission path
 * lives here, and `tools.ts` / `panel-api.ts` are thin adapters over it.
 *
 * Everything is expressed against {@link VideoForgeRuntime}, so an operation never
 * needs to know whether a model or a browser asked for it.
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { maskSecret, resolveApiKey } from './credentials.ts'
import { describeMaterial, resolveMaterial } from './materials.ts'
import { ProviderRequestError } from './providers/adapter.ts'
import { adapterFor, cancelSupported, type AdapterContext } from './providers/index.ts'
import { artifactUrl, type VideoForgeRuntime } from './runtime.ts'
import { assertGeometry, ConfigError, resolveTarget, supportsMode, type ModelSetting, type ProviderSetting } from './settings.ts'
import {
  NOT_SUBMITTED_CODE,
  UNCONFIRMED_CODE,
  type GenerationRequest,
  type ResolvedMaterial,
  type VideoArtifact,
  type TaskBilling,
  type VideoMode,
  type VideoTask,
} from './types.ts'
import { describe } from './watch.ts'

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
  // Duplicate checks read the ledger, so it must have been read from disk first.
  await runtime.ledger.ready()

  const { provider, model } = resolveTarget(settings, input.provider ?? null, input.model ?? null)
  const request = normaliseRequest(input)
  if (!supportsMode(model, request.mode)) {
    throw new ConfigError(`model "${model.id}" does not declare mode ${request.mode}; it supports ${model.modes.join('/')}`)
  }
  assertGeometry(model, {
    durationSeconds: request.durationSeconds,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
  })

  const resolved = await resolveMaterials(runtime, request, options.signal)
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
    providerTaskId: null,
    status: 'submitting',
    progress: null,
    submittedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    paramsFingerprint: fingerprint,
    params: {
      prompt: request.prompt,
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
  return {
    task: final,
    jobId: done ? null : jobId,
    artifact,
    kind: done ? 'done' : 'job',
    message: done
      ? `finished ${final.localId}: ${artifact.bytes} bytes at ${artifact.path}`
      : final.status === 'failed' || final.status === 'cancelled'
        ? describe(final).trim()
        : `submitted ${final.localId} (${provider.id}/${model.id}); track it with video_status — do not re-submit`,
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
      await runtime.ledger.update(intent.localId, current => ({
        ...current,
        status: 'failed',
        error: { message: sent ? `the provider refused the submission: ${detail}` : `nothing was sent: ${detail}`, code: NOT_SUBMITTED_CODE },
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
      message: `${task.localId} is already ${task.status}; nothing to cancel`,
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

export interface ExportOutcome {
  taskId: string
  path: string
  bytes: number
}

/** Copy a finished artifact out of the plugin's output directory. */
export async function exportArtifact(
  runtime: VideoForgeRuntime,
  taskId: string,
  targetPath: string,
  overwrite = false,
): Promise<ExportOutcome> {
  const task = runtime.ledger.byId(taskId)
  if (task === undefined) throw new ConfigError(`no video task with id "${taskId}"`)
  const artifact = task.artifacts[0]
  if (artifact === undefined) {
    throw new ConfigError(`${task.localId} is ${task.status} and has no artifact to export yet; check video_status`)
  }
  if (!isAbsolute(targetPath)) throw new ConfigError(`target_path must be absolute, got "${targetPath}"`)

  const existing = await stat(targetPath).catch(() => null)
  if (existing !== null && !overwrite) {
    throw new ConfigError(`${targetPath} already exists; pass overwrite to replace it`)
  }
  await mkdir(join(targetPath, '..'), { recursive: true })
  await copyFile(artifact.path, targetPath)
  const written = await stat(targetPath)
  return { taskId: task.localId, path: targetPath, bytes: written.size }
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
  artifactBytes: number | null
  error: string | null
  /** Provider-reported usage once settled; null while the task runs or before anyone asked. */
  billing: TaskBilling | null
}

export interface TaskList {
  tasks: TaskRow[]
  usage: { tasks: number; bytes: number; overTaskLimit: boolean; overByteLimit: boolean }
  active: number
}

/** Project the ledger into rows. */
export function listTasks(runtime: VideoForgeRuntime, options: { taskId?: string | undefined; limit?: number | undefined } = {}): TaskList {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50))
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
        artifactBytes: artifact?.bytes ?? null,
        error: task.error === null ? null : task.error.message,
        billing: task.billing ?? null,
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
): Promise<{ firstFrame: ResolvedMaterial | null; lastFrame: ResolvedMaterial | null; referenceImages: ResolvedMaterial[] }> {
  const context = { workspaceRoot: null, signal }
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
  void runtime
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

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) return null
  return value.trim() === '' ? null : value
}

export type { ModelSetting }
