/**
 * Where the teaching route gets its paths (DESIGN §23).
 *
 * The settings page is the only place a GUI user can correct a path, so it must
 * win over the environment variable that was set when the host started — that is
 * the whole reason these fields exist.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { teachPaths } from '../src/teach/probe.ts'
import { DEFAULT_TEACH_SETTINGS, DEFAULT_VOICE_AUTH_REF, teachSettings, type VideoForgeSettings } from '../src/settings.ts'

const settingsWith = (teach?: Partial<typeof DEFAULT_TEACH_SETTINGS>): VideoForgeSettings => ({
  enabled: true,
  providers: [],
  defaultProvider: '',
  defaultModel: '',
  outputDir: '',
  pollIntervalMs: 5000,
  waitSecondsMax: 600,
  dedupeWindowSeconds: 120,
  maxConcurrent: 1,
  maxTasks: 200,
  maxGiB: 20,
  requestTimeoutMs: 30_000,
  priceTable: { currency: 'CNY', pricedAt: '', source: '', rows: [] },
  ...(teach === undefined ? {} : { teach: { ...DEFAULT_TEACH_SETTINGS, ...teach } }),
})

afterEach(() => {
  delete process.env.TEACH_PYTHON
  delete process.env.TEACH_TEXBIN
  delete process.env.TEACH_CHROMIUM
})

describe('teachSettings', () => {
  it('falls back to the reference this build has always used', () => {
    const resolved = teachSettings(settingsWith())
    expect(resolved.voiceAuthRef).toBe(DEFAULT_VOICE_AUTH_REF)
    expect(resolved.pythonPath).toBe('')
  })

  it('ignores blank fields rather than accepting a whitespace path', () => {
    const resolved = teachSettings(settingsWith({ pythonPath: '   ', voiceAuthRef: '  ' }))
    expect(resolved.pythonPath).toBe('')
    expect(resolved.voiceAuthRef).toBe(DEFAULT_VOICE_AUTH_REF)
  })
})

describe('teachPaths precedence', () => {
  it('prefers the setting over the environment variable', () => {
    process.env.TEACH_PYTHON = '/env/python3'
    process.env.TEACH_TEXBIN = '/env/texbin'
    process.env.TEACH_CHROMIUM = '/env/chromium'
    const paths = teachPaths(settingsWith({ pythonPath: '/set/python3', texBinPath: '/set/texbin', chromiumPath: '/set/chromium' }))
    expect(paths.pythonPath).toBe('/set/python3')
    expect(paths.texBinPath).toBe('/set/texbin')
    expect(paths.chromiumPath).toBe('/set/chromium')
  })

  it('uses the environment variable when the setting is empty', () => {
    process.env.TEACH_PYTHON = '/env/python3'
    const paths = teachPaths(settingsWith({ pythonPath: '' }))
    expect(paths.pythonPath).toBe('/env/python3')
  })

  it('reports null when neither names a path, leaving discovery to the caller', () => {
    const paths = teachPaths(settingsWith())
    expect(paths.pythonPath).toBeNull()
    expect(paths.texBinPath).toBeNull()
    expect(paths.chromiumPath).toBeNull()
  })

  it('carries the configured credential reference, not a hard-coded one', () => {
    expect(teachPaths(settingsWith({ voiceAuthRef: 'MY_VOICE_KEY' })).voiceAuthRef).toBe('MY_VOICE_KEY')
    expect(teachPaths(settingsWith()).voiceAuthRef).toBe(DEFAULT_VOICE_AUTH_REF)
  })
})
