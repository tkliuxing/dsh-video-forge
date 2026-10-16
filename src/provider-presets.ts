/**
 * What this build supports, as data.
 *
 * `providers/index.ts` is the runtime's protocol table: it maps a protocol name
 * to the adapter that speaks it. This module is the same table in the form a
 * *configuration UI* needs — the short list of vendors this build can talk to
 * today, each with the base URL, credential reference and starter model it needs
 * — plus the pure draft/serialise/validate rules an editor for that list runs on.
 *
 * Two reasons it is a separate, plain module:
 *
 * - **The browser half imports it.** The configuration card has to offer real
 *   choices rather than asking an operator to type a protocol name from memory,
 *   and it must still work when the panel API is unreachable. Nothing here
 *   touches a DSH service, a `node:` builtin or an adapter, so the client bundle
 *   can inline it.
 * - **A preset is a starting point, not a closed list.** The catalog below seeds
 *   a provider row the operator then edits; the actual contract remains the
 *   protocol union in `settings.ts` and the schema in `config.ts`. Any
 *   OpenAI-Videos-shaped gateway is reachable through the `relay` preset even
 *   though it is not a named vendor here.
 */

import type { ProviderSetting } from './settings.ts'
import { VIDEO_MODES, type VideoMode } from './types.ts'

/**
 * Protocols this build speaks. The single declaration: the settings union, the
 * config schema and the protocol table all derive from this tuple, so adding a
 * vendor is one entry here plus one adapter file.
 */
export const SUPPORTED_PROTOCOLS = ['ark-seedance', 'generic-openai-videos', 'minimax-video'] as const

/** One protocol this build speaks. */
export type SupportedProtocol = (typeof SUPPORTED_PROTOCOLS)[number]

/** Compile-time guard: the settings union and this list cannot drift apart. */
type UnlistedProtocol = Exclude<ProviderSetting['protocol'], SupportedProtocol>
const _everyProtocolIsListed: [UnlistedProtocol] extends [never] ? true : never = true
void _everyProtocolIsListed

/**
 * One model a preset knows, with the capabilities its vendor documents.
 *
 * A capability list left empty means "the provider decides" in
 * `assertGeometry`. Lists are filled only from the vendor's own reference, never
 * guessed: a made-up duration is a constraint the vendor never agreed to, and it
 * would refuse requests the vendor accepts.
 */
export interface PresetModel {
  id: string
  label: string
  modes: readonly VideoMode[]
  durations: readonly number[]
  resolutions: readonly string[]
  aspectRatios: readonly string[]
  /** Ask for a synchronized audio track; true only where the model can produce one. */
  generateAudio: boolean
  /** Whether the vendor documents a cancel operation for this model. */
  cancelable: boolean
}

/** One vendor this build can talk to today, as a starting point for a provider row. */
export interface ProviderPreset {
  /** Suggested provider id; de-duplicated against the ids already in use. */
  id: string
  protocol: SupportedProtocol
  baseUrl: string
  /** Credential reference name; empty when the endpoint may run without a key. */
  authRef: string
  models: readonly PresetModel[]
}

/** Whole seconds `from`…`to`, for a vendor that documents a duration range. */
function seconds(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
}

/** Every `ratio` Seedance accepts; `adaptive` lets the model follow the input. */
const SEEDANCE_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] as const

/**
 * The Seedance models callable through `POST /contents/generations/tasks`, as
 * the 火山方舟 reference states them on 2026-10-14 ([创建视频生成任务] for the
 * per-model `resolution` / `ratio` / `duration` / `generate_audio` support and
 * [模型列表] for the ids). Console-only models (the 1.0 lite pair, Seaweed) are
 * left out because the API does not serve them.
 *
 * The two 1.0 models are marked 即将下线 ("being retired", no date given) on
 * the 模型列表 page as of 2026-10-15, and `doubao-seedance-1-0-pro-250528`
 * already answered `404 InvalidEndpointOrModel.NotFound` to an account that
 * had not activated it (where `1-0-pro-fast` still said `ModelNotOpen`). They
 * stay in the catalog — an account that has them can still call them — but
 * the label says so, so nobody picks one as a default.
 *
 * Two per-task rules cannot be expressed as a per-model list, so the vendor
 * enforces them and its error reaches the operator:
 * - Seedance 2.5 accepts only `adaptive` for first-frame / first-and-last-frame
 *   tasks (the output follows the first frame);
 * - Seedance 1.0 refuses `adaptive` for text-to-video.
 *
 * `duration: -1` ("let the model choose", 2.x only) is not listed: leaving the
 * duration unset hands the choice to the vendor's default (which is `-1` for
 * 2.5; the 2.0 reference names none) without a sentinel the configuration card would
 * have to explain.
 *
 * [创建视频生成任务]: https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
 * [模型列表]: https://docs.volcengine.com/docs/ark/model-list?lang=zh
 */
const SEEDANCE_MODELS: readonly PresetModel[] = [
  {
    id: 'doubao-seedance-2-5-260628',
    label: 'Seedance 2.5',
    modes: ['t2v', 'i2v', 'flf2v', 's2v'],
    durations: seconds(4, 30),
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: SEEDANCE_RATIOS,
    generateAudio: true,
    cancelable: true,
  },
  {
    id: 'doubao-seedance-2-0-260128',
    label: 'Seedance 2.0',
    modes: ['t2v', 'i2v', 'flf2v', 's2v'],
    durations: seconds(4, 15),
    resolutions: ['480p', '720p', '1080p', '4k'],
    aspectRatios: SEEDANCE_RATIOS,
    generateAudio: true,
    cancelable: true,
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    label: 'Seedance 2.0 Fast',
    modes: ['t2v', 'i2v', 'flf2v', 's2v'],
    durations: seconds(4, 15),
    resolutions: ['480p', '720p'],
    aspectRatios: SEEDANCE_RATIOS,
    generateAudio: true,
    cancelable: true,
  },
  {
    id: 'doubao-seedance-2-0-mini-260615',
    label: 'Seedance 2.0 Mini',
    modes: ['t2v', 'i2v', 'flf2v', 's2v'],
    durations: seconds(4, 15),
    resolutions: ['480p', '720p'],
    aspectRatios: SEEDANCE_RATIOS,
    generateAudio: true,
    cancelable: true,
  },
  {
    id: 'doubao-seedance-1-0-pro-250528',
    label: 'Seedance 1.0 Pro (retiring)',
    modes: ['t2v', 'i2v', 'flf2v'],
    durations: seconds(2, 12),
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: SEEDANCE_RATIOS,
    generateAudio: false,
    cancelable: true,
  },
  {
    id: 'doubao-seedance-1-0-pro-fast-251015',
    label: 'Seedance 1.0 Pro Fast (retiring)',
    modes: ['t2v', 'i2v'],
    durations: seconds(2, 12),
    resolutions: ['480p', '720p', '1080p'],
    aspectRatios: SEEDANCE_RATIOS,
    generateAudio: false,
    cancelable: true,
  },
]

/** Every `ratio` MiniMax accepts; text-to-video refuses `adaptive` (the adapter enforces it). */
const MINIMAX_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'] as const

/**
 * The MiniMax models served by `POST /v2/video_generation`, as the MiniMax
 * reference states them on 2026-10-15 ([创建视频生成任务]). Resolutions keep the
 * vendor's upper-case spelling because the adapter forwards them verbatim.
 *
 * Neither model documents an audio switch or a cancel operation, so
 * `generateAudio` stays false: it is a request switch, and there is none to
 * send. The output carries an AAC track regardless — every real H3-Max task on
 * 2026-10-15 came back with one. H3-Max's
 * `extra.prompt_expansion_mode` is not surfaced: the config schema has no field
 * for it yet.
 *
 * [创建视频生成任务]: https://platform.minimax.cn/docs/api-reference/video-generation-v2-create
 */
const MINIMAX_MODELS: readonly PresetModel[] = [
  {
    id: 'MiniMax-H3',
    label: 'MiniMax H3',
    modes: ['t2v', 'i2v', 'flf2v', 's2v'],
    durations: seconds(4, 15),
    resolutions: ['768P', '2K'],
    aspectRatios: MINIMAX_RATIOS,
    generateAudio: false,
    cancelable: false,
  },
  {
    id: 'MiniMax-H3-Max',
    label: 'MiniMax H3 Max',
    modes: ['t2v', 'i2v', 'flf2v', 's2v'],
    durations: seconds(5, 15),
    resolutions: ['480P', '768P'],
    aspectRatios: MINIMAX_RATIOS,
    generateAudio: false,
    cancelable: false,
  },
]

/**
 * The catalogue. Every entry is a vendor whose wire shape is implemented *and*
 * documented (DESIGN §7.1); `relay` is the honest generic entry — an
 * OpenAI-Videos-shaped gateway that may be keyless because it runs on the
 * operator's own machine. Sora's capabilities have not been checked against
 * OpenAI's reference yet, so its lists stay empty.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'ark',
    protocol: 'ark-seedance',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authRef: 'ARK_API_KEY',
    models: SEEDANCE_MODELS,
  },
  {
    id: 'openai',
    protocol: 'generic-openai-videos',
    baseUrl: 'https://api.openai.com/v1',
    authRef: 'OPENAI_API_KEY',
    models: [{ id: 'sora-2', label: '', modes: ['t2v'], durations: [], resolutions: [], aspectRatios: [], generateAudio: false, cancelable: true }],
  },
  {
    id: 'minimax',
    protocol: 'minimax-video',
    baseUrl: 'https://api.minimax.cn',
    authRef: 'MINIMAX_API_KEY',
    models: MINIMAX_MODELS,
  },
  {
    id: 'relay',
    protocol: 'generic-openai-videos',
    baseUrl: '',
    authRef: '',
    models: [],
  },
]

/** Look one preset up by id; undefined for a caller that no longer names a known one. */
export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id)
}

/** Model ids this build knows for a protocol, for a suggestion list. */
export function knownModelIds(protocol: SupportedProtocol): string[] {
  const ids = new Set<string>()
  for (const preset of PROVIDER_PRESETS) {
    if (preset.protocol !== protocol) continue
    for (const model of preset.models) ids.add(model.id)
  }
  return [...ids]
}

/** The documented capabilities of one model id under a protocol, if a preset knows it. */
export function knownModel(protocol: SupportedProtocol, id: string): PresetModel | undefined {
  for (const preset of PROVIDER_PRESETS) {
    if (preset.protocol !== protocol) continue
    const model = preset.models.find(entry => entry.id === id)
    if (model !== undefined) return model
  }
  return undefined
}

/**
 * One model as the editor holds it: the fields the form surfaces, plus whatever
 * else the row carried.
 *
 * `rest` is not laziness. The schema has more per-model fields than a form
 * should show at once (`sizes`, `pollIntervalMs`, the frame-role names), and a
 * save that silently dropped them would be a data loss the operator never asked
 * for. They are carried through untouched instead.
 */
export interface ModelDraft {
  id: string
  label: string
  modes: VideoMode[]
  durations: number[]
  resolutions: string[]
  aspectRatios: string[]
  cancelable: boolean
  generateAudio: boolean
  rest: Record<string, unknown>
}

export interface ProviderDraft {
  id: string
  protocol: SupportedProtocol
  baseUrl: string
  authRef: string
  models: ModelDraft[]
  rest: Record<string, unknown>
}

/** Why a provider list cannot be shown as a form. */
export interface DraftReadResult {
  drafts: ProviderDraft[]
  /** Set when the stored value is not a provider array at all; the JSON view is the way in. */
  problem: 'shape' | null
}

/** A configuration mistake the card refuses to write, named so the locale can word it. */
export type DraftProblem =
  | { code: 'providerIdEmpty'; index: number }
  | { code: 'providerIdDuplicate'; index: number; id: string }
  | { code: 'baseUrlEmpty'; index: number }
  | { code: 'modelIdEmpty'; index: number; modelIndex: number }
  | { code: 'modelIdDuplicate'; index: number; modelIndex: number; id: string }

const MODEL_FIELDS = new Set(['id', 'label', 'modes', 'durations', 'resolutions', 'aspectRatios', 'cancelable', 'generateAudio'])
const PROVIDER_FIELDS = new Set(['id', 'protocol', 'baseUrl', 'authRef', 'models'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function asModeList(value: unknown): VideoMode[] {
  return asStringList(value).filter((entry): entry is VideoMode => (VIDEO_MODES as readonly string[]).includes(entry))
}

/** Everything the form does not surface, so a save cannot drop it. */
function restOf(source: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) rest[key] = value
  }
  return rest
}

/**
 * Read the stored `providers` value into editable drafts.
 *
 * Coercion is defensive rather than strict: the value crosses a schema and a
 * form boundary to get here, and the card must render *something* for a row a
 * hand-edited `cordis.yml` left slightly off. Only a value that is not a
 * provider array at all is refused, because there is no honest form for it.
 */
export function readProviders(value: unknown): DraftReadResult {
  if (value === undefined || value === null) return { drafts: [], problem: null }
  if (!Array.isArray(value)) return { drafts: [], problem: 'shape' }

  const drafts: ProviderDraft[] = []
  for (const entry of value) {
    const provider = asRecord(entry)
    if (provider === null) return { drafts: [], problem: 'shape' }
    const rawModels = provider['models']
    if (rawModels !== undefined && rawModels !== null && !Array.isArray(rawModels)) return { drafts: [], problem: 'shape' }

    const models: ModelDraft[] = []
    for (const rawModel of asArray(rawModels)) {
      const model = asRecord(rawModel)
      if (model === null) return { drafts: [], problem: 'shape' }
      models.push({
        id: asString(model['id']),
        label: asString(model['label']),
        modes: asModeList(model['modes']),
        durations: asNumberList(model['durations']),
        resolutions: asStringList(model['resolutions']),
        aspectRatios: asStringList(model['aspectRatios']),
        cancelable: asBoolean(model['cancelable'], true),
        generateAudio: asBoolean(model['generateAudio'], false),
        rest: restOf(model, MODEL_FIELDS),
      })
    }

    const protocol = asString(provider['protocol'])
    drafts.push({
      id: asString(provider['id']),
      // Unknown protocols cannot reach a parsed config (the schema is a union),
      // so the fallback only covers a value read before the schema ran.
      protocol: (SUPPORTED_PROTOCOLS as readonly string[]).includes(protocol)
        ? protocol as SupportedProtocol
        : SUPPORTED_PROTOCOLS[0],
      baseUrl: asString(provider['baseUrl']),
      authRef: asString(provider['authRef']),
      models,
      rest: restOf(provider, PROVIDER_FIELDS),
    })
  }
  return { drafts, problem: null }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** One model row back in config shape. */
export function serializeModel(draft: ModelDraft): Record<string, unknown> {
  return {
    ...draft.rest,
    id: draft.id,
    label: draft.label,
    modes: [...draft.modes],
    durations: [...draft.durations],
    resolutions: [...draft.resolutions],
    aspectRatios: [...draft.aspectRatios],
    cancelable: draft.cancelable,
    generateAudio: draft.generateAudio,
  }
}

/** One provider row back in config shape. */
export function serializeProvider(draft: ProviderDraft): Record<string, unknown> {
  return {
    ...draft.rest,
    id: draft.id,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    authRef: draft.authRef,
    models: draft.models.map(serializeModel),
  }
}

/** An empty model row, so "add a model" is one click rather than a JSON edit. */
export function newModel(id = ''): ModelDraft {
  return {
    id,
    label: '',
    modes: ['t2v'],
    durations: [],
    resolutions: [],
    aspectRatios: [],
    cancelable: true,
    generateAudio: false,
    rest: {},
  }
}

/** A model row carrying a preset model's documented capabilities. */
export function modelFromPreset(model: PresetModel): ModelDraft {
  return {
    ...newModel(model.id),
    label: model.label,
    modes: [...model.modes],
    durations: [...model.durations],
    resolutions: [...model.resolutions],
    aspectRatios: [...model.aspectRatios],
    generateAudio: model.generateAudio,
    cancelable: model.cancelable,
  }
}

/** Append `-2`, `-3`, … until an id is free: two relays are a normal configuration. */
export function uniqueId(existing: readonly string[], wanted: string): string {
  const taken = new Set(existing)
  if (!taken.has(wanted)) return wanted
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${wanted}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${wanted}-${Date.now()}`
}

/** A provider row pre-filled from a preset, with an id that does not collide. */
export function providerFromPreset(preset: ProviderPreset, existingIds: readonly string[]): ProviderDraft {
  return {
    id: uniqueId(existingIds, preset.id),
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    authRef: preset.authRef,
    models: preset.models.map(modelFromPreset),
    rest: {},
  }
}

/**
 * The first reason this list must not be written, or null when it is writable.
 *
 * The card checks this before saving, so a mistake reads as a sentence about
 * the exact field. The host schema still validates afterwards: this is a
 * courtesy, not the gate.
 */
export function validateDrafts(drafts: readonly ProviderDraft[]): DraftProblem | null {
  const seen = new Set<string>()
  for (const [index, draft] of drafts.entries()) {
    const id = draft.id.trim()
    if (id === '') return { code: 'providerIdEmpty', index }
    if (seen.has(id)) return { code: 'providerIdDuplicate', index, id }
    seen.add(id)
    if (draft.baseUrl.trim() === '') return { code: 'baseUrlEmpty', index }

    const models = new Set<string>()
    for (const [modelIndex, model] of draft.models.entries()) {
      const modelId = model.id.trim()
      if (modelId === '') return { code: 'modelIdEmpty', index, modelIndex }
      if (models.has(modelId)) return { code: 'modelIdDuplicate', index, modelIndex, id: modelId }
      models.add(modelId)
    }
  }
  return null
}

/** Every credential reference a provider list declares, de-duplicated, in order. */
export function authRefs(drafts: readonly ProviderDraft[]): string[] {
  const refs = new Set<string>()
  for (const draft of drafts) {
    const ref = draft.authRef.trim()
    if (ref !== '') refs.add(ref)
  }
  return [...refs]
}

/** Parse a comma-separated number list, ignoring blanks and non-numbers. */
export function parseNumberList(text: string): number[] {
  return text
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
    .map(Number)
    .filter(value => Number.isFinite(value))
}

/** Parse a comma-separated string list, ignoring blanks. */
export function parseStringList(text: string): string[] {
  return text.split(',').map(part => part.trim()).filter(part => part !== '')
}
