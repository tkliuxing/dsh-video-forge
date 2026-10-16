// @vitest-environment jsdom
/**
 * The configuration card's write path.
 *
 * What it edits and what it sends are the two things worth pinning: a value the
 * operator changed must reach the host as the right path op, and text that is not
 * valid JSON must be refused locally instead of being written as a string.
 *
 * The panel API's own behaviour is covered by its tests; the helpers below are
 * the pure ones the configuration card shares with the chat cards.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsCard, type ClientConfigShape, type ConfigPatch, type CredentialState } from '../src/client/settings-card.tsx'
import { formatBytes, resolveMediaUrl as safeUrl } from '../src/client/video-card-model.ts'
import { en } from '../src/client/locales.ts'
import type { VideoForgeKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: VideoForgeKey, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

const CONFIG: ClientConfigShape = {
  enabled: true,
  providers: [{ id: 'ark', protocol: 'ark-seedance', baseUrl: 'https://ark.example', authRef: 'ARK_API_KEY', models: [] }],
  defaultProvider: 'ark',
  defaultModel: '',
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
  describeCredential: ReturnType<typeof vi.fn<(ref: string) => Promise<CredentialState>>>
  setCredential: ReturnType<typeof vi.fn<(ref: string, value: string) => Promise<string | null>>>
  unsetCredential: ReturnType<typeof vi.fn<(ref: string) => Promise<string | null>>>
  useConfig: () => { status: 'ready'; value: ClientConfigShape; writable: boolean }
}

function bench(over: {
  writable?: boolean
  credential?: Partial<CredentialState>
  setCredential?: (ref: string, value: string) => Promise<string | null>
} = {}): Bench {
  const save = vi.fn(async () => true)
  const describeCredential = vi.fn(async (): Promise<CredentialState> => ({
    configured: false,
    source: null,
    writable: true,
    error: null,
    ...over.credential,
  }))
  const setCredential = vi.fn(over.setCredential ?? (async () => null))
  const unsetCredential = vi.fn(async () => null)
  return {
    save,
    describeCredential,
    setCredential,
    unsetCredential,
    useConfig: () => ({ status: 'ready', value: CONFIG, writable: over.writable ?? true }),
  }
}

/** Props for one render, so each test states only what it varies. */
function props(b: Bench, t: (key: VideoForgeKey, params?: Record<string, unknown>) => string) {
  return {
    t,
    useConfig: b.useConfig,
    save: b.save,
    describeCredential: b.describeCredential,
    setCredential: b.setCredential,
    unsetCredential: b.unsetCredential,
  }
}

describe('configuration card', () => {
  it('writes a changed scalar as one path op', async () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)

    const field = screen.getByLabelText(en['config.maxConcurrent'])
    fireEvent.change(field, { target: { value: '3' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(b.save.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['maxConcurrent'], value: 3 }])
  })

  it('refuses invalid provider JSON instead of writing it', async () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)

    const editor = screen.getByLabelText(`${en['config.providers']} (JSON)`)
    fireEvent.change(editor, { target: { value: '{ not json' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(screen.getByText(/not valid JSON/)).toBeTruthy() })
    expect(b.save).not.toHaveBeenCalled()
  })

  it('writes a valid provider array through the same op', async () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)

    const editor = screen.getByLabelText(`${en['config.providers']} (JSON)`) as HTMLTextAreaElement
    const next = [{ id: 'relay', protocol: 'generic-openai-videos', baseUrl: 'https://relay.example/v1', models: [] }]
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(b.save.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['providers'], value: next }])
  })

  it('reports a refusal as not saved', async () => {
    const save = vi.fn(async () => false)
    render(<SettingsCard {...props({ ...bench(), save }, t)} />)
    fireEvent.change(screen.getByLabelText(en['config.maxConcurrent']), { target: { value: '5' } })
    fireEvent.click(screen.getByText(en['config.save']))
    await waitFor(() => { expect(screen.getByText(en['config.saveFailed'])).toBeTruthy() })
  })

  it('keeps the save control disabled until something changes', () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)
    expect((screen.getByText(en['config.save']) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en['config.pollInterval']), { target: { value: '9000' } })
    expect((screen.getByText(en['config.save']) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says so when the composition does not allow editing', () => {
    const b = bench()
    render(<SettingsCard {...props(bench({ writable: false }), t)} />)
    expect(screen.getByText(en['config.readonly'])).toBeTruthy()
    expect((screen.getByText(en['config.save']) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('configuration card: API keys', () => {
  it('stores a key, clears the field, and never keeps the value on the page', async () => {
    const b = bench()
    const { container } = render(<SettingsCard {...props(b, t)} />)

    const field = await screen.findByLabelText(`${en['config.keyLabel']} · ARK_API_KEY`)
    fireEvent.change(field, { target: { value: 'sk-super-secret-value' } })
    fireEvent.click(screen.getByText(en['config.keySave']))

    await waitFor(() => { expect(b.setCredential).toHaveBeenCalledWith('ARK_API_KEY', 'sk-super-secret-value') })
    await waitFor(() => { expect(screen.getByText(en['config.keyStored'])).toBeTruthy() })
    // The write-only contract: after the host has it, the page does not.
    expect((field as HTMLInputElement).value).toBe('')
    expect(container.innerHTML).not.toContain('sk-super-secret-value')
    // And the state is re-read from the host rather than assumed.
    await waitFor(() => { expect(b.describeCredential).toHaveBeenCalledWith('ARK_API_KEY') })
  })

  it('refuses to send an empty value and says why', async () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)
    fireEvent.click(await screen.findByText(en['config.keySave']))
    await waitFor(() => { expect(screen.getByText(en['config.keyRequired'])).toBeTruthy() })
    expect(b.setCredential).not.toHaveBeenCalled()
  })

  it('shows a refusal from the host verbatim', async () => {
    const b = bench({ setCredential: async () => 'credential/rejected: read-only source shadows this reference' })
    render(<SettingsCard {...props(b, t)} />)
    const field = await screen.findByLabelText(`${en['config.keyLabel']} · ARK_API_KEY`)
    fireEvent.change(field, { target: { value: 'x' } })
    fireEvent.click(screen.getByText(en['config.keySave']))
    await waitFor(() => { expect(screen.getByText(/read-only source shadows this reference/)).toBeTruthy() })
  })

  it('disables entry for a credential the host reports as read-only', async () => {
    const b = bench({ credential: { configured: true, source: 'file', writable: false } })
    render(<SettingsCard {...props(b, t)} />)
    const field = await screen.findByLabelText(`${en['config.keyLabel']} · ARK_API_KEY`)
    await waitFor(() => { expect((field as HTMLInputElement).disabled).toBe(true) })
    expect(screen.getByText(en['config.keyReadOnly'])).toBeTruthy()
  })

  it('offers removal only when a key is actually configured', async () => {
    const present = bench({ credential: { configured: true, source: 'user-env' } })
    render(<SettingsCard {...props(present, t)} />)
    const remove = await screen.findByText(en['config.keyClear'])
    await waitFor(() => { expect((remove as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(remove)
    await waitFor(() => { expect(present.unsetCredential).toHaveBeenCalledWith('ARK_API_KEY') })

    cleanup()
    const absent = bench()
    render(<SettingsCard {...props(absent, t)} />)
    const disabled = await screen.findByText(en['config.keyClear'])
    await waitFor(() => { expect((disabled as HTMLButtonElement).disabled).toBe(true) })
  })

  it('shows no key row for a provider that needs no credential', async () => {
    const b = bench()
    const keyless = { ...CONFIG, providers: [{ ...CONFIG.providers[0]!, authRef: '' }] }
    render(<SettingsCard {...props({ ...b, useConfig: () => ({ status: 'ready' as const, value: keyless, writable: true }) }, t)} />)
    await waitFor(() => { expect(screen.queryByText(en['config.keySave'])).toBeNull() })
    expect(b.describeCredential).not.toHaveBeenCalled()
  })
})

describe('shared card helpers', () => {
  it('resolves a document-relative media URL and refuses anything else', () => {
    expect(safeUrl('video-forge/media/v-1/tok/x.mp4', 'http://127.0.0.1:3080/'))
      .toBe('http://127.0.0.1:3080/video-forge/media/v-1/tok/x.mp4')
    expect(safeUrl('https://cdn.example/x.mp4', 'http://127.0.0.1:3080/')).toBe('https://cdn.example/x.mp4')
    expect(safeUrl('/etc/passwd', 'file:///')).toBeNull()
  })

  it('formats byte sizes', () => {
    expect(formatBytes(5_242_880)).toBe('5.0 MiB')
  })
})
