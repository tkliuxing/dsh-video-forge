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
 *   and it must still work when the workbench API is unreachable. Nothing here
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
export const SUPPORTED_PROTOCOLS = ['ark-seedance', 'generic-openai-videos'] as const

/** One protocol this build speaks. */
export type SupportedProtocol = (typeof SUPPORTED_PROTOCOLS)[number]

/** Compile-time guard: the settings union and this list cannot drift apart. */
type UnlistedProtocol = Exclude<ProviderSetting['protocol'], SupportedProtocol>
const _everyProtocolIsListed: [UnlistedProtocol] extends [never] ? true : never = true
void _everyProtocolIsListed

/** One vendor this build can talk to today, as a starting point for a provider row. */
export interface ProviderPreset {
  /** Suggested provider id; de-duplicated against the ids already in use. */
  id: string
  protocol: SupportedProtocol
  baseUrl: string
  /** Credential reference name; empty when the endpoint may run without a key. */
  authRef: string
  /**
   * Model ids worth starting with. Capability lists are left empty on purpose:
   * empty means "the provider decides" in `assertGeometry`, and inventing
   * durations or resolutions a vendor may not accept would be worse than
   * shipping none.
   */
  models: readonly { id: string; modes: readonly VideoMode[] }[]
}

/**
 * The catalogue. Every entry is a vendor whose wire shape is implemented *and*
 * documented (DESIGN §7.1); `relay` is the honest generic entry — an
 * OpenAI-Videos-shaped gateway that may be keyless because it runs on the
 * operator's own machine.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'ark',
    protocol: 'ark-seedance',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authRef: 'ARK_API_KEY',
    models: [{ id: 'doubao-seedance-1-0-pro-250528', modes: ['t2v', 'i2v', 'flf2v'] }],
  },
  {
    id: 'openai',
    protocol: 'generic-openai-videos',
    baseUrl: 'https://api.openai.com/v1',
    authRef: 'OPENAI_API_KEY',
    models: [{ id: 'sora-2', modes: ['t2v'] }],
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
    models: preset.models.map(model => ({ ...newModel(model.id), modes: [...model.modes] })),
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
