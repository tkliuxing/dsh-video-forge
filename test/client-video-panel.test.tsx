// @vitest-environment jsdom
/**
 * The video panel's rendered behaviour (M5): what an operator sees and can do.
 *
 * The list's rules are covered by the model tests; this file pins the wiring a
 * model test cannot — that the newest finished video opens by itself, that one
 * row is open at a time and can be closed, that a row plays from the right source
 * (the ledger's token URL or the stream route), that "open in file viewer"
 * addresses the row's own file, and that the loading, empty, error and
 * no-stream states each say something instead of showing a blank pane.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelTask } from '../src/client/panel-api.ts'
import type { PanelLoad } from '../src/client/panel-data.ts'
import { en, type VideoForgeKey } from '../src/client/locales.ts'
import { VideoPanel, type VideoPanelProps } from '../src/client/video-panel.tsx'

afterEach(cleanup)

const t = (key: VideoForgeKey, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? `{${name}}`))
}

function task(overrides: Partial<PanelTask> = {}): PanelTask {
  return {
    taskId: 'v-20261019-0001',
    provider: 'ark',
    model: 'seedance',
    status: 'succeeded',
    progress: 1,
    mode: 't2v',
    prompt: 'a rainy street at night',
    submittedAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:01:00.000Z',
    playUrl: '/video-forge/media/v-20261019-0001/tok/v001.mp4',
    artifactPath: '/work/renders/hero/v001.mp4',
    artifactLocation: 'renders/hero/v001.mp4',
    artifactBytes: 1_600_000,
    error: null,
    sessionId: 'session-a',
    workspacePath: 'renders/hero/v001.mp4',
    shot: 'hero',
    durationSeconds: 5.17,
    width: 1344,
    height: 768,
    resolution: '1080p',
    aspectRatio: '16:9',
    ...overrides,
  }
}

const load = (overrides: Partial<PanelLoad> = {}): PanelLoad => ({
  tasks: [task()],
  files: [],
  stream: true,
  scanError: null,
  ...overrides,
})

/** Compose the props the slot framework would, with fakes for the hooks. */
function props(overrides: {
  loadPanel?: (signal: AbortSignal) => Promise<PanelLoad>
  openResource?: (address: string) => void
  visible?: boolean
  /** Sessions the on-screen workspace accounts for. */
  workspaceSessions?: readonly string[]
} = {}): VideoPanelProps {
  const openResource = overrides.openResource ?? (() => undefined)
  const fake = {
    t,
    sessionId: 'session-a',
    loadPanel: overrides.loadPanel ?? (() => Promise.resolve(load())),
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: 'tab-1',
        kind: 'video-forge-videos',
        title: 'Videos',
        visible: overrides.visible ?? true,
        signal: new AbortController().signal,
        navigation: { address: 'sidebar://video-forge-videos', revision: 0 },
        actions: { openResource, openTab: () => undefined, close: () => undefined, bindCommands: () => () => undefined },
      },
    }),
    useWorkspaces: (selector: (state: unknown) => unknown) =>
      selector({ items: [{ sessionIds: overrides.workspaceSessions ?? ['session-a'] }] }),
  }
  return fake as unknown as VideoPanelProps
}

describe('VideoPanel', () => {
  it('opens the newest finished video by itself and plays it from the token URL', async () => {
    const newest = task({
      taskId: 'v-2',
      workspacePath: 'renders/hero/v002.mp4',
      playUrl: '/video-forge/media/v-2/tok/v002.mp4',
      submittedAt: '2026-10-19T09:00:00.000Z',
    })
    render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ tasks: [newest, task()] })) })} />)
    await waitFor(() => { expect(screen.getByText('v002.mp4')).toBeTruthy() })
    const players = document.querySelectorAll('video')
    expect(players).toHaveLength(1)
    expect(players[0]?.getAttribute('src')).toContain('/video-forge/media/v-2/tok/v002.mp4')
    expect(screen.getByText('renders/hero')).toBeTruthy()
    expect(screen.getByText('a rainy street at night')).toBeTruthy()
  })

  it('keeps one row open at a time and closes it on a second click', async () => {
    const second = task({ taskId: 'v-2', workspacePath: 'renders/hero/v002.mp4', submittedAt: '2026-10-19T09:00:00.000Z' })
    render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ tasks: [second, task()] })) })} />)
    await waitFor(() => { expect(screen.getByText('v001.mp4')).toBeTruthy() })
    // v002 is newest, so it is the open one.
    expect(document.querySelectorAll('video')).toHaveLength(1)
    fireEvent.click(screen.getByText('v001.mp4'))
    await waitFor(() => {
      const players = document.querySelectorAll('video')
      expect(players).toHaveLength(1)
      expect(players[0]?.getAttribute('src')).toContain('v001.mp4')
    })
    fireEvent.click(screen.getByText('v001.mp4'))
    await waitFor(() => { expect(document.querySelectorAll('video')).toHaveLength(0) })
  })

  it('opens a row in the file viewer by its session-relative address', async () => {
    const openResource = vi.fn()
    render(<VideoPanel {...props({ openResource })} />)
    await waitFor(() => { expect(screen.getByText('Open in file viewer')).toBeTruthy() })
    fireEvent.click(screen.getByText('Open in file viewer'))
    expect(openResource).toHaveBeenCalledWith('dsh-resource://file/session/session-a/renders/hero/v001.mp4')
  })

  it('plays a scanned file through the stream route, and says so when the host has none', async () => {
    const files = [{ path: 'renders/hero/v009.mp4', bytes: 2048 }]
    const { unmount } = render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ tasks: [], files })) })} />)
    await waitFor(() => { expect(screen.getByText('v009.mp4')).toBeTruthy() })
    expect(document.querySelector('video')?.getAttribute('src')).toContain('/api/video-forge/stream?path=renders%2Fhero%2Fv009.mp4&sessionId=session-a')
    expect(screen.getByText('File only')).toBeTruthy()
    unmount()

    render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ tasks: [], files, stream: false })) })} />)
    await waitFor(() => { expect(screen.getByText(/cannot play here/)).toBeTruthy() })
    expect(document.querySelector('video')).toBeNull()
    // The file viewer is still one click away.
    expect(screen.getByText('Open in file viewer')).toBeTruthy()
  })

  it('sinks work in flight and failures into their own sections', async () => {
    const running = task({ taskId: 'v-3', status: 'running', progress: 0.62, playUrl: null, workspacePath: null, submittedAt: '2026-10-19T10:00:00.000Z' })
    const failed = task({ taskId: 'v-4', status: 'failed', playUrl: null, workspacePath: null, error: 'the provider refused', submittedAt: '2026-10-19T07:00:00.000Z' })
    render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ tasks: [task(), running, failed] })) })} />)
    await waitFor(() => { expect(screen.getByText('62%')).toBeTruthy() })
    expect(screen.getAllByText('Generating').length).toBeGreaterThan(0)
    // The section header is its own word; the failed row keeps its status chip.
    expect(screen.getByText('Not finished')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('filters by scope and counts each one', async () => {
    const other = task({ taskId: 'v-5', sessionId: 'session-other', workspacePath: 'renders/hero/v005.mp4' })
    render(<VideoPanel {...props({
      loadPanel: () => Promise.resolve(load({ tasks: [task(), other] })),
      // Both Sessions are accounted to this workspace; only one is on screen.
      workspaceSessions: ['session-a', 'session-other'],
    })} />)
    await waitFor(() => { expect(screen.getByText('v001.mp4')).toBeTruthy() })
    // Workspace scope: both rows belong to this workspace.
    expect(screen.getByText('v005.mp4')).toBeTruthy()
    fireEvent.click(screen.getByText('This session'))
    await waitFor(() => { expect(screen.queryByText('v005.mp4')).toBeNull() })
    fireEvent.click(screen.getByText('All'))
    await waitFor(() => { expect(screen.getByText('v005.mp4')).toBeTruthy() })
  })

  it('says it is loading, empty, failed, or partly scanned', async () => {
    const { unmount } = render(<VideoPanel {...props({ loadPanel: () => new Promise<PanelLoad>(() => undefined) })} />)
    expect(screen.getByText('Reading the video list…')).toBeTruthy()
    unmount()

    render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ tasks: [], files: [] })) })} />)
    await waitFor(() => { expect(screen.getByText('No videos in this workspace yet.')).toBeTruthy() })
    cleanup()

    render(<VideoPanel {...props({ loadPanel: () => Promise.reject(new Error('the ledger is unreadable')) })} />)
    await waitFor(() => { expect(screen.getByText(/the ledger is unreadable/)).toBeTruthy() })
    cleanup()

    render(<VideoPanel {...props({ loadPanel: () => Promise.resolve(load({ scanError: 'not a directory' })) })} />)
    await waitFor(() => { expect(screen.getByText(/not a directory/)).toBeTruthy() })
    // The ledger rows are still there.
    expect(screen.getByText('v001.mp4')).toBeTruthy()
  })
})
