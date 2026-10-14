// @vitest-environment jsdom
/**
 * The workbench's parameter controls.
 *
 * The page asks the host what the selected model can do, and then offers exactly
 * that: lengths and resolutions are choices where the model declares them, free
 * text where it declares none. What is pinned here is that the controls follow
 * the *selected* model (not the provider's union of models, and not a house
 * default), because sending a value the provider will refuse is the failure this
 * whole surface exists to avoid.
 *
 * Only the transport is faked: every assertion below is about what the page
 * renders from one overview.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelOverview } from '../src/client/panel-api.ts'

const overview: PanelOverview = {
  ok: true,
  enabled: true,
  settings: {
    defaultProvider: 'ark',
    defaultModel: 'seedance-5s',
    maxConcurrent: 1,
    pollIntervalMs: 5000,
    dedupeWindowSeconds: 120,
    outputRoot: '/tmp/dsh-video-forge/outputs',
  },
  providers: [
    {
      id: 'ark',
      protocol: 'ark-seedance',
      baseUrl: 'https://ark.example',
      authRef: 'ARK_API_KEY',
      credential: { configured: true, source: 'file', masked: 'sk…1234', error: null },
      models: [
        {
          id: 'seedance-5s',
          label: 'Seedance 5s',
          modes: ['t2v', 'i2v'],
          durations: [5],
          resolutions: ['720p'],
          aspectRatios: [],
          cancelable: true,
        },
        {
          id: 'seedance-open',
          label: 'Seedance open',
          modes: ['t2v'],
          durations: [],
          resolutions: [],
          aspectRatios: [],
          cancelable: true,
        },
      ],
    },
    {
      id: 'relay',
      protocol: 'generic-openai-videos',
      baseUrl: 'https://relay.example/v1',
      authRef: '',
      credential: { configured: true, source: null, masked: null, error: null },
      models: [
        {
          id: 'sora-2',
          label: 'Sora 2',
          modes: ['t2v'],
          durations: [4, 8, 12],
          resolutions: ['1080p'],
          aspectRatios: ['16:9', '9:16'],
          cancelable: false,
        },
      ],
    },
  ],
  tasks: [],
  usage: { tasks: 0, bytes: 0, overTaskLimit: false, overByteLimit: false },
  active: 0,
}

vi.mock('../src/client/panel-api.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/client/panel-api.ts')>()
  return {
    ...actual,
    fetchOverview: async () => ({ ok: true, value: overview }),
  }
})

const { WorkbenchPage } = await import('../src/client/panel.tsx')
const { en } = await import('../src/client/locales.ts')

afterEach(cleanup)

const t = (key: keyof typeof en, params?: Record<string, unknown>): string => {
  const template = String(en[key])
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

/** Render the page and wait for the overview to arrive. */
async function open(): Promise<void> {
  render(<WorkbenchPage t={t} />)
  await waitFor(() => { expect(screen.getByLabelText(en['panel.provider'])).toBeTruthy() })
}

describe('workbench parameter controls', () => {
  it('offers the default provider\'s declared lengths, not every model\'s', async () => {
    await open()
    const duration = screen.getByLabelText(en['panel.duration']) as HTMLSelectElement
    expect(duration.tagName).toBe('SELECT')
    expect([...duration.options].map(option => option.value)).toEqual(['', '5'])
  })

  it('offers resolution as a choice when the model declares one', async () => {
    await open()
    const resolution = screen.getByLabelText(en['panel.resolution']) as HTMLSelectElement
    expect(resolution.tagName).toBe('SELECT')
    expect([...resolution.options].map(option => option.value)).toEqual(['', '720p'])
  })

  it('falls back to free text for a value the model does not declare', async () => {
    await open()
    const ratio = screen.getByLabelText(en['panel.aspectRatio']) as HTMLInputElement
    expect(ratio.tagName).toBe('INPUT')
    expect(ratio.placeholder).toBe(en['panel.undeclared'])
  })

  it('re-reads every control when the selected model changes', async () => {
    await open()
    fireEvent.change(screen.getByLabelText(en['panel.model']), { target: { value: 'seedance-open' } })

    // A model that declares nothing gets text inputs rather than an empty menu.
    await waitFor(() => {
      expect((screen.getByLabelText(en['panel.resolution']) as HTMLElement).tagName).toBe('INPUT')
    })
    expect((screen.getByLabelText(en['panel.duration']) as HTMLSelectElement).disabled).toBe(true)
  })

  it('re-reads them when the provider changes too', async () => {
    await open()
    fireEvent.change(screen.getByLabelText(en['panel.provider']), { target: { value: 'relay' } })

    await waitFor(() => {
      const ratio = screen.getByLabelText(en['panel.aspectRatio']) as HTMLSelectElement
      expect([...ratio.options].map(option => option.value)).toEqual(['', '16:9', '9:16'])
    })
    expect([...(screen.getByLabelText(en['panel.duration']) as HTMLSelectElement).options].map(option => option.value))
      .toEqual(['', '4', '8', '12'])
  })
})
