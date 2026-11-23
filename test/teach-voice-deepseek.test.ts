/**
 * The DeepSeek voice provider (api-docs.deepseek.com, /v1/tools/tts).
 *
 * What the docs promised, checked here against a stubbed socket: one POST, a
 * Bearer key, `{ text, voice_id, format }`, audio back. The important property
 * for this plugin is what the response does *not* contain — word timings — so
 * the provider must report `timestamps: 'none'` rather than let the recorder
 * place cues on invented moments.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesizeDeepseek, VoiceError } from '../src/teach/voice.ts'
import { voiceAuthRefFor } from '../src/teach/tools.ts'
import { DEFAULT_VOICE_AUTH_REF } from '../src/settings.ts'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

function stub(audio = new Uint8Array([1, 2, 3, 4]), init: { status?: number, body?: string, headers?: Record<string, string> } = {}) {
  const calls: { url: string, init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    calls.push({ url, init: options })
    return new Response(init.body ?? audio, {
      status: init.status ?? 200,
      headers: { 'content-type': 'audio/wav', ...(init.headers ?? {}) },
    })
  }) as unknown as typeof fetch
  return calls
}

describe('DeepSeek TTS', () => {
  it('posts the documented body and reports that it carries no word timings', async () => {
    const calls = stub()
    const result = await synthesizeDeepseek({ text: '  你好，我是 DeepSeek。 ', apiKey: 'k-voice', voiceId: 'tide' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.deepseek.com/v1/tools/tts')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer k-voice')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: '你好，我是 DeepSeek。', voice_id: 'tide', format: 'wav', filter_markdown: true })
    expect(result.audio.byteLength).toBe(4)
    expect(result.timestamps).toBe('none')
    expect(result.words).toEqual([])
    expect(result.sentences[0]?.text).toBe('你好，我是 DeepSeek。')
  })

  it('omits voice_id when the manuscript names none, letting the service default', async () => {
    const calls = stub()
    await synthesizeDeepseek({ text: '好。', apiKey: 'k' })
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('voice_id')
  })

  it('surfaces the status and the body on a refusal', async () => {
    stub(new Uint8Array(), { status: 400, body: '{"error":{"message":"Content Exists Risk"}}' })
    await expect(synthesizeDeepseek({ text: 'x', apiKey: 'k' })).rejects.toThrow(/400.*Content Exists Risk/s)
  })

  it('refuses an empty text and a missing key before any request', async () => {
    const calls = stub()
    await expect(synthesizeDeepseek({ text: '  ', apiKey: 'k' })).rejects.toBeInstanceOf(VoiceError)
    await expect(synthesizeDeepseek({ text: '好。', apiKey: ' ' })).rejects.toThrow(/DEEPSEEK_API_KEY/)
    expect(calls).toHaveLength(0)
  })

  it('refuses an empty audio body instead of writing a zero-byte narration', async () => {
    stub(new Uint8Array())
    await expect(synthesizeDeepseek({ text: '好。', apiKey: 'k' })).rejects.toThrow(/returned no audio/)
  })
})

describe('voice credential reference', () => {
  it('falls back to each provider\'s own default reference', () => {
    expect(voiceAuthRefFor('', 'volcengine')).toBe(DEFAULT_VOICE_AUTH_REF)
    expect(voiceAuthRefFor(DEFAULT_VOICE_AUTH_REF, 'deepseek')).toBe('DEEPSEEK_API_KEY')
  })

  it('keeps an explicit override for either provider', () => {
    expect(voiceAuthRefFor('MY_VOICE_KEY', 'volcengine')).toBe('MY_VOICE_KEY')
    expect(voiceAuthRefFor('MY_VOICE_KEY', 'deepseek')).toBe('MY_VOICE_KEY')
  })
})
