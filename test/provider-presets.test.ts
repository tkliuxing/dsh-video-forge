/**
 * The supported-provider catalogue and the draft rules the configuration card
 * edits through.
 *
 * These are pure functions on purpose: "which providers can I add", "what does a
 * preset fill in", "may this list be saved" and "which fields survive a round
 * trip" are all answerable without a DOM or a host, so they are pinned here
 * rather than through the card's rendering.
 */

import { describe, expect, it } from 'vitest'
import {
  PROVIDER_PRESETS,
  SUPPORTED_PROTOCOLS,
  authRefs,
  knownModel,
  knownModelIds,
  modelFromPreset,
  newModel,
  parseNumberList,
  parseStringList,
  providerFromPreset,
  providerPreset,
  readProviders,
  serializeProvider,
  uniqueId,
  validateDrafts,
  type ProviderDraft,
} from '../src/provider-presets.ts'
import { en, zh } from '../src/client/locales.ts'

const STORED = [
  {
    id: 'ark',
    protocol: 'ark-seedance',
    baseUrl: 'https://ark.example/api/v3',
    authRef: 'ARK_API_KEY',
    endpoints: { submit: '/contents/generations/tasks' },
    models: [
      {
        id: 'doubao-seedance-1-0-pro-250528',
        label: 'Seedance Pro',
        modes: ['t2v', 'i2v'],
        durations: [5, 10],
        resolutions: ['720p'],
        aspectRatios: ['16:9'],
        sizes: ['1280x720'],
        cancelable: false,
        generateAudio: true,
        pollIntervalMs: 9000,
        frameRoleFirst: 'first_frame',
      },
    ],
  },
]

describe('supported protocols', () => {
  it('is the list the protocol table speaks, with no protocol unimplemented', () => {
    expect([...SUPPORTED_PROTOCOLS]).toEqual(['ark-seedance', 'generic-openai-videos', 'minimax-video'])
  })

  it('names every protocol in both shipped locales', () => {
    for (const protocol of SUPPORTED_PROTOCOLS) {
      const key = `config.protocol.${protocol}`
      expect((en as Record<string, string>)[key], key).toBeTruthy()
      expect((zh as Record<string, string>)[key], key).toBeTruthy()
    }
  })
})

describe('provider catalogue', () => {
  it('offers exactly the protocols this build implements, each with a label', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(SUPPORTED_PROTOCOLS).toContain(preset.protocol)
      expect((en as Record<string, string>)[`config.preset.${preset.id}`]).toBeTruthy()
      expect((zh as Record<string, string>)[`config.preset.${preset.id}`]).toBeTruthy()
    }
  })

  it('covers every protocol, so no supported provider is missing from the picker', () => {
    const covered = new Set(PROVIDER_PRESETS.map(preset => preset.protocol))
    for (const protocol of SUPPORTED_PROTOCOLS) expect(covered).toContain(protocol)
  })

  it('looks a preset up by id and refuses an unknown one', () => {
    expect(providerPreset('ark')?.protocol).toBe('ark-seedance')
    expect(providerPreset('nope')).toBeUndefined()
  })

  it('pre-fills a row: protocol, base URL, credential reference and the documented models', () => {
    const draft = providerFromPreset(providerPreset('ark')!, ['relay'])
    expect(draft.id).toBe('ark')
    expect(draft.protocol).toBe('ark-seedance')
    expect(draft.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(draft.authRef).toBe('ARK_API_KEY')
    expect(draft.models.map(model => model.id)).toEqual([
      'doubao-seedance-2-5-260628',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128',
      'doubao-seedance-2-0-mini-260615',
      'doubao-seedance-1-0-pro-250528',
      'doubao-seedance-1-0-pro-fast-251015',
    ])
  })

  it('carries each Seedance model\'s documented capabilities into its row', () => {
    const rows = Object.fromEntries(providerFromPreset(providerPreset('ark')!, []).models.map(model => [model.id, model]))
    const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']

    expect(rows['doubao-seedance-2-5-260628']).toMatchObject({
      label: 'Seedance 2.5',
      modes: ['t2v', 'i2v', 'flf2v', 's2v'],
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ratios,
      generateAudio: true,
    })
    expect(rows['doubao-seedance-2-5-260628']?.durations).toEqual(Array.from({ length: 27 }, (_, i) => 4 + i))
    // 4k is the full 2.0 model's alone; Fast and Mini stop at 720p.
    expect(rows['doubao-seedance-2-0-260128']?.resolutions).toEqual(['480p', '720p', '1080p', '4k'])
    expect(rows['doubao-seedance-2-0-fast-260128']?.resolutions).toEqual(['480p', '720p'])
    expect(rows['doubao-seedance-2-0-mini-260615']?.resolutions).toEqual(['480p', '720p'])
    expect(rows['doubao-seedance-2-0-mini-260615']?.durations).toEqual(Array.from({ length: 12 }, (_, i) => 4 + i))
    // 1.0 produces no audio, and Pro Fast has no last-frame input.
    expect(rows['doubao-seedance-1-0-pro-250528']).toMatchObject({ modes: ['t2v', 'i2v', 'flf2v'], generateAudio: false })
    expect(rows['doubao-seedance-1-0-pro-fast-251015']).toMatchObject({ modes: ['t2v', 'i2v'], generateAudio: false })
    expect(rows['doubao-seedance-1-0-pro-fast-251015']?.durations).toEqual(Array.from({ length: 11 }, (_, i) => 2 + i))
  })

  it('writes resolutions exactly as the API spells them', () => {
    // The adapters forward `resolution` verbatim, and each vendor spells it its
    // own way: ARK refuses `1080P`, MiniMax documents `768P`.
    const spelling: Record<string, RegExp> = {
      'ark-seedance': /^(480p|720p|1080p|4k)$/,
      'minimax-video': /^(480P|768P|2K)$/,
    }
    for (const preset of PROVIDER_PRESETS) {
      const pattern = spelling[preset.protocol]
      for (const model of preset.models) {
        if (pattern === undefined) expect(model.resolutions).toEqual([])
        for (const resolution of model.resolutions) expect(resolution, `${preset.id}/${model.id}`).toMatch(pattern ?? /^$/)
      }
    }
  })

  it('carries each MiniMax model\'s documented capabilities, and no cancel', () => {
    const draft = providerFromPreset(providerPreset('minimax')!, [])
    expect(draft).toMatchObject({ protocol: 'minimax-video', baseUrl: 'https://api.minimax.cn', authRef: 'MINIMAX_API_KEY' })
    const rows = Object.fromEntries(draft.models.map(model => [model.id, model]))
    const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']

    expect(rows['MiniMax-H3']).toMatchObject({
      label: 'MiniMax H3',
      modes: ['t2v', 'i2v', 'flf2v', 's2v'],
      resolutions: ['768P', '2K'],
      aspectRatios: ratios,
      generateAudio: false,
      cancelable: false,
    })
    expect(rows['MiniMax-H3']?.durations).toEqual(Array.from({ length: 12 }, (_, i) => 4 + i))
    // H3-Max has no 2K and no 4-second clip.
    expect(rows['MiniMax-H3-Max']).toMatchObject({ resolutions: ['480P', '768P'], cancelable: false })
    expect(rows['MiniMax-H3-Max']?.durations).toEqual(Array.from({ length: 11 }, (_, i) => 5 + i))
  })

  it('marks a row cancelable exactly when its vendor documents a cancel', () => {
    expect(providerFromPreset(providerPreset('ark')!, []).models.every(model => model.cancelable)).toBe(true)
    expect(providerFromPreset(providerPreset('minimax')!, []).models.some(model => model.cancelable)).toBe(false)
  })

  it('leaves the capability lists of an unchecked vendor empty', () => {
    // Empty means "the provider decides"; Sora's limits are not verified yet.
    const [sora] = providerFromPreset(providerPreset('openai')!, []).models
    expect(sora).toMatchObject({ id: 'sora-2', durations: [], resolutions: [], aspectRatios: [] })
  })

  it('lets the same vendor be added twice under distinct ids', () => {
    const first = providerFromPreset(providerPreset('ark')!, [])
    const second = providerFromPreset(providerPreset('ark')!, [first.id])
    expect([first.id, second.id]).toEqual(['ark', 'ark-2'])
    expect(uniqueId(['ark', 'ark-2'], 'ark')).toBe('ark-3')
    expect(uniqueId([], 'relay')).toBe('relay')
  })

  it('suggests the model ids it knows for a protocol', () => {
    expect(knownModelIds('ark-seedance')).toContain('doubao-seedance-1-0-pro-250528')
    expect(knownModelIds('ark-seedance')).toHaveLength(6)
    expect(knownModelIds('generic-openai-videos')).toEqual(['sora-2'])
  })

  it('looks a model up within its protocol only', () => {
    expect(knownModel('ark-seedance', 'doubao-seedance-2-0-260128')?.label).toBe('Seedance 2.0')
    expect(knownModel('generic-openai-videos', 'doubao-seedance-2-0-260128')).toBeUndefined()
    expect(knownModel('ark-seedance', 'doubao-seedance-1-0-lite-t2v-250428')).toBeUndefined()
  })

  it('builds a row from a preset model without sharing its arrays', () => {
    const preset = knownModel('ark-seedance', 'doubao-seedance-2-0-260128')!
    const row = modelFromPreset(preset)
    row.durations.push(99)
    expect(preset.durations).not.toContain(99)
  })
})

describe('reading the stored list', () => {
  it('reads a stored provider list into editable rows', () => {
    const result = readProviders(STORED)
    expect(result.problem).toBeNull()
    expect(result.drafts).toHaveLength(1)
    const [provider] = result.drafts
    expect(provider?.id).toBe('ark')
    expect(provider?.protocol).toBe('ark-seedance')
    expect(provider?.models[0]?.modes).toEqual(['t2v', 'i2v'])
    expect(provider?.models[0]?.cancelable).toBe(false)
    expect(provider?.models[0]?.generateAudio).toBe(true)
  })

  it('keeps the fields the form does not show, so a save cannot drop them', () => {
    const [draft] = readProviders(STORED).drafts
    const written = serializeProvider(draft!) as {
      endpoints: Record<string, string>
      models: Record<string, unknown>[]
    }
    expect(written.endpoints).toEqual({ submit: '/contents/generations/tasks' })
    expect(written.models[0]?.['sizes']).toEqual(['1280x720'])
    expect(written.models[0]?.['pollIntervalMs']).toBe(9000)
    expect(written.models[0]?.['frameRoleFirst']).toBe('first_frame')
  })

  it('round-trips a row it read, unchanged', () => {
    const [draft] = readProviders(STORED).drafts
    const written = serializeProvider(draft!) as Record<string, unknown>
    expect(written).toEqual(STORED[0])
  })

  it('treats an absent list as empty rather than broken', () => {
    expect(readProviders(undefined)).toEqual({ drafts: [], problem: null })
    expect(readProviders([])).toEqual({ drafts: [], problem: null })
  })

  it('refuses a value that is not a provider list at all', () => {
    expect(readProviders({ id: 'ark' }).problem).toBe('shape')
    expect(readProviders(['ark']).problem).toBe('shape')
    expect(readProviders([{ id: 'ark', models: 'none' }]).problem).toBe('shape')
  })

  it('coerces a row a hand-edited config left slightly off', () => {
    const [draft] = readProviders([{ id: 'x', protocol: 'generic-openai-videos', baseUrl: 'u', models: [{ id: 'm' }] }]).drafts
    expect(draft?.authRef).toBe('')
    expect(draft?.models[0]?.modes).toEqual([])
    expect(draft?.models[0]?.cancelable).toBe(true)
  })
})

describe('validation before a save', () => {
  function draft(over: Partial<ProviderDraft> = {}): ProviderDraft {
    return { id: 'ark', protocol: 'ark-seedance', baseUrl: 'https://ark.example', authRef: '', models: [], rest: {}, ...over }
  }

  it('accepts a list the runtime could use', () => {
    expect(validateDrafts([draft({ models: [newModel('m-1')] })])).toBeNull()
    expect(validateDrafts([])).toBeNull()
  })

  it('names the row that has no id', () => {
    expect(validateDrafts([draft(), draft({ id: '  ' })])).toEqual({ code: 'providerIdEmpty', index: 1 })
  })

  it('refuses two providers under one id, because a call could not pick one', () => {
    expect(validateDrafts([draft(), draft({ id: 'ark' })])).toEqual({ code: 'providerIdDuplicate', index: 1, id: 'ark' })
  })

  it('refuses a provider with no base URL', () => {
    expect(validateDrafts([draft({ baseUrl: '' })])).toEqual({ code: 'baseUrlEmpty', index: 0 })
  })

  it('refuses a model with no id, and a duplicate inside one provider', () => {
    expect(validateDrafts([draft({ models: [newModel('')] })])).toEqual({ code: 'modelIdEmpty', index: 0, modelIndex: 0 })
    expect(validateDrafts([draft({ models: [newModel('m'), newModel('m')] })]))
      .toEqual({ code: 'modelIdDuplicate', index: 0, modelIndex: 1, id: 'm' })
  })
})

describe('credential references and list fields', () => {
  it('collects distinct references and skips the keyless ones', () => {
    const drafts = [
      { id: 'a', protocol: 'ark-seedance' as const, baseUrl: 'u', authRef: 'ARK_API_KEY', models: [], rest: {} },
      { id: 'b', protocol: 'ark-seedance' as const, baseUrl: 'u', authRef: ' ark_api_key ', models: [], rest: {} },
      { id: 'c', protocol: 'ark-seedance' as const, baseUrl: 'u', authRef: '', models: [], rest: {} },
    ]
    expect(authRefs(drafts)).toEqual(['ARK_API_KEY', 'ark_api_key'])
  })

  it('parses comma-separated lists leniently, so typing stays possible', () => {
    expect(parseNumberList('5, 10')).toEqual([5, 10])
    expect(parseNumberList('5,')).toEqual([5])
    expect(parseNumberList('  ')).toEqual([])
    expect(parseNumberList('5, oops')).toEqual([5])
    expect(parseStringList('720p, 1080p')).toEqual(['720p', '1080p'])
    expect(parseStringList('16:9,')).toEqual(['16:9'])
  })
})
