/**
 * The chip's pure rules (M6, DESIGN §20), tested without a browser.
 *
 * These are the decisions the operator cannot see being made: what a selection
 * means when the settings changed underneath it, which values a parameter may
 * offer, and what is dropped when the model changes. The rendered behaviour is
 * covered in `client-model-chip.test.tsx`.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_CHIP_SELECTION,
  chipLabel,
  declaredValues,
  geometrySummary,
  modelOptions,
  paramText,
  paramValues,
  pruneSelection,
  settingsTarget,
  targetOf,
  type ParamKey,
} from '../src/client/model-chip.ts'
import type { ChipModel, ChipProvider, ChipSelection } from '../src/client/panel-api.ts'

const SEEDANCE: ChipModel = {
  id: 'seedance-2',
  label: 'Seedance 2.0',
  modes: ['t2v'],
  durations: [5, 10],
  resolutions: ['720p', '1080p'],
  aspectRatios: ['16:9', '9:16'],
  cancelable: true,
}

const NO_DECLARATIONS: ChipModel = {
  id: 'opaque',
  label: '',
  modes: ['t2v'],
  durations: [],
  resolutions: [],
  aspectRatios: [],
  cancelable: false,
}

const ARK: ChipProvider = {
  id: 'ark',
  protocol: 'ark-seedance',
  credential: { configured: true, masked: 'sk…1234', error: null },
  models: [SEEDANCE, NO_DECLARATIONS],
}

const MINIMAX: ChipProvider = {
  id: 'minimax',
  protocol: 'minimax-video',
  credential: { configured: false, masked: null, error: null },
  models: [{ ...SEEDANCE, id: 'hailuo', label: 'Hailuo', durations: [6], resolutions: [], aspectRatios: [] }],
}

const PROVIDERS = [ARK, MINIMAX]

const selection = (over: Partial<ChipSelection> = {}): ChipSelection => ({ ...EMPTY_CHIP_SELECTION, provider: 'ark', model: 'seedance-2', ...over })

describe('resolving a stored choice', () => {
  it('finds the model it names', () => {
    const target = targetOf(selection(), PROVIDERS)
    expect(target.provider?.id).toBe('ark')
    expect(target.model?.id).toBe('seedance-2')
    expect(target.missing).toBeNull()
  })

  it('reports a vanished provider and a vanished model separately', () => {
    expect(targetOf(selection({ provider: 'gone' }), PROVIDERS)).toMatchObject({ provider: null, model: null, missing: 'provider' })
    expect(targetOf(selection({ model: 'gone' }), PROVIDERS)).toMatchObject({ provider: ARK, model: null, missing: 'model' })
  })

  it('treats "no choice" as auto rather than as an error', () => {
    expect(targetOf(null, PROVIDERS)).toEqual({ provider: null, model: null, missing: null })
    expect(targetOf({ ...EMPTY_CHIP_SELECTION }, PROVIDERS)).toEqual({ provider: null, model: null, missing: null })
  })

  it('offers the trigger a name and a warning marker', () => {
    expect(chipLabel(selection(), targetOf(selection(), PROVIDERS))).toEqual({ text: 'Seedance 2.0', warning: null })
    expect(chipLabel(selection({ provider: 'minimax', model: 'hailuo' }), targetOf(selection({ provider: 'minimax', model: 'hailuo' }), PROVIDERS))).toEqual({ text: 'Hailuo', warning: 'key' })
    expect(chipLabel(selection({ model: 'gone' }), targetOf(selection({ model: 'gone' }), PROVIDERS))).toEqual({ text: 'gone', warning: 'unavailable' })
    // An unlabelled model falls back to its id.
    expect(chipLabel(selection({ model: 'opaque' }), targetOf(selection({ model: 'opaque' }), PROVIDERS)).text).toBe('opaque')
  })

  it('resolves the settings default the "auto" row shows', () => {
    expect(settingsTarget({ provider: 'ark', model: '' }, PROVIDERS)).toMatchObject({ model: { id: 'seedance-2' } })
    expect(settingsTarget({ provider: 'ark', model: 'opaque' }, PROVIDERS)).toMatchObject({ model: { id: 'opaque' } })
    expect(settingsTarget({ provider: 'ark', model: 'gone' }, PROVIDERS)).toBeNull()
    expect(settingsTarget({ provider: '', model: '' }, PROVIDERS)).toBeNull()
  })
})

describe('what a parameter may offer', () => {
  it('uses the chosen model\'s declarations', () => {
    expect(paramValues(PROVIDERS, targetOf(selection(), PROVIDERS), 'durationSeconds')).toEqual({ values: [5, 10], scope: 'model' })
    expect(paramValues(PROVIDERS, targetOf(selection(), PROVIDERS), 'resolution')).toEqual({ values: ['720p', '1080p'], scope: 'model' })
  })

  it('falls back to the union across every model while no model is chosen', () => {
    const target = targetOf(null, PROVIDERS)
    expect(paramValues(PROVIDERS, target, 'durationSeconds')).toEqual({ values: [5, 10, 6], scope: 'union' })
    // 720p/1080p from Seedance, nothing from Hailuo: the union is not padded.
    expect(paramValues(PROVIDERS, target, 'resolution')).toEqual({ values: ['720p', '1080p'], scope: 'union' })
  })

  it('offers nothing for a model that declares nothing', () => {
    expect(declaredValues(NO_DECLARATIONS, 'resolution')).toEqual([])
    expect(declaredValues(null, 'resolution')).toEqual([])
    expect(paramValues(PROVIDERS, targetOf(selection({ model: 'opaque' }), PROVIDERS), 'resolution')).toEqual({ values: [], scope: 'model' })
  })

  it('reads a value the way the button does', () => {
    for (const [key, value, expected] of [
      ['durationSeconds', 5, '5s'],
      ['resolution', '720p', '720p'],
      ['aspectRatio', '16:9', '16:9'],
    ] as [ParamKey, number | string, string][]) {
      expect(paramText(key, value)).toBe(expected)
    }
  })

  it('summarises only what is chosen, in a stable order', () => {
    expect(geometrySummary(null)).toBe('')
    expect(geometrySummary(selection())).toBe('')
    expect(geometrySummary(selection({ aspectRatio: '16:9', resolution: '720p', durationSeconds: 5 }))).toBe('5s · 720p · 16:9')
    expect(geometrySummary(selection({ resolution: '1080p' }))).toBe('1080p')
  })
})

describe('changing the model', () => {
  it('drops what the new model does not declare and keeps the rest', () => {
    const { selection: pruned, dropped } = pruneSelection(
      selection({ durationSeconds: 10, resolution: '720p', aspectRatio: '16:9' }),
      MINIMAX.models[0] as ChipModel,
    )
    // Hailuo declares 6s only, and neither resolution nor aspect ratio.
    expect(pruned).toMatchObject({ provider: 'ark', model: 'seedance-2', durationSeconds: null, resolution: null, aspectRatio: null })
    expect(dropped).toEqual(['durationSeconds', 'resolution', 'aspectRatio'])
  })

  it('drops a value a model that declares nothing cannot show as selected', () => {
    // Keeping it would leave the parameter active while the menu shows nothing
    // chosen — the one state the chip must never be in.
    const { selection: pruned, dropped } = pruneSelection(selection({ durationSeconds: 7, resolution: '4k', aspectRatio: '2.39:1' }), NO_DECLARATIONS)
    expect(dropped).toEqual(['durationSeconds', 'resolution', 'aspectRatio'])
    expect(pruned).toMatchObject({ durationSeconds: null, resolution: null, aspectRatio: null })
  })

  it('keeps a value the model does declare', () => {
    const model: ChipModel = { ...SEEDANCE, durations: [5] }
    const { selection: pruned, dropped } = pruneSelection(selection({ durationSeconds: 5, resolution: '1080p' }), model)
    expect(dropped).toEqual([])
    expect(pruned).toMatchObject({ durationSeconds: 5, resolution: '1080p' })
  })

  it('lists every model with the provider it belongs to', () => {
    expect(modelOptions(PROVIDERS).map(option => `${option.provider.id}/${option.model.id}`))
      .toEqual(['ark/seedance-2', 'ark/opaque', 'minimax/hailuo'])
  })
})
