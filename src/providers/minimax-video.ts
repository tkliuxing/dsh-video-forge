/**
 * MiniMax 视频生成 V2 — `POST {base}/v2/video_generation`, then
 * `GET {base}/v2/query/video_generation/{task_id}`.
 *
 * Shapes verified against the official docs on 2026-10-15 (DESIGN §7.1). The
 * create body is Seedance's `content[]` with the same role names, so the content
 * builder is shared; everything around it differs — the id is `task_id`, the
 * query body nests under `task`, the result is `task.content.url`, the watermark
 * switch is `aigc_watermark`, and there is no cancel operation.
 *
 * Unlike ARK, `resolution` and `duration` are required, and a text-only task must
 * name a concrete `ratio`. Those are refused here, before the paid call, rather
 * than filled with a guess: the vendor documents no default to fall back on.
 */

import { readPath, readString } from './dot-path.ts'
import { ConfigError } from '../settings.ts'
import type { GenerationRequest, ProviderTaskState } from '../types.ts'
import { buildArkContent, type ArkRoles } from './ark-seedance.ts'
import {
  excerpt,
  normalizeStatus,
  ProviderRequestError,
  requestJson,
  type AdapterContext,
  type ProtocolAdapter,
  taskError,
  usageOf,
} from './adapter.ts'

/** The five words the query and callback bodies use, and nothing else. */
const STATUS_TABLE = {
  queued: ['queued'],
  running: ['running'],
  succeeded: ['succeeded'],
  failed: ['failed'],
  cancelled: ['cancelled'],
} as const

export interface MinimaxVideoOptions {
  /** Role names inside `content[]`; MiniMax documents the same three as Seedance. */
  roles: ArkRoles
  /** Ask for the provider's AIGC watermark; the plugin never adds one by default. */
  watermark: boolean
}

/** Body of one create request; exported so tests can pin the shape without a network. */
export function buildMinimaxBody(request: GenerationRequest, options: MinimaxVideoOptions): Record<string, unknown> {
  if (request.durationSeconds === null) {
    throw new ConfigError(`model "${request.model}" requires duration_seconds; MiniMax documents no default`)
  }
  if (request.resolution === null) {
    throw new ConfigError(`model "${request.model}" requires resolution; MiniMax documents no default`)
  }
  // Frame tasks follow the input image, so their ratio is ignored; a text-only
  // task has no image to follow and is refused without a concrete ratio.
  if (request.mode === 't2v' && (request.aspectRatio === null || request.aspectRatio === 'adaptive')) {
    throw new ConfigError(`model "${request.model}" needs a concrete aspect_ratio for text-to-video (adaptive is refused)`)
  }

  const body: Record<string, unknown> = {
    model: request.model,
    content: buildArkContent(request, options.roles),
    resolution: request.resolution,
    duration: request.durationSeconds,
    aigc_watermark: options.watermark,
  }
  if (request.aspectRatio !== null) body.ratio = request.aspectRatio
  return body
}

/** Read one query response into provider-neutral state. */
export function readMinimaxState(body: unknown): ProviderTaskState {
  const raw = readString(body, 'task.status')
  const normalized = normalizeStatus(raw, STATUS_TABLE)
  const errorObject = readPath(body, 'task.error')
  const errorMessage = readString(errorObject, 'message')
  const errorCode = readString(errorObject, 'code')
  return {
    status: normalized.status,
    // The query body has no progress field.
    progress: null,
    videoUrl: readString(body, 'task.content.url'),
    error: normalized.status === 'failed'
      ? taskError('minimax-video', errorMessage ?? `task reported status "${raw ?? 'unknown'}"`, errorCode)
      : null,
    terminal: normalized.terminal,
    // Billed by output seconds; the documented token fields were absent in real answers.
    usage: usageOf(readPath(body, 'task.usage'), { outputSeconds: 'output_seconds' }),
  }
}

/**
 * `base_resp` codes that refuse a request before any work starts, per the MiniMax
 * error-code reference (2026-10-15): rate and connection limits (1002, 1041,
 * 2045, 2056), authentication (1004, 2049), balance (1008), content review
 * (1026, 1027), token limit (1039), invalid characters (1042), parameters
 * (2013). Anything else — 1000 unknown, 1001 timeout, 1024 internal, 1033
 * downstream — says nothing about whether a task exists.
 */
const FINAL_REFUSALS: ReadonlySet<number> = new Set([1002, 1004, 1008, 1026, 1027, 1039, 1041, 1042, 2013, 2045, 2049, 2056])

export function minimaxVideoAdapter(options: MinimaxVideoOptions): ProtocolAdapter {
  return {
    id: 'minimax-video',
    cancelable: false,

    async submit(context: AdapterContext, request: GenerationRequest) {
      const body = buildMinimaxBody(request, options)
      const response = await requestJson(context, `${trimSlash(context.baseUrl)}/v2/video_generation`, { method: 'POST', body })
      const id = readString(response, 'task_id')
      if (id === null || id === '') {
        // MiniMax's older endpoints answer an error as HTTP 200 with a non-zero
        // base_resp and no id. A code that refuses the request outright (auth,
        // balance, limits, parameters, content review) is a verdict: report it
        // as a refusal (status 400), so the row is `failed` and tagged when it is
        // a review. A timeout or internal error may have come after the task was
        // created, so it keeps no status and the row stays `unconfirmed`, as a
        // 502/504 does — never "not submitted", which would invite a second charge.
        const raw = readPath(response, 'base_resp.status_code')
        const statusCode = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null)
        const statusMessage = readString(response, 'base_resp.status_msg')
        if (statusCode !== null && statusCode !== 0) {
          throw new ProviderRequestError(`minimax-video: the provider answered ${statusCode} — ${statusMessage ?? 'no message'} without a task_id`, {
            status: FINAL_REFUSALS.has(statusCode) ? 400 : null,
            bodyExcerpt: excerpt(JSON.stringify(response)),
            providerCode: String(statusCode),
            providerMessage: statusMessage,
          })
        }
        throw new ProviderRequestError('minimax-video: the create response carried no task_id', {
          bodyExcerpt: excerpt(JSON.stringify(response ?? null)),
        })
      }
      return { providerTaskId: id }
    },

    async query(context: AdapterContext, providerTaskId: string) {
      const response = await requestJson(
        context,
        `${trimSlash(context.baseUrl)}/v2/query/video_generation/${encodeURIComponent(providerTaskId)}`,
        { method: 'GET' },
      )
      return readMinimaxState(response)
    },

    async cancel() {
      // No cancel operation is documented; `cancelled` only appears as a status.
      return false
    },
  }
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
