/**
 * The four model-facing tools.
 *
 * These are adapters: the schema, the model-facing prose and the card metadata
 * live here, while every side effect — validate, de-duplicate, submit, watch,
 * cancel, export — belongs to `operations.ts`, shared with the workbench panel.
 * Two implementations of a paid side effect drift, and the one that drifts is
 * always the quieter one.
 *
 * Contract notes (DESIGN §4, docs/cookbook/adding-a-tool.md):
 *
 * - `execute` returns exactly one canonical JSON value; `output.render` owns the
 *   prose a model reads, and `output.presentationMeta` owns the bounded facts the
 *   browser card needs. Presenters are pure functions of `args` (+ the value) —
 *   they also run on session replay, so they must not read the ledger, the clock,
 *   or the filesystem.
 * - Every tool reads the config snapshot per call, so a live settings edit takes
 *   effect on the next call with no re-registration.
 * - "Check, never re-submit": `video_status` is the recovery entry point, and a
 *   duplicate submission inside the dedupe window is refused in the operations
 *   layer rather than trusted to the model's judgement.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { cancelTask, exportArtifact, generate, listTasks } from './operations.ts'
import { artifactUrl, type VideoForgeRuntime } from './runtime.ts'
import type { VideoMode } from './types.ts'

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
  const { ctx } = runtime

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
      const outcome = await generate(runtime, {
        prompt: args.prompt,
        provider: args.provider,
        model: args.model,
        mode: args.mode as VideoMode | undefined,
        firstFrame: args.first_frame,
        lastFrame: args.last_frame,
        referenceImages: args.reference_images,
        durationSeconds: args.duration_seconds ?? null,
        resolution: args.resolution,
        aspectRatio: args.aspect_ratio,
      }, {
        owner: exec.agent?.id,
        signal: exec.signal,
        waitSeconds: args.wait_seconds ?? 0,
      })

      const artifact = outcome.artifact
      return {
        kind: outcome.kind,
        task_id: outcome.task.localId,
        provider: outcome.task.provider,
        model: outcome.task.model,
        status: outcome.task.status,
        progress: outcome.task.progress,
        job_id: outcome.jobId,
        artifact: artifact === null
          ? null
          : {
            path: artifact.path,
            url: artifactUrl(outcome.task, artifact),
            mime: artifact.mime,
            bytes: artifact.bytes,
          },
        message: outcome.message,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_status',
    description: [
      'List recent video generations with their provider, status, progress, error and (once finished) the artifact path and play URL.',
      'This is the recovery entry point: after a timeout, a host restart, or any doubt, check here instead of submitting the prompt again.',
      'Tasks marked orphaned belonged to a previous process and could not be reconciled with the provider; they are never re-submitted automatically.',
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
      const list = listTasks(runtime, { taskId: args.task_id, limit: args.limit ?? 10 })
      return {
        tasks: list.tasks.map(row => ({
          task_id: row.taskId,
          provider: row.provider,
          model: row.model,
          status: row.status,
          progress: row.progress,
          submitted_at: row.submittedAt,
          play_url: row.playUrl,
          error: row.error,
        })),
        usage: {
          tasks: list.usage.tasks,
          bytes: list.usage.bytes,
          over_task_limit: list.usage.overTaskLimit,
          over_byte_limit: list.usage.overByteLimit,
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
      const outcome = await cancelTask(runtime, args.task_id, { signal: exec.signal })
      return {
        task_id: outcome.taskId,
        cancelled: outcome.cancelled,
        provider_supported: outcome.providerSupported,
        status: outcome.status,
        message: outcome.message,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_export',
    description: [
      'Copy a finished artifact out of the plugin\'s own output directory into the workspace, so it can be delivered with present.',
      'Requires an absolute target path; refuses to overwrite an existing file unless overwrite is true.',
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
      const outcome = await exportArtifact(runtime, args.task_id, args.target_path, args.overwrite === true)
      return { task_id: outcome.taskId, path: outcome.path, bytes: outcome.bytes }
    },
  }))
}
