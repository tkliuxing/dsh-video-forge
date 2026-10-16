// @vitest-environment jsdom
/**
 * M3.4 (DESIGN §16.4, §17.3): the generate card is the working surface. Its
 * props freeze with the result, so it follows the task through the plugin's
 * live store — progress, the finished player, where the video is, a moved or
 * deleted video, and cancel — and the store polls only while a card watches a
 * task that can still change.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VideoGenerateRow, type Translate } from '../src/client/cards.tsx'
import { createLiveTasks } from '../src/client/live-tasks.ts'
import { en } from '../src/client/locales.ts'
import { fetchTask, type LiveTask, type PanelResult } from '../src/client/panel-api.ts'

const t: Translate = (key, params) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const TASK_ID = 'v-20261016-0001'

function row(over: Partial<LiveTask>): LiveTask {
  return {
    taskId: TASK_ID, provider: 'ark', model: 'seedance', status: 'running', progress: null, mode: 't2v', prompt: 'a fox',
    submittedAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', playUrl: null, artifactPath: null,
    artifactLocation: null, artifactBytes: null, error: null, artifactState: null, ...over,
  }
}

/** A frozen `video_generate` result, as the host recorded it when the call returned. */
function frozen(status = 'queued'): unknown {
  return {
    kind: 'tool-result',
    seq: 5, time: 1, callId: 'c1', callTime: 0, subCalls: [],
    call: { name: 'video_generate', argsRaw: '{"prompt":"a fox"}' },
    content: [{ type: 'text', text: 'submitted' }],
    isError: false,
    meta: { taskId: TASK_ID, provider: 'ark', model: 'seedance', status, progress: null, artifact: null },
  }
}

/** A scripted host: each poll answers the next row (the last one repeats). */
function host(rows: (LiveTask | string)[]): { fetchTask: (id: string) => Promise<PanelResult<{ task: LiveTask | null; active: number }>>; calls: string[] } {
  const calls: string[] = []
  let index = 0
  return {
    calls,
    fetchTask: async (id) => {
      calls.push(id)
      const next = rows[Math.min(index, rows.length - 1)]
      index += 1
      return typeof next === 'string' ? { ok: false, error: next } : { ok: true, value: { task: next ?? null, active: 1 } }
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('the live store', () => {
  it('polls while a card watches a moving task, slows for one the host is retrying, and stops when it settles or nobody watches', async () => {
    vi.useFakeTimers()
    const scripted = host([row({ status: 'queued' }), row({ status: 'running' }), row({ status: 'orphaned' }), row({ status: 'succeeded' })])
    const live = createLiveTasks({ fastMs: 1000, slowMs: 10_000, fetchTask: scripted.fetchTask })
    const source = live.source(TASK_ID)
    expect(live.source(TASK_ID)).toBe(source)

    const stop = source.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(scripted.calls).toHaveLength(1)
    expect(source.getSnapshot().task?.status).toBe('queued')
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.getSnapshot().task?.status).toBe('running')
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.getSnapshot().task?.status).toBe('orphaned')
    // Waiting on the host's own retries: the slow pace.
    await vi.advanceTimersByTimeAsync(5000)
    expect(scripted.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(5000)
    expect(source.getSnapshot().task?.status).toBe('succeeded')
    // Settled: no more requests.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scripted.calls).toHaveLength(4)
    stop()
  })

  it('asks once for a task that already settled, and never for a card nobody mounted', async () => {
    vi.useFakeTimers()
    const scripted = host([row({ status: 'succeeded', artifactState: 'missing' })])
    const live = createLiveTasks({ fetchTask: scripted.fetchTask })
    live.source('v-unwatched')
    const stop = live.source(TASK_ID).subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(scripted.calls).toEqual([TASK_ID])
    stop()
  })

  it('stops the timer when the last card unmounts', async () => {
    vi.useFakeTimers()
    const scripted = host([row({ status: 'running' })])
    const live = createLiveTasks({ fastMs: 1000, fetchTask: scripted.fetchTask })
    const stop = live.source(TASK_ID).subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scripted.calls).toHaveLength(1)
  })

  it('keeps the last row when a poll fails, and says so', async () => {
    vi.useFakeTimers()
    const scripted = host([row({ status: 'running', progress: 0.5 }), 'HTTP 503'])
    const live = createLiveTasks({ fastMs: 1000, slowMs: 1000, fetchTask: scripted.fetchTask })
    const source = live.source(TASK_ID)
    const stop = source.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.getSnapshot()).toMatchObject({ task: { progress: 0.5 }, error: 'HTTP 503' })
    stop()
  })
})

describe('the generate card', () => {
  it('follows its task from queued to a playable video, saying where it is', async () => {
    vi.useFakeTimers()
    const scripted = host([
      row({ status: 'running', progress: 0.4 }),
      row({ status: 'succeeded', progress: 1, playUrl: `video-forge/media/${TASK_ID}/tok/v001.mp4`, artifactLocation: 'renders/untitled/v001.mp4 in the workspace', artifactBytes: 2_097_152, artifactState: 'present' }),
    ])
    const live = createLiveTasks({ fastMs: 1000, fetchTask: scripted.fetchTask })
    const { container } = render(<VideoGenerateRow phase="result" block={frozen()} t={t} liveTasks={live} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('Generating…')).toBeTruthy()
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('Video ready')).toBeTruthy()
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toContain(`video-forge/media/${TASK_ID}/tok/v001.mp4`)
    expect(screen.getByText('renders/untitled/v001.mp4 in the workspace · 2.0 MiB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('says a video was moved or deleted instead of showing a broken player', async () => {
    const scripted = host([row({ status: 'succeeded', playUrl: `video-forge/media/${TASK_ID}/tok/v001.mp4`, artifactLocation: 'renders/untitled/v001.mp4 in the workspace', artifactState: 'missing' })])
    const live = createLiveTasks({ fetchTask: scripted.fetchTask })
    const { container } = render(<VideoGenerateRow phase="result" block={frozen('succeeded')} t={t} liveTasks={live} />)
    await flush()
    expect(screen.getByText(en['generate.missing'])).toBeTruthy()
    expect(container.querySelector('video')).toBeNull()
  })

  it('cancels through the store and shows the provider\'s answer', async () => {
    const scripted = host([row({ status: 'queued' }), row({ status: 'cancelled' })])
    const cancelTask = vi.fn(async () => ({ ok: true as const, value: { cancelled: true, message: 'the provider accepted the cancellation', status: 'cancelled' } }))
    const live = createLiveTasks({ fetchTask: scripted.fetchTask, cancelTask })
    render(<VideoGenerateRow phase="result" block={frozen()} t={t} liveTasks={live} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await flush()
    await flush()
    expect(cancelTask).toHaveBeenCalledWith(TASK_ID)
    expect(screen.getByText('the provider accepted the cancellation')).toBeTruthy()
    expect(screen.getByText('Generation cancelled')).toBeTruthy()
  })

  it('renders the frozen result alone where no store is injected', () => {
    render(<VideoGenerateRow phase="result" block={frozen('running')} t={t} />)
    expect(screen.getByText('Generating…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('review fixes (M3.4 round 1)', () => {
  it('stops for good on 403 or 404, and shows no error for them', async () => {
    vi.useFakeTimers()
    for (const status of [403, 404]) {
      const calls: string[] = []
      const live = createLiveTasks({ fastMs: 1000, slowMs: 1000, fetchTask: async (id) => { calls.push(id); return { ok: false, error: 'refused', status } } })
      const source = live.source(TASK_ID)
      const stop = source.subscribe(() => undefined)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toHaveLength(1)
      expect(source.getSnapshot()).toMatchObject({ stopped: true, error: null })
      stop()
    }
  })

  it('refreshes after a cancel even when a poll was already in flight', async () => {
    let resolveFirst: ((value: PanelResult<{ task: LiveTask | null; active: number }>) => void) | undefined
    const answers: LiveTask[] = []
    let calls = 0
    const live = createLiveTasks({
      fastMs: 60_000,
      fetchTask: async () => {
        calls += 1
        // The card's first poll is the slow one: it is still out when the cancel lands.
        if (calls === 1) return new Promise(resolve => { resolveFirst = resolve })
        return { ok: true, value: { task: answers.at(-1) ?? row({ status: 'running' }), active: 1 } }
      },
      cancelTask: async () => {
        answers.push(row({ status: 'cancelled' }))
        return { ok: true, value: { cancelled: true, message: 'accepted', status: 'cancelled' } }
      },
    })
    const source = live.source(TASK_ID)
    const stop = source.subscribe(() => undefined)
    await flush()
    // A poll is in flight when the cancel lands…
    const pending = live.cancel(TASK_ID)
    await flush()
    await pending
    // …and it answers with the state from before the cancel.
    resolveFirst?.({ ok: true, value: { task: row({ status: 'running' }), active: 1 } })
    await flush()
    await flush()
    expect(source.getSnapshot().task?.status).toBe('cancelled')
    stop()
  })

  it('never shows another task\'s row, and a malformed answer is an error, not a stall', async () => {
    const realFetch = globalThis.fetch
    const answer = (body: unknown): void => {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    }
    try {
      answer({ ok: true, tasks: [row({ taskId: 'v-someone-else' })], active: 0 })
      expect(await fetchTask(TASK_ID)).toEqual({ ok: true, value: { task: null, active: 0 } })
      answer({ ok: true })
      expect(await fetchTask(TASK_ID)).toMatchObject({ ok: false })
    } finally {
      globalThis.fetch = realFetch
    }
    const live = createLiveTasks({ fetchTask: async () => { throw new Error('boom') } })
    const source = live.source(TASK_ID)
    const stop = source.subscribe(() => undefined)
    await flush()
    expect(source.getSnapshot()).toMatchObject({ loaded: true, error: 'boom' })
    stop()
  })

  it('once disposed, stops its timers and hands out nothing', async () => {
    vi.useFakeTimers()
    const scripted = host([row({ status: 'running' })])
    const live = createLiveTasks({ fastMs: 1000, fetchTask: scripted.fetchTask })
    const stop = live.source(TASK_ID).subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    live.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scripted.calls).toHaveLength(1)
    const late = live.source('v-late')
    late.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(scripted.calls).toHaveLength(1)
    expect(await live.cancel(TASK_ID)).toMatchObject({ ok: false })
    stop()
  })

  it('offers cancel only once the live state confirms the task is still running', async () => {
    let release: (() => void) | undefined
    const live = createLiveTasks({
      fetchTask: async () => {
        await new Promise<void>(resolve => { release = resolve })
        return { ok: true, value: { task: row({ status: 'succeeded' }), active: 0 } }
      },
    })
    render(<VideoGenerateRow phase="result" block={frozen('queued')} t={t} liveTasks={live} />)
    // The frozen result says queued, but nothing live has confirmed it yet.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    release?.()
    await flush()
    await flush()
    expect(screen.getByText('Video ready')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
