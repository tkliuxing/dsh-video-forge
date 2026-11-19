/**
 * What the host tells the chip and the configuration card about a model's
 * capabilities.
 *
 * A stored row that declares nothing is the normal shape of an older config:
 * the operator typed the model id, and the three lists were added to the schema
 * later with an empty default. Those rows must recover the capabilities this
 * build documents for the exact (protocol, id), or the chip has nothing to
 * offer. The provenance marker is what keeps that recovery honest — the UI can
 * say the lists were filled in, not written to the config.
 */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { describeProviders } from '../src/operations.ts'
import { DEFAULT_PRICE_TABLE } from '../src/prices.ts'
import { DEFAULT_ENDPOINTS, type ModelSetting, type ProviderSetting, type VideoForgeSettings } from '../src/settings.ts'
import type { VideoForgeRuntime } from '../src/runtime.ts'

function model(over: Partial<ModelSetting> & { id: string }): ModelSetting {
  return {
    label: '',
    modes: ['t2v'],
    durations: [],
    resolutions: [],
    aspectRatios: [],
    sizes: [],
    cancelable: true,
    generateAudio: false,
    pollIntervalMs: 5000,
    frameRoleFirst: 'first_frame',
    frameRoleLast: 'last_frame',
    frameRoleReference: 'reference_image',
    ...over,
  }
}

/** The ark provider exactly as the operator's config stores it: two rows with no lists at all. */
const ARK_MODELS: ModelSetting[] = [
  model({
    id: 'doubao-seedance-2-5-260628',
    label: 'Doubao-Seedance-2.5',
    modes: ['t2v', 'i2v', 'flf2v'],
  }),
  model({
    id: 'doubao-seedance-2-0-260128',
    label: 'Doubao-Seedance-2.0',
    modes: ['t2v', 'i2v', 's2v'],
  }),
]

function settingsFor(models: readonly ModelSetting[], protocol: ProviderSetting['protocol'] = 'ark-seedance'): VideoForgeSettings {
  return {
    enabled: true,
    providers: [{ id: 'ark', protocol, baseUrl: 'http://127.0.0.1:1', authRef: '', models, endpoints: DEFAULT_ENDPOINTS }],
    defaultProvider: 'ark',
    defaultModel: '',
    outputDir: '',
    pollIntervalMs: 5000,
    waitSecondsMax: 600,
    dedupeWindowSeconds: 0,
    maxConcurrent: 1,
    maxTasks: 200,
    maxGiB: 20,
    requestTimeoutMs: 30_000,
    priceTable: DEFAULT_PRICE_TABLE,
  }
}

function runtimeFor(settings: VideoForgeSettings): VideoForgeRuntime {
  // describeProviders only reads settings and (for a keyed provider) credentials.
  // An empty authRef over loopback needs neither, so the context can stay inert.
  return { settings: () => settings, ctx: { get: () => undefined } as unknown as Context } as unknown as VideoForgeRuntime
}

describe('the provider status a stored row describes', () => {
  it('fills an undeclared known model from the built-in preset', async () => {
    const [provider] = await describeProviders(runtimeFor(settingsFor(ARK_MODELS)))
    const rows = provider!.models

    expect(rows[0]).toMatchObject({
      id: 'doubao-seedance-2-5-260628',
      label: 'Doubao-Seedance-2.5',
      durations: Array.from({ length: 27 }, (_value, index) => index + 4),
      resolutions: ['480p', '720p', '1080p'],
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      capabilitiesFrom: 'preset',
    })
    expect(rows[1]).toMatchObject({
      id: 'doubao-seedance-2-0-260128',
      durations: Array.from({ length: 12 }, (_value, index) => index + 4),
      resolutions: ['480p', '720p', '1080p', '4k'],
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
      capabilitiesFrom: 'preset',
    })
    // The fields that were declared stay exactly as configured.
    expect(rows[0]!.modes).toEqual(['t2v', 'i2v', 'flf2v'])
  })

  it('leaves a row whose id the preset does not know empty', async () => {
    const [provider] = await describeProviders(runtimeFor(settingsFor([model({ id: 'sora-2', label: 'Sora 2' })], 'generic-openai-videos')))
    expect(provider!.models[0]).toMatchObject({
      id: 'sora-2',
      durations: [],
      resolutions: [],
      aspectRatios: [],
      capabilitiesFrom: 'config',
    })
  })

  it('does not overwrite a row that declares any one of the three', async () => {
    const partial = model({ id: 'doubao-seedance-2-5-260628', label: 'My Seedance', durations: [7] })
    const [provider] = await describeProviders(runtimeFor(settingsFor([partial])))
    expect(provider!.models[0]).toMatchObject({
      label: 'My Seedance',
      durations: [7],
      resolutions: [],
      aspectRatios: [],
      capabilitiesFrom: 'config',
    })
  })
})
