// @vitest-environment jsdom
/**
 * The composer chip's rendered behaviour (M6, DESIGN §20).
 *
 * The pure rules (what a stale choice means, what a model declares, what to drop
 * when the model changes) are covered in `client-model-chip.test.ts`; this file
 * pins the wiring a pure test cannot: that the panel opens on the trigger, that
 * picking a model stores it and drops what the new model does not declare *and
 * says so*, that a parameter can be cleared one at a time, that "auto" forgets
 * the whole choice, and that a model which has left the settings is shown as
 * unavailable instead of being swapped out behind the operator's back.
 *
 * `fetch` is stubbed at the boundary the chip actually uses, so the assertions are
 * about the requests the composer would send.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelChip, type ModelChipProps } from '../src/client/model-chip.tsx'
import { en, type VideoForgeKey } from '../src/client/locales.ts'
import type { ChipProvider, ChipSelection } from '../src/client/panel-api.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = (key: VideoForgeKey, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

const PROVIDERS: ChipProvider[] = [
  {
    id: 'ark',
    protocol: 'ark-seedance',
    credential: { configured: true, masked: 'sk…1234', error: null },
    models: [
      { id: 'seedance-2', label: 'Seedance 2.0', modes: ['t2v'], durations: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9'], cancelable: true },
      { id: 'seedance-fast', label: 'Seedance Fast', modes: ['t2v'], durations: [5], resolutions: ['1080p'], aspectRatios: ['9:16'], cancelable: true },
    ],
  },
  {
    id: 'minimax',
    protocol: 'minimax-video',
    credential: { configured: false, masked: null, error: null },
    models: [
      { id: 'hailuo', label: 'Hailuo', modes: ['t2v'], durations: [6], resolutions: [], aspectRatios: [], cancelable: false },
    ],
  },
]

interface FakeHost {
  selection: ChipSelection | null
  saves: ChipSelection[]
  clears: number
  failSave: string | null
  reads: number
}

let host: FakeHost

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response
}

/** Stand a fake panel API behind `fetch`, the seam the chip talks through. */
function installHost(selection: ChipSelection | null = null): FakeHost {
  host = { selection, saves: [], clears: 0, failSave: null, reads: 0 }
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      host.reads += 1
      return json({ ok: true, session: 's1', enabled: true, selection: host.selection, defaults: { provider: 'ark', model: '' }, providers: PROVIDERS })
    }
    if (method === 'POST') {
      if (host.failSave !== null) return json({ ok: false, error: host.failSave }, 400)
      const body = JSON.parse(String(init?.body ?? '{}')) as ChipSelection
      host.saves.push(body)
      host.selection = body
      return json({ ok: true, session: 's1', selection: body })
    }
    host.clears += 1
    host.selection = null
    return json({ ok: true, session: 's1', selection: null })
  }))
  return host
}

/** Compose the props the slot framework would hand the chip. */
function props(): ModelChipProps {
  // The composer's runtime kit is not part of this test: only the session and
  // the copy are read, and the rest is the framework's business.
  return { sessionId: 's1', t } as unknown as ModelChipProps
}

const trigger = (): HTMLElement => screen.getByRole('button', { name: /^Video model for this conversation:/ })

async function openMenu(): Promise<HTMLElement> {
  render(<ModelChip {...props()} />)
  await waitFor(() => expect(host.reads).toBeGreaterThan(0))
  fireEvent.click(trigger())
  return screen.getByRole('dialog', { name: 'Video model for this conversation' })
}

const chipSelection = (over: Partial<ChipSelection> = {}): ChipSelection => ({
  provider: 'ark',
  model: 'seedance-2',
  durationSeconds: null,
  resolution: null,
  aspectRatio: null,
  ...over,
})

describe('the composer chip', () => {
  it('says "auto" until this conversation chooses, and lists every configured model', async () => {
    installHost()
    const dialog = await openMenu()
    // The trigger itself carries no model name yet.
    expect(trigger().textContent).toContain('Video model')
    expect(within(dialog).getByRole('button', { name: /^Auto/ })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: /Seedance 2\.0/ })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: /Seedance Fast/ })).toBeDefined()
    // A provider without a key is marked as such, and still selectable.
    expect(within(dialog).getByRole('button', { name: /Hailuo/ }).textContent).toContain('no key')
  })

  it('stores the model it picked, and the trigger then names it', async () => {
    installHost()
    const dialog = await openMenu()
    fireEvent.click(within(dialog).getByRole('button', { name: /Seedance 2\.0/ }))
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ provider: 'ark', model: 'seedance-2' }))
    await waitFor(() => expect(trigger().textContent).toContain('Seedance 2.0'))
  })

  it('drops the parameters a newly picked model does not declare, and says which', async () => {
    installHost(chipSelection({ durationSeconds: 5, resolution: '720p', aspectRatio: '16:9' }))
    const dialog = await openMenu()
    // The fields the current model declared are the pressed ones.
    expect(within(dialog).getByRole('button', { name: '720p' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(dialog).getByRole('button', { name: /Seedance Fast/ }))
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({
      provider: 'ark',
      model: 'seedance-fast',
      // Fast declares 5s, so the duration stays; it declares neither 720p nor 16:9.
      durationSeconds: 5,
      resolution: null,
      aspectRatio: null,
    }))
    await waitFor(() => expect(within(dialog).getByRole('status').textContent).toMatch(/Cleared Resolution, Aspect ratio/))
  })

  it('sets one parameter and clears it again with "not set"', async () => {
    installHost(chipSelection())
    const dialog = await openMenu()
    fireEvent.click(within(dialog).getByRole('button', { name: '10s' }))
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ durationSeconds: 10 }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Length: Not set' }))
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ durationSeconds: null }))
  })

  it('forgets the whole choice when "auto" is picked, so the manifest and settings decide again', async () => {
    installHost(chipSelection({ resolution: '1080p' }))
    const dialog = await openMenu()
    expect(trigger().textContent).toContain('1080p')
    fireEvent.click(within(dialog).getByRole('button', { name: /^Auto/ }))
    await waitFor(() => expect(host.clears).toBe(1))
    await waitFor(() => expect(trigger().textContent).not.toContain('1080p'))
  })

  it('marks a model that has left the settings instead of quietly using another', async () => {
    installHost(chipSelection({ model: 'gone' }))
    const dialog = await openMenu()
    expect(trigger().textContent).toContain('gone')
    expect(within(dialog).getByText('The chosen model is no longer in the settings')).toBeDefined()
    // Nothing was written: showing the problem must not rewrite the choice.
    expect(host.saves).toHaveLength(0)
    expect(host.clears).toBe(0)
  })

  it('offers every configured model\'s values while the chip chooses no model', async () => {
    installHost()
    const dialog = await openMenu()
    // Durations: 5 and 10 from Seedance 2.0, 6 from Hailuo — the union.
    expect(within(dialog).getByRole('button', { name: '6s' })).toBeDefined()
    // The hint appears once per parameter, because none of them has a model to read from.
    expect(within(dialog).getAllByText(en['chip.unionHint'])).toHaveLength(3)
  })

  it('says why a save failed, and keeps the old choice', async () => {
    const fake = installHost(chipSelection())
    const dialog = await openMenu()
    fake.failSave = 'the selection file could not be read; not overwriting it'
    fireEvent.click(within(dialog).getByRole('button', { name: '720p' }))
    await waitFor(() => expect(within(dialog).getByText(/Not saved: the selection file could not be read/)).toBeDefined())
    expect(trigger().textContent).toContain('Seedance 2.0')
  })
})
