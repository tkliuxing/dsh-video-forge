// @vitest-environment jsdom
/**
 * The card's two entry buttons (M5): the file viewer on this video, and the panel
 * that lists them all.
 *
 * What matters here is the path handed over — the artifact's own absolute path,
 * not a display summary — and that a card rendered somewhere without the owner's
 * props (a replay of an older log, a test harness) simply has no buttons.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VideoGenerateRow, VideoStatusRow, type Translate } from '../src/client/cards.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: Translate = (key, params) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

const ARTIFACT = '/work/renders/hero/v001.mp4'

const META = {
  taskId: 'v-20261019-0001',
  provider: 'ark',
  model: 'seedance',
  status: 'succeeded',
  progress: 1,
  artifact: { path: ARTIFACT, url: 'video-forge/media/v-20261019-0001/tok/v001.mp4', mime: 'video/mp4', bytes: 1024 },
}

const block = (meta: unknown): unknown => ({
  kind: 'tool-result',
  seq: 5,
  time: 1,
  callId: 'c1',
  call: { name: 'video_generate', argsRaw: '{"prompt":"a fox"}' },
  callTime: 0,
  content: [{ type: 'text', text: 'finished' }],
  isError: false,
  meta,
  subCalls: [],
})

describe('card entries', () => {
  it('opens the resolved artifact in the file viewer', () => {
    const openFile = vi.fn()
    render(<VideoGenerateRow phase="result" block={block(META)} t={t} openFile={openFile} openPanel={() => undefined} />)
    fireEvent.click(screen.getByText('Open in file viewer'))
    expect(openFile).toHaveBeenCalledWith(ARTIFACT)
  })

  it('opens the panel from the generate card', () => {
    const openPanel = vi.fn()
    render(<VideoGenerateRow phase="result" block={block(META)} t={t} openPanel={openPanel} />)
    fireEvent.click(screen.getByText('All videos'))
    expect(openPanel).toHaveBeenCalledTimes(1)
    // No `openFile` was supplied, so no viewer button that would do nothing.
    expect(screen.queryByText('Open in file viewer')).toBeNull()
  })

  it('keeps the panel entry on a status card and drops the viewer one', () => {
    const openPanel = vi.fn()
    render(
      <VideoStatusRow
        phase="result"
        block={block({ tasks: [{ task_id: 'v-1', provider: 'ark', model: 'm', status: 'succeeded', progress: 1, play_url: 'video-forge/media/v-1/tok/out.mp4', error: null }] })}
        t={t}
        openPanel={openPanel}
      />,
    )
    expect(screen.queryByText('Open in file viewer')).toBeNull()
    fireEvent.click(screen.getByText('All videos'))
    expect(openPanel).toHaveBeenCalledTimes(1)
  })

  it('has no entries when the video is gone', () => {
    render(<VideoGenerateRow phase="result" block={block({ ...META, artifact: { ...META.artifact, url: null } })} t={t} openFile={() => undefined} openPanel={() => undefined} />)
    // A missing artifact reports itself; the viewer button would open nothing.
    expect(screen.queryByText('Open in file viewer')).toBeNull()
  })
})
