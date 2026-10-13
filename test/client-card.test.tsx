/**
 * The browser half: the pure card derivations, the rendered markup (including the
 * fact that a finished generation really does produce a `<video controls>`), and
 * the registrations `apply` performs.
 *
 * The registrations are asserted through a recording `ctx` stub. Their option
 * *shapes* are checked at compile time against the published slot declarations —
 * which is what the type-only imports in `src/client/index.ts` are for — so this
 * file asserts the values and the callbacks, not the types.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VideoActionRow, VideoGenerateRow, VideoStatusRow, type Translate } from '../src/client/cards.tsx'
import { blockFacts, formatBytes, generateMeta, resolveMediaUrl, statusMeta } from '../src/client/video-card-model.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import type { Context } from '@deepseek-ai/cordis'

const t: Translate = (key, params) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

const GENERATE_META = {
  taskId: 'v-20261013-0001',
  provider: 'ark',
  model: 'doubao-seedance-1-0-pro',
  status: 'succeeded',
  progress: 1,
  artifact: { path: '/home/me/.dsh/dsh-video-forge/outputs/v-20261013-0001/v-20261013-0001.mp4', url: 'video-forge/media/v-20261013-0001/abc/clip.mp4', mime: 'video/mp4', bytes: 4_194_304 },
}

const resultBlock = (meta: unknown, over: Record<string, unknown> = {}): unknown => ({
  kind: 'tool-result',
  seq: 5,
  time: 1,
  callId: 'c1',
  call: { name: 'video_generate', argsRaw: '{"prompt":"a fox in snow"}' },
  callTime: 0,
  content: [{ type: 'text', text: 'finished' }],
  isError: false,
  meta,
  subCalls: [],
  ...over,
})

describe('card derivations', () => {
  it('narrows a settled generate result', () => {
    const facts = blockFacts(resultBlock(GENERATE_META))
    expect(facts.phase).toBe('result')
    expect(generateMeta(facts.meta)?.taskId).toBe('v-20261013-0001')
  })

  it('returns null for a payload that is not ours, so the generic row is used', () => {
    expect(generateMeta({ something: 'else' })).toBeNull()
    expect(statusMeta({ tasks: 'not an array' })).toBeNull()
    expect(generateMeta(undefined)).toBeNull()
  })

  it('drops unusable rows from a status list instead of failing the whole card', () => {
    const rows = statusMeta({ tasks: [{ task_id: 'a', status: 'running' }, { nope: true }] })
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.taskId).toBe('a')
  })

  it('resolves a document-relative media URL against the document base', () => {
    expect(resolveMediaUrl('video-forge/media/a/b/c.mp4', 'http://127.0.0.1:3080/'))
      .toBe('http://127.0.0.1:3080/video-forge/media/a/b/c.mp4')
    expect(resolveMediaUrl('video-forge/media/a/b/c.mp4', 'http://127.0.0.1:3080/dsh/'))
      .toBe('http://127.0.0.1:3080/dsh/video-forge/media/a/b/c.mp4')
    expect(resolveMediaUrl('https://cdn.example/x.mp4', 'http://127.0.0.1:3080/')).toBe('https://cdn.example/x.mp4')
    expect(resolveMediaUrl('/etc/passwd', 'file:///')).toBeNull()
  })

  it('narrows the running phase without arguments', () => {
    const facts = blockFacts({ phase: 'preparing', callId: 'c1', name: 'video_generate', turn: 1, step: 1, time: 1, subCalls: [] })
    expect(facts.phase).toBe('preparing')
    expect(facts.argsRaw).toBe('')
  })

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KiB')
    expect(formatBytes(4_194_304)).toBe('4.0 MiB')
  })
})

describe('rendered markup', () => {
  it('renders a player for a finished generation', () => {
    const html = renderToStaticMarkup(<VideoGenerateRow phase="result" block={resultBlock(GENERATE_META)} t={t} />)
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain('src="http://localhost/video-forge/media/v-20261013-0001/abc/clip.mp4"')
    expect(html).toContain('4.0 MiB')
  })

  it('renders the running state rather than an empty card', () => {
    const html = renderToStaticMarkup(
      <VideoGenerateRow
        phase="start"
        block={{ phase: 'start', callId: 'c1', name: 'video_generate', argsRaw: '{"prompt":"a fox in snow"}', turn: 1, step: 1, time: 1, subCalls: [] }}
        t={t}
      />,
    )
    expect(html).toContain('Generate video')
    expect(html).toContain('a fox in snow')
    expect(html).not.toContain('<video')
  })

  it('renders an error without inventing a player', () => {
    const html = renderToStaticMarkup(
      <VideoGenerateRow
        phase="result"
        block={resultBlock(undefined, { isError: true, content: [{ type: 'text', text: 'provider said no' }] })}
        t={t}
      />,
    )
    expect(html).toContain('Generation failed')
    expect(html).toContain('provider said no')
    expect(html).not.toContain('<video')
  })

  it('lists statuses and links the playable ones', () => {
    const html = renderToStaticMarkup(
      <VideoStatusRow
        phase="result"
        block={resultBlock({ tasks: [
          { task_id: 'v-1', provider: 'ark', model: 'm', status: 'succeeded', progress: 1, play_url: 'video-forge/media/v-1/tok/out.mp4', error: null },
          { task_id: 'v-2', provider: 'ark', model: 'm', status: 'failed', progress: null, play_url: null, error: 'boom' },
        ] })}
        t={t}
      />,
    )
    expect(html).toContain('v-1')
    expect(html).toContain('http://localhost/video-forge/media/v-1/tok/out.mp4')
    expect(html).toContain('2 task(s)')
    expect(html).toContain('boom')
  })

  it('renders the action row for cancel and export', () => {
    const block = { phase: 'start', callId: 'c', name: 'video_export', argsRaw: '{"task_id":"v-1","target_path":"/tmp/a.mp4"}', turn: 1, step: 1, time: 1, subCalls: [] }
    expect(renderToStaticMarkup(<VideoActionRow phase="start" block={block} t={t} />)).toContain('Export video')
    const cancel = { ...block, name: 'video_cancel', argsRaw: '{"task_id":"v-1"}' }
    expect(renderToStaticMarkup(<VideoActionRow phase="start" block={cancel} t={t} />)).toContain('Cancel video task')
  })
})

describe('client apply', () => {
  it('registers every wire tool name under the shared locale namespace', () => {
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      effect: (fn: () => (() => void) | void) => {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      locale: { register: localeRegister, bind: () => t },
      slots: {
        inject: (_slot: string, callback: () => unknown) => callback(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    } as unknown as Context

    apply(ctx)

    expect(localeRegister).toHaveBeenCalledWith(NS, { zh, en })
    expect(inject).toEqual(['slots', 'locale'])
    const registered = registrations.map(entry => entry.options)
    expect(registered.every(options => options['name'] === 'tool.call.toolview')).toBe(true)
    expect(registered.map(options => options['key']).sort())
      .toEqual(['video_cancel', 'video_export', 'video_generate', 'video_status'])
    expect(registered.every(options => options['locale'] === NS)).toBe(true)
    expect(registrations.every(entry => typeof entry.component === 'function')).toBe(true)
  })

  it('ships both dictionaries with identical keys', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
