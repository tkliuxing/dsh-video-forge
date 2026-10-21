/**
 * Plain settings types, defaults, and the pure resolution rules the runtime and
 * the tools share: which provider a call lands on, whether a model accepts the
 * requested mode and geometry, and which credential reference to read.
 *
 * Nothing here touches a DSH service, so every rule below is unit-testable.
 */

import type { PriceSourceInfo, PriceTable } from './prices.ts'
import type { SupportedProtocol } from './provider-presets.ts'
import type { VideoMode } from './types.ts'

/** Directory name under `$DSH_HOME` for the ledger, artifacts and quarantine files. */
export const HOME_DIRECTORY = 'dsh-video-forge'

/** Route prefix for the token-gated media family. */
export const MEDIA_ROUTE_PREFIX = '/video-forge/media'

export interface EndpointSetting {
  submit: string
  query: string
  content: string
  cancel: string
  idPath: string
  statusPath: string
  progressPath: string
  resultUrlPath: string
  errorPath: string
  /** Comma-separated status words, because a relay's vocabulary is not knowable ahead of time. */
  statusQueued: string
  statusRunning: string
  statusSucceeded: string
  statusFailed: string
  statusCancelled: string
}

/**
 * Defaults for the OpenAI-Videos-shaped family. `{id}` is substituted with the
 * provider task id. The paths are deliberately the OpenAI wire names — a relay
 * that differs gets a per-provider override instead of a code change.
 */
export const DEFAULT_ENDPOINTS: EndpointSetting = {
  submit: '/videos',
  query: '/videos/{id}',
  content: '/videos/{id}/content',
  cancel: '/videos/{id}',
  idPath: 'id',
  statusPath: 'status',
  progressPath: 'progress',
  resultUrlPath: 'url',
  errorPath: 'error.message',
  statusQueued: 'queued,pending',
  statusRunning: 'running,in_progress,processing,generating',
  statusSucceeded: 'succeeded,success,completed,complete',
  statusFailed: 'failed,error,expired',
  statusCancelled: 'cancelled,canceled',
}

export interface ModelSetting {
  id: string
  label: string
  // Declared lists are read-only: they come from the config schema, and nothing
  // downstream should mutate what the operator typed.
  modes: readonly VideoMode[]
  durations: readonly number[]
  resolutions: readonly string[]
  aspectRatios: readonly string[]
  sizes: readonly string[]
  cancelable: boolean
  generateAudio: boolean
  pollIntervalMs: number
  frameRoleFirst: string
  frameRoleLast: string
  frameRoleReference: string
}

export interface ProviderSetting {
  id: string
  protocol: SupportedProtocol
  baseUrl: string
  /** Credential reference; empty means the endpoint needs no key. */
  authRef: string
  models: readonly ModelSetting[]
  endpoints: EndpointSetting
}

export interface VideoForgeSettings {
  enabled: boolean
  providers: readonly ProviderSetting[]
  defaultProvider: string
  defaultModel: string
  outputDir: string
  pollIntervalMs: number
  waitSecondsMax: number
  dedupeWindowSeconds: number
  maxConcurrent: number
  maxTasks: number
  maxGiB: number
  requestTimeoutMs: number
  /** The price table used to turn usage into an estimate (never the bill). */
  priceTable: PriceTable
  /**
   * Where {@link priceTable} comes from (DESIGN §21): the configured feed, the
   * refresh interval, and the provenance of the layer that answered. Absent in
   * a reduced composition (and in tests), where prices are local only.
   */
  priceSource?: {
    url: string
    refreshHours: number
    info: PriceSourceInfo
  }
}

/** A configuration problem the model can act on: it names the exact field to fix. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Split a comma-separated status word list into lowercase words. */
export function statusWords(value: string): string[] {
  return value.split(',').map(word => word.trim().toLowerCase()).filter(word => word !== '')
}

/**
 * Resolve which provider and model a call uses.
 *
 * `providerId::modelId` is accepted in either parameter, mirroring the
 * reference format the rest of the ecosystem uses. Ambiguity is an error rather
 * than a silent fallback: submitting to the wrong endpoint costs money.
 */
export function resolveTarget(
  settings: VideoForgeSettings,
  providerId: string | null,
  modelId: string | null,
): { provider: ProviderSetting; model: ModelSetting } {
  let wantedProvider = providerId
  let wantedModel = modelId
  if (wantedProvider !== null && wantedProvider.includes('::')) {
    const parts = wantedProvider.split('::')
    const head = parts[0] ?? ''
    const tail = parts[1] ?? ''
    wantedProvider = head === '' ? null : head
    if (wantedModel === null && tail !== '') wantedModel = tail
  }

  const provider = wantedProvider !== null && wantedProvider !== ''
    ? settings.providers.find(entry => entry.id === wantedProvider)
    : settings.providers.find(entry => entry.id === settings.defaultProvider) ?? settings.providers[0]

  if (provider === undefined) {
    const known = settings.providers.map(entry => entry.id).join(', ')
    throw new ConfigError(wantedProvider === null || wantedProvider === ''
      ? 'video-forge has no providers configured; add one under the plugin\'s settings (providers[])'
      : `unknown provider "${wantedProvider}"; configured providers: ${known === '' ? '(none)' : known}`)
  }

  const wanted = wantedModel !== null && wantedModel !== ''
    ? wantedModel
    : (settings.defaultProvider === provider.id && settings.defaultModel !== '' ? settings.defaultModel : '')
  const model = wanted !== ''
    ? provider.models.find(entry => entry.id === wanted)
    : provider.models[0]

  if (model === undefined) {
    const known = provider.models.map(entry => entry.id).join(', ')
    throw new ConfigError(wanted === ''
      ? `provider "${provider.id}" declares no models; add one under providers[].models`
      : `provider "${provider.id}" does not declare model "${wanted}"; declared models: ${known === '' ? '(none)' : known}`)
  }
  return { provider, model }
}

/** True when the model's declared mode list admits this input shape. */
export function supportsMode(model: ModelSetting, mode: VideoMode): boolean {
  return model.modes.includes(mode)
}

/** Check a requested geometry against what the model declares. Empty lists mean "provider default". */
export function assertGeometry(model: ModelSetting, request: { durationSeconds: number | null; resolution: string | null; aspectRatio: string | null }): void {
  if (request.durationSeconds !== null && model.durations.length > 0 && !model.durations.includes(request.durationSeconds)) {
    throw new ConfigError(`model "${model.id}" allows durations ${model.durations.join('/')} seconds, got ${request.durationSeconds}`)
  }
  if (request.resolution !== null && model.resolutions.length > 0 && !model.resolutions.includes(request.resolution)) {
    throw new ConfigError(`model "${model.id}" allows resolutions ${model.resolutions.join('/')}, got ${request.resolution}`)
  }
  if (request.aspectRatio !== null && model.aspectRatios.length > 0 && !model.aspectRatios.includes(request.aspectRatio)) {
    throw new ConfigError(`model "${model.id}" allows aspect ratios ${model.aspectRatios.join('/')}, got ${request.aspectRatio}`)
  }
}

/** Common pixel geometry, used to render `WxH` for providers that take a literal size. */
const GEOMETRY: Record<string, Record<string, string>> = {
  '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '480x480' },
  '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x720' },
  '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080' },
}

/**
 * Render the `WxH` a size-taking provider wants. Returns null when the model
 * declares no size and the request names none either, which is a legitimate
 * "let the provider decide".
 */
export function resolveSize(model: ModelSetting, resolution: string | null, aspectRatio: string | null): string | null {
  if (model.sizes.length === 0) return null
  if (resolution !== null && aspectRatio !== null) {
    const candidate = GEOMETRY[resolution]?.[aspectRatio]
    if (candidate !== undefined && model.sizes.includes(candidate)) return candidate
  }
  if (model.sizes.length === 1) return model.sizes[0] ?? null
  const declared = model.sizes.join(', ')
  throw new ConfigError(`model "${model.id}" needs an unambiguous size; requested resolution/aspect ratio did not map to one of ${declared}`)
}

/** Whether a reference looks like it needs no credential (a gateway on this machine). */
export function isLoopback(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Environment variable fallback name for a provider: `<ID>_API_KEY`, upper-cased
 * with non-alphanumerics collapsed to `_`. This is the third and last layer of
 * the credential order in DESIGN §8.
 */
export function environmentFallbackName(providerId: string): string {
  const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `${normalized === '' ? 'VIDEO' : normalized}_API_KEY`
}
