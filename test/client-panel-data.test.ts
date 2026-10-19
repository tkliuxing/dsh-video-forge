/**
 * The panel's two data sources (M5): the plugin's own overview and the
 * `renders/` scan through the workspace-files Remote.
 *
 * The scan is where a project's real shape shows up — no renders directory yet,
 * a renders path that is a file, a shot that disappears between two listings, a
 * directory big enough for the host to cut the listing short — and every one of
 * those has to end as a row list plus something honest to say, never as a silent
 * empty panel.
 */

import { describe, expect, it, vi } from 'vitest'
import { RENDERS_DIRECTORY, isPanelVideo, scanRenders, type WorkspaceFilesRemoteLike } from '../src/client/panel-data.ts'

type Listing = { ok: true; value: { entries: { name: string; type: string; size?: number }[]; truncated?: boolean } } | { ok: false; error: { code: string; message?: string } }

const ok = (entries: { name: string; type: string; size?: number }[], truncated = false): Listing => ({ ok: true, value: { entries, truncated } })
const refused = (code: string, message = `host said ${code}`): Listing => ({ ok: false, error: { code, message } })

/** A Remote double keyed by the path it is asked for. */
function remoteOf(tree: Record<string, Listing>, calls: string[] = []): WorkspaceFilesRemoteLike {
  return {
    list: (sessionId: string, path: string) => {
      calls.push(`${sessionId}:${path}`)
      return Promise.resolve(tree[path] ?? refused('workspace-file/not-found'))
    },
  }
}

const deps = (remote: WorkspaceFilesRemoteLike | undefined): { sessionId: string; remote: WorkspaceFilesRemoteLike | undefined } => ({
  sessionId: 'session-a',
  remote,
})

const never = new AbortController().signal

describe('isPanelVideo', () => {
  it('claims mp4 in any case and nothing else', () => {
    expect(isPanelVideo('v001.mp4')).toBe(true)
    expect(isPanelVideo('V001.MP4')).toBe(true)
    expect(isPanelVideo('v001.mov')).toBe(false)
    expect(isPanelVideo('v001.mp4.gif')).toBe(false)
  })
})

describe('scanRenders', () => {
  it('lists the files at the root and one level into each shot', async () => {
    const calls: string[] = []
    const scan = await scanRenders(deps(remoteOf({
      [RENDERS_DIRECTORY]: ok([
        { name: 'hero', type: 'directory' },
        { name: 'ending', type: 'directory' },
        { name: 'loose.mp4', type: 'file', size: 10 },
        { name: 'notes.txt', type: 'file' },
      ]),
      'renders/hero': ok([{ name: 'v001.mp4', type: 'file', size: 20 }, { name: 'v001.json', type: 'file' }]),
      'renders/ending': ok([{ name: 'v002.mp4', type: 'file' }]),
    }, calls)), never)
    expect(scan.problem.kind).toBe('none')
    expect(scan.files).toEqual([
      { path: 'renders/loose.mp4', bytes: 10 },
      { path: 'renders/hero/v001.mp4', bytes: 20 },
      { path: 'renders/ending/v002.mp4', bytes: null },
    ])
    // Root first, then the shots; order is preserved for stable dedupe.
    expect(calls[0]).toBe('session-a:renders')
    expect(calls).toHaveLength(3)
  })

  it('treats a missing renders/ as an empty project, not a failure', async () => {
    const scan = await scanRenders(deps(remoteOf({})), never)
    expect(scan).toEqual({ files: [], problem: { kind: 'none' } })
  })

  it('says which way renders/ was unusable', async () => {
    expect((await scanRenders(deps(remoteOf({ renders: refused('workspace-file/not-directory') })), never)).problem.kind).toBe('not-directory')
    expect((await scanRenders(deps(remoteOf({ renders: refused('workspace-file/outside-workspace') })), never)).problem.kind).toBe('outside')
    const other = await scanRenders(deps(remoteOf({ renders: refused('workspace-file/not-text', 'surprising') })), never)
    expect(other.problem).toEqual({ kind: 'refused', detail: 'surprising' })
  })

  it('reports a host without the workspace file service', async () => {
    expect((await scanRenders(deps(undefined), never)).problem).toEqual({ kind: 'unavailable' })
  })

  it('keeps the other shots when one listing fails', async () => {
    const scan = await scanRenders(deps(remoteOf({
      renders: ok([{ name: 'hero', type: 'directory' }, { name: 'ending', type: 'directory' }]),
      'renders/hero': refused('workspace-file/not-found'),
      'renders/ending': ok([{ name: 'v001.mp4', type: 'file' }]),
    })), never)
    expect(scan.files.map(file => file.path)).toEqual(['renders/ending/v001.mp4'])
    expect(scan.problem.kind).toBe('none')
  })

  it('does not present a cut-short listing as complete', async () => {
    const scan = await scanRenders(deps(remoteOf({
      renders: ok([{ name: 'hero', type: 'directory' }], true),
      'renders/hero': ok([{ name: 'v001.mp4', type: 'file' }]),
    })), never)
    expect(scan.problem.kind).toBe('truncated')
    expect(scan.files).toHaveLength(1)
  })

  it('caps the number of directories it lists, and says the list was cut', async () => {
    const shots = Array.from({ length: 90 }, (_, index) => ({ name: `shot-${String(index).padStart(3, '0')}`, type: 'directory' }))
    const tree: Record<string, Listing> = { renders: ok(shots) }
    for (const shot of shots) tree[`renders/${shot.name}`] = ok([{ name: 'v001.mp4', type: 'file' }])
    const calls: string[] = []
    const scan = await scanRenders(deps(remoteOf(tree, calls)), never)
    expect(scan.problem.kind).toBe('truncated')
    // Root + at most 80 shot listings.
    expect(calls).toHaveLength(81)
    expect(scan.files).toHaveLength(80)
  })

  it('stops when the abort signal fires', async () => {
    const controller = new AbortController()
    controller.abort()
    const remote: WorkspaceFilesRemoteLike = {
      list: vi.fn(async () => {
        controller.signal.throwIfAborted()
        return ok([])
      }),
    }
    await expect(scanRenders(deps(remote), controller.signal)).rejects.toThrow()
  })
})
