// @vitest-environment jsdom
/**
 * The configuration card's provider editor.
 *
 * What the operator can *choose* is the point of this file. The card used to ask
 * for a provider list as JSON and for the default provider and model as free
 * text; what is pinned here is that every enumerable value is now an offered
 * option — the supported protocols, the vendor catalogue, the configured
 * providers, their models — that several providers can be added, and that a
 * mistake is refused with a sentence naming the row rather than written through.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_PRESETS, SUPPORTED_PROTOCOLS } from '../src/provider-presets.ts'
import { SettingsCard, type ClientConfigShape, type ConfigPatch, type CredentialState } from '../src/client/settings-card.tsx'
import { credentialSummary } from '../src/client/providers-editor.tsx'
import { en } from '../src/client/locales.ts'
import type { VideoForgeKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: VideoForgeKey, params?: Record<string, unknown>): string => {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

/** The ark row as a stored config would carry it: every schema field present. */
const ARK_ROW = {
  id: 'ark',
  protocol: 'ark-seedance',
  baseUrl: 'https://ark.example/api/v3',
  authRef: 'ARK_API_KEY',
  models: [
    {
      id: 'doubao-seedance-1-0-pro-250528',
      label: 'Seedance Pro',
      modes: ['t2v', 'i2v'],
      durations: [5, 10],
      resolutions: ['720p'],
      aspectRatios: ['16:9'],
      sizes: ['1280x720'],
      cancelable: true,
      generateAudio: true,
      pollIntervalMs: 9000,
      frameRoleFirst: 'first_frame',
      frameRoleLast: 'last_frame',
      frameRoleReference: 'reference_image',
    },
  ],
}

const CONFIG: ClientConfigShape = {
  enabled: true,
  providers: [ARK_ROW],
  defaultProvider: 'ark',
  defaultModel: 'doubao-seedance-1-0-pro-250528',
  outputDir: '',
  pollIntervalMs: 5000,
  waitSecondsMax: 600,
  dedupeWindowSeconds: 120,
  maxConcurrent: 1,
  maxTasks: 200,
  maxGiB: 20,
  requestTimeoutMs: 120_000,
}

interface Bench {
  save: ReturnType<typeof vi.fn<(ops: readonly ConfigPatch[]) => Promise<boolean>>>
  useConfig: () => { status: 'ready'; value: ClientConfigShape; writable: boolean }
}

function bench(config: ClientConfigShape = CONFIG, over: { writable?: boolean } = {}): Bench {
  const save = vi.fn(async () => true)
  return { save, useConfig: () => ({ status: 'ready' as const, value: config, writable: over.writable ?? true }) }
}

function props(b: Bench) {
  return {
    t,
    useConfig: b.useConfig,
    save: b.save,
    describeCredential: async (): Promise<CredentialState> => ({ configured: false, source: null, writable: true, error: null }),
    setCredential: async () => null,
    unsetCredential: async () => null,
  }
}

/** The single providers op a save produced, or a failure that says why not. */
function providersOp(b: Bench): unknown {
  const call = b.save.mock.calls.at(-1)?.[0] ?? []
  const op = call.find(entry => entry.path[0] === 'providers')
  expect(op, 'a providers op was written').toBeTruthy()
  return op?.value
}

describe('configuration card: choices instead of typing', () => {
  it('offers the configured providers as the default, not a text field', () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)
    const select = screen.getByLabelText(en['config.defaultProvider']) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect([...select.options].map(option => option.text)).toEqual([en['config.defaultFirst'], 'ark'])
  })

  it('offers the default provider\'s own models, by label', () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)
    const select = screen.getByLabelText(en['config.defaultModel']) as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect([...select.options].map(option => option.text))
      .toEqual([en['config.defaultFirstModel'], 'Seedance Pro (doubao-seedance-1-0-pro-250528)'])
  })

  it('offers exactly the protocols this build speaks, per provider', () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)
    const select = screen.getByLabelText(en['config.protocol']) as HTMLSelectElement
    expect([...select.options].map(option => option.value)).toEqual([...SUPPORTED_PROTOCOLS])
    expect([...select.options].map(option => option.text))
      .toEqual(SUPPORTED_PROTOCOLS.map(protocol => t(`config.protocol.${protocol}` as VideoForgeKey)))
  })

  it('offers exactly the supported providers in the add picker', () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)
    const select = screen.getByLabelText(en['config.addProvider']) as HTMLSelectElement
    expect([...select.options].slice(1).map(option => option.value))
      .toEqual(PROVIDER_PRESETS.map(preset => preset.id))
  })

  it('switches the default provider and drops the model that belonged to the old one', async () => {
    const b = bench({ ...CONFIG, providers: [ARK_ROW, { id: 'relay', protocol: 'generic-openai-videos', baseUrl: 'https://relay.example/v1', models: [] }] })
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.defaultProvider']), { target: { value: 'relay' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(b.save.mock.calls[0]?.[0]).toEqual([
      { op: 'set', path: ['defaultProvider'], value: 'relay' },
      // A model id belongs to one provider; keeping it would make every default
      // call fail the provider's own "does not declare model" check.
      { op: 'set', path: ['defaultModel'], value: '' },
    ])
  })
})

describe('configuration card: adding providers', () => {
  it('adds a second provider from the catalogue and writes both rows', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.addProvider']), { target: { value: 'relay' } })
    fireEvent.click(screen.getByText(en['config.add']))

    // The preset filled the row in; only its base URL is the operator's to give.
    expect(screen.getAllByLabelText(en['config.providerId'])).toHaveLength(2)
    expect((screen.getAllByLabelText(en['config.providerId'])[1] as HTMLInputElement).value).toBe('relay')
    expect((screen.getAllByLabelText(en['config.protocol'])[1] as HTMLSelectElement).value).toBe('generic-openai-videos')

    fireEvent.change(screen.getAllByLabelText(en['config.baseUrl'])[1]!, { target: { value: 'https://relay.example/v1' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    const written = providersOp(b) as Record<string, unknown>[]
    expect(written).toHaveLength(2)
    // The untouched row is written back exactly as it was read.
    expect(written[0]).toEqual(ARK_ROW)
    expect(written[1]).toMatchObject({
      id: 'relay',
      protocol: 'generic-openai-videos',
      baseUrl: 'https://relay.example/v1',
      models: [],
    })
  })

  it('adds the same vendor twice under distinct ids rather than losing one', () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.addProvider']), { target: { value: 'ark' } })
    fireEvent.click(screen.getByText(en['config.add']))

    expect((screen.getAllByLabelText(en['config.providerId']).map(node => (node as HTMLInputElement).value)))
      .toEqual(['ark', 'ark-2'])
  })

  it('refuses the save and names the row while a base URL is missing', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.addProvider']), { target: { value: 'relay' } })
    fireEvent.click(screen.getByText(en['config.add']))
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => {
      expect(screen.getByText(t('config.problem.baseUrlEmpty', { index: 2 }))).toBeTruthy()
    })
    expect(b.save).not.toHaveBeenCalled()
  })

  it('removes a provider, and says there is none left', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.click(screen.getByText(en['config.removeProvider']))
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(providersOp(b)).toEqual([])
  })
})

describe('configuration card: editing a provider and its models', () => {
  it('changes the protocol through the select and writes it', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.protocol']), { target: { value: 'generic-openai-videos' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    const written = providersOp(b) as Record<string, unknown>[]
    expect(written[0]?.['protocol']).toBe('generic-openai-videos')
    // Everything else about the row survives the switch.
    expect(written[0]?.['baseUrl']).toBe('https://ark.example/api/v3')
    expect(written[0]?.['models']).toEqual(ARK_ROW.models)
  })

  it('edits a model: id, display name, modes, capability lists', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.modelId']), { target: { value: 'doubao-seedance-2-0' } })
    fireEvent.change(screen.getByLabelText(en['config.modelLabel']), { target: { value: 'Seedance 2' } })
    // Modes are checkboxes over the four the runtime understands.
    fireEvent.click(screen.getByLabelText(en['panel.mode.s2v']))
    fireEvent.click(screen.getByLabelText(en['panel.mode.i2v']))
    fireEvent.change(screen.getByLabelText(en['config.durations']), { target: { value: '5, 10, 15' } })
    fireEvent.change(screen.getByLabelText(en['config.resolutions']), { target: { value: '720p, 1080p' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    const written = providersOp(b) as { models: Record<string, unknown>[] }[]
    expect(written[0]?.models[0]).toMatchObject({
      id: 'doubao-seedance-2-0',
      label: 'Seedance 2',
      modes: ['t2v', 's2v'],
      durations: [5, 10, 15],
      resolutions: ['720p', '1080p'],
      // The fields the form does not show are still carried through.
      sizes: ['1280x720'],
      frameRoleReference: 'reference_image',
    })
  })

  it('fills a new model row from the catalogue when a known id is entered', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.click(screen.getByText(new RegExp(en['config.addModel'])))
    fireEvent.change(screen.getAllByLabelText(en['config.modelId'])[1]!, { target: { value: 'doubao-seedance-2-0-fast-260128' } })
    expect((screen.getAllByLabelText(en['config.resolutions'])[1] as HTMLInputElement).value).toBe('480p, 720p')
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    const written = providersOp(b) as { models: Record<string, unknown>[] }[]
    expect(written[0]?.models[1]).toMatchObject({
      id: 'doubao-seedance-2-0-fast-260128',
      label: 'Seedance 2.0 Fast',
      modes: ['t2v', 'i2v', 'flf2v', 's2v'],
      resolutions: ['480p', '720p'],
      generateAudio: true,
    })
  })

  it('never overwrites a row that already declares capabilities', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    // The stored row has its own lists; renaming it to a catalogue id keeps them.
    fireEvent.change(screen.getByLabelText(en['config.modelId']), { target: { value: 'doubao-seedance-2-0-260128' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    const written = providersOp(b) as { models: Record<string, unknown>[] }[]
    expect(written[0]?.models[0]).toMatchObject({ id: 'doubao-seedance-2-0-260128', label: ARK_ROW.models[0]!.label, durations: ARK_ROW.models[0]!.durations })
  })

  it('adds an empty model and can remove it again', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.click(screen.getByText(new RegExp(en['config.addModel'])))
    expect(screen.getAllByLabelText(en['config.modelId'])).toHaveLength(2)

    fireEvent.click(screen.getByText(en['config.save']))
    await waitFor(() => { expect(screen.getByText(t('config.problem.modelIdEmpty', { index: 1, model: 2 }))).toBeTruthy() })
    expect(b.save).not.toHaveBeenCalled()

    fireEvent.change(screen.getAllByLabelText(en['config.modelId'])[1]!, { target: { value: 'second-model' } })
    fireEvent.click(screen.getAllByText(en['config.removeModel'])[1]!)
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    const written = providersOp(b) as { models: { id: string }[] }[]
    expect(written[0]?.models.map(model => model.id)).toEqual(['doubao-seedance-1-0-pro-250528'])
  })
})

describe('configuration card: the JSON view and the rows are one list', () => {
  it('re-renders the rows from the text, and writes what was typed', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    const typed = [
      { id: 'relay', protocol: 'generic-openai-videos', baseUrl: 'https://relay.example/v1', models: [] },
      { id: 'ark', protocol: 'ark-seedance', baseUrl: 'https://ark.example/api/v3', models: [] },
    ]
    const editor = screen.getByLabelText(`${en['config.providers']} (JSON)`) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: JSON.stringify(typed, null, 2) } })

    expect(screen.getAllByLabelText(en['config.providerId']).map(node => (node as HTMLInputElement).value))
      .toEqual(['relay', 'ark'])

    fireEvent.click(screen.getByText(en['config.save']))
    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(providersOp(b)).toEqual(typed)
  })

  it('rewrites the text from a row edit, so the two views cannot disagree', () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(en['config.providerId']), { target: { value: 'ark-cn' } })
    const editor = screen.getByLabelText(`${en['config.providers']} (JSON)`) as HTMLTextAreaElement
    expect(JSON.parse(editor.value)).toMatchObject([{ id: 'ark-cn', protocol: 'ark-seedance' }])
  })

  it('refuses text that parses but would not run: entries that are not providers', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    fireEvent.change(screen.getByLabelText(`${en['config.providers']} (JSON)`), { target: { value: '["ark"]' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(screen.getByText(en['config.providersJsonShape'])).toBeTruthy() })
    expect(b.save).not.toHaveBeenCalled()
  })

  it('refuses text with two rows under one id, the same way a row edit would', async () => {
    const b = bench()
    render(<SettingsCard {...props(b)} />)

    const twice = [
      { id: 'ark', protocol: 'ark-seedance', baseUrl: 'https://a.example', models: [] },
      { id: 'ark', protocol: 'ark-seedance', baseUrl: 'https://b.example', models: [] },
    ]
    fireEvent.change(screen.getByLabelText(`${en['config.providers']} (JSON)`), { target: { value: JSON.stringify(twice) } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => {
      expect(screen.getByText(t('config.problem.providerIdDuplicate', { index: 2, id: 'ark' }))).toBeTruthy()
    })
    expect(b.save).not.toHaveBeenCalled()
  })
})

describe('configuration card: folding providers and models', () => {
  /** The `<details>` whose summary leads with this id (a provider card or a model row). */
  const fold = (id: string): HTMLDetailsElement => {
    const heading = screen.getAllByText(id, { selector: 'summary strong' })[0]
    const details = heading?.closest('details')
    expect(details, `a fold for ${id}`).toBeTruthy()
    return details as HTMLDetailsElement
  }
  const TWO_PROVIDERS: ClientConfigShape = {
    ...CONFIG,
    providers: [ARK_ROW, { id: 'relay', protocol: 'generic-openai-videos', baseUrl: 'https://relay.example/v1', authRef: '', models: [] }],
  }

  it('shows stored rows folded, each summarised on one line', () => {
    render(<SettingsCard {...props(bench(TWO_PROVIDERS))} />)

    expect(fold('ark').open).toBe(false)
    expect(fold('relay').open).toBe(false)
    expect(fold('doubao-seedance-1-0-pro-250528').open).toBe(false)

    const ark = fold('ark').querySelector('summary')!.textContent ?? ''
    expect(ark).toContain(en['config.protocol.ark-seedance'])
    expect(ark).toContain(`${en['config.models']} · 1`)
    expect(fold('relay').querySelector('summary')!.textContent).toContain(en['config.credentialKeyless'])
    const model = fold('doubao-seedance-1-0-pro-250528').querySelector('summary')!.textContent ?? ''
    expect(model).toContain('Seedance Pro')
    expect(model).toContain(`${en['panel.mode.t2v']} / ${en['panel.mode.i2v']}`)
  })

  it('opens a provider added from the picker, and leaves the stored ones folded', () => {
    render(<SettingsCard {...props(bench())} />)

    fireEvent.change(screen.getByLabelText(en['config.addProvider']), { target: { value: 'minimax' } })
    fireEvent.click(screen.getByText(en['config.add']))

    expect(fold('minimax').open).toBe(true)
    expect(fold('ark').open).toBe(false)
  })

  it('opens the provider and the new row when a model is added', () => {
    render(<SettingsCard {...props(bench())} />)

    fireEvent.click(screen.getByText(new RegExp(en['config.addModel'])))

    expect(fold('ark').open).toBe(true)
    expect(fold(en['config.unnamed']).open).toBe(true)
    expect(fold('doubao-seedance-1-0-pro-250528').open).toBe(false)
  })

  it('expands and collapses every row at once', () => {
    render(<SettingsCard {...props(bench(TWO_PROVIDERS))} />)

    fireEvent.click(screen.getByText(en['config.expandAll']))
    expect([fold('ark').open, fold('relay').open, fold('doubao-seedance-1-0-pro-250528').open]).toEqual([true, true, true])

    fireEvent.click(screen.getByText(en['config.collapseAll']))
    expect([fold('ark').open, fold('relay').open, fold('doubao-seedance-1-0-pro-250528').open]).toEqual([false, false, false])
  })

  it('opens the row a refused save names, even after it was folded', async () => {
    const b = bench(TWO_PROVIDERS)
    render(<SettingsCard {...props(b)} />)

    // Blank the ark model's id, fold everything, then try to save.
    fireEvent.change(screen.getByDisplayValue('doubao-seedance-1-0-pro-250528'), { target: { value: '' } })
    fireEvent.click(screen.getByText(en['config.collapseAll']))
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => {
      expect(screen.getByText(t('config.problem.modelIdEmpty', { index: 1, model: 1 }))).toBeTruthy()
    })
    expect(b.save).not.toHaveBeenCalled()
    expect(fold('ark').open).toBe(true)
    expect(fold(en['config.unnamed']).open).toBe(true)
    expect(fold('relay').open).toBe(false)
  })
})

describe('configuration card: credential verdicts', () => {
  const provider = (over: Partial<{ credential: { configured: boolean; source: string | null; masked: string | null; error: string | null }; authRef: string }> = {}) => ({
    id: 'ark',
    protocol: 'ark-seedance',
    baseUrl: 'https://ark.example',
    authRef: over.authRef ?? 'ARK_API_KEY',
    credential: over.credential ?? { configured: false, source: null, masked: null, error: null },
    models: [],
  })

  it('prefers the masked tail the workbench API knows about', () => {
    const summary = credentialSummary(
      t,
      'ARK_API_KEY',
      provider({ credential: { configured: true, source: 'file', masked: 'sk…1234', error: null } }),
      { configured: true, source: 'file', writable: true, error: null },
    )
    expect(summary).toEqual({ text: t('config.credentialConfigured', { masked: 'sk…1234', source: 'file' }), tone: 'ok' })
  })

  it('falls back to the host\'s own verdict when the API did not answer', () => {
    const summary = credentialSummary(t, 'ARK_API_KEY', undefined, { configured: true, source: 'file', writable: true, error: null })
    expect(summary.tone).toBe('ok')
    expect(summary.text).toBe(t('config.keyExists', { ref: 'ARK_API_KEY' }))
  })

  it('calls an empty reference keyless rather than missing', () => {
    expect(credentialSummary(t, '', undefined, undefined).text).toBe(t('config.credentialKeyless'))
  })

  it('shows a host-side failure verbatim', () => {
    const summary = credentialSummary(t, 'ARK_API_KEY', provider({ credential: { configured: false, source: null, masked: null, error: 'missing ARK_API_KEY' } }), undefined)
    expect(summary.tone).toBe('error')
    expect(summary.text).toContain('missing ARK_API_KEY')
    // The one-line summary of a folded card keeps the verdict and drops the detail.
    expect(summary.headline).toBe(t('config.credentialMissing'))
  })
})
