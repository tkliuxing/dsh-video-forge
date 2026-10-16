/**
 * The three model-facing tools: generate, status, cancel.
 *
 * These are adapters: the schema, the model-facing prose and the card metadata
 * live here, while every side effect — validate, de-duplicate, submit, watch,
 * cancel — belongs to `operations.ts`, shared with the panel API.
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
import { cancelTask, describeSetup, generate, listTasks, requireLedger, type SetupStatus } from './operations.ts'
import { artifactUrl, type VideoForgeRuntime } from './runtime.ts'
import { sessionContextOf } from './session-context.ts'
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
    location: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    error: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
    moderation: { required: true, oneOf: [{ type: 'null' }, { type: 'string', enum: ['input', 'output', 'unknown'] }] },
    billing: {
      required: true,
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: ['reported', 'none', 'unknown'], required: true },
            tokens: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            output_seconds: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            fields: { type: 'object', additionalProperties: true, required: true },
          },
        },
      ],
    },
  },
} as const

const STRINGS = { type: 'array', required: true, items: { type: 'string' } } as const
const NULLABLE_STRING = { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] } as const

/** `video_status` with no task id: what the model needs to know before generating. */
const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', required: true },
    default_provider: NULLABLE_STRING,
    default_model: NULLABLE_STRING,
    providers: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          protocol: { type: 'string', required: true },
          key: { type: 'string', required: true, enum: ['set', 'not required', 'missing'] },
          key_problem: NULLABLE_STRING,
          continuable: { type: 'boolean', required: true },
          models: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                modes: STRINGS,
                durations: { type: 'array', required: true, items: { type: 'number' } },
                resolutions: STRINGS,
                aspect_ratios: STRINGS,
                cancelable: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
    },
    workspace: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        state: { type: 'string', required: true, enum: ['none', 'unavailable', 'default-layout', 'manifest', 'invalid-manifest'] },
        folder: NULLABLE_STRING,
        mode: NULLABLE_STRING,
        renders: NULLABLE_STRING,
        characters: STRINGS,
        style: { type: 'boolean', required: true },
        problem: NULLABLE_STRING,
      },
    },
  },
} as const

/** The setup in the tool's snake_case vocabulary. */
function setupValue(setup: SetupStatus) {
  return {
    enabled: setup.enabled,
    default_provider: setup.defaultProvider,
    default_model: setup.defaultModel,
    providers: setup.providers.map(provider => ({
      id: provider.id,
      protocol: provider.protocol,
      key: provider.key,
      key_problem: provider.keyProblem,
      continuable: provider.continuable,
      models: provider.models.map(model => ({
        id: model.id,
        label: model.label,
        modes: [...model.modes],
        durations: [...model.durations],
        resolutions: [...model.resolutions],
        aspect_ratios: [...model.aspectRatios],
        cancelable: model.cancelable,
      })),
    })),
    workspace: { ...setup.workspace, characters: [...setup.workspace.characters] },
  }
}

/** The setup as a few lines of text. */
function setupText(setup: ReturnType<typeof setupValue>): string {
  const lines = [setup.enabled ? 'video-forge is enabled' : 'video-forge is DISABLED in its settings']
  if (setup.providers.length === 0) lines.push('no provider is configured: the user adds one under Plugins → Video Forge')
  for (const provider of setup.providers) {
    const key = provider.key === 'missing' ? `key missing (${provider.key_problem ?? 'not set'})` : `key ${provider.key}`
    const marker = provider.id === setup.default_provider ? ' (default)' : ''
    lines.push(`provider ${provider.id}${marker} [${provider.protocol}], ${key}${provider.continuable ? ', takes can be continued with from' : ''}: ${provider.models.map(model => `${model.id} (${model.modes.join('/')})`).join(', ')}`)
  }
  const workspace = setup.workspace
  if (workspace.state === 'none') lines.push('no workspace: videos stay in the plugin\'s own folder')
  else if (workspace.state === 'unavailable' || workspace.state === 'invalid-manifest') lines.push(`workspace ${workspace.folder ?? ''}: ${workspace.problem ?? workspace.state}`)
  else {
    lines.push(`workspace ${workspace.folder ?? ''} (${workspace.mode ?? 'unfenced'}): ${workspace.state === 'manifest' ? 'video-project.yaml' : 'no video-project.yaml yet (default layout)'}, renders in ${workspace.renders ?? 'renders'}/`
      + `${workspace.characters.length > 0 ? `, characters ${workspace.characters.join(', ')}` : ''}${workspace.style ? ', project style set' : ''}`)
    if (workspace.mode === 'read-only') lines.push('this conversation is read-only: generating is refused until the user allows writing')
    if (workspace.mode === 'unknown') lines.push('the host could not say which permission mode this conversation runs in: generating is refused, as if it were read-only')
  }
  return lines.join('\n')
}

/** Usage as one short phrase for the text rendering; never a price. */
function usageText(billing: { state: string; tokens: number | null; output_seconds: number | null } | null): string {
  if (billing === null) return ''
  if (billing.state === 'unknown') return 'usage unknown (provider query window closed)'
  if (billing.state === 'none') return 'no usage reported'
  if (billing.tokens !== null) return `usage ${billing.tokens} tokens`
  if (billing.output_seconds !== null) return `usage ${billing.output_seconds} s`
  return 'usage reported'
}

/** Register the three tools. */
export function registerTools(runtime: VideoForgeRuntime): void {
  const { ctx } = runtime

  ctx.tools.register(defineTool({
    name: 'video_generate',
    description: [
      'Generate a video with an online model provider.',
      'Returns immediately with a task id and a background job id; the generation continues while you work, and its completion is delivered to you as a notice. Use video_status to check on it.',
      'Inputs: prompt (required), optional provider/model, mode t2v (text only), i2v (first_frame), flf2v (first_frame + last_frame) or s2v (reference_images).',
      'A local image is a path relative to the workspace (or absolute) that already exists; verify it with the read tool first.',
      'shot names the take\'s folder under renders/. from continues an earlier take (its task id or video path): its last frame becomes the first frame and its shot carries over — only providers that return a last frame (ARK) can be continued.',
      'characters names characters registered in video-project.yaml: their descriptions are added to the prompt and their reference images are sent (mode s2v when you set no mode). The project style from video-project.yaml is added to every prompt.',
      'Never re-submit the same prompt to work around a timeout: call video_status instead. A duplicate submission inside the dedupe window is refused.',
      'The finished video is saved into the workspace as renders/<shot>/vNNN.mp4 (folders per video-project.yaml, whose defaults also fill omitted parameters), with a vNNN.json description beside it. A read-only conversation or a remote workspace is refused before anything is paid for.',
    ].join(' '),
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the video should show. Be specific about subject, motion, camera and style.' },
      provider: { type: 'string', description: 'Provider id, or `providerId::modelId`. Defaults to the configured default provider.' },
      model: { type: 'string', description: 'Model id at that provider. Defaults to the provider\'s first declared model.' },
      mode: { type: 'string', enum: ['t2v', 'i2v', 'flf2v', 's2v'], description: 'Input shape. Defaults to t2v.' },
      first_frame: { type: 'string', description: 'Image path (workspace-relative or absolute) or http(s) URL used as the first frame.' },
      last_frame: { type: 'string', description: 'Image path (workspace-relative or absolute) or http(s) URL used as the last frame (flf2v only).' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Subject/style reference images (s2v only).' },
      duration_seconds: { type: 'number', description: 'Requested length; the model\'s declared durations decide what is valid.' },
      resolution: { type: 'string', description: 'e.g. 720p, 1080p.' },
      aspect_ratio: { type: 'string', description: 'e.g. 16:9, 9:16, 1:1.' },
      shot: { type: 'string', description: 'Folder under renders/ for this take, e.g. opening or shot-03 (letters, digits, - _ .). Defaults to the continued take\'s shot, else untitled.' },
      from: { type: 'string', description: 'Continue an earlier take: its task id (v-…) or its video path (renders/<shot>/vNNN.mp4). Its last frame becomes this take\'s first frame.' },
      characters: { type: 'array', items: { type: 'string' }, description: 'Names of characters registered under characters: in video-project.yaml.' },
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
        shot: args.shot,
        from: args.from,
        characters: args.characters,
      }, {
        owner: exec.agent?.id,
        session: sessionContextOf(runtime.ctx, exec.agent),
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
      'List recent video generations with their provider, status, progress, error and (once finished) where the video is and its play URL.',
      'Without task_id it also reports the setup (setup): configured providers and whether their keys are set, their models and modes, and this workspace (manifest, renders folder, characters, permission mode) — check it before a first generation or when one is refused.',
      'This is the recovery entry point: after a timeout, a host restart, or any doubt, check here instead of submitting the prompt again.',
      'moderation is set when the provider\'s content review refused the task (input or output side): the identical request is refused again, so rewrite the prompt or change the materials rather than retrying.',
      'billing is what the provider reported a finished task consumed (tokens for ARK, output seconds for MiniMax, every raw field under fields) — usage, not money; null until settled, "unknown" when the provider\'s seven-day query window closed first.',
      'Tasks marked orphaned lost contact with the provider (credential not yet loaded, network failure, a download that broke); while the provider still answers for them — up to seven days, if the task id is known and its provider is still configured — the plugin keeps asking and settles them on its own. It never re-submits them: check back here rather than generating again, and read the error field for what is known.',
      'Tasks marked unconfirmed were sent but the provider\'s answer was lost (timeout, network failure, restart): the provider may already have created and billed them, so never submit the same request again — the error field says what is known.',
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
          setup: { required: true, oneOf: [{ type: 'null' }, SETUP_SCHEMA] },
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
        text: [
          ...(value.setup === null ? [] : [setupText(value.setup)]),
          value.tasks.length === 0
          ? 'no video tasks yet'
          : value.tasks.map(row => [
            `${row.task_id} ${row.status}${row.progress === null ? '' : ` ${Math.round(row.progress * 100)}%`}`,
            `${row.provider}/${row.model}`,
            row.location ?? '',
            row.play_url === null ? '' : row.play_url,
            usageText(row.billing),
            row.moderation === null ? '' : `refused by the provider's content review (${row.moderation})`,
            row.error ?? '',
          ].filter(part => part !== '').join(' · ')).join('\n'),
        ].join('\n\n'),
      }],
      presentationMeta: (_args, value) => ({ tasks: value.tasks }),
    },
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Video task status' }),
    presentResult: () => ({ card: 'generic', title: 'Video tasks' }),

    async execute(args, exec) {
      // Never "no tasks yet" from an unread ledger: that invites a re-submission.
      await requireLedger(runtime)
      const list = listTasks(runtime, { taskId: args.task_id, limit: args.limit ?? 10 })
      const single = args.task_id !== undefined && args.task_id !== ''
      const setup = single ? null : setupValue(await describeSetup(runtime, sessionContextOf(runtime.ctx, exec.agent), exec.signal))
      return {
        setup,
        tasks: list.tasks.map(row => ({
          task_id: row.taskId,
          provider: row.provider,
          model: row.model,
          status: row.status,
          progress: row.progress,
          submitted_at: row.submittedAt,
          play_url: row.playUrl,
          location: row.artifactLocation,
          error: row.error,
          moderation: row.moderation,
          billing: row.billing === null
            ? null
            : { state: row.billing.state, tokens: row.billing.tokens, output_seconds: row.billing.outputSeconds, fields: row.billing.fields },
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
}
