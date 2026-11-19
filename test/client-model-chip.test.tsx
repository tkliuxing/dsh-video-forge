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

const LONG_PROVIDER: ChipProvider = {
  id: 'ark',
  protocol: 'ark-seedance',
  credential: { configured: true, masked: 'sk…1234', error: null },
  models: [{
    id: 'seedance-long',
    label: 'Seedance Long',
    modes: ['t2v'],
    durations: [5, 10, 15, 20],
    resolutions: [],
    aspectRatios: [],
    cancelable: true,
  }],
}

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
function installHost(selection: ChipSelection | null = null, providers: ChipProvider[] = PROVIDERS): FakeHost {
  host = { selection, saves: [], clears: 0, failSave: null, reads: 0 }
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      host.reads += 1
      return json({ ok: true, session: 's1', enabled: true, selection: host.selection, defaults: { provider: 'ark', model: '' }, providers })
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

  it('sets the length with the slider and clears it again with "not set"', async () => {
    installHost(chipSelection())
    const dialog = await openMenu()
    const slider = within(dialog).getByRole('slider', { name: 'Length' }) as HTMLInputElement
    // Seedance 2.0 declares [5, 10], so index 1 is 10 — no assumption that the
    // steps are one second apart.
    expect(slider.max).toBe('1')
    expect(dialog.querySelector('.dvf-chip-slider-readout')?.textContent).toBe('Not set')
    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ durationSeconds: 10 }))
    expect(dialog.querySelector('.dvf-chip-slider-readout')?.textContent).toBe('10s')
    expect(slider.getAttribute('aria-valuetext')).toBe('10s')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Length: Not set' }))
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ durationSeconds: null }))
    expect(dialog.querySelector('.dvf-chip-slider-readout')?.textContent).toBe('Not set')
  })

  it('says "not set" on the slider readout until a length is dragged in', async () => {
    installHost(chipSelection())
    const dialog = await openMenu()
    const slider = within(dialog).getByRole('slider', { name: 'Length' })
    // The thumb sits at the first declared value, but that position is not a choice.
    expect((slider as HTMLInputElement).value).toBe('0')
    expect(slider.getAttribute('aria-valuetext')).toBe('Not set')
    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(slider.getAttribute('aria-valuetext')).toBe('10s'))
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
    // Durations: 5 and 10 from Seedance 2.0, 6 from Hailuo — the union, sorted.
    const slider = within(dialog).getByRole('slider', { name: 'Length' }) as HTMLInputElement
    expect(slider.max).toBe('2')
    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ durationSeconds: 6 }))
    // The hint appears once per parameter, because none of them has a model to read from.
    expect(within(dialog).getAllByText(en['chip.unionHint'])).toHaveLength(3)
  })

  it('keeps a single declared length as a button rather than a one-stop slider', async () => {
    installHost(chipSelection({ model: 'seedance-fast' }))
    const dialog = await openMenu()
    expect(within(dialog).getByRole('button', { name: '5s' })).toBeDefined()
    expect(within(dialog).queryByRole('slider', { name: 'Length' })).toBeNull()
  })

  it('keeps the slider usable while a save is in flight, and disables the buttons', async () => {
    const fake = installHost(chipSelection())
    const previous = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') await gate
      return previous(input, init)
    }))
    const dialog = await openMenu()
    const slider = within(dialog).getByRole('slider', { name: 'Length' }) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Length: Not set' }).hasAttribute('disabled')).toBe(true))
    // The thumb follows the drag; disabling it here is what used to cut a drag
    // off after one step.
    expect(slider.disabled).toBe(false)
    expect(slider.value).toBe('1')
    release()
    await waitFor(() => expect(fake.saves.at(-1)).toMatchObject({ durationSeconds: 10 }))
  })

  it('follows a multi-step drag and merges its writes into two requests', async () => {
    installHost(chipSelection({ model: 'seedance-long' }), [LONG_PROVIDER])
    const previous = globalThis.fetch as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const posts: ChipSelection[] = []
    const resolvePost: Array<() => void> = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') !== 'POST') return previous(input, init)
      const body = JSON.parse(String(init?.body ?? '{}')) as ChipSelection
      posts.push(body)
      return new Promise<Response>(resolve => {
        resolvePost.push(() => { resolve(json({ ok: true, session: 's1', selection: body })) })
      })
    }))
    const dialog = await openMenu()
    const slider = within(dialog).getByRole('slider', { name: 'Length' }) as HTMLInputElement
    const readout = (): string | null | undefined => dialog.querySelector('.dvf-chip-slider-readout')?.textContent

    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(slider.value).toBe('1'))
    fireEvent.change(slider, { target: { value: '2' } })
    await waitFor(() => expect(slider.value).toBe('2'))
    fireEvent.change(slider, { target: { value: '3' } })
    await waitFor(() => expect(slider.value).toBe('3'))

    expect(slider.disabled).toBe(false)
    expect(readout()).toBe('20s')
    expect(slider.getAttribute('aria-valuetext')).toBe('20s')
    expect(posts).toHaveLength(1)

    resolvePost[0]!()
    await waitFor(() => expect(posts).toHaveLength(2))
    // The merged write carries the value the thumb settled on, not an
    // intermediate one.
    expect(posts[1]!.durationSeconds).toBe(20)
    expect(readout()).toBe('20s')

    resolvePost[1]!()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Length: Not set' }).hasAttribute('disabled')).toBe(false))
    expect(posts).toHaveLength(2)
    expect(readout()).toBe('20s')
  })

  it('puts the readout back on the stored value when the write fails', async () => {
    const fake = installHost(chipSelection())
    const dialog = await openMenu()
    const slider = within(dialog).getByRole('slider', { name: 'Length' }) as HTMLInputElement
    fake.failSave = 'the selection file could not be read; not overwriting it'
    fireEvent.change(slider, { target: { value: '1' } })
    await waitFor(() => expect(within(dialog).getByText(/Not saved: the selection file could not be read/)).toBeDefined())
    // The host still says "no length", so the optimistic value is dropped.
    expect(slider.value).toBe('0')
    expect(dialog.querySelector('.dvf-chip-slider-readout')?.textContent).toBe('Not set')
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

describe('a stored row the build knows but that declares nothing', () => {
  it('offers the documented parameters and says where they came from', async () => {
    const stored: ChipProvider = {
      id: 'ark',
      protocol: 'ark-seedance',
      credential: { configured: true, masked: 'sk…1234', error: null },
      models: [{
        id: 'doubao-seedance-2-5-260628',
        label: 'Doubao-Seedance-2.5',
        modes: ['t2v', 'i2v', 'flf2v'],
        durations: [],
        resolutions: [],
        aspectRatios: [],
        cancelable: true,
      }],
    }
    installHost(chipSelection({ provider: 'ark', model: 'doubao-seedance-2-5-260628' }), [stored])
    const dialog = await openMenu()

    expect(within(dialog).getByRole('slider', { name: 'Length' }).getAttribute('max')).toBe('26')
    expect(dialog.querySelector('.dvf-chip-slider-readout')?.textContent).toBe('Not set')
    expect(within(dialog).getByRole('button', { name: '1080p' })).toBeDefined()
    expect(within(dialog).getByRole('button', { name: '21:9' })).toBeDefined()
    expect(within(dialog).getByText(en['chip.presetCapabilities'])).toBeDefined()
    expect(within(dialog).queryByText(en['chip.undeclared'])).toBeNull()
    fireEvent.change(within(dialog).getByRole('slider', { name: 'Length' }), { target: { value: '26' } })
    await waitFor(() => expect(host.saves.at(-1)).toMatchObject({ durationSeconds: 30 }))
  })
})
