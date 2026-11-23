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

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/**
 * The credential row for one reference.
 *
 * The card now offers a key row for every provider *and* one per voice provider,
 * so "the last save button" is not a stable way to reach a row; a row is found
 * from the field its label names and then searched inside.
 */
const keyLabel = (ref: string) => (content: string): boolean => content.includes(`${en['config.keyLabel']} · ${ref}`)

/** The key field for one reference (its label also carries the stored state, so it is a prefix match). */
function keyField(ref: string): HTMLInputElement {
  return screen.getByLabelText(keyLabel(ref)) as HTMLInputElement
}

async function findKeyField(ref: string): Promise<HTMLInputElement> {
  return await screen.findByLabelText(keyLabel(ref)) as HTMLInputElement
}

/** The credential row for one reference. */
function keyRow(ref: string): HTMLElement {
  const row = keyField(ref).closest('label')?.parentElement
  if (row === null || row === undefined) throw new Error(`no row around the key field for ${ref}`)
  return row
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

    const field = await findKeyField('ARK_API_KEY')
    fireEvent.change(field, { target: { value: 'sk-super-secret-value' } })
    fireEvent.click(within(keyRow('ARK_API_KEY')).getByText(en['config.keySave']))

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
    const field = await findKeyField('ARK_API_KEY')
    fireEvent.click(within(keyRow('ARK_API_KEY')).getByText(en['config.keySave']))
    await waitFor(() => { expect(screen.getByText(en['config.keyRequired'])).toBeTruthy() })
    expect((field as HTMLInputElement).value).toBe('')
    expect(b.setCredential).not.toHaveBeenCalled()
  })

  it('shows a refusal from the host verbatim', async () => {
    const b = bench({ setCredential: async () => 'credential/rejected: read-only source shadows this reference' })
    render(<SettingsCard {...props(b, t)} />)
    const field = await findKeyField('ARK_API_KEY')
    fireEvent.change(field, { target: { value: 'x' } })
    fireEvent.click(within(keyRow('ARK_API_KEY')).getByText(en['config.keySave']))
    await waitFor(() => { expect(screen.getByText(/read-only source shadows this reference/)).toBeTruthy() })
  })

  it('disables entry for a credential the host reports as read-only', async () => {
    const b = bench({ credential: { configured: true, source: 'file', writable: false } })
    render(<SettingsCard {...props(b, t)} />)
    const field = await findKeyField('ARK_API_KEY')
    await waitFor(() => { expect(field.disabled).toBe(true) })
    expect(within(keyRow('ARK_API_KEY')).getByText(en['config.keyReadOnly'])).toBeTruthy()
  })

  it('offers removal only when a key is actually configured', async () => {
    const present = bench({ credential: { configured: true, source: 'user-env' } })
    render(<SettingsCard {...props(present, t)} />)
    await findKeyField('ARK_API_KEY')
    const remove = within(keyRow('ARK_API_KEY')).getByText(en['config.keyClear']) as HTMLButtonElement
    await waitFor(() => { expect(remove.disabled).toBe(false) })
    fireEvent.click(remove)
    await waitFor(() => { expect(present.unsetCredential).toHaveBeenCalledWith('ARK_API_KEY') })

    cleanup()
    const absent = bench()
    render(<SettingsCard {...props(absent, t)} />)
    await findKeyField('ARK_API_KEY')
    const disabled = within(keyRow('ARK_API_KEY')).getByText(en['config.keyClear']) as HTMLButtonElement
    await waitFor(() => { expect(disabled.disabled).toBe(true) })
  })

  it('shows no key row for a provider that needs no credential', async () => {
    const b = bench()
    const keyless = { ...CONFIG, providers: [{ ...CONFIG.providers[0]!, authRef: '' }] }
    render(<SettingsCard {...props({ ...b, useConfig: () => ({ status: 'ready' as const, value: keyless, writable: true }) }, t)} />)
    // The voice rows are always offered; the keyless provider is the one that has none.
    await waitFor(() => { expect(screen.queryByLabelText(keyLabel('ARK_API_KEY'))).toBeNull() })
    expect(b.describeCredential).not.toHaveBeenCalledWith('ARK_API_KEY')
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

describe('configuration card: teaching route', () => {
  it('keeps the teaching fields behind a toggle and writes them as config ops', async () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)

    // Collapsed by default: a slides-only operator never sees (or probes) this.
    expect(screen.queryByText(en['config.pythonPath'])).toBeNull()

    fireEvent.click(screen.getByText(en['config.teach']))

    const python = await screen.findByLabelText(en['config.pythonPath'])
    const tex = screen.getByLabelText(en['config.texBinPath'])
    const chromium = screen.getByLabelText(en['config.chromiumPath'])
    fireEvent.change(python, { target: { value: '/opt/teach/python3' } })
    fireEvent.change(tex, { target: { value: '/opt/teach/texbin' } })
    fireEvent.change(chromium, { target: { value: '/opt/teach/chromium' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(b.save.mock.calls[0]?.[0]).toEqual([
      { op: 'set', path: ['teachPythonPath'], value: '/opt/teach/python3' },
      { op: 'set', path: ['teachTexBinPath'], value: '/opt/teach/texbin' },
      { op: 'set', path: ['teachChromiumPath'], value: '/opt/teach/chromium' },
    ])
  })

  it('reports the state of both voice keys after one of them is saved', async () => {
    // Saving one key asks the host about that reference only, so the other row's
    // state has to survive the refresh rather than be replaced by it.
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)
    fireEvent.click(screen.getByText(en['config.teach']))
    const field = await findKeyField('ARK_VOICE_API_KEY')
    fireEvent.change(field, { target: { value: 'voice-secret' } })
    fireEvent.click(within(keyRow('ARK_VOICE_API_KEY')).getByText(en['config.keySave']))
    await waitFor(() => { expect(b.setCredential).toHaveBeenCalledWith('ARK_VOICE_API_KEY', 'voice-secret') })
    await waitFor(() => {
      const header = screen.getByText(new RegExp(`${en['config.teachVoice']}:`))
      expect(header.textContent).toContain('DeepSeek')
      expect(header.textContent).toContain('volcengine')
      expect(header.textContent).not.toContain(en['config.credentialUnreadable'])
    })
  })

  it('offers one key row per voice provider, named by a reference, never as config text', async () => {
    const b = bench()
    render(<SettingsCard {...props(b, t)} />)

    // Both keys are reachable without opening the teaching section: the collapsed
    // header says whether each is stored, which is the question this row answers.
    await waitFor(() => {
      expect(b.describeCredential).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
      expect(b.describeCredential).toHaveBeenCalledWith('ARK_VOICE_API_KEY')
    })
    expect(screen.getByText(new RegExp(`${en['config.teachVoice']}.*DeepSeek`))).toBeTruthy()

    fireEvent.click(screen.getByText(en['config.teach']))

    // Each row carries its own reference, defaulting to that provider's own name.
    expect((await screen.findByDisplayValue('DEEPSEEK_API_KEY') as HTMLInputElement).value).toBe('DEEPSEEK_API_KEY')
    const volcengineRef = screen.getByDisplayValue('ARK_VOICE_API_KEY')
    fireEvent.change(volcengineRef, { target: { value: 'MY_VOICE_KEY' } })

    // Renaming one leaves the other alone: a key stored for one product is not a
    // key for the other.
    expect((screen.getByDisplayValue('DEEPSEEK_API_KEY') as HTMLInputElement).value).toBe('DEEPSEEK_API_KEY')
    const key = await findKeyField('MY_VOICE_KEY')
    fireEvent.change(key, { target: { value: 'voice-secret' } })
    fireEvent.click(within(keyRow('MY_VOICE_KEY')).getByText(en['config.keySave']))
    await waitFor(() => { expect(b.setCredential).toHaveBeenCalledWith('MY_VOICE_KEY', 'voice-secret') })
    expect(b.save).not.toHaveBeenCalled()
  })
})
