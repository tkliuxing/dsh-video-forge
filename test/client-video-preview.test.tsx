// @vitest-environment jsdom
/**
 * The file viewer's mp4 body (M5).
 *
 * It loads nothing itself: the owner asks for a renderer-owned content, and this
 * component turns the file's metadata into a `<video src>` — the plugin's ranged
 * stream route first, the harness's bounded `/api/file` when that route is not
 * there. These tests pin the URL it builds, that it reports the content as shown
 * (the owner is otherwise stuck in its loading state), and that a file neither
 * route can play says so instead of showing a silent black box.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { VIDEO_PREVIEW_ID, VideoPreview, type VideoPreviewProps } from '../src/client/video-preview.tsx'
import { en, type VideoForgeKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: VideoForgeKey, params?: Record<string, unknown>): string => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

const ADDRESS = 'dsh-resource://file/session/session-a/renders/hero/v001.mp4'

/** Compose the props the document seat would, with a fake resource snapshot. */
function props(overrides: {
  loaded?: (version: string) => void
  failed?: () => void
  status?: 'live' | 'failed' | 'loading'
  message?: string
  absolutePath?: string
} = {}): VideoPreviewProps {
  const fake = {
    t,
    resourceAddress: ADDRESS,
    wrap: false,
    addResource: () => undefined,
    setResources: () => undefined,
    scrollportRef: () => undefined,
    content: {
      kind: 'renderer',
      revision: 0,
      loaded: overrides.loaded ?? (() => undefined),
      failed: overrides.failed ?? (() => undefined),
      reload: () => undefined,
    },
    useResource: () => (overrides.status === 'failed'
      ? { status: 'failed', failure: { message: overrides.message ?? 'gone' } }
      : overrides.status === 'loading'
        ? { status: 'loading' }
        : { status: 'live', value: { absolutePath: overrides.absolutePath ?? '/w/renders/hero/v001.mp4', version: 'v1' } }),
  }
  return fake as unknown as VideoPreviewProps & DocumentPreviewProps
}

describe('mp4 preview body', () => {
  it('plays from the stream route and reports the content as shown', async () => {
    const loaded = vi.fn()
    render(<VideoPreview {...props({ loaded })} />)
    const player = document.querySelector('video')
    expect(player).not.toBeNull()
    // Document-relative on purpose: the GUI is served under a `<base>`.
    expect(player?.getAttribute('src')).toBe(new URL('api/video-forge/stream?path=%2Fw%2Frenders%2Fhero%2Fv001.mp4&v=v1-0', document.baseURI).href)
    expect(player?.hasAttribute('controls')).toBe(true)
    await waitFor(() => { expect(loaded).toHaveBeenCalledWith('v1') })
    // Never more than once per version, or the store would loop.
    expect(loaded).toHaveBeenCalledTimes(1)
  })

  it('falls back to the harness file URL when the stream route refuses, then says so', async () => {
    render(<VideoPreview {...props()} />)
    const first = document.querySelector('video')
    expect(first?.getAttribute('src')).toContain('/api/video-forge/stream')
    fireEvent.error(first!)
    await waitFor(() => {
      expect(document.querySelector('video')?.getAttribute('src'))
        .toBe(new URL('api/file?path=%2Fw%2Frenders%2Fhero%2Fv001.mp4', document.baseURI).href)
    })
    fireEvent.error(document.querySelector('video')!)
    await waitFor(() => { expect(screen.getByText(/cannot play here/)).toBeTruthy() })
    expect(document.querySelector('video')).toBeNull()
  })

  it('reports a failed resource read instead of drawing a player', () => {
    render(<VideoPreview {...props({ status: 'failed', message: 'permission denied' })} />)
    expect(screen.getByText('permission denied')).toBeTruthy()
    expect(document.querySelector('video')).toBeNull()
  })

  it('waits for the metadata before building a URL', () => {
    render(<VideoPreview {...props({ status: 'loading' })} />)
    expect(screen.getByText('Loading the video…')).toBeTruthy()
    expect(document.querySelector('video')).toBeNull()
  })

  it('claims exactly one suffix, so the plain-text viewer is not offered beside it', async () => {
    const { VIDEO_PREVIEW_EXTENSIONS } = await import('../src/client/video-preview.tsx')
    expect([...VIDEO_PREVIEW_EXTENSIONS]).toEqual(['mp4'])
    expect(VIDEO_PREVIEW_ID).toBe('dsh-video-forge/mp4')
  })
})
