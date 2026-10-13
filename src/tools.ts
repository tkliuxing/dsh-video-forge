/**
 * The four model-facing tools.
 *
 * Contract notes that shape this file (DESIGN §4, docs/cookbook/adding-a-tool.md):
 *
 * - `execute` returns exactly one canonical JSON value; `output.render` owns the
 *   prose a model reads, and `output.presentationMeta` owns the bounded facts the
 *   browser card needs. Presenters are pure functions of `args` (+ the value) —
 *   they also run on session replay, so they must not read the ledger, the clock,
 *   or the filesystem.
 * - Every tool reads the config snapshot per call, so a live settings edit takes
 *   effect on the next call with no re-registration.
 * - "Check, never re-submit": `video_status` is the recovery entry point, and a
 *   duplicate submission inside the dedupe window is refused at this layer rather
 *   than trusted to the model's judgement.
 */

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveApiKey, maskSecret } from './credentials.ts'
import { ConfigError, resolveTarget, supportsMode } from './settings.ts'
import { assertGeometry } from './settings.ts'
import { describeMaterial, MaterialError, resolveMaterial } from './materials.ts'
import { adapterFor, cancelSupported } from './providers/index.ts'
import type { AdapterContext } from './providers/index.ts'
import { artifactUrl, type VideoForgeRuntime } from './runtime.ts'
import type { GenerationRequest, ResolvedMaterial, VideoMode, VideoTask } from './types.ts'
import { describe } from './watch.ts'

/** Statuses the ledger treats as "the provider may still be working". */
const OPEN = new Set<VideoTask['status']>(['queued', 'running'])

const ARTIFACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    url: { type: 'string', required: true },
    mime: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
  },
} as const

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string', required: true },
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    status: { type: 'string', required: true },
    progress: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
    submitted_at: { type: 'string', required: true },
    play_url: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    error: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
} as const

/** Register all four tools. */
export function registerTools(runtime: VideoForgeRuntime): void {
  const { ctx, ledger, logger } = runtime

  ctx.tools.register(defineTool({
    name: 'video_generate',
    description: [
      'Generate a video with an online model provider.',
      'Returns immediately with a task id and a background job id; the generation continues while you work, and its completion is delivered to you as a notice. Use video_status to check on it.',
      'Inputs: prompt (required), optional provider/model, mode t2v (text only), i2v (first_frame), flf2v (first_frame + last_frame) or s2v (reference_images).',
      'A local image must be an absolute workspace path that already exists; verify it with the read tool first.',
      'Never re-submit the same prompt to work around a timeout: call video_status instead. A duplicate submission inside the dedupe window is refused.',
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show. Be specific about subject, motion, camera and style.' },
      provider: { type: 'string', description: 'Provider id, or `providerId::modelId`. Defaults to the configured default provider.' },
      model: { type: 'string', description: 'Model id at that provider. Defaults to the provider\'s first declared model.' },
      mode: { type: 'string', enum: ['t2v', 'i2v', 'flf2v', 's2v'], description: 'Input shape. Defaults to t2v.' },
      first_frame: { type: 'string', description: 'Absolute image path or http(s) URL used as the first frame.' },
      last_frame: { type: 'string', description: 'Absolute image path or http(s) URL used as the last frame (flf2v only).' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Subject/style reference images (s2v only).' },
      duration_seconds: { type: 'number', description: 'Requested length; the model\'s declared durations decide what is valid.' },
      resolution: { type: 'string', description: 'e.g. 720p, 1080p.' },
      aspect_ratio: { type: 'string', description: 'e.g. 16:9, 9:16, 1:1.' },
      wait_seconds: { type: 'number', description: 'Optionally block up to this many seconds for a finished artifact before returning the job handle. 0 (default) returns at once.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['job', 'done'] },
          task_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          status: { type: 'string', required: true },
          progress: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
          job_id: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          artifact: { required: true, oneOf: [{ type: 'null' }, ARTIFACT_SCHEMA] },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({
        taskId: value.task_id,
        provider: value.provider,
        model: value.model,
        status: value.status,
        progress: value.progress,
        artifact: value.artifact,
      }),
    },
    // Generation is paid and resource-heavy: never run two of these side by side.
    isConcurrencySafe: () => false,
    timeoutMs: 660_000,
    presentCall: () => ({ card: 'generic', title: 'Generate video' }),
    presentResult: () => ({ card: 'generic', title: 'Video generation' }),

    async execute(args, exec) {
      const settings = runtime.settings()
      if (!settings.enabled) {
        throw new ConfigError('video-forge is disabled in its settings; enable it before generating')
      }
      const { provider, model } = resolveTarget(settings, args.provider ?? null, args.model ?? null)
      const mode = (args.mode ?? 't2v') as VideoMode
      const request = normaliseRequest(args, mode)

      if (!supportsMode(model, mode)) {
        throw new ConfigError(`model "${model.id}" does not declare mode ${mode}; it supports ${model.modes.join('/')}`)
      }
      assertGeometry(model, {
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
      })

      const resolved = await resolveMaterials(runtime, request, exec)
      const generation: GenerationRequest = {
        model: model.id,
        prompt: request.prompt,
        mode,
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

      const open = ledger.list().filter(task => OPEN.has(task.status))
      if (open.length >= settings.maxConcurrent) {
        throw new ConfigError(
          `video-forge already has ${open.length} task(s) in flight (limit maxConcurrent=${settings.maxConcurrent}): ${open.map(task => task.localId).join(', ')}; wait for one to finish, or cancel it with video_cancel`,
        )
      }

      const credential = await resolveApiKey(ctx, provider)
      const adapter = adapterFor(provider, model)
      const context: AdapterContext = {
        baseUrl: provider.baseUrl,
        apiKey: credential.value,
        fetch,
        signal: exec.signal,
      }

      const submitted = await adapter.submit(context, generation)
      const now = new Date()
      const task: VideoTask = {
        localId: ledger.nextLocalId(now),
        provider: provider.id,
        protocol: provider.protocol,
        model: model.id,
        providerTaskId: submitted.providerTaskId,
        status: 'queued',
        progress: null,
        submittedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        paramsFingerprint: fingerprint,
        params: {
          prompt: request.prompt,
          mode,
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
      await ledger.add(task)
      logger.info(`video-forge: submitted ${task.localId} to ${provider.id}/${model.id} as ${submitted.providerTaskId}${credential.value === null ? '' : ` using ${maskSecret(credential.value)}`}`)

      const jobId = runtime.watchTask({
        task,
        provider,
        model,
        apiKey: credential.value,
        baseUrl: provider.baseUrl,
        owner: exec.agent?.id,
      })

      const waitSeconds = Math.max(0, Math.min(args.wait_seconds ?? 0, settings.waitSecondsMax))
      if (waitSeconds > 0 && jobId !== null) {
        await waitForTerminal(ledger, task.localId, waitSeconds * 1000)
      }

      const final = ledger.byId(task.localId) ?? task
      const artifact = final.artifacts[0]
      const done = final.status === 'succeeded' && artifact !== undefined
      return {
        kind: done ? 'done' as const : 'job' as const,
        task_id: final.localId,
        provider: final.provider,
        model: final.model,
        status: final.status,
        progress: final.progress,
        job_id: done ? null : jobId,
        artifact: artifact === undefined
          ? null
          : {
            path: artifact.path,
            url: artifactUrl(final, artifact),
            mime: artifact.mime,
            bytes: artifact.bytes,
          },
      message: done
        ? `finished ${final.localId}: ${artifact.bytes} bytes at ${artifact.path}`
        : final.status === 'failed' || final.status === 'cancelled'
          ? topLine(final)
          : jobId === null
            ? `submitted ${final.localId} (${provider.id}/${model.id}); retain this id — poll it with video_status, do not re-submit`
            : `submitted ${final.localId} (${provider.id}/${model.id}); the background job ${jobId} reports progress and completion, and video_status keeps the link after a restart`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_status',
    description: [
      'List recent video generations with their provider, status, progress, error and (once finished) the artifact path and play URL.',
      'This is the recovery entry point: after a timeout, a host restart, or any doubt, check here instead of submitting the prompt again.',
      'Tasks marked orphaned belonged to a previous process and have not been reconciled with the provider yet; they are never re-submitted automatically.',
    ].join(' '),
    parameters: {
      task_id: { type: 'string', description: 'One task id, e.g. v-20261013-0001. Omit to list recent tasks.' },
      limit: { type: 'number', description: 'How many tasks to list (default 10, maximum 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', required: true, items: TASK_SCHEMA },
          usage: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              tasks: { type: 'number', required: true },
              bytes: { type: 'number', required: true },
              over_task_limit: { type: 'boolean', required: true },
              over_byte_limit: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tasks.length === 0
          ? 'no video tasks yet'
          : value.tasks.map(row => [
            `${row.task_id} ${row.status}${row.progress === null ? '' : ` ${Math.round(row.progress * 100)}%`}`,
            `${row.provider}/${row.model}`,
            row.play_url === null ? '' : row.play_url,
            row.error ?? '',
          ].filter(part => part !== '').join(' · ')).join('\n'),
      }],
      presentationMeta: (_args, value) => ({ tasks: value.tasks }),
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Video task status' }),
    presentResult: () => ({ card: 'generic', title: 'Video tasks' }),

    async execute(args) {
      const limit = Math.max(1, Math.min(args.limit ?? 10, 50))
      const all = ledger.list()
      const selected = args.task_id === undefined || args.task_id === ''
        ? all.slice(0, limit)
        : all.filter(task => task.localId === args.task_id)
      if (args.task_id !== undefined && args.task_id !== '' && selected.length === 0) {
        throw new ConfigError(`no video task with id "${args.task_id}"; call video_status without task_id to list recent tasks`)
      }
      const retention = ledger.retention()
      return {
        tasks: selected.map(task => {
          const artifact = task.artifacts[0]
          return {
            task_id: task.localId,
            provider: task.provider,
            model: task.model,
            status: task.status,
            progress: task.progress,
            submitted_at: task.submittedAt,
            play_url: artifact === undefined ? null : artifactUrl(task, artifact),
            error: task.error === null ? null : task.error.message,
          }
        }),
        usage: {
          tasks: retention.tasks,
          bytes: retention.bytes,
          over_task_limit: retention.overTaskLimit,
          over_byte_limit: retention.overByteLimit,
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_cancel',
    description: [
      'Ask the provider to cancel a generation (this is what stops the work).',
      'Distinct from job_kill, which only stops watching and leaves the provider running — and therefore still billing.',
      'Documented provider support varies: some providers only cancel a task that has not started yet, and the result reports whether the request was accepted.',
    ].join(' '),
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task to cancel, e.g. v-20261013-0001.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          cancelled: { type: 'boolean', required: true },
          provider_supported: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
      presentationMeta: (_args, value) => ({ taskId: value.task_id, cancelled: value.cancelled, status: value.status }),
    },
    isConcurrencySafe: () => false,
    presentCall: () => ({ card: 'generic', title: 'Cancel video task' }),
    presentResult: () => ({ card: 'generic', title: 'Video task cancelled' }),

    async execute(args, exec) {
      const task = ledger.byId(args.task_id)
      if (task === undefined) {
        throw new ConfigError(`no video task with id "${args.task_id}"; call video_status to list recent tasks`)
      }
      const settings = runtime.settings()
      const { provider, model } = resolveTarget(settings, task.provider, task.model)
      const adapter = adapterFor(provider, model)
      const supported = cancelSupported(provider, model, adapter)

      if (task.status !== 'queued' && task.status !== 'running') {
        return {
          task_id: task.localId,
          cancelled: false,
          provider_supported: supported,
          status: task.status,
          message: `${task.localId} is already ${task.status}; nothing to cancel`,
        }
      }
      if (!supported || task.providerTaskId === null) {
        return {
          task_id: task.localId,
          cancelled: false,
          provider_supported: false,
          status: task.status,
          message: `provider ${provider.id} does not document cancellation for ${model.id}; the task will keep running and may still be billed`,
        }
      }

      const credential = await resolveApiKey(ctx, provider)
      const context: AdapterContext = { baseUrl: provider.baseUrl, apiKey: credential.value, fetch, signal: exec.signal }
      const accepted = await adapter.cancel(context, task.providerTaskId)
      if (accepted) {
        // Stop watching too; leaving a watcher on a cancelled task would keep
        // polling a provider that has already been told to stop.
        await runtime.cancels.get(task.localId)?.()
        await ledger.update(task.localId, current => ({
          ...current,
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
        }))
      }
      return {
        task_id: task.localId,
        cancelled: accepted,
        provider_supported: true,
        status: accepted ? 'cancelled' : task.status,
        message: accepted
          ? `the provider accepted the cancellation of ${task.localId}`
          : `the provider refused to cancel ${task.localId} (it may already be past the cancellable stage); it keeps running`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_export',
    description: [
      'Copy a finished artifact out of the plugin\'s own output directory into the workspace, so it can be delivered with present.',
      'Requires an absolute target path inside the workspace; refuses to overwrite an existing file unless overwrite is true.',
      'The artifact stays where it is: nothing is moved or deleted.',
    ].join(' '),
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task whose artifact should be exported.' },
      target_path: { type: 'string', required: true, description: 'Absolute destination path, e.g. /home/me/project/out/clip.mp4' },
      overwrite: { type: 'boolean', description: 'Replace an existing file. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `exported ${value.bytes} bytes to ${value.path}` }],
      presentationMeta: (_args, value) => ({ taskId: value.task_id, path: value.path, bytes: value.bytes }),
    },
    isConcurrencySafe: () => false,
    timeoutMs: 120_000,
    presentCall: args => ({ card: 'generic', title: `Export ${args.task_id}`, locations: [{ path: args.target_path }] }),
    presentResult: (_args, result) => (result.isError ? undefined : { card: 'generic', title: 'Video exported' }),

    async execute(args) {
      const task = ledger.byId(args.task_id)
      if (task === undefined) throw new ConfigError(`no video task with id "${args.task_id}"`)
      const artifact = task.artifacts[0]
      if (artifact === undefined) {
        throw new ConfigError(`${task.localId} is ${task.status} and has no artifact to export yet; check video_status`)
      }
      if (!isAbsolute(args.target_path)) {
        throw new ConfigError(`target_path must be absolute, got "${args.target_path}"`)
      }
      const existing = await stat(args.target_path).catch(() => null)
      if (existing !== null && args.overwrite !== true) {
        throw new ConfigError(`${args.target_path} already exists; pass overwrite: true to replace it`)
      }
      await mkdir(join(args.target_path, '..'), { recursive: true })
      await copyFile(artifact.path, args.target_path)
      const written = await stat(args.target_path)
      return { task_id: task.localId, path: args.target_path, bytes: written.size }
    },
  }))
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
function normaliseRequest(
  args: {
    prompt: string
    mode?: 't2v' | 'i2v' | 'flf2v' | 's2v'
    first_frame?: string
    last_frame?: string
    reference_images?: string[]
    duration_seconds?: number
    resolution?: string
    aspect_ratio?: string
  },
  mode: VideoMode,
): NormalisedRequest {
  const first = blankToNull(args.first_frame)
  const last = blankToNull(args.last_frame)
  const references = (args.reference_images ?? []).filter(value => value.trim() !== '')
  if (args.prompt.trim() === '') throw new ConfigError('prompt must not be empty')

  if (mode === 't2v') {
    if (first !== null || last !== null || references.length > 0) {
      throw new ConfigError('mode t2v takes text only; choose i2v (first_frame), flf2v (first_frame + last_frame) or s2v (reference_images) to send images')
    }
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
    prompt: args.prompt,
    mode,
    durationSeconds: args.duration_seconds ?? null,
    resolution: blankToNull(args.resolution),
    aspectRatio: blankToNull(args.aspect_ratio),
    firstFrame: first,
    lastFrame: last,
    referenceImages: references,
    descriptors: { firstFrame: null, lastFrame: null, referenceImages: [] },
  }
}

async function resolveMaterials(
  runtime: VideoForgeRuntime,
  request: NormalisedRequest,
  exec: { signal: AbortSignal; agent?: { id: string } | undefined },
): Promise<{ firstFrame: ResolvedMaterial | null; lastFrame: ResolvedMaterial | null; referenceImages: ResolvedMaterial[] }> {
  const context = { workspaceRoot: null, signal: exec.signal }
  const one = async (value: string | null, kind: 'path' | 'url'): Promise<{ resolved: ResolvedMaterial; descriptor: string } | null> => {
    if (value === null) return null
    const resolved = await resolveMaterial({ kind, value }, context)
    return { resolved, descriptor: describeMaterial({ kind, value }, resolved) }
  }

  const classify = (value: string): 'path' | 'url' => (value.startsWith('http://') || value.startsWith('https://') ? 'url' : 'path')

  const first = request.firstFrame === null ? null : await one(request.firstFrame, classify(request.firstFrame))
  const last = request.lastFrame === null ? null : await one(request.lastFrame, classify(request.lastFrame))
  const references: ResolvedMaterial[] = []
  for (const value of request.referenceImages) {
    const entry = await one(value, classify(value))
    if (entry !== null) {
      references.push(entry.resolved)
      request.descriptors.referenceImages.push(entry.descriptor)
    }
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

/** Canonical fingerprint: prompt plus the exact inputs, so different images differ. */
function fingerprintOf(providerId: string, modelId: string, request: GenerationRequest, descriptors: NormalisedRequest['descriptors']): string {
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
  throw new ConfigError(
    `an identical request is already tracked as ${existing.localId} (${existing.status}); call video_status with that id instead of re-submitting — a repeated submission is a repeated charge`,
  )
}

async function waitForTerminal(ledger: { byId(id: string): VideoTask | undefined }, localId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = ledger.byId(localId)
    if (task === undefined) return
    if (!OPEN.has(task.status)) return
    if (Date.now() >= deadline) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

function blankToNull(value: string | undefined): string | null {
  if (value === undefined) return null
  return value.trim() === '' ? null : value
}

function topLine(task: VideoTask): string {
  return describe(task).trim()
}

export { MaterialError }
