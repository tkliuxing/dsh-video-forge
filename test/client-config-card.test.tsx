// @vitest-environment jsdom
/**
 * The configuration card's write path.
 *
 * What it edits and what it sends are the two things worth pinning: a value the
 * operator changed must reach the host as the right path op, and text that is not
 * valid JSON must be refused locally instead of being written as a string.
 *
 * The panel's own behaviour is covered by the API tests plus the pure helpers
 * below; a full interaction sweep of the workbench page would need a scripted
 * fetch face and belongs with the M2 follow-up on the panel's UX.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsCard, type ClientConfigShape, type ConfigPatch } from '../src/client/settings-card.tsx'
import { formatBytes, safeUrl } from '../src/client/panel.tsx'
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

function bench(): {
  save: ReturnType<typeof vi.fn<(ops: readonly ConfigPatch[]) => Promise<boolean>>>
  useConfig: () => { status: 'ready'; value: ClientConfigShape; writable: boolean }
} {
  const save = vi.fn(async () => true)
  return { save, useConfig: () => ({ status: 'ready', value: CONFIG, writable: true }) }
}

describe('configuration card', () => {
  it('writes a changed scalar as one path op', async () => {
    const b = bench()
    render(<SettingsCard t={t} useConfig={b.useConfig} save={b.save} />)

    const field = screen.getByLabelText(en['config.maxConcurrent'])
    fireEvent.change(field, { target: { value: '3' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(b.save.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['maxConcurrent'], value: 3 }])
  })

  it('refuses invalid provider JSON instead of writing it', async () => {
    const b = bench()
    render(<SettingsCard t={t} useConfig={b.useConfig} save={b.save} />)

    const editor = screen.getByLabelText(`${en['config.providers']} (JSON)`)
    fireEvent.change(editor, { target: { value: '{ not json' } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(screen.getByText(/not valid JSON/)).toBeTruthy() })
    expect(b.save).not.toHaveBeenCalled()
  })

  it('writes a valid provider array through the same op', async () => {
    const b = bench()
    render(<SettingsCard t={t} useConfig={b.useConfig} save={b.save} />)

    const editor = screen.getByLabelText(`${en['config.providers']} (JSON)`) as HTMLTextAreaElement
    const next = [{ id: 'relay', protocol: 'generic-openai-videos', baseUrl: 'https://relay.example/v1', models: [] }]
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } })
    fireEvent.click(screen.getByText(en['config.save']))

    await waitFor(() => { expect(b.save).toHaveBeenCalledTimes(1) })
    expect(b.save.mock.calls[0]?.[0]).toEqual([{ op: 'set', path: ['providers'], value: next }])
  })

  it('reports a refusal as not saved', async () => {
    const save = vi.fn(async () => false)
    render(<SettingsCard t={t} useConfig={() => ({ status: 'ready', value: CONFIG, writable: true })} save={save} />)
    fireEvent.change(screen.getByLabelText(en['config.maxConcurrent']), { target: { value: '5' } })
    fireEvent.click(screen.getByText(en['config.save']))
    await waitFor(() => { expect(screen.getByText(en['config.saveFailed'])).toBeTruthy() })
  })

  it('keeps the save control disabled until something changes', () => {
    const b = bench()
    render(<SettingsCard t={t} useConfig={b.useConfig} save={b.save} />)
    expect((screen.getByText(en['config.save']) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(en['config.pollInterval']), { target: { value: '9000' } })
    expect((screen.getByText(en['config.save']) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says so when the composition does not allow editing', () => {
    const b = bench()
    render(<SettingsCard t={t} useConfig={() => ({ status: 'ready', value: CONFIG, writable: false })} save={b.save} />)
    expect(screen.getByText(en['config.readonly'])).toBeTruthy()
    expect((screen.getByText(en['config.save']) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('workbench helpers', () => {
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
