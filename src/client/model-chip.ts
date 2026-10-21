/**
 * The composer chip's pure half (M6, DESIGN §20): what a stored selection means
 * against the models that are configured *right now*.
 *
 * All of the judgement about stale choices lives here, away from the DOM, so it
 * can be tested without a browser:
 *
 * - a selection pointing at a model that is no longer configured is *shown* as
 *   unavailable, never quietly replaced — the host would refuse the generation
 *   and name the chip, and a silent swap would be a worse lie;
 * - the values a parameter may offer come from the chosen model's own
 *   declarations, or from the union of every configured model when the chip has
 *   not chosen one yet;
 * - picking another model drops the values that model does not declare, and
 *   reports what it dropped so the chip can say so.
 */

import type { Translate } from './locales.ts'
import type { ChipModel, ChipProvider, ChipSelection } from './panel-api.ts'

/** A selection that chooses nothing: the arguments, manifest and settings decide. */
export const EMPTY_CHIP_SELECTION: ChipSelection = {
  provider: null,
  model: null,
  durationSeconds: null,
  resolution: null,
  aspectRatio: null,
}

/** The three parameters the chip may carry (DESIGN §20: `mode` is decided by the materials, not here). */
export type ParamKey = 'durationSeconds' | 'resolution' | 'aspectRatio'

export const PARAM_KEYS: readonly ParamKey[] = ['durationSeconds', 'resolution', 'aspectRatio']

/** Every parameter rendered with one value type, so a list mixes numbers and strings. */
export type ParamValue = string | number

/** What a selection points at, resolved against the current configuration. */
export interface ChipTarget {
  provider: ChipProvider | null
  model: ChipModel | null
  /** `provider`: the provider is gone from the settings; `model`: the provider stayed, the model did not. */
  missing: 'provider' | 'model' | null
}

/** One option in the model list, with the provider it belongs to. */
export interface ModelOption {
  provider: ChipProvider
  model: ChipModel
}

/** Resolve a selection against the configured providers. */
export function targetOf(selection: ChipSelection | null, providers: readonly ChipProvider[]): ChipTarget {
  if (selection === null || selection.provider === null) return { provider: null, model: null, missing: null }
  const provider = providers.find(entry => entry.id === selection.provider) ?? null
  if (provider === null) return { provider: null, model: null, missing: 'provider' }
  if (selection.model === null) return { provider, model: null, missing: null }
  const model = provider.models.find(entry => entry.id === selection.model) ?? null
  return { provider, model, missing: model === null ? 'model' : null }
}

/** Every model the chip can offer, in configuration order. */
export function modelOptions(providers: readonly ChipProvider[]): ModelOption[] {
  return providers.flatMap(provider => provider.models.map(model => ({ provider, model })))
}

/** The values one model declares for one parameter; empty means "the provider decides". */
export function declaredValues(model: ChipModel | null, key: ParamKey): readonly ParamValue[] {
  if (model === null) return []
  if (key === 'durationSeconds') return [...model.durations]
  if (key === 'resolution') return [...model.resolutions]
  return [...model.aspectRatios]
}

/**
 * The values to offer for one parameter: the chosen model's declarations, or —
 * while no model is chosen — the union across every configured model, since the
 * eventual model is whichever the manifest or settings name.
 */
export function paramValues(
  providers: readonly ChipProvider[],
  target: ChipTarget,
  key: ParamKey,
): { values: readonly ParamValue[]; scope: 'model' | 'union' } {
  if (target.model !== null) return { values: declaredValues(target.model, key), scope: 'model' }
  const seen = new Set<string>()
  const values: ParamValue[] = []
  for (const { model } of modelOptions(providers)) {
    for (const value of declaredValues(model, key)) {
      const id = String(value)
      if (seen.has(id)) continue
      seen.add(id)
      values.push(value)
    }
  }
  return { values, scope: 'union' }
}

/**
 * Drop the parameters the newly chosen model does not declare.
 *
 * A model that declares *nothing* for a parameter counts as "does not declare
 * it": the chip offers no value for that parameter under such a model, so a
 * value left in place would be active while the menu shows nothing selected —
 * the one failure mode a chip must not have. The operator can still pass the
 * argument in the conversation, which the tool reports by name.
 */
export function pruneSelection(selection: ChipSelection, model: ChipModel): { selection: ChipSelection; dropped: ParamKey[] } {
  const next: ChipSelection = { ...selection }
  const dropped: ParamKey[] = []
  for (const key of PARAM_KEYS) {
    const value = next[key]
    if (value === null) continue
    const declared = declaredValues(model, key)
    if (declared.some(entry => String(entry) === String(value))) continue
    next[key] = null
    dropped.push(key)
  }
  return { selection: next, dropped }
}

/** One parameter's value as it reads on a button: `5s`, `720p`, `16:9`. */
export function paramText(key: ParamKey, value: ParamValue): string {
  return key === 'durationSeconds' ? `${String(value)}s` : String(value)
}

/** The parameter's name, for a group heading and for the "cleared" sentence. */
export function paramLabel(key: ParamKey, t: Translate): string {
  if (key === 'durationSeconds') return t('chip.duration')
  if (key === 'resolution') return t('chip.resolution')
  return t('chip.aspect')
}

/** The geometry a selection carries, joined for the trigger's trailing text (empty when it carries none). */
export function geometrySummary(selection: ChipSelection | null): string {
  if (selection === null) return ''
  return PARAM_KEYS
    .map(key => (selection[key] === null ? null : paramText(key, selection[key] as ParamValue)))
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** Why a chosen model cannot be used, or null when nothing is wrong with it. */
export type ChipWarning = 'unavailable' | 'key' | null

/** What the trigger shows, and whether it must carry a warning marker. */
export function chipLabel(selection: ChipSelection | null, target: ChipTarget): { text: string; warning: ChipWarning } {
  if (target.missing !== null) return { text: selection?.model ?? selection?.provider ?? '', warning: 'unavailable' }
  if (target.model !== null) {
    const provider = target.provider
    const missingKey = provider !== null && !provider.credential.configured
    return { text: target.model.label === '' ? target.model.id : target.model.label, warning: missingKey ? 'key' : null }
  }
  if (target.provider !== null) return { text: target.provider.id, warning: target.provider.credential.configured ? null : 'key' }
  return { text: '', warning: null }
}

/** The provider/model a settings default names, for the "auto" row's subtitle; null when it does not resolve. */
export function settingsTarget(defaults: { provider: string; model: string }, providers: readonly ChipProvider[]): ModelOption | null {
  if (defaults.provider === '') return null
  const provider = providers.find(entry => entry.id === defaults.provider)
  if (provider === undefined) return null
  const model = defaults.model === ''
    ? provider.models[0] ?? null
    : provider.models.find(entry => entry.id === defaults.model) ?? null
  return model === null ? null : { provider, model }
}

/** Whether a chosen model would be refused for a missing key, which the trigger and the row both mark. */
export function keyMissing(provider: ChipProvider | null): boolean {
  return provider !== null && !provider.credential.configured
}
