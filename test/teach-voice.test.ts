import { describe, expect, it } from 'vitest'
import { assembleVoiceBody, foldVoiceLine, parseVoiceBody, VoiceError } from '../src/teach/voice.ts'

/** One line as the service actually emits it: base64 audio plus the sentence entry. */
const audioLine = (text: string, words: [string, number, number][], payload = 'AAECAw==') =>
  JSON.stringify({
    code: 0,
    message: '',
    data: payload,
    sentence: {
      text,
      phonemes: [],
      words: words.map(([word, startTime, endTime]) => ({ word, startTime, endTime, confidence: 0.9 })),
    },
  })

const TERMINAL = JSON.stringify({ code: 20000000, message: 'OK', usage: { text_words: 13 } })

describe('voice response assembly', () => {
  it('collects audio, converts seconds to whole milliseconds and keeps the usage', () => {
    const body = [
      JSON.stringify({ code: 0, message: '', data: 'AAECAw==' }),
      audioLine('先看一个完全平方数的倒数。', [['先', 0, 0.2], ['看', 0.2, 0.39], ['来个', 0.39, 0.715]]),
      TERMINAL,
    ].join('\n')
    const result = assembleVoiceBody(body, 'logid-1')
    expect(result.audio.byteLength).toBe(8)
    expect(result.words).toEqual([
      { t: '先', b: 0, e: 200 },
      { t: '看', b: 200, e: 390 },
      { t: '来个', b: 390, e: 715 },
    ])
    expect(result.usage).toEqual({ text_words: 13 })
    expect(result.logId).toBe('logid-1')
  })

  it('drops the accumulated entry, which would otherwise shift every later offset', () => {
    const body = [
      audioLine('第一句。', [['第一', 0, 0.4], ['句', 0.4, 0.8]]),
      // The service repeats the whole text so far with no word list.
      audioLine('第一句。第二句。', []),
      audioLine('第二句。', [['第二', 2.62, 2.9], ['句', 2.9, 3.3]]),
    ].join('\n')
    const result = assembleVoiceBody(body)
    expect(result.sentences.map(sentence => sentence.text)).toEqual(['第一句。', '第二句。'])
    expect(result.words.map(word => word.b)).toEqual([0, 400, 2620, 2900])
  })

  it('ignores blank lines and tolerates a missing usage record', () => {
    const body = `\n\n${audioLine('好。', [['好', 0, 0.3]])}\n\n`
    const result = assembleVoiceBody(body)
    expect(result.usage).toBeNull()
    expect(result.words).toHaveLength(1)
  })

  it('surfaces the service code and request id on a failure line', () => {
    const body = JSON.stringify({ code: 45000010, message: 'acquire failed', reqid: 'r-1' })
    expect(() => assembleVoiceBody(body)).toThrowError(/45000010|acquire failed/)
    try {
      assembleVoiceBody(body)
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceError)
      expect((error as VoiceError).code).toBe(45000010)
    }
  })

  it('refuses an answer with audio but no word timings, which is a request that forgot enable_subtitle', () => {
    const body = JSON.stringify({ code: 0, message: '', data: 'AAECAw==' })
    expect(() => assembleVoiceBody(body)).toThrow(/audio_params.enable_subtitle/)
  })

  it('refuses an answer with timings but no audio', () => {
    const body = audioLine('好。', [['好', 0, 0.3]], '')
    expect(() => assembleVoiceBody(body)).toThrow(/carried no audio/)
  })

  it('refuses a body that is not NDJSON', () => {
    expect(() => parseVoiceBody('<html>gateway</html>')).toThrow(/not JSON/)
    expect(() => assembleVoiceBody('<html>gateway</html>')).toThrow(/not JSON/)
  })

  it('folds one line at a time without keeping the raw payload around', () => {
    const into = { audio: [] as Uint8Array[], sentences: [] as { text: string, words: { t: string, b: number, e: number }[] }[], usage: null as Record<string, number> | null }
    foldVoiceLine(JSON.parse(audioLine('好。', [['好', 0.1, 0.35]])) as Parameters<typeof foldVoiceLine>[0], into)
    expect(into.audio).toHaveLength(1)
    expect(into.sentences[0]?.words).toEqual([{ t: '好', b: 100, e: 350 }])
  })
})
