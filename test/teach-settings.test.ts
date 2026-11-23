/**
 * Where the teaching route gets its paths (DESIGN §23).
 *
 * The settings page is the only place a GUI user can correct a path, so it must
 * win over the environment variable that was set when the host started — that is
 * the whole reason these fields exist.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { teachPaths, voiceAuthRefFor } from '../src/teach/probe.ts'
import { DEFAULT_TEACH_SETTINGS, DEFAULT_VOICE_AUTH_REF, DEFAULT_VOICE_AUTH_REFS, teachSettings, type VideoForgeSettings } from '../src/settings.ts'

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
  it('gives each voice provider its own reference by default', () => {
    const resolved = teachSettings(settingsWith())
    expect(resolved.voiceAuthRefDeepseek).toBe('DEEPSEEK_API_KEY')
    expect(resolved.voiceAuthRefVolcengine).toBe(DEFAULT_VOICE_AUTH_REF)
    expect(resolved.pythonPath).toBe('')
  })

  it('ignores blank fields rather than accepting a whitespace path or reference', () => {
    const resolved = teachSettings(settingsWith({ pythonPath: '   ', voiceAuthRefDeepseek: '  ', voiceAuthRefVolcengine: ' ' }))
    expect(resolved.pythonPath).toBe('')
    expect(resolved.voiceAuthRefDeepseek).toBe('DEEPSEEK_API_KEY')
    expect(resolved.voiceAuthRefVolcengine).toBe(DEFAULT_VOICE_AUTH_REF)
  })
})

describe('voice credential references', () => {
  it('reads the reference belonging to the provider, never the other one', () => {
    const teach = teachSettings(settingsWith({ voiceAuthRefDeepseek: 'MY_DEEPSEEK_KEY', voiceAuthRefVolcengine: 'MY_VOICE_KEY' }))
    expect(voiceAuthRefFor(teach, 'deepseek')).toBe('MY_DEEPSEEK_KEY')
    expect(voiceAuthRefFor(teach, 'volcengine')).toBe('MY_VOICE_KEY')
  })

  it('falls back per provider, so configuring one leaves the other alone', () => {
    const teach = teachSettings(settingsWith({ voiceAuthRefDeepseek: 'MY_DEEPSEEK_KEY' }))
    expect(voiceAuthRefFor(teach, 'deepseek')).toBe('MY_DEEPSEEK_KEY')
    expect(voiceAuthRefFor(teach, 'volcengine')).toBe(DEFAULT_VOICE_AUTH_REFS.volcengine)
  })

  it('keeps the volcengine name as the fallback for a provider it does not know', () => {
    expect(voiceAuthRefFor(teachSettings(settingsWith()), 'some-other-voice')).toBe(DEFAULT_VOICE_AUTH_REF)
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

  it('carries one credential reference per voice provider, not a hard-coded one', () => {
    const paths = teachPaths(settingsWith({ voiceAuthRefDeepseek: 'MY_DEEPSEEK_KEY', voiceAuthRefVolcengine: 'MY_VOICE_KEY' }))
    expect(paths.voiceAuthRefs).toEqual({ deepseek: 'MY_DEEPSEEK_KEY', volcengine: 'MY_VOICE_KEY' })
    expect(teachPaths(settingsWith()).voiceAuthRefs).toEqual({ deepseek: 'DEEPSEEK_API_KEY', volcengine: DEFAULT_VOICE_AUTH_REF })
  })
})
